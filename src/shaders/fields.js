/**
 * Scalar field generation + PBR channel baking.
 * Owned by the MATERIALS lane (CONTRACTS.md §16).
 *
 * The whole texture library is built out of *fields*: Float32Array(size*size) scalar images that
 * are cheap to combine. Working in fields rather than in canvas pixels means a material is written
 * as a short recipe ("aggregate worley, warped by fbm, minus tar seams, times wheel polish")
 * instead of a pile of per-pixel arithmetic, and it means every layer is trivially reusable.
 *
 * Performance shape: a field octave costs ~4 lattice reads + 3 lerps per pixel with all the
 * index/weight tables precomputed per axis, so a 6-octave 1024² fbm lands around 30-45 ms.
 * Everything is exactly tileable — lattice indices wrap, scatter footprints wrap.
 */

import * as THREE from 'three';
import { hash2i, hash2f, clamp01, smoothstep, lerp } from './noise.js';

// ---------------------------------------------------------------------------- axis tables cache

const _axisCache = new Map();
/** Precompute, for one axis, the two lattice indices and the smootherstep weight per texel. */
function axisTable(size, cells) {
  const key = size * 100000 + cells;
  let t = _axisCache.get(key);
  if (t) return t;
  const i0 = new Int32Array(size);
  const i1 = new Int32Array(size);
  const w = new Float32Array(size);
  const scale = cells / size;
  for (let p = 0; p < size; p++) {
    const c = (p + 0.5) * scale - 0.5;
    const c0 = Math.floor(c);
    const f = c - c0;
    i0[p] = ((c0 % cells) + cells) % cells;
    i1[p] = ((c0 + 1) % cells + cells) % cells;
    w[p] = f * f * f * (f * (f * 6 - 15) + 10);
  }
  t = { i0, i1, w };
  _axisCache.set(key, t);
  return t;
}

// ---------------------------------------------------------------------------- fields

/** Allocate a zeroed field. */
export const field = (size) => new Float32Array(size * size);

/**
 * One octave of tileable value noise, added into `dst` with amplitude `amp`.
 * `cells` is the lattice resolution (and therefore the tiling period).
 */
export function addValueOctave(dst, size, cells, amp, seed) {
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = hash2f(i % cells, (i / cells) | 0, seed) * 2 - 1;
  const ax = axisTable(size, cells);
  const { i0, i1, w } = ax;
  for (let y = 0; y < size; y++) {
    const r0 = i0[y] * cells;
    const r1 = i1[y] * cells;
    const wy = w[y];
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const a = i0[x];
      const b = i1[x];
      const wx = w[x];
      const t = lat[r0 + a] + (lat[r0 + b] - lat[r0 + a]) * wx;
      const u = lat[r1 + a] + (lat[r1 + b] - lat[r1 + a]) * wx;
      dst[row + x] += (t + (u - t) * wy) * amp;
    }
  }
}

/**
 * Multi-octave tileable noise field. Returns values roughly in [-1,1].
 *   cells    lattice size of the first octave (== tiling period in cells)
 *   octaves  how many doublings
 *   gain     amplitude falloff (0.5 = classic pink noise)
 *   ridge    fold to |n| and invert -> sharp crests (cracks, seams, weave)
 *   billow   fold to |n| -> puffy lobes (smoke, grime blooms)
 */
export function fbmField(size, { cells = 4, octaves = 6, gain = 0.5, lac = 2, seed = 1, ridge = false, billow = false } = {}) {
  const out = field(size);
  let amp = 1;
  let norm = 0;
  let c = cells;
  const tmp = ridge || billow ? field(size) : null;
  for (let o = 0; o < octaves; o++) {
    const cc = Math.max(2, Math.round(c));
    if (cc > size) break;
    if (tmp) {
      tmp.fill(0);
      addValueOctave(tmp, size, cc, 1, seed + o * 7919);
      if (ridge) for (let i = 0; i < out.length; i++) out[i] += amp * (1 - Math.abs(tmp[i])) * (1 - Math.abs(tmp[i]));
      else for (let i = 0; i < out.length; i++) out[i] += amp * Math.abs(tmp[i]);
    } else {
      addValueOctave(out, size, cc, amp, seed + o * 7919);
    }
    norm += amp;
    amp *= gain;
    c *= lac;
  }
  const inv = 1 / Math.max(norm, 1e-6);
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/** Domain-warp `src` by two offset fields. `amount` is in texels. Tileable (indices wrap). */
export function warpField(src, size, wx, wy, amount) {
  const out = field(size);
  const m = size - 1;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const i = row + x;
      const sx = x + wx[i] * amount;
      const sy = y + wy[i] * amount;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const ax = x0 & m;
      const bx = (x0 + 1) & m;
      const ay = (y0 & m) * size;
      const by = ((y0 + 1) & m) * size;
      const t = src[ay + ax] + (src[ay + bx] - src[ay + ax]) * fx;
      const u = src[by + ax] + (src[by + bx] - src[by + ax]) * fx;
      out[i] = t + (u - t) * fy;
    }
  }
  return out;
}

/**
 * Tileable Worley. Returns { f1, f2 } fields normalised so a cell radius is ~1.
 * Kept for genuine cell structures (paving joints, cracked mud, crystal). Aggregate uses
 * `scatter` instead — cheaper and gives per-stone control.
 */
export function worleyField(size, cells, seed = 1, { jitter = 1, metric = 0 } = {}) {
  const f1 = field(size);
  const f2 = field(size);
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const h = hash2i(i, j, seed);
      px[j * cells + i] = i + 0.5 + ((h & 0xffff) / 65535 - 0.5) * jitter;
      py[j * cells + i] = j + 0.5 + (((h >>> 16) & 0xffff) / 65535 - 0.5) * jitter;
    }
  }
  const s = cells / size;
  for (let y = 0; y < size; y++) {
    const cy = (y + 0.5) * s;
    const jc = Math.floor(cy);
    for (let x = 0; x < size; x++) {
      const cx = (x + 0.5) * s;
      const ic = Math.floor(cx);
      let d1 = 1e9;
      let d2 = 1e9;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = ((jc + dj) % cells + cells) % cells;
        const oy = jc + dj - jj; // wrap offset so distances stay in continuous space
        for (let di = -1; di <= 1; di++) {
          const ii = ((ic + di) % cells + cells) % cells;
          const ox = ic + di - ii;
          const ax = px[jj * cells + ii] + ox - cx;
          const ay = py[jj * cells + ii] + oy - cy;
          let d;
          if (metric === 1) d = Math.abs(ax) + Math.abs(ay);
          else if (metric === 2) d = Math.max(Math.abs(ax), Math.abs(ay));
          else d = Math.sqrt(ax * ax + ay * ay);
          if (d < d1) {
            d2 = d1;
            d1 = d;
          } else if (d < d2) d2 = d;
        }
      }
      f1[y * size + x] = d1;
      f2[y * size + x] = d2;
    }
  }
  return { f1, f2 };
}

// ---------------------------------------------------------------------------- field ops

export function mapField(f, fn) {
  for (let i = 0; i < f.length; i++) f[i] = fn(f[i], i);
  return f;
}
export function remapField(f, lo, hi) {
  const d = hi - lo;
  for (let i = 0; i < f.length; i++) f[i] = lo + (f[i] * 0.5 + 0.5) * d;
  return f;
}
export function normaliseField(f, lo = 0, hi = 1) {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < f.length; i++) {
    if (f[i] < mn) mn = f[i];
    if (f[i] > mx) mx = f[i];
  }
  const d = mx - mn || 1;
  const s = (hi - lo) / d;
  for (let i = 0; i < f.length; i++) f[i] = lo + (f[i] - mn) * s;
  return f;
}
export function mulField(a, b) {
  for (let i = 0; i < a.length; i++) a[i] *= b[i];
  return a;
}
export function addField(a, b, k = 1) {
  for (let i = 0; i < a.length; i++) a[i] += b[i] * k;
  return a;
}
export function maxField(a, b) {
  for (let i = 0; i < a.length; i++) if (b[i] > a[i]) a[i] = b[i];
  return a;
}
export function cloneField(a) {
  return Float32Array.from(a);
}
/** Separable box blur, `r` texels, wrapping. Two passes ≈ a decent gaussian. */
export function blurField(f, size, r = 2, passes = 2) {
  if (r < 1) return f;
  const tmp = field(size);
  const w = 1 / (r * 2 + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < size; y++) {
      const row = y * size;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += f[row + ((k % size) + size) % size];
      for (let x = 0; x < size; x++) {
        tmp[row + x] = acc * w;
        acc -= f[row + ((x - r) % size + size) % size];
        acc += f[row + ((x + r + 1) % size + size) % size];
      }
    }
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[(((k % size) + size) % size) * size + x];
      for (let y = 0; y < size; y++) {
        f[y * size + x] = acc * w;
        acc -= tmp[((((y - r) % size) + size) % size) * size + x];
        acc += tmp[((((y + r + 1) % size) + size) % size) * size + x];
      }
    }
  }
  return f;
}

// ---------------------------------------------------------------------------- scatter

/**
 * Rasterise a jittered-grid scatter of elliptical blobs into `height` (and optionally a
 * per-blob id field + tint field). This is how aggregate stones, gravel, paint chips and rust
 * flecks are made: O(count × footprint) instead of O(pixels × octaves), and every blob gets its
 * own size / aspect / rotation / albedo, which is what makes it read as *stones* rather than
 * as *noise shaped like stones*.
 *
 * opts: cells, radius[min,max], aspect, sharp (profile exponent), amp, seed,
 *       onBlob(i, h01, cx, cy, r) optional callback for per-blob colour work.
 */
export function scatter(height, size, opts = {}) {
  const {
    cells = 48,
    radius = [3, 9],
    aspect = 0.55,
    sharp = 1.6,
    amp = 1,
    seed = 5,
    jitter = 0.95,
    density = 1,
    tint = null,
    tintRange = [0, 1],
    mode = 'max',
  } = opts;
  const m = size - 1;
  const step = size / cells;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const h = hash2i(i, j, seed);
      const h2 = hash2i(i, j, seed + 4441);
      if (density < 1 && (h2 & 0xff) / 255 > density) continue;
      const cx = (i + 0.5 + ((h & 0x3ff) / 1023 - 0.5) * jitter) * step;
      const cy = (j + 0.5 + (((h >>> 10) & 0x3ff) / 1023 - 0.5) * jitter) * step;
      const t = ((h >>> 20) & 0x3ff) / 1023;
      const r = (radius[0] + (radius[1] - radius[0]) * t * t) * (size / 1024);
      const ar = 1 + (h2 & 0xff) / 255 * aspect;
      const ang = ((h2 >>> 8) & 0x3ff) / 1023 * Math.PI;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const a = amp * (0.55 + ((h2 >>> 18) & 0xff) / 255 * 0.45);
      const tv = tintRange[0] + (tintRange[1] - tintRange[0]) * (((h2 >>> 26) & 0x3f) / 63);
      const rr = Math.ceil(r * ar) + 1;
      const x0 = Math.round(cx);
      const y0 = Math.round(cy);
      for (let dy = -rr; dy <= rr; dy++) {
        const py = (y0 + dy) & m;
        const rowo = py * size;
        for (let dx = -rr; dx <= rr; dx++) {
          const lx = (dx * ca + dy * sa) / (r * ar);
          const ly = (-dx * sa + dy * ca) / r;
          const d2 = lx * lx + ly * ly;
          if (d2 >= 1) continue;
          const v = Math.pow(1 - d2, sharp) * a;
          const idx = rowo + ((x0 + dx) & m);
          if (mode === 'add') height[idx] += v;
          else if (v > height[idx]) height[idx] = v;
          if (tint && v > 0.04) tint[idx] = tv;
        }
      }
    }
  }
  return height;
}

/**
 * Anisotropic streaks along an axis — grime runs, brushed metal, tyre-drag smear.
 * `dir` 0 = horizontal, 1 = vertical.
 */
export function streakField(size, { count = 400, dir = 1, len = [0.05, 0.4], width = [1, 3], seed = 9, amp = 1 } = {}) {
  const out = field(size);
  const m = size - 1;
  for (let s = 0; s < count; s++) {
    const h = hash2i(s, 17, seed);
    const h2 = hash2i(s, 91, seed);
    const cx = ((h & 0xffff) / 65535) * size;
    const cy = (((h >>> 16) & 0xffff) / 65535) * size;
    const L = (len[0] + (len[1] - len[0]) * ((h2 & 0xffff) / 65535)) * size;
    const W = width[0] + (width[1] - width[0]) * (((h2 >>> 16) & 0xff) / 255);
    const a = amp * (0.3 + ((h2 >>> 24) & 0xff) / 255 * 0.7);
    for (let t = 0; t < L; t++) {
      const f = t / L;
      const fall = Math.sin(f * Math.PI);
      for (let w = -W; w <= W; w++) {
        const wf = 1 - Math.abs(w) / (W + 1);
        const x = dir === 1 ? cx + w : cx + t;
        const y = dir === 1 ? cy + t : cy + w;
        const idx = ((y | 0) & m) * size + ((x | 0) & m);
        const v = a * fall * wf * wf;
        if (v > out[idx]) out[idx] = v;
      }
    }
  }
  return out;
}

/** Sub-pixel-ish grit: uncorrelated high-frequency dither. The last 5% of realism. */
export function gritField(size, seed = 3, amp = 1) {
  const out = field(size);
  for (let i = 0; i < out.length; i++) out[i] = (hash2f(i & 8191, (i >> 13) + i, seed) * 2 - 1) * amp;
  return out;
}

// ---------------------------------------------------------------------------- baking

/**
 * Sobel height -> tangent-space normal map (RGB) as a DataTexture.
 * `strength` folds in the physical relationship between height amplitude and texel size, so a
 * material author tunes one number and it stays right at any resolution.
 */
export function bakeNormal(height, size, strength = 1, aniso = 8) {
  const out = new Uint8Array(size * size * 4);
  const m = size - 1;
  const k = strength * (size / 1024) * 3.2;
  for (let y = 0; y < size; y++) {
    const yn = ((y - 1) & m) * size;
    const yp = ((y + 1) & m) * size;
    const yc = y * size;
    for (let x = 0; x < size; x++) {
      const xn = (x - 1) & m;
      const xp = (x + 1) & m;
      // Sobel — less aliased than a central difference on noisy height.
      const dx =
        height[yn + xp] + 2 * height[yc + xp] + height[yp + xp] -
        (height[yn + xn] + 2 * height[yc + xn] + height[yp + xn]);
      const dy =
        height[yp + xn] + 2 * height[yp + x] + height[yp + xp] -
        (height[yn + xn] + 2 * height[yn + x] + height[yn + xp]);
      let nx = -dx * k;
      let ny = -dy * k;
      const l = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (yc + x) * 4;
      out[i] = (nx * l * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * l * 0.5 + 0.5) * 255;
      out[i + 2] = (l * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/** RGB albedo fields -> sRGB DataTexture. */
export function bakeAlbedo(r, g, b, size, aniso = 8, { alpha = null, wrap = THREE.RepeatWrapping } = {}) {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0, j = 0; i < r.length; i++, j += 4) {
    out[j] = clamp01(r[i]) * 255;
    out[j + 1] = clamp01(g[i]) * 255;
    out[j + 2] = clamp01(b[i]) * 255;
    out[j + 3] = alpha ? clamp01(alpha[i]) * 255 : 255;
  }
  const t = new THREE.DataTexture(out, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/**
 * glTF-convention ORM pack: R = ambient occlusion, G = roughness, B = metalness.
 * three.js reads aoMap.r / roughnessMap.g / metalnessMap.b, so one texture feeds all three —
 * a third of the memory and a third of the fetches. Any of the three may be null.
 */
export function bakeORM(ao, rough, metal, size, aniso = 8) {
  const n = size * size;
  const out = new Uint8Array(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[j] = ao ? clamp01(ao[i]) * 255 : 255;
    out[j + 1] = rough ? clamp01(rough[i]) * 255 : 255;
    out[j + 2] = metal ? clamp01(metal[i]) * 255 : 0;
    out[j + 3] = 255;
  }
  const t = new THREE.DataTexture(out, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.channel = 0; // AO reads uv0 like everything else; avoids demanding a uv1 attribute
  t.needsUpdate = true;
  return t;
}

/** Single-channel field -> greyscale data texture (masks, height, caustics). */
export function bakeMask(f, size, { srgb = false, wrap = THREE.RepeatWrapping, aniso = 4, alphaFromValue = false } = {}) {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0, j = 0; i < f.length; i++, j += 4) {
    const v = clamp01(f[i]) * 255;
    out[j] = out[j + 1] = out[j + 2] = v;
    out[j + 3] = alphaFromValue ? v : 255;
  }
  const t = new THREE.DataTexture(out, size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/** Ambient occlusion approximated from a height field: how buried is this texel vs its blurred self. */
export function aoFromHeight(height, size, radius = 6, strength = 1) {
  const blurred = blurField(cloneField(height), size, radius, 2);
  const out = field(size);
  for (let i = 0; i < out.length; i++) {
    out[i] = clamp01(1 - Math.max(0, blurred[i] - height[i]) * 6 * strength);
  }
  return out;
}

export { clamp01, smoothstep, lerp, hash2i, hash2f };
