/**
 * Vehicle & industrial-material texture generators.
 * metalScratch, carPaintFlake, tireTread/tireNormal, paintChip, carbonFibre, brushedAlu, rubberScuff.
 * Owned by the MATERIALS lane.
 */

import * as THREE from 'three';
import {
  field, fbmField, scatter, streakField, gritField, blurField, worleyField,
  cloneField, normaliseField, aoFromHeight,
  bakeAlbedo, bakeNormal, bakeORM, bakeMask,
  clamp01, smoothstep, lerp, hash2f, hash2i,
} from './fields.js';
import { hex, mixc, rgbFields, tintRGB, addRGB } from './palette.js';

// ============================================================================ METAL SCRATCH
/** Scuffed painted steel — barriers, guardrails, dumpsters. Scratches cut through to bare metal. */
export function buildMetalScratch({ size: S, aniso }) {
  const D = Math.min(S, 1024);
  const N = D * D;
  const macro = fbmField(D, { cells: 4, octaves: 4, gain: 0.6, seed: 1451 });
  const fine = fbmField(D, { cells: Math.max(16, D >> 3), octaves: 3, seed: 3391, ridge: true });
  // Two crossed scratch families + a fine hairline family.
  const sA = streakField(D, { count: Math.round(D * 1.4), dir: 0, len: [0.02, 0.35], width: [0.5, 1.6], seed: 61, amp: 1 });
  const sB = streakField(D, { count: Math.round(D * 0.7), dir: 1, len: [0.01, 0.18], width: [0.5, 1.2], seed: 62, amp: 0.7 });
  const dents = field(D);
  scatter(dents, D, { cells: Math.round(D / 42), radius: [4, 16], aspect: 0.5, sharp: 0.8, amp: 1, seed: 981, density: 0.4 });
  const rustSpot = field(D);
  scatter(rustSpot, D, { cells: Math.round(D / 20), radius: [2, 9], aspect: 0.7, sharp: 0.9, amp: 1, seed: 771, density: 0.35 });
  const grit = gritField(D, 217, 1);

  const scr = field(D);
  for (let i = 0; i < N; i++) scr[i] = clamp01(Math.max(sA[i], sB[i]));

  const h = field(D);
  for (let i = 0; i < N; i++) h[i] = 0.55 + macro[i] * 0.05 + fine[i] * 0.05 + grit[i] * 0.02 - dents[i] * 0.3 - scr[i] * 0.12 + rustSpot[i] * 0.06;
  normaliseField(h, 0, 1);

  const [R, G, B] = rgbFields(D);
  const PAINT = hex(0xa8adb3);
  const PAINT_D = hex(0x6e747b);
  const BARE = hex(0xd6dbe1);
  const GRIME = hex(0x4a4c4e);
  const RUST = hex(0x74401f);
  for (let i = 0; i < N; i++) {
    const t = clamp01(macro[i] * 0.7 + 0.5);
    let c = mixc(PAINT_D, PAINT, t * t);
    // Road film settles unevenly — without it galvanised steel reads as flat white plastic.
    c = mixc(c, GRIME, clamp01(0.45 - macro[i] * 0.8) * 0.55);
    c = mixc(c, BARE, clamp01(scr[i] * 1.6 - 0.08) * 0.9);
    R[i] = c[0];
    G[i] = c[1];
    B[i] = c[2];
  }
  const rustMask = field(D);
  for (let i = 0; i < N; i++) rustMask[i] = clamp01(rustSpot[i] * 1.2 - 0.15) * clamp01(0.35 + macro[i] * 0.9);
  tintRGB(R, G, B, rustMask, RUST, 0.75);
  addRGB(R, G, B, grit, 0.02);

  const ao = aoFromHeight(h, D, Math.max(2, D >> 8), 1.2);
  const rough = field(D);
  const metal = field(D);
  for (let i = 0; i < N; i++) {
    const bare = clamp01(scr[i] * 1.4 - 0.1);
    const rst = rustMask[i];
    rough[i] = clamp01(lerp(0.42, 0.24, bare) + rst * 0.55 + fine[i] * 0.06 + clamp01(macro[i]) * 0.06);
    metal[i] = clamp01(lerp(0.55, 1.0, bare) * (1 - rst * 0.8));
  }
  return {
    metalScratch: bakeAlbedo(R, G, B, D, aniso),
    metalScratchNormal: bakeNormal(h, D, 0.75, aniso),
    metalScratchRough: bakeORM(ao, rough, metal, D, aniso),
  };
}

// ============================================================================ CAR PAINT FLAKE
/**
 * Metallic-flake normal map. This is consumed as `normalMap` on car paint with a *very* high
 * repeat (60-200×) and a small normalScale — the flakes are ~0.1 mm aluminium platelets, so what
 * you want on screen is a dense field of randomly-tilted micro-facets that make the paint boil
 * with sparkle as the car rotates under a light. Companion `carPaintFlakeMask` carries the
 * per-flake reflectance for anyone who wants to modulate roughness or clearcoat with it.
 */
export function buildCarPaintFlake({ size: S, aniso }) {
  const D = Math.min(S, 512);
  const N = D * D;
  // Flakes: hard-edged facets, not smooth bumps. Use worley cell ids to get flat tilted plates.
  const cells = Math.max(48, D >> 2);
  const { f1, f2 } = worleyField(D, cells, 3037, { jitter: 1 });
  const out = new Uint8Array(N * 4);
  const mask = field(D);
  const micro = gritField(D, 4801, 1);

  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      // Recover a per-cell pseudo id from the F1/F2 pair so each plate gets one constant tilt.
      const cx = Math.floor((x / D) * cells);
      const cy = Math.floor((y / D) * cells);
      const id = hash2i(cx, cy, 3037);
      const a = ((id & 0xffff) / 65535) * Math.PI * 2;
      const tilt = 0.25 + ((id >>> 16) & 0xff) / 255 * 0.85;
      // Only the inner part of each cell is a flake; the rest is flat clearcoat.
      const plate = smoothstep(0.52, 0.14, f1[i]) * smoothstep(0.01, 0.06, f2[i] - f1[i]);
      let nx = Math.cos(a) * tilt * plate;
      let ny = Math.sin(a) * tilt * plate;
      nx += micro[i] * 0.05;
      ny += micro[(i * 7 + 13) % N] * 0.05;
      const l = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const j = i * 4;
      out[j] = (nx * l * 0.5 + 0.5) * 255;
      out[j + 1] = (ny * l * 0.5 + 0.5) * 255;
      out[j + 2] = (l * 0.5 + 0.5) * 255;
      out[j + 3] = 255;
      mask[i] = plate;
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

  // Orange-peel: the low-frequency waviness every real clearcoat has. Separate, gentler normal.
  const peelH = fbmField(D, { cells: 10, octaves: 3, gain: 0.5, seed: 6006 });
  normaliseField(peelH, 0, 1);

  return {
    carPaintFlake: t,
    carPaintFlakeMask: bakeMask(mask, D, { aniso }),
    clearcoatPeel: bakeNormal(peelH, D, 0.22, aniso),
  };
}

// ============================================================================ TYRE
/**
 * Performance tyre tread. U wraps the circumference, V runs across the width.
 * Four circumferential grooves, angled lateral sipes, chunky shoulder blocks, and the
 * moulding flash + wear indicators that make a tyre read as moulded rubber.
 */
export function buildTire({ size: S, aniso }) {
  const D = Math.min(S, 512);
  const N = D * D;
  const rubber = fbmField(D, { cells: Math.max(16, D >> 3), octaves: 3, seed: 1010, ridge: true });
  const macro = fbmField(D, { cells: 6, octaves: 3, seed: 2020 });
  const grit = gritField(D, 707, 1);

  const h = field(D);
  const [R, G, B] = rgbFields(D);
  // Rubber photographs far lighter than people expect — a black tyre lit by daylight sits
  // around #2c2c30, not #101012. Painting it at the value you *think* black is gives you a
  // silhouette with no readable tread.
  const RUB = hex(0x2b2b2f);
  const RUB_L = hex(0x46464c);
  const RUB_D = hex(0x141416);
  const DUST = hex(0x554e44);

  const GROOVES = [0.18, 0.38, 0.62, 0.82];
  for (let y = 0; y < D; y++) {
    const v = y / D; // across the tread
    let groove = 0;
    for (const gpos of GROOVES) groove = Math.max(groove, smoothstep(0.030, 0.012, Math.abs(v - gpos)));
    // Shoulder blocks at the outer 12%.
    const shoulder = 1 - smoothstep(0.10, 0.14, Math.min(v, 1 - v));
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      const u = x / D; // around the circumference
      // Angled sipes: fine slits raked ~18 degrees, denser on the shoulders.
      const rake = u * 26 + (v - 0.5) * 5.2;
      const sipe = smoothstep(0.055, 0.02, Math.abs(((rake % 1) + 1) % 1 - 0.5) - 0.44);
      // Shoulder block gaps: bigger, blockier.
      const blockCut = shoulder * smoothstep(0.10, 0.04, Math.abs((((u * 13 + v * 1.2) % 1) + 1) % 1 - 0.5) - 0.38);

      const cut = clamp01(Math.max(groove, Math.max(sipe * 0.9, blockCut)));
      let hh = 0.82 - cut * 0.80 + rubber[i] * 0.06 + grit[i] * 0.015;
      // Slight crown so the centre sits proud.
      hh += (1 - Math.abs(v - 0.5) * 2) * 0.04;
      h[i] = hh;

      let c = mixc(RUB, RUB_L, clamp01(rubber[i] * 0.5 + 0.5) * 0.5 + clamp01(macro[i]) * 0.2);
      c = mixc(c, RUB_D, cut * 0.92);
      // Road dust on the tread faces.
      c = mixc(c, DUST, clamp01(1 - cut) * clamp01(macro[i] * 0.5 + 0.35) * 0.3);
      R[i] = c[0];
      G[i] = c[1];
      B[i] = c[2];
    }
  }
  normaliseField(h, 0, 1);

  const ao = aoFromHeight(h, D, Math.max(3, D >> 7), 2.2);
  const rough = field(D);
  for (let i = 0; i < N; i++) {
    // Scrubbed tread faces are noticeably glossier than the moulded groove walls — that
    // contrast, plus deep AO in the grooves, is what makes the pattern readable on a black tyre.
    rough[i] = clamp01(0.94 - clamp01(h[i] - 0.5) * 0.60 + rubber[i] * 0.05);
  }

  return {
    tireTread: bakeAlbedo(R, G, B, D, aniso),
    tireNormal: bakeNormal(h, D, 2.2, aniso),
    tireRough: bakeORM(ao, rough, null, D, aniso),
  };
}

// ============================================================================ PAINT CHIP
/** Stone-chip decal for leading edges: tiny craters exposing primer and bare metal. RGBA. */
export function buildPaintChip({ size: S, aniso }) {
  const D = Math.min(S, 256);
  const N = D * D;
  const chips = field(D);
  scatter(chips, D, { cells: Math.round(D / 5), radius: [1.2, 5.0], aspect: 0.8, sharp: 0.45, amp: 1, seed: 313, density: 0.75 });
  const halo = cloneField(chips);
  blurField(halo, D, 1, 1);
  const grad = fbmField(D, { cells: 3, octaves: 3, seed: 646 });

  const out = new Uint8Array(N * 4);
  const PRIMER = hex(0x9a9a96);
  const BARE = hex(0xd0d4d8);
  for (let i = 0; i < N; i++) {
    const core = smoothstep(0.18, 0.5, chips[i]);
    const ring = clamp01(halo[i] * 1.8 - core);
    const c = mixc(PRIMER, BARE, core * 0.7);
    const a = clamp01(core * 1.0 + ring * 0.3) * clamp01(0.55 + grad[i] * 1.2);
    const j = i * 4;
    out[j] = c[0] * 255;
    out[j + 1] = c[1] * 255;
    out[j + 2] = c[2] * 255;
    out[j + 3] = a * 255;
  }
  const t = new THREE.DataTexture(out, D, D, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;

  const h = field(D);
  for (let i = 0; i < N; i++) h[i] = 0.6 - smoothstep(0.3, 0.7, chips[i]) * 0.5;
  return { paintChip: t, paintChipNormal: bakeNormal(h, D, 1.4, aniso) };
}

// ============================================================================ CARBON FIBRE
/**
 * 2×2 twill carbon weave. The tell of a good carbon shader is the *anisotropic* highlight
 * running along each tow and flipping 90° between warp and weft — that's carried here by the
 * normal map's directional ripple plus a roughness that is lower along the fibre direction.
 */
export function buildCarbon({ size: S, aniso }) {
  const D = Math.min(S, 512);
  const N = D * D;
  const TOWS = 8; // 2x2 twill repeats every 4 tows; 8 gives two repeats per tile
  const cell = D / TOWS;
  const h = field(D);
  const dirF = field(D); // 0 = weft (horizontal tow), 1 = warp (vertical tow)
  const fibre = field(D);
  const dust = fbmField(D, { cells: 5, octaves: 3, seed: 8181 });

  for (let y = 0; y < D; y++) {
    const ty = y / cell;
    const j = Math.floor(ty);
    const fy = ty - j;
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      const tx = x / cell;
      const k = Math.floor(tx);
      const fx = tx - k;
      // 2x2 twill: warp is on top when ((k - j) mod 4) < 2
      const over = ((((k - j) % 4) + 4) % 4) < 2;
      // Rounded tow cross-section.
      const bulgeV = Math.cos((fx - 0.5) * Math.PI) ** 0.7;
      const bulgeH = Math.cos((fy - 0.5) * Math.PI) ** 0.7;
      const hh = over ? bulgeV * 0.9 + bulgeH * 0.25 : bulgeH * 0.9 + bulgeV * 0.25;
      // Individual filaments running along the tow.
      const fil = over
        ? Math.sin((x / D) * TOWS * 0 + fx * Math.PI * 2 * 0 + (y / D) * 900) * 0.5 + 0.5
        : Math.sin((x / D) * 900) * 0.5 + 0.5;
      h[i] = hh * 0.5 + 0.25 + fil * 0.04;
      dirF[i] = over ? 1 : 0;
      fibre[i] = fil;
    }
  }
  normaliseField(h, 0, 1);

  const [R, G, B] = rgbFields(D);
  const DARK = hex(0x0f1013);
  const MID = hex(0x24262b);
  const SHEEN = hex(0x4a4e58);
  for (let i = 0; i < N; i++) {
    const t = clamp01(h[i]);
    let c = mixc(DARK, MID, t * t);
    c = mixc(c, SHEEN, clamp01(t - 0.72) * 1.6 * (0.4 + fibre[i] * 0.6));
    // Resin bloom.
    c = mixc(c, [c[0] * 1.12, c[1] * 1.12, c[2] * 1.16], clamp01(dust[i] * 0.5 + 0.5) * 0.25);
    R[i] = c[0];
    G[i] = c[1];
    B[i] = c[2];
  }

  const ao = aoFromHeight(h, D, 2, 1.5);
  const rough = field(D);
  const metal = field(D);
  for (let i = 0; i < N; i++) {
    // Lower roughness on the crest of each tow, higher in the interstices.
    rough[i] = clamp01(0.34 - clamp01(h[i] - 0.6) * 0.22 + (1 - h[i]) * 0.22 + fibre[i] * 0.03);
    metal[i] = 0.15 + h[i] * 0.15;
  }
  return {
    carbonFibre: bakeAlbedo(R, G, B, D, aniso),
    carbonFibreNormal: bakeNormal(h, D, 1.1, aniso),
    carbonFibreRough: bakeORM(ao, rough, metal, D, aniso),
  };
}

// ============================================================================ BRUSHED ALUMINIUM
/** Brushed/anodised aluminium: fine unidirectional abrasion, a few deeper drags, clean metal. */
export function buildBrushedAlu({ size: S, aniso }) {
  const D = Math.min(S, 512);
  const N = D * D;
  // Strongly anisotropic: many octaves in Y, almost none in X.
  const h = field(D);
  const rows = new Float32Array(D);
  for (let pass = 0; pass < 4; pass++) {
    const freq = 1 << pass;
    const amp = 0.5 / (pass + 1);
    for (let x = 0; x < D; x++) rows[x] = hash2f(x, pass, 990 + pass) * 2 - 1;
    for (let y = 0; y < D; y++) {
      const jitter = (hash2f(y, pass, 4400) - 0.5) * 2;
      for (let x = 0; x < D; x++) {
        const xi = (x + Math.round(jitter * freq)) & (D - 1);
        h[y * D + x] += rows[xi] * amp;
      }
    }
  }
  // Deeper drag scratches.
  const drags = streakField(D, { count: D, dir: 0, len: [0.2, 1.0], width: [0.5, 1.8], seed: 5, amp: 1 });
  const cloud = fbmField(D, { cells: 4, octaves: 3, seed: 3232 });
  for (let i = 0; i < N; i++) h[i] = h[i] * 0.9 - drags[i] * 0.5 + cloud[i] * 0.06;
  normaliseField(h, 0, 1);

  const [R, G, B] = rgbFields(D);
  const AL = hex(0xd2d6db);
  const AL_D = hex(0x878d94);
  for (let i = 0; i < N; i++) {
    const c = mixc(AL_D, AL, clamp01(h[i] * 1.6 - 0.28));
    R[i] = c[0];
    G[i] = c[1];
    B[i] = c[2];
  }

  const ao = aoFromHeight(h, D, 2, 0.8);
  const rough = field(D);
  const metal = field(D);
  for (let i = 0; i < N; i++) {
    // The abrasion is the material: roughness has to swing hard along the brush direction or
    // it just looks like flat chrome.
    rough[i] = clamp01(0.15 + (1 - h[i]) * 0.5 + clamp01(drags[i]) * 0.25);
    metal[i] = 1;
  }
  // Brushing runs across X, so the normal is nearly flat in that axis — that's the anisotropy.
  return {
    brushedAlu: bakeAlbedo(R, G, B, D, aniso),
    brushedAluNormal: bakeNormal(h, D, 0.5, aniso),
    brushedAluRough: bakeORM(ao, rough, metal, D, aniso),
  };
}

// ============================================================================ RUBBER SCUFF
/** Rubber transfer decal — barrier strikes, wall rubs, tyre marks on kerbs. RGBA, tileable. */
export function buildRubberScuff({ size: S, aniso }) {
  const D = Math.min(S, 256);
  const N = D * D;
  // A scuff is a *sparse* transfer of rubber, not a wash. Keep the streaks separated and
  // feathered — full coverage turns every barrier strike into a flat grey rectangle.
  const s = streakField(D, { count: Math.round(D * 0.35), dir: 0, len: [0.1, 0.55], width: [1, 4], seed: 77, amp: 1 });
  blurField(s, D, 1, 1);
  const n = fbmField(D, { cells: Math.max(8, D >> 4), octaves: 3, seed: 1717 });
  const out = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const a = clamp01(smoothstep(0.10, 0.55, s[i]) * (0.45 + clamp01(n[i] * 0.9 + 0.45) * 0.75));
    const j = i * 4;
    const v = 0.10 + clamp01(n[i] * 0.5 + 0.5) * 0.08;
    out[j] = v * 255;
    out[j + 1] = v * 0.98 * 255;
    out[j + 2] = v * 0.97 * 255;
    out[j + 3] = clamp01(a * 0.95) * 255;
  }
  const t = new THREE.DataTexture(out, D, D, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return { rubberScuff: t };
}

export { field, clamp01 };
