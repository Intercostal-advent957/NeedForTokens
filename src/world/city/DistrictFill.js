import * as THREE from 'three';
import { GeoBuilder, KIND, col, tint } from './Geo.js';
import { terrainMeshY } from './CityGround.js';

/**
 * Everything between the playable blocks and the horizon.
 *
 * The circuit's infield alone is a quarter of a square kilometre; left empty it reads as a black
 * plain in any elevated shot. This lays a coarse street grid over the whole map — ground plates,
 * avenues, and blocks of boxed buildings using the procedural window grid — merged into a handful
 * of regional meshes. About 25k triangles for the entire background city.
 *
 * A plaza is deliberately kept open around the world origin: it is the natural civic space for a
 * street circuit, and it is where the establishing camera looks from.
 */

const CELL = 54;
const REGIONS = 4; // REGIONS × REGIONS merged meshes
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
  [0, 0],
];

export const PLAZA = [
  { x: 0, z: 0, r: 138 }, // civic plaza / establishing-shot foreground
];

export function buildDistrictFill(track, rng, opts = {}, world = null) {
  const near = opts.near ?? 168; // inside this, the real sectors own the ground
  const far = opts.far ?? 640; // beyond this, the skyline takes over
  const min = track.bounds.min;
  const max = track.bounds.max;
  const pad = far * 0.75;
  const x0 = min.x - pad;
  const z0 = min.z - pad;
  const nx = Math.ceil((max.x - min.x + pad * 2) / CELL);
  const nz = Math.ceil((max.z - min.z + pad * 2) / CELL);

  const builders = [];
  for (let i = 0; i < REGIONS * REGIONS; i++) builders.push(new GeoBuilder());
  const regionOf = (i, j) =>
    Math.min(REGIONS - 1, Math.floor((i / nx) * REGIONS)) * REGIONS +
    Math.min(REGIONS - 1, Math.floor((j / nz) * REGIONS));

  const p = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const blockCols = [0x6e7178, 0x5f636b, 0x787b80, 0x6a6a68, 0x545a63, 0x7d7a72];

  // Block interiors, picked per cell. Green space is one draw in eight and deliberate — a
  // background city that is all lawn is exactly the tell this pass exists to remove.
  const LOTS = [
    { color: 0x3a3e44, kind: KIND.LOT, lift: 0.05 },
    { color: 0x76736d, kind: KIND.SLAB, lift: 0.17 },
    { color: 0x86837c, kind: KIND.PAVEMENT, lift: 0.17 },
    { color: 0x726049, kind: KIND.DIRT, lift: 0.0 },
    { color: 0x33363c, kind: KIND.LOT, lift: 0.04 },
    { color: 0x46583a, kind: KIND.TURF, lift: 0.12 },
    { color: 0x7d7a73, kind: KIND.SLAB, lift: 0.16 },
    { color: 0x2f3238, kind: KIND.SERVICE, lift: 0.0 },
    { color: 0x6c5a44, kind: KIND.DIRT, lift: 0.0 },
    { color: 0x363a40, kind: KIND.LOT, lift: 0.05 },
    { color: 0x2c2f34, kind: KIND.SERVICE, lift: 0.0 },
  ];
  const AVENUE = { color: 0x2c2f34, kind: KIND.SERVICE, lift: 0.0 };
  const KERB_COL = col(0x9d9a92);

  const SUB = 3; // sub-quads per cell edge: keeps a 54 m plate within ~0.3 m of the heightfield
  const groundY = (x, z, fallback) => {
    const g = world?.sampleGround?.(x, z);
    let h = g && Number.isFinite(g.height) ? g.height : null;
    // Clear the terrain mesh as rasterised, not as interpolated — see terrainMeshY.
    const t = terrainMeshY(world, x, z);
    if (t !== null && (h === null || t > h)) h = t;
    // Deliberately lower than the apron's own clearance: the two overlap in a ring around
    // 140-240 m out, and a consistent 12 cm gap lets the apron win outright instead of the pair
    // of them z-fighting across half a square kilometre.
    return h === null ? fallback : h + 0.16;
  };

  let placed = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const cx = x0 + (i + 0.5) * CELL;
      const cz = z0 + (j + 0.5) * CELL;
      const proj = track.project(p.set(cx, 0, cz));
      const d = proj.distance;
      if (d < near || d > far) continue;
      let inPlaza = false;
      for (const pz of PLAZA) if (Math.hypot(cx - pz.x, cz - pz.z) < pz.r) inPlaza = true;

      const b = builders[regionOf(i, j)];
      // Sit on the track lane's terrain, not on our own guess at it.
      const gy = groundY(cx, cz, proj.height - 0.35);
      const avenue = i % 4 === 0 || j % 5 === 0;
      const lot = avenue ? AVENUE : LOTS[(i * 5 + j * 3 + ((i * j) & 3)) % LOTS.length];
      const seed = rng();

      // ---- ground plate. Subdivided and conformed: a single 54 m quad laid across a
      // heightfield with 26 m of relief floats metres above the ground on one corner and
      // buries itself on the other, and the track lane's grass pours through the seam.
      const ho = CELL * 0.5;
      const kerbIn = avenue || lot.lift < 0.05 ? 0 : 2.6; // kerbed band around the block edge
      const hi = ho - kerbIn;
      for (let sj = 0; sj < SUB; sj++) {
        for (let si = 0; si < SUB; si++) {
          const ax = cx - hi + (si * hi * 2) / SUB;
          const bx = cx - hi + ((si + 1) * hi * 2) / SUB;
          const az = cz - hi + (sj * hi * 2) / SUB;
          const bz = cz - hi + ((sj + 1) * hi * 2) / SUB;
          b.quad(
            [ax, groundY(ax, az, gy) + lot.lift, az],
            [bx, groundY(bx, az, gy) + lot.lift, az],
            [bx, groundY(bx, bz, gy) + lot.lift, bz],
            [ax, groundY(ax, bz, gy) + lot.lift, bz],
            { color: col(lot.color), kind: lot.kind, seed, w: (hi * 2) / SUB, h: (hi * 2) / SUB, u0: ax, v0: az }
          );
        }
      }
      // ---- mitred kerb skirt. The 17 cm step around a block is what reads as a street from
      // above; without it a district is a flat colour chart.
      if (kerbIn > 0) {
        for (let e = 0; e < 4; e++) {
          const ox = e === 0 ? 1 : e === 2 ? -1 : 0;
          const oz = e === 1 ? 1 : e === 3 ? -1 : 0;
          const tx = oz;
          const tz = -ox;
          const P = (o, t, lift) => {
            const x = cx + ox * o + tx * t;
            const z = cz + oz * o + tz * t;
            return [x, groundY(x, z, gy) + lift, z];
          };
          // u runs ALONG the kerb (a->b, one cell edge), v runs across it (a->d, the ramp).
          b.quad(P(ho, -ho, 0), P(ho, ho, 0), P(hi, hi, lot.lift), P(hi, -hi, lot.lift), {
            color: KERB_COL,
            kind: KIND.KERB,
            seed,
            w: CELL,
            h: kerbIn,
            u0: cx * ox + cz * oz,
            v0: 0,
          });
        }
      }
      // A park is a park: nothing gets built on the green cells.
      if (avenue || inPlaza || lot.kind === KIND.TURF) continue;

      // fade the density out toward the skyline so the transition isn't a wall
      const t = 1 - (d - near) / (far - near);
      if (rng() > 0.35 + t * 0.6) continue;

      const count = rng.chance(0.35) ? 2 : 1;
      for (let k = 0; k < count; k++) {
        const w = rng.range(16, count > 1 ? 24 : 40);
        const dd = rng.range(16, count > 1 ? 24 : 36);
        const ox = count > 1 ? (k - 0.5) * CELL * 0.42 : rng.range(-6, 6);
        const oz = count > 1 ? rng.range(-8, 8) : rng.range(-6, 6);
        const hub = 1 + Math.max(0, t - 0.45) * rng.range(1.0, 3.2);
        const h = rng.range(11, 44) * hub;
        const base = tint(blockCols[rng.int(0, blockCols.length - 1)], rng.range(0.75, 1.1));
        // Seat on the LOWEST footprint corner, not on the cell centre: a 40 m box dropped at
        // the centre height of a sloping cell hangs in the air on the downhill side.
        const bx = cx + ox;
        const bz = cz + oz;
        const hw = Math.max(w, dd) * 0.72;
        let seat = Infinity;
        for (const [sx, sz] of CORNERS) seat = Math.min(seat, groundY(bx + sx * hw, bz + sz * hw, gy));
        const by = Math.min(gy, seat) - 0.5;
        m.makeRotationY(rng() * Math.PI);
        m.setPosition(bx, by, bz);
        b.push(m);
        // plinth: closes any residual gap under the box on sloping ground
        b.box(0, (gy + 0.4 - by) * 0.5, 0, w + 0.7, Math.max(0.6, gy + 0.4 - by), dd + 0.7, {
          color: tint(0x4e5055, rng.range(0.85, 1.15)),
          kind: KIND.CONCRETE,
          seed: rng(),
          faces: 63 & ~4 & ~8,
        });
        let y = gy + 0.35 - by;
        let cw = w;
        let cd = dd;
        const stacks = h > 55 ? 2 : 1;
        for (let s = 0; s < stacks; s++) {
          const sh = s === stacks - 1 ? h - y : h * rng.range(0.5, 0.7);
          b.box(0, y + sh * 0.5, 0, cw, sh, cd, {
            color: base,
            kind: KIND.FARFACADE,
            seed: rng(),
            faces: 63 & ~8,
          });
          // parapet cap breaks the extruded-box silhouette
          b.box(0, y + sh + 0.5, 0, cw + 0.8, 1.0, cd + 0.8, {
            color: tint(0x4a4c50, rng.range(0.8, 1.2)),
            kind: KIND.CONCRETE,
            seed: rng(),
            faces: 63 & ~8,
          });
          y += sh;
          cw *= rng.range(0.6, 0.82);
          cd *= rng.range(0.6, 0.82);
        }
        if (h > 60 && rng.chance(0.5))
          b.box(0, h + 2.4, 0, 1.2, 1.4, 1.2, { color: tint(0xff3020, 1), kind: KIND.NEON, seed: 0.9 });
        b.pop();
        placed++;
      }
    }
  }

  const geos = [];
  for (const b of builders) if (!b.isEmpty) geos.push(b.geometry('district-fill'));
  return { geos, placed };
}
