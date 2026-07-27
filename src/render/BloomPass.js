import * as THREE from 'three';
import { FsPass, makeHdrTarget } from './Fullscreen.js';
import { LUMA_GLSL } from './ShaderLib.js';

/**
 * Energy-conserving multi-mip bloom — the "Next Generation Post Processing in Call of Duty:
 * Advanced Warfare" (Jimenez, SIGGRAPH 2014) chain.
 *
 * WHY NOT UnrealBloomPass: it thresholds at a fixed *tone-mapped-looking* level (0.86), blurs five
 * fixed-size Gaussians and adds them with hand-tuned tint vectors. Feed it a genuine HDR frame —
 * a sun disc at several thousand nits, headlights at 60 — and the threshold catches the entire
 * sky, the wide Gaussian smears it over a third of the screen, and the per-mip tints turn the
 * result into a rainbow. That single behaviour is why the env lane had to soft-knee the whole sky
 * to an asymptote of 0.85.
 *
 * What this does instead:
 *   - Soft-knee threshold in LINEAR HDR at ~1.25, i.e. genuinely "brighter than white". A correctly
 *     exposed sky (0.2–0.8 linear) contributes nothing; neon at 3–20 and headlights at 30+ bloom.
 *   - Karis average on the first downsample so a single 5000-nit texel cannot dominate a whole mip
 *     (this is the actual fix for firefly/rainbow speckle).
 *   - 13-tap downsample / 9-tap tent upsample. The progressive up-chain is what gives the tight
 *     physical falloff: energy decays per octave instead of being 5 discrete halos.
 *   - The result is a pure *additive* highlight term. Composite happens in GradePass.
 */
export class BloomPass {
  constructor(renderer) {
    this.renderer = renderer;
    this.levels = 5;
    this.maxLevels = 6;
    // Soft-knee threshold in LINEAR HDR. Bloom starts contributing at (threshold - knee) = 0.85
    // and is fully applied above ~1.85. A correctly exposed sky sits at 0.2-0.8 linear and
    // therefore contributes NOTHING; neon at 3-20 and headlights at 30+ bloom properly; a sun
    // disc at several hundred produces a tight aureole because the Karis average below caps how
    // much a single blazing texel can push a whole mip.
    this.threshold = 1.35;
    this.knee = 0.5;
    this.radius = 0.62; // up-chain blend: lower = tighter falloff
    this.clampMax = 24.0; // firefly ceiling in linear HDR
    this.mips = [];
    this.width = 2;
    this.height = 2;

    this.prefilter = new FsPass(PREFILTER_SHADER);
    this.down = new FsPass(DOWN_SHADER);
    this.up = new FsPass(UP_SHADER);
    this.up.material.blending = THREE.NoBlending;
  }

  setSize(w, h) {
    this.width = w;
    this.height = h;
    this._alloc();
  }

  setLevels(n) {
    const lv = Math.max(2, Math.min(this.maxLevels, n | 0));
    if (lv === this.levels) return;
    this.levels = lv;
    this._alloc();
  }

  _alloc() {
    for (const m of this.mips) m.dispose();
    this.mips = [];
    let w = Math.max(2, this.width >> 1);
    let h = Math.max(2, this.height >> 1);
    for (let i = 0; i < this.levels; i++) {
      const rt = makeHdrTarget(w, h);
      rt.texture.name = `bloom-mip${i}`;
      rt.texture.wrapS = THREE.ClampToEdgeWrapping;
      rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      this.mips.push(rt);
      w = Math.max(2, w >> 1);
      h = Math.max(2, h >> 1);
      if (w <= 2 || h <= 2) {
        // Stop early rather than grinding on 1x1 targets.
        this.levels = i + 1;
        break;
      }
    }
  }

  /** @returns {THREE.Texture} the additive bloom texture (mip 0 of the up-chain). */
  render(srcTexture) {
    const r = this.renderer;
    const mips = this.mips;
    if (!mips.length) return null;

    // ---- prefilter into mip 0 (half res) ------------------------------------------------
    const p = this.prefilter.u;
    p.tSrc.value = srcTexture;
    p.uTexel.value.set(1 / this.width, 1 / this.height);
    p.uFilter.value.set(
      this.threshold,
      this.threshold - this.knee,
      this.knee * 2.0,
      0.25 / Math.max(this.knee, 1e-4)
    );
    p.uClamp.value = this.clampMax;
    this.prefilter.render(r, mips[0]);

    // ---- downsample chain ----------------------------------------------------------------
    for (let i = 1; i < mips.length; i++) {
      const d = this.down.u;
      d.tSrc.value = mips[i - 1].texture;
      d.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      this.down.render(r, mips[i]);
    }

    // ---- upsample chain (additive tent, in-place on the coarser sibling) -------------------
    for (let i = mips.length - 1; i > 0; i--) {
      const u = this.up.u;
      u.tSrc.value = mips[i].texture;
      u.tDest.value = mips[i - 1].texture;
      u.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      u.uBlend.value = this.radius;
      // Ping into the destination mip: we read mips[i-1] and write mips[i-1], which is illegal.
      // Instead write into the *scratch* half of the pair — allocate lazily.
      const dst = this._scratchFor(i - 1);
      this.up.render(r, dst);
      // Swap so the next iteration reads the freshly blended level.
      const tmp = this.mips[i - 1];
      this.mips[i - 1] = dst;
      this._scratch[i - 1] = tmp;
    }
    return this.mips[0].texture;
  }

  _scratchFor(i) {
    if (!this._scratch) this._scratch = [];
    if (!this._scratch[i]) {
      const src = this.mips[i];
      const rt = makeHdrTarget(src.width, src.height);
      rt.texture.name = `bloom-scratch${i}`;
      this._scratch[i] = rt;
    } else if (
      this._scratch[i].width !== this.mips[i].width ||
      this._scratch[i].height !== this.mips[i].height
    ) {
      this._scratch[i].setSize(this.mips[i].width, this.mips[i].height);
    }
    return this._scratch[i];
  }

  dispose() {
    for (const m of this.mips) m.dispose();
    for (const m of this._scratch || []) m?.dispose();
    this.mips = [];
    this._scratch = [];
    this.prefilter.dispose();
    this.down.dispose();
    this.up.dispose();
  }
}

// ---------------------------------------------------------------------------------------------

const PREFILTER_SHADER = {
  name: 'bloom-prefilter',
  uniforms: {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uFilter: { value: new THREE.Vector4(1.25, 0.6, 1.3, 0.38) },
    uClamp: { value: 24.0 },
  },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    uniform vec4 uFilter;   // threshold, threshold-knee, 2*knee, 0.25/knee
    uniform float uClamp;
    ${LUMA_GLSL}

    vec3 fetch(vec2 uv) {
      vec3 c = texture2D(tSrc, uv).rgb;
      c = max(c, vec3(0.0));
      // Ceiling before anything else: one NaN-adjacent specular texel must not become a mip.
      float m = max(c.r, max(c.g, c.b));
      if (m > uClamp) c *= uClamp / m;
      return c;
    }

    // Karis: weight each tap by 1/(1+luma) so a single blazing texel cannot own the average.
    float karis(vec3 c) { return 1.0 / (1.0 + luma(c)); }

    vec3 prefilter(vec3 c) {
      float br = max(c.r, max(c.g, c.b));
      float soft = br - uFilter.y;
      soft = clamp(soft, 0.0, uFilter.z);
      soft = soft * soft * uFilter.w;
      float contrib = max(soft, br - uFilter.x) / max(br, 1e-5);
      return c * contrib;
    }

    void main() {
      // 2x2 box of 2x2 boxes (the COD "13 tap" first stage collapses to this at half res),
      // Karis-averaged per group.
      vec2 o = uTexel;
      vec3 a = fetch(vUv + o * vec2(-1.0, -1.0));
      vec3 b = fetch(vUv + o * vec2( 1.0, -1.0));
      vec3 c = fetch(vUv + o * vec2(-1.0,  1.0));
      vec3 d = fetch(vUv + o * vec2( 1.0,  1.0));
      vec3 e = fetch(vUv);

      float wa = karis(a), wb = karis(b), wc = karis(c), wd = karis(d), we = karis(e) * 2.0;
      vec3 col = (a * wa + b * wb + c * wc + d * wd + e * we) / (wa + wb + wc + wd + we);

      gl_FragColor = vec4(prefilter(col), 1.0);
    }
  `,
};

const DOWN_SHADER = {
  name: 'bloom-down',
  uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tSrc;
    uniform vec2 uTexel;

    void main() {
      vec2 t = uTexel;
      vec3 a = texture2D(tSrc, vUv + t * vec2(-2.0,  2.0)).rgb;
      vec3 b = texture2D(tSrc, vUv + t * vec2( 0.0,  2.0)).rgb;
      vec3 c = texture2D(tSrc, vUv + t * vec2( 2.0,  2.0)).rgb;
      vec3 d = texture2D(tSrc, vUv + t * vec2(-2.0,  0.0)).rgb;
      vec3 e = texture2D(tSrc, vUv).rgb;
      vec3 f = texture2D(tSrc, vUv + t * vec2( 2.0,  0.0)).rgb;
      vec3 g = texture2D(tSrc, vUv + t * vec2(-2.0, -2.0)).rgb;
      vec3 h = texture2D(tSrc, vUv + t * vec2( 0.0, -2.0)).rgb;
      vec3 i = texture2D(tSrc, vUv + t * vec2( 2.0, -2.0)).rgb;
      vec3 j = texture2D(tSrc, vUv + t * vec2(-1.0,  1.0)).rgb;
      vec3 k = texture2D(tSrc, vUv + t * vec2( 1.0,  1.0)).rgb;
      vec3 l = texture2D(tSrc, vUv + t * vec2(-1.0, -1.0)).rgb;
      vec3 m = texture2D(tSrc, vUv + t * vec2( 1.0, -1.0)).rgb;

      vec3 col = e * 0.125;
      col += (a + c + g + i) * 0.03125;
      col += (b + d + f + h) * 0.0625;
      col += (j + k + l + m) * 0.125;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

const UP_SHADER = {
  name: 'bloom-up',
  uniforms: {
    tSrc: { value: null }, // coarser mip
    tDest: { value: null }, // finer mip we are blending into
    uTexel: { value: new THREE.Vector2() },
    uBlend: { value: 0.62 },
  },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tSrc;
    uniform sampler2D tDest;
    uniform vec2 uTexel;
    uniform float uBlend;

    void main() {
      // 3x3 tent on the coarse mip
      vec2 t = uTexel;
      vec3 s = texture2D(tSrc, vUv + t * vec2(-1.0,  1.0)).rgb * 1.0;
      s += texture2D(tSrc, vUv + t * vec2( 0.0,  1.0)).rgb * 2.0;
      s += texture2D(tSrc, vUv + t * vec2( 1.0,  1.0)).rgb * 1.0;
      s += texture2D(tSrc, vUv + t * vec2(-1.0,  0.0)).rgb * 2.0;
      s += texture2D(tSrc, vUv).rgb * 4.0;
      s += texture2D(tSrc, vUv + t * vec2( 1.0,  0.0)).rgb * 2.0;
      s += texture2D(tSrc, vUv + t * vec2(-1.0, -1.0)).rgb * 1.0;
      s += texture2D(tSrc, vUv + t * vec2( 0.0, -1.0)).rgb * 2.0;
      s += texture2D(tSrc, vUv + t * vec2( 1.0, -1.0)).rgb * 1.0;
      s *= (1.0 / 16.0);

      vec3 d = texture2D(tDest, vUv).rgb;
      // Energy-conserving lerp, not an add: total bloom energy stays equal to the thresholded
      // input no matter how many octaves we run.
      gl_FragColor = vec4(mix(d, s, uBlend), 1.0);
    }
  `,
};
