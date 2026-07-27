import * as THREE from 'three';
import { GeoBuilder, KIND, col } from './Geo.js';
import { CityTextures } from './CityTextures.js';

/**
 * Street planting. Cross-billboard canopies on real trunks, plus merged hedges and grass tufts.
 *
 * `aSeed` doubles as the wind stiffness gradient here (0 at the root, 1 at the tip) — the
 * foliage material reads it in the vertex shader to sway the canopy without moving the trunk.
 * Population scales with settings.get('vegetation').
 */

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * Quad with explicit per-vertex normals, so a flat card still shades like a volume.
 * `flip` mirrors the atlas cell horizontally — free silhouette variation, no extra texels.
 */
function card(b, cx, cy, cz, ax, az, w, h, rect, colr, centreY, radius, tiltUp = 0, flip = false) {
  const hw = w * 0.5;
  const px = ax * hw;
  const pz = az * hw;
  const pts = [
    [cx - px, cy, cz - pz],
    [cx + px, cy, cz + pz],
    [cx + px + ax * tiltUp, cy + h, cz + pz + az * tiltUp],
    [cx - px + ax * tiltUp, cy + h, cz - pz + az * tiltUp],
  ];
  const uL = flip ? rect.u1 : rect.u0;
  const uR = flip ? rect.u0 : rect.u1;
  const uvs = [
    [uL, rect.v0],
    [uR, rect.v0],
    [uR, rect.v1],
    [uL, rect.v1],
  ];
  const base = b.vertexCount;
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    _v.set(p[0] - cx, p[1] - centreY, p[2] - cz).normalize();
    if (_v.lengthSq() < 0.1) _v.set(0, 1, 0);
    const heightFrac = Math.min(1, Math.max(0, (p[1] - (centreY - radius)) / (radius * 2)));
    b.vert(p[0], p[1], p[2], _v.x, _v.y * 0.8 + 0.3, _v.z, uvs[i][0], uvs[i][1], colr, KIND.FOLIAGE, heightFrac);
  }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Tree species. Two assets repeated down a whole street is read as repetition within about
 * three trees, so the library is deliberately wider than the number of draw calls: CityLayout
 * still builds exactly two InstancedMeshes per sector, but neighbouring sectors draw from
 * different pairs, so the eye never sees the same silhouette twice in a row.
 */
export const TREE_SPECIES = [
  { trunk: [2.6, 3.8], r: [2.4, 3.4], cells: [0, 1], bark: 0x4f4234, leaf: 0xb9d29a, cards: 3 },
  { trunk: [1.6, 2.4], r: [1.5, 2.1], cells: [2, 11], bark: 0x4a3b2c, leaf: 0xcfe0b0, cards: 3 },
  { trunk: [3.4, 4.6], r: [2.0, 2.6], cells: [3, 7], bark: 0x453a30, leaf: 0x9fbe93, cards: 4, tall: 1.5 },
  { trunk: [2.2, 3.0], r: [2.8, 3.8], cells: [4, 6], bark: 0x5a4a38, leaf: 0xc9d79c, cards: 3, wide: 1.15 },
  { trunk: [3.0, 4.2], r: [2.2, 3.0], cells: [5, 1], bark: 0x4c4032, leaf: 0xb2cc98, cards: 4, droop: 1 },
];

/** One instanced street tree. `variant` indexes TREE_SPECIES. */
export function treeGeometry(rng, variant = 0) {
  const sp = TREE_SPECIES[((variant % TREE_SPECIES.length) + TREE_SPECIES.length) % TREE_SPECIES.length];
  const b = new GeoBuilder();
  const trunkH = rng.range(sp.trunk[0], sp.trunk[1]);
  const canopyR = rng.range(sp.r[0], sp.r[1]);
  const trunkColour = col(sp.bark);
  const leafCol = col(sp.leaf);

  // trunk — slight taper, no caps (hidden by canopy and ground)
  b.cylinder(0, 0, 0, 0.19, 0.12, trunkH, 6, { color: trunkColour, kind: KIND.SURFACE, seed: 0, capTop: false });
  // a couple of branches so the trunk isn't a bare pole
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + rng() * 0.8;
    const y = trunkH * (0.62 + i * 0.12);
    b.box(Math.cos(a) * 0.35, y, Math.sin(a) * 0.35, 0.5, 0.09, 0.09, {
      color: trunkColour,
      kind: KIND.SURFACE,
      seed: 0.1,
    });
  }

  const cy = trunkH * 0.75;
  const ch = canopyR * 2.0 * (sp.tall ?? 1);
  const cw = canopyR * 2.1 * (sp.wide ?? 1);
  const centre = cy + ch * 0.5;

  /*
   * The crown is a SCATTER of smaller clusters, not a rosette of full-width cards through the
   * trunk axis. A rosette is cheap but it has two tells that no amount of shading hides: every
   * card is edge-on from some angle, which draws a hard vertical seam straight down the middle
   * of the tree, and the silhouette is perfectly symmetric about that seam. Offsetting each
   * cluster off-axis, varying its size and letting its plane face a random way costs the same
   * per-quad and gives an irregular outline that survives being looked at from the road.
   */
  const n = sp.cards + 2;
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + rng.range(-0.55, 0.55);
    const rad = canopyR * (i === 0 ? 0.1 : rng.range(0.3, 0.62));
    const s = i === 0 ? rng.range(0.86, 1.0) : rng.range(0.5, 0.82);
    const hh = ch * s * rng.range(0.85, 1.12);
    const face = rng() * Math.PI;
    const rect = CityTextures.canopyRect(sp.cells[i % sp.cells.length]);
    card(
      b,
      Math.cos(az) * rad,
      cy + (ch - hh) * rng.range(0.05, 0.72),
      Math.sin(az) * rad,
      Math.cos(face),
      Math.sin(face),
      cw * s,
      hh,
      rect,
      leafCol,
      centre,
      canopyR,
      (sp.droop ?? 0) * -canopyR * 0.22,
      i % 2 === 1
    );
  }
  // two tilted caps so the crown has volume when seen from above
  const capRect = CityTextures.canopyRect(sp.cells[0]);
  card(b, 0, cy + ch * 0.52, 0, 1, 0, cw * 0.8, ch * 0.5, capRect, leafCol, centre, canopyR, canopyR * 0.5);
  card(b, 0, cy + ch * 0.52, 0, 0, 1, cw * 0.8, ch * 0.5, capRect, leafCol, centre, canopyR, -canopyR * 0.5, true);

  const geo = b.geometry('tree');
  geo.userData = { height: trunkH + ch, radius: canopyR };
  return geo;
}

/** Grass tufts, hedges and planter greenery, merged straight into the sector. */
export class GroundCover {
  constructor() {
    this.b = new GeoBuilder();
  }

  tuft(x, y, z, s, rng) {
    const c = col(rng.pick([0x7d8a52, 0x6d7a46, 0x88914f, 0x5f6e3e]));
    const w = s * rng.range(0.8, 1.5);
    const h = s * rng.range(0.5, 1.1);
    for (let i = 0; i < 2; i++) {
      const a = rng() * Math.PI;
      const rect = CityTextures.grassRect(rng.int(0, 3));
      card(this.b, x, y, z, Math.cos(a), Math.sin(a), w, h, rect, c, y + h * 0.5, h * 0.5, 0, rng.chance(0.5));
    }
  }

  hedge(x, y, z, len, dirX, dirZ, height, rng) {
    const c = col(rng.pick([0x54703c, 0x466034, 0x5d7745, 0x3f5730]));
    const steps = Math.max(2, Math.round(len / 1.1));
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps - 0.5;
      const px = x + dirX * len * t;
      const pz = z + dirZ * len * t;
      const w = (len / steps) * 1.5;
      // alternate cells and mirroring along the run so a long hedge is not one card tiled
      const rect = CityTextures.shrubRect(2 + (i % 2));
      const fl = i % 2 === 1;
      card(this.b, px, y, pz, dirX, dirZ, w, height, rect, c, y + height * 0.5, height * 0.5, 0, fl);
      card(this.b, px, y, pz, -dirZ, dirX, height * 1.1, height, rect, c, y + height * 0.5, height * 0.5, 0, !fl);
    }
  }

  bush(x, y, z, r, rng) {
    const c = col(rng.pick([0x5c7440, 0x496038, 0x67804a, 0x415634]));
    for (let i = 0; i < 2; i++) {
      const a = (i / 2) * Math.PI + rng() * 0.6;
      const rect = CityTextures.shrubRect(rng.int(0, 3));
      card(this.b, x, y, z, Math.cos(a), Math.sin(a), r * 2.1, r * 1.7, rect, c, y + r * 0.85, r, 0, i === 1);
    }
  }

  get isEmpty() {
    return this.b.isEmpty;
  }
  geometry() {
    return this.b.geometry('groundcover');
  }
}

export { _q };
