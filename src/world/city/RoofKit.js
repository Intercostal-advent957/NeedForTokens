import * as THREE from 'three';
import { KIND, col, tint } from './Geo.js';

/**
 * Rooftop and facade attachments. The roofline is what you actually read at distance, so this
 * is where the silhouette budget goes: plant rooms, condensers, water towers, masts, dishes,
 * fire escapes. Each helper also pushes any light fixtures it creates into `out.fixtures` /
 * `out.glows` so the light pool and the halo pass can find them later.
 */

export function acUnit(b, x, y, z, s, seed, mat) {
  const w = 1.5 * s;
  const h = 1.0 * s;
  const d = 1.2 * s;
  b.box(x, y + h * 0.5, z, w, h, d, { color: mat.metal, kind: KIND.PANEL, seed });
  b.box(x, y + h + 0.06, z, w * 0.82, 0.12, d * 0.82, {
    color: mat.dark,
    kind: KIND.METAL,
    seed,
    faces: 63 & ~8,
  });
  // fan guard
  b.disc(x, y + h + 0.14, z, Math.min(w, d) * 0.34, 8, 1, { color: mat.dark, kind: KIND.METAL, seed });
  // feet
  b.box(x, y + 0.06, z, w * 1.06, 0.12, 0.18, { color: mat.dark, kind: KIND.METAL, seed });
}

export function ductRun(b, x, y, z, len, dir, s, seed, mat) {
  const r = 0.34 * s;
  if (dir === 0) b.box(x, y + r, z, len, r * 2, r * 2, { color: mat.duct, kind: KIND.METAL, seed });
  else b.box(x, y + r, z, r * 2, r * 2, len, { color: mat.duct, kind: KIND.METAL, seed });
  b.box(x, y + r * 2 + 0.2, z, r * 1.4, 0.42, r * 1.4, { color: mat.duct, kind: KIND.METAL, seed });
}

export function stairBulkhead(b, x, y, z, w, d, h, seed, mat) {
  b.box(x, y + h * 0.5, z, w, h, d, { color: mat.wall, kind: KIND.CONCRETE, seed });
  b.box(x, y + h + 0.08, z, w + 0.3, 0.16, d + 0.3, {
    color: mat.trim,
    kind: KIND.SURFACE,
    seed,
    faces: 63 & ~8,
  });
  // door
  b.box(x, y + 1.05, z + d * 0.5 + 0.03, Math.min(1.0, w * 0.4), 2.1, 0.08, {
    color: mat.dark,
    kind: KIND.METAL,
    seed,
  });
}

export function waterTower(b, x, y, z, s, seed, mat, out) {
  const legH = 3.4 * s;
  const r = 1.9 * s;
  const bodyH = 3.6 * s;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.79;
    const lx = x + Math.cos(a) * r * 0.78;
    const lz = z + Math.sin(a) * r * 0.78;
    b.box(lx, y + legH * 0.5, lz, 0.2 * s, legH, 0.2 * s, {
      color: mat.dark,
      kind: KIND.METAL,
      seed,
    });
  }
  // cross bracing
  b.box(x, y + legH * 0.55, z, r * 1.7, 0.12, 0.12, { color: mat.dark, kind: KIND.METAL, seed });
  b.box(x, y + legH * 0.55, z, 0.12, 0.12, r * 1.7, { color: mat.dark, kind: KIND.METAL, seed });
  b.cylinder(x, y + legH, z, r, r, bodyH, 12, {
    color: mat.timber,
    kind: KIND.SURFACE,
    seed,
    capTop: false,
  });
  b.cylinder(x, y + legH + bodyH, z, r * 1.04, 0.14, r * 0.75, 12, {
    color: mat.dark,
    kind: KIND.METAL,
    seed,
  });
  // hoop bands
  for (let i = 1; i <= 3; i++)
    b.cylinder(x, y + legH + (bodyH * i) / 4, z, r * 1.03, r * 1.03, 0.1, 12, {
      color: mat.dark,
      kind: KIND.METAL,
      seed,
      capTop: false,
    });
  out?.glows?.push({ x, y: y + legH + bodyH + r * 0.8, z, size: 1.4, color: 0xff3020, night: 1 });
}

export function mast(b, x, y, z, h, seed, mat, out) {
  b.cylinder(x, y, z, 0.16, 0.06, h, 6, { color: mat.dark, kind: KIND.METAL, seed });
  for (let i = 1; i <= 3; i++) {
    const yy = y + (h * i) / 4;
    b.box(x, yy, z, 1.5 - i * 0.3, 0.07, 0.07, { color: mat.dark, kind: KIND.METAL, seed });
    b.box(x, yy, z, 0.07, 0.07, 1.5 - i * 0.3, { color: mat.dark, kind: KIND.METAL, seed });
  }
  // aviation warning lamp
  b.box(x, y + h + 0.16, z, 0.3, 0.3, 0.3, { color: tint(0xff2a1a, 1), kind: KIND.NEON, seed: 0.9 });
  out?.glows?.push({ x, y: y + h + 0.2, z, size: 2.6, color: 0xff2a1a, night: 0 });
}

export function satDish(b, x, y, z, s, seed, mat) {
  b.cylinder(x, y, z, 0.1 * s, 0.1 * s, 1.1 * s, 6, { color: mat.dark, kind: KIND.METAL, seed });
  b.disc(x, y + 1.1 * s, z, 0.75 * s, 10, 1, { color: mat.metal, kind: KIND.METAL, seed });
  b.box(x, y + 1.1 * s + 0.35 * s, z, 0.12 * s, 0.7 * s, 0.12 * s, {
    color: mat.dark,
    kind: KIND.METAL,
    seed,
  });
}

export function roofRailing(b, w, d, y, seed, mat) {
  const posts = 8;
  for (const side of [-1, 1]) {
    for (let i = 0; i <= posts; i++) {
      const x = -w * 0.5 + (w * i) / posts;
      b.box(x, y + 0.55, side * d * 0.5, 0.08, 1.1, 0.08, {
        color: mat.dark,
        kind: KIND.METAL,
        seed,
      });
    }
    // 90/70 mm rails, not 70/50 mm. These run the full roof width and sit on the roofline
    // against the sky, which is the highest-contrast place in the frame for a sub-pixel
    // specular band to flicker. See the aFeat note in Geo.js.
    b.box(0, y + 1.08, side * d * 0.5, w, 0.09, 0.09, { color: mat.dark, kind: KIND.METAL, seed });
    b.box(0, y + 0.62, side * d * 0.5, w, 0.07, 0.07, { color: mat.dark, kind: KIND.METAL, seed });
  }
}

/**
 * Zig-zag fire escape hung on a face plane at z = `off`, facing +Z.
 * Platforms, stringers, handrails and a drop ladder — about 40 boxes for 5 floors.
 */
export function fireEscape(b, span, y0, floors, floorH, off, seed, mat) {
  const w = Math.min(span * 0.44, 3.6);
  const depth = 1.35;
  const z = off + depth * 0.5;
  for (let f = 1; f <= floors; f++) {
    const y = y0 + f * floorH - floorH * 0.18;
    // platform
    b.box(0, y, z, w, 0.09, depth, { color: mat.dark, kind: KIND.METAL, seed });
    // rails — 80/70 mm, same reasoning as roofRailing above
    b.box(0, y + 0.98, off + depth, w, 0.08, 0.08, { color: mat.dark, kind: KIND.METAL, seed });
    b.box(0, y + 0.55, off + depth, w, 0.07, 0.07, { color: mat.dark, kind: KIND.METAL, seed });
    for (const sx of [-w * 0.5, w * 0.5]) {
      b.box(sx, y + 0.52, off + depth, 0.07, 1.05, 0.07, {
        color: mat.dark,
        kind: KIND.METAL,
        seed,
      });
      b.box(sx, y + 0.52, off + 0.1, 0.07, 1.05, 0.07, { color: mat.dark, kind: KIND.METAL, seed });
      b.box(sx, y + 0.98, off + depth * 0.5, 0.06, 0.06, depth, {
        color: mat.dark,
        kind: KIND.METAL,
        seed,
      });
    }
    // brackets into the wall
    b.box(-w * 0.35, y - 0.35, off + 0.4, 0.07, 0.7, 0.8, { color: mat.dark, kind: KIND.METAL, seed });
    b.box(w * 0.35, y - 0.35, off + 0.4, 0.07, 0.7, 0.8, { color: mat.dark, kind: KIND.METAL, seed });
    // stair flight down to the platform below, alternating sides
    if (f > 1) {
      const dir = f % 2 === 0 ? 1 : -1;
      const yA = y;
      const yB = y - floorH;
      const xA = dir * w * 0.28;
      const xB = -dir * w * 0.28;
      strut(b, xA, yA, z, xB, yB, z, 0.09, mat.dark, seed);
      strut(b, xA, yA + 0.95, z + 0.28, xB, yB + 0.95, z + 0.28, 0.06, mat.dark, seed);
    }
  }
  // drop ladder
  b.box(w * 0.3, y0 + floorH * 0.5, z, 0.07, floorH, 0.07, {
    color: mat.dark,
    kind: KIND.METAL,
    seed,
  });
  b.box(w * 0.3 + 0.5, y0 + floorH * 0.5, z, 0.07, floorH, 0.07, {
    color: mat.dark,
    kind: KIND.METAL,
    seed,
  });
}

/** A thin box stretched between two points — used for stair stringers and cable stays. */
const _sA = new THREE.Matrix4();
const _sB = new THREE.Matrix4();
export function strut(b, x0, y0, z0, x1, y1, z1, t, colr, seed) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 0.01;
  // Build along +Y then rotate — cheaper than a general basis for a single box.
  const pitch = Math.atan2(Math.hypot(dx, dz), dy);
  const yaw = Math.atan2(dx, dz);
  _sA.makeRotationY(yaw);
  _sB.makeRotationX(pitch);
  _sA.multiply(_sB);
  _sA.setPosition((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  b.push(_sA);
  b.box(0, 0, 0, t, len, t, { color: colr, kind: KIND.METAL, seed });
  b.pop();
}

export const ROOF_MAT = {
  metal: col(0x9aa0a6),
  dark: col(0x30343a),
  duct: col(0x8f959b),
  wall: col(0x8b8880),
  trim: col(0x63676c),
  timber: col(0x5a4436),
};
