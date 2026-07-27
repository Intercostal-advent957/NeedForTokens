import * as THREE from 'three';
import { GeoBuilder, KIND, col, tint } from './Geo.js';
import { punchedWall, curtainWall, ribbonWall, shopFront, parapet, cornice, faceSpan, PALETTE } from './Facade.js';
import { acUnit, ductRun, stairBulkhead, waterTower, mast, satDish, roofRailing, fireEscape, ROOF_MAT } from './RoofKit.js';

/**
 * Builds the archetype library — a fixed set of fully-modelled buildings that the layout then
 * instances. One InstancedMesh per archetype per sector means a hundred buildings cost a
 * handful of draw calls (CONTRACTS.md §0 budget).
 *
 * Each archetype also carries the metadata the rest of the lane needs:
 *   silhouette — stacked boxes for the distant LOD
 *   signSlots  — where signage can be hung, in local space
 *   fixtures   — emissive light sources for the point-light pool
 *   glows      — halo sprite anchors
 */

const _m4 = new THREE.Matrix4();

export class BuildingFactory {
  constructor(rng) {
    this.rng = rng;
    this.archetypes = [];
  }

  build() {
    const R = this.rng;
    const add = (fn, n) => {
      for (let i = 0; i < n; i++) this.archetypes.push(fn.call(this, R, this.archetypes.length));
    };
    add(this._midrise, 4);
    add(this._brickWalkup, 3);
    add(this._retail, 3);
    add(this._officeBlock, 3);
    add(this._glassTower, 3);
    add(this._apartmentSlab, 2);
    add(this._parking, 2);
    add(this._warehouse, 3);
    return this.archetypes;
  }

  // ------------------------------------------------------------------ shared
  _finish(b, meta) {
    const geo = b.geometry(meta.style);
    return { ...meta, geometry: geo, tris: b.triangleCount };
  }

  _roofDress(b, R, w, d, y, seed, out, opts = {}) {
    const n = opts.units ?? R.int(2, 5);
    const used = [];
    for (let i = 0; i < n; i++) {
      const x = R.range(-w * 0.34, w * 0.34);
      const z = R.range(-d * 0.34, d * 0.34);
      if (used.some((u) => Math.abs(u[0] - x) < 2.2 && Math.abs(u[1] - z) < 2.2)) continue;
      used.push([x, z]);
      acUnit(b, x, y, z, R.range(0.85, 1.7), seed + i * 0.11, ROOF_MAT);
    }
    if (R.chance(0.75)) {
      const bw = R.range(2.6, 4.4);
      const bd = R.range(2.4, 3.8);
      stairBulkhead(
        b,
        R.range(-w * 0.2, w * 0.2),
        y,
        R.range(-d * 0.2, d * 0.2),
        bw,
        bd,
        R.range(2.6, 3.6),
        seed,
        ROOF_MAT
      );
    }
    if (R.chance(0.5)) ductRun(b, R.range(-w * 0.3, w * 0.3), y, 0, d * 0.55, 1, R.range(0.7, 1.2), seed, ROOF_MAT);
    if (opts.water && R.chance(0.7)) waterTower(b, R.range(-w * 0.28, w * 0.28), y, R.range(-d * 0.28, d * 0.28), R.range(0.75, 1.15), seed, ROOF_MAT, out);
    if (opts.dish && R.chance(0.6)) satDish(b, R.range(-w * 0.35, w * 0.35), y, R.range(-d * 0.35, d * 0.35), R.range(0.7, 1.2), seed, ROOF_MAT);
    if (opts.mast && R.chance(0.8)) mast(b, R.range(-w * 0.18, w * 0.18), y, R.range(-d * 0.18, d * 0.18), R.range(6, 16), seed, ROOF_MAT, out);
  }

  /** Punched-window body on all four walls, sides using fewer bays. */
  _bodyAllFaces(b, o) {
    const { w, d } = o;
    for (let side = 0; side < 4; side++) {
      const { span, off } = faceSpan(side, w, d);
      const bays = Math.max(2, Math.round(span / o.bayW));
      b.push(_m4.makeRotationY((side * Math.PI) / 2));
      punchedWall(b, { ...o, span, off, bays, seedBase: o.seedBase + side * 0.271 });
      b.pop();
    }
  }

  // ------------------------------------------------------------------ archetypes
  _midrise(R, id) {
    const b = new GeoBuilder();
    const out = { fixtures: [], glows: [], signSlots: [] };
    const w = R.range(17, 30);
    const d = R.range(14, 24);
    const floors = R.int(4, 9);
    const floorH = R.range(3.3, 3.9);
    const groundH = R.range(4.4, 5.4);
    const wallCol = col(R.pick(PALETTE.render));
    const trimCol = col(R.pick(PALETTE.trim));
    const glassCol = col(R.pick(PALETTE.glass));
    const seed = R();

    // plinth
    b.box(0, groundH * 0.5, 0, w + 0.5, groundH, d + 0.5, {
      color: tint(R.pick(PALETTE.concrete), 0.85),
      kind: KIND.CONCRETE,
      seed,
      faces: 63 & ~4,
    });
    // shopfront on the street face
    b.push(_m4.makeRotationY(0));
    shopFront(b, {
      span: w * 0.94,
      off: d * 0.5 + 0.26,
      y0: 0.12,
      h: groundH - 0.5,
      glassCol,
      trimCol,
      frameCol: col(R.pick(PALETTE.metal)),
      awningCol: col(R.pick([0x8b2431, 0x1f4f3d, 0x24406b, 0x6b4a1f])),
      seed,
    });
    b.pop();

    const bodyY = groundH;
    this._bodyAllFaces(b, {
      w,
      d,
      y0: bodyY,
      floors,
      floorH,
      bayW: R.range(3.0, 3.8),
      inset: R.range(0.38, 0.55),
      wallCol,
      glassCol,
      trimCol,
      seedBase: seed,
      kind: R.chance(0.4) ? KIND.PANEL : KIND.SURFACE,
    });

    const topY = bodyY + floors * floorH;
    cornice(b, w, d, topY, tint(R.pick(PALETTE.concrete), 1.05));
    b.box(0, topY + 0.5, 0, w, 0.5, d, { color: col(0x4a4842), kind: KIND.SURFACE, seed, faces: 4 });
    parapet(b, w, d, topY + 0.55, R.range(0.9, 1.5), wallCol, trimCol);
    this._roofDress(b, R, w, d, topY + 0.75, seed, out, { water: true, dish: true, units: R.int(2, 5) });

    if (R.chance(0.55)) {
      b.push(_m4.makeRotationY(Math.PI / 2));
      fireEscape(b, d, bodyY, floors, floorH, w * 0.5 + 0.02, seed, ROOF_MAT);
      b.pop();
    }

    // signage: fascia band above the shopfront + one blade sign
    out.signSlots.push({
      x: 0,
      y: groundH - 0.05,
      z: d * 0.5 + 0.4,
      rotY: 0,
      w: w * 0.62,
      h: 1.5,
      type: 'fascia',
    });
    if (R.chance(0.7))
      out.signSlots.push({
        x: -w * 0.36,
        y: groundH + floorH * 1.2,
        z: d * 0.5 + 0.15,
        rotY: 0,
        w: 1.5,
        h: 4.4,
        type: 'blade',
      });
    if (R.chance(0.35))
      out.signSlots.push({
        x: 0,
        y: topY + 3.2,
        z: d * 0.42,
        rotY: 0,
        w: Math.min(w * 0.8, 14),
        h: 4.2,
        type: 'roof',
      });
    out.fixtures.push({ x: 0, y: groundH - 0.6, z: d * 0.5 + 1.4, color: 0xffd8a8, intensity: 190, dist: 30 });

    return this._finish(b, {
      id,
      style: 'midrise',
      w,
      d,
      h: topY + 2,
      silhouette: [{ y0: 0, y1: topY + 1.4, w, d }],
      ...out,
    });
  }

  _brickWalkup(R, id) {
    const b = new GeoBuilder();
    const out = { fixtures: [], glows: [], signSlots: [] };
    const w = R.range(14, 22);
    const d = R.range(12, 18);
    const floors = R.int(3, 6);
    const floorH = R.range(3.1, 3.5);
    const groundH = R.range(3.8, 4.6);
    const brick = col(R.pick(PALETTE.brick));
    const trimCol = col(R.pick([0xd8d2c4, 0x2b2b2b, 0x50483c]));
    const glassCol = col(R.pick(PALETTE.glass));
    const seed = R();

    b.box(0, groundH * 0.5, 0, w, groundH, d, {
      color: tint(R.pick(PALETTE.concrete), 0.7),
      kind: KIND.CONCRETE,
      seed,
      faces: 63 & ~4,
    });
    // stoop
    for (let i = 0; i < 4; i++)
      b.box(0, 0.16 + i * 0.18, d * 0.5 + 1.5 - i * 0.36, 3.2, 0.18, 0.42, {
        color: tint(R.pick(PALETTE.concrete), 0.9),
        kind: KIND.CONCRETE,
        seed,
      });
    b.box(0, groundH * 0.42, d * 0.5 + 0.06, 1.5, groundH * 0.72, 0.14, {
      color: col(0x3a2a20),
      kind: KIND.SURFACE,
      seed,
    });
    // entrance lamp
    b.box(1.35, groundH * 0.72, d * 0.5 + 0.2, 0.3, 0.42, 0.3, {
      color: tint(0xffdca8, 1),
      kind: KIND.LAMP,
      seed: 0.6,
    });
    out.glows.push({ x: 1.35, y: groundH * 0.72, z: d * 0.5 + 0.35, size: 1.5, color: 0xffd2a0 });

    this._bodyAllFaces(b, {
      w,
      d,
      y0: groundH,
      floors,
      floorH,
      bayW: R.range(2.7, 3.3),
      inset: R.range(0.3, 0.42),
      wallCol: brick,
      glassCol,
      trimCol,
      seedBase: seed,
      kind: KIND.BRICK,
      spandrelFrac: 0.4,
    });

    const topY = groundH + floors * floorH;
    cornice(b, w, d, topY, trimCol);
    b.box(0, topY + 0.5, 0, w, 0.5, d, { color: col(0x413c34), kind: KIND.SURFACE, seed, faces: 4 });
    parapet(b, w, d, topY + 0.55, 0.9, brick, trimCol);
    this._roofDress(b, R, w, d, topY + 0.7, seed, out, { water: true, units: R.int(1, 3) });

    b.push(_m4.makeRotationY(0));
    fireEscape(b, w, groundH, floors, floorH, d * 0.5 + 0.02, seed, ROOF_MAT);
    b.pop();

    if (R.chance(0.6))
      out.signSlots.push({
        x: -w * 0.28,
        y: groundH - 0.9,
        z: d * 0.5 + 0.12,
        rotY: 0,
        w: 3.6,
        h: 1.2,
        type: 'fascia',
      });

    return this._finish(b, {
      id,
      style: 'brickWalkup',
      w,
      d,
      h: topY + 1.6,
      silhouette: [{ y0: 0, y1: topY + 1.2, w, d }],
      ...out,
    });
  }

  _retail(R, id) {
    const b = new GeoBuilder();
    const out = { fixtures: [], glows: [], signSlots: [] };
    const w = R.range(20, 34);
    const d = R.range(15, 26);
    const floors = R.int(1, 3);
    const floorH = R.range(3.4, 4.0);
    const groundH = R.range(5.0, 6.2);
    const wallCol = col(R.pick(PALETTE.render));
    const trimCol = col(R.pick(PALETTE.trim));
    const glassCol = col(R.pick(PALETTE.glass));
    const seed = R();

    b.box(0, groundH * 0.5, 0, w, groundH, d, {
      color: tint(R.pick(PALETTE.concrete), 0.8),
      kind: KIND.CONCRETE,
      seed,
      faces: 63 & ~4,
    });
    for (const side of [0, 1]) {
      const { span, off } = faceSpan(side, w, d);
      b.push(_m4.makeRotationY((side * Math.PI) / 2));
      shopFront(b, {
        span: span * 0.96,
        off: off + 0.2,
        y0: 0.15,
        h: groundH - 0.55,
        glassCol,
        trimCol,
        frameCol: col(R.pick(PALETTE.metal)),
        awningCol: col(R.pick([0x8b2431, 0x1f4f3d, 0x24406b, 0xb0651f])),
        seed: seed + side,
      });
      b.pop();
    }

    if (floors > 0) {
      this._bodyAllFaces(b, {
        w,
        d,
        y0: groundH,
        floors,
        floorH,
        bayW: R.range(3.2, 4.2),
        inset: 0.4,
        wallCol,
        glassCol,
        trimCol,
        seedBase: seed,
        kind: KIND.PANEL,
      });
    }
    const topY = groundH + floors * floorH;
    b.box(0, topY + 0.35, 0, w + 0.6, 0.7, d + 0.6, { color: trimCol, kind: KIND.SURFACE, seed });
    b.box(0, topY + 0.8, 0, w, 0.5, d, { color: col(0x4a4842), kind: KIND.SURFACE, seed, faces: 4 });
    parapet(b, w, d, topY + 0.7, 1.2, wallCol, trimCol);
    this._roofDress(b, R, w, d, topY + 0.85, seed, out, { units: R.int(3, 6), dish: true });

    out.signSlots.push({ x: 0, y: groundH + 0.1, z: d * 0.5 + 0.35, rotY: 0, w: w * 0.5, h: 2.0, type: 'fascia' });
    out.signSlots.push({
      x: w * 0.28,
      y: groundH + floorH * Math.max(floors, 1) - 1.0,
      z: d * 0.5 + 0.12,
      rotY: 0,
      w: 1.6,
      h: 5.0,
      type: 'blade',
    });
    out.signSlots.push({ x: 0, y: topY + 3.6, z: 0, rotY: 0, w: Math.min(w * 0.85, 18), h: 5.0, type: 'roof' });
    out.fixtures.push({ x: 0, y: groundH - 1.0, z: d * 0.5 + 1.8, color: 0xffe0b0, intensity: 230, dist: 34 });

    return this._finish(b, {
      id,
      style: 'retail',
      w,
      d,
      h: topY + 2,
      silhouette: [{ y0: 0, y1: topY + 1.3, w, d }],
      ...out,
    });
  }

  _officeBlock(R, id) {
    const b = new GeoBuilder();
    const out = { fixtures: [], glows: [], signSlots: [] };
    const w = R.range(24, 40);
    const d = R.range(18, 30);
    const floors = R.int(6, 13);
    const floorH = R.range(3.5, 4.0);
    const groundH = R.range(5.5, 7.0);
    const wallCol = col(R.pick(PALETTE.concrete));
    const trimCol = col(R.pick(PALETTE.trim));
    const glassCol = col(R.pick(PALETTE.glass));
    const seed = R();

    // recessed glazed lobby with columns
    b.box(0, groundH * 0.5, 0, w - 2.4, groundH, d - 2.4, {
      color: glassCol,
      kind: KIND.DARKGLASS,
      seed,
      faces: 63 & ~4,
    });
    const cols = Math.max(3, Math.round(w / 6));
    for (let i = 0; i <= cols; i++) {
      const x = -w * 0.5 + (w * i) / cols;
      for (const z of [d * 0.5 - 0.4, -d * 0.5 + 0.4])
        b.box(x, groundH * 0.5, z, 0.85, groundH, 0.85, { color: wallCol, kind: KIND.CONCRETE, seed });
    }
    for (let i = 0; i < 6; i++) {
      const x = -w * 0.5 + 2 + i * ((w - 4) / 5);
      b.box(x, groundH - 0.35, d * 0.5 - 0.7, 1.1, 0.16, 0.5, {
        color: tint(0xfff0d8, 1),
        kind: KIND.LAMP,
        seed: 0.4 + i * 0.07,
      });
      out.glows.push({ x, y: groundH - 0.5, z: d * 0.5 - 0.4, size: 2.2, color: 0xffe6c0 });
    }
    b.box(0, groundH + 0.35, 0, w + 1.0, 0.7, d + 1.0, { color: trimCol, kind: KIND.SURFACE, seed });

    for (let side = 0; side < 4; side++) {
      const { span, off } = faceSpan(side, w, d);
      b.push(_m4.makeRotationY((side * Math.PI) / 2));
      ribbonWall(b, {
        span,
        off,
        y0: groundH + 0.7,
        floors,
        floorH,
        glassCol,
        wallCol,
        trimCol,
        seedBase: seed + side * 0.331,
        cells: Math.max(4, Math.round(span / 3.4)),
      });
      b.pop();
    }
    const topY = groundH + 0.7 + floors * floorH;
    b.box(0, topY + 0.5, 0, w, 0.6, d, { color: col(0x53504a), kind: KIND.SURFACE, seed, faces: 4 });
    parapet(b, w, d, topY + 0.7, 1.3, wallCol, trimCol);
    // rooftop plant enclosure
    b.box(0, topY + 3.0, 0, w * 0.5, 4.4, d * 0.5, { color: wallCol, kind: KIND.PANEL, seed });
    b.box(0, topY + 5.35, 0, w * 0.54, 0.3, d * 0.54, { color: trimCol, kind: KIND.SURFACE, seed });
    this._roofDress(b, R, w * 0.9, d * 0.9, topY + 0.9, seed, out, { dish: true, mast: true, units: R.int(2, 4) });
    roofRailing(b, w - 1.2, d - 1.2, topY + 0.8, seed, ROOF_MAT);

    out.signSlots.push({ x: 0, y: groundH + 1.5, z: d * 0.5 + 0.55, rotY: 0, w: 6.5, h: 1.5, type: 'fascia' });
    if (R.chance(0.5))
      out.signSlots.push({
        x: 0,
        y: topY - floorH * 1.2,
        z: d * 0.5 + 0.35,
        rotY: 0,
        w: Math.min(w * 0.55, 12),
        h: 3.2,
        type: 'wall',
      });

    return this._finish(b, {
      id,
      style: 'officeBlock',
      w,
      d,
      h: topY + 6,
      silhouette: [
        { y0: 0, y1: topY + 1.2, w, d },
        { y0: topY + 1.2, y1: topY + 5.4, w: w * 0.5, d: d * 0.5 },
      ],
      ...out,
    });
  }

  _glassTower(R, id) {
    const b = new GeoBuilder();
    const out = { fixtures: [], glows: [], signSlots: [] };
    let w = R.range(22, 34);
    let d = R.range(20, 30);
    const floorH = R.range(3.6, 4.1);
    const groundH = R.range(6.5, 8.5);
    const stacks = R.int(2, 3);
    const glassCol = col(R.pick([0x0e1a24, 0x101e26, 0x16232e, 0x0c161f]));
    const mullionCol = col(R.pick([0x3c4249, 0x2a2f35, 0x565c62]));
    const seed = R();

    // podium
    b.box(0, groundH * 0.5, 0, w + 3.5, groundH, d + 3.5, {
      color: col(R.pick(PALETTE.concrete)),
      kind: KIND.PANEL,
      seed,
      faces: 63 & ~4,
    });
    for (let side = 0; side < 4; side++) {
      const { span, off } = faceSpan(side, w + 3.5, d + 3.5);
      b.push(_m4.makeRotationY((side * Math.PI) / 2));
      b.quad(
        [-span * 0.4, 1.2, off + 0.02],
        [span * 0.4, 1.2, off + 0.02],
        [span * 0.4, groundH - 1.2, off + 0.02],
        [-span * 0.4, groundH - 1.2, off + 0.02],
        { color: glassCol, kind: KIND.DARKGLASS, seed: 0.3, w: span * 0.8, h: groundH - 2.4 }
      );
      b.box(0, groundH - 1.5, off - 0.5, span * 0.8, 0.18, 0.6, {
        color: tint(0xffeed0, 1),
        kind: KIND.LAMP,
        seed: 0.5,
      });
      b.pop();
    }
    b.box(0, groundH + 0.4, 0, w + 4.4, 0.8, d + 4.4, { color: mullionCol, kind: KIND.METAL, seed });
    out.glows.push({ x: 0, y: groundH - 1.4, z: d * 0.5 + 1.4, size: 5, color: 0xffe6c0 });

    let y = groundH + 0.8;
    const sil = [{ y0: 0, y1: groundH + 0.8, w: w + 3.5, d: d + 3.5 }];
    for (let s = 0; s < stacks; s++) {
      const floors = s === 0 ? R.int(9, 16) : R.int(4, 9);
      for (let side = 0; side < 4; side++) {
        const { span, off } = faceSpan(side, w, d);
        b.push(_m4.makeRotationY((side * Math.PI) / 2));
        curtainWall(b, {
          span,
          off,
          y0: y,
          floors,
          floorH,
          bays: Math.max(4, Math.round(span / 3.4)),
          glassCol,
          mullionCol,
          seedBase: seed + s * 0.53 + side * 0.19,
        });
        b.pop();
      }
      const ny = y + floors * floorH + 0.4;
      // setback slab
      b.box(0, ny + 0.25, 0, w + 1.2, 0.5, d + 1.2, { color: mullionCol, kind: KIND.METAL, seed });
      sil.push({ y0: y, y1: ny + 0.5, w, d });
      y = ny + 0.5;
      w *= R.range(0.72, 0.86);
      d *= R.range(0.72, 0.86);
    }
    // crown
    b.box(0, y + 2.2, 0, w * 0.8, 4.4, d * 0.8, { color: mullionCol, kind: KIND.PANEL, seed });
    b.box(0, y + 4.6, 0, w * 0.86, 0.4, d * 0.86, { color: mullionCol, kind: KIND.METAL, seed });
    sil.push({ y0: y, y1: y + 4.8, w: w * 0.8, d: d * 0.8 });
    // crown light band — reads for miles at night
    for (let side = 0; side < 4; side++) {
      const { span, off } = faceSpan(side, w * 0.8, d * 0.8);
      b.push(_m4.makeRotationY((side * Math.PI) / 2));
      b.box(0, y + 3.9, off + 0.06, span * 0.92, 0.36, 0.12, {
        color: tint(R.pick([0x40c8ff, 0xff4d7a, 0xffffff, 0x9dff5a]), 1),
        kind: KIND.NEON,
        seed: 0.7,
      });
      b.pop();
    }
    mast(b, 0, y + 4.8, 0, R.range(9, 20), seed, ROOF_MAT, out);
    out.glows.push({ x: 0, y: y + 3.9, z: 0, size: 14, color: 0x60c0ff });

    return this._finish(b, {
      id,
      style: 'glassTower',
      w: sil[0].w,
      d: sil[0].d,
      h: y + 22,
      silhouette: sil,
      ...out,
    });
  }

  _apartmentSlab(R, id) {
    const b = new GeoBuilder();
    const out = { fixtures: [], glows: [], signSlots: [] };
    const w = R.range(30, 46);
    const d = R.range(14, 20);
    const floors = R.int(8, 16);
    const floorH = R.range(3.0, 3.4);
    const groundH = R.range(4.2, 5.2);
    const wallCol = col(R.pick(PALETTE.render));
    const trimCol = col(R.pick(PALETTE.trim));
    const glassCol = col(R.pick(PALETTE.glass));
    const seed = R();

    b.box(0, groundH * 0.5, 0, w, groundH, d, {
      color: tint(R.pick(PALETTE.concrete), 0.82),
      kind: KIND.CONCRETE,
      seed,
      faces: 63 & ~4,
    });

    // narrow ends: plain punched windows
    for (const side of [1, 3]) {
      const { span, off } = faceSpan(side, w, d);
      b.push(_m4.makeRotationY((side * Math.PI) / 2));
      punchedWall(b, {
        span,
        off,
        y0: groundH,
        floors,
        floorH,
        bays: Math.max(2, Math.round(span / 3.4)),
        inset: 0.4,
        wallCol,
        glassCol,
        trimCol,
        seedBase: seed + side,
        kind: KIND.PANEL,
      });
      b.pop();
    }
    // long faces: recessed balconies every other bay
    const bays = Math.max(6, Math.round(w / 4.4));
    const bayW = w / bays;
    for (const side of [0, 2]) {
      b.push(_m4.makeRotationY((side * Math.PI) / 2));
      const off = d * 0.5;
      for (let f = 0; f < floors; f++) {
        const yA = groundH + f * floorH;
        for (let i = 0; i < bays; i++) {
          const x0 = -w * 0.5 + i * bayW;
          const balcony = i % 2 === 1;
          const inner = off - (balcony ? 1.5 : 0.42);
          b.quad(
            [x0 + 0.1, yA + 0.35, inner],
            [x0 + bayW - 0.1, yA + 0.35, inner],
            [x0 + bayW - 0.1, yA + floorH - 0.2, inner],
            [x0 + 0.1, yA + floorH - 0.2, inner],
            {
              color: glassCol,
              kind: KIND.GLASS,
              seed: (f * 0.317 + i * 0.713 + seed) % 1,
              // uv is in window cells, not metres — see the WINDOW UV CONVENTION in Facade.js
              w: 1,
              h: 1,
              feat: Math.min(bayW, floorH),
            }
          );
          if (balcony) {
            // side cheeks + soffit + glass balustrade
            b.box(x0 + 0.06, yA + floorH * 0.5, off - 0.75, 0.12, floorH, 1.5, {
              color: wallCol,
              kind: KIND.CONCRETE,
              seed,
            });
            b.box(x0 + bayW - 0.06, yA + floorH * 0.5, off - 0.75, 0.12, floorH, 1.5, {
              color: wallCol,
              kind: KIND.CONCRETE,
              seed,
            });
            b.box(x0 + bayW * 0.5, yA + 0.16, off - 0.75, bayW, 0.32, 1.5, {
              color: wallCol,
              kind: KIND.CONCRETE,
              seed,
            });
            b.box(x0 + bayW * 0.5, yA + 0.75, off - 0.06, bayW - 0.24, 0.85, 0.1, {
              color: glassCol,
              kind: KIND.DARKGLASS,
              seed,
            });
            b.box(x0 + bayW * 0.5, yA + 1.2, off - 0.06, bayW - 0.24, 0.07, 0.14, {
              color: trimCol,
              kind: KIND.METAL,
              seed,
            });
          }
        }
        b.box(0, groundH + f * floorH + 0.16, off - 0.2, w, 0.32, 0.44, {
          color: trimCol,
          kind: KIND.SURFACE,
          seed,
          faces: 63 & ~32,
        });
      }
      for (let i = 0; i <= bays; i++)
        if (i % 2 === 0)
          b.box(-w * 0.5 + i * bayW, groundH + floors * floorH * 0.5, off - 0.2, 0.5, floors * floorH, 0.44, {
            color: wallCol,
            kind: KIND.PANEL,
            seed,
            faces: 63 & ~32,
          });
      b.pop();
    }

    const topY = groundH + floors * floorH;
    b.box(0, topY + 0.5, 0, w, 0.6, d, { color: col(0x4d4a44), kind: KIND.SURFACE, seed, faces: 4 });
    parapet(b, w, d, topY + 0.7, 1.1, wallCol, trimCol);
    this._roofDress(b, R, w, d, topY + 0.85, seed, out, { units: R.int(3, 6), dish: true, mast: true });

    return this._finish(b, {
      id,
      style: 'apartmentSlab',
      w,
      d,
      h: topY + 5,
      silhouette: [{ y0: 0, y1: topY + 1.2, w, d }],
      ...out,
    });
  }

  _parking(R, id) {
    const b = new GeoBuilder();
    const out = { fixtures: [], glows: [], signSlots: [] };
    const w = R.range(30, 44);
    const d = R.range(24, 34);
    const decks = R.int(4, 7);
    const deckH = R.range(2.9, 3.2);
    const concrete = col(R.pick(PALETTE.concrete));
    const dark = col(0x2c2f33);
    const seed = R();

    b.box(0, 0.3, 0, w, 0.6, d, { color: tint(0x6a6862, 1), kind: KIND.CONCRETE, seed });
    for (let f = 0; f < decks; f++) {
      const y = 0.6 + f * deckH;
      // slab
      b.box(0, y + 0.28, 0, w, 0.56, d, { color: concrete, kind: KIND.CONCRETE, seed: (seed + f * 0.2) % 1 });
      // spandrel band with the open gap above it
      for (let side = 0; side < 4; side++) {
        const { span, off } = faceSpan(side, w, d);
        b.push(_m4.makeRotationY((side * Math.PI) / 2));
        b.box(0, y + 1.05, off - 0.18, span, 1.0, 0.36, {
          color: concrete,
          kind: KIND.CONCRETE,
          seed: (seed + f * 0.11) % 1,
          faces: 63 & ~32,
        });
        // dark interior behind the opening
        b.quad(
          [span * 0.5, y + 1.55, off - 0.5],
          [-span * 0.5, y + 1.55, off - 0.5],
          [-span * 0.5, y + deckH + 0.05, off - 0.5],
          [span * 0.5, y + deckH + 0.05, off - 0.5],
          { color: col(0x0a0b0d), kind: KIND.SURFACE, seed: 0.1, w: span, h: deckH }
        );
        // Cable barrier. Two 80 mm rails, not three 50 mm ones: at 100 m a 50 mm rail is a
        // third of a pixel, and three of them stacked 240 mm apart drew three parallel
        // sub-pixel lines down the whole 40 m face — the worst of the crawling bands.
        for (let k = 0; k < 2; k++)
          b.box(0, y + 1.66 + k * 0.34, off - 0.1, span, 0.08, 0.08, {
            color: dark,
            kind: KIND.METAL,
            seed: 0.2,
          });
        // Deck lighting: a RUN OF FITTINGS, not one continuous tube. A 36 m unbroken emissive
        // strip 100 mm tall is a razor-sharp near-white line across a shaded deck at every
        // level, which is what read as the bright horizontal streaks on the facade. Real decks
        // are lit by luminaires on a pitch; discrete fittings also give the deck depth cues.
        if (f < decks - 1) {
          const lamps = Math.max(2, Math.round(span / 7.5));
          const pitch = (span * 0.86) / lamps;
          for (let i = 0; i < lamps; i++) {
            const lx = -span * 0.43 + pitch * (i + 0.5);
            b.box(lx, y + deckH - 0.14, off - 1.1, Math.min(1.7, pitch * 0.42), 0.14, 0.3, {
              color: tint(0xdff0ff, 1),
              kind: KIND.LAMP,
              seed: (0.3 + f * 0.13 + i * 0.07) % 1,
            });
          }
        }
        b.pop();
      }
      // columns
      const cn = Math.max(3, Math.round(w / 8));
      for (let i = 0; i <= cn; i++)
        for (const z of [d * 0.5 - 2.5, -d * 0.5 + 2.5, 0])
          b.box(-w * 0.5 + (w * i) / cn, y + deckH * 0.5, z, 0.6, deckH, 0.6, {
            color: concrete,
            kind: KIND.CONCRETE,
            seed: 0.4,
          });
      if (f === 0)
        out.fixtures.push({ x: 0, y: y + deckH - 0.4, z: d * 0.5 - 1.5, color: 0xdaeeff, intensity: 160, dist: 30 });
      out.glows.push({ x: 0, y: y + deckH - 0.3, z: d * 0.5 - 1.0, size: 6, color: 0xcfe4ff });
    }
    const topY = 0.6 + decks * deckH;
    b.box(0, topY + 0.3, 0, w, 0.6, d, { color: concrete, kind: KIND.CONCRETE, seed });
    parapet(b, w, d, topY + 0.6, 1.15, concrete, col(0x5a5d61));
    // stair / lift core
    const cx = w * 0.5 - 4;
    b.box(cx, topY * 0.5 + 2.5, -d * 0.5 + 4, 7, topY + 5, 7.5, {
      color: tint(R.pick(PALETTE.concrete), 0.9),
      kind: KIND.PANEL,
      seed,
    });
    b.box(cx, topY + 5.3, -d * 0.5 + 4, 7.6, 0.4, 8.1, { color: col(0x5a5d61), kind: KIND.SURFACE, seed });
    for (let f = 0; f < decks; f++)
      b.box(cx + 3.55, 1.6 + f * deckH, -d * 0.5 + 4, 0.12, 1.4, 5.5, {
        color: tint(0x9fd8ff, 1),
        kind: KIND.LAMP,
        seed: (0.2 + f * 0.17) % 1,
      });
    // roof-deck lamp posts
    for (let i = 0; i < 4; i++) {
      const x = -w * 0.35 + (i * w * 0.7) / 3;
      b.cylinder(x, topY + 0.6, 0, 0.11, 0.09, 4.2, 6, { color: dark, kind: KIND.METAL, seed });
      b.box(x, topY + 4.85, 0, 0.7, 0.22, 0.34, { color: tint(0xdff0ff, 1), kind: KIND.LAMP, seed: 0.8 });
      out.glows.push({ x, y: topY + 4.8, z: 0, size: 3.4, color: 0xcfe4ff });
    }
    out.signSlots.push({ x: 0, y: 6.5, z: d * 0.5 + 0.3, rotY: 0, w: 4.5, h: 3.0, type: 'wall' });

    return this._finish(b, {
      id,
      style: 'parking',
      w,
      d,
      h: topY + 6,
      silhouette: [
        { y0: 0, y1: topY + 1.5, w, d },
        { y0: topY + 1.5, y1: topY + 5.4, w: 7, d: 7.5 },
      ],
      ...out,
    });
  }

  _warehouse(R, id) {
    const b = new GeoBuilder();
    const out = { fixtures: [], glows: [], signSlots: [] };
    const w = R.range(34, 58);
    const d = R.range(24, 40);
    const h = R.range(8, 13);
    const metalCol = col(R.pick([0x7d858c, 0x8f6f5c, 0x6d7a72, 0x9aa0a6, 0x5f6a72]));
    const trimCol = col(R.pick(PALETTE.trim));
    const seed = R();

    for (let side = 0; side < 4; side++) {
      const { span, off } = faceSpan(side, w, d);
      b.push(_m4.makeRotationY((side * Math.PI) / 2));
      // plinth
      b.box(0, 0.7, off - 0.12, span, 1.4, 0.24, { color: col(0x6c6a66), kind: KIND.CONCRETE, seed, faces: 63 & ~32 });
      // corrugated skin
      b.box(0, 1.4 + (h - 1.4) * 0.5, off - 0.1, span, h - 1.4, 0.2, {
        color: metalCol,
        kind: KIND.CORRUGATED,
        seed: (seed + side * 0.2) % 1,
        faces: 63 & ~32,
      });
      // clerestory strip
      b.quad(
        [-span * 0.46, h - 2.2, off - 0.24],
        [span * 0.46, h - 2.2, off - 0.24],
        [span * 0.46, h - 0.9, off - 0.24],
        [-span * 0.46, h - 0.9, off - 0.24],
        {
          color: col(0x1a222a),
          kind: KIND.GLASS,
          seed: (seed + side * 0.41) % 1,
          // a continuous clerestory: uv counts the panes across it (Facade.js convention)
          w: Math.max(2, Math.round((span * 0.92) / 3.2)),
          h: 1,
          feat: 1.3,
        }
      );
      // vertical ribs
      const ribs = Math.max(4, Math.round(span / 6));
      for (let i = 0; i <= ribs; i++)
        b.box(-span * 0.5 + (span * i) / ribs, h * 0.5, off + 0.02, 0.22, h, 0.16, {
          color: trimCol,
          kind: KIND.METAL,
          seed: 0.3,
          faces: 63 & ~32,
        });
      // gutter
      b.box(0, h + 0.1, off + 0.1, span + 0.4, 0.35, 0.5, { color: trimCol, kind: KIND.METAL, seed });
      b.pop();
    }
    // roller doors on the front
    const doors = R.int(2, 4);
    for (let i = 0; i < doors; i++) {
      const x = -w * 0.32 + (i * w * 0.64) / Math.max(1, doors - 1);
      b.box(x, 2.4, d * 0.5 + 0.06, 4.6, 4.8, 0.3, { color: col(0x4a4f55), kind: KIND.CORRUGATED, seed: 0.6 });
      b.box(x, 4.95, d * 0.5 + 0.45, 5.4, 0.35, 1.1, { color: trimCol, kind: KIND.METAL, seed });
      b.box(x, 5.25, d * 0.5 + 0.3, 1.4, 0.18, 0.4, { color: tint(0xfff2d8, 1), kind: KIND.LAMP, seed: 0.55 });
      out.glows.push({ x, y: 5.2, z: d * 0.5 + 0.6, size: 2.6, color: 0xffe9c4 });
      if (i === 0) out.fixtures.push({ x, y: 5.1, z: d * 0.5 + 1.6, color: 0xffe6c0, intensity: 150, dist: 26 });
    }
    // loading dock apron
    b.box(0, 0.45, d * 0.5 + 3.2, w * 0.8, 0.9, 6, { color: col(0x6f6d68), kind: KIND.CONCRETE, seed });
    // shallow roof
    b.box(0, h + 0.45, 0, w, 0.5, d, { color: col(0x53565a), kind: KIND.SURFACE, seed, faces: 63 & ~8 });
    for (let i = 0; i < 6; i++) {
      const x = R.range(-w * 0.4, w * 0.4);
      const z = R.range(-d * 0.4, d * 0.4);
      b.cylinder(x, h + 0.7, z, 0.55, 0.55, 0.7, 8, { color: col(0x8e949a), kind: KIND.METAL, seed });
      b.cylinder(x, h + 1.35, z, 0.75, 0.55, 0.3, 8, { color: col(0x777d83), kind: KIND.METAL, seed });
    }
    ductRun(b, 0, h + 0.7, -d * 0.25, w * 0.6, 0, 1.4, seed, ROOF_MAT);

    out.signSlots.push({ x: 0, y: h - 3.2, z: d * 0.5 + 0.28, rotY: 0, w: Math.min(w * 0.35, 12), h: 3.4, type: 'wall' });

    return this._finish(b, {
      id,
      style: 'warehouse',
      w,
      d,
      h: h + 2,
      silhouette: [{ y0: 0, y1: h + 0.7, w, d }],
      ...out,
    });
  }
}
