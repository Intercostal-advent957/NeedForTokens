import * as THREE from 'three';
import { KIND, col, tint } from './Geo.js';
import { strut } from './RoofKit.js';

/**
 * Street furniture. Every builder works in local space with the road toward +Z and the base at
 * y = 0, then the sector merges it through a placement matrix — so a whole block of lamps,
 * signs, bins, benches and barriers ends up as one draw call.
 *
 * Builders return `{ fixtures, glows }` in local space: `fixtures` feed the point-light pool,
 * `glows` feed the additive halo pass.
 */

const DARK = col(0x24272b);
const STEEL = col(0x8b9298);
const PAINT = col(0x3f4348);

export function streetLight(b, R, o = {}) {
  const h = o.h ?? R.range(8.5, 11);
  const arm = o.arm ?? R.range(1.8, 3.0);
  const dir = o.dir ?? 1; // +1 leans toward +Z
  const c = o.color ?? (R.chance(0.72) ? 0xffd9a0 : 0xdfeaff);
  b.cylinder(0, 0, 0, 0.34, 0.26, 0.5, 8, { color: DARK, kind: KIND.CONCRETE, seed: 0.2 });
  b.cylinder(0, 0.5, 0, 0.19, 0.11, h, 8, { color: PAINT, kind: KIND.METAL, seed: 0.3 });
  // door hatch on the column
  b.box(0, 1.4, 0.2, 0.22, 0.75, 0.06, { color: DARK, kind: KIND.METAL, seed: 0.3 });
  // curved arm, approximated with three segments
  const segs = 3;
  let px = 0,
    py = 0.5 + h,
    pz = 0;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const nx2 = 0;
    const ny2 = 0.5 + h + Math.sin(t * 1.35) * 0.85;
    const nz2 = dir * arm * t;
    strut(b, px, py, pz, nx2, ny2, nz2, 0.15, PAINT, 0.3);
    px = nx2;
    py = ny2;
    pz = nz2;
  }
  // luminaire
  b.box(0, py - 0.16, pz + dir * 0.28, 0.42, 0.2, 1.15, { color: PAINT, kind: KIND.METAL, seed: 0.4 });
  b.box(0, py - 0.3, pz + dir * 0.28, 0.34, 0.1, 0.95, { color: tint(c, 1), kind: KIND.LAMP, seed: R() });
  return {
    fixtures: [{ x: 0, y: py - 0.4, z: pz + dir * 0.28, color: c, intensity: o.intensity ?? 620, dist: o.dist ?? 58 }],
    glows: [{ x: 0, y: py - 0.32, z: pz + dir * 0.28, size: R.range(3.6, 5.2), color: c }],
  };
}

export function twinStreetLight(b, R, o = {}) {
  const a = streetLight(b, R, { ...o, dir: 1 });
  const c = streetLight(b, R, { ...o, dir: -1 });
  return { fixtures: a.fixtures.concat(c.fixtures), glows: a.glows.concat(c.glows) };
}

export function trafficLight(b, R) {
  const h = R.range(4.6, 5.6);
  const arm = R.range(3.4, 5.5);
  b.cylinder(0, 0, 0, 0.36, 0.28, 0.35, 8, { color: DARK, kind: KIND.CONCRETE, seed: 0.2 });
  b.cylinder(0, 0.35, 0, 0.17, 0.13, h, 8, { color: DARK, kind: KIND.METAL, seed: 0.3 });
  b.box(0, h + 0.3, arm * 0.5, 0.15, 0.15, arm, { color: DARK, kind: KIND.METAL, seed: 0.3 });
  const glows = [];
  const head = (x, y, z) => {
    b.box(x, y, z, 0.44, 1.28, 0.4, { color: DARK, kind: KIND.METAL, seed: 0.4 });
    const state = R.int(0, 2);
    const colors = [0xff2a1a, 0xffb020, 0x2aff62];
    for (let i = 0; i < 3; i++) {
      const on = i === state;
      b.box(x, y + 0.42 - i * 0.42, z + 0.22, 0.26, 0.26, 0.08, {
        color: on ? tint(colors[i], 1) : tint(colors[i], 0.06),
        kind: on ? KIND.NEON : KIND.SURFACE,
        seed: 0.5,
      });
      b.box(x, y + 0.56 - i * 0.42, z + 0.3, 0.3, 0.06, 0.18, { color: DARK, kind: KIND.METAL, seed: 0.3 });
      if (on) glows.push({ x, y: y + 0.42 - i * 0.42, z: z + 0.3, size: 1.5, color: colors[i] });
    }
  };
  head(0, h - 0.6, 0.32);
  head(0, h - 0.2, arm - 0.4);
  // pedestrian signal
  b.box(0, 2.6, 0.3, 0.34, 0.6, 0.28, { color: DARK, kind: KIND.METAL, seed: 0.4 });
  b.box(0, 2.6, 0.46, 0.22, 0.4, 0.05, { color: tint(0xff5a2a, 1), kind: KIND.NEON, seed: 0.5 });
  return { fixtures: [], glows };
}

export function roadSign(b, R) {
  const kind = R.int(0, 3);
  const h = R.range(2.2, 3.1);
  b.cylinder(0, 0, 0, 0.09, 0.08, h, 6, { color: STEEL, kind: KIND.METAL, seed: 0.3 });
  if (kind === 0) {
    // rectangular direction board
    const w = R.range(1.5, 2.6);
    b.box(0, h + 0.5, 0.06, w, 1.0, 0.09, { color: col(0x1d5a3a), kind: KIND.SURFACE, seed: 0.4 });
    b.box(0, h + 0.5, 0.115, w - 0.16, 0.84, 0.02, { color: col(0x2a7a52), kind: KIND.SURFACE, seed: 0.4 });
    for (let i = 0; i < 3; i++)
      b.box(-w * 0.22 + i * 0.36, h + 0.5, 0.13, 0.22, 0.12, 0.02, {
        color: tint(0xf2f5f8, 1),
        kind: KIND.SURFACE,
        seed: 0.4,
      });
  } else if (kind === 1) {
    // speed roundel
    b.disc(0, h + 0.42, 0.07, 0.44, 12, 1, { color: tint(0xf5f5f2, 1), kind: KIND.SURFACE, seed: 0.4 });
    b.push(_rotX());
    b.pop();
    b.box(0, h + 0.42, 0.05, 0.9, 0.9, 0.07, { color: tint(0xc02020, 1), kind: KIND.SURFACE, seed: 0.4 });
    b.box(0, h + 0.42, 0.1, 0.66, 0.66, 0.03, { color: tint(0xf5f5f2, 1), kind: KIND.SURFACE, seed: 0.4 });
    b.box(0, h + 0.42, 0.13, 0.34, 0.1, 0.02, { color: col(0x101010), kind: KIND.SURFACE, seed: 0.4 });
  } else if (kind === 2) {
    // warning diamond
    b.box(0, h + 0.4, 0.06, 0.78, 0.78, 0.08, { color: tint(0xf2c020, 1), kind: KIND.SURFACE, seed: 0.4 });
    b.box(0, h + 0.4, 0.11, 0.58, 0.58, 0.02, { color: col(0x151515), kind: KIND.SURFACE, seed: 0.4 });
  } else {
    // chevron / arrow board on a low frame
    b.box(0, h * 0.5 + 0.35, 0.06, 2.1, 0.62, 0.09, { color: col(0x171a1d), kind: KIND.SURFACE, seed: 0.4 });
    for (let i = 0; i < 4; i++)
      b.box(-0.72 + i * 0.48, h * 0.5 + 0.35, 0.12, 0.3, 0.42, 0.02, {
        color: tint(0xffe14a, 1),
        kind: KIND.LAMP,
        seed: 0.4 + i * 0.1,
      });
  }
  return { fixtures: [], glows: [] };
}

export function bollard(b, R) {
  const h = R.range(0.85, 1.05);
  b.cylinder(0, 0, 0, 0.13, 0.11, h, 8, { color: R.chance(0.5) ? col(0x2b2f33) : col(0x8b9298), kind: KIND.METAL, seed: 0.3 });
  b.cylinder(0, h, 0, 0.13, 0.09, 0.08, 8, { color: DARK, kind: KIND.METAL, seed: 0.3 });
  b.box(0, h - 0.14, 0, 0.28, 0.09, 0.28, { color: tint(0xf0f0f0, 1), kind: KIND.SURFACE, seed: 0.3 });
  return null;
}

export function bin(b, R) {
  const h = R.range(0.95, 1.15);
  b.box(0, h * 0.5, 0, 0.62, h, 0.5, { color: col(R.pick([0x2f3a33, 0x39332f, 0x2c3038])), kind: KIND.PANEL, seed: R() });
  b.box(0, h + 0.05, 0, 0.7, 0.1, 0.58, { color: DARK, kind: KIND.METAL, seed: 0.3 });
  b.box(0, h + 0.02, 0.02, 0.34, 0.16, 0.3, { color: col(0x0a0b0c), kind: KIND.SURFACE, seed: 0.3 });
  b.box(0, h * 0.55, 0.26, 0.36, 0.5, 0.03, { color: col(0x7a8188), kind: KIND.METAL, seed: 0.3 });
  return null;
}

export function bench(b, R) {
  const w = R.range(1.7, 2.3);
  const timber = col(R.pick([0x6b4c31, 0x5a4432, 0x7a5a3c]));
  for (const z of [-0.19, 0.0, 0.19])
    b.box(0, 0.44, z, w, 0.07, 0.16, { color: timber, kind: KIND.SURFACE, seed: R() });
  for (let i = 0; i < 3; i++)
    b.box(0, 0.62 + i * 0.16, -0.26, w, 0.06, 0.12, { color: timber, kind: KIND.SURFACE, seed: R() });
  for (const x of [-w * 0.42, w * 0.42]) {
    b.box(x, 0.21, 0, 0.09, 0.42, 0.52, { color: DARK, kind: KIND.METAL, seed: 0.3 });
    b.box(x, 0.62, -0.26, 0.08, 0.46, 0.1, { color: DARK, kind: KIND.METAL, seed: 0.3 });
  }
  return null;
}

export function hydrant(b, R) {
  const c = col(R.pick([0xb02a1e, 0xc9b21e, 0x9aa0a6]));
  b.cylinder(0, 0, 0, 0.2, 0.17, 0.62, 8, { color: c, kind: KIND.METAL, seed: R() });
  b.cylinder(0, 0.62, 0, 0.19, 0.13, 0.16, 8, { color: c, kind: KIND.METAL, seed: 0.4 });
  b.cylinder(0, 0.78, 0, 0.08, 0.07, 0.12, 6, { color: c, kind: KIND.METAL, seed: 0.4 });
  b.box(0.2, 0.42, 0, 0.16, 0.16, 0.16, { color: c, kind: KIND.METAL, seed: 0.4 });
  b.box(-0.2, 0.42, 0, 0.16, 0.16, 0.16, { color: c, kind: KIND.METAL, seed: 0.4 });
  return null;
}

export function drainCover(b, R) {
  b.box(0, 0.015, 0, 0.72, 0.03, 0.52, { color: col(0x4a4b4d), kind: KIND.METAL, seed: R() });
  for (let i = 0; i < 5; i++)
    b.box(-0.26 + i * 0.13, 0.032, 0, 0.06, 0.02, 0.4, { color: col(0x1b1c1e), kind: KIND.SURFACE, seed: 0.3 });
  return null;
}

export function utilityPole(b, R) {
  const h = R.range(9, 12.5);
  b.cylinder(0, -0.2, 0, 0.24, 0.15, h, 7, { color: col(0x4d3a2b), kind: KIND.SURFACE, seed: R() });
  for (let i = 0; i < 2; i++) {
    const y = h - 0.7 - i * 1.15;
    b.box(0, y, 0, 0.12, 0.14, 2.6, { color: col(0x4d3a2b), kind: KIND.SURFACE, seed: 0.4 });
    for (const z of [-1.05, 0, 1.05])
      b.cylinder(0, y + 0.14, z, 0.07, 0.05, 0.2, 6, { color: col(0x2c3a3a), kind: KIND.METAL, seed: 0.3 });
  }
  // transformer can
  if (R.chance(0.35)) b.cylinder(0.35, h - 3.4, 0, 0.42, 0.42, 1.1, 8, { color: col(0x6b6f73), kind: KIND.METAL, seed: 0.4 });
  return { top: h - 0.56, glows: [], fixtures: [] };
}

/** Catenary between two pole tops, in *sector* space. `sag` in metres. */
export function catenary(b, a, c, sag, strands = 3) {
  const segs = 6;
  for (let s = 0; s < strands; s++) {
    const off = (s - (strands - 1) * 0.5) * 0.5;
    let px = 0,
      py = 0,
      pz = 0;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const x = a.x + (c.x - a.x) * t;
      const z = a.z + (c.z - a.z) * t;
      const y = a.y + (c.y - a.y) * t - Math.sin(t * Math.PI) * sag;
      // perpendicular offset so the strands don't overlap
      const dx = c.x - a.x;
      const dz = c.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      const ox = (-dz / l) * off;
      const oz = (dx / l) * off;
      if (i > 0) strut(b, px, py, pz, x + ox, y, z + oz, 0.055, col(0x15171a), 0.2);
      px = x + ox;
      py = y;
      pz = z + oz;
    }
  }
}

export function pedBarrier(b, R, o = {}) {
  const len = o.len ?? 2.4;
  const c = R.chance(0.5) ? col(0x9aa0a6) : col(0x2f3338);
  b.box(0, 0.55, 0, len, 0.07, 0.07, { color: c, kind: KIND.METAL, seed: 0.3 });
  b.box(0, 1.05, 0, len, 0.08, 0.08, { color: c, kind: KIND.METAL, seed: 0.3 });
  for (const x of [-len * 0.5, len * 0.5]) b.box(x, 0.55, 0, 0.07, 1.1, 0.07, { color: c, kind: KIND.METAL, seed: 0.3 });
  for (let i = 1; i < 5; i++) b.box(-len * 0.5 + (len * i) / 5, 0.8, 0, 0.045, 0.5, 0.045, { color: c, kind: KIND.METAL, seed: 0.3 });
  return null;
}

export function jerseyBarrier(b, R) {
  const c = R.chance(0.4) ? col(0xd8d4c8) : col(0x9a9790);
  b.box(0, 0.2, 0, 2.4, 0.4, 0.62, { color: c, kind: KIND.CONCRETE, seed: R() });
  b.box(0, 0.62, 0, 2.4, 0.5, 0.36, { color: c, kind: KIND.CONCRETE, seed: R() });
  b.box(0, 0.88, 0, 2.4, 0.1, 0.3, { color: c, kind: KIND.CONCRETE, seed: R() });
  if (R.chance(0.5)) b.box(0, 0.72, 0.19, 0.5, 0.24, 0.02, { color: tint(0xff8a1e, 1), kind: KIND.SURFACE, seed: 0.4 });
  return null;
}

export function hoarding(b, R, o = {}) {
  const len = o.len ?? 8;
  const h = R.range(2.2, 2.9);
  const c = col(R.pick([0x2e5a8a, 0x1f6b4a, 0x8a4a1e, 0x4a4a52]));
  b.box(0, h * 0.5, 0, len, h, 0.14, { color: c, kind: KIND.PANEL, seed: R() });
  b.box(0, h + 0.07, 0, len + 0.2, 0.14, 0.24, { color: col(0x3a3d41), kind: KIND.METAL, seed: 0.3 });
  const posts = Math.max(2, Math.round(len / 2.4));
  for (let i = 0; i <= posts; i++)
    b.box(-len * 0.5 + (len * i) / posts, h * 0.5, -0.16, 0.12, h, 0.18, { color: col(0x3a3d41), kind: KIND.METAL, seed: 0.3 });
  // hazard stripe at the base
  b.box(0, 0.18, 0.08, len, 0.36, 0.03, { color: tint(0xf0a81e, 1), kind: KIND.SURFACE, seed: 0.5 });
  return null;
}

export function planter(b, R) {
  const w = R.range(1.2, 2.2);
  b.box(0, 0.32, 0, w, 0.64, 0.9, { color: col(R.pick([0x8b8880, 0x6e6a63, 0x9d9a92])), kind: KIND.CONCRETE, seed: R() });
  b.box(0, 0.66, 0, w - 0.14, 0.06, 0.76, { color: col(0x2a2318), kind: KIND.SURFACE, seed: 0.4 });
  return null;
}

export function busShelter(b, R) {
  const w = R.range(4.2, 6.0);
  const h = 2.6;
  const glass = col(0x16202a);
  b.box(0, h + 0.08, 0, w, 0.16, 1.7, { color: col(0x3a3f45), kind: KIND.METAL, seed: 0.3 });
  b.box(0, h * 0.55, -0.78, w, h * 1.1, 0.06, { color: glass, kind: KIND.DARKGLASS, seed: R() });
  for (const x of [-w * 0.5, w * 0.5]) {
    b.box(x, h * 0.5, 0, 0.12, h, 1.6, { color: col(0x3a3f45), kind: KIND.METAL, seed: 0.3 });
    b.box(x, h * 0.55, -0.4, 0.05, h * 1.05, 0.75, { color: glass, kind: KIND.DARKGLASS, seed: R() });
  }
  b.box(0, h - 0.15, 0, w - 0.6, 0.12, 1.2, { color: tint(0xeaf2ff, 1), kind: KIND.LAMP, seed: 0.6 });
  b.box(0, 0.46, -0.62, w * 0.7, 0.08, 0.4, { color: col(0x4a4438), kind: KIND.SURFACE, seed: 0.3 });
  return {
    fixtures: [{ x: 0, y: h - 0.3, z: 0, color: 0xdfe9ff, intensity: 110, dist: 20 }],
    glows: [{ x: 0, y: h - 0.25, z: 0, size: 4.5, color: 0xdfe9ff }],
  };
}

export function junctionBox(b, R) {
  const h = R.range(1.1, 1.6);
  b.box(0, h * 0.5, 0, R.range(0.5, 0.9), h, R.range(0.3, 0.5), { color: col(R.pick([0x5a6068, 0x3f4c44, 0x6b6560])), kind: KIND.PANEL, seed: R() });
  b.box(0, h + 0.04, 0, 0.62, 0.08, 0.42, { color: DARK, kind: KIND.METAL, seed: 0.3 });
  return null;
}

export function trafficCone(b, R) {
  b.box(0, 0.02, 0, 0.34, 0.04, 0.34, { color: col(0x22242a), kind: KIND.SURFACE, seed: 0.3 });
  b.cylinder(0, 0.04, 0, 0.15, 0.04, 0.62, 6, { color: tint(0xf05a1e, 1), kind: KIND.SURFACE, seed: R() });
  b.cylinder(0, 0.32, 0, 0.1, 0.09, 0.12, 6, { color: tint(0xf2f2f2, 1), kind: KIND.SURFACE, seed: 0.4 });
  return null;
}

export function vendingRow(b, R) {
  const n = R.int(1, 3);
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) * 0.5) * 1.05;
    b.box(x, 0.9, 0, 1.0, 1.8, 0.72, { color: col(R.pick([0x22303f, 0x3a1f28, 0x1f3a2c])), kind: KIND.PANEL, seed: R() });
    b.box(x, 1.06, 0.37, 0.78, 1.24, 0.05, { color: tint(R.pick([0x7ad8ff, 0xffd27a, 0xff7a9c]), 1), kind: KIND.LAMP, seed: R() });
    b.box(x, 1.82, 0, 1.06, 0.08, 0.78, { color: DARK, kind: KIND.METAL, seed: 0.3 });
  }
  return { fixtures: [], glows: [{ x: 0, y: 1.1, z: 0.5, size: 2.6, color: 0xffd9b0 }] };
}

export function kerbRamp(b, R) {
  b.box(0, 0.06, 0, 1.8, 0.12, 1.1, { color: col(0xa8a49a), kind: KIND.CONCRETE, seed: R() });
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 3; j++)
      b.box(-0.6 + i * 0.4, 0.14, -0.3 + j * 0.3, 0.12, 0.04, 0.12, { color: col(0xb8b4aa), kind: KIND.SURFACE, seed: 0.3 });
  return null;
}

const _rx = new THREE.Matrix4();
function _rotX() {
  return _rx.identity();
}

export const PROPS = {
  streetLight,
  twinStreetLight,
  trafficLight,
  roadSign,
  bollard,
  bin,
  bench,
  hydrant,
  drainCover,
  utilityPole,
  pedBarrier,
  jerseyBarrier,
  hoarding,
  planter,
  busShelter,
  junctionBox,
  trafficCone,
  vendingRow,
  kerbRamp,
};
