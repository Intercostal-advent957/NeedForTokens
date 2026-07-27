/**
 * Sprite / decal / mask generators: smoke, sparks, flare, raindrop, skid, light cookie.
 * Owned by the MATERIALS lane.
 *
 * Sprites are small and cheap, but they are also the things the eye tracks at 250 km/h, so they
 * get real internal structure rather than a radial gradient. A smoke puff with no interior
 * turbulence reads as a grey circle the instant two of them overlap.
 */

import * as THREE from 'three';
import {
  field, fbmField, streakField, gritField, blurField, worleyField,
  normaliseField, cloneField, bakeNormal, bakeMask,
  clamp01, smoothstep, lerp,
} from './fields.js';

function rgbaTexture(data, D, { srgb = true, wrap = THREE.ClampToEdgeWrapping, aniso = 4, mips = true } = {}) {
  const t = new THREE.DataTexture(data, D, D, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

// ============================================================================ SMOKE
/**
 * Tyre-smoke puff. A = density (billowy fbm shaped by a soft radial falloff), RGB = a baked
 * form-factor gradient: lighter where a puff would catch the key light, darker in the core.
 * The VFX lane multiplies RGB by its own light colour, so the sprite already has *volume* before
 * any lighting is applied — which is what stops a smoke column reading as flat billboards.
 */
export function buildSmokeSprite({ aniso }) {
  const D = 256;
  const N = D * D;
  const dens = fbmField(D, { cells: 3, octaves: 5, gain: 0.58, seed: 4242, billow: true });
  const detail = fbmField(D, { cells: 10, octaves: 3, gain: 0.5, seed: 8484, billow: true });
  const out = new Uint8Array(N * 4);
  const c = (D - 1) / 2;
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      const r = Math.hypot(x - c, y - c) / (D * 0.5);
      // Ragged edge: push the falloff radius around with the density field.
      const edge = 1 - smoothstep(0.42, 1.0, r + (1 - dens[i]) * 0.28 - detail[i] * 0.12);
      const core = 1 - smoothstep(0.0, 0.75, r);
      const a = clamp01(edge * (0.35 + dens[i] * 0.85) * (0.5 + core * 0.7));
      // Fake self-shadowing: light comes from up-left in sprite space.
      const nx = (x - c) / (D * 0.5);
      const ny = (y - c) / (D * 0.5);
      const lit = clamp01(0.52 - nx * 0.32 - ny * 0.38 + dens[i] * 0.28);
      const v = 0.30 + lit * 0.70;
      const j = i * 4;
      out[j] = v * 255;
      out[j + 1] = v * 0.995 * 255;
      out[j + 2] = v * 0.99 * 255;
      out[j + 3] = a * 255;
    }
  }
  return { smokeSprite: rgbaTexture(out, D, { aniso }) };
}

// ============================================================================ SPARK
/** Hot metal spark: a bright white core fading through orange to deep red, with a comet tail. */
export function buildSparkSprite({ aniso }) {
  const D = 128;
  const N = D * D;
  const out = new Uint8Array(N * 4);
  const cx = (D - 1) / 2;
  const cy = (D - 1) / 2;
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      // Elongate along +Y so the VFX lane can orient it along the velocity vector.
      const dx = (x - cx) / (D * 0.5);
      const dy = (y - cy) / (D * 0.5);
      const tail = dy > 0 ? dy * 0.35 : dy * 1.6; // longer one way
      const r = Math.hypot(dx * 3.0, tail);
      const core = Math.exp(-r * r * 9.0);
      const glow = Math.exp(-r * 2.6) * 0.45;
      const a = clamp01(core + glow);
      // Blackbody-ish ramp: white-hot core -> amber -> red edge.
      const t = clamp01(core * 1.4);
      const rr = clamp01(0.65 + t * 0.35);
      const gg = clamp01(0.16 + t * 0.84);
      const bb = clamp01(t * t * 0.9);
      const j = i * 4;
      out[j] = rr * 255;
      out[j + 1] = gg * 255;
      out[j + 2] = bb * 255;
      out[j + 3] = a * 255;
    }
  }
  return { sparkSprite: rgbaTexture(out, D, { aniso }) };
}

// ============================================================================ FLARE
/**
 * Light glow / lens flare. Radial core + a soft halo + faint anamorphic streaks + a chromatic
 * outer ring. Additive-blend friendly (alpha == luminance).
 */
export function buildFlareSprite({ aniso }) {
  const D = 256;
  const N = D * D;
  const out = new Uint8Array(N * 4);
  const c = (D - 1) / 2;
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      const dx = (x - c) / (D * 0.5);
      const dy = (y - c) / (D * 0.5);
      const r = Math.hypot(dx, dy);
      const core = Math.exp(-r * r * 42);
      const halo = Math.exp(-r * 4.2) * 0.5;
      // Anamorphic horizontal streak + a fainter vertical one.
      const hStreak = Math.exp(-Math.abs(dx) * 2.2) * Math.exp(-dy * dy * 700) * 0.55;
      const vStreak = Math.exp(-Math.abs(dy) * 3.4) * Math.exp(-dx * dx * 1400) * 0.28;
      // Six-point diffraction spikes.
      const ang = Math.atan2(dy, dx);
      const spike = Math.pow(Math.abs(Math.cos(ang * 3)), 26) * Math.exp(-r * 3.6) * 0.35;
      const v = clamp01(core + halo + hStreak + vStreak + spike);
      // Chromatic separation: blue tightens inward, red spreads outward.
      const rr = clamp01(v + Math.exp(-Math.abs(r - 0.42) * 16) * 0.10);
      const gg = clamp01(v * 0.98);
      const bb = clamp01(v * 0.94 + Math.exp(-Math.abs(r - 0.26) * 22) * 0.12);
      const j = i * 4;
      out[j] = rr * 255;
      out[j + 1] = gg * 255;
      out[j + 2] = bb * 255;
      out[j + 3] = v * 255;
    }
  }
  return { flareSprite: rgbaTexture(out, D, { aniso }) };
}

// ============================================================================ RAINDROP
/**
 * Two things in one atlas-free texture set:
 *  - `raindrop`     : a falling streak sprite for the rain particle system (vertical, bright head)
 *  - `raindropNormal`: beaded droplets on glass, as a tileable normal map for windscreen/camera FX
 */
export function buildRaindrop({ aniso }) {
  const D = 128;
  const N = D * D;
  const out = new Uint8Array(N * 4);
  const cx = (D - 1) / 2;
  for (let y = 0; y < D; y++) {
    const v = y / (D - 1);
    // Head near the bottom, tapering tail upward.
    const width = lerp(0.055, 0.012, Math.pow(1 - v, 0.6));
    const head = Math.exp(-Math.pow((v - 0.86) / 0.09, 2));
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      const dx = Math.abs(x - cx) / (D * 0.5);
      const body = clamp01(1 - smoothstep(width * 0.6, width * 1.6, dx)) * smoothstep(0.02, 0.16, v);
      const a = clamp01(body * (0.30 + head * 0.85));
      const j = i * 4;
      out[j] = 0.80 * 255;
      out[j + 1] = 0.87 * 255;
      out[j + 2] = 255;
      out[j + 3] = a * 255;
    }
  }
  const streak = rgbaTexture(out, D, { aniso });

  // Beaded droplets: hemispherical caps with flattened trails.
  const B = 256;
  const h = field(B);
  const { f1 } = worleyField(B, 14, 6161, { jitter: 1 });
  const jitter = fbmField(B, { cells: 6, octaves: 3, seed: 2323 });
  for (let i = 0; i < B * B; i++) {
    const d = clamp01(1 - f1[i] * (2.1 + jitter[i] * 0.9));
    h[i] = Math.sqrt(d) * 0.9;
  }
  const trails = streakField(B, { count: 90, dir: 1, len: [0.05, 0.3], width: [1, 3], seed: 646, amp: 0.5 });
  for (let i = 0; i < B * B; i++) h[i] = Math.max(h[i], trails[i] * 0.45);
  normaliseField(h, 0, 1);
  const nrm = bakeNormal(h, B, 2.4, aniso);
  nrm.wrapS = nrm.wrapT = THREE.RepeatWrapping;
  const msk = bakeMask(h, B, { aniso });
  return { raindrop: streak, raindropNormal: nrm, raindropMask: msk };
}

// ============================================================================ SKID
/**
 * Tyre skid decal, laid down by the VFX lane as a ribbon. U runs across the tyre width,
 * V along the mark. Carries the tread striations, the darker edges where rubber piles up,
 * and a feathered start so a mark doesn't begin with a hard rectangle.
 */
export function buildSkidSprite({ aniso }) {
  const D = 256;
  const N = D * D;
  // Grain is stretched along the mark: rubber is dragged, so its texture is anisotropic.
  const grain = field(D);
  {
    const g = fbmField(D, { cells: Math.max(8, D >> 4), octaves: 3, seed: 1919, ridge: true });
    for (let y = 0; y < D; y++) {
      for (let x = 0; x < D; x++) {
        // Sample the field with V compressed 6x -> features smear down the length of the mark.
        const sy = ((y * 6) | 0) % D;
        grain[y * D + x] = g[sy * D + x];
      }
    }
  }
  const along = fbmField(D, { cells: 6, octaves: 3, seed: 2828 });
  const out = new Uint8Array(N * 4);
  for (let y = 0; y < D; y++) {
    const v = y / (D - 1); // along the mark
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      const u = x / (D - 1); // across the tyre
      // Across-width profile: rubber piles at the shoulders, thinner in the grooves.
      const edge = smoothstep(0.0, 0.08, u) * smoothstep(1.0, 0.92, u);
      const grooves = 0.72 + 0.28 * (Math.cos(u * Math.PI * 8) * 0.5 + 0.5);
      const shoulder = 1 + 0.35 * (Math.exp(-Math.pow((u - 0.07) / 0.06, 2)) + Math.exp(-Math.pow((u - 0.93) / 0.06, 2)));
      // Along-length: intensity modulated by grip/heat variation.
      const mod = 0.55 + clamp01(along[i] * 0.9 + 0.5) * 0.45;
      const a = clamp01(edge * grooves * shoulder * mod * (0.7 + grain[i] * 0.5)) * 0.92;
      const j = i * 4;
      const tone = 0.055 + clamp01(grain[i] * 0.5 + 0.5) * 0.05;
      out[j] = tone * 255;
      out[j + 1] = tone * 0.97 * 255;
      out[j + 2] = tone * 0.95 * 255;
      out[j + 3] = a * 255;
    }
  }
  return { skidSprite: rgbaTexture(out, D, { wrap: THREE.RepeatWrapping, aniso }) };
}

// ============================================================================ LIGHT COOKIE
/**
 * Projector cookie for spot lights (street lamps, headlights). Soft-edged pool with the subtle
 * banding, dirt and filament structure a real reflector produces. Black border so it clamps
 * cleanly. Also returns `lightCookieHead` — a headlight cut-off pattern with the asymmetric
 * kick-up on the nearside that every real dipped beam has.
 */
export function buildLightCookie({ aniso }) {
  const D = 256;
  const N = D * D;
  const dirt = fbmField(D, { cells: 5, octaves: 4, gain: 0.55, seed: 3535 });
  const rings = fbmField(D, { cells: 14, octaves: 2, seed: 7171 });

  const pool = new Uint8Array(N * 4);
  const head = new Uint8Array(N * 4);
  const c = (D - 1) / 2;
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      const dx = (x - c) / (D * 0.5);
      const dy = (y - c) / (D * 0.5);
      const r = Math.hypot(dx, dy);

      // --- omni pool ---
      let v = 1 - smoothstep(0.30, 1.0, r);
      v *= 0.75 + clamp01(dirt[i] * 0.6 + 0.55) * 0.45;
      v *= 0.9 + rings[i] * 0.1;
      v = clamp01(v * (1 - smoothstep(0.88, 1.0, r))); // hard clamp at the border
      let j = i * 4;
      pool[j] = pool[j + 1] = pool[j + 2] = v * 255;
      pool[j + 3] = 255;

      // --- dipped headlight beam: wide, low, with a stepped cut-off ---
      const bx = dx * 0.85;
      const by = dy;
      // Cut-off line rises on the nearside, but the step is blended over ~0.25 of the width and
      // softened by the reflector's own scatter — a razor step reads as a clipping bug.
      const cut = lerp(-0.06, -0.30, smoothstep(-0.22, 0.10, bx)) + dirt[i] * 0.03;
      const above = smoothstep(cut + 0.16, cut - 0.05, by);
      const spread = Math.exp(-bx * bx * 2.2);
      const depth = smoothstep(1.0, 0.15, Math.abs(by - cut) * 1.6);
      let hv = above * spread * (0.35 + depth * 0.75);
      // Hot spot just under the cut-off.
      hv += Math.exp(-(bx * bx * 9 + Math.pow(by - cut + 0.10, 2) * 34)) * 0.6;
      hv *= 0.85 + clamp01(dirt[i] * 0.5 + 0.5) * 0.3;
      hv = clamp01(hv * (1 - smoothstep(0.9, 1.0, r)));
      head[j] = head[j + 1] = head[j + 2] = hv * 255;
      head[j + 3] = 255;
    }
  }
  return {
    lightCookie: rgbaTexture(pool, D, { srgb: false, aniso }),
    lightCookieHead: rgbaTexture(head, D, { srgb: false, aniso }),
  };
}

export { field, clamp01, blurField, gritField, cloneField };
