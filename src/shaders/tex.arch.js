/**
 * Architecture texture generators: brick, facade, windows, graffiti, glass grime.
 * Owned by the MATERIALS lane.
 */

import * as THREE from 'three';
import {
  field, fbmField, worleyField, scatter, streakField, gritField, blurField,
  cloneField, mapField, normaliseField, aoFromHeight,
  bakeAlbedo, bakeNormal, bakeORM, bakeMask,
  clamp01, smoothstep, lerp, hash2i,
} from './fields.js';
import { hex, mixc, rgbFields, tintRGB, addRGB, chromaDrift } from './palette.js';

// ============================================================================ BRICK
/**
 * Running-bond brickwork, 8 courses per tile. Every brick gets its own colour, height offset and
 * wear, mortar is recessed and rough, and the whole wall carries efflorescence + soot gradients.
 * Per-brick variation is the entire game here — a uniform brick colour reads as wallpaper.
 */
export function buildBrick({ size: S, aniso }) {
  const D = Math.min(S, 1024);
  const N = D * D;
  const COURSES = 8;
  const PER_ROW = 4; // bricks across (so a brick is 2:1, correct for standard bond)

  const grime = fbmField(D, { cells: 3, octaves: 4, gain: 0.6, seed: 2211 });
  const fine = fbmField(D, { cells: Math.max(16, D >> 3), octaves: 3, seed: 6633, ridge: true });
  const mortarN = fbmField(D, { cells: Math.max(24, D >> 4), octaves: 3, seed: 8811 });
  const grit = gritField(D, 442, 1);
  const soot = streakField(D, { count: Math.round(D / 4), dir: 1, len: [0.1, 0.7], width: [2, 8], seed: 199, amp: 1 });
  blurField(soot, D, 2, 1);

  const h = field(D);
  const [R, G, B] = rgbFields(D);
  const MORTAR = hex(0x9d968a);
  const MORTAR_D = hex(0x6f6a61);
  const BRICKS = [hex(0x8c4530), hex(0x9a5238), hex(0x7a3a29), hex(0xa5624a), hex(0x6d3324), hex(0x94523c), hex(0x83422f), hex(0xb0705a)];
  const SOOT = hex(0x2a2521);
  const EFFLOR = hex(0xc9c4ba);

  const mortarW = 0.055; // fraction of a brick cell

  for (let y = 0; y < D; y++) {
    const cy = (y / D) * COURSES;
    const row = Math.floor(cy);
    const fy = cy - row;
    const offset = row % 2 ? 0.5 : 0;
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      const cx = (x / D) * PER_ROW + offset;
      const col = Math.floor(cx);
      const fx = cx - col;

      // Mortar joints with a slightly irregular edge from noise.
      const jn = mortarN[i] * 0.012;
      const dx = Math.min(fx, 1 - fx) + jn;
      const dy = Math.min(fy, 1 - fy) + jn;
      const mortarMask = 1 - smoothstep(mortarW * 0.6, mortarW * 1.5, Math.min(dx, dy * 2));

      const id = hash2i(col, row, 1717);
      const pick = BRICKS[id % BRICKS.length];
      const shade = 0.82 + ((id >>> 8) & 0xff) / 255 * 0.36;
      const proud = (((id >>> 16) & 0xff) / 255 - 0.5) * 0.09; // bricks aren't flush

      let c = [pick[0] * shade, pick[1] * shade, pick[2] * shade];
      // Surface texture inside the brick.
      c = mixc(c, [c[0] * 0.78, c[1] * 0.78, c[2] * 0.78], clamp01(fine[i] * 0.5 + 0.5) * 0.35);
      // Mortar.
      const mshade = clamp01(mortarN[i] * 0.5 + 0.5);
      const mc = mixc(MORTAR_D, MORTAR, mshade);
      c = mixc(c, mc, mortarMask);

      R[i] = c[0];
      G[i] = c[1];
      B[i] = c[2];
      h[i] = 0.6 + proud - mortarMask * 0.5 + fine[i] * 0.08 + grit[i] * 0.02;
    }
  }

  // Weathering passes.
  tintRGB(R, G, B, mapField(cloneField(grime), (v) => clamp01(v * 0.9 + 0.25) * 0.55), SOOT, 1);
  tintRGB(R, G, B, soot, SOOT, 0.4);
  const effl = field(D);
  for (let i = 0; i < N; i++) effl[i] = smoothstep(0.55, 0.85, -grime[i]) * clamp01(mortarN[i] * 0.5 + 0.5);
  tintRGB(R, G, B, effl, EFFLOR, 0.45);
  addRGB(R, G, B, grit, 0.02);
  chromaDrift(R, G, B, mapField(cloneField(grime), (v) => v * 0.5 + 0.5), 0.05);
  normaliseField(h, 0, 1);

  const ao = aoFromHeight(h, D, Math.max(2, D >> 8), 1.5);
  const rough = field(D);
  for (let i = 0; i < N; i++) rough[i] = clamp01(0.78 + fine[i] * 0.1 + clamp01(grime[i]) * 0.08);

  return {
    brickWall: bakeAlbedo(R, G, B, D, aniso),
    brickWallNormal: bakeNormal(h, D, 1.35, aniso),
    brickWallRough: bakeORM(ao, rough, null, D, aniso),
  };
}

// ============================================================================ FACADE
/**
 * Generic mid-rise commercial facade: 6 floors × 5 bays of window per tile, spandrel panels,
 * mullions, a concrete/stone frame, and ground-level variation. Designed to be tiled vertically
 * by the city lane. The matching `buildingWindows` emissive mask lines up bay-for-bay.
 */
const FACADE_FLOORS = 6;
const FACADE_BAYS = 5;

function facadeLayout(D) {
  // Per-texel masks: `win` = glazing, `mull` = the frame members crossing it, `span` = the
  // opaque spandrel panel under each window. `mull` must be a *thin line* — if it covers the
  // whole pane it silently zeroes the emissive map and the city never lights up at night.
  const win = field(D);
  const mull = field(D);
  const span = field(D);
  const HALF_W = 0.31; // window half-width as a fraction of the bay
  const TOP = 0.80;
  const BOT = 0.32;
  for (let y = 0; y < D; y++) {
    const fy = ((y / D) * FACADE_FLOORS) % 1;
    const wy = smoothstep(BOT, BOT + 0.012, fy) * smoothstep(TOP, TOP - 0.012, fy);
    // Spandrel: the opaque panel between the sill and the floor below.
    const sy = smoothstep(0.05, 0.08, fy) * smoothstep(BOT - 0.02, BOT - 0.06, fy);
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      const fx = ((x / D) * FACADE_BAYS) % 1;
      const dx = Math.abs(fx - 0.5);
      const wx = smoothstep(HALF_W, HALF_W - 0.012, dx);
      const w = wx * wy;
      win[i] = w;
      span[i] = sy * wx;
      // One vertical mullion up the centre of the pane, one horizontal transom across it.
      const mv = smoothstep(0.013, 0.005, dx);
      const mh = smoothstep(0.011, 0.004, Math.abs(fy - 0.52));
      mull[i] = clamp01(Math.max(mv, mh)) * w;
    }
  }
  return { win, mull, span };
}

export function buildFacade({ size: S, aniso }) {
  const D = Math.min(S, 1024);
  const N = D * D;
  const { win, mull, span } = facadeLayout(D);

  const conc = fbmField(D, { cells: 8, octaves: 4, gain: 0.55, seed: 3131 });
  const fine = fbmField(D, { cells: Math.max(16, D >> 3), octaves: 3, seed: 5151, ridge: true });
  const dirt = streakField(D, { count: Math.round(D / 3), dir: 1, len: [0.06, 0.4], width: [1.5, 5], seed: 91, amp: 1 });
  blurField(dirt, D, 1, 1);
  const grit = gritField(D, 626, 1);

  const h = field(D);
  const [R, G, B] = rgbFields(D);
  const STONE = hex(0x8a8781);
  const STONE_D = hex(0x64625d);
  const PANEL = hex(0x4b4f55);
  const MULL = hex(0x2e3236);
  const GLASS = hex(0x1a2530);

  for (let i = 0; i < N; i++) {
    const t = clamp01(conc[i] * 0.55 + 0.5);
    let c = mixc(STONE_D, STONE, t);
    c = mixc(c, [c[0] * 0.85, c[1] * 0.85, c[2] * 0.85], clamp01(fine[i] * 0.5 + 0.5) * 0.3);
    c = mixc(c, PANEL, span[i] * 0.9);
    c = mixc(c, GLASS, win[i] * 0.95);
    c = mixc(c, MULL, mull[i]);
    R[i] = c[0];
    G[i] = c[1];
    B[i] = c[2];
    h[i] = 0.62 - win[i] * 0.35 + mull[i] * 0.22 - span[i] * 0.08 + fine[i] * 0.05 + grit[i] * 0.015;
  }
  tintRGB(R, G, B, dirt, hex(0x3c3a36), 0.3);
  addRGB(R, G, B, grit, 0.015);
  chromaDrift(R, G, B, mapField(cloneField(conc), (v) => v * 0.5 + 0.5), 0.035);
  normaliseField(h, 0, 1);

  const ao = aoFromHeight(h, D, Math.max(2, D >> 8), 1.4);
  const rough = field(D);
  const metal = field(D);
  for (let i = 0; i < N; i++) {
    let r = 0.72 + fine[i] * 0.1 + clamp01(dirt[i]) * 0.12;
    r = lerp(r, 0.09, win[i]); // glass
    r = lerp(r, 0.35, mull[i]); // anodised aluminium
    r = lerp(r, 0.55, span[i] * 0.7);
    rough[i] = clamp01(r);
    metal[i] = clamp01(mull[i] * 0.85 + span[i] * 0.25);
  }

  return {
    buildingFacade: bakeAlbedo(R, G, B, D, aniso),
    buildingFacadeNormal: bakeNormal(h, D, 1.1, aniso),
    buildingFacadeRough: bakeORM(ao, rough, metal, D, aniso),
  };
}

/**
 * Emissive window map matching `buildingFacade` bay-for-bay: which panes are lit, how warm, and
 * the blinds/occupancy variation inside.
 *
 * Brightness lives in RGB, not alpha, and unlit panes are black — because three.js `emissiveMap`
 * multiplies the emissive colour by texel.rgb and ignores alpha entirely. Encoding intensity in
 * the alpha channel is the classic way to ship a night skyline where every window is equally lit.
 */
export function buildWindows({ size: S, aniso }) {
  const D = Math.min(S, 1024);
  const { win, mull } = facadeLayout(D);
  const inner = fbmField(D, { cells: Math.max(16, D >> 4), octaves: 3, seed: 8080 });
  const out = new Uint8Array(D * D * 4);

  // Warm tungsten through cool office fluorescent.
  const LIGHTS = [hex(0xffd9a0), hex(0xffe8c8), hex(0xd8e4ff), hex(0xfff2d8), hex(0xbfe0ff), hex(0xffc98a)];

  for (let y = 0; y < D; y++) {
    const floor = Math.floor((y / D) * FACADE_FLOORS);
    const fy = ((y / D) * FACADE_FLOORS) % 1;
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      const bay = Math.floor((x / D) * FACADE_BAYS);
      const id = hash2i(bay, floor, 5309);
      const lit = (id & 0xff) / 255 < 0.55 ? 1 : 0;
      const col = LIGHTS[(id >>> 8) % LIGHTS.length];
      const bright = 0.35 + ((id >>> 16) & 0xff) / 255 * 0.65;
      // Blinds: horizontal banding on some panes; partial-height on others.
      const hasBlind = ((id >>> 24) & 3) === 0;
      const blind = hasBlind ? 0.35 + 0.65 * (Math.sin(fy * 60) * 0.5 + 0.5) : 1;
      const occl = clamp01(0.55 + inner[i] * 0.8);
      const a = win[i] * (1 - mull[i]) * lit * bright * blind * occl;
      const j = i * 4;
      out[j] = clamp01(col[0] * a) * 255;
      out[j + 1] = clamp01(col[1] * a) * 255;
      out[j + 2] = clamp01(col[2] * a) * 255;
      out[j + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, D, D, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return { buildingWindows: t };
}

// ============================================================================ GRAFFITI
/**
 * Spray-can graffiti decal (RGBA, clamped). Built from stroked bezier tags with drips and
 * overspray — abstract rather than lettered, which reads better at speed and dodges the
 * uncanny-valley of procedurally faked letterforms.
 */
export function buildGraffiti({ size: S, aniso }) {
  const D = Math.min(S, 512);
  const c = document.createElement('canvas');
  c.width = c.height = D;
  const g = c.getContext('2d');
  g.clearRect(0, 0, D, D);

  const PAL = ['#ff2d55', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2', '#ff9f0a', '#f2f2f7'];
  let seed = 1234;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // Overspray haze first.
  for (let i = 0; i < 220; i++) {
    const col = PAL[(rnd() * PAL.length) | 0];
    g.globalAlpha = 0.02 + rnd() * 0.05;
    g.fillStyle = col;
    g.beginPath();
    g.arc(rnd() * D, rnd() * D, D * (0.02 + rnd() * 0.12), 0, 7);
    g.fill();
  }

  // Two or three overlapping tags.
  for (let t = 0; t < 3; t++) {
    const col = PAL[(rnd() * PAL.length) | 0];
    const dark = t === 0;
    g.strokeStyle = dark ? '#101014' : col;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.globalAlpha = 0.92;
    const baseY = D * (0.28 + t * 0.16);
    const strokes = 4 + ((rnd() * 4) | 0);
    for (let s = 0; s < strokes; s++) {
      g.lineWidth = D * (0.018 + rnd() * 0.05);
      g.beginPath();
      let x = D * (0.08 + rnd() * 0.15);
      let y = baseY + (rnd() - 0.5) * D * 0.12;
      g.moveTo(x, y);
      const segs = 3 + ((rnd() * 3) | 0);
      for (let k = 0; k < segs; k++) {
        const cx1 = x + D * (0.05 + rnd() * 0.14);
        const cy1 = y + (rnd() - 0.5) * D * 0.34;
        const cx2 = cx1 + D * (0.04 + rnd() * 0.12);
        const cy2 = y + (rnd() - 0.5) * D * 0.34;
        const nx = cx2 + D * (0.03 + rnd() * 0.1);
        const ny = baseY + (rnd() - 0.5) * D * 0.2;
        g.bezierCurveTo(cx1, cy1, cx2, cy2, nx, ny);
        x = nx;
        y = ny;
      }
      g.stroke();
      // Drips.
      if (rnd() < 0.5) {
        g.lineWidth = D * (0.004 + rnd() * 0.008);
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + (rnd() - 0.5) * 4, y + D * (0.05 + rnd() * 0.18));
        g.stroke();
      }
    }
    // Highlight pass on the last tag.
    if (t === 2) {
      g.globalAlpha = 0.6;
      g.strokeStyle = '#ffffff';
      g.lineWidth = D * 0.006;
      g.beginPath();
      g.moveTo(D * 0.15, baseY - D * 0.06);
      g.bezierCurveTo(D * 0.4, baseY - D * 0.16, D * 0.6, baseY + D * 0.1, D * 0.88, baseY - D * 0.04);
      g.stroke();
    }
  }
  g.globalAlpha = 1;

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return { graffiti: t };
}

// ============================================================================ GLASS DIRT
/**
 * Windscreen/window grime. RGB = grime colour, A = how much it obscures.
 * Wiper arcs sweep it clear, edges and corners accumulate, plus dried droplet rings and
 * a few smeared streaks. Used on car glass and building glass alike.
 */
export function buildGlassDirt({ size: S, aniso }) {
  const D = Math.min(S, 512);
  const N = D * D;
  const haze = fbmField(D, { cells: 4, octaves: 4, gain: 0.6, seed: 6262 });
  const fineD = fbmField(D, { cells: Math.max(16, D >> 3), octaves: 3, seed: 1212 });
  const smear = streakField(D, { count: Math.round(D / 4), dir: 0, len: [0.1, 0.6], width: [2, 7], seed: 424, amp: 1 });
  blurField(smear, D, 2, 1);

  // Dried droplet rings.
  const drops = field(D);
  scatter(drops, D, { cells: Math.round(D / 18), radius: [1.5, 6], aspect: 0.35, sharp: 0.5, amp: 1, seed: 838, density: 0.45 });
  const rings = field(D);
  for (let i = 0; i < N; i++) rings[i] = smoothstep(0.25, 0.45, drops[i]) * (1 - smoothstep(0.45, 0.7, drops[i])) * 1.6;

  const out = new Uint8Array(N * 4);
  const cx = D * 0.5;
  const cy = D * 1.05;
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      // Wiper arc: two overlapping swept bands where the glass is clean.
      const r = Math.hypot(x - cx, y - cy) / D;
      const arc = smoothstep(0.55, 0.62, r) + (1 - smoothstep(1.02, 1.08, r));
      const clean = clamp01(1 - clamp01(arc)) * 0.85;
      // Edge accumulation.
      const ex = Math.min(x, D - x) / D;
      const ey = Math.min(y, D - y) / D;
      const edge = 1 - smoothstep(0.0, 0.16, Math.min(ex, ey));
      let a = clamp01(haze[i] * 0.35 + 0.28) * 0.5;
      a += edge * 0.4;
      a += clamp01(smear[i]) * 0.35;
      a += clamp01(rings[i]) * 0.3;
      a += clamp01(fineD[i] * 0.5 + 0.5) * 0.12;
      a *= 1 - clean;
      const j = i * 4;
      const tone = 0.55 + clamp01(haze[i] * 0.5 + 0.5) * 0.35;
      out[j] = tone * 0.98 * 255;
      out[j + 1] = tone * 0.96 * 255;
      out[j + 2] = tone * 0.9 * 255;
      out[j + 3] = clamp01(a) * 255;
    }
  }
  const t = new THREE.DataTexture(out, D, D, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;

  // Companion normal so beading distorts reflections slightly.
  const h = field(D);
  for (let i = 0; i < N; i++) h[i] = 0.5 + rings[i] * 0.35 + fineD[i] * 0.05 + clamp01(smear[i]) * 0.1;
  normaliseField(h, 0, 1);
  return { glassDirt: t, glassDirtNormal: bakeNormal(h, D, 0.6, aniso) };
}

export { worleyField, bakeMask, blurField };
