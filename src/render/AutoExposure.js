import * as THREE from 'three';
import { FsPass, makeHdrTarget } from './Fullscreen.js';
import { LUMA_GLSL } from './ShaderLib.js';

/**
 * Eye adaptation. Entirely GPU-side — no readPixels, so no pipeline stall.
 *
 * chain:  scene HDR --(log-luma, centre weighted)--> 64x64 --(8x8 box)--> 8x8 --(8x8 box + temporal
 *         adaptation against the previous frame's value)--> 1x1
 *
 * The 1x1 target holds the *scene-referred* geometric-mean luminance. GradePass turns that into an
 * exposure multiplier on top of whatever `renderer.toneMappingExposure` the env lane authored, so
 * this is a compensation term, not a replacement: golden hour keeps the env lane's look, and the
 * tunnel — which is 3-4 stops brighter than the night street it opens off — stops blowing out.
 *
 * Geometric mean (average of log) rather than arithmetic mean: a 5000-nit sun disc occupying 0.2%
 * of the frame moves an arithmetic mean by a full stop and a log mean by almost nothing, which is
 * exactly the behaviour a photographer expects.
 */
export class AutoExposure {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;
    this.failed = false;

    // Adaptation time constants (seconds to reach 1-1/e of the target).
    this.tauUp = 0.55; // scene got brighter -> stop down quickly (protects highlights)
    this.tauDown = 1.15; // scene got darker -> open up slowly

    this.lumRT = makeHdrTarget(64, 64, { filter: THREE.LinearFilter });
    this.midRT = makeHdrTarget(8, 8, { filter: THREE.NearestFilter });
    this.a = makeHdrTarget(1, 1, { filter: THREE.NearestFilter });
    this.b = makeHdrTarget(1, 1, { filter: THREE.NearestFilter });
    this.lumRT.texture.name = 'exposure-luma';

    this.lumPass = new FsPass(LUMA_SHADER);
    this.reducePass = new FsPass(REDUCE_SHADER);
    this.adaptPass = new FsPass(ADAPT_SHADER);
    this._snap = 3;
  }

  get texture() {
    return this.a.texture;
  }

  reset() {
    this._snap = 2;
  }

  render(srcTexture, dt) {
    if (!this.enabled || this.failed) return this.a.texture;
    const r = this.renderer;
    try {
      const l = this.lumPass.u;
      l.tSrc.value = srcTexture;
      this.lumPass.render(r, this.lumRT);

      const m = this.reducePass.u;
      m.tSrc.value = this.lumRT.texture;
      m.uTexel.value.set(1 / 64, 1 / 64);
      this.reducePass.render(r, this.midRT);

      const a = this.adaptPass.u;
      a.tSrc.value = this.midRT.texture;
      a.tPrev.value = this.a.texture;
      a.uTexel.value.set(1 / 8, 1 / 8);
      a.uRate.value.set(
        1 - Math.exp(-Math.max(dt, 1e-4) / this.tauUp),
        1 - Math.exp(-Math.max(dt, 1e-4) / this.tauDown)
      );
      a.uSnap.value = this._snap > 0 ? 1 : 0;
      this.adaptPass.render(r, this.b);

      const t = this.a;
      this.a = this.b;
      this.b = t;
      if (this._snap > 0) this._snap--;
    } catch (e) {
      console.warn('[postfx] auto-exposure disabled:', e?.message || e);
      this.failed = true;
    }
    return this.a.texture;
  }

  dispose() {
    this.lumRT.dispose();
    this.midRT.dispose();
    this.a.dispose();
    this.b.dispose();
    this.lumPass.dispose();
    this.reducePass.dispose();
    this.adaptPass.dispose();
  }
}

const LUMA_SHADER = {
  name: 'exposure-luma',
  uniforms: { tSrc: { value: null } },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tSrc;
    ${LUMA_GLSL}
    void main() {
      // Four taps spread across the texel footprint — 16k samples over the frame is a very stable
      // estimator and costs nothing at 64x64.
      vec2 j = vec2(1.0 / 190.0, 1.0 / 190.0);
      float s = 0.0;
      s += log(max(luma(texture2D(tSrc, vUv + vec2( j.x,  j.y)).rgb), 1e-4) + 1e-4);
      s += log(max(luma(texture2D(tSrc, vUv + vec2(-j.x,  j.y)).rgb), 1e-4) + 1e-4);
      s += log(max(luma(texture2D(tSrc, vUv + vec2( j.x, -j.y)).rgb), 1e-4) + 1e-4);
      s += log(max(luma(texture2D(tSrc, vUv + vec2(-j.x, -j.y)).rgb), 1e-4) + 1e-4);
      s *= 0.25;

      // Centre-weighted metering with a hard de-emphasis of the top of the frame: a racing camera
      // always has a big chunk of sky up there and metering for it under-exposes the road.
      vec2 d = vUv - vec2(0.5, 0.42);
      float w = exp(-dot(d, d) * 3.2) * mix(1.0, 0.35, smoothstep(0.62, 0.95, vUv.y));
      gl_FragColor = vec4(s * w, w, 0.0, 1.0);
    }
  `,
};

const REDUCE_SHADER = {
  name: 'exposure-reduce',
  uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    void main() {
      vec2 base = floor(vUv * 8.0) * 8.0;
      vec2 acc = vec2(0.0);
      for (int y = 0; y < 8; y++) {
        for (int x = 0; x < 8; x++) {
          vec2 uv = (base + vec2(float(x), float(y)) + 0.5) * uTexel;
          acc += texture2D(tSrc, uv).rg;
        }
      }
      gl_FragColor = vec4(acc / 64.0, 0.0, 1.0);
    }
  `,
};

const ADAPT_SHADER = {
  name: 'exposure-adapt',
  uniforms: {
    tSrc: { value: null },
    tPrev: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uRate: { value: new THREE.Vector2(0.5, 0.2) },
    uSnap: { value: 1 },
  },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tSrc;
    uniform sampler2D tPrev;
    uniform vec2 uTexel;
    uniform vec2 uRate;   // x = brightening rate, y = darkening rate
    uniform float uSnap;
    void main() {
      vec2 acc = vec2(0.0);
      for (int y = 0; y < 8; y++) {
        for (int x = 0; x < 8; x++) {
          acc += texture2D(tSrc, (vec2(float(x), float(y)) + 0.5) * uTexel).rg;
        }
      }
      float avgLog = acc.x / max(acc.y, 1e-4);
      float target = clamp(exp(avgLog), 0.0004, 60.0);

      float prev = texture2D(tPrev, vec2(0.5)).r;
      if (!(prev > 0.0)) prev = target;

      // A cut (preset change, teleport into a tunnel) is not an eye adaptation — snap instead of
      // crawling through two seconds of wrong exposure.
      float ratio = target / max(prev, 1e-4);
      float k = (target > prev) ? uRate.x : uRate.y;
      float v = mix(prev + (target - prev) * k, target, step(0.5, uSnap));
      if (ratio > 7.0 || ratio < 0.14) v = target;

      gl_FragColor = vec4(v, target, 0.0, 1.0);
    }
  `,
};
