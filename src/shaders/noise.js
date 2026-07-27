/**
 * CPU-side procedural noise library — the foundation of every texture in the game.
 * Owned by the MATERIALS lane (CONTRACTS.md §16).
 *
 * Design notes
 * ------------
 * - Everything here is **tileable**. Textures are repeated hundreds of times down a road, so a
 *   single visible seam is fatal. All generators take a `period` in *cell units* and wrap their
 *   lattice/cell indices modulo that period, which makes the result exactly periodic.
 * - Coordinates are in cell units, not pixels. A generator asking for 8 cells across a 1024px
 *   tile calls `perlin(u*8, v*8, 8)`.
 * - No allocation in the hot path. Worley returns into a caller-supplied 3-tuple.
 * - Deterministic: hashes are pure integer math seeded by an int, so a given seed always makes
 *   the same texture. Boot is reproducible, screenshots are diffable.
 */

// ---------------------------------------------------------------------------- integer hashing

/** 2D integer hash -> uint32. Wang/PCG-flavoured; good avalanche, no visible lattice artefacts. */
export function hash2i(x, y, seed = 0) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** 2D hash -> float in [0,1). */
export function hash2f(x, y, seed = 0) {
  return hash2i(x, y, seed) / 4294967296;
}

/** 3D integer hash -> uint32. */
export function hash3i(x, y, z, seed = 0) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x1b873593) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function hash3f(x, y, z, seed = 0) {
  return hash3i(x, y, z, seed) / 4294967296;
}

// ---------------------------------------------------------------------------- helpers

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
/** Positive modulo — JS `%` keeps the sign of the dividend, which breaks lattice wrapping. */
const pmod = (n, m) => ((n % m) + m) % m;

// 16 evenly-spread unit gradients. More directions than the classic 8 = fewer axis-aligned streaks.
const GRAD_X = new Float32Array(16);
const GRAD_Y = new Float32Array(16);
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2;
  GRAD_X[i] = Math.cos(a);
  GRAD_Y[i] = Math.sin(a);
}

// ---------------------------------------------------------------------------- gradient (Perlin) noise

/**
 * Periodic 2D gradient noise. Returns roughly [-1, 1].
 * `px`,`py` are the wrap periods in cell units (integers). Pass 0 for non-tiling.
 */
export function perlin(x, y, px = 0, py = px, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const w = (ix, iy) => {
    const cx = px ? pmod(ix, px) : ix;
    const cy = py ? pmod(iy, py) : iy;
    return hash2i(cx, cy, seed) & 15;
  };

  const g00 = w(xi, yi);
  const g10 = w(xi + 1, yi);
  const g01 = w(xi, yi + 1);
  const g11 = w(xi + 1, yi + 1);

  const d00 = GRAD_X[g00] * xf + GRAD_Y[g00] * yf;
  const d10 = GRAD_X[g10] * (xf - 1) + GRAD_Y[g10] * yf;
  const d01 = GRAD_X[g01] * xf + GRAD_Y[g01] * (yf - 1);
  const d11 = GRAD_X[g11] * (xf - 1) + GRAD_Y[g11] * (yf - 1);

  const u = fade(xf);
  const v = fade(yf);
  return lerp(lerp(d00, d10, u), lerp(d01, d11, u), v) * 1.4142;
}

/** Periodic gradient noise remapped to [0,1]. */
export const perlin01 = (x, y, px, py, seed) => perlin(x, y, px, py, seed) * 0.5 + 0.5;

/**
 * Simplex-flavoured noise built on a skewed triangular lattice — no axis-aligned bias, which is
 * what makes stone/aggregate look organic rather than woven. Periodic in the *unskewed* lattice,
 * so pass a period that is a multiple of 3 for a clean wrap (we use powers of 2 × 3 in practice;
 * in the rare case it doesn't divide evenly the seam lands inside high-frequency detail).
 */
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
export function simplex(x, y, px = 0, py = px, seed = 0) {
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);

  let i1, j1;
  if (x0 > y0) {
    i1 = 1;
    j1 = 0;
  } else {
    i1 = 0;
    j1 = 1;
  }
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;

  const g = (ix, iy) => {
    const cx = px ? pmod(ix, px) : ix;
    const cy = py ? pmod(iy, py) : iy;
    return hash2i(cx, cy, seed) & 15;
  };

  let n = 0;
  let tt = 0.5 - x0 * x0 - y0 * y0;
  if (tt > 0) {
    const gi = g(i, j);
    tt *= tt;
    n += tt * tt * (GRAD_X[gi] * x0 + GRAD_Y[gi] * y0);
  }
  tt = 0.5 - x1 * x1 - y1 * y1;
  if (tt > 0) {
    const gi = g(i + i1, j + j1);
    tt *= tt;
    n += tt * tt * (GRAD_X[gi] * x1 + GRAD_Y[gi] * y1);
  }
  tt = 0.5 - x2 * x2 - y2 * y2;
  if (tt > 0) {
    const gi = g(i + 1, j + 1);
    tt *= tt;
    n += tt * tt * (GRAD_X[gi] * x2 + GRAD_Y[gi] * y2);
  }
  return 70 * n;
}

export const simplex01 = (x, y, px, py, seed) => simplex(x, y, px, py, seed) * 0.5 + 0.5;

// ---------------------------------------------------------------------------- fractal stacks

/**
 * Fractal Brownian motion. Returns [-1,1]-ish (normalised by total amplitude).
 * `period` is the base period in cells and doubles with each octave so the stack stays tileable.
 */
export function fbm(x, y, { octaves = 5, lacunarity = 2, gain = 0.5, period = 0, seed = 0, warp = 0 } = {}) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  let wx = x;
  let wy = y;
  if (warp > 0) {
    const qx = perlin(x + 5.2, y + 1.3, period, period, seed + 991);
    const qy = perlin(x + 9.7, y + 4.1, period, period, seed + 313);
    wx = x + warp * qx;
    wy = y + warp * qy;
  }
  for (let o = 0; o < octaves; o++) {
    const p = period ? Math.round(period * freq) : 0;
    sum += amp * perlin(wx * freq, wy * freq, p, p, seed + o * 131);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export const fbm01 = (x, y, o) => fbm(x, y, o) * 0.5 + 0.5;

/** Simplex-based fbm — rounder, less grid-locked. Best for stone / cloud / rust shapes. */
export function fbmS(x, y, { octaves = 5, lacunarity = 2, gain = 0.5, period = 0, seed = 0 } = {}) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const p = period ? Math.round(period * freq) : 0;
    sum += amp * simplex(x * freq, y * freq, p, p, seed + o * 271);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal — sharp crests. Cracks, mountain scars, tar seams, cloth weave. */
export function ridged(x, y, { octaves = 5, lacunarity = 2, gain = 0.5, period = 0, seed = 0, sharpness = 1 } = {}) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const p = period ? Math.round(period * freq) : 0;
    let n = 1 - Math.abs(perlin(x * freq, y * freq, p, p, seed + o * 577));
    n *= n;
    if (sharpness !== 1) n = Math.pow(n, sharpness);
    sum += amp * n;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Billowy turbulence — |noise|. Puffy, good for smoke and grime blooms. */
export function turbulence(x, y, { octaves = 5, lacunarity = 2, gain = 0.5, period = 0, seed = 0 } = {}) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const p = period ? Math.round(period * freq) : 0;
    sum += amp * Math.abs(perlin(x * freq, y * freq, p, p, seed + o * 733));
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Domain-warped fbm. The single highest-value trick in procedural texturing: it turns
 * "obviously noise" into "geologically plausible". Two levels of warp by default.
 */
export function warpedFbm(x, y, { octaves = 5, period = 0, seed = 0, warp = 0.6, levels = 2, gain = 0.5 } = {}) {
  let px = x;
  let py = y;
  for (let l = 0; l < levels; l++) {
    const s = seed + l * 4099;
    const qx = fbm(px + 1.7, py + 9.2, { octaves: 3, period, seed: s + 11, gain });
    const qy = fbm(px + 8.3, py + 2.8, { octaves: 3, period, seed: s + 47, gain });
    px += warp * qx;
    py += warp * qy;
  }
  return fbm(px, py, { octaves, period, seed: seed + 7, gain });
}

// ---------------------------------------------------------------------------- worley / voronoi

const _wout = [0, 0, 0];

/**
 * Periodic Worley. Writes [F1, F2, cellHash01] into `out` and returns it.
 * `jitter` 0..1 controls how far feature points stray from cell centres (1 = classic Worley).
 * `metric`: 0 euclidean, 1 manhattan, 2 chebyshev (chebyshev gives brick/tile-like cells).
 */
export function worley(x, y, period = 0, seed = 0, { jitter = 1, metric = 0, out = _wout } = {}) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 1e9;
  let f2 = 1e9;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const wx = period ? pmod(cx, period) : cx;
      const wy = period ? pmod(cy, period) : cy;
      const h = hash2i(wx, wy, seed);
      const ox = ((h & 0xffff) / 65535 - 0.5) * jitter + 0.5;
      const oy = (((h >>> 16) & 0xffff) / 65535 - 0.5) * jitter + 0.5;
      const ax = cx + ox - x;
      const ay = cy + oy - y;
      let d;
      if (metric === 1) d = Math.abs(ax) + Math.abs(ay);
      else if (metric === 2) d = Math.max(Math.abs(ax), Math.abs(ay));
      else d = Math.sqrt(ax * ax + ay * ay);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = h;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  out[0] = f1;
  out[1] = f2;
  out[2] = (id >>> 8) / 16777216;
  return out;
}

/** F2 - F1: bright ridges exactly on the cell borders. Cracked mud, paving joints, dry lakebed. */
export function worleyEdge(x, y, period = 0, seed = 0, opts) {
  const w = worley(x, y, period, seed, opts);
  return w[1] - w[0];
}

/** Multi-octave worley. Stone aggregate at several sizes in one call. */
export function worleyFbm(x, y, { octaves = 3, period = 0, seed = 0, gain = 0.5, jitter = 1, metric = 0 } = {}) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const p = period ? Math.round(period * freq) : 0;
    sum += amp * worley(x * freq, y * freq, p, seed + o * 887, { jitter, metric })[0];
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------- utility curves

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a || 1e-9));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a || 1e-9));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const mix = lerp;
export { lerp, pmod, fade };

/** Contrast around a pivot. `k` > 1 hardens, < 1 softens. */
export const contrast = (v, k, pivot = 0.5) => clamp01((v - pivot) * k + pivot);

/** Signed distance to a rounded box, in the same units as p. Used for tiles/bricks/panels. */
export function sdRoundBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * A cheap blue-noise-ish stratified point set on the unit square, tileable by construction.
 * Returns Float32Array of [x,y,rot,scale,...] tuples. Used to scatter stones/decals without
 * the clumping you get from pure rand().
 */
export function jitteredGrid(cells, seed = 0, jitter = 0.85) {
  const out = new Float32Array(cells * cells * 4);
  let k = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const h = hash2i(i, j, seed);
      const h2 = hash2i(i, j, seed + 7717);
      out[k++] = (i + 0.5 + ((h & 0xffff) / 65535 - 0.5) * jitter) / cells;
      out[k++] = (j + 0.5 + (((h >>> 16) & 0xffff) / 65535 - 0.5) * jitter) / cells;
      out[k++] = ((h2 & 0xffff) / 65535) * Math.PI * 2;
      out[k++] = (h2 >>> 16) / 65535;
    }
  }
  return out;
}
