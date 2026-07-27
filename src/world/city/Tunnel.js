import * as THREE from 'three';
import { GeoBuilder, KIND, col, tint } from './Geo.js';

/**
 * The underpass. QA shot 12 frames NOS inside a tunnel, so this stretch is placed by geometry
 * rather than by agreement: pick a range of `t` on the existing centreline, follow it, and box
 * it in. Tiled walls, a dado band, pilasters, expansion joints, a cable tray, ceiling light
 * strips and two daylight slots.
 *
 * Enclosed emissive geometry plus a handful of pooled point lights is the cheapest big win in
 * the whole lane — bounce light on a car roof reads as expensive rendering.
 */

export const TUNNEL_T0 = 0.5185;
export const TUNNEL_T1 = 0.6280;

// The bore is sized off the road itself so it never swallows the car or clips the barriers.
let HALF_W = 15.4; // inner face of the wall from the centreline
const HEIGHT = 8.2; // road to ceiling
const WALK = 1.45; // service walkway width

export function buildTunnel(track, chunks = 4) {
  const out = { meshes: [], fixtures: [], glows: [], t0: TUNNEL_T0, t1: TUNNEL_T1 };
  const span = TUNNEL_T1 - TUNNEL_T0;
  const lengthM = span * track.length;
  const steps = Math.max(48, Math.round(lengthM / 3.0));
  let wMax = 0;
  for (let i = 0; i <= 24; i++) wMax = Math.max(wMax, track.widthAt(TUNNEL_T0 + (span * i) / 24));
  HALF_W = wMax * 1.42 + 5.0;
  const perChunk = Math.ceil(steps / chunks);

  const wallCol = col(0xd8d4cc);
  const dadoCol = col(0x2c3238);
  const ribCol = col(0x9a978f);
  const ceilCol = col(0x54534f);
  const kerbCol = col(0x9a968d);
  const jointCol = col(0x2a2b2d);

  const frames = [];
  for (let i = 0; i <= steps; i++) {
    const t = TUNNEL_T0 + (span * i) / steps;
    const p = track.pointAt(t);
    const tan = track.tangentAt(t);
    const right = new THREE.Vector3().crossVectors(tan, UP).normalize();
    frames.push({ t, p, tan, right, s: (i / steps) * lengthM });
  }

  for (let c = 0; c < chunks; c++) {
    const i0 = c * perChunk;
    const i1 = Math.min(steps, i0 + perChunk);
    if (i1 <= i0) continue;
    const b = new GeoBuilder();

    for (let i = i0; i < i1; i++) {
      const a = frames[i];
      const d = frames[i + 1];
      const seg = a.s;
      const segLen = d.s - a.s;

      for (const side of [-1, 1]) {
        const wallX = HALF_W * side;
        const A = pt(a, wallX, 0);
        const B = pt(d, wallX, 0);
        // --- walkway kerb
        const Ai = pt(a, wallX - WALK * side, 0);
        const Bi = pt(d, wallX - WALK * side, 0);
        quadY(b, Ai, Bi, A, B, 0.22, kerbCol, KIND.TUNNEL, seg, side);

        // --- dado band (dark, splash zone)
        wallQuad(b, A, B, 0.22, 1.35, dadoCol, KIND.TILE, seg, side, 0.22);
        // --- main tiled wall
        wallQuad(b, A, B, 1.35, HEIGHT - 0.9, wallCol, KIND.TILE, seg, side, 1.35);
        // --- upper fascia
        wallQuad(b, A, B, HEIGHT - 0.9, HEIGHT, ribCol, KIND.TUNNEL, seg, side, 0);

        // --- expansion joint every ~16 m
        if (Math.floor(a.s / 16) !== Math.floor(d.s / 16))
          wallQuad(b, A, B, 0.22, HEIGHT, jointCol, KIND.SURFACE, seg, side, 0, 0.06);

        // --- pilaster every ~8 m
        if (Math.floor(a.s / 8) !== Math.floor(d.s / 8)) {
          const P = pt(a, wallX - 0.16 * side, 0);
          boxAt(b, P, a, 0.34, HEIGHT - 0.2, 0.9, ribCol, KIND.TUNNEL, seg);
        }

        // --- cable tray
        const T = pt(a, wallX - 0.28 * side, HEIGHT - 1.55);
        const T2 = pt(d, wallX - 0.28 * side, HEIGHT - 1.55);
        tube(b, T, T2, 0.34, 0.22, col(0x4a4d52), KIND.METAL, seg);

        // --- wall-washer light strip, alternating sides
        if (Math.floor(a.s / 6) !== Math.floor(d.s / 6)) {
          const L = pt(a, wallX - 0.34 * side, HEIGHT - 2.5);
          boxAt(b, L, a, 0.16, 0.3, 3.0, tint(0xfff0d2, 1), KIND.LAMP, seg);
          out.glows.push({ x: L.x, y: L.y, z: L.z, size: 2.4, color: 0xffe8c0 });
          if (Math.floor(a.s / 24) !== Math.floor(d.s / 24)) {
            const L2 = pt(a, wallX - 3.2 * side, 3.0);
            out.fixtures.push({ x: L2.x, y: L2.y, z: L2.z, color: 0xdfe9ff, intensity: 70, dist: 24, tunnel: true });
          }
        }
      }

      // --- ceiling
      const CL = pt(a, -HALF_W, HEIGHT);
      const CR = pt(a, HALF_W, HEIGHT);
      const DL = pt(d, -HALF_W, HEIGHT);
      const DR = pt(d, HALF_W, HEIGHT);
      const slot = isSlot(a.s, lengthM);
      if (!slot) {
        quadDown(b, CL, CR, DL, DR, ceilCol, KIND.TUNNEL, seg);
        // structural rib
        if (Math.floor(a.s / 8) !== Math.floor(d.s / 8)) {
          const RL = pt(a, -HALF_W, HEIGHT - 0.3);
          const RR = pt(a, HALF_W, HEIGHT - 0.3);
          crossBox(b, RL, RR, a, 0.6, 0.32, ribCol, KIND.TUNNEL, seg);
        }
      } else {
        // daylight slot — open to the sky with a low upstand each side
        for (const side of [-1, 1]) {
          const S = pt(a, side * 5.6, HEIGHT);
          boxAt(b, S, a, 0.5, 1.1, segLen + 0.1, ribCol, KIND.CONCRETE, seg);
        }
        const OL = pt(a, -HALF_W, HEIGHT);
        const OM = pt(a, -5.6, HEIGHT);
        const DL2 = pt(d, -HALF_W, HEIGHT);
        const DM = pt(d, -5.6, HEIGHT);
        quadDown(b, OL, OM, DL2, DM, ceilCol, KIND.TUNNEL, seg);
        const OR = pt(a, 5.6, HEIGHT);
        const OR2 = pt(a, HALF_W, HEIGHT);
        const DR1 = pt(d, 5.6, HEIGHT);
        const DR2 = pt(d, HALF_W, HEIGHT);
        quadDown(b, OR, OR2, DR1, DR2, ceilCol, KIND.TUNNEL, seg);
      }

      // --- ceiling luminaire every ~7 m, plus a continuous throat line down the crown
      if (!slot) {
        const C = pt(a, 0, HEIGHT - 0.12);
        boxAt(b, C, a, 0.55, 0.1, segLen + 0.05, tint(0xd8d4c8, 1), KIND.SURFACE, seg);
      }
      if (!slot && Math.floor(a.s / 7) !== Math.floor(d.s / 7)) {
        const M = pt(a, 0, HEIGHT - 0.28);
        crossBox(b, pt(a, -4.2, HEIGHT - 0.28), pt(a, 4.2, HEIGHT - 0.28), a, 0.6, 0.2, tint(0xfff4dc, 1), KIND.LAMP, seg);
        out.fixtures.push({ x: M.x, y: M.y - 3.0, z: M.z, color: 0xffeccb, intensity: 130, dist: 34, tunnel: true });
        out.glows.push({ x: M.x, y: M.y - 0.1, z: M.z, size: 4.0, color: 0xffeccb });
      }
    }

    if (!b.isEmpty) out.meshes.push(b.geometry(`tunnel-${c}`));
  }

  // ---------------- portals
  const portal = new GeoBuilder();
  for (const [f, dir] of [
    [frames[0], -1],
    [frames[steps], 1],
  ]) {
    const w = HALF_W + 4.5;
    const h = HEIGHT + 3.2;
    // headwall
    for (const side of [-1, 1]) {
      const P = pt(f, side * (HALF_W + 2.2), 0);
      boxAt(portal, P, f, 4.6, h, 3.0, col(0x8f8c85), KIND.TUNNEL, 0);
    }
    const Ctop = pt(f, 0, HEIGHT + 1.6);
    crossBox(portal, pt(f, -w, HEIGHT + 1.6), pt(f, w, HEIGHT + 1.6), f, 3.2, 3.2, col(0x8f8c85), KIND.CONCRETE, 0);
    // hazard chevrons on the portal edge
    for (let i = 0; i < 7; i++) {
      const y = 1.0 + i * 0.95;
      for (const side of [-1, 1]) {
        const P = pt(f, side * (HALF_W + 0.15), y);
        boxAt(portal, P, f, 0.16, 0.55, 3.1 + dir * 0.05, i % 2 ? tint(0xf0a81e, 1) : col(0x1a1a1a), KIND.SURFACE, 0);
      }
    }
    // height-limit gantry lamps
    for (let i = -2; i <= 2; i++) {
      const P = pt(f, i * 6.2, HEIGHT + 2.4);
      boxAt(portal, P, f, 0.9, 0.26, 0.3, tint(0xffd24a, 1), KIND.NEON, 0);
      out.glows.push({ x: P.x, y: P.y, z: P.z, size: 2.4, color: 0xffd24a });
    }
    void Ctop;
  }
  out.meshes.push(portal.geometry('tunnel-portals'));

  out.frames = frames;
  out.lengthM = lengthM;
  return out;
}

/** Is this arc-length inside one of the two daylight slots? */
function isSlot(s, len) {
  const a = len * 0.34;
  const bq = len * 0.66;
  return (s > a && s < a + 5) || (s > bq && s < bq + 5);
}

const UP = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();

/** Point at (lateral, height) on a frame. */
function pt(f, lat, h) {
  return {
    x: f.p.x + f.right.x * lat,
    y: f.p.y + h,
    z: f.p.z + f.right.z * lat,
  };
}

/** Vertical wall quad between two frame points, facing inward (toward the centreline). */
function wallQuad(b, A, B, y0, y1, colr, kind, s, side, vBase = 0, push = 0) {
  const nx = -side * dirX(A, B);
  const ox = side * push * dirX(A, B);
  const oz = side * push * dirZ(A, B);
  const p = [
    [A.x - ox, A.y + y0, A.z - oz],
    [B.x - ox, B.y + y0, B.z - oz],
    [B.x - ox, B.y + y1, B.z - oz],
    [A.x - ox, A.y + y1, A.z - oz],
  ];
  const len = Math.hypot(B.x - A.x, B.z - A.z);
  emit(b, side > 0 ? [p[1], p[0], p[3], p[2]] : p, colr, kind, s, len, y1 - y0, s, vBase);
  void nx;
}

/** Horizontal top surface of the walkway. */
function quadY(b, Ai, Bi, A, B, y, colr, kind, s, side) {
  const p =
    side > 0
      ? [
          [Ai.x, Ai.y + y, Ai.z],
          [A.x, A.y + y, A.z],
          [B.x, B.y + y, B.z],
          [Bi.x, Bi.y + y, Bi.z],
        ]
      : [
          [A.x, A.y + y, A.z],
          [Ai.x, Ai.y + y, Ai.z],
          [Bi.x, Bi.y + y, Bi.z],
          [B.x, B.y + y, B.z],
        ];
  const len = Math.hypot(B.x - A.x, B.z - A.z);
  emit(b, p, colr, kind, s, WALK, len, s, 0);
  // kerb face — must look back toward the centreline
  const f =
    side > 0
      ? [
          [Bi.x, Bi.y, Bi.z],
          [Ai.x, Ai.y, Ai.z],
          [Ai.x, Ai.y + y, Ai.z],
          [Bi.x, Bi.y + y, Bi.z],
        ]
      : [
          [Ai.x, Ai.y, Ai.z],
          [Bi.x, Bi.y, Bi.z],
          [Bi.x, Bi.y + y, Bi.z],
          [Ai.x, Ai.y + y, Ai.z],
        ];
  emit(b, f, colr, kind, s, len, y, s, 0);
}

/** Ceiling quad facing down. */
function quadDown(b, CL, CR, DL, DR, colr, kind, s) {
  emit(
    b,
    [
      [CR.x, CR.y, CR.z],
      [CL.x, CL.y, CL.z],
      [DL.x, DL.y, DL.z],
      [DR.x, DR.y, DR.z],
    ],
    colr,
    kind,
    s,
    Math.hypot(CR.x - CL.x, CR.z - CL.z),
    Math.hypot(DL.x - CL.x, DL.z - CL.z),
    s,
    0
  );
}

/** Axis-aligned-ish box placed on a frame, oriented along the tangent. */
function boxAt(b, P, f, w, h, len, colr, kind, s) {
  const m = frameMatrix(f, P);
  b.push(m);
  b.box(0, h * 0.5, 0, w, h, len, { color: colr, kind, seed: (s * 0.017) % 1 });
  b.pop();
}

/** Box spanning between two lateral points (a transverse rib / luminaire). */
function crossBox(b, A, B, f, thick, h, colr, kind, s) {
  const cx = (A.x + B.x) * 0.5;
  const cy = (A.y + B.y) * 0.5;
  const cz = (A.z + B.z) * 0.5;
  const w = Math.hypot(B.x - A.x, B.z - A.z);
  const m = frameMatrix(f, { x: cx, y: cy, z: cz });
  b.push(m);
  b.box(0, 0, 0, w, h, thick, { color: colr, kind, seed: (s * 0.021) % 1 });
  b.pop();
}

function tube(b, A, B, w, h, colr, kind, s) {
  const cx = (A.x + B.x) * 0.5;
  const cy = (A.y + B.y) * 0.5;
  const cz = (A.z + B.z) * 0.5;
  const len = Math.hypot(B.x - A.x, B.z - A.z) + 0.02;
  const yaw = Math.atan2(B.x - A.x, B.z - A.z);
  _fm.makeRotationY(yaw);
  _fm.setPosition(cx, cy, cz);
  b.push(_fm);
  b.box(0, 0, 0, w, h, len, { color: colr, kind, seed: (s * 0.013) % 1 });
  b.pop();
}

const _fm = new THREE.Matrix4();
function frameMatrix(f, P) {
  const yaw = Math.atan2(f.tan.x, f.tan.z);
  _fm.makeRotationY(yaw);
  _fm.setPosition(P.x, P.y, P.z);
  return _fm;
}

function emit(b, p, colr, kind, seed, w, h, uBase, vBase) {
  b.quad(p[0], p[1], p[2], p[3], { color: colr, kind, seed: (seed * 0.011) % 1, w, h, u0: uBase, v0: vBase });
}

function dirX(A, B) {
  const dx = B.x - A.x;
  const dz = B.z - A.z;
  const l = Math.hypot(dx, dz) || 1;
  return -dz / l;
}
function dirZ(A, B) {
  const dx = B.x - A.x;
  const dz = B.z - A.z;
  const l = Math.hypot(dx, dz) || 1;
  return dx / l;
}
void _p;
