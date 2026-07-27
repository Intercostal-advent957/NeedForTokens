import * as THREE from 'three';
import {
  loftBody,
  domeCap,
  smoothNormals,
  mergeGeos,
  stationHalfWidths,
  lerp,
  clamp,
  clamp01,
} from './CarLoft.js';

/**
 * The shell: one continuous lofted surface carrying BOTH the painted panels and the glass
 * (as a second material group), so the greenhouse follows the body with zero seam and the
 * silhouette is a single curve. Wheel arches are cut into that surface; shut lines are inset
 * grooves that ride on it.
 */

// ---------------------------------------------------------------- station expansion

/** Normalised station -> metric station. z:-1..1 (*L/2), y:*H, w:*W/2 */
/** Wheel-hub height at rest, in car-local space. See PhysicsSystem._stepVehicle. */
export function staticHubY(def) {
  const penStatic = (def.mass * 9.81 * 0.25) / Math.max(def.suspension.stiffness, 1);
  return def.cog.y - def.suspension.travel + Math.min(penStatic, def.suspension.travel);
}

export function expandStations(list, L, W, H) {
  return list.map((s) => ({
    z: s.z * (L / 2),
    yb: (s.yb ?? 0.16) * H,
    ys: (s.ys ?? 0.24) * H,
    w: (s.w ?? 1) * (W / 2),
    ybelt: (s.ybelt ?? 0.62) * H,
    wbelt: (s.wbelt ?? 0.94) * (W / 2),
    yroof: (s.yroof ?? 0.7) * H,
    wroof: (s.wroof ?? 0.7) * (W / 2),
    crown: s.crown ?? 0.5,
    tuck: s.tuck ?? 0.5,
    flank: s.flank ?? 0.5,
  }));
}

/**
 * Guarantee the bodywork actually covers its own wheels.
 *
 * The hand-authored stations describe a silhouette; nothing in them knows how big the tyre is.
 * On several cars the front wing crown sat BELOW the top of the front tyre, so the wheel stood
 * proud of the arch and the arch cut had to eat through the whole wing to fit. This lifts the
 * roof/belt line and widens the flank over each axle by exactly as much as the wheel needs,
 * blended out with a smoothstep so it reads as a fender blister rather than a step.
 *
 * @param {Array}  stations metric stations (mutated in place)
 * @param {number} axleZ    axle centre in car space
 * @param {number} topNeed  minimum body top over the axle
 * @param {number} halfNeed minimum body half-width over the axle
 * @param {number} span     blend radius in Z
 */
function blisterOverAxle(stations, axleZ, topNeed, halfNeed, span) {
  for (const s of stations) {
    const u = 1 - Math.min(1, Math.abs(s.z - axleZ) / span);
    if (u <= 0) continue;
    const k = u * u * (3 - 2 * u);
    if (s.yroof < topNeed) s.yroof += (topNeed - s.yroof) * k;
    const beltNeed = topNeed - (topNeed - s.ys) * 0.16;
    if (s.ybelt < beltNeed) s.ybelt += (beltNeed - s.ybelt) * k * 0.85;
    if (s.w < halfNeed) s.w += (halfNeed - s.w) * k;
    if (s.wbelt < halfNeed - 0.035) s.wbelt += (halfNeed - 0.035 - s.wbelt) * k;
    if (s.wroof > s.wbelt) s.wroof = s.wbelt * 0.98;
  }
}

/**
 * Tuck the tail.
 *
 * The loft is capped with a flat fan at the last station, so whatever cross-section that station
 * has becomes a literal slab bolted to the back of the car. Left alone it is a 1.7 x 0.6 m
 * featureless red wall — the single boxiest thing on the model. Narrowing the last stations and
 * lifting the underfloor turns it into a tapered tail with an undercut the diffuser sits in.
 */
function tuckTail(stations, L) {
  const zEnd = stations[stations.length - 1].z;
  const span = L * 0.15;
  for (const s of stations) {
    const u = 1 - Math.min(1, (zEnd - s.z) / span);
    if (u <= 0) continue;
    const k = u * u;
    s.yb += (s.ys - s.yb) * 0.8 * k; // undercut: the rear valance lifts off the road
    s.w *= 1 - 0.15 * k;
    s.wbelt *= 1 - 0.13 * k;
    s.wroof *= 1 - 0.1 * k;
    s.ybelt -= (s.ybelt - s.ys) * 0.06 * k;
  }
}

/** Keep the profile control points ordered after the blister pass. */
function sanitiseStations(stations) {
  for (const s of stations) {
    s.yb = Math.min(s.yb, s.ys - 0.008);
    s.ys = Math.min(s.ys, s.ybelt - 0.02);
    s.ybelt = Math.min(s.ybelt, s.yroof - 0.02);
    s.wbelt = Math.min(s.wbelt, s.w);
    s.wroof = Math.min(s.wroof, s.wbelt);
  }
}

// ---------------------------------------------------------------- glass classification

function beltAt(stations, z) {
  let i = 1;
  while (i < stations.length - 1 && stations[i].z < z) i++;
  const a = stations[i - 1],
    b = stations[i];
  const t = clamp01((z - a.z) / Math.max(b.z - a.z, 1e-6));
  return {
    belt: lerp(a.ybelt, b.ybelt, t),
    roof: lerp(a.yroof, b.yroof, t),
    wroof: lerp(a.wroof, b.wroof, t),
  };
}

// ---------------------------------------------------------------- shut lines

/**
 * A shut line is a narrow inset band riding on the body surface. Even 4 mm of inset groove
 * reads at 1080p — it is the single cheapest thing that stops a car looking like a solid blob.
 */
const _sp = new THREE.Vector3();
const _sq = new THREE.Vector3();
const _sr = new THREE.Vector3();
const _sn = new THREE.Vector3();
const _se1 = new THREE.Vector3();
const _se2 = new THREE.Vector3();

/**
 * Bilinear sample of the loft grid at FRACTIONAL station/ring coordinates.
 *
 * This is what makes real panel gaps possible: station spacing is ~6 cm, so snapping a groove
 * to whole stations gives you a 13 cm black stripe instead of a 6 mm shut line.
 */
function sampleGrid(grid, S, RING, fi, fj, out) {
  const i0 = Math.max(0, Math.min(S - 2, Math.floor(fi)));
  const ti = Math.max(0, Math.min(1, fi - i0));
  const j0 = ((Math.floor(fj) % RING) + RING) % RING;
  const tj = fj - Math.floor(fj);
  const j1 = (j0 + 1) % RING;
  const a = (i0 * RING + j0) * 3;
  const b = (i0 * RING + j1) * 3;
  const c = ((i0 + 1) * RING + j0) * 3;
  const d = ((i0 + 1) * RING + j1) * 3;
  for (let k = 0; k < 3; k++) {
    const top = grid[a + k] + (grid[b + k] - grid[a + k]) * tj;
    const bot = grid[c + k] + (grid[d + k] - grid[c + k]) * tj;
    out.setComponent(k, top + (bot - top) * ti);
  }
  return out;
}

/** Outward surface normal at a fractional grid coordinate. */
function gridNormal(grid, S, RING, fi, fj, out) {
  sampleGrid(grid, S, RING, fi, fj, _sp);
  sampleGrid(grid, S, RING, Math.min(fi + 0.35, S - 1), fj, _sq);
  sampleGrid(grid, S, RING, fi, fj + 0.35, _sr);
  _se1.subVectors(_sq, _sp);
  _se2.subVectors(_sr, _sp);
  out.crossVectors(_se2, _se1).normalize();
  if (!Number.isFinite(out.x)) out.set(0, 1, 0);
  return out;
}

/**
 * Build a 3-row band along a parametric path on the surface. `pathFn(t)` returns
 * [stationF, ringF]; `halfWidth` is in *grid units* perpendicular to the run.
 *
 * The band stands PROUD of the panel, it is not sunk into it.
 *
 * Sinking it was the obvious thing to do — a shut line is a groove — but the loft has no hole
 * for it to sit in, so a sunk band is geometrically BEHIND the panel everywhere and can only be
 * made visible with a slope-scaled polygon offset. At a grazing angle that offset explodes, and
 * the band erupts through the paint as a comb of dark spikes, one per station, all down the
 * rocker. Standing it 0.2–1.1 mm off the surface instead makes it unambiguously in front from
 * every angle: no depth fight is possible, and a dark strip with a lit lip either side reads as
 * a panel gap just as well as a real groove does at any distance a player will ever see it.
 */
function groove(grid, S, RING, steps, pathFn, alongStation, halfWidth, relief) {
  const verts = [];
  const idx = [];
  for (let s = 0; s <= steps; s++) {
    const [fi, fj] = pathFn(s / steps);
    gridNormal(grid, S, RING, fi, fj, _sn);
    // Lips stand tall, the floor between them almost touches the panel: a shallow dark valley.
    for (const [off, depth] of [
      [-halfWidth, 1.0],
      [0, 0.16],
      [halfWidth, 1.0],
    ]) {
      // Width is measured ACROSS the run, never along it. Getting this backwards collapses the
      // band into sliver triangles that shimmer through the panel.
      const si = alongStation ? fi + off : fi;
      const sj = alongStation ? fj : fj + off;
      sampleGrid(grid, S, RING, Math.max(0, Math.min(S - 1, si)), sj, _sp);
      verts.push(
        _sp.x + _sn.x * relief * depth,
        _sp.y + _sn.y * relief * depth,
        _sp.z + _sn.z * relief * depth
      );
    }
  }
  for (let s = 0; s < steps; s++)
    for (let k = 0; k < 2; k++) {
      const a = s * 3 + k,
        b = (s + 1) * 3 + k;
      idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Build an inner shell: the body surface pushed inward, drawn BackSide in a dark material.
 *  Without it a car with glass is see-through — you look straight out the far window. */
export function innerShell(shellGeo, d = 0.035) {
  const g = shellGeo.clone();
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    // Normal offset plus a small pull toward the centreline: pure normal offset alone pops
    // through the panel on tight convex-to-concave transitions (haunches, arch lips).
    pos.setXYZ(
      i,
      (pos.getX(i) - nor.getX(i) * d) * 0.978,
      pos.getY(i) - nor.getY(i) * d,
      pos.getZ(i) - nor.getZ(i) * d
    );
  }
  g.clearGroups();
  pos.needsUpdate = true;
  return g;
}

// ---------------------------------------------------------------- arch liners

/**
 * The arch lip: a swept tube riding on the exact arch circle.
 *
 * A quad grid can only cut a hole on cell boundaries, so the raw opening is a staircase up to one
 * cell outside the true arc. The lip is the part that makes that irrelevant — it is a perfect
 * circle, it is painted body colour, and it is fat enough to bury the staircase behind it. Real
 * cars have exactly this: a rolled fender lip standing proud of the flank.
 *
 * @param {number} side  -1 | +1
 * @param {(z:number)=>number} outerAt body half-width at a given Z
 */
function archLip(side, zc, yc, r, outerAt, { radial = 0.052, out = 0.024, mid = 0.03 } = {}) {
  const seg = 40;
  const tube = 10;
  const a0 = -0.3;
  const a1 = Math.PI + 0.3;
  const verts = [];
  const uvs = [];
  const idx = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const a = lerp(a0, a1, t);
    const cz = Math.cos(a);
    const sy = Math.sin(a);
    const flank = outerAt(zc + cz * r) + 0.006;
    // Taper the tube away at both ends so it melts into the sill instead of stopping dead.
    const fade = Math.min(1, Math.min(t, 1 - t) * 7 + 0.34);
    for (let j = 0; j < tube; j++) {
      const p = (j / tube) * Math.PI * 2;
      const rr = r + mid + Math.cos(p) * radial * fade;
      verts.push(side * (flank + Math.sin(p) * out * fade), yc + sy * rr, zc + cz * rr);
      uvs.push(t * 4, j / tube);
    }
  }
  for (let i = 0; i < seg; i++)
    for (let j = 0; j < tube; j++) {
      const j2 = (j + 1) % tube;
      const a = i * tube + j;
      const b = (i + 1) * tube + j;
      const c = (i + 1) * tube + j2;
      const d = i * tube + j2;
      if (side > 0) idx.push(a, b, c, a, c, d);
      else idx.push(a, c, b, a, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * The wheel well.
 *
 * Cutting the arch open exposes the inside of a single-skinned shell — the arches read as flat
 * black voids, which is the loudest "this is a hobby model" tell a car can have. A real car has
 * a moulded liner: the outer skin rolls over the arch lip, runs inboard along the top of the
 * tyre, and closes onto an inner wall behind the wheel. That is exactly the cross-section swept
 * here, revolved about the axle axis.
 *
 * @param {number} side   -1 | +1
 * @param {number} zc     axle Z
 * @param {number} yc     arch centre Y
 * @param {number} r      arch radius (the opening the shell was cut to)
 * @param {(z:number)=>number} outerAt  body half-width at a given Z — the rim rides on it
 * @param {number} innerX inboard wall X (inboard of the tyre's inner face)
 */
function archLiner(side, zc, yc, r, outerAt, innerX) {
  // (radiusScale, x-offset-from-outer, blend-to-inner). Rim first, then the roll, the well
  // ceiling, the inner corner and finally the closing wall down to the hub.
  const section = [
    [1.035, 0.012, 0],
    [1.002, -0.014, 0],
    [0.975, -0.05, 0.18],
    [0.955, 0, 0.62],
    [0.94, 0, 1],
    [0.62, 0, 1],
    [0.26, 0, 1],
    [0.05, 0, 1],
  ];
  const seg = 26;
  const P = section.length;
  const a0 = -0.34;
  const a1 = Math.PI + 0.34;
  const verts = [];
  const uvs = [];
  const idx = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const a = lerp(a0, a1, t);
    const cz = Math.cos(a);
    const sy = Math.sin(a);
    const outer = outerAt(zc + cz * r);
    for (let j = 0; j < P; j++) {
      const [rs, dx, blend] = section[j];
      const x = lerp(outer + dx, innerX, blend);
      verts.push(side * x, yc + sy * r * rs, zc + cz * r * rs);
      uvs.push(t * 3.2, j / (P - 1));
    }
  }
  for (let i = 0; i < seg; i++)
    for (let j = 0; j < P - 1; j++) {
      const a = i * P + j;
      const b = (i + 1) * P + j;
      const c = (i + 1) * P + j + 1;
      const d = i * P + j + 1;
      if (side > 0) idx.push(a, b, c, a, c, d);
      else idx.push(a, c, b, a, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- main

/**
 * @returns {{ shell: THREE.BufferGeometry, glassGroups:boolean, grid, rings, ringLen, zs,
 *             grooves: THREE.BufferGeometry, liners: THREE.BufferGeometry, cabin:{z0,z1,beltY,roofY} }}
 */
export function buildShell(def, quality = 1) {
  const L = def.length;
  const W = def.width;
  const H = def.height;
  const b = def.body;
  const stations = expandStations(b.stations, L, W, H);

  // Three LODs. Even the mid tier keeps a properly resolved shell — the silhouette is what
  // reads at race distance, so we cut wheel/detail density long before we cut the body.
  // Density matters most at the wheel openings: the arch hole can only be cut on cell edges, so
  // the staircase the lip has to hide is exactly one cell wide.
  // The ring count (K) is what resolves the ROOF ARC and the shoulder roll — the two places a
  // blind critique kept calling "countable polys" — because those are curvature across the
  // section, not along the car. 26 gave ~6 samples over the whole crown. A shell at this
  // density is ~15k triangles; the budget is 2.5M, so this was never a cost decision.
  const S = quality >= 0.9 ? 116 : quality >= 0.55 ? 80 : 44;
  const K = quality >= 0.9 ? 34 : quality >= 0.55 ? 26 : 17;
  const shutLines = quality >= 0.55;

  // The hub does NOT sit at wheelRadius. PhysicsSystem hangs the wheel off a hardpoint at
  // cog.y and lets the spring compress, so at rest the hub is at
  //     cog.y - suspension.travel + staticCompression
  // Sizing the arch around wheelRadius instead buries the tyre in the fender.
  const hubY = staticHubY(def);
  const axleF = -def.wheelbase / 2;
  const axleR = def.wheelbase / 2;
  // Arch radius is clamped to a realistic gap over the tyre. 1.24 (as one def asked for) puts
  // the rim 8.5 cm off the tread and forces a fender lift nobody wants; 1.06 clips the tyre.
  const archScale = clamp(b.archScale ?? 1.14, 1.08, 1.18);
  const archR = def.wheelRadius * archScale;
  const archY = hubY + def.wheelRadius * 0.02;
  const rearScale = clamp(b.rearArch ?? 1.02, 0.98, 1.08);
  const arches = [
    { z: axleF, y: archY, r: archR, lipOut: b.archLip ?? 0.014, inner: 0.56 },
    { z: axleR, y: archY, r: archR * rearScale, lipOut: b.archLip ?? 0.014, inner: 0.56 },
  ];

  // ---- make the body big enough to contain its own wheels ----
  // Verified numerically in buildShell's return value: `clearance` must stay positive or the
  // tyre stands proud of the wing (which is exactly what shipped before).
  // + 0.10 leaves room for the arch lip tube (which tops out at r + 0.082) under the wing crown.
  const tyreOuterX = def.track / 2 + def.wheelWidth / 2;
  tuckTail(stations, L);
  for (const a of arches) {
    blisterOverAxle(stations, a.z, a.y + a.r + 0.1, tyreOuterX + 0.028, a.r * 2.15);
  }
  sanitiseStations(stations);

  const cabZ0 = (b.cabZ0 ?? -0.28) * (L / 2);
  const cabZ1 = (b.cabZ1 ?? 0.6) * (L / 2);

  // Glass = everything above the beltline inside the cabin z-range, excluding the roof crown.
  const group = (i, j, grid, RING) => {
    let above = 0;
    for (const [ii, jj] of [
      [i, j],
      [i + 1, j],
      [i, (j + 1) % RING],
      [i + 1, (j + 1) % RING],
    ]) {
      const o = (ii * RING + jj) * 3;
      const x = grid[o],
        y = grid[o + 1],
        z = grid[o + 2];
      if (z < cabZ0 || z > cabZ1) return 0;
      const ba = beltAt(stations, z);
      const roofBand = ba.roof - (ba.roof - ba.belt) * (b.roofBand ?? 0.16);
      const isRoof = y > roofBand && Math.abs(x) < ba.wroof * 1.02;
      if (y > ba.belt + 0.004 && !isRoof) above++;
    }
    return above === 4 ? 1 : 0;
  };

  const loft = loftBody({
    stations,
    rings: S,
    half: K,
    arches,
    group,
    groupCount: 2,
    warp: b.warp ?? null,
  });

  const { grid, rings, ringLen, zs } = loft;

  // ---- domed nose & tail closures, welded into the shell BEFORE the normals are solved ----
  // Smoothing the caps as a separate geometry leaves a hard shading break right across the nose
  // and the tail panel, which is most of why they read as bolted-on slabs. Merging first means
  // one continuous normal field from bumper to bumper.
  // The domes push the real nose/tail surface PAST the last grid station, and every detail on
  // this car is anchored by probing that grid. Keep them shallow and publish the overhang as
  // `domeF` / `domeR` so lamps, badges and the splitter can be biased onto the true surface
  // instead of being swallowed by it.
  const domeF = L * 0.016;
  const domeR = L * 0.011;
  const caps = mergeGeos([
    // The nose dome is the tightest curvature on the whole car; 4 rows made the highlight run
    // off it in visible steps.
    domeCap(grid, rings, ringLen, 0, domeF, true, 0.3, 7),
    domeCap(grid, rings, ringLen, rings - 1, domeR, false, 0.8, 6),
  ]);
  const shellGroups = loft.geometry.groups.map((g) => ({ ...g }));
  const shellVerts = loft.geometry.attributes.position.count;
  const welded = mergeGeos([loft.geometry, caps]);
  for (const g of shellGroups) welded.addGroup(g.start, g.count, g.materialIndex);
  welded.addGroup(shellVerts, caps.attributes.position.count, 0);
  const shell = smoothNormals(welded, b.smooth ?? 46);

  // ---- shut lines ----
  const grooves = [];
  const zToStation = (z) => {
    let best = 0,
      bd = 1e9;
    for (let i = 0; i < rings; i++) {
      const d = Math.abs(zs[i] - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  // A real shut line is 4–8 mm. Station spacing here is ~6 cm, so the groove half-width is
  // expressed as a FRACTION of a station and sampled bilinearly.
  // How far the shut-line lips stand off the panel. 1.1 mm is a real panel step and, crucially,
  // is orders of magnitude more than any depth-buffer slop at chase distance.
  const relief = 0.0011;
  const stationLen = L / rings;
  const gapHalf = 0.005 / stationLen; // ~10 mm total gap: below this it is sub-pixel and dashes
  const K2 = K;
  // A shut line that crosses a wheel opening hangs in mid-air inside the well. Push any that
  // land inside an arch out to the nearest edge of it.
  const clearOfArches = (z) => {
    for (const a of arches) {
      if (Math.abs(z - a.z) < a.r * 1.08) {
        return z < a.z ? a.z - a.r * 1.1 : a.z + a.r * 1.1;
      }
    }
    return z;
  };
  if (shutLines) {
    for (const zz of b.shutZ ?? [-0.55, 0.1, 0.68]) {
      const st = zToStation(clamp(clearOfArches(zz * (L / 2)), -L / 2 + 0.2, L / 2 - 0.2));
      // Two runs so the groove skips the underbody centre.
      for (const [j0, j1] of [
        [3, K2 - 3],
        [K2 + 1, 2 * K2 - 5],
      ]) {
        grooves.push(
          groove(grid, rings, ringLen, j1 - j0, (t) => [st, j0 + t * (j1 - j0)], true, gapHalf, relief)
        );
      }
    }
    // beltline / door-top swage running the length of the cabin
    const beltRing = K * 0.62;
    const i0 = zToStation(cabZ0 * 0.98);
    const i1 = zToStation(cabZ1 * 0.98);
    const ringHalf = 0.05 * (K / 26);
    if (i1 > i0 + 2) {
      for (const rIdx of [beltRing, ringLen - beltRing]) {
        grooves.push(
          groove(grid, rings, ringLen, i1 - i0, (t) => [i0 + t * (i1 - i0), rIdx], false, ringHalf, relief * 0.5)
        );
      }
    }
    // sill / rocker crease — run it only over the spans of body BETWEEN the wheel openings,
    // otherwise it strings a black thread straight across each arch.
    const sillRing = K * 0.26;
    const spans = [];
    let cursor = -L / 2 + 0.14;
    for (const a of [...arches].sort((p, q) => p.z - q.z)) {
      if (a.z - a.r * 1.12 > cursor + 0.2) spans.push([cursor, a.z - a.r * 1.12]);
      cursor = Math.max(cursor, a.z + a.r * 1.12);
    }
    if (L / 2 - 0.14 > cursor + 0.2) spans.push([cursor, L / 2 - 0.14]);
    for (const [za, zb] of spans) {
      const i0 = zToStation(za);
      const i1 = zToStation(zb);
      if (i1 - i0 < 3) continue;
      for (const rIdx of [sillRing, ringLen - sillRing]) {
        grooves.push(
          groove(grid, rings, ringLen, i1 - i0, (t) => [i0 + t * (i1 - i0), rIdx], false, ringHalf, relief * 0.45)
        );
      }
    }
  }

  // ---- arch liners ----
  const halfW = stationHalfWidths(grid, rings, ringLen);
  const outerAt = (z) => {
    let best = 0;
    let bd = 1e9;
    for (let i = 0; i < rings; i++) {
      const d = Math.abs(zs[i] - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return halfW[best];
  };
  // Inner wall sits inboard of the tyre's inner face so the well is a real cavity, not a decal.
  const innerX = Math.max(0.14, def.track / 2 - def.wheelWidth / 2 - 0.05);
  const liners = [];
  const lips = [];
  for (const a of arches) {
    for (const s of [-1, 1]) {
      liners.push(archLiner(s, a.z, a.y, a.r, outerAt, innerX));
      lips.push(archLip(s, a.z, a.y, a.r, outerAt, { out: (b.archLip ?? 0.016) + 0.012 }));
    }
  }

  // ---- numeric self-check (surfaces the exact defects that shipped) ----
  const diag = { minHalf: 1e9, maxHalf: 0, zMonotone: true, ringFlat: true };
  for (let i = 0; i < rings; i++) {
    if (i && zs[i] <= zs[i - 1]) diag.zMonotone = false;
    let mx = 0;
    let zmin = 1e9;
    let zmax = -1e9;
    for (let j = 0; j < ringLen; j++) {
      const bb = (i * ringLen + j) * 3;
      mx = Math.max(mx, Math.abs(grid[bb]));
      zmin = Math.min(zmin, grid[bb + 2]);
      zmax = Math.max(zmax, grid[bb + 2]);
    }
    if (zmax - zmin > 1e-4) diag.ringFlat = false;
    diag.minHalf = Math.min(diag.minHalf, mx);
    diag.maxHalf = Math.max(diag.maxHalf, mx);
  }
  diag.archClearance = outerAt(axleF) - (def.track / 2 + def.wheelWidth / 2);
  diag.archOverTyre = archY + archR - (hubY + def.wheelRadius);

  return {
    shell,
    grooves: grooves.length ? smoothNormals(mergeGeos(grooves), 60) : null,
    liners: smoothNormals(mergeGeos(liners), 62),
    lips: smoothNormals(mergeGeos(lips), 52),
    grid,
    rings,
    ringLen,
    zs,
    K,
    halfW,
    diag,
    domeF,
    domeR,
    cabin: { z0: cabZ0, z1: cabZ1 },
    arches,
    hubY,
    archTop: archY + archR,
  };
}

/**
 * Query helpers for hanging details ON the lofted surface rather than at guessed coordinates.
 * Placing a headlight at `-length/2` puts it in mid-air, because the nose station is a tapered
 * tip — you have to ask the surface where it actually is.
 */
export function surfaceProbe(grid, rings, ringLen, zs) {
  const idx = (i, j) => (i * ringLen + (((j % ringLen) + ringLen) % ringLen)) * 3;

  const station = (z) => {
    let best = 0,
      bd = 1e9;
    for (let i = 0; i < rings; i++) {
      const d = Math.abs(zs[i] - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };

  /** Highest point of the body at station z. */
  const topAt = (z) => {
    const i = station(z);
    let my = -1e9;
    for (let j = 0; j < ringLen; j++) my = Math.max(my, grid[idx(i, j) + 1]);
    return my;
  };

  /** Lowest point of the body at station z — where splitters and skirts must hang from. */
  const bottomAt = (z) => {
    const i = station(z);
    let my = 1e9;
    for (let j = 0; j < ringLen; j++) my = Math.min(my, grid[idx(i, j) + 1]);
    return my;
  };

  /**
   * Height of the underside of the body at station z, taken as the HIGHEST point of the lower
   * surface within `halfX` of the centreline.
   *
   * `bottomAt` returns the centreline of the floor pan, which on a tapered nose is far below the
   * bodywork out at the edges of a splitter blade — hang a blade there and it floats under the
   * car looking like a slab dropped on the road. Taking the maximum instead guarantees the blade
   * is buried in bodywork across its whole span.
   */
  const underEdgeY = (z, halfX) => {
    const i = station(z);
    let lo = 1e9;
    let hi = -1e9;
    for (let j = 0; j < ringLen; j++) {
      const y = grid[idx(i, j) + 1];
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    const mid = (lo + hi) * 0.5;
    let edge = lo;
    for (let j = 0; j < ringLen; j++) {
      const b = idx(i, j);
      if (grid[b + 1] > mid) continue; // lower surface only
      if (Math.abs(grid[b]) > halfX) continue;
      edge = Math.max(edge, grid[b + 1]);
    }
    return edge;
  };

  /** Widest half-width at station z, and the height at which it occurs. */
  const halfWidthAt = (z) => {
    const i = station(z);
    let mx = 0,
      my = 0;
    for (let j = 0; j < ringLen; j++) {
      const b = idx(i, j);
      if (grid[b] > mx) {
        mx = grid[b];
        my = grid[b + 1];
      }
    }
    return { x: mx, y: my };
  };

  /** Half-width of the body at a given height, at station z (how wide the nose is up high). */
  const widthAtHeight = (z, y) => {
    const i = station(z);
    let mx = 0;
    for (let j = 0; j < ringLen; j++) {
      const b = idx(i, j);
      if (Math.abs(grid[b + 1] - y) < 0.06) mx = Math.max(mx, grid[b]);
    }
    return mx;
  };

  /**
   * Front-most (or rear-most) surface z near a point (x, y). Returns null if the body has no
   * surface there — the caller can then pull the detail inboard/down until it does.
   */
  const faceZ = (x, y, front = true, tol = 0.11) => {
    // The search MUST be confined to the end of the car we are dressing. Without the gate the
    // scan runs the whole grid, so a tail lamp whose (x, y) happens not to exist on the rear
    // panel silently snaps to the front wheel arch — and the tail-light bar, which sweeps
    // through nine of these anchors, becomes a ribbon stretched from the boot lid to the front
    // axle. That was a real, shipped artefact, not a hypothetical.
    const zLo = zs[0];
    const zHi = zs[rings - 1];
    const gate = front ? zLo + (zHi - zLo) * 0.3 : zLo + (zHi - zLo) * 0.7;
    let bestZ = front ? 1e9 : -1e9;
    let found = false;
    for (let i = 0; i < rings; i++) {
      if (front ? zs[i] > gate : zs[i] < gate) continue;
      for (let j = 0; j < ringLen; j++) {
        const b = idx(i, j);
        if (Math.abs(grid[b] - x) > tol || Math.abs(grid[b + 1] - y) > tol) continue;
        const z = grid[b + 2];
        if (front ? z < bestZ : z > bestZ) {
          bestZ = z;
          found = true;
        }
      }
    }
    return found ? bestZ : null;
  };

  /** Place a detail on the front/rear face, sliding it inboard until it finds real bodywork. */
  const anchor = (x, y, front = true) => {
    for (const shrink of [1, 0.86, 0.72, 0.58, 0.44]) {
      const z = faceZ(x * shrink, y, front);
      if (z !== null) return { x: x * shrink, y, z };
    }
    // Nothing at that height on that face: widen the tolerance before giving up, so the detail
    // still lands on real bodywork rather than on a hard-coded station.
    for (const shrink of [1, 0.8, 0.6]) {
      const z = faceZ(x * shrink, y, front, 0.22);
      if (z !== null) return { x: x * shrink, y, z };
    }
    return { x: x * 0.4, y, z: front ? zs[2] : zs[rings - 3] };
  };

  return { station, topAt, bottomAt, underEdgeY, halfWidthAt, widthAtHeight, faceZ, anchor };
}

/** Sample the shell surface at a station/ring for placing details flush against the body. */
export function surfacePoint(grid, rings, ringLen, zs, z, ringIdx, out = new THREE.Vector3()) {
  let best = 0,
    bd = 1e9;
  for (let i = 0; i < rings; i++) {
    const d = Math.abs(zs[i] - z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  const j = ((Math.round(ringIdx) % ringLen) + ringLen) % ringLen;
  const b = (best * ringLen + j) * 3;
  return out.set(grid[b], grid[b + 1], grid[b + 2]);
}

/**
 * The SHOULDER at a given z: the highest point on the flank that is still within `frac` of the
 * station's widest half-width.
 *
 * `widthAt` returns the widest point, which is down at the hip — hang a wing mirror there and it
 * comes out level with the top of the front tyre, reading as a wart on the fender rather than a
 * mirror. The shoulder is where the flank starts turning into the greenhouse, which is the base
 * of the A-pillar: exactly where a door mirror is bolted on a real car.
 */
export function shoulderAt(grid, rings, ringLen, zs, z, frac = 0.9) {
  let best = 0;
  let bd = 1e9;
  for (let i = 0; i < rings; i++) {
    const d = Math.abs(zs[i] - z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  let mx = 0;
  for (let j = 0; j < ringLen; j++) mx = Math.max(mx, grid[(best * ringLen + j) * 3]);
  let y = -1e9;
  let x = mx;
  for (let j = 0; j < ringLen; j++) {
    const b = (best * ringLen + j) * 3;
    if (grid[b] < mx * frac) continue;
    if (grid[b + 1] > y) {
      y = grid[b + 1];
      x = grid[b];
    }
  }
  return { x, y: y > -1e8 ? y : 0 };
}

/** Widest half-width of the shell at a given z — used to sit mirrors, skirts, handles. */
export function widthAt(grid, rings, ringLen, zs, z) {
  let best = 0,
    bd = 1e9;
  for (let i = 0; i < rings; i++) {
    const d = Math.abs(zs[i] - z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  let mx = 0,
    my = 0;
  for (let j = 0; j < ringLen; j++) {
    const b = (best * ringLen + j) * 3;
    if (grid[b] > mx) {
      mx = grid[b];
      my = grid[b + 1];
    }
  }
  return { x: mx, y: my };
}
