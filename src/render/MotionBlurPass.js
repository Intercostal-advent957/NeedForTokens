import * as THREE from 'three';
import { FsPass } from './Fullscreen.js';
import { DEPTH_GLSL, HASH_GLSL } from './ShaderLib.js';

/**
 * Velocity-buffer motion blur — the single biggest "sense of speed" lever in a racing game.
 *
 * Velocity comes from two sources and they are combined per pixel:
 *   1. the static world, reprojected from the depth buffer with the previous frame's
 *      view-projection (free — no geometry pass, exact for anything that does not move);
 *   2. VelocityPass, which draws the cars and the player's four wheels with their previous model
 *      matrices, so the body stays sharp in chase cam while the wheels streak rotationally.
 *   A dynamic sample is only trusted when its stored depth matches the scene depth, which gives
 *   correct occlusion without sharing a depth attachment between render targets.
 *
 * The gather is McGuire et al. 2012 ("A Reconstruction Filter for Plausible Motion Blur"): each
 * tap is classified as foreground or background against the centre and weighted by whether its own
 * velocity could plausibly have carried it here. That is what lets a fast object bleed OUT over a
 * static background instead of the background smearing across the object.
 *
 * Blur length is normalised to a 60 Hz frame so the look does not change with frame rate, and
 * scaled by a shutter angle (0.5 = 180 deg, the film default).
 */
export class MotionBlurPass extends FsPass {
  constructor(samples = 12) {
    super(SHADER, { MB_SAMPLES: String(samples) });
    /** 0.5 == a 180-degree shutter, the film default. */
    this.shutter = 0.46;
    /** hard ceiling as a fraction of screen height — beyond ~3% it stops reading as speed and
     *  starts reading as a broken frame */
    this.maxBlur = 0.024;
    this.failed = false;
  }

  setSamples(n) {
    this.setDefine('MB_SAMPLES', String(Math.max(4, Math.min(20, n | 0))));
  }

  configure({ camera, depth, velocity, prevViewProj, dt, width, height, speedN, nos }) {
    const u = this.u;
    u.tDepth.value = depth;
    u.tVelocity.value = velocity;
    u.uHasVelocity.value = velocity ? 1 : 0;
    u.uInvViewProj.value.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse).invert();
    u.uPrevViewProj.value.copy(prevViewProj);
    u.uNearFar.value.set(camera.near, camera.far);
    u.uTexel.value.set(1 / width, 1 / height);
    u.uResolution.value.set(width, height);
    // 60 Hz reference: at 30 fps a frame covers twice the distance, so halve the multiplier.
    const norm = Math.min(1 / (60 * Math.max(dt, 1e-4)), 2.0);
    u.uScale.value = this.shutter * norm;
    u.uMax.value = this.maxBlur * (1 + (speedN ?? 0) * 0.45 + (nos ?? 0) * 0.3);
  }
}

const SHADER = {
  name: 'motion-blur',
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    tVelocity: { value: null },
    uHasVelocity: { value: 0 },
    uInvViewProj: { value: new THREE.Matrix4() },
    uPrevViewProj: { value: new THREE.Matrix4() },
    uNearFar: { value: new THREE.Vector2(0.15, 6000) },
    uTexel: { value: new THREE.Vector2() },
    uResolution: { value: new THREE.Vector2() },
    uScale: { value: 0.6 },
    uMax: { value: 0.045 },
  },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tVelocity;
    uniform float uHasVelocity;
    uniform mat4 uInvViewProj;
    uniform mat4 uPrevViewProj;
    uniform vec2 uNearFar, uTexel, uResolution;
    uniform float uScale, uMax;

    ${DEPTH_GLSL}
    ${HASH_GLSL}

    // uv-space velocity of a *static* world point, from depth reprojection.
    vec2 cameraVelocity(vec2 uv, float d) {
      vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      vec4 world = uInvViewProj * clip;
      world /= world.w;
      vec4 prev = uPrevViewProj * world;
      vec2 prevUv = (prev.xy / max(prev.w, 1e-5)) * 0.5 + 0.5;
      return uv - prevUv;
    }

    struct Sample { vec2 vel; float z; };

    Sample fetchVel(vec2 uv) {
      Sample s;
      float d = texture2D(tDepth, uv).x;
      s.z = linearDepth(d, uNearFar.x, uNearFar.y);
      s.vel = cameraVelocity(uv, d);
      if (uHasVelocity > 0.5) {
        vec4 dyn = texture2D(tVelocity, uv);
        // dyn.a = coverage, dyn.z = the view depth the dynamic object was rasterised at.
        // Reject it when the scene is much closer: that pixel is occluded by the world.
        if (dyn.a > 0.5 && abs(dyn.z - s.z) < max(0.06 * s.z, 0.12)) s.vel = dyn.xy;
      }
      return s;
    }

    float softDepthCompare(float za, float zb) {
      return clamp(1.0 - (za - zb) / max(0.06 * min(za, zb), 0.05), 0.0, 1.0);
    }
    float cone(float dist, float len) { return clamp(1.0 - dist / max(len, 1e-5), 0.0, 1.0); }
    float cylinder(float dist, float len) {
      return 1.0 - smoothstep(0.95 * len, 1.05 * len, dist);
    }

    void main() {
      vec3 centre = texture2D(tDiffuse, vUv).rgb;
      Sample c = fetchVel(vUv);

      vec2 vel = c.vel * uScale;
      float aspect = uResolution.x / uResolution.y;
      // Clamp in *screen* units so a wide aspect does not get twice the horizontal streak.
      vec2 velPx = vec2(vel.x * aspect, vel.y);
      float len = length(velPx);
      float maxLen = uMax;
      if (len > maxLen) { vel *= maxLen / len; len = maxLen; }

      float lenPx = len * uResolution.y;
      if (lenPx < 1.0) { gl_FragColor = vec4(centre, 1.0); return; }

      float jitter = ign(gl_FragCoord.xy) - 0.5;
      vec3 sum = centre;
      float wsum = 1.0;
      float invS = 1.0 / float(MB_SAMPLES);

      for (int i = 0; i < MB_SAMPLES; i++) {
        float t = (float(i) + 0.5 + jitter) * invS - 0.5;   // -0.5 .. 0.5
        vec2 suv = vUv + vel * t;
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

        Sample s = fetchVel(suv);
        vec2 sVelPx = vec2(s.vel.x * uScale * aspect, s.vel.y * uScale);
        float sLen = length(sVelPx);
        float dist = abs(t) * len;

        // Classification is the whole point of the filter and it is easy to get backwards: f
        // must be 1 when the TAP is nearer than us (a foreground object whose smear can reach
        // back over us), b when the tap is further (background we uncover because WE are
        // smeared and therefore semi-transparent). Swap these two and a sharp foreground car
        // gathers the fast-moving road behind it — the car ends up exactly as blurred as the
        // world it is driving through, which defeats the entire velocity buffer.
        float f = softDepthCompare(s.z, c.z);   // tap is in FRONT of the centre
        float b = softDepthCompare(c.z, s.z);   // tap is BEHIND the centre
        float w = f * cone(dist, sLen)          // blurry foreground bleeding over us
                + b * cone(dist, len)           // we are blurry, so the background shows through
                + cylinder(dist, sLen) * cylinder(dist, len) * 2.0;

        sum += texture2D(tDiffuse, suv).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4(sum / max(wsum, 1e-4), 1.0);
    }
  `,
};
