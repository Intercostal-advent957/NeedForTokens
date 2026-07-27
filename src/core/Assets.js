import * as THREE from 'three';
import { makeRng, clamp01 } from './MathX.js';

import { simplex, perlin, fbm, worley, worleyEdge, hash2f } from '../shaders/noise.js';
import {
  buildAsphalt, buildConcrete, buildCurb, buildGrass, buildDirt, buildManhole,
  buildRoadLineMask, buildPuddleMask, buildCaustics,
} from '../shaders/tex.ground.js';
import { buildBrick, buildFacade, buildWindows, buildGraffiti, buildGlassDirt } from '../shaders/tex.arch.js';
import {
  buildMetalScratch, buildCarPaintFlake, buildTire, buildPaintChip,
  buildCarbon, buildBrushedAlu, buildRubberScuff,
} from '../shaders/tex.vehicle.js';
import {
  buildSmokeSprite, buildSparkSprite, buildFlareSprite, buildRaindrop,
  buildSkidSprite, buildLightCookie,
} from '../shaders/tex.sprites.js';
import {
  makeRoadMaterial, makeWetSurfaceMaterial, makeGlassMaterial,
  makeSignageMaterial, makeFoliageMaterial, makeCarPaintMaterial,
} from '../shaders/materials.js';

/**
 * Central procedural texture + material factory. See CONTRACTS.md §5.
 *
 * ------------------------------------------------------------------------------------------
 * EVERY texture in this game is generated from noise at runtime. No image files, no fetches.
 *
 * How it is organised
 * -------------------
 *  - `src/shaders/noise.js`      deterministic tileable noise (gradient, simplex, fbm, worley)
 *  - `src/shaders/fields.js`     scalar-field builders + PBR channel baking (normal/ORM/albedo)
 *  - `src/shaders/tex.*.js`      the material recipes, grouped by domain
 *  - `src/shaders/materials.js`  material factories with the anti-tiling / wetness shader patches
 *  - `src/shaders/noise.glsl.js` the GLSL side of the same noise, for shader-time detail
 *
 * Channel packing: roughness/AO/metalness live in ONE texture in glTF ORM order
 * (R=AO, G=roughness, B=metalness) because three.js reads exactly those channels for
 * aoMap/roughnessMap/metalnessMap. One upload, one fetch, three channels.
 *
 * Colour spaces: albedo and anything else that is a *colour* is SRGBColorSpace; normal, ORM,
 * height and masks are NoColorSpace. Getting this backwards washes the whole frame out.
 *
 * A note on sizes: a "2K asphalt tile" is only 2K on the tile. The road repeats it ~150 times,
 * so tiling is fought in the shader (world-space macro variation + a rotated second tap), not
 * by throwing resolution at it. See `src/shaders/materials.js`.
 * ------------------------------------------------------------------------------------------
 */

// --------------------------------------------------------------------------- texture registry
// Each entry builds several related maps in one pass and caches them all, because the expensive
// part (the scalar fields) is shared between albedo, normal and ORM.
// `max` is the memory/time governor. A 1024 RGBA tile plus its mip chain is ~7.5 MB, so a
// three-map PBR set at 1024 costs 22 MB — affordable exactly once, for the road.
const BUILDERS = [
  { fn: buildAsphalt, mult: 1.0, min: 512, max: 1024, names: ['asphalt', 'asphaltNormal', 'asphaltRough'] },
  { fn: buildConcrete, mult: 0.5, min: 256, max: 512, names: ['concrete', 'concreteNormal', 'concreteRough'] },
  { fn: buildCurb, mult: 0.5, min: 256, max: 512, names: ['curb', 'curbNormal', 'curbRough'] },
  { fn: buildGrass, mult: 0.5, min: 256, max: 512, names: ['grassAlbedo', 'grassNormal', 'grassRough'] },
  { fn: buildDirt, mult: 0.5, min: 256, max: 512, names: ['dirtAlbedo', 'dirtNormal', 'dirtRough'] },
  { fn: buildManhole, mult: 0.25, min: 256, max: 512, names: ['manhole', 'manholeNormal', 'manholeRough'] },
  { fn: buildRoadLineMask, mult: 0.5, min: 256, max: 512, names: ['roadLineMask'] },
  { fn: buildPuddleMask, mult: 0.25, min: 256, max: 512, names: ['puddleMask'] },
  { fn: buildCaustics, mult: 0.25, min: 256, max: 512, names: ['caustics'] },

  { fn: buildBrick, mult: 0.5, min: 256, max: 512, names: ['brickWall', 'brickWallNormal', 'brickWallRough'] },
  { fn: buildFacade, mult: 0.5, min: 256, max: 512, names: ['buildingFacade', 'buildingFacadeNormal', 'buildingFacadeRough'] },
  { fn: buildWindows, mult: 0.5, min: 256, max: 512, names: ['buildingWindows'] },
  { fn: buildGraffiti, mult: 0.25, min: 256, max: 512, names: ['graffiti'] },
  { fn: buildGlassDirt, mult: 0.25, min: 256, max: 512, names: ['glassDirt', 'glassDirtNormal'] },

  { fn: buildMetalScratch, mult: 0.5, min: 256, max: 512, names: ['metalScratch', 'metalScratchNormal', 'metalScratchRough'] },
  { fn: buildCarPaintFlake, mult: 0.25, min: 256, max: 512, names: ['carPaintFlake', 'carPaintFlakeMask', 'clearcoatPeel'] },
  { fn: buildTire, mult: 0.25, min: 256, max: 512, names: ['tireTread', 'tireNormal', 'tireRough'] },
  { fn: buildPaintChip, mult: 0.25, min: 128, max: 256, names: ['paintChip', 'paintChipNormal'] },
  { fn: buildCarbon, mult: 0.25, min: 256, max: 512, names: ['carbonFibre', 'carbonFibreNormal', 'carbonFibreRough'] },
  { fn: buildBrushedAlu, mult: 0.25, min: 256, max: 512, names: ['brushedAlu', 'brushedAluNormal', 'brushedAluRough'] },
  { fn: buildRubberScuff, mult: 0.25, min: 128, max: 256, names: ['rubberScuff'] },

  { fn: buildSmokeSprite, mult: 0, names: ['smokeSprite'] },
  { fn: buildSparkSprite, mult: 0, names: ['sparkSprite'] },
  { fn: buildFlareSprite, mult: 0, names: ['flareSprite'] },
  { fn: buildRaindrop, mult: 0, names: ['raindrop', 'raindropNormal', 'raindropMask'] },
  { fn: buildSkidSprite, mult: 0, names: ['skidSprite'] },
  { fn: buildLightCookie, mult: 0, names: ['lightCookie', 'lightCookieHead'] },
];

const BUILDER_BY_NAME = new Map();
for (const b of BUILDERS) for (const n of b.names) BUILDER_BY_NAME.set(n, b);

/** Names other systems are contractually guaranteed to be able to ask for. */
export const GUARANTEED_TEXTURES = [
  'asphalt', 'asphaltNormal', 'asphaltRough', 'roadLineMask', 'concrete', 'concreteNormal',
  'curb', 'metalScratch', 'carPaintFlake', 'tireTread', 'tireNormal', 'glassDirt', 'brickWall',
  'buildingFacade', 'buildingWindows', 'grassAlbedo', 'dirtAlbedo', 'smokeSprite', 'sparkSprite',
  'flareSprite', 'raindrop', 'skidSprite', 'lightCookie', 'caustics', 'puddleMask', 'graffiti',
  'manhole', 'paintChip', 'carbonFibre', 'brushedAlu', 'rubberScuff',
];

// Stable cache key that never chokes on THREE objects.
function optsKey(opts) {
  if (!opts) return '';
  const keys = Object.keys(opts).sort();
  let s = '';
  for (const k of keys) {
    const v = opts[k];
    const t = typeof v;
    if (v === null || t === 'number' || t === 'string' || t === 'boolean') s += `${k}:${v};`;
    else if (v?.isColor) s += `${k}:#${v.getHexString()};`;
    else if (v?.isVector2) s += `${k}:${v.x},${v.y};`;
    else if (v?.uuid) s += `${k}:${v.uuid};`;
    else s += `${k}:?;`;
  }
  return s;
}

export class ProceduralAssets {
  constructor(renderer, settings) {
    this.renderer = renderer;
    this.settings = settings;
    this.textures = new Map();
    this.materials = new Map();
    this.rng = makeRng(0xa11ce);
    this.maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 8;
    this.envMap = null;

    /**
     * Shared uniform hooks. Other lanes bind these — `assets.wetness.value = 0.8` re-dresses
     * every road, kerb, pavement and pane of glass in one assignment. See CONTRACTS.md §6:
     * the environment lane owns `env.wetness`, and we mirror it here every frame.
     */
    this.wetness = new THREE.Uniform(0);
    this.rain = new THREE.Uniform(0);
    this.time = new THREE.Uniform(0);

    this.stats = { buildMs: 0, textures: 0, bytes: 0, builds: [] };
    this._clockStop = null;
  }

  async init() {
    const t0 = performance.now();
    // Pre-bake what the first frame will certainly touch. Everything else builds on demand.
    const warm = [
      'asphalt', 'asphaltNormal', 'asphaltRough',
      'concrete', 'concreteNormal', 'curb',
      'smokeSprite', 'sparkSprite', 'flareSprite',
    ];
    for (const n of warm) this.texture(n);
    this._startClock();
    this.stats.buildMs = performance.now() - t0;
    if (typeof console !== 'undefined') {
      console.info(
        `[assets] warm set in ${this.stats.buildMs.toFixed(0)}ms ` +
        `(${this.textures.size} textures, ~${(this.stats.bytes / 1048576).toFixed(1)} MB)`
      );
    }
    return this;
  }

  /**
   * Drives `uTime` and mirrors the environment's wetness onto the shared uniform.
   * Read-only integration: if the env lane never touches us, wetness simply stays where it was.
   */
  _startClock() {
    if (this._clockStop || typeof requestAnimationFrame !== 'function') return;
    let last = performance.now();
    let raf = 0;
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      this.time.value += dt;
      const env = globalThis.__GAME?.ctx?.env;
      if (env) {
        if (Number.isFinite(env.wetness)) this.wetness.value = env.wetness;
        if (Number.isFinite(env.rainIntensity)) this.rain.value = env.rainIntensity;
      }
    };
    raf = requestAnimationFrame(tick);
    this._clockStop = () => cancelAnimationFrame(raf);
  }

  /** Manual override, for anyone who would rather push than be pulled. */
  setWetness(w, rain = null) {
    this.wetness.value = clamp01(w);
    if (rain !== null) this.rain.value = clamp01(rain);
  }

  // ------------------------------------------------------------------ textures

  get anisotropy() {
    return Math.max(1, Math.min(this.maxAniso, this.settings?.get('anisotropy') ?? 8));
  }

  /** Resolved tile size for a builder: tier-scaled, clamped, rounded down to a power of two. */
  _size(entry) {
    if (!entry.mult) return 0; // sprite builders pick their own fixed size
    const base = this.settings?.get('textureSize') ?? 1024;
    const v = Math.round(base * entry.mult);
    let p = 64;
    while (p * 2 <= v && p < 2048) p *= 2;
    return Math.max(entry.min ?? 128, Math.min(entry.max ?? 1024, p));
  }

  texture(name, opts = {}) {
    const key = name + '|' + optsKey(opts);
    const hit = this.textures.get(key);
    if (hit) return hit;

    const entry = BUILDER_BY_NAME.get(name);
    if (!entry) {
      const fb = this._fallback();
      this.textures.set(key, fb);
      return fb;
    }

    const t0 = performance.now();
    let produced;
    try {
      produced = entry.fn({ size: this._size(entry), aniso: this.anisotropy, rng: this.rng, opts });
    } catch (err) {
      console.error(`[assets] generator "${name}" failed:`, err);
      const fb = this._fallback();
      this.textures.set(key, fb);
      return fb;
    }
    const ms = performance.now() - t0;
    this.stats.builds.push({ name: entry.names[0], ms: +ms.toFixed(1) });

    // Cache every map the builder produced, not just the one that was asked for.
    for (const [n, tex] of Object.entries(produced)) {
      if (!tex) continue;
      tex.name = n;
      const k = n + '|';
      if (!this.textures.has(k)) {
        this.textures.set(k, tex);
        this.stats.textures++;
        const w = tex.image?.width ?? 0;
        const h = tex.image?.height ?? 0;
        this.stats.bytes += w * h * 4 * 1.34; // +mip chain
      }
    }
    // Honour a per-call opts variation (repeat/rotation) by cloning the shared texture.
    const base = this.textures.get(name + '|') ?? this._fallback();
    let out = base;
    if (opts && Object.keys(opts).length) {
      out = base.clone();
      out.needsUpdate = true;
      if (opts.repeat) out.repeat.set(opts.repeat[0] ?? opts.repeat, opts.repeat[1] ?? opts.repeat);
      if (opts.offset) out.offset.set(opts.offset[0] ?? 0, opts.offset[1] ?? 0);
      if (opts.rotation !== undefined) out.rotation = opts.rotation;
      if (opts.wrap) out.wrapS = out.wrapT = opts.wrap;
      if (opts.anisotropy !== undefined) out.anisotropy = opts.anisotropy;
    }
    this.textures.set(key, out);
    return out;
  }

  _fallback() {
    let t = this.textures.get('__fallback');
    if (t) return t;
    const d = new Uint8Array([128, 128, 128, 255]);
    t = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    this.textures.set('__fallback', t);
    return t;
  }

  /** Draw into an offscreen canvas and wrap it in a texture. Kept for other lanes' convenience. */
  canvas(w, h, drawFn, { srgb = true, wrap = THREE.RepeatWrapping, aniso = true, mips = true } = {}) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: false });
    drawFn(g, w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = wrap;
    t.generateMipmaps = mips;
    t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    t.anisotropy = aniso ? this.anisotropy : 1;
    t.needsUpdate = true;
    return t;
  }

  /** Height field -> tangent-space normal map. Kept from the old API; now Sobel-filtered. */
  normalFromHeight(data, w, h, strength = 2.0) {
    const out = new Uint8Array(w * h * 4);
    const at = (x, y) => data[((y & (h - 1)) * w + (x & (w - 1))) * 4] / 255;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
        const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
        const l = 1 / Math.sqrt(dx * dx + dy * dy + 1);
        const i = (y * w + x) * 4;
        out[i] = (-dx * l * 0.5 + 0.5) * 255;
        out[i + 1] = (-dy * l * 0.5 + 0.5) * 255;
        out[i + 2] = (l * 0.5 + 0.5) * 255;
        out[i + 3] = 255;
      }
    }
    const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.anisotropy = this.anisotropy;
    t.needsUpdate = true;
    return t;
  }

  // ------------------------------------------------------------------ materials

  /**
   * Named material factories. All of them bind `assets.wetness` / `assets.time`, so the whole
   * world reacts to weather without any lane knowing about any other lane.
   *
   *   road | asphalt      the hero surface: macro anti-tiling, wheel polish, puddles
   *   wet                 any map set + the same wetness response (opts: map/normalMap/ormMap)
   *   glass               automotive & architectural glass with grime
   *   signage | neon      emissive sign with optional flicker
   *   foliage             alpha-tested cards with world-space wind gusts + translucency
   *   carPaint            pigment + aluminium flake + clearcoat with orange peel
   *   concrete curb brick facade metal grass dirt carbon alu tire  — plain PBR sets
   */
  material(name, opts = {}) {
    const key = name + '|' + optsKey(opts);
    const hit = this.materials.get(key);
    if (hit) return hit;
    const m = this._makeMaterial(name, opts);
    m.userData.nftName = name;
    this.materials.set(key, m);
    return m;
  }

  _pbr(albedo, normal, orm, extra = {}) {
    const mat = new THREE.MeshStandardMaterial({
      map: albedo ? this.texture(albedo) : null,
      normalMap: normal ? this.texture(normal) : null,
      roughnessMap: orm ? this.texture(orm) : null,
      aoMap: orm ? this.texture(orm) : null,
      metalnessMap: orm ? this.texture(orm) : null,
      aoMapIntensity: 0.85,
      roughness: 1.0,
      metalness: orm ? 1.0 : 0.0,
      envMapIntensity: 0.9,
      ...extra,
    });
    return mat;
  }

  _makeMaterial(name, opts) {
    switch (name) {
      case 'road':
      case 'asphalt':
        return makeRoadMaterial(this, opts);
      case 'wet':
      case 'wetSurface':
        return makeWetSurfaceMaterial(this, opts);
      case 'glass':
        return makeGlassMaterial(this, opts);
      case 'signage':
      case 'neon':
        return makeSignageMaterial(this, opts);
      case 'foliage':
        return makeFoliageMaterial(this, opts);
      case 'carPaint':
        return makeCarPaintMaterial(this, opts);

      case 'concrete':
        return makeWetSurfaceMaterial(this, {
          map: this.texture('concrete'),
          normalMap: this.texture('concreteNormal'),
          ormMap: this.texture('concreteRough'),
          metalness: 0,
          puddles: false,
          detailAmt: 0.3,
          ...opts,
        });
      case 'curb':
        return this._pbr('curb', 'curbNormal', 'curbRough', { metalness: 0, envMapIntensity: 0.8, ...opts });
      case 'brick':
      case 'brickWall':
        return this._pbr('brickWall', 'brickWallNormal', 'brickWallRough', { metalness: 0, ...opts });
      case 'facade':
      case 'buildingFacade':
        // `buildingWindows` is already a *pre-multiplied* emissive map (unlit panes are black),
        // so this material lights its own windows out of the box. Drive `emissiveIntensity`
        // from time of day — around 0.15 at noon, 1.2+ after dark.
        return this._pbr('buildingFacade', 'buildingFacadeNormal', 'buildingFacadeRough', {
          emissiveMap: this.texture('buildingWindows'),
          emissive: new THREE.Color(0xffffff),
          emissiveIntensity: 0.8,
          envMapIntensity: 1.1,
          ...opts,
        });
      case 'metal':
      case 'metalScratch':
        return this._pbr('metalScratch', 'metalScratchNormal', 'metalScratchRough', { envMapIntensity: 1.3, ...opts });
      case 'grass':
        return this._pbr('grassAlbedo', 'grassNormal', 'grassRough', { metalness: 0, envMapIntensity: 0.7, ...opts });
      case 'dirt':
        return this._pbr('dirtAlbedo', 'dirtNormal', 'dirtRough', { metalness: 0, envMapIntensity: 0.7, ...opts });
      case 'carbon':
      case 'carbonFibre':
        return this._pbr('carbonFibre', 'carbonFibreNormal', 'carbonFibreRough', { envMapIntensity: 1.6, ...opts });
      case 'alu':
      case 'brushedAlu':
        return this._pbr('brushedAlu', 'brushedAluNormal', 'brushedAluRough', { envMapIntensity: 1.8, ...opts });
      case 'tire':
      case 'tyre':
        return this._pbr('tireTread', 'tireNormal', 'tireRough', {
          metalness: 0, roughness: 1, envMapIntensity: 0.5, ...opts,
        });
      default:
        return new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.85, metalness: 0, ...opts });
    }
  }

  // ------------------------------------------------------------------ noise API

  /** Deterministic simplex noise in [-1,1]. Contractual API (§5). */
  noise2D(x, y) {
    return simplex(x, y);
  }
  /** Multi-octave noise in [-1,1]. */
  fbm2D(x, y, opts) {
    return fbm(x, y, opts);
  }
  perlin2D(x, y) {
    return perlin(x, y);
  }
  worley2D(x, y, period, seed) {
    return worley(x, y, period, seed)[0];
  }
  worleyEdge2D(x, y, period, seed) {
    return worleyEdge(x, y, period, seed);
  }
  hash2D(x, y, seed) {
    return hash2f(x, y, seed);
  }

  // ------------------------------------------------------------------ lifecycle

  onQuality() {
    // Regenerating multi-megabyte tiles mid-race would hitch far worse than the quality gain.
    // Anisotropy is free to change, so track that and leave the pixels alone.
    const a = this.anisotropy;
    for (const t of this.textures.values()) {
      if (t && t.anisotropy !== undefined && t.anisotropy > 1) t.anisotropy = a;
    }
  }

  /** Diagnostic dump — `window.__GAME.ctx.assets.report()` in the console. */
  report() {
    const rows = [...this.stats.builds].sort((a, b) => b.ms - a.ms);
    const total = rows.reduce((s, r) => s + r.ms, 0);
    console.table(rows);
    console.info(`[assets] ${this.stats.textures} textures, ${total.toFixed(0)}ms total, ~${(this.stats.bytes / 1048576).toFixed(1)} MB`);
    return { total, rows };
  }

  dispose() {
    this._clockStop?.();
    for (const t of this.textures.values()) t?.dispose?.();
    for (const m of this.materials.values()) m?.dispose?.();
    this.textures.clear();
    this.materials.clear();
  }
}
