import * as THREE from 'three';
import { clamp01 } from '../core/MathX.js';
import { FsPass, makeHdrTarget } from './Fullscreen.js';
import { DEPTH_GLSL, HASH_GLSL, RECON_NORMAL_GLSL } from './ShaderLib.js';

/**
 * Ground-truth-ish ambient occlusion, half resolution, depth-only.
 *
 * Algorithm: Alchemy/Scalable AO (McGuire et al. 2011/2012) over a spiral kernel, with normals
 * reconstructed from depth rather than a normal pre-pass. Reasons for that choice:
 *
 *  - three's GTAOPass renders the whole scene a second time with an override normal material.
 *    In this project that is ~1000 extra draw calls per frame on top of a shadow pass that already
 *    costs 10 ms. Reconstructing normals costs 8 depth taps.
 *  - Alchemy's estimator is `max(0, dot(v,n) - z*beta) / (dot(v,v) + eps)` — the 1/d² term makes
 *    the falloff physical, and because the radius is projected from a WORLD-space metre value the
 *    occlusion is scale-correct: a 0.55 m radius means the same shading whether the camera is on
 *    the bumper or thirty metres back. That is the specific thing that stops AO haloing.
 *
 * The buffer stores (ao, linearDepth) so the bilateral blur and the upsample in ResolvePass can
 * both reject samples across a depth discontinuity without re-fetching the depth texture.
 *
 * ===================== the transparent-surface exclusion mask =====================
 * A depth-only AO is only ever correct for surfaces that WROTE depth. In a forward renderer the
 * glass, the light lenses and the shut lines are all `depthWrite:false`, so at those pixels the
 * depth buffer holds whatever is BEHIND them — the cabin interior, or the street past the
 * windscreen. The AO computed there belongs to that hidden geometry, and because the interior is
 * boxy its occlusion field is a set of hard-edged rectangles. Multiply that into a near-mirror
 * clearcoat and you get the blocky "half-res checkerboard" smeared across the greenhouse.
 *
 * No amount of upsample or denoise fixes this: the AO buffer is being reproduced faithfully, it is
 * simply the wrong surface's AO. So after the blur we draw the offending meshes straight into the
 * AO buffer as "unoccluded". They are tagged onto a private layer, so the whole thing is one extra
 * draw batch at half res with a two-instruction fragment shader. Visibility is resolved by a
 * manual depth compare against the scene depth texture rather than a depth attachment, which is
 * what lets the mask run at half res against a full-res depth buffer.
 */

/** Private layer used to isolate the AO-exclusion set. Nothing else in the project uses layers. */
const MASK_LAYER = 11;

const _v = new THREE.Vector3();
const NOOP = function () {};

export class AoPass {
  constructor(renderer) {
    this.renderer = renderer;
    this.scale = 0.5;
    this.radius = 0.72; // metres
    this.intensity = 1.15;
    // Alchemy's beta: the self-occlusion reject scales with view depth, because both the depth
    // buffer's precision and the error in a depth-reconstructed normal do. A constant bias is
    // what makes AO look clean up close and boil into dashes on a road 60 m out.
    this.bias = 0.0025;
    this.maxRadiusPx = 48;
    this.power = 1.4;
    /** metres — beyond this the world-space radius is sub-pixel and AO is just noise */
    this.fadeStart = 55;
    this.fadeEnd = 150;
    this.failed = false;

    this.compute = new FsPass(AO_SHADER, { AO_SAMPLES: '11' });
    this.blur = new FsPass(BLUR_SHADER);
    this.rtA = null;
    this.rtB = null;

    // ---- transparent-surface exclusion mask ----
    this.maskEnabled = true;
    this._maskMat = new THREE.ShaderMaterial(MASK_SHADER);
    this._tagged = [];
    this._rescanIn = 0;
    /** flat [object, savedHook, ...] used while the mask pass suppresses onBeforeRender */
    this._hooks = [];

    // ---- screen-space contact shadows ----
    // The cascaded sun shadow is the right tool for a car-sized shadow and the wrong one for the
    // 5 cm gap under a splitter: at its filter width the penumbra is the SAME size at the contact
    // point as it is at the tip, which is what makes objects read as hovering. A depth-buffer march
    // toward the key light fills in exactly that missing near-field term, and it rides in the AO
    // buffer's visibility channel, so it costs one buffer, one blur and one resolve — all of which
    // are already paid for.
    this.contact = true;
    this.contactLength = 1.1; // metres of march — must clear a wheel arch, not just a splitter
    this.contactThickness = 0.9; // metres a depth sample is assumed to extend behind itself
    this.contactStrength = 0.92;
    /** tan(angular radius) of the key light. This is what produces CONTACT HARDENING: the search
     *  cone widens linearly with march distance, so a blocker touching the surface casts a hard
     *  edge and one 80 cm away casts a soft one. A constant-width penumbra is the tell. */
    this.contactSunTan = 0.055;
    this.contactAmbientTan = 0.22;
    /** metres — past this a contact shadow is thinner than a pixel, so do not pay for the march */
    this.contactMaxDist = 45;
    this._sunView = new THREE.Vector3(0, 1, 0);
    this._sunStrength = 0;
    this._contactTan = this.contactSunTan;
  }

  setSize(w, h) {
    const bw = Math.max(4, Math.round(w * this.scale));
    const bh = Math.max(4, Math.round(h * this.scale));
    if (this.rtA && this.rtA.width === bw && this.rtA.height === bh) return;
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtA = makeHdrTarget(bw, bh, { format: THREE.RGFormat });
    this.rtB = makeHdrTarget(bw, bh, { format: THREE.RGFormat });
    this.rtA.texture.name = 'ao';
    this.rtB.texture.name = 'ao-blur';
  }

  /**
   * @param {THREE.Texture} depthTexture scene depth
   * @param {THREE.Camera} camera
   * @param {object} [ctx] engine context — only needed for the transparent-exclusion mask
   * @returns {THREE.Texture|null}
   */
  render(depthTexture, camera, ctx) {
    if (this.failed || !this.rtA) return null;
    const r = this.renderer;
    try {
      const u = this.compute.u;
      u.tDepth.value = depthTexture;
      u.uTexel.value.set(1 / this.rtA.width, 1 / this.rtA.height);
      u.uFullTexel.value.set(1 / (this.rtA.width * 2), 1 / (this.rtA.height * 2));
      u.uInvProj.value.copy(camera.projectionMatrixInverse);
      u.uNearFar.value.set(camera.near, camera.far);
      // projScale converts a world-space radius at view depth z into pixels:
      //   px = radius * projScale / z ,  projScale = 0.5 * viewportHeight / tan(fov/2)
      const projScale = 0.5 * this.rtA.height * camera.projectionMatrix.elements[5];
      u.uParams.value.set(this.radius, projScale, this.bias, this.maxRadiusPx);
      u.uShade.value.set(this.intensity, this.power, this.fadeStart, this.fadeEnd);

      // ---- contact shadows: key direction in VIEW space + a strength for this lighting ---------
      const contactOn = this._updateKey(camera, ctx);
      this.compute.setDefine('AO_CONTACT', contactOn ? '' : null);
      // Written unconditionally on purpose: if the define ever survives a frame it should not be
      // able to march along a stale vector at a stale strength. Strength 0 is a hard no-op.
      u.uProj.value.copy(camera.projectionMatrix);
      u.uSunView.value.copy(this._sunView);
      u.uContact.value.set(
        this.contactLength,
        this.contactThickness,
        contactOn ? this.contactStrength * this._sunStrength : 0,
        this._contactTan
      );
      u.uContactDist.value = this.contactMaxDist;
      this.compute.render(r, this.rtA);

      const b = this.blur.u;
      b.tAo.value = this.rtA.texture;
      b.uTexel.value.set(1 / this.rtA.width, 1 / this.rtA.height);
      // The blur is the denoiser, so its depth tolerance has to track view depth exactly like the
      // upsample's does. A fixed `exp(-|dz| * 5)` means a 20 cm tolerance everywhere: fine at 5 m,
      // but two neighbouring half-res texels on a road 100 m out are already further apart than
      // that, so every weight but the centre tap collapses and the "blur" silently becomes a copy.
      // Distant AO then arrives at the resolve completely undenoised.
      b.uNearFar.value.set(camera.near, camera.far);
      b.uDir.value.set(1, 0);
      this.blur.render(r, this.rtB);
      b.tAo.value = this.rtB.texture;
      b.uDir.value.set(0, 1);
      this.blur.render(r, this.rtA);

      // Stamp "no occlusion" over every surface the depth buffer does not actually describe.
      if (this.maskEnabled && ctx?.scene) this._renderMask(ctx, depthTexture, camera);

      return this.rtA.texture;
    } catch (e) {
      // Stack, not just message: this pass has three separate uniform blocks and a scene render,
      // and "cannot set property of undefined" without a frame is unfindable.
      console.warn('[postfx] AO disabled:', e?.stack || e?.message || e);
      this.failed = true;
      return null;
    }
  }

  /**
   * Key-light direction in view space + how much contact shadowing it earns.
   *
   * The previous version disabled itself whenever the sun was down, which meant every night frame
   * shipped with the cars sitting on the road with nothing under them at all. There is always a
   * grounding term to compute: when there is no directional key, march STRAIGHT UP instead. A
   * vertical march is an ambient-occlusion cone test — it finds the floorpan over the tarmac and
   * nothing over open road — so it produces exactly the tight dark blob a baked AO decal would,
   * and it is the same eleven instructions.
   *
   * @returns {boolean} false only if contact shadows are switched off entirely
   */
  _updateKey(camera, ctx) {
    if (!this.contact) return false;
    const env = ctx?.env;
    const dir = env?.sunDirection;
    const alt = env?.sunAltitude ?? 0.5;
    // Fade with solar altitude and with the key's own intensity, so an overcast preset does not
    // stamp a hard-edged sun shadow it has no business having.
    const alti = clamp01((alt - 0.015) / 0.14);
    const lit = clamp01((env?.sunLight?.intensity ?? 1) / 1.5);
    const sunAmt = dir && dir.lengthSq() > 1e-6 ? alti * lit : 0;

    if (sunAmt > 0.02) {
      // sunDirection points FROM the sun TO the scene; the direction to the light is its negation.
      _v.set(-dir.x, -dir.y, -dir.z);
      // A grazing sun makes the march nearly parallel to the road. Keep a small floor on the
      // elevation so the ray still climbs to a 15 cm floorpan inside the march length — at 10 deg
      // an unlifted ray gained 7 cm over the old 40 cm march and found nothing at all, which is
      // why the contact term was invisible at golden hour. Keep the lift SMALL: this term has to
      // agree with the direction the cascaded shadow map is casting in, or the two disagree
      // visibly where they overlap next to the tyres.
      _v.y += 0.20 * (1 - clamp01(_v.y / 0.20));
      _v.normalize();
      this._contactTan = this.contactSunTan;
      this._sunStrength = sunAmt;
    } else {
      // No directional key: occlusion cone straight up, in world space.
      _v.set(0, 1, 0);
      this._contactTan = this.contactAmbientTan;
      // Softer, because it is standing in for sky occlusion rather than a cast shadow — but never
      // zero: this is the whole reason a car reads as touching the road at night.
      this._sunStrength = 0.8;
    }
    // Rotation only — a direction has no translation.
    _v.transformDirection(camera.matrixWorldInverse).normalize();
    this._sunView.copy(_v);
    return true;
  }

  // ------------------------------------------------------------------ exclusion mask

  /**
   * Tag every CAR mesh whose material is transparent AND does not write depth: the glass, the lamp
   * lenses, the shut lines. Those are exactly the surfaces the depth buffer lies about.
   *
   * SCOPE. This used to walk the whole scene, which sounds more thorough and is in fact a bug. The
   * mask stamps a mesh's raster coverage, not its alpha — it has no idea what the material's
   * opacity map says — so a VFX billboard (tyre smoke, a dust card, an exhaust plume) got its
   * entire camera-facing QUAD stamped as unoccluded. On a road carrying a contact shadow that
   * prints a hard-edged grey rectangle several metres across, with half-res stair-stepped borders,
   * lying over the tarmac in front of the hero car. It was invisible until now only because the
   * mask pass itself was throwing and taking the AO with it.
   *
   * The artefact this mask exists for — the cabin interior's boxy occlusion reprinted across the
   * greenhouse — is a car problem, so the car roots are the correct scope, and walking five car
   * subtrees instead of the whole streamed city makes the rescan free as well.
   */
  _rescan(ctx) {
    const tagged = this._tagged;
    for (let i = 0; i < tagged.length; i++) tagged[i].layers.disable(MASK_LAYER);
    tagged.length = 0;
    const cars = ctx?.cars?.instances;
    if (!cars) return;
    const visit = (o) => {
      if (!o.isMesh) return;
      const m = o.material;
      let hit = false;
      if (Array.isArray(m)) {
        for (let i = 0; i < m.length; i++) {
          if (m[i] && m[i].transparent === true && m[i].depthWrite === false) hit = true;
        }
      } else if (m && m.transparent === true && m.depthWrite === false) {
        hit = true;
      }
      if (!hit) return;
      o.layers.enable(MASK_LAYER);
      tagged.push(o);
    };
    for (let i = 0; i < cars.length; i++) cars[i]?.root?.traverse(visit);
  }

  _renderMask(ctx, depthTexture, camera) {
    const { renderer, scene } = ctx;
    if (--this._rescanIn <= 0) {
      this._rescanIn = 20;
      this._rescan(ctx);
    }
    if (!this._tagged.length) return;

    const u = this._maskMat.uniforms;
    u.tDepth.value = depthTexture;
    u.uInvSize.value.set(1 / this.rtA.width, 1 / this.rtA.height);
    u.uNearFar.value.set(camera.near, camera.far);

    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const prevFog = scene.fog;
    const prevMask = camera.layers.mask;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const hooks = this._hooks;
    try {
      // ---- neutralise per-object onBeforeRender for the duration of this pass ------------------
      // three hands `renderObject()` the OVERRIDE material, and every VFX lane hook in this project
      // reaches straight into `material.uniforms.<x>.value` (src/vfx/Jets.js) or grabs the frame
      // buffer (src/vfx/Distortion.js). Both are meaningless here and the first one THROWS, which
      // used to take the entire AO pass down for the rest of the session — that is why the AO and
      // contact-shadow buffer was frozen on whatever the first shot produced and every subsequent
      // frame shipped with no occlusion at all. The tagged set is exactly the transparent VFX
      // surfaces, so this is the same list either way.
      for (let i = 0; i < this._tagged.length; i++) {
        const o = this._tagged[i];
        if (o.onBeforeRender !== NOOP) {
          hooks.push(o, o.onBeforeRender);
          o.onBeforeRender = NOOP;
        }
      }
      // Background and fog would both be applied to a plain scene render; the first would fill the
      // AO buffer with sky, the second would tint a mask that is not a colour.
      scene.background = null;
      scene.fog = null;
      scene.overrideMaterial = this._maskMat;
      camera.layers.set(MASK_LAYER);
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = false; // never clear — we are stamping ONTO the finished AO buffer
      renderer.setRenderTarget(this.rtA);
      renderer.render(scene, camera);
    } catch (e) {
      // The mask is a refinement, not the AO. Losing it must never lose the occlusion buffer.
      console.warn('[postfx] AO transparent mask disabled:', e?.stack || e?.message || e);
      this.maskEnabled = false;
    } finally {
      for (let i = 0; i < hooks.length; i += 2) hooks[i].onBeforeRender = hooks[i + 1];
      hooks.length = 0;
      scene.overrideMaterial = prevOverride;
      scene.background = prevBg;
      scene.fog = prevFog;
      camera.layers.mask = prevMask;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.autoClear = prevAuto;
      renderer.setRenderTarget(prevTarget);
    }
  }

  dispose() {
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.compute.dispose();
    this.blur.dispose();
    for (const o of this._tagged) o.layers.disable(MASK_LAYER);
    this._tagged.length = 0;
    this._maskMat.dispose();
  }
}

const AO_SHADER = {
  name: 'ao-alchemy',
  uniforms: {
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uFullTexel: { value: new THREE.Vector2() },
    uInvProj: { value: new THREE.Matrix4() },
    uNearFar: { value: new THREE.Vector2(0.15, 6000) },
    uParams: { value: new THREE.Vector4(0.6, 500, 0.03, 56) }, // radius, projScale, bias, maxPx
    uShade: { value: new THREE.Vector4(1.05, 1.35, 0, 0) }, // intensity, power
    uProj: { value: new THREE.Matrix4() },
    uSunView: { value: new THREE.Vector3(0, 1, 0) },
    // length, thickness, strength, tan(light angular radius)
    uContact: { value: new THREE.Vector4(1.1, 0.9, 0.92, 0.055) },
    uContactDist: { value: 45.0 },
  },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tDepth;
    uniform vec2 uTexel, uFullTexel;
    uniform mat4 uInvProj;
    uniform vec2 uNearFar;
    uniform vec4 uParams;
    uniform vec4 uShade;
    uniform mat4 uProj;
    uniform vec3 uSunView;
    uniform vec4 uContact;
    uniform float uContactDist;

    ${DEPTH_GLSL}
    ${RECON_NORMAL_GLSL}
    ${HASH_GLSL}

    const float SPIRAL_TURNS = 7.0;

    #ifdef AO_CONTACT
    #ifndef CONTACT_STEPS
    #define CONTACT_STEPS 12
    #endif
    /**
     * Screen-space march toward the key light, with a CONTACT-HARDENING penumbra.
     *
     * This is the near-field term the cascaded shadow map physically cannot resolve: at 2048 px
     * over a 24 m cascade one texel is ~2 cm, the PCF kernel is 3x3, and its penumbra is therefore
     * the same width where the tyre meets the tarmac as it is at the tip of the shadow 4 m away.
     * A constant-width penumbra is precisely what makes a car read as a decal hovering over the
     * road, so the fix is not "more blur" — it is a term that is HARD at the contact point.
     *
     * Two things make that happen here:
     *
     *  1. The search is a CONE, not a ray. At march distance t the sample is displaced sideways by
     *     +-t * tan(theta), theta being the light's angular radius. A blocker touching the surface
     *     is found at t~0 by every pixel (cone radius ~0 => hard edge); a blocker 80 cm up is found
     *     by only some of them (cone radius ~4 cm => soft edge). The side is chosen by a per-pixel
     *     dither decorrelated from the along-ray one, so neighbouring pixels sample opposite sides
     *     of the cone and the bilateral blur that already runs on this buffer resolves it into a
     *     smooth, correctly-widening penumbra for free.
     *  2. The step distribution is quadratic. Half the samples land in the first quarter of the
     *     march, which is where a contact shadow's entire signal lives.
     *
     * Occlusion decays with march distance, so the darkest part of the shadow is always the part
     * touching the occluder.
     */
    float contactShadow(vec3 P, vec3 N) {
      // A contact shadow that is thinner than a pixel is noise. Skip the whole march.
      if (-P.z > uContactDist) return 1.0;

      vec3 L = normalize(uSunView);
      float ndl = dot(N, L);
      if (ndl <= 0.02) return 1.0;   // already facing away; the N.L term owns this pixel

      float len = uContact.x;
      float thick = uContact.y;
      float lightTan = uContact.w;

      // Offset along the normal so a flat surface cannot shadow itself. Scales with view depth
      // because both depth precision and the error in a depth-reconstructed normal do.
      vec3 ro = P + N * (0.008 + 0.0022 * (-P.z));
      // Sideways basis for the cone. L is normalised, so any non-parallel vector works.
      vec3 up = abs(L.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
      vec3 T = normalize(cross(L, up));

      float jitter = ign(gl_FragCoord.xy);
      float side = bayer4(gl_FragCoord.xy) * 2.0 - 1.0;
      float occ = 0.0;
      float invS = 1.0 / float(CONTACT_STEPS);

      for (int i = 0; i < CONTACT_STEPS; i++) {
        float a = (float(i) + jitter) * invS;
        float t = len * a * a;                  // quadratic: dense at the contact point
        float cone = t * lightTan;              // penumbra half-width at this distance
        vec3 p = ro + L * t + T * (side * cone);
        vec4 clip = uProj * vec4(p, 1.0);
        if (clip.w <= 1e-5) break;
        vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
        float sd = texture2D(tDepth, suv).x;
        if (sd >= 0.9999) continue;             // sky: nothing to be occluded by
        float sceneZ = -linearDepth(sd, uNearFar.x, uNearFar.y);
        float diff = sceneZ - p.z;              // > 0 => an occluder sits in front of the ray point
        // Feather the acceptance by the penumbra width too, so the transition softens with
        // distance instead of popping between "hit" and "miss".
        float feather = 0.004 + cone;
        float hit = smoothstep(0.010, 0.010 + feather, diff)
                  * (1.0 - smoothstep(thick, thick + feather * 6.0 + 0.35, diff));
        occ = max(occ, hit * (1.0 - a * a * 0.85));
      }
      // Fade the whole term out where the surface turns away from the light, and where it is far
      // enough that the march can no longer resolve anything.
      float far = 1.0 - smoothstep(uContactDist * 0.6, uContactDist, -P.z);
      return 1.0 - occ * uContact.z * smoothstep(0.02, 0.22, ndl) * far;
    }
    #endif

    void main() {
      float d = texture2D(tDepth, vUv).x;
      float lz = linearDepth(d, uNearFar.x, uNearFar.y);
      if (d >= 0.9999 || lz > uNearFar.y * 0.85) {
        gl_FragColor = vec4(1.0, lz, 0.0, 1.0);
        return;
      }

      vec3 P = viewPosFromDepth(vUv, d, uInvProj);
      vec3 N = reconstructNormal(tDepth, vUv, uFullTexel, uInvProj, P, d);
      float ao = 1.0;

      #ifndef AO_CONTACT_ONLY
      float radiusPx = min(uParams.x * uParams.y / max(-P.z, 0.05), uParams.w);
      if (radiusPx < 1.2) {
        gl_FragColor = vec4(1.0, lz, 0.0, 1.0);
        return;
      }

      // Interleaved-gradient noise: stable across frames (no TAA here, so temporal jitter would
      // just read as boiling) but decorrelated in screen space.
      vec2 px = gl_FragCoord.xy;
      float phi = fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))) * 6.2831853;

      float occ = 0.0;
      float invN = 1.0 / float(AO_SAMPLES);
      float bias = uParams.z * max(-P.z, 1.0);
      for (int i = 0; i < AO_SAMPLES; i++) {
        float alpha = (float(i) + 0.5) * invN;
        float h = radiusPx * alpha;
        float theta = alpha * SPIRAL_TURNS * 6.2831853 + phi;
        vec2 off = h * vec2(cos(theta), sin(theta)) * uTexel;
        vec2 suv = vUv + off;
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
        float sd = texture2D(tDepth, suv).x;
        if (sd >= 0.9999) continue;
        vec3 Q = viewPosFromDepth(suv, sd, uInvProj);
        vec3 v = Q - P;
        float vv = dot(v, v);
        float vn = dot(v, N);
        // 1/(d^2) falloff, biased so a flat surface never occludes itself.
        float r2 = uParams.x * uParams.x;
        float f = max(r2 - vv, 0.0) / r2;
        occ += f * f * f * max(vn - bias, 0.0) / max(vv + 0.0001, 0.0001);
      }

      ao = max(0.0, 1.0 - occ * invN * 5.0 * uShade.x);
      ao = pow(ao, uShade.y);
      #endif

      #ifdef AO_CONTACT
        // Both terms are visibility, so they compose by multiplication and ride the same buffer,
        // the same bilateral blur and the same resolve.
        ao *= contactShadow(P, N);
      #endif

      // Fade out with distance: past ~150 m a 0.7 m sphere is sub-pixel, so anything the
      // estimator reports there is depth-buffer noise, not occlusion.
      ao = mix(ao, 1.0, smoothstep(uShade.z, uShade.w, -P.z));
      gl_FragColor = vec4(ao, lz, 0.0, 1.0);
    }
  `,
};

const BLUR_SHADER = {
  name: 'ao-blur',
  uniforms: {
    tAo: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uDir: { value: new THREE.Vector2(1, 0) },
    uNearFar: { value: new THREE.Vector2(0.15, 6000) },
  },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tAo;
    uniform vec2 uTexel, uDir, uNearFar;

    void main() {
      vec2 stp = uDir * uTexel;
      vec2 c = texture2D(tAo, vUv).rg;
      float sum = c.r * 0.383;
      float wsum = 0.383;
      // Depth tolerance in METRES, scaled by view depth. Half-res texels on a receding surface
      // separate linearly with distance, so a constant tolerance can only be right at one depth.
      // The floor keeps it sane at the near plane; the +0.05 on each weight guarantees the kernel
      // degrades to a plain gaussian rather than to a single tap when every neighbour is rejected.
      float tol = 0.035 * c.g + 0.05;
      // 4 taps each side, gaussian-ish weights, softly rejected across depth edges.
      for (int i = 1; i <= 4; i++) {
        float w = (i == 1 || i == 2) ? 0.24 : 0.062;
        float fi = float(i);
        vec2 o = stp * fi;
        vec2 a = texture2D(tAo, vUv + o).rg;
        vec2 b = texture2D(tAo, vUv - o).rg;
        float wa = w * (exp(-abs(a.g - c.g) / tol) + 0.05);
        float wb = w * (exp(-abs(b.g - c.g) / tol) + 0.05);
        sum += a.r * wa + b.r * wb;
        wsum += wa + wb;
      }
      gl_FragColor = vec4(sum / max(wsum, 1e-4), c.g, 0.0, 1.0);
    }
  `,
};

/**
 * Stamps `ao = 1` over the transparent, non-depth-writing surfaces. Rendered with the real scene
 * geometry at half res; `discard` implements the depth test by hand against the scene depth
 * texture, so the pass needs no depth attachment of its own and stays resolution-independent.
 */
const MASK_SHADER = {
  name: 'ao-transparent-mask',
  uniforms: {
    tDepth: { value: null },
    uInvSize: { value: new THREE.Vector2() },
    uNearFar: { value: new THREE.Vector2(0.15, 6000) },
  },
  vertexShader: /* glsl */ `
    varying float vViewZ;
    void main() {
      vec4 view = modelViewMatrix * vec4(position, 1.0);
      vViewZ = -view.z;
      gl_Position = projectionMatrix * view;
    }
  `,
  fragmentShader: /* glsl */ `
    varying float vViewZ;
    uniform sampler2D tDepth;
    uniform vec2 uInvSize, uNearFar;

    ${DEPTH_GLSL}

    void main() {
      vec2 uv = gl_FragCoord.xy * uInvSize;
      float sceneZ = linearDepth(texture2D(tDepth, uv).x, uNearFar.x, uNearFar.y);
      // Behind the opaque surface => this transparent fragment is not what the viewer sees here,
      // and stamping it would wrongly erase AO from whatever is in front of it.
      if (vViewZ > sceneZ + 0.05 + sceneZ * 0.01) discard;
      // .g must carry the depth the resolve's bilateral upsample will compare against, which is
      // the depth of the surface actually IN the buffer — not this fragment's own.
      gl_FragColor = vec4(1.0, sceneZ, 0.0, 1.0);
    }
  `,
  side: THREE.DoubleSide,
  depthTest: false,
  depthWrite: false,
  blending: THREE.NoBlending,
  toneMapped: false,
  fog: false,
};
