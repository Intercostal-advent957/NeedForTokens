import * as THREE from 'three';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { clamp01 } from '../core/MathX.js';
import { FsPass, makeHdrTarget, makeLdrTarget } from './Fullscreen.js';
import { BloomPass } from './BloomPass.js';
import { AutoExposure } from './AutoExposure.js';
import { GradePass } from './GradePass.js';
import { AoPass } from './AoPass.js';
import { ResolvePass } from './ResolvePass.js';
import { VelocityPass } from './VelocityPass.js';
import { MotionBlurPass } from './MotionBlurPass.js';
import { SsrPass } from './SsrPass.js';
import { ReflectionProbe } from './ReflectionProbe.js';
import { GodRaysPass } from './GodRaysPass.js';
import { DofPass } from './DofPass.js';
import { makeLensDirtTexture } from './LensDirt.js';
import { LOOKS, bakeLut, lerpLook, lookDistance, makeLutTexture, neutralLook } from './Lut.js';

/**
 * POST — owns the frame. CONTRACTS.md §15. Nothing else in the project may call
 * `renderer.render` against the default framebuffer.
 *
 *   post.render(dt)   post.setEnabled(name, bool)   post.resize(w, h)   post.needsVelocity
 *
 * ============================ why there is no EffectComposer ============================
 * Half this stack needs the scene *depth* buffer (AO, SSR, motion-blur reprojection, DOF) and it
 * needs it to still be intact eight passes later. EffectComposer ping-pongs two colour targets and
 * three's ShaderMaterial defaults to depthWrite:true, so a composer chain quietly stomps whatever
 * depth attachment you hang off the render targets. A hand-rolled chain is about sixty lines,
 * gives us one authoritative `sceneRT` with a live DepthTexture, and lets the half-res effects
 * share a single full-res resolve instead of each paying for its own read/modify/write.
 *
 * ============================ pass order ============================
 *   0  car reflection probe          (ONE cube face per frame, cars hidden — ReflectionProbe.js)
 *   1  scene            -> sceneRT (RGBA16F + depth)
 *   2  velocity         -> velRT      (dynamic objects only; static world is reprojected)
 *   3  AO               -> aoRT       (half res)
 *   4  SSR              -> ssrRT      (half res, ground only)
 *   5  god rays         -> grRT       (half res)
 *   6  resolve          -> hdrA       (single full-res pass that applies 3, 4 and 5 at once)
 *   7  DOF              -> hdrB
 *   8  motion blur      -> hdrA
 *   9  bloom mips       (from whichever HDR buffer is current)
 *  10  grade            -> ldrRT      (CA, bloom, flare, exposure, ACES, LUT, vignette, grain)
 *  11  SMAA             -> screen
 */
export class PostFxSystem {
  constructor(ctx) {
    this.ctx = ctx;
    /** CONTRACTS §15 — main.js may use this to keep previous matrices around. */
    this.needsVelocity = false;
    this.enabled = new Map();
    this.ready = false;
    this._failed = false;

    this.width = 2;
    this.height = 2;

    // feature switches, resolved from settings each onQuality()
    this.want = {
      bloom: true,
      ssao: true,
      /** screen-space contact shadows — on at every tier, see onQuality() */
      contact: true,
      ssr: true,
      motionBlur: true,
      dof: true,
      godrays: true,
      lensFlare: true,
      chromatic: true,
      grain: true,
      smaa: true,
      autoExposure: true,
    };

    this._look = neutralLook();
    this._lookTarget = neutralLook();
    this._lutDirty = true;
    this._lutCooldown = 0;
    this._prevViewProj = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._prevValid = false;
    this._prevCamPos = new THREE.Vector3();
    this._prevCamQuat = new THREE.Quaternion();
    this._motionEnergy = 0;
    this._cpuMs = 0;
  }

  async init() {
    const { renderer, settings } = this.ctx;
    try {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      this.width = Math.max(2, size.x | 0);
      this.height = Math.max(2, size.y | 0);

      this._allocTargets();

      this.bloom = new BloomPass(renderer);
      this.bloom.setSize(this.width, this.height);

      this.exposure = new AutoExposure(renderer);

      this.grade = new GradePass();
      this.lut = makeLutTexture();
      this.grade.u.tLut.value = this.lut;
      this.grade.setDefine('USE_LUT', '');

      this.copy = new FsPass(COPY_SHADER);

      this.smaa = new SMAAPass(this.width, this.height);
      this.smaa.renderToScreen = true;

      // Optional stages — each is lazily constructed by the module that owns it so a failure in
      // one never takes the frame down.
      this._initOptional();

      this._syncLookTarget(true);
      this.onQuality(settings?.tier);
      this.ready = true;
    } catch (err) {
      console.error('[postfx] init failed — falling back to direct render:', err);
      this._failed = true;
    }
    return this;
  }

  /** Everything that can fail independently. A throw here must never take the frame down. */
  _initOptional() {
    const { renderer } = this.ctx;
    try {
      this.ao = new AoPass(renderer);
      this.ao.setSize(this.width, this.height);
    } catch (e) {
      console.warn('[postfx] AO unavailable:', e?.message || e);
      this.ao = null;
    }
    try {
      this.resolve = new ResolvePass();
    } catch (e) {
      console.warn('[postfx] resolve unavailable:', e?.message || e);
      this.resolve = null;
    }
    try {
      this.velocity = new VelocityPass(this.ctx);
      this.velocity.setSize(this.width, this.height);
      this.motionBlur = new MotionBlurPass(12);
    } catch (e) {
      console.warn('[postfx] motion blur unavailable:', e?.message || e);
      this.velocity = null;
      this.motionBlur = null;
    }
    try {
      this.ssr = new SsrPass(renderer);
      this.ssr.setSize(this.width, this.height);
    } catch (e) {
      console.warn('[postfx] SSR unavailable:', e?.message || e);
      this.ssr = null;
    }
    try {
      this.probe = new ReflectionProbe(renderer);
      this.probe.setSize(128);
    } catch (e) {
      console.warn('[postfx] reflection probe unavailable:', e?.message || e);
      this.probe = null;
    }
    try {
      this.godRays = new GodRaysPass(renderer);
      this.godRays.setSize(this.width, this.height);
    } catch (e) {
      console.warn('[postfx] god rays unavailable:', e?.message || e);
      this.godRays = null;
    }
    try {
      this.dof = new DofPass(renderer);
      this.dof.setSize(this.width, this.height);
    } catch (e) {
      console.warn('[postfx] DOF unavailable:', e?.message || e);
      this.dof = null;
    }
    try {
      this.dirtTexture = makeLensDirtTexture(512);
      this.grade.u.tDirt.value = this.dirtTexture;
    } catch (e) {
      console.warn('[postfx] lens dirt unavailable:', e?.message || e);
      this.dirtTexture = null;
    }
  }

  // ------------------------------------------------------------------ targets

  _allocTargets() {
    const w = this.width;
    const h = this.height;
    this.sceneRT?.dispose();
    this.hdrA?.dispose();
    this.hdrB?.dispose();
    this.ldrRT?.dispose();

    this.sceneRT = makeHdrTarget(w, h, { depth: true });
    this.sceneRT.texture.name = 'post-scene';
    this.hdrA = makeHdrTarget(w, h);
    this.hdrA.texture.name = 'post-hdrA';
    this.hdrB = makeHdrTarget(w, h);
    this.hdrB.texture.name = 'post-hdrB';
    this.ldrRT = makeLdrTarget(w, h);
    this.ldrRT.texture.name = 'post-ldr';
  }

  resize(w, h) {
    if (this._failed) return;
    const pr = this.ctx.renderer.getPixelRatio();
    const nw = Math.max(2, Math.round(w * pr));
    const nh = Math.max(2, Math.round(h * pr));
    if (nw === this.width && nh === this.height) return;
    this.width = nw;
    this.height = nh;
    try {
      this.sceneRT.setSize(nw, nh);
      this.sceneRT.depthTexture.image.width = nw;
      this.sceneRT.depthTexture.image.height = nh;
      this.sceneRT.depthTexture.needsUpdate = true;
      this.hdrA.setSize(nw, nh);
      this.hdrB.setSize(nw, nh);
      this.ldrRT.setSize(nw, nh);
      this.bloom?.setSize(nw, nh);
      this.smaa?.setSize(nw, nh);
      this._resizeOptional(nw, nh);
    } catch (e) {
      console.warn('[postfx] resize failed:', e?.message || e);
    }
  }

  _resizeOptional(w, h) {
    this.ao?.setSize(w, h);
    this.velocity?.setSize(w, h);
    this.ssr?.setSize(w, h);
    this.godRays?.setSize(w, h);
    this.dof?.setSize(w, h);
  }

  onResize(w, h) {
    this.resize(w, h);
  }

  // ------------------------------------------------------------------ settings

  setEnabled(name, v) {
    this.enabled.set(name, !!v);
    if (name in this.want) this.want[name] = !!v;
  }

  _want(key, settingKey = key) {
    if (this.enabled.has(key)) return this.enabled.get(key);
    return !!this.ctx.settings?.get?.(settingKey);
  }

  onQuality(tier) {
    const s = this.ctx.settings;
    if (!s || this._failed) return;
    const t = tier ?? s.tier;
    const low = t === 'low';

    this.want.bloom = this._want('bloom');
    this.want.ssao = !low && this._want('ssao');
    // Contact shadows are GROUNDING, not ambience. A car with nothing under it reads as a decal
    // hovering over the road at every tier, and at night on low there is no sun shadow to stand in
    // either. They ride in the AO buffer, so instead of switching that buffer off on low we run it
    // in contact-only mode: one short march, no spiral kernel, no extra target.
    this.want.contact = this.enabled.has('ssao') ? this.enabled.get('ssao') : true;
    this.want.ssr = !low && this._want('ssr');
    this.want.motionBlur = !low && this._want('motionBlur');
    this.want.dof = !low && this._want('dof');
    this.want.godrays = !low && this._want('godrays');
    this.want.lensFlare = !low && this._want('lensFlare');
    this.want.chromatic = this._want('chromatic');
    this.want.grain = this._want('grain');
    this.want.autoExposure = true;
    this.needsVelocity = this.want.motionBlur;

    if (this.bloom) {
      this.bloom.setLevels(s.get('bloomQuality') ?? 5);
      this.bloom.setSize(this.width, this.height);
    }
    if (this.grade) {
      this.grade.setDefine('USE_CA', this.want.chromatic ? '' : null);
      this.grade.setDefine('USE_GRAIN', this.want.grain ? '' : null);
      this.grade.setDefine('USE_FLARE', this.want.lensFlare ? '' : null);
      this.grade.setDefine('USE_DIRT', this.want.lensFlare ? '' : null);
    }
    this._qualityOptional(t, low);
  }

  _qualityOptional(tier) {
    if (this.ao) {
      // Half res everywhere; ultra gets a denser kernel rather than more pixels — AO is a
      // low-frequency signal, sample count buys far more than resolution does.
      this.ao.compute.setDefine('AO_SAMPLES', tier === 'ultra' ? '16' : tier === 'high' ? '11' : '8');
      // The contact march is NOT low-frequency — it is the tight dark line under the tyres, so it
      // keeps a usable step count even on low, where it is the only grounding cue left.
      this.ao.compute.setDefine(
        'CONTACT_STEPS',
        tier === 'ultra' ? '16' : tier === 'high' ? '12' : '9'
      );
      this.ao.scale = tier === 'ultra' ? 0.6 : 0.5;
      this.ao.setSize(this.width, this.height);
    }
    if (this.motionBlur) {
      // The single most expensive pass in the stack (full res, 3 fetches per tap). 10 taps with
      // an IGN-dithered start offset is visually indistinguishable from 16 at this blur length.
      this.motionBlur.setSamples(tier === 'ultra' ? 14 : tier === 'high' ? 10 : 8);
    }
    if (this.velocity) {
      this.velocity.scale = tier === 'low' ? 0.5 : 1.0;
      this.velocity.setSize(this.width, this.height);
    }
    if (this.ssr) {
      this.ssr.pass.setDefine('SSR_STEPS', tier === 'ultra' ? '32' : '22');
      this.ssr.scale = tier === 'ultra' ? 0.6 : 0.5;
      this.ssr.setSize(this.width, this.height);
    }
    if (this.probe) {
      // `reflectionProbe` is false only on low, where the whole point is to stop rendering the
      // world more than once per frame.
      this.probe.enabled = this.ctx.settings?.get?.('reflectionProbe') !== false;
      // Resolution is nearly free here (the cost is draw calls, not fill), but a clearcoat at
      // roughness 0.035 is a mirror, so the extra texels do show on ultra.
      this.probe.setSize(tier === 'ultra' ? 192 : 128);
      // Never more than one face per frame: two doubles the worst-case spike for a refresh
      // latency nobody can see.
      this.probe.facesPerFrame = 1;
      this.probe.maxInterval = tier === 'ultra' ? 0.5 : 0.75;
    }
    if (this.godRays) {
      this.godRays.blur.setDefine('GR_SAMPLES', tier === 'ultra' ? '16' : '12');
      this.godRays.scale = tier === 'ultra' ? 0.35 : 0.25;
      this.godRays.setSize(this.width, this.height);
    }
    if (this.dof) {
      this.dof.pass.setDefine('DOF_SAMPLES', tier === 'ultra' ? '28' : '18');
    }
    if (this.grade) this.grade.setDefine('USE_DOF', this.want.dof ? '' : null);
  }

  // ------------------------------------------------------------------ look

  _syncLookTarget(snap = false) {
    const preset = this.ctx.env?.preset;
    const target = LOOKS[preset] || LOOKS.noon;
    if (snap) {
      lerpLook(this._look, target, target, 1);
      lerpLook(this._lookTarget, target, target, 1);
      this._lutDirty = true;
      return;
    }
    this._lookTarget = target;
  }

  _updateLut(dt) {
    if (!this.lut) return;
    const target = this._lookTarget;
    const d = lookDistance(this._look, target);
    if (d > 1e-4) {
      const k = 1 - Math.exp(-dt * 2.6);
      lerpLook(this._look, this._look, target, k);
      this._lutDirty = true;
    }
    this._lutCooldown -= dt;
    if (this._lutDirty && this._lutCooldown <= 0) {
      bakeLut(this.lut, this._look);
      this._lutDirty = d > 1e-3;
      this._lutCooldown = 0.05;
    }
  }

  // ------------------------------------------------------------------ frame

  render(dt) {
    const { renderer, scene, camera } = this.ctx;
    if (this._failed || !this.ready) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    try {
      this._renderChain(dt);
    } catch (err) {
      console.error('[postfx] frame failed, falling back to direct render:', err);
      this._failed = true;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    }
  }

  _renderChain(dt) {
    const { renderer, scene, camera, env, player } = this.ctx;
    const step = Math.max(dt || 0, 1e-4);

    this._syncLookTarget();
    this._updateLut(step);

    // ---- camera matrices + history discontinuity ------------------------------------------
    camera.updateMatrixWorld();
    this._prevViewProj.copy(this._viewProj);
    this._viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    // How far did the camera actually move and turn since the previous frame?
    const dPos = this._prevValid ? camera.position.distanceTo(this._prevCamPos) : 0;
    const dot = this._prevValid ? Math.abs(this._prevCamQuat.dot(camera.quaternion)) : 1;
    const dAng = 2 * Math.acos(Math.min(1, dot));
    const carSpeed = Math.abs(player?.state?.speed ?? 0);

    // A teleport, a camera-mode cut or a photo pose is a CUT, not motion. Reprojecting across it
    // produces one frame of enormous apparent velocity — which is exactly the window the QA
    // harness screenshots in. Treat it as a new shot: clear the history.
    const moveLimit = Math.max(2.0, carSpeed * step * 8 + 1.5);
    const cut = !this._prevValid || dPos > moveLimit || dAng > 0.42;
    if (cut) {
      this._prevViewProj.copy(this._viewProj);
      this.velocity?.resetHistory();
      this.exposure?.reset();
    }
    this._prevCamPos.copy(camera.position);
    this._prevCamQuat.copy(camera.quaternion);
    this._prevValid = true;

    // Screen-space motion estimate, as a fraction of screen height. Used as a deadband so a
    // parked car in front of a parked camera gets a bit-exact sharp frame, not a "small" blur.
    const fovRad = (camera.fov * Math.PI) / 180;
    const tanHalf = Math.max(Math.tan(fovRad * 0.5), 1e-3);
    const focus = Math.max(this.dof?.focus ?? 12, 2);
    this._motionEnergy = cut ? 0 : dAng / fovRad + dPos / focus / (2 * tanHalf);

    // ---- 0. car reflection probe --------------------------------------------------------------
    // Before the beauty pass, because it moves the render target and hides the cars. One face per
    // frame; the cars only see a new cube once a full sweep lands.
    if (this.probe && !this.probe.failed) {
      const tex = this.probe.update(this.ctx, step);
      if (tex) this.ctx.cars?.setReflectionProbe?.(tex);
    }

    // ---- 1. scene ---------------------------------------------------------------------------
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    void prevTarget;

    let cur = this.sceneRT.texture;
    const speedKmh = Math.abs(player?.state?.speedKmh ?? 0);
    this._speedN = clamp01((speedKmh - 70) / 240);

    // ---- optional mid-chain (AO / SSR / god rays / DOF / motion blur) -------------------------
    cur = this._renderOptional(cur, step);

    // ---- auto exposure ------------------------------------------------------------------------
    let expTex = null;
    if (this.want.autoExposure && this.exposure) {
      expTex = this.exposure.render(this.sceneRT.texture, step);
    }

    // ---- bloom --------------------------------------------------------------------------------
    let bloomTex = null;
    if (this.want.bloom && this.bloom) bloomTex = this.bloom.render(cur);

    // ---- grade --------------------------------------------------------------------------------
    const g = this.grade.u;
    g.tDiffuse.value = cur;
    g.tBloom.value = bloomTex || BLACK_TEXTURE(renderer);
    g.tExposure.value = expTex;
    g.uAutoEnabled.value = expTex && !this.exposure.failed ? 1 : 0;
    g.uBloom.value = this.want.bloom ? this._bloomStrength() : 0;
    g.uResolution.value.set(this.width, this.height);
    g.uTime.value = this.ctx.time?.elapsed ?? 0;
    g.uExposure.value = renderer.toneMappingExposure ?? 1;

    g.uSpeed.value = this._speedN;
    g.uNos.value = player?.state?.nosActive ? 1 : 0;

    this._updateFlare(env);

    this.grade.render(renderer, this.want.smaa ? this.ldrRT : null);

    // ---- AA -----------------------------------------------------------------------------------
    if (this.want.smaa && this.smaa) {
      this.smaa.renderToScreen = true;
      this.smaa.render(renderer, null, this.ldrRT);
    }

    // ---- debug views (set post.debugView from the console / QA harness) -------------------------
    if (this.debugView) this._renderDebug(renderer);
    renderer.setRenderTarget(null);
  }

  /** `post.debugView = 'ao' | 'velocity' | 'ssr' | 'godrays' | 'dof' | 'bloom' | null` */
  _renderDebug(renderer) {
    const map = {
      ao: [this.ao?.rtA?.texture, 1],
      velocity: [this.velocity?.rt?.texture, 2],
      ssr: [this.ssr?.rt?.texture, 3],
      godrays: [this.godRays?.rtA?.texture, 0],
      dof: [this.dof?.rt?.texture, 0],
      bloom: [this.bloom?.mips?.[0]?.texture, 0],
    };
    const entry = map[this.debugView];
    if (!entry || !entry[0]) return;
    this.copy.u.tDiffuse.value = entry[0];
    this.copy.u.uMode.value = entry[1];
    this.copy.render(renderer, null);
  }

  /**
   * Everything between the scene render and the grade. Each stage is individually skippable and
   * individually fatal-proof; `cur` is whichever texture holds the live frame.
   */
  _renderOptional(cur, dt) {
    const { renderer, camera, env } = this.ctx;
    const depth = this.sceneRT.depthTexture;

    // ---- half-res effect buffers ----------------------------------------------------------
    let aoTex = null;
    if ((this.want.ssao || this.want.contact) && this.ao && !this.ao.failed) {
      this.ao.compute.setDefine('AO_CONTACT_ONLY', this.want.ssao ? null : '');
      aoTex = this.ao.render(depth, camera, this.ctx);
    }

    let ssrTex = null;
    if (this.want.ssr && this.ssr && !this.ssr.failed) {
      const wet = env?.wetness ?? 0;
      ssrTex = this.ssr.render(cur, depth, camera, wet);
    }

    let godTex = null;
    if (this.want.godrays && this.godRays && !this.godRays.failed) {
      const vis = env?.sunScreenValid ? (env.sunVisibility ?? 0) : 0;
      const ndc = env?.sunScreenPosition;
      if (vis > 0.01 && ndc) {
        _sunUv.set(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5);
        godTex = this.godRays.render(cur, depth, _sunUv, vis);
      }
    }

    // ---- single full-res resolve -----------------------------------------------------------
    if ((aoTex || ssrTex || godTex) && this.resolve) {
      const r = this.resolve;
      r.setDefine('USE_AO', aoTex ? '' : null);
      r.setDefine('USE_SSR', ssrTex ? '' : null);
      r.setDefine('USE_GOD', godTex ? '' : null);
      const u = r.u;
      u.tDiffuse.value = cur;
      u.tDepth.value = depth;
      u.tAo.value = aoTex;
      u.tSsr.value = ssrTex;
      u.tGod.value = godTex;
      if (this.ao?.rtA) u.uAoTexel.value.set(1 / this.ao.rtA.width, 1 / this.ao.rtA.height);
      u.uNearFar.value.set(camera.near, camera.far);
      u.uAo.value.set(1.0, 0.5, 0.1);
      u.uSsr.value = 1.0;
      u.uGod.value = 1.0;
      const sc = env?.sunLight?.color;
      if (sc) u.uGodColor.value.copy(sc);
      r.render(renderer, this.hdrA);
      cur = this.hdrA.texture;
    }

    // ---- depth of field (half res; GradePass does the mix) -----------------------------------
    if (this.want.dof && this.dof && !this.dof.failed) {
      this._updateFocus();
      const t = this.dof.render(cur, depth, camera, this.height);
      this.grade.u.tDof.value = t;
      this.grade.setDefine('USE_DOF', t ? '' : null);
    } else if (this.grade.material.defines.USE_DOF !== undefined) {
      this.grade.setDefine('USE_DOF', null);
    }

    // ---- motion blur -------------------------------------------------------------------------
    // A showcase/photo frame must be pristine: the whole point of those cameras is to hold still
    // and be looked at, and a 30 px smear across the hero car is the opposite of that.
    const camMode = this.ctx.cameras?.mode;
    const showcase = camMode === 'photo' || camMode === 'orbit';
    // Deadband: the estimated screen travel has to exceed ~1.5 px at 1080p before the pass runs
    // at all, and the player's own motion has to be real. Nothing moving => bit-exact sharp frame.
    const carSpeedMs = Math.abs(this.ctx.player?.state?.speed ?? 0);
    const moving = this._motionEnergy > 0.0014 || carSpeedMs > 0.8;
    if (this.want.motionBlur && this.motionBlur && !this.motionBlur.failed && !showcase && moving) {
      let velTex = null;
      if (this.velocity && !this.velocity.failed) velTex = this.velocity.render(this._prevViewProj);
      this.motionBlur.configure({
        camera,
        depth,
        velocity: velTex,
        prevViewProj: this._prevViewProj,
        dt,
        width: this.width,
        height: this.height,
        speedN: this._speedN ?? 0,
        nos: this.ctx.player?.state?.nosActive ? 1 : 0,
      });
      this.motionBlur.u.tDiffuse.value = cur;
      const dst = cur === this.hdrA.texture ? this.hdrB : this.hdrA;
      this.motionBlur.render(renderer, dst);
      cur = dst.texture;
    }

    return cur;
  }

  /**
   * Focus plane. The subject is the car, always — a centre-screen autofocus wanders onto the road
   * surface every time the camera swings through a corner, which reads as a focus pull nobody
   * asked for. Photo/showcase mode opens the aperture; gameplay keeps it nearly closed.
   */
  _updateFocus() {
    const { camera, cameras, player } = this.ctx;
    const target = player?.state?.position;
    let dist = this.dof.focus;
    if (target) dist = camera.position.distanceTo(target);
    else dist = 12;
    // Ease so a camera cut does not snap the focus.
    this.dof.focus += (Math.max(dist, 1.2) - this.dof.focus) * 0.25;

    const mode = cameras?.mode;
    const showcase = mode === 'photo' || mode === 'orbit' || mode === 'cinematic';
    this.dof.maxRadius = showcase ? 8.5 : 3.0;
    this.dof.nearStrength = showcase ? 0.8 : 0.35;
    this.dof.farStrength = showcase ? 1.0 : 0.7;
    this.grade.u.uDof.value = showcase ? 0.95 : 0.6;
  }

  _bloomStrength() {
    // Wet night streets carry more airborne moisture, so a touch more veiling glare; daylight
    // gets the minimum that still makes a specular highlight feel hot.
    const env = this.ctx.env;
    const wet = env?.wetness ?? 0;
    const night = env ? 1 - clamp01(((env.sunAltitude ?? 0.3) + 0.1) / 0.25) : 0;
    return 0.05 + wet * 0.018 + night * 0.022;
  }

  _updateFlare(env) {
    const g = this.grade.u;
    if (!this.want.lensFlare) {
      g.uFlare.value.set(0, 0, 0, 0);
      g.uDirt.value = 0;
      return;
    }
    const vis = env?.sunScreenValid ? (env.sunVisibility ?? 0) : 0;
    const ndc = env?.sunScreenPosition;
    if (ndc) g.uFlare.value.set(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5, vis, vis * 0.35);
    else g.uFlare.value.set(0.5, 0.5, 0, 0);
    g.uDirt.value = this.dirtTexture ? 0.5 : 0;
  }

  dispose() {
    this.sceneRT?.dispose();
    this.hdrA?.dispose();
    this.hdrB?.dispose();
    this.ldrRT?.dispose();
    this.bloom?.dispose();
    this.exposure?.dispose();
    this.grade?.dispose();
    this.copy?.dispose();
    this.smaa?.dispose();
    this.lut?.dispose();
    this.ao?.dispose();
    this.resolve?.dispose();
    this.velocity?.dispose();
    this.motionBlur?.dispose();
    this.ssr?.dispose();
    this.probe?.dispose();
    this.godRays?.dispose();
    this.dof?.dispose();
    this.dirtTexture?.dispose();
  }
}

// ------------------------------------------------------------------------------------------

let _black = null;
function BLACK_TEXTURE() {
  if (!_black) {
    _black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    _black.needsUpdate = true;
  }
  return _black;
}

const _sunUv = new THREE.Vector2();

const COPY_SHADER = {
  name: 'copy',
  uniforms: { tDiffuse: { value: null }, uMode: { value: 0 } },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uMode;
    void main() {
      vec4 t = texture2D(tDiffuse, vUv);
      vec3 c = t.rgb;
      if (uMode > 0.5 && uMode < 1.5) c = vec3(t.r);                          // AO
      else if (uMode > 1.5 && uMode < 2.5) c = vec3(t.rg * 24.0 + 0.5, t.a);  // velocity
      else if (uMode > 2.5) c = mix(vec3(0.0), t.rgb, t.a);                   // SSR
      gl_FragColor = vec4(c, 1.0);
    }
  `,
};
