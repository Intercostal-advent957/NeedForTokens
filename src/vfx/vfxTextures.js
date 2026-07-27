import * as THREE from 'three';

/**
 * Procedural sprite sheets for the VFX lane.
 *
 * Everything here is generated ONCE at init and cached on the module. These are small
 * (64–256px) data textures, not the big PBR maps that live in ProceduralAssets — we keep them
 * local so the VFX lane can iterate on sprite shape without touching src/core/Assets.js.
 * No image files, no fetches. See CONTRACTS.md §0.
 */

const cache = new Map();

function hash2(x, y, s) {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263 + (s | 0) * 2147483647;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967296;
}

function vnoise(x, y, s) {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j, s);
  const b = hash2(i + 1, j, s);
  const c = hash2(i, j + 1, s);
  const d = hash2(i + 1, j + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Tiling fbm so sprite edges never show a seam when we scroll detail UVs. */
function fbmTiling(x, y, period, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    // Tiling trick: sample on a torus by wrapping integer lattice coords at `p`.
    const xi = ((x * p) % p + p) % p;
    const yi = ((y * p) % p + p) % p;
    sum += amp * vnoiseWrapped(xi, yi, p, seed + o * 37);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

function vnoiseWrapped(x, y, p, s) {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = (n) => ((n % p) + p) % p;
  const i0 = w(i);
  const j0 = w(j);
  const i1 = w(i + 1);
  const j1 = w(j + 1);
  const a = hash2(i0, j0, s);
  const b = hash2(i1, j0, s);
  const c = hash2(i0, j1, s);
  const d = hash2(i1, j1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function makeDataTexture(size, fill, { srgb = false, wrap = THREE.ClampToEdgeWrapping } = {}) {
  const data = new Uint8Array(size * size * 4);
  fill(data, size);
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * Smoke puff atlas — one texture, four useful channels:
 *   R = round soft puff mask (the "shape")
 *   G = tiling fbm detail (breaks up the sphere so it doesn't read as an airbrush blob)
 *   B = coarse cloud lobes (used to modulate the fake-normal so lighting gets structure)
 *   A = R eroded by G  → the alpha we actually draw with
 */
export function smokePuff() {
  return get('smokePuff', () =>
    makeDataTexture(192, (d, S) => {
      const inv = 1 / S;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const u = (x + 0.5) * inv;
          const v = (y + 0.5) * inv;
          const dx = u - 0.5;
          const dy = v - 0.5;
          const r = Math.sqrt(dx * dx + dy * dy) * 2; // 0 centre → 1 edge

          // Lumpy silhouette: push the radius around with low-frequency angular noise.
          const ang = Math.atan2(dy, dx);
          const lobe =
            0.5 +
            0.5 *
              (Math.sin(ang * 3 + 1.7) * 0.5 +
                Math.sin(ang * 5 - 0.6) * 0.3 +
                Math.sin(ang * 2 + 2.9) * 0.2);
          const rr = r * (0.82 + lobe * 0.3);

          const shape = Math.max(0, 1 - rr);
          const soft = Math.pow(shape, 1.45);

          const detail = fbmTiling(u, v, 4, 4, 11);
          const lobes = fbmTiling(u * 0.5 + 0.13, v * 0.5 + 0.71, 3, 3, 91);

          // Erode the edge with detail so the boundary is wispy, not a clean circle.
          let a = soft * (0.55 + 0.75 * detail);
          a = Math.max(0, Math.min(1, a * 1.35 - 0.06));
          a *= Math.min(1, shape * 4.0); // guarantee a clean fade at the very rim

          const i = (y * S + x) * 4;
          d[i] = Math.round(soft * 255);
          d[i + 1] = Math.round(detail * 255);
          d[i + 2] = Math.round(lobes * 255);
          d[i + 3] = Math.round(a * 255);
        }
      }
    }, { wrap: THREE.RepeatWrapping })
  );
}

/** Stretched spark / flame body: bright core, long soft falloff toward +U (the tail). */
export function sparkStreak() {
  return get('sparkStreak', () =>
    makeDataTexture(128, (d, S) => {
      const inv = 1 / S;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const u = (x + 0.5) * inv;
          const v = (y + 0.5) * inv;
          const across = Math.abs(v - 0.5) * 2;
          // Head at u=1, tail at u=0.
          const along = u;
          const thick = Math.pow(along, 0.65) * 0.9 + 0.1;
          const cross = Math.max(0, 1 - across / thick);
          const body = Math.pow(cross, 2.2) * Math.pow(along, 1.2);
          const head = Math.pow(Math.max(0, 1 - Math.hypot((u - 0.94) * 3.4, (v - 0.5) * 2.2)), 2.4);
          const a = Math.min(1, body * 0.85 + head * 1.25);
          const i = (y * S + x) * 4;
          d[i] = 255;
          d[i + 1] = Math.round(Math.min(1, head * 1.4 + body * 0.3) * 255); // heat mask
          d[i + 2] = 255;
          d[i + 3] = Math.round(a * 255);
        }
      }
    })
  );
}

/** Rain streak: a thin vertical capsule, softened at both ends. */
export function rainStreak() {
  return get('rainStreak', () =>
    makeDataTexture(64, (d, S) => {
      const inv = 1 / S;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const u = (x + 0.5) * inv;
          const v = (y + 0.5) * inv;
          const across = Math.abs(u - 0.5) * 2;
          const ends = Math.sin(Math.PI * Math.min(1, Math.max(0, v)));
          const core = Math.max(0, 1 - across / 0.85);
          const a = Math.pow(core, 1.6) * Math.pow(ends, 0.55);
          const i = (y * S + x) * 4;
          d[i] = 255;
          d[i + 1] = 255;
          d[i + 2] = 255;
          d[i + 3] = Math.round(Math.min(1, a * 1.15) * 255);
        }
      }
    })
  );
}

/**
 * Tyre-tread skid stamp — tiles along V (the length of the ribbon) so a long mark shows
 * repeating tread blocks, and falls off across U so the edges of the mark feather out.
 *   R = rubber density, G = fine grain, A = combined
 */
export function skidTread() {
  return get('skidTread', () =>
    makeDataTexture(
      128,
      (d, S) => {
        const inv = 1 / S;
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const u = (x + 0.5) * inv;
            const v = (y + 0.5) * inv;
            const across = Math.abs(u - 0.5) * 2;

            // Longitudinal tread grooves (4 ribs) + lateral sipes.
            const ribs = 0.62 + 0.38 * Math.pow(Math.abs(Math.cos(u * Math.PI * 4.0)), 0.35);
            const sipes = 0.78 + 0.22 * Math.pow(Math.abs(Math.sin(v * Math.PI * 7.0 + u * 1.1)), 0.5);
            const grain = fbmTiling(u * 1.0, v * 1.0, 8, 4, 303);

            // Shoulders darker than the centre (weight transfer squishes the outer edge).
            const shoulder = 0.85 + 0.35 * Math.pow(across, 2.0);
            const edge = Math.pow(Math.max(0, 1 - Math.pow(across, 3.5)), 0.9);

            let a = ribs * sipes * shoulder * edge * (0.62 + 0.7 * grain);
            a = Math.max(0, Math.min(1, a * 1.1));

            const i = (y * S + x) * 4;
            d[i] = Math.round(Math.min(1, ribs * sipes) * 255);
            d[i + 1] = Math.round(grain * 255);
            d[i + 2] = Math.round(edge * 255);
            d[i + 3] = Math.round(a * 255);
          }
        }
      },
      { wrap: THREE.RepeatWrapping }
    )
  );
}

/** Soft radial glow used for flashes, jet cores and lens droplet highlights. */
export function glow() {
  return get('glow', () =>
    makeDataTexture(96, (d, S) => {
      const inv = 1 / S;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const dx = (x + 0.5) * inv - 0.5;
          const dy = (y + 0.5) * inv - 0.5;
          const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
          const a = Math.pow(1 - r, 2.6);
          const core = Math.pow(Math.max(0, 1 - r * 3.2), 3.0);
          const i = (y * S + x) * 4;
          d[i] = 255;
          d[i + 1] = 255;
          d[i + 2] = 255;
          d[i + 3] = Math.round(Math.min(1, a + core * 0.9) * 255);
        }
      }
    })
  );
}

/** 3D-ish tiling noise packed into a 2D RGBA slab; used for haze distortion + jet flicker. */
export function noiseTile() {
  return get('noiseTile', () =>
    makeDataTexture(
      128,
      (d, S) => {
        const inv = 1 / S;
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const u = (x + 0.5) * inv;
            const v = (y + 0.5) * inv;
            const i = (y * S + x) * 4;
            d[i] = Math.round(fbmTiling(u, v, 4, 4, 5) * 255);
            d[i + 1] = Math.round(fbmTiling(u + 0.37, v + 0.11, 4, 4, 55) * 255);
            d[i + 2] = Math.round(fbmTiling(u * 2 + 0.7, v * 2 + 0.3, 8, 3, 155) * 255);
            d[i + 3] = 255;
          }
        }
      },
      { wrap: THREE.RepeatWrapping }
    )
  );
}

function get(key, make) {
  let t = cache.get(key);
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

export function disposeVfxTextures() {
  for (const t of cache.values()) t.dispose?.();
  cache.clear();
}

