import * as THREE from 'three';
import { KIND, col, tint } from './Geo.js';

/**
 * Facade primitives shared by every building archetype.
 *
 * The trick that makes a box read as a building is that the *wall* is the recessed surface and
 * the spandrels/piers stand proud of it. The gaps between them become the window openings, and
 * the side faces of those bands give you real reveal depth, self-shadowing and a silhouette
 * that changes with the sun — for the cost of a handful of boxes per floor.
 */

const _m = new THREE.Matrix4();

/** Rotate a locally-built +Z-facing face into one of the four cardinal walls. */
export function faceMatrix(side) {
  return _m.makeRotationY((side * Math.PI) / 2).clone();
}

/** Face widths for a W×D footprint: front/back use W, sides use D. */
export function faceSpan(side, w, d) {
  return side % 2 === 0 ? { span: w, off: d * 0.5 } : { span: d, off: w * 0.5 };
}

export const PALETTE = {
  concrete: [0x9d9a92, 0x8b8880, 0xa9a49a, 0x7e7c76, 0xb3aea3],
  render: [0xb9b2a4, 0x8e9298, 0x6d747a, 0xa89c8c, 0x5d646b],
  brick: [0x8d4b3b, 0x6f4437, 0x9c5b45, 0x7a3f33, 0x5e3a30],
  metal: [0x9aa0a6, 0x828a92, 0xa9b0b6],
  glass: [0x141d27, 0x18242c, 0x1c2632, 0x101820, 0x1a2330],
  trim: [0x2a2e33, 0x3a3f45, 0x1d2126, 0x4a4136],
  neon: [0xff2d6f, 0x4fd8ff, 0xffb03a, 0x8affc1, 0xc77dff, 0xff5722, 0x37f2ff],
};

/**
 * WINDOW UV CONVENTION — read before touching any KIND.GLASS quad.
 *
 * Every other surface in the city carries uv in *metres*. Glass does not: a glass quad's uv is in
 * WINDOW CELLS, so a single window spans exactly 0..1 and a continuous ribbon spans 0..N. The
 * surface shader takes fract(uv) as the coordinate inside one room and floor(uv) as that room's
 * identity, which is what lets it march a parallax interior box behind the pane and give each
 * window its own colour temperature, brightness and on/off state.
 *
 * Two consequences:
 *   - always pass `w`/`h` as a CELL COUNT (usually 1), never as a span in metres;
 *   - always pass `feat` explicitly, because GeoBuilder would otherwise infer the feature size
 *     from w/h and hand the specular-AA branch a 1 m face (see Geo.js aFeat).
 */
const WIN = (seed, w, h, feat) => ({ kind: KIND.GLASS, seed, w, h, feat });

/**
 * One punched-window wall.
 *
 * @param b       GeoBuilder (already pushed into the face frame)
 * @param o.span  face width (metres)
 * @param o.off   distance from the building centre to the outer wall plane
 * @param o.y0    base height
 * @param o.floors, o.floorH, o.bays
 * @param o.inset window recess depth
 */
export function punchedWall(b, o) {
  const {
    span,
    off,
    y0,
    floors,
    floorH,
    bays,
    inset = 0.42,
    wallCol,
    glassCol,
    trimCol,
    seedBase = 0,
    kind = KIND.SURFACE,
    sill = true,
    spandrelFrac = 0.34,
  } = o;

  const half = span * 0.5;
  const inner = off - inset;
  const top = y0 + floors * floorH;
  const bandH = floorH * spandrelFrac;
  const bayW = span / bays;
  const pierW = Math.min(bayW * 0.34, 1.15);

  // Recessed wall plane — one quad per window cell so each gets its own aSeed.
  for (let f = 0; f < floors; f++) {
    for (let i = 0; i < bays; i++) {
      const x0 = -half + i * bayW;
      const yA = y0 + f * floorH;
      const seed = frac(seedBase + f * 0.3719 + i * 0.7311);
      b.quad(
        [x0, yA, inner],
        [x0 + bayW, yA, inner],
        [x0 + bayW, yA + floorH, inner],
        [x0, yA + floorH, inner],
        { color: glassCol, ...WIN(seed, 1, 1, Math.min(bayW, floorH)) }
      );
    }
  }

  // Horizontal spandrel bands (below every window line, plus a lintel at the top). The band's
  // top and bottom faces ARE the sill and the soffit of the openings either side of it, so they
  // are tagged as reveals and pick up the spill from the rooms behind.
  for (let f = 0; f <= floors; f++) {
    const yc = y0 + f * floorH + (f === floors ? -bandH * 0.5 : bandH * 0.5);
    const h = f === floors ? bandH * 1.15 : bandH;
    b.box(0, yc, (inner + off) * 0.5, span, h, inset, {
      color: wallCol,
      kind,
      kindY: KIND.REVEAL,
      seed: frac(seedBase + f * 0.211),
      faces: 63 & ~32,
    });
    if (sill && f < floors) {
      // protruding sill lip — catches light and drops a shadow onto the band below
      b.box(0, yc + bandH * 0.5 + 0.055, off + 0.055, span, 0.11, inset + 0.16, {
        color: trimCol,
        kind: KIND.SURFACE,
        kindY: KIND.REVEAL,
        seed: 0.3,
        faces: 63 & ~32,
      });
    }
  }

  // Vertical piers between bays. Their flanks are the window jambs — reveals again.
  for (let i = 0; i <= bays; i++) {
    const x = -half + i * bayW;
    const w = i === 0 || i === bays ? pierW * 1.5 : pierW;
    const xc = i === 0 ? x + w * 0.5 - 0.02 : i === bays ? x - w * 0.5 + 0.02 : x;
    b.box(xc, y0 + (top - y0) * 0.5, (inner + off) * 0.5, w, top - y0, inset, {
      color: wallCol,
      kind,
      kindX: KIND.REVEAL,
      seed: frac(seedBase + i * 0.523),
      faces: 63 & ~32,
    });
  }
}

/** Curtain wall: continuous glazing, slim mullions, opaque spandrel every floor. */
export function curtainWall(b, o) {
  const { span, off, y0, floors, floorH, bays, glassCol, mullionCol, seedBase = 0 } = o;
  const half = span * 0.5;
  const inner = off - 0.16;
  const bandH = floorH * 0.2;

  for (let f = 0; f < floors; f++) {
    for (let i = 0; i < bays; i++) {
      const bayW = span / bays;
      const x0 = -half + i * bayW;
      const yA = y0 + f * floorH + bandH;
      const seed = frac(seedBase + f * 0.4131 + i * 0.6197);
      b.quad(
        [x0, yA, inner],
        [x0 + bayW, yA, inner],
        [x0 + bayW, yA + floorH - bandH, inner],
        [x0, yA + floorH - bandH, inner],
        { color: glassCol, ...WIN(seed, 1, 1, Math.min(bayW, floorH - bandH)) }
      );
    }
    // spandrel
    b.box(0, y0 + f * floorH + bandH * 0.5, (inner + off) * 0.5, span, bandH, 0.16, {
      color: mullionCol,
      kind: KIND.METAL,
      kindY: KIND.REVEAL,
      seed: 0.2,
      faces: 63 & ~32,
    });
  }
  // mullions
  const bayW = span / bays;
  for (let i = 0; i <= bays; i++) {
    b.box(-half + i * bayW, y0 + (floors * floorH) * 0.5, off - 0.06, 0.18, floors * floorH, 0.24, {
      color: mullionCol,
      kind: KIND.METAL,
      kindX: KIND.REVEAL,
      seed: 0.4,
      faces: 63 & ~32,
    });
  }
  // top cap
  b.box(0, y0 + floors * floorH + 0.18, off - 0.06, span, 0.36, 0.34, {
    color: mullionCol,
    kind: KIND.METAL,
    seed: 0.5,
    faces: 63 & ~32,
  });
}

/** Horizontal ribbon glazing — 60s/70s office block. */
export function ribbonWall(b, o) {
  const { span, off, y0, floors, floorH, glassCol, wallCol, trimCol, seedBase = 0, cells = 8 } = o;
  const half = span * 0.5;
  const inset = 0.5;
  const inner = off - inset;
  const bandH = floorH * 0.46;
  const winH = floorH - bandH;
  const cw = span / cells;

  for (let f = 0; f < floors; f++) {
    const yA = y0 + f * floorH + bandH;
    for (let i = 0; i < cells; i++) {
      b.quad(
        [-half + i * cw, yA, inner],
        [-half + (i + 1) * cw, yA, inner],
        [-half + (i + 1) * cw, yA + winH, inner],
        [-half + i * cw, yA + winH, inner],
        { color: glassCol, ...WIN(frac(seedBase + f * 0.317 + i * 0.811), 1, 1, Math.min(cw, winH)) }
      );
      if (i > 0)
        b.box(-half + i * cw, yA + winH * 0.5, inner + 0.07, 0.1, winH, 0.14, {
          color: trimCol,
          kind: KIND.METAL,
          kindX: KIND.REVEAL,
          seed: 0.1,
          faces: 63 & ~32,
        });
    }
    b.box(0, y0 + f * floorH + bandH * 0.5, (inner + off) * 0.5, span, bandH, inset, {
      color: wallCol,
      kind: KIND.PANEL,
      kindY: KIND.REVEAL,
      seed: frac(seedBase + f * 0.19),
      faces: 63 & ~32,
    });
  }
  b.box(0, y0 + floors * floorH + bandH * 0.4, (inner + off) * 0.5, span, bandH * 0.8, inset, {
    color: wallCol,
    kind: KIND.PANEL,
    seed: 0.6,
    faces: 63 & ~32,
  });
}

/** Ground-floor retail: deep glazing, stall riser, awning, fascia sign band. */
export function shopFront(b, o) {
  const { span, off, y0, h, glassCol, trimCol, frameCol, seed = 0, awning = true, awningCol } = o;
  const half = span * 0.5;
  const inner = off - 0.55;
  const units = Math.max(1, Math.round(span / 6.2));
  const uw = span / units;

  for (let i = 0; i < units; i++) {
    const x0 = -half + i * uw;
    // stall riser
    b.box(x0 + uw * 0.5, y0 + 0.32, off - 0.16, uw - 0.16, 0.64, 0.34, {
      color: trimCol,
      kind: KIND.SURFACE,
      seed: 0.2,
      faces: 63 & ~32,
    });
    // glazing
    b.quad(
      [x0 + 0.12, y0 + 0.62, inner],
      [x0 + uw - 0.12, y0 + 0.62, inner],
      [x0 + uw - 0.12, y0 + h - 0.75, inner],
      [x0 + 0.12, y0 + h - 0.75, inner],
      { color: glassCol, kind: KIND.DARKGLASS, seed: frac(seed + i * 0.41), w: uw, h: h - 1.4 }
    );
    // interior strip light — the reason a shopfront glows at night
    b.box(x0 + uw * 0.5, y0 + h - 0.92, inner - 0.12, uw - 0.6, 0.14, 0.1, {
      color: tint(0xffe9c8, 1),
      kind: KIND.LAMP,
      seed: frac(seed + i * 0.77),
    });
    // mullion
    b.box(x0, y0 + h * 0.5, off - 0.3, 0.16, h, 0.4, {
      color: frameCol,
      kind: KIND.METAL,
      seed: 0.3,
      faces: 63 & ~32,
    });
  }
  // head beam
  b.box(0, y0 + h - 0.42, off - 0.22, span, 0.5, 0.5, {
    color: frameCol,
    kind: KIND.METAL,
    seed: 0.4,
    faces: 63 & ~32,
  });
  // right-hand end mullion
  b.box(half, y0 + h * 0.5, off - 0.3, 0.16, h, 0.4, {
    color: frameCol,
    kind: KIND.METAL,
    seed: 0.3,
    faces: 63 & ~32,
  });

  if (awning) {
    for (let i = 0; i < units; i++) {
      if (i % 2 === 1) continue;
      const x0 = -half + i * uw;
      const w = Math.min(uw * 1.9, span - i * uw) - 0.3;
      const yA = y0 + h - 1.05;
      // sloped canopy
      b.quad(
        [x0 + 0.15, yA, off],
        [x0 + 0.15 + w, yA, off],
        [x0 + 0.15 + w, yA - 0.55, off + 1.5],
        [x0 + 0.15, yA - 0.55, off + 1.5],
        { color: awningCol, kind: KIND.SURFACE, seed: 0.5, w, h: 1.6 }
      );
      b.quad(
        [x0 + 0.15, yA - 0.55, off + 1.5],
        [x0 + 0.15 + w, yA - 0.55, off + 1.5],
        [x0 + 0.15 + w, yA - 1.0, off + 1.45],
        [x0 + 0.15, yA - 1.0, off + 1.45],
        { color: awningCol, kind: KIND.SURFACE, seed: 0.5, w, h: 0.5 }
      );
    }
  }
}

/** Parapet wall + coping around a roof slab. */
export function parapet(b, w, d, y, h, colr, copingCol) {
  const t = 0.34;
  for (const [sx, sz, sw, sd] of [
    [0, d * 0.5 - t * 0.5, w, t],
    [0, -d * 0.5 + t * 0.5, w, t],
    [w * 0.5 - t * 0.5, 0, t, d - t * 2],
    [-w * 0.5 + t * 0.5, 0, t, d - t * 2],
  ]) {
    b.box(sx, y + h * 0.5, sz, sw, h, sd, { color: colr, kind: KIND.CONCRETE, seed: 0.3 });
    b.box(sx, y + h + 0.05, sz, sw + 0.16, 0.1, sd + 0.16, {
      color: copingCol,
      kind: KIND.SURFACE,
      seed: 0.4,
      faces: 63 & ~8,
    });
  }
}

/** Projecting cornice — the single cheapest way to stop a facade looking extruded. */
export function cornice(b, w, d, y, colr) {
  b.box(0, y + 0.22, 0, w + 0.9, 0.44, d + 0.9, { color: colr, kind: KIND.SURFACE, seed: 0.5 });
  b.box(0, y - 0.16, 0, w + 0.45, 0.34, d + 0.45, { color: colr, kind: KIND.SURFACE, seed: 0.4 });
}

export function frac(x) {
  return x - Math.floor(x);
}

export { col, tint, KIND };
