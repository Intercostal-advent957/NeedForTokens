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
    maxPixels: 1300000, // ~1.3 MP — below 1080p
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
    maxPixels: 2100000, // ~1080p
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
    maxPixels: 3700000, // ~1440p
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
    maxPixels: 8300000, // ~2160p
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

const ORDER = ['low', 'medium', 'high', 'ultra'];

export class Settings {
  constructor(bus, tier = 'medium') {
    this.bus = bus;
    this.tier = tier;
    this._overrides = {};
    this.autoAdjust = true;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._sinceAdjust = 0;
    this._grace = 2.5;
    /** Highest tier auto-adjust may climb to; lowered permanently whenever we drop out of one. */
    this._ceiling = ORDER.length - 1;
  }

  get(key) {
    if (key in this._overrides) return this._overrides[key];
    const t = TIERS[this.tier] || TIERS.medium;
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

  /**
   * Detects a sensible starting tier from the GPU string.
   *
   * The renderer string is only descriptive on desktop, and on Windows everything arrives
   * wrapped by ANGLE — `ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0,
   * D3D11)`. That means an unrecognised string is the *common* case, not the exotic one, so
   * the fallback has to be the safe tier rather than the flattering one: a machine that can
   * handle more climbs back up within a few seconds via observeFrame(), whereas one that
   * cannot is unplayable until it finishes stepping down.
   */
  static detect(renderer) {
    try {
      const gl = renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const raw = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';

      // Vendors sprinkle "(R)" and "(TM)" through these strings — "Intel(R) Arc(TM) A770" —
      // and those are word characters, so they break any pattern trying to span them. Strip
      // them once here rather than working around them in every pattern below.
      const d = raw.toLowerCase().replace(/\((?:tm|r|c)\)/g, ' ').replace(/\s+/g, ' ');

      // Software rasterisers cannot run this at any tier; give them the cheapest one.
      if (/swiftshader|llvmpipe|softwarerasterizer|basic render|angle \(google/.test(d)) {
        return 'low';
      }

      // Phones and tablets, regardless of what the GPU claims.
      const nav = typeof navigator === 'undefined' ? null : navigator;
      if (
        /adreno|mali|powervr|apple a[0-9]+ gpu/.test(d) ||
        (nav?.maxTouchPoints > 0 && /android|iphone|ipad/i.test(nav.userAgent || ''))
      ) {
        return 'low';
      }

      // Intel's discrete Arc cards carry the same vendor name as its integrated parts, so
      // they have to be claimed before the integrated test below runs.
      if (/\barc [ab]\d/.test(d)) return /\barc [ab][57]\d/.test(d) ? 'high' : 'medium';

      // Integrated desktop parts. Intel UHD/HD/Iris and AMD's Vega/760M-class iGPUs are the
      // most common Windows laptop configuration by a wide margin, and they were previously
      // falling through to 'high'.
      if (/intel|\buhd\b|\bhd graphics\b|iris|vega \d|radeon graphics/.test(d)) return 'low';

      // Known-fast discrete parts.
      if (/apple m[1-9]|radeon pro|rtx|gtx 16|gtx 10[6-8]|rx [6-9]\d{3}/.test(d)) return 'high';

      // Recognisably discrete but unremarkable (GTX 9xx, RX 5xx, MX-series…).
      if (/geforce|radeon|nvidia|quadro/.test(d)) return 'medium';
    } catch {
      /* fall through to the safe default */
    }
    return 'medium';
  }

  /**
   * Called once per frame by main. Steps the tier towards whatever this machine can actually
   * sustain.
   *
   * Dropping is urgent and climbing is not, so they are deliberately asymmetric: a struggling
   * machine falls as far as it needs to in one adjustment, while a fast one creeps up a single
   * tier at a time. Once we have dropped out of a tier we never return to it, which costs a
   * little headroom on a machine that had one bad patch but is the only cheap way to guarantee
   * the tier cannot oscillate — and an oscillating tier looks far worse than a slightly
   * conservative one, because every change rebuilds shadow maps and probes.
   */
  observeFrame(dt) {
    if (!this.autoAdjust) return;

    // Ignore the first couple of seconds: shader compilation and texture upload land here and
    // would read as a permanently slow machine.
    if (this._grace > 0) {
      this._grace -= dt;
      return;
    }

    this._fpsAccum += dt;
    this._fpsFrames++;
    this._sinceAdjust += dt;
    if (this._fpsAccum < 1.2) return;

    const fps = this._fpsFrames / this._fpsAccum;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    if (this._sinceAdjust < 3) return;

    const i = ORDER.indexOf(this.tier);

    if (fps < 50 && i > 0) {
      // How far down we go scales with how bad it is — at 12 fps, stepping down one tier and
      // waiting another three seconds to discover it is still unplayable helps nobody.
      const drop = fps < 20 ? 3 : fps < 30 ? 2 : 1;
      const next = ORDER[Math.max(0, i - drop)];
      this._ceiling = Math.max(0, i - 1);
      this._sinceAdjust = 0;
      this.setTier(next);
      console.info(`[settings] ${fps.toFixed(0)}fps → dropping to ${next}`);
      return;
    }

    if (fps > 58 && i < this._ceiling) {
      this._sinceAdjust = 0;
      this.setTier(ORDER[i + 1]);
      console.info(`[settings] ${fps.toFixed(0)}fps → raising to ${ORDER[i + 1]}`);
    }
  }
}
