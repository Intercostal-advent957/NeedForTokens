import * as THREE from 'three';
import { GeoBuilder, KIND, col } from './Geo.js';

/**
 * The apron: everything between the carriageway and the background district fill.
 *
 * Two jobs, and they used to fight each other.
 *
 * 1. NEAR THE ROAD it is a *street*: a gutter, a real kerb with a vertical face, a flagged
 *    pavement raised 15 cm above the channel, and a drop back down at the building line. The
 *    height difference is the whole point — a pavement painted flat onto the road plane reads
 *    as a texture swatch from the car and as nothing at all from the air.
 *
 * 2. AWAY FROM THE ROAD it is *urban ground*: service roads, parking lots with painted bays,
 *    concrete hardstanding, dirt yards and the occasional deliberate green space, zoned in
 *    coherent patches rather than sprinkled. Every one of those is a `KIND` on the shared city
 *    surface material, so the whole apron is still one draw per arc.
 *
 * The outer field is CONFORMED TO `world.sampleGround`, band by band. Previously the section
 * jumped straight from 40 m to 130 m to 240 m in single quads: over a heightfield with 26 m of
 * relief that leaves the apron floating 15 m in the air in places and buried in others, and the
 * track lane's grass pours through the gaps — which is exactly the "golf course" the QA aerial
 * was showing. Sampling every band boundary keeps the error inside a few centimetres.
 *
 * Over the tunnel the section lifts onto the deck, but only across the bore: past `DECK_HALF` it
 * ramps back down to the terrain instead of extending a 480 m table into the sky.
 */

// --- street section, lateral metres from the kerb line -----------------------------------
const KERB_TOP = 0.155; // pavement height above the road edge
const GUTTER = -0.17;

// [lateral, dy relative to the road edge, colour, kind]
const STREET = [
  [-0.55, GUTTER, 0x1f2225, KIND.ROAD], // gutter channel
  [0.0, GUTTER + 0.015, 0x24272b, KIND.ROAD],
  [0.0, KERB_TOP, 0xa8a49a, KIND.KERB], // vertical kerb face
  [0.36, KERB_TOP + 0.008, 0xb4b0a6, KIND.KERB], // kerb top
  [1.05, KERB_TOP, 0x8e8b85, KIND.PAVEMENT],
  [6.30, KERB_TOP - 0.01, 0x87847e, KIND.PAVEMENT],
  [6.60, 0.0, 0x7c7a74, KIND.KERB], // back kerb, drops to the block
];

// --- outer field band boundaries, lateral metres from the kerb line ----------------------
const OUTER = [6.6, 8.4, 11, 14.5, 19, 24.5, 31, 39, 49, 61, 76, 94, 116, 138, 162, 190, 215, 240];

// Zones. `lift` is metres above the conformed ground: paved surfaces are kerbed up, unmade
// ground sits low, so every zone change emits a riser and the block reads as built.
const ZONES = {
  service: { kind: KIND.SERVICE, color: 0x33373d, lift: 0.0 },
  lot: { kind: KIND.LOT, color: 0x393d43, lift: 0.04 },
  yard: { kind: KIND.LOT, color: 0x2d3036, lift: 0.02 },
  hard: { kind: KIND.SLAB, color: 0x6f6c66, lift: 0.16 },
  pave: { kind: KIND.PAVEMENT, color: 0x86837c, lift: 0.17 },
  dirt: { kind: KIND.DIRT, color: 0x66584a, lift: -0.02 },
  turf: { kind: KIND.TURF, color: 0x46583a, lift: 0.11 },
};

// Zone mix by distance out. The first 30 m off the kerb is forecourt, parking and alley — no
// lawn, because that band is what the car sees all race. Further out it becomes yards,
// hardstanding and waste ground, and green space stays deliberate at ~1 patch in 8.
const MIX_NEAR = ['lot', 'service', 'lot', 'pave', 'yard', 'lot', 'hard', 'lot'];
const MIX_MID = ['lot', 'hard', 'yard', 'service', 'lot', 'dirt', 'pave', 'turf'];
const MIX_FAR = ['yard', 'dirt', 'hard', 'dirt', 'lot', 'dirt', 'yard', 'turf'];

const RISER = 0.09; // half-width of the sloped step between two zones
const _zbuf = [];

const DECK_HALF = 30; // deck survives this far from the centreline over the tunnel…
const DECK_FALL = 24; // …then ramps back down to the terrain over this much
// Every cross-section point is either LOCKED TO THE ROAD (mode 0 — the street section, which
// has to track the carriageway however it banks) or LOCKED TO THE GROUND (mode 1 — the outer
// field). There is deliberately no gradual blend between them: while a point is part-way
// between the two it is below both, and the track lane's terrain punches straight through it.
// The step at the building line is absorbed by one riser quad instead.
const ROAD_LOCK = 0;
const GROUND_LOCK = 1;
const CLEAR = 0.28; // metres the field is held above the highest competing surface

export function buildApron(track, layout, arcs = 10, world = null) {
  const steps = 420;
  const perArc = Math.ceil(steps / arcs);
  const geos = [];

  const sample = (i) => {
    const t = (i % steps) / steps;
    const f = track.frameAt(t);
    const tb = layout.tunnelBlend(t);
    const wr = track.widthAt(t) * 1.35;
    const lat0 = lerp(wr + 0.05, 16.4, tb);
    const y = lerp(f.position.y, layout.deckY, tb);
    return { t, f, tb, lat0, y, s: t * track.length };
  };

  for (let a = 0; a < arcs; a++) {
    const b = new GeoBuilder();
    const i0 = a * perArc;
    const i1 = Math.min(steps, i0 + perArc);
    if (i1 <= i0) continue;
    let prev = sample(i0);
    for (let i = i0 + 1; i <= i1; i++) {
      const cur = sample(i);
      const h = cur.s - prev.s || 1;
      for (const side of [-1, 1]) {
        // ---- street section: gutter, kerb, pavement. Locked to the road.
        for (let k = 0; k < STREET.length - 1; k++) {
          const [l0, d0, c0, k0] = STREET[k];
          const [l1, d1] = STREET[k + 1];
          band(b, prev, cur, side, l0, d0, 0, l1, d1, 0, c0, k0, h, world, i * 0.137 + k * 0.31, 0, ROAD_LOCK);
        }
        // ---- the building line: one riser absorbing the whole step from the road-locked
        // pavement to the ground-locked block, whichever way it goes.
        {
          const l = OUTER[0];
          const z0 = zoneAt(Math.floor(prev.s / 33), 0, side);
          band(
            b, prev, cur, side,
            l - 0.12, 0, 0,
            l, 0, z0.lift,
            0x9c998f, KIND.KERB, h, world, (i * 0.53) % 1, 0, ROAD_LOCK, GROUND_LOCK
          );
        }

        // ---- outer field: zoned, terrain-conformed
        const blockA = Math.floor(prev.s / 33);
        const N = OUTER.length - 1;
        const zones = _zbuf;
        for (let k = 0; k < N; k++) zones[k] = zoneAt(blockA, k, side);
        for (let k = 0; k < N; k++) {
          const z = zones[k];
          // Pull the band back from any boundary that carries a step, so the riser owns that
          // strip outright instead of z-fighting the two surfaces it joins.
          const stepBefore = k > 0 && Math.abs(zones[k - 1].lift - z.lift) > 0.025;
          const stepAfter = k + 1 < N && Math.abs(zones[k + 1].lift - z.lift) > 0.025;
          const l0 = OUTER[k] + (stepBefore ? RISER : 0);
          const l1 = OUTER[k + 1] - (stepAfter ? RISER : 0);
          const seed = hash2(blockA * 7 + k * 13, side * 31 + k);
          band(b, prev, cur, side, l0, 0, z.lift, l1, 0, z.lift, z.color, z.kind, h, world, seed, l0, GROUND_LOCK);
          // The riser between two zones: the kerb that makes a lot read as a lot from the air.
          if (stepAfter) {
            const zn = zones[k + 1];
            const up = z.lift > zn.lift;
            band(
              b, prev, cur, side,
              l1, 0, z.lift,
              OUTER[k + 1] + RISER, 0, zn.lift,
              up ? 0xa5a29a : 0x94918a,
              KIND.KERB, h, world, seed + 0.37, l1, GROUND_LOCK
            );
          }
        }
      }
      prev = cur;
    }
    geos.push(b.geometry(`apron-${a}`));
  }
  return geos;
}

/** One cross-section band, stitched between two stations. `m0`/`m1` are the lock modes. */
function band(b, prev, cur, side, l0, d0, g0, l1, d1, g1, colour, kind, h, world, seed, u0 = 0, m0 = 0, m1 = m0) {
  const A = pt(prev, side, l0, d0, g0, world, m0);
  const B = pt(prev, side, l1, d1, g1, world, m1);
  const C = pt(cur, side, l1, d1, g1, world, m1);
  const D = pt(cur, side, l0, d0, g0, world, m0);
  const w = Math.max(0.02, Math.hypot(l1 - l0, B[1] - A[1]));
  const quad = side > 0 ? [A, B, C, D] : [D, C, B, A];
  b.quad(quad[0], quad[1], quad[2], quad[3], {
    color: Array.isArray(colour) ? colour : col(colour),
    kind,
    seed: seed % 1,
    w,
    h,
    u0,
    v0: prev.s,
  });
}

/**
 * A cross-section point.
 *
 * `dRoad` is metres relative to the carriageway edge (used by the street section, which must
 * stay locked to the road however the road banks); `dGround` is metres above the conformed
 * terrain (used by the outer field). `mode` picks between them — 0 or 1, never in between —
 * so the pavement cannot shear away from the kerb and the field cannot float over the height
 * field. The one exception is the tunnel deck, which damps `mode` back toward the structure.
 */
function pt(s, side, lat, dRoad, dGround, world, mode) {
  const l = s.lat0 + lat;
  const x = s.f.position.x + s.f.binormal.x * side * l;
  const z = s.f.position.z + s.f.binormal.z * side * l;
  let y = s.y + dRoad;
  if (!world) return [x, y, z];

  let blend = mode;
  if (s.tb > 0.01) {
    // The tunnel deck is a structure, not ground — but only across the bore. Past DECK_HALF it
    // gives way so the city does not sit on a 480 m table hanging over the valley.
    const hold = 1 - clamp01((l - DECK_HALF) / DECK_FALL);
    blend *= 1 - s.tb * hold;
  }
  if (blend <= 0) return [x, y, z];

  const g = world.sampleGround?.(x, z);
  let gh = g && Number.isFinite(g.height) ? g.height : null;
  if (gh === null) return [x, y, z];
  // Inside the road corridor `sampleGround` answers with the road cross-section, which the
  // track lane deliberately holds 0.5 m above its own terrain mesh. Outside it, the two are the
  // same surface. Taking the higher of the pair means the apron clears whichever one is
  // actually being rasterised, instead of sliding under the terrain in the overlap.
  const th = terrainMeshY(world, x, z);
  if (th !== null && th > gh) gh = th;
  const target = gh + CLEAR + dGround;
  y += (target - y) * blend;
  // A ground-locked point must never end up under the ground. The deck damping above pulls
  // `blend` a few percent off 1 for a long way either side of the tunnel, and a few percent of
  // a ten-metre deck is a ten-centimetre hole for the terrain to show through.
  if (mode === GROUND_LOCK && y < target) y = target;
  return [x, y, z];
}
/**
 * The height of the terrain mesh as it is actually RASTERISED, at a world XZ.
 *
 * `world.terrainAt` answers with the bilinear value, which is the right answer for physics but
 * not for hiding geometry: the mesh is triangulated on the anti-diagonal, and over a 22 m cell
 * with any twist in it the triangles stand up to ~25 cm proud of the bilinear surface. Laying
 * the city's ground on the bilinear height therefore leaves the track lane's terrain poking
 * through in exactly the places the QA aerial was picking up as stray grass. This evaluates the
 * same triangle the GPU draws.
 */
export function terrainMeshY(world, x, z) {
  const T = world?.terrain;
  if (!T) return null;
  const fx = (x - T.x0) / T.cell;
  const fz = (z - T.z0) / T.cell;
  const cx = Math.min(Math.max(fx, 0), T.nx - 1e-4);
  const cz = Math.min(Math.max(fz, 0), T.nz - 1e-4);
  const i = cx | 0;
  const j = cz | 0;
  const ux = cx - i;
  const uz = cz - j;
  const w = T.nx + 1;
  const h00 = T.h[j * w + i];
  const h10 = T.h[j * w + i + 1];
  const h01 = T.h[(j + 1) * w + i];
  const h11 = T.h[(j + 1) * w + i + 1];
  // WorldSystem indexes each cell as (a, a+nx+1, a+1) + (a+1, a+nx+1, a+nx+2) — the split runs
  // along the anti-diagonal, so ux+uz <= 1 is the h00 triangle.
  return ux + uz <= 1
    ? h00 + (h10 - h00) * ux + (h01 - h00) * uz
    : h11 + (h01 - h11) * (1 - ux) + (h10 - h11) * (1 - uz);
}

/**
 * Zoning. Coherent patches ~33 m along the road and one band deep, so you get a car park that
 * is actually car-park-shaped rather than per-quad confetti.
 */
function zoneAt(block, bandIdx, side) {
  const mix = bandIdx < 4 ? MIX_NEAR : bandIdx < 9 ? MIX_MID : MIX_FAR;
  // Neighbouring bands share a draw from a slowly-varying hash, which merges patches laterally.
  const r = hash2(block * 3 + (side > 0 ? 101 : 0), Math.floor(bandIdx * 0.7) * 17 + bandIdx);
  return ZONES[mix[Math.floor(r * mix.length) % mix.length]];
}

function hash2(a, b) {
  let t = ((a * 374761393 + b * 668265263) ^ 0x5f356495) >>> 0;
  t = Math.imul(t ^ (t >>> 13), 1274126177) >>> 0;
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

void THREE;
