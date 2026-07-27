/**
 * Ground-surface texture generators: asphalt, concrete, curb, grass, dirt, manhole, masks.
 * Owned by the MATERIALS lane.
 *
 * Each builder receives `{ size, aniso }` and returns a map of texture-name -> THREE.Texture,
 * so one expensive field pass feeds albedo + normal + ORM at once (see Assets._buildSet).
 */

import * as THREE from 'three';
import {
  field, fbmField, worleyField, warpField, scatter, streakField, gritField,
  blurField, cloneField, maxField, mapField, normaliseField,
  aoFromHeight, bakeAlbedo, bakeNormal, bakeORM, bakeMask,
  clamp01, smoothstep, lerp, hash2f,
} from './fields.js';
import { hex, mixc, rgbFields, tintRGB, addRGB, chromaDrift } from './palette.js';

// ============================================================================ ASPHALT
/**
 * Dense-graded hot-mix asphalt, aged ~4 years, city arterial.
 *
 * Scale note: consumers land this tile on 3.5-8 m of road, so at 1K one texel is 3-8 mm and a
 * real 10 mm aggregate stone is one to three texels. That is why the *readable* structure here
 * is not individual stones but the clumping between them, plus the things that actually catch
 * your eye on a road: crack-sealant snakes, patch repairs, oil staining, and polished wheel
 * tracks. (Wheel polish is applied in the shader, because the road UV repeats across its width
 * and the tile cannot know where the lanes are.)
 */
export function buildAsphalt({ size: S, aniso }) {
  const N = S * S;

  // ---- structure ----------------------------------------------------------
  // SCALE DISCIPLINE. The tile lands on roughly 8 m of road, so one texel is ~8 mm and a real
  // 10 mm aggregate stone is barely one texel across. Draw stones any bigger and the road reads
  // as cobbles — which is exactly what a too-large worley gives you. So: worley cells at ~4 px
  // (≈3 cm, the raveling clumps you actually see), with the individual stones living in the
  // finer noise below it, and the last of it added procedurally in the shader up close.
  const { f1, f2 } = worleyField(S, Math.max(48, Math.round(S / 6)), 771, { jitter: 1 });
  const agg = field(S);
  const gaps = field(S);
  for (let i = 0; i < N; i++) {
    agg[i] = clamp01(1 - f1[i] * 1.9);
    gaps[i] = clamp01(1 - (f2[i] - f1[i]) * 3.6);
  }

  // Sub-aggregate grain. Deliberately stops well short of Nyquist: 1-2 texel detail in a normal
  // map does not survive mipping or anisotropic filtering, it just shimmers.
  const grain = fbmField(S, { cells: Math.max(24, S >> 4), octaves: 3, gain: 0.55, seed: 4021, ridge: true });
  const fines = gritField(S, 917, 1);
  // Raveling: shallow dishes where the binder has let go of a clump of stones.
  const ravel = field(S);
  scatter(ravel, S, { cells: Math.round(S / 34), radius: [2, 7], aspect: 0.7, sharp: 0.9, amp: 1, seed: 5309, density: 0.35 });

  // Macro tonal drift: oxidation, sun bleaching, old repairs.
  const macro = fbmField(S, { cells: 3, octaves: 4, gain: 0.62, seed: 133 });
  const patchN = fbmField(S, { cells: 5, octaves: 3, gain: 0.5, seed: 812 });

  // Crack-sealant seams: ridged noise, domain-warped so the snakes wander like real ones.
  // Sparse on purpose — one or two snakes crossing an 8 m tile. A dense reticulated net is the
  // single most common mistake in a procedural road: it reads as a dried lakebed, not a repair.
  const wA = fbmField(S, { cells: 2, octaves: 3, seed: 3311 });
  const wB = fbmField(S, { cells: 2, octaves: 3, seed: 5527 });
  const seamRaw = fbmField(S, { cells: 2, octaves: 3, gain: 0.5, seed: 6101, ridge: true });
  const seamW = warpField(seamRaw, S, wA, wB, S * 0.10);
  const seams = field(S);
  for (let i = 0; i < N; i++) seams[i] = smoothstep(0.88, 0.965, seamW[i]);
  blurField(seams, S, Math.max(1, S >> 9), 1);

  // Hairline / alligator cracking — much finer, follows a different warp.
  const crackRaw = fbmField(S, { cells: 10, octaves: 4, gain: 0.55, seed: 2287, ridge: true });
  const cracks = field(S);
  for (let i = 0; i < N; i++) cracks[i] = smoothstep(0.86, 0.97, crackRaw[i]) * clamp01(macro[i] * 1.4 + 0.55);

  // Patch repairs: ONE or TWO blocky zones of newer, blacker mix per tile. Coverage discipline
  // matters more than the shape — a stain mask that covers half the tile stops being a stain
  // and becomes the base colour, which is what turns a road into a field of dark blotches.
  const patchCells = worleyField(S, 4, 4409, { jitter: 0.9, metric: 2 });
  const patch = field(S);
  for (let i = 0; i < N; i++) {
    const inCell = smoothstep(0.10, 0.20, patchCells.f2[i] - patchCells.f1[i]);
    patch[i] = inCell * smoothstep(0.62, 0.78, patchN[i] * 0.5 + 0.5);
  }

  // Oil / fluid staining — billowy, warped. Sparse: the top few percent of the field only.
  const oilRaw = fbmField(S, { cells: 6, octaves: 4, gain: 0.6, seed: 9133, billow: true });
  const oil = field(S);
  for (let i = 0; i < N; i++) oil[i] = smoothstep(0.80, 0.965, 1 - oilRaw[i]);

  // ---- height -------------------------------------------------------------
  // Amplitudes are deliberately shallow. Asphalt is a *flat* material with a fine tooth; the
  // moment the normal map gets deep enough to see individual bumps at 10 m it becomes gravel.
  const h = field(S);
  for (let i = 0; i < N; i++) {
    let v = 0.5 + agg[i] * 0.20 + grain[i] * 0.13 + fines[i] * 0.018;
    v -= gaps[i] * 0.10;
    v -= ravel[i] * 0.16; // raveled dishes sit low
    v += seams[i] * 0.045; // sealant sits proud of the surface, but only by a few millimetres
    v -= cracks[i] * 0.22;
    v += macro[i] * 0.02;
    h[i] = v;
  }
  normaliseField(h, 0, 1);

  // ---- albedo -------------------------------------------------------------
  const [R, G, B] = rgbFields(S);
  const BITUMEN = hex(0x34332f);
  const BITUMEN_OLD = hex(0x4a4842);
  const STONE_L = hex(0x77736a);
  const STONE_D = hex(0x4c4a45);
  const TAR = hex(0x17171a);
  const OILC = hex(0x1c1a18);

  for (let i = 0; i < N; i++) {
    // Base bitumen, oxidised toward grey by the macro field. Kept subtle: strong tonal drift
    // *inside* the tile becomes a repeating blotch pattern once the road is 150 tiles long.
    // Large-scale tonal variation is the shader's job (nftMacro), where it never repeats.
    const ox = clamp01(macro[i] * 0.6 + 0.5);
    let c = mixc(BITUMEN, BITUMEN_OLD, ox * ox * 0.55);
    // Exposed aggregate: only the tops of stones show light rock, and only where the binder
    // has already worn thin. Keep this low-contrast — bright speckle is the "gravel" tell.
    const expo = clamp01((agg[i] - 0.55) * 2.2) * clamp01(0.25 + ox * 0.9);
    const stone = mixc(STONE_D, STONE_L, hash2f(i & 2047, i >> 11, 55));
    c = mixc(c, stone, expo * 0.42);
    // Bitumen gaps go darker.
    c = mixc(c, TAR, gaps[i] * 0.22);
    // Raveled dishes expose more stone and dust.
    c = mixc(c, mixc(STONE_D, BITUMEN_OLD, 0.4), clamp01(ravel[i] - 0.25) * 0.45);
    R[i] = c[0];
    G[i] = c[1];
    B[i] = c[2];
  }
  // Fine grit sparkle (quartz in the mix catching light).
  addRGB(R, G, B, fines, 0.022);
  // Newer patch mix is blacker and less oxidised.
  tintRGB(R, G, B, patch, hex(0x2b2b2e), 0.6);
  // Crack sealant: near-black, wide-ish, slightly proud.
  tintRGB(R, G, B, seams, TAR, 0.9);
  // Cracks themselves: dark lines.
  tintRGB(R, G, B, cracks, hex(0x121213), 0.7);
  // Oil.
  tintRGB(R, G, B, oil, OILC, 0.6);
  chromaDrift(R, G, B, mapField(cloneField(macro), (v) => v * 0.5 + 0.5), 0.055);

  // ---- roughness / AO -----------------------------------------------------
  const ao = aoFromHeight(h, S, Math.max(2, S >> 8), 1.0);
  // Toksvig-flavoured specular anti-aliasing: where the height field is steep, the normal map
  // packs more micro-facets into a texel than the shading model can resolve, so those texels
  // must read rougher. Without this, a low sun turns fine grain into a field of hard glints.
  const slope = field(S);
  {
    const m = S - 1;
    for (let y = 0; y < S; y++) {
      const yc = y * S;
      const yn = ((y - 1) & m) * S;
      const yp = ((y + 1) & m) * S;
      for (let x = 0; x < S; x++) {
        const dx = h[yc + ((x + 1) & m)] - h[yc + ((x - 1) & m)];
        const dy = h[yp + x] - h[yn + x];
        slope[yc + x] = Math.sqrt(dx * dx + dy * dy);
      }
    }
    blurField(slope, S, 1, 1);
  }

  const rough = field(S);
  for (let i = 0; i < N; i++) {
    let r = 0.93;
    r -= clamp01((agg[i] - 0.55) * 2) * 0.10; // stone tops polished by traffic
    r += gaps[i] * 0.03;
    r += (grain[i] - 0.5) * 0.05;
    r += ravel[i] * 0.04; // freshly torn surface is coarser
    r = lerp(r, 0.55, seams[i]); // fresh sealant is glossy
    r = lerp(r, 0.42, oil[i] * 0.9); // oil films are glossy
    r = lerp(r, 0.90, patch[i] * 0.6); // new mix is matte
    r += clamp01(slope[i] * 5.5) * 0.05;
    rough[i] = clamp01(r);
  }

  return {
    asphalt: bakeAlbedo(R, G, B, S, aniso),
    asphaltNormal: bakeNormal(h, S, 0.22, aniso),
    asphaltRough: bakeORM(ao, rough, null, S, aniso),
  };
}

// ============================================================================ CONCRETE
/** Cast concrete: form-board marks, aggregate bloom, rain streaking, chipped edges, rust bleed. */
export function buildConcrete({ size: S, aniso }) {
  const N = S * S;

  const macro = fbmField(S, { cells: 3, octaves: 4, gain: 0.6, seed: 41 });
  const mottle = fbmField(S, { cells: 12, octaves: 4, gain: 0.55, seed: 77 });
  const fine = fbmField(S, { cells: Math.max(16, S >> 3), octaves: 3, gain: 0.5, seed: 909, ridge: true });
  const grit = gritField(S, 313, 1);

  // Pinholes / bug-holes from trapped air against the formwork.
  const holes = field(S);
  scatter(holes, S, { cells: Math.round(S / 22), radius: [0.8, 2.6], aspect: 0.25, sharp: 0.7, amp: 1, seed: 1717, density: 0.55 });

  // Exposed aggregate bloom where the surface has spalled.
  const spallMask = field(S);
  for (let i = 0; i < N; i++) spallMask[i] = smoothstep(0.34, 0.6, macro[i]);
  const agg = field(S);
  scatter(agg, S, { cells: Math.round(S / 14), radius: [1.5, 5], aspect: 0.6, sharp: 1.4, amp: 1, seed: 2929 });

  // Vertical rain streaking (concrete's most recognisable weathering cue).
  const streaks = streakField(S, { count: Math.round(S / 3), dir: 1, len: [0.12, 0.65], width: [1.5, 5.5], seed: 51, amp: 1 });
  blurField(streaks, S, Math.max(1, S >> 9), 1);

  // Form-board horizontal joints every ~1/4 tile.
  const joints = field(S);
  for (let y = 0; y < S; y++) {
    const t = (y / S) * 4;
    const d = Math.abs(t - Math.round(t));
    const v = smoothstep(0.016, 0.0, d);
    for (let x = 0; x < S; x++) joints[y * S + x] = v;
  }

  const h = field(S);
  for (let i = 0; i < N; i++) {
    h[i] = 0.5 + mottle[i] * 0.05 + fine[i] * 0.055 + grit[i] * 0.015
      - holes[i] * 0.38 - joints[i] * 0.3 + agg[i] * spallMask[i] * 0.16;
  }
  normaliseField(h, 0, 1);

  const [R, G, B] = rgbFields(S);
  const C_LIGHT = hex(0xb0aca4);
  const C_MID = hex(0x8f8b83);
  const C_DARK = hex(0x6a6760);
  const C_STAIN = hex(0x4e4c48);
  const C_RUST = hex(0x6d4425);

  for (let i = 0; i < N; i++) {
    const t = clamp01(macro[i] * 0.55 + 0.5 + mottle[i] * 0.22);
    let c = mixc(C_DARK, C_LIGHT, t);
    c = mixc(c, C_MID, clamp01(fine[i] * 0.5 + 0.5) * 0.35);
    c = mixc(c, hex(0x9c988f), clamp01(agg[i] * spallMask[i]) * 0.5);
    R[i] = c[0];
    G[i] = c[1];
    B[i] = c[2];
  }
  tintRGB(R, G, B, streaks, C_STAIN, 0.42);
  tintRGB(R, G, B, joints, C_DARK, 0.55);
  tintRGB(R, G, B, holes, hex(0x3d3b37), 0.7);
  // A couple of rust bleeds from rebar/fixings.
  const rust = field(S);
  for (let i = 0; i < N; i++) rust[i] = smoothstep(0.72, 0.93, streaks[i]) * smoothstep(0.55, 0.85, mottle[i] * 0.5 + 0.5);
  tintRGB(R, G, B, rust, C_RUST, 0.5);
  addRGB(R, G, B, grit, 0.022);
  chromaDrift(R, G, B, mapField(cloneField(mottle), (v) => v * 0.5 + 0.5), 0.04);

  const ao = aoFromHeight(h, S, Math.max(2, S >> 9), 1.2);
  const rough = field(S);
  for (let i = 0; i < N; i++) {
    let r = 0.82 + fine[i] * 0.08 + (mottle[i] * 0.5 + 0.5) * 0.08;
    r += holes[i] * 0.08;
    r = lerp(r, 0.66, clamp01(streaks[i]) * 0.5); // washed areas are smoother
    r = lerp(r, 0.9, clamp01(agg[i] * spallMask[i]));
    rough[i] = clamp01(r);
  }

  return {
    concrete: bakeAlbedo(R, G, B, S, aniso),
    concreteNormal: bakeNormal(h, S, 0.45, aniso),
    concreteRough: bakeORM(ao, rough, null, S, aniso),
  };
}

// ============================================================================ CURB
/** Painted kerb: red/white alternating blocks, chipped paint, exposed concrete, tyre rubber. */
export function buildCurb({ size: S, aniso }) {
  const N = S * S;
  const base = fbmField(S, { cells: 8, octaves: 4, gain: 0.55, seed: 611 });
  const fine = fbmField(S, { cells: Math.max(16, S >> 3), octaves: 3, seed: 233, ridge: true });
  const grit = gritField(S, 88, 1);

  // Chipping: worley cells knocked off the paint layer at the block edges.
  const chip = field(S);
  scatter(chip, S, { cells: Math.round(S / 26), radius: [2, 9], aspect: 0.8, sharp: 0.6, amp: 1, seed: 4321, density: 0.5 });

  const h = field(S);
  const [R, G, B] = rgbFields(S);
  const RED = hex(0xb8322c);
  const RED_D = hex(0x8e2723);
  const WHITE = hex(0xd8d6d0);
  const WHITE_D = hex(0xa9a7a1);
  const CONC = hex(0x8b8880);
  const RUBBER = hex(0x2a2a2c);

  const BLOCKS = 6;
  for (let y = 0; y < S; y++) {
    const v = y / S;
    const bf = v * BLOCKS;
    const bi = Math.floor(bf);
    const inBlock = bf - bi;
    // Mortar/expansion line between blocks.
    const joint = smoothstep(0.03, 0.0, Math.min(inBlock, 1 - inBlock));
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const isRed = bi % 2 === 0;
      const shade = clamp01(base[i] * 0.5 + 0.5);
      let c = isRed ? mixc(RED_D, RED, shade) : mixc(WHITE_D, WHITE, shade);
      // Paint worn through to concrete on the high spots.
      const wear = clamp01(chip[i] * 1.3 - 0.15) * clamp01(0.4 + shade);
      c = mixc(c, CONC, wear);
      c = mixc(c, hex(0x5c5a55), joint * 0.8);
      R[i] = c[0];
      G[i] = c[1];
      B[i] = c[2];
      h[i] = 0.55 + fine[i] * 0.12 + grit[i] * 0.03 - joint * 0.6 - chip[i] * 0.22;
    }
  }
  // Tyre rubber scuffs across the top.
  const scuff = streakField(S, { count: Math.round(S / 8), dir: 0, len: [0.08, 0.5], width: [1, 4], seed: 707, amp: 0.9 });
  tintRGB(R, G, B, scuff, RUBBER, 0.5);
  addRGB(R, G, B, grit, 0.02);
  normaliseField(h, 0, 1);

  const ao = aoFromHeight(h, S, Math.max(2, S >> 9), 1.0);
  const rough = field(S);
  for (let i = 0; i < N; i++) {
    // Fresh paint is semi-gloss; worn concrete is matte; rubber is very matte.
    const wear = clamp01(chip[i] * 1.3 - 0.15);
    rough[i] = clamp01(lerp(0.42, 0.88, wear) + fine[i] * 0.06 + scuff[i] * 0.12);
  }

  return {
    curb: bakeAlbedo(R, G, B, S, aniso),
    curbNormal: bakeNormal(h, S, 0.9, aniso),
    curbRough: bakeORM(ao, rough, null, S, aniso),
  };
}

// ============================================================================ GRASS / DIRT
/** Mown verge grass seen from above: blade clumps, dry patches, soil showing through. */
export function buildGrass({ size: S, aniso }) {
  const N = S * S;
  const clump = fbmField(S, { cells: 6, octaves: 4, gain: 0.58, seed: 1231 });
  const dry = fbmField(S, { cells: 3, octaves: 3, gain: 0.6, seed: 4567 });
  const blades = streakField(S, { count: S * 6, dir: 1, len: [0.006, 0.03], width: [0.6, 1.6], seed: 31, amp: 1 });
  const blades2 = streakField(S, { count: S * 4, dir: 0, len: [0.005, 0.022], width: [0.6, 1.4], seed: 32, amp: 0.8 });
  maxField(blades, blades2);
  const soil = field(S);
  for (let i = 0; i < N; i++) soil[i] = smoothstep(0.45, 0.75, -clump[i]);

  const h = field(S);
  for (let i = 0; i < N; i++) h[i] = 0.5 + clump[i] * 0.28 + blades[i] * 0.3 - soil[i] * 0.2;
  normaliseField(h, 0, 1);

  const [R, G, B] = rgbFields(S);
  const G_DARK = hex(0x2c3d1c);
  const G_MID = hex(0x4a6328);
  const G_LIGHT = hex(0x6f8a3a);
  const G_DRY = hex(0x8a7f43);
  const SOIL = hex(0x413428);
  for (let i = 0; i < N; i++) {
    const t = clamp01(clump[i] * 0.6 + 0.5);
    let c = mixc(G_DARK, G_MID, t);
    c = mixc(c, G_LIGHT, clamp01(blades[i]) * 0.55);
    c = mixc(c, G_DRY, clamp01(dry[i] * 0.7 + 0.35) * 0.55);
    c = mixc(c, SOIL, soil[i] * 0.8);
    R[i] = c[0];
    G[i] = c[1];
    B[i] = c[2];
  }

  const ao = aoFromHeight(h, S, Math.max(2, S >> 8), 1.4);
  const rough = field(S);
  for (let i = 0; i < N; i++) rough[i] = clamp01(0.86 - clamp01(blades[i]) * 0.22 + soil[i] * 0.1);

  return {
    grassAlbedo: bakeAlbedo(R, G, B, S, aniso),
    grassNormal: bakeNormal(h, S, 1.5, aniso),
    grassRough: bakeORM(ao, rough, null, S, aniso),
  };
}

/** Dry compacted dirt / dust runoff: pebbles, tyre ruts, cracked crust. */
export function buildDirt({ size: S, aniso }) {
  const N = S * S;
  const macro = fbmField(S, { cells: 4, octaves: 4, gain: 0.6, seed: 8123 });
  const fine = fbmField(S, { cells: Math.max(16, S >> 3), octaves: 3, seed: 4499, ridge: true });
  const pebbles = field(S);
  scatter(pebbles, S, { cells: Math.round(S / 20), radius: [1.2, 4.5], aspect: 0.7, sharp: 1.5, amp: 1, seed: 6611, density: 0.7 });
  // Crazing in the dried crust. Cells must stay small — big cells give the "dry lakebed"
  // look, which is a completely different (and much rarer) surface.
  const crack = worleyField(S, Math.max(24, S >> 4), 991, { jitter: 0.85 });
  const cracks = field(S);
  for (let i = 0; i < N; i++) cracks[i] = smoothstep(0.055, 0.0, crack.f2[i] - crack.f1[i]) * smoothstep(0.35, 0.75, macro[i] * 0.5 + 0.5);
  const grit = gritField(S, 550, 1);

  const h = field(S);
  for (let i = 0; i < N; i++) h[i] = 0.5 + macro[i] * 0.09 + fine[i] * 0.10 + pebbles[i] * 0.22 - cracks[i] * 0.2 + grit[i] * 0.025;
  normaliseField(h, 0, 1);

  const [R, G, B] = rgbFields(S);
  const D_DARK = hex(0x453629);
  const D_MID = hex(0x6d5940);
  const D_LIGHT = hex(0x937d5d);
  const D_PEB = hex(0x8b8478);
  for (let i = 0; i < N; i++) {
    const t = clamp01(macro[i] * 0.6 + 0.5);
    let c = mixc(D_DARK, D_LIGHT, t);
    c = mixc(c, D_MID, clamp01(fine[i] * 0.5 + 0.5) * 0.4);
    c = mixc(c, D_PEB, clamp01(pebbles[i] - 0.25) * 0.8);
    c = mixc(c, D_DARK, cracks[i] * 0.45);
    R[i] = c[0];
    G[i] = c[1];
    B[i] = c[2];
  }
  addRGB(R, G, B, grit, 0.03);

  const ao = aoFromHeight(h, S, Math.max(2, S >> 9), 1.2);
  const rough = field(S);
  for (let i = 0; i < N; i++) rough[i] = clamp01(0.95 - clamp01(pebbles[i] - 0.3) * 0.25 + fine[i] * 0.04);

  return {
    dirtAlbedo: bakeAlbedo(R, G, B, S, aniso),
    dirtNormal: bakeNormal(h, S, 1.2, aniso),
    dirtRough: bakeORM(ao, rough, null, S, aniso),
  };
}

// ============================================================================ MANHOLE
/** Cast-iron manhole cover, clamped, one per quad. Diamond tread, rust wash, bolt recesses. */
export function buildManhole({ size: S, aniso }) {
  const D = Math.min(S, 512);
  const N = D * D;
  const rustF = fbmField(D, { cells: 6, octaves: 4, gain: 0.6, seed: 3321 });
  const fine = fbmField(D, { cells: Math.max(16, D >> 3), octaves: 3, seed: 7761, ridge: true });
  const h = field(D);
  const [R, G, B] = rgbFields(D);
  const IRON = hex(0x3a3a3c);
  const IRON_L = hex(0x585a5c);
  const RUSTC = hex(0x6b3f22);
  const ASPH = hex(0x2f2e2b);

  const cx = D / 2;
  const cy = D / 2;
  const rOuter = D * 0.46;
  const rRim = D * 0.42;
  const rInner = D * 0.36;

  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const inCover = smoothstep(rOuter, rOuter - 2.5, r);

      // Diamond tread pattern on the inner disc.
      const gx = (x / D) * 22;
      const gy = (y / D) * 22;
      const dsq = Math.abs(((gx + gy) % 1) - 0.5) + Math.abs(((gx - gy) % 1) - 0.5);
      const tread = smoothstep(0.55, 0.35, dsq) * smoothstep(rInner, rInner - 4, r);

      // Rim groove + radial ribs.
      const groove = smoothstep(2.5, 0.0, Math.abs(r - rRim));
      const ribs = smoothstep(0.72, 0.95, Math.cos(ang * 24) * 0.5 + 0.5) * smoothstep(rRim - 1, rInner, r) * smoothstep(rInner - 8, rInner, r);

      // Seat gap between cover and asphalt collar.
      const gap = smoothstep(2.0, 0.0, Math.abs(r - rOuter));

      let hh = inCover * 0.62 + tread * 0.2 + ribs * 0.12 - groove * 0.25 - gap * 0.5;
      hh += fine[i] * 0.06;
      h[i] = hh + 0.2;

      const rustAmt = clamp01(rustF[i] * 0.8 + 0.35) * (0.35 + tread * 0.5);
      let c = mixc(IRON, IRON_L, clamp01(fine[i] * 0.6 + 0.45) * (0.4 + tread * 0.8));
      c = mixc(c, RUSTC, rustAmt * 0.55);
      c = mixc(c, ASPH, 1 - inCover);
      R[i] = c[0];
      G[i] = c[1];
      B[i] = c[2];
    }
  }
  normaliseField(h, 0, 1);
  const ao = aoFromHeight(h, D, 3, 1.3);
  const rough = field(D);
  for (let i = 0; i < N; i++) rough[i] = clamp01(0.5 + clamp01(rustF[i] * 0.5 + 0.5) * 0.35 + fine[i] * 0.06);
  const metal = field(D);
  for (let i = 0; i < N; i++) {
    const dx = (i % D) - cx;
    const dy = ((i / D) | 0) - cy;
    metal[i] = smoothstep(rOuter, rOuter - 2.5, Math.hypot(dx, dy)) * (1 - clamp01(rustF[i] * 0.4 + 0.4) * 0.55);
  }

  const opt = { wrap: THREE.ClampToEdgeWrapping };
  const a = bakeAlbedo(R, G, B, D, aniso, opt);
  const n = bakeNormal(h, D, 1.6, aniso);
  n.wrapS = n.wrapT = THREE.ClampToEdgeWrapping;
  const o = bakeORM(ao, rough, metal, D, aniso);
  o.wrapS = o.wrapT = THREE.ClampToEdgeWrapping;
  return { manhole: a, manholeNormal: n, manholeRough: o };
}

// ============================================================================ MASKS
/**
 * Road marking mask. R = long lane line, G = dashed centre line, B = wide edge/stop line.
 * Packed so a road shader can pick the marking type per-lane without three textures.
 * Slightly eroded edges + worn gaps, because a razor-sharp painted line is an instant tell.
 */
export function buildRoadLineMask({ size: S, aniso }) {
  const D = Math.min(S, 1024);
  const N = D * D;
  const wear = fbmField(D, { cells: 10, octaves: 4, gain: 0.55, seed: 1919 });
  const edge = fbmField(D, { cells: Math.max(16, D >> 3), octaves: 3, seed: 2727 });
  const out = new Uint8Array(N * 4);

  for (let y = 0; y < D; y++) {
    const v = y / D;
    // Dash cycle: 3 m paint / 6 m gap, softened at the ends.
    const cyc = (v * 4) % 1;
    const dash = smoothstep(0.0, 0.02, cyc) * smoothstep(0.36, 0.34, cyc);
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      const u = x / D;
      const e = edge[i] * 0.012;
      // Solid line down the middle of the tile.
      const solid = smoothstep(0.5 + 0.055 + e, 0.5 + 0.045 + e, Math.abs(u - 0.5) + 0.5) *
        smoothstep(0.44 - e, 0.455 - e, u) * smoothstep(0.556 + e, 0.545 + e, u);
      const line = clamp01(smoothstep(0.455 + e, 0.47 + e, u) * smoothstep(0.545 - e, 0.53 - e, u));
      const w = clamp01(0.55 + wear[i] * 1.1); // patchy wear
      const wornLine = clamp01(line * w);
      const j = i * 4;
      out[j] = wornLine * 255; // solid lane line
      out[j + 1] = wornLine * dash * 255; // dashed
      out[j + 2] = clamp01(smoothstep(0.38, 0.42, u) * smoothstep(0.62, 0.58, u) * w) * 255; // wide bar
      out[j + 3] = 255;
      void solid;
    }
  }
  const t = new THREE.DataTexture(out, D, D, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return { roadLineMask: t };
}

/** Where water pools. Low-frequency warped basins — used by the wet-road shader and VFX. */
export function buildPuddleMask({ size: S, aniso }) {
  const D = Math.min(S, 512);
  const a = fbmField(D, { cells: 3, octaves: 3, seed: 771 });
  const b = fbmField(D, { cells: 3, octaves: 3, seed: 313 });
  const base = fbmField(D, { cells: 4, octaves: 5, gain: 0.55, seed: 5150 });
  const w = warpField(base, D, a, b, D * 0.12);
  normaliseField(w, 0, 1);
  return { puddleMask: bakeMask(w, D, { aniso }) };
}

/** Animated-looking water caustics tile (static, but scrolled + double-sampled by the shader). */
export function buildCaustics({ size: S, aniso }) {
  const D = Math.min(S, 512);
  const N = D * D;
  // Caustics are the *bright web*, not the cells: take the cell borders, sharpen hard, and let
  // the black between them dominate. Two of these scrolled against each other read as moving
  // water without a single frame of animation being stored.
  const { f1, f2 } = worleyField(D, 9, 4242, { jitter: 1 });
  const wob = fbmField(D, { cells: 5, octaves: 3, seed: 1357 });
  const out = field(D);
  for (let i = 0; i < N; i++) {
    const e = f2[i] - f1[i];
    const web = Math.pow(clamp01(1 - e * 3.4), 7.0);
    out[i] = clamp01(web * (0.75 + wob[i] * 0.7) * 1.6);
  }
  blurField(out, D, 1, 1);
  normaliseField(out, 0, 1);
  for (let i = 0; i < N; i++) out[i] = Math.pow(out[i], 1.6);
  return { caustics: bakeMask(out, D, { aniso, alphaFromValue: true }) };
}

export { field, clamp01, smoothstep, lerp };
