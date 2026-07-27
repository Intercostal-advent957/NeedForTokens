import * as THREE from 'three';
import { FsPass, makeHdrTarget } from './Fullscreen.js';
import { DEPTH_GLSL, HASH_GLSL, RECON_NORMAL_GLSL } from './ShaderLib.js';

/**
 * Screen-space reflections, deliberately scoped to the ground plane.
 *
 * A general SSR needs a G-buffer with roughness and normals; we have depth only, and a full SSR on
 * every surface in a city full of glass would cost more than the rest of the stack put together and
 * would look worse than the PMREM probe it replaces. What actually sells this game is one thing:
 * wet asphalt reflecting neon. So this traces only where the reconstructed normal is close to
 * world-up, weights the result by `env.wetness` and a Fresnel term, and lets everything else keep
 * using the environment map — which is the correct fallback, not a compromise.
 *
 * March is in screen space with a depth-thickness test and a short binary refine, then edge-faded
 * so a reflection never pops as it leaves the frame. Output alpha is the confidence ResolvePass
 * blends with.
 */
export class SsrPass {
  constructor(renderer) {
    this.renderer = renderer;
    this.scale = 0.5;
    this.failed = false;
    this.strength = 1.0;
    this.maxDistance = 90; // metres
    this.thickness = 0.55; // metres — how deep a depth sample is assumed to extend
    this.rt = null;
    this.pass = new FsPass(SHADER, { SSR_STEPS: '24', SSR_REFINE: '5' });
  }

  setSize(w, h) {
    const bw = Math.max(4, Math.round(w * this.scale));
    const bh = Math.max(4, Math.round(h * this.scale));
    if (this.rt && this.rt.width === bw && this.rt.height === bh) return;
    this.rt?.dispose();
    this.rt = makeHdrTarget(bw, bh);
    this.rt.texture.name = 'ssr';
  }

  /** @returns {THREE.Texture|null} */
  render(colorTexture, depthTexture, camera, wetness) {
    if (this.failed || !this.rt || wetness <= 0.01) return null;
    try {
      const u = this.pass.u;
      u.tColor.value = colorTexture;
      u.tDepth.value = depthTexture;
      u.uTexel.value.set(1 / this.rt.width, 1 / this.rt.height);
      u.uFullTexel.value.set(1 / (this.rt.width / this.scale), 1 / (this.rt.height / this.scale));
      u.uProj.value.copy(camera.projectionMatrix);
      u.uInvProj.value.copy(camera.projectionMatrixInverse);
      u.uViewToWorld.value.setFromMatrix4(camera.matrixWorld);
      u.uNearFar.value.set(camera.near, camera.far);
      u.uParams.value.set(this.maxDistance, this.thickness, wetness * this.strength, 0);
      this.pass.render(this.renderer, this.rt);
      return this.rt.texture;
    } catch (e) {
      console.warn('[postfx] SSR disabled:', e?.message || e);
      this.failed = true;
      return null;
    }
  }

  dispose() {
    this.rt?.dispose();
    this.pass.dispose();
  }
}

const SHADER = {
  name: 'ssr-ground',
  uniforms: {
    tColor: { value: null },
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uFullTexel: { value: new THREE.Vector2() },
    uProj: { value: new THREE.Matrix4() },
    uInvProj: { value: new THREE.Matrix4() },
    uViewToWorld: { value: new THREE.Matrix3() },
    uNearFar: { value: new THREE.Vector2(0.15, 6000) },
    uParams: { value: new THREE.Vector4(90, 0.5, 1, 0) }, // maxDist, thickness, wetness
  },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    uniform vec2 uTexel, uFullTexel, uNearFar;
    uniform mat4 uProj, uInvProj;
    uniform mat3 uViewToWorld;
    uniform vec4 uParams;

    ${DEPTH_GLSL}
    ${RECON_NORMAL_GLSL}
    ${HASH_GLSL}

    vec2 projectUv(vec3 viewPos) {
      vec4 clip = uProj * vec4(viewPos, 1.0);
      return (clip.xy / max(clip.w, 1e-5)) * 0.5 + 0.5;
    }

    void main() {
      gl_FragColor = vec4(0.0);
      float d = texture2D(tDepth, vUv).x;
      if (d >= 0.9999) return;

      vec3 P = viewPosFromDepth(vUv, d, uInvProj);
      vec3 N = reconstructNormal(tDepth, vUv, uFullTexel, uInvProj, P, d);
      vec3 Nw = uViewToWorld * N;

      // Ground only. Anything else keeps the environment probe.
      float ground = smoothstep(0.80, 0.96, Nw.y);
      if (ground < 0.01) return;

      vec3 V = normalize(P);
      vec3 R = reflect(V, N);
      if (R.z > -0.02) return;   // reflection heading back at the camera plane

      float fres = pow(1.0 - max(dot(-V, N), 0.0), 4.0);
      float weight = ground * uParams.z * mix(0.10, 1.0, fres);
      if (weight < 0.008) return;

      float maxDist = uParams.x;
      float stepLen = maxDist / float(SSR_STEPS);
      // Dither the ray origin so the banding from a coarse march turns into noise the half-res
      // upsample smooths away.
      float jitter = bayer4(gl_FragCoord.xy);
      vec3 ro = P + N * 0.05;

      float hitT = -1.0;
      vec2 hitUv = vec2(0.0);
      float prevT = 0.0;
      for (int i = 1; i <= SSR_STEPS; i++) {
        float t = (float(i) + jitter) * stepLen;
        vec3 p = ro + R * t;
        vec2 uv = projectUv(p);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
        float sd = texture2D(tDepth, uv).x;
        if (sd >= 0.9999) { prevT = t; continue; }
        float sceneZ = -linearDepth(sd, uNearFar.x, uNearFar.y);
        float rayZ = p.z;
        float diff = sceneZ - rayZ;     // >0 means the ray is behind the surface
        if (diff > 0.0 && diff < uParams.y + t * 0.03) {
          // binary refine between prevT and t
          float lo = prevT, hi = t;
          for (int j = 0; j < SSR_REFINE; j++) {
            float mid = (lo + hi) * 0.5;
            vec3 pm = ro + R * mid;
            vec2 um = projectUv(pm);
            float sdm = texture2D(tDepth, um).x;
            float szm = -linearDepth(sdm, uNearFar.x, uNearFar.y);
            if (szm - pm.z > 0.0) hi = mid; else lo = mid;
          }
          hitT = hi;
          hitUv = projectUv(ro + R * hi);
          break;
        }
        prevT = t;
      }

      if (hitT < 0.0) return;

      // Fade at the screen border and with ray length — both are hard SSR failure modes and the
      // env map underneath is a perfectly good answer.
      vec2 e = smoothstep(vec2(0.0), vec2(0.12), hitUv) * (1.0 - smoothstep(vec2(0.88), vec2(1.0), hitUv));
      float edge = e.x * e.y;
      float distFade = 1.0 - smoothstep(maxDist * 0.55, maxDist, hitT);
      vec3 col = texture2D(tColor, hitUv).rgb;
      // A wet road is not a mirror: tint slightly and never return more energy than it received.
      gl_FragColor = vec4(min(col, vec3(12.0)), weight * edge * distFade);
    }
  `,
};
