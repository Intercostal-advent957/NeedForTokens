import * as THREE from 'three';
import { KIND, col, tint } from './Geo.js';
import { CityTextures } from './CityTextures.js';
import { PALETTE } from './Facade.js';

/**
 * Shop signs, blade signs, rooftop letters and billboards.
 *
 * Sign faces go into the *signage* builder (atlas UVs, emissive map). Their frames, brackets,
 * gantries and the neon tube outlines go into the *surface* builder so they get the KIND.NEON
 * treatment — emissive above 1.0, which is what makes them bloom and smear across wet tarmac.
 */

const _c = [1, 1, 1];

/** Quad with explicit atlas UVs. `p` = 4 corners CCW from bottom-left of the face. */
export function atlasQuad(b, p, rect, flipU = false) {
  const u0 = flipU ? rect.u1 : rect.u0;
  const u1 = flipU ? rect.u0 : rect.u1;
  const uv = [
    [u0, rect.v0],
    [u1, rect.v0],
    [u1, rect.v1],
    [u0, rect.v1],
  ];
  // face normal
  const ex = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
  const ey = [p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]];
  let nx = ex[1] * ey[2] - ex[2] * ey[1];
  let ny = ex[2] * ey[0] - ex[0] * ey[2];
  let nz = ex[0] * ey[1] - ex[1] * ey[0];
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  const base = b.vertexCount;
  for (let i = 0; i < 4; i++)
    b.vert(p[i][0], p[i][1], p[i][2], nx, ny, nz, uv[i][0], uv[i][1], _c, KIND.SURFACE, 0);
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * @param sb signage GeoBuilder  @param fb surface GeoBuilder
 * @param slot { x,y,z,w,h,type } in the *sector* frame, sign facing +Z of `rot`
 */
export function placeSign(sb, fb, slot, rng, out) {
  const type = slot.type;
  const idx = rng.int(0, CityTextures.signCount - 1);
  const rect = CityTextures.signRect(idx);
  const neon = col(rng.pick(PALETTE.neon));

  if (type === 'fascia') {
    const w = slot.w;
    const h = Math.min(slot.h, w * 0.45);
    const y = slot.y - h * 0.5;
    // deep fascia box
    fb.box(slot.x, y, slot.z - 0.14, w + 0.4, h + 0.3, 0.34, {
      color: col(0x181a1d),
      kind: KIND.SURFACE,
      seed: 0.3,
    });
    atlasQuad(
      sb,
      [
        [slot.x - w * 0.5, y - h * 0.5, slot.z + 0.05],
        [slot.x + w * 0.5, y - h * 0.5, slot.z + 0.05],
        [slot.x + w * 0.5, y + h * 0.5, slot.z + 0.05],
        [slot.x - w * 0.5, y + h * 0.5, slot.z + 0.05],
      ],
      rect
    );
    // neon tube under the fascia washing the pavement
    fb.box(slot.x, y - h * 0.5 - 0.14, slot.z - 0.02, w * 0.96, 0.08, 0.1, {
      color: neon,
      kind: KIND.NEON,
      seed: rng(),
    });
    out.glows.push({ x: slot.x, y: y, z: slot.z + 0.5, size: Math.max(3, w * 0.55), color: hexOf(neon) });
    out.fixtures.push({ x: slot.x, y: y - 0.4, z: slot.z + 1.6, color: hexOf(neon), intensity: 150, dist: 24 });
    return;
  }

  if (type === 'blade') {
    const w = slot.w;
    const h = slot.h;
    const proj = w * 1.9;
    // bracket
    fb.box(slot.x, slot.y, slot.z + proj * 0.15, 0.12, 0.12, proj * 0.4, {
      color: col(0x2a2d31),
      kind: KIND.METAL,
      seed: 0.3,
    });
    // vertical blade box
    fb.box(slot.x, slot.y - h * 0.5, slot.z + proj * 0.55, 0.22, h + 0.2, proj * 0.85, {
      color: col(0x131518),
      kind: KIND.SURFACE,
      seed: 0.3,
    });
    const vRect = CityTextures.signRect(pickVertical(rng, idx));
    for (const s of [-1, 1]) {
      const x = slot.x + s * 0.13;
      atlasQuad(
        sb,
        [
          [x, slot.y - h, slot.z + proj * 0.16],
          [x, slot.y - h, slot.z + proj * 0.94],
          [x, slot.y, slot.z + proj * 0.94],
          [x, slot.y, slot.z + proj * 0.16],
        ],
        vRect,
        s < 0
      );
    }
    // outline tubes
    for (const s of [-1, 1]) {
      fb.box(slot.x + s * 0.16, slot.y - h - 0.06, slot.z + proj * 0.55, 0.05, 0.09, proj * 0.8, {
        color: neon,
        kind: KIND.NEON,
        seed: rng(),
      });
      fb.box(slot.x + s * 0.16, slot.y + 0.06, slot.z + proj * 0.55, 0.05, 0.09, proj * 0.8, {
        color: neon,
        kind: KIND.NEON,
        seed: rng(),
      });
    }
    out.glows.push({ x: slot.x, y: slot.y - h * 0.5, z: slot.z + proj * 0.6, size: h * 1.1, color: hexOf(neon) });
    out.fixtures.push({ x: slot.x, y: slot.y - h * 0.5, z: slot.z + proj, color: hexOf(neon), intensity: 130, dist: 22 });
    return;
  }

  if (type === 'roof') {
    const w = slot.w;
    const h = slot.h;
    const y = slot.y;
    // steel gantry
    for (const s of [-1, 1]) {
      fb.box(slot.x + s * w * 0.42, y - h * 0.5 - 0.6, slot.z, 0.18, h + 1.2, 0.18, {
        color: col(0x2b2e32),
        kind: KIND.METAL,
        seed: 0.3,
      });
      fb.box(slot.x + s * w * 0.42, y - h - 1.0, slot.z + 0.9, 0.14, 0.14, 2.0, {
        color: col(0x2b2e32),
        kind: KIND.METAL,
        seed: 0.3,
      });
    }
    fb.box(slot.x, y + h * 0.5 + 0.1, slot.z, w * 0.9, 0.16, 0.16, { color: col(0x2b2e32), kind: KIND.METAL, seed: 0.3 });
    fb.box(slot.x, y, slot.z - 0.12, w, h, 0.2, { color: col(0x0e1013), kind: KIND.SURFACE, seed: 0.3 });
    const bIdx = rng.int(0, CityTextures.billboardCount - 1);
    const bRect = CityTextures.billboardRect(bIdx);
    const useBillboard = rng.chance(0.55);
    const r = useBillboard ? bRect : rect;
    const fw = useBillboard ? w : Math.min(w, h * 1.0);
    for (const s of [1, -1]) {
      atlasQuad(
        sb,
        [
          [slot.x - (fw * 0.5) * s, y - h * 0.5, slot.z + s * 0.03],
          [slot.x + (fw * 0.5) * s, y - h * 0.5, slot.z + s * 0.03],
          [slot.x + (fw * 0.5) * s, y + h * 0.5, slot.z + s * 0.03],
          [slot.x - (fw * 0.5) * s, y + h * 0.5, slot.z + s * 0.03],
        ],
        r,
        s < 0
      );
    }
    // flood lights on a spar below
    for (let i = 0; i < 3; i++) {
      const x = slot.x + (i - 1) * w * 0.3;
      fb.box(x, y - h * 0.5 - 0.75, slot.z + 0.75, 0.4, 0.24, 0.5, { color: col(0x2b2e32), kind: KIND.METAL, seed: 0.3 });
      fb.box(x, y - h * 0.5 - 0.75, slot.z + 0.52, 0.32, 0.18, 0.06, { color: tint(0xfff0d0, 1), kind: KIND.LAMP, seed: rng() });
    }
    out.glows.push({ x: slot.x, y, z: slot.z + 1.2, size: h * 1.6, color: 0xffe0b0 });
    out.fixtures.push({ x: slot.x, y: y - h * 0.4, z: slot.z + 2.5, color: 0xffe8c8, intensity: 300, dist: 40 });
    return;
  }

  // 'wall' — large flat panel
  const w = slot.w;
  const h = slot.h;
  fb.box(slot.x, slot.y, slot.z - 0.1, w + 0.3, h + 0.3, 0.24, { color: col(0x131518), kind: KIND.SURFACE, seed: 0.3 });
  atlasQuad(
    sb,
    [
      [slot.x - w * 0.5, slot.y - h * 0.5, slot.z + 0.05],
      [slot.x + w * 0.5, slot.y - h * 0.5, slot.z + 0.05],
      [slot.x + w * 0.5, slot.y + h * 0.5, slot.z + 0.05],
      [slot.x - w * 0.5, slot.y + h * 0.5, slot.z + 0.05],
    ],
    rect
  );
  fb.box(slot.x, slot.y - h * 0.5 - 0.2, slot.z + 0.1, w, 0.07, 0.09, { color: neon, kind: KIND.NEON, seed: rng() });
  out.glows.push({ x: slot.x, y: slot.y, z: slot.z + 0.7, size: h * 1.3, color: hexOf(neon) });
}

/**
 * Freestanding roadside billboard on two posts. Built directly in sector space; `rot` yaws it.
 */
export function billboard(sb, fb, x, y, z, rotY, rng, out) {
  const w = rng.range(11, 16);
  const h = w * 0.5;
  const legH = rng.range(5.5, 8.5);
  const cs = Math.cos(rotY);
  const sn = Math.sin(rotY);
  const P = (lx, ly, lz) => [x + lx * cs + lz * sn, y + ly, z - lx * sn + lz * cs];

  for (const s of [-1, 1]) {
    const p = P(s * w * 0.3, 0, 0);
    fb.box(p[0], y + legH * 0.5, p[2], 0.42, legH, 0.42, { color: col(0x3c4045), kind: KIND.METAL, seed: 0.3 });
  }
  const c = P(0, legH + h * 0.5, 0);
  // frame
  fb.push(_yaw(rotY, c[0], c[1], c[2]));
  fb.box(0, 0, -0.14, w + 0.5, h + 0.5, 0.28, { color: col(0x1a1c20), kind: KIND.SURFACE, seed: 0.3 });
  fb.box(0, -h * 0.5 - 0.5, 0.5, w, 0.2, 0.9, { color: col(0x3c4045), kind: KIND.METAL, seed: 0.3 });
  for (let i = 0; i < 4; i++) {
    const lx = (i - 1.5) * w * 0.26;
    fb.box(lx, -h * 0.5 - 0.62, 0.72, 0.55, 0.28, 0.55, { color: col(0x2b2e32), kind: KIND.METAL, seed: 0.3 });
    fb.box(lx, -h * 0.5 - 0.5, 0.62, 0.44, 0.14, 0.1, { color: tint(0xfff2d8, 1), kind: KIND.LAMP, seed: rng() });
  }
  fb.pop();

  const rect = CityTextures.billboardRect(rng.int(0, CityTextures.billboardCount - 1));
  const q = (lx, ly, lz) => P(lx, legH + h * 0.5 + ly, lz);
  atlasQuad(
    sb,
    [q(-w * 0.5, -h * 0.5, 0.04), q(w * 0.5, -h * 0.5, 0.04), q(w * 0.5, h * 0.5, 0.04), q(-w * 0.5, h * 0.5, 0.04)],
    rect
  );
  atlasQuad(
    sb,
    [q(w * 0.5, -h * 0.5, -0.18), q(-w * 0.5, -h * 0.5, -0.18), q(-w * 0.5, h * 0.5, -0.18), q(w * 0.5, h * 0.5, -0.18)],
    CityTextures.billboardRect(rng.int(0, CityTextures.billboardCount - 1)),
    true
  );
  out.glows.push({ x: c[0], y: c[1], z: c[2], size: h * 1.5, color: 0xffe0b0 });
  out.fixtures.push({ x: c[0], y: c[1] - h * 0.3, z: c[2], color: 0xffe8c8, intensity: 330, dist: 44 });
}

const _M = new THREE.Matrix4();
function _yaw(a, x, y, z) {
  _M.makeRotationY(a);
  _M.setPosition(x, y, z);
  return _M;
}

function pickVertical(rng, fallback) {
  for (let i = 0; i < 8; i++) {
    const k = rng.int(0, CityTextures.signCount - 1);
    if (CityTextures.isVertical(k)) return k;
  }
  return fallback;
}

function hexOf(linear) {
  // approximate linear -> sRGB hex for the halo pass, which wants a plain colour
  const s = (v) => Math.round(Math.min(1, Math.max(0, Math.pow(v, 1 / 2.2))) * 255);
  return (s(linear[0]) << 16) | (s(linear[1]) << 8) | s(linear[2]);
}
