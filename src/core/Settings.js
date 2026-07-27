/**
 * Quality tiers. Systems read `settings.get(key)` and react to the `quality:change` event.
 * See CONTRACTS.md §4.
 */

const TIERS = {
  low: {
    shadowMapSize: 1024,
    shadowCascades: 2,
    shadowDistance: 180,
    ssao: false,
    ssr: false,
    bloom: true,
    bloomQuality: 3,
    motionBlur: false,
    dof: false,
    chromatic: false,
    grain: true,
    godrays: false,
    lensFlare: false,
    anisotropy: 4,
    pixelRatio: 1,
    msaa: 0,
    taa: false,
    particleBudget: 900,
    trafficCount: 6,
    envMapSize: 128,
    textureSize: 512,
    reflectionProbe: false,
    drawDistance: 900,
    cityDensity: 0.45,
    vegetation: 0.3,
    wetReflections: false,
  },
  medium: {
    shadowMapSize: 2048,
    shadowCascades: 3,
    shadowDistance: 260,
    ssao: true,
    ssr: false,
    bloom: true,
    bloomQuality: 4,
    motionBlur: true,
    dof: false,
    chromatic: true,
    grain: true,
    godrays: false,
    lensFlare: true,
    anisotropy: 8,
    pixelRatio: 1,
    msaa: 0,
    taa: true,
    particleBudget: 2200,
    trafficCount: 12,
    envMapSize: 256,
    textureSize: 1024,
    reflectionProbe: true,
    drawDistance: 1400,
    cityDensity: 0.7,
    vegetation: 0.6,
    wetReflections: true,
  },
  high: {
    shadowMapSize: 2048,
    shadowCascades: 4,
    shadowDistance: 400,
    ssao: true,
    ssr: true,
    bloom: true,
    bloomQuality: 5,
    motionBlur: true,
    dof: true,
    chromatic: true,
    grain: true,
    godrays: true,
    lensFlare: true,
    anisotropy: 16,
    pixelRatio: 1.0,
    msaa: 0,
    taa: true,
    particleBudget: 4500,
    trafficCount: 18,
    envMapSize: 512,
    textureSize: 2048,
    reflectionProbe: true,
    drawDistance: 2200,
    cityDensity: 1.0,
    vegetation: 1.0,
    wetReflections: true,
  },
  ultra: {
    shadowMapSize: 4096,
    shadowCascades: 4,
    shadowDistance: 600,
    ssao: true,
    ssr: true,
    bloom: true,
    bloomQuality: 6,
    motionBlur: true,
    dof: true,
    chromatic: true,
    grain: true,
    godrays: true,
    lensFlare: true,
    anisotropy: 16,
    pixelRatio: 1.5,
    msaa: 0,
    taa: true,
    particleBudget: 8000,
    trafficCount: 26,
    envMapSize: 1024,
    textureSize: 2048,
    reflectionProbe: true,
    drawDistance: 3200,
    cityDensity: 1.25,
    vegetation: 1.3,
    wetReflections: true,
  },
};

export class Settings {
  constructor(bus, tier = 'high') {
    this.bus = bus;
    this.tier = tier;
    this._overrides = {};
    this.autoAdjust = true;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._sinceAdjust = 0;
  }

  get(key) {
    if (key in this._overrides) return this._overrides[key];
    const t = TIERS[this.tier] || TIERS.high;
    return t[key];
  }

  set(key, v) {
    this._overrides[key] = v;
    this.bus?.emit('quality:change', { tier: this.tier, key });
  }

  setTier(tier) {
    if (!TIERS[tier] || tier === this.tier) return;
    this.tier = tier;
    this._overrides = {};
    this.bus?.emit('quality:change', { tier });
  }

  static get tiers() {
    return Object.keys(TIERS);
  }

  /** Detects a sensible starting tier from the GPU string / screen. */
  static detect(renderer) {
    try {
      const gl = renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const desc = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
      const soft = /swiftshader|llvmpipe|software|angle \(google/i.test(desc);
      if (soft) return 'medium';
      if (/apple m[1-9]|radeon pro|rtx|rx 6|rx 7|arc a/i.test(desc)) return 'high';
    } catch {
      /* ignore */
    }
    return 'high';
  }

  /** Called once per frame by main; drops a tier if we're consistently starved. */
  observeFrame(dt) {
    if (!this.autoAdjust) return;
    this._fpsAccum += dt;
    this._fpsFrames++;
    this._sinceAdjust += dt;
    if (this._fpsAccum < 2.5) return;
    const fps = this._fpsFrames / this._fpsAccum;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    if (this._sinceAdjust < 6) return;
    const order = ['low', 'medium', 'high', 'ultra'];
    const i = order.indexOf(this.tier);
    if (fps < 34 && i > 0) {
      this._sinceAdjust = 0;
      this.setTier(order[i - 1]);
      console.info(`[settings] ${fps.toFixed(0)}fps → dropping to ${order[i - 1]}`);
    }
  }
}
