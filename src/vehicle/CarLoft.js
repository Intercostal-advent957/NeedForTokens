import * as THREE from 'three';
import { catmull, clamp, clamp01, lerp } from '../core/MathX.js';

/**
 * Lofted-surface toolkit for hand-authored car bodies.
 *
 * A car body is a series of closed cross-section profiles ("stations") placed along the length
 * axis (Z). Each station is described by a handful of scalars (sill height, max half-width,
 * beltline, roof width/height...). We turn each station into a smooth closed 2D curve via
 * Catmull-Rom through control points, then Catmull-Rom AGAIN along Z between stations so the
 * surface has continuous curvature in both directions. The result is skinned into a quad grid.
 *
 * Wheel arches are OPENINGS in that surface, not displacements of it. Earlier versions projected
 * body vertices radially onto the arch circle; that scattered a single station across 40 cm of Z,
 * folded the loft through itself and tore the nose and tail off the car. The current code leaves
 * the grid pristine (Z stays monotone, half-width stays bounded) and instead marks the vertices
 * that fall inside the wheel opening, drops the quads that touch them, and snaps the surviving
 * rim row onto the arch arc. A separate swept liner fills the well behind it.
 *
 * Owned by the car-art lane. See CONTRACTS.md §8.
 */

// ---------------------------------------------------------------------------- normals

/**
 * Angle-thresholded vertex normals. Faces that meet at less than `angleDeg` are smoothed
 * together; sharper joints stay creased. This is the difference between a car that looks like
 * sheet metal and one that looks like crumpled foil.
 */
export function smoothNormals(geo, angleDeg = 42) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position.array;
  const triCount = pos.length / 9;
  const fn = new Float32Array(triCount * 3);
  const cosLimit = Math.cos((angleDeg * Math.PI) / 180);

  const ax = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const cx = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (let f = 0; f < triCount; f++) {
    const i = f * 9;
    ax.set(pos[i], pos[i + 1], pos[i + 2]);
    bx.set(pos[i + 3], pos[i + 4], pos[i + 5]);
    cx.set(pos[i + 6], pos[i + 7], pos[i + 8]);
    e1.subVectors(bx, ax);
    e2.subVectors(cx, ax);
    n.crossVectors(e1, e2);
    const l = n.length();
    if (l > 1e-12) n.divideScalar(l);
    else n.set(0, 1, 0);
    fn[f * 3] = n.x;
    fn[f * 3 + 1] = n.y;
    fn[f * 3 + 2] = n.z;
  }

  // Spatial hash of coincident vertices (1/10 mm buckets).
  const buckets = new Map();
  const key = (x, y, z) =>
    `${Math.round(x * 10000)},${Math.round(y * 10000)},${Math.round(z * 10000)}`;
  for (let v = 0; v < triCount * 3; v++) {
    const i = v * 3;
    const k = key(pos[i], pos[i + 1], pos[i + 2]);
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(v);
  }

  const out = new Float32Array(triCount * 9);
  for (const arr of buckets.values()) {
    for (let a = 0; a < arr.length; a++) {
      const va = arr[a];
      const fa = (va / 3) | 0;
      let nx = 0,
        ny = 0,
        nz = 0;
      const ax0 = fn[fa * 3],
        ay0 = fn[fa * 3 + 1],
        az0 = fn[fa * 3 + 2];
      for (let b = 0; b < arr.length; b++) {
        const fb = (arr[b] / 3) | 0;
        const d = ax0 * fn[fb * 3] + ay0 * fn[fb * 3 + 1] + az0 * fn[fb * 3 + 2];
        if (d >= cosLimit) {
          nx += fn[fb * 3];
          ny += fn[fb * 3 + 1];
          nz += fn[fb * 3 + 2];
        }
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      out[va * 3] = nx / l;
      out[va * 3 + 1] = ny / l;
      out[va * 3 + 2] = nz / l;
    }
  }
  g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return g;
}

// ---------------------------------------------------------------------------- curves

/** Catmull-Rom resample of an open polyline of [x,y] pairs into `n` evenly-parameterised points. */
export function resample2D(pts, n) {
  const m = pts.length;
  const ext = [pts[0], ...pts, pts[m - 1]];
  const out = new Array(n);
  const segs = m - 1;
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * segs;
    const s = Math.min(Math.floor(u), segs - 1);
    const t = u - s;
    const p0 = ext[s],
      p1 = ext[s + 1],
      p2 = ext[s + 2],
      p3 = ext[s + 3];
    out[i] = [
      catmull(p0[0], p1[0], p2[0], p3[0], t),
      catmull(p0[1], p1[1], p2[1], p3[1], t),
    ];
  }
  return out;
}

/** Catmull-Rom interpolation of a keyed scalar track: [{z, v}], sampled at z. */
function trackAt(keys, field, z) {
  const n = keys.length;
  if (z <= keys[0].z) return keys[0][field];
  if (z >= keys[n - 1].z) return keys[n - 1][field];
  let i = 1;
  while (i < n - 1 && keys[i].z < z) i++;
  const k1 = keys[i - 1],
    k2 = keys[i];
  const k0 = keys[Math.max(0, i - 2)],
    k3 = keys[Math.min(n - 1, i + 1)];
  const t = (z - k1.z) / Math.max(k2.z - k1.z, 1e-6);
  return catmull(k0[field], k1[field], k2[field], k3[field], t);
}

// ---------------------------------------------------------------------------- profile

const P_FIELDS = ['yb', 'ys', 'w', 'ybelt', 'wbelt', 'yroof', 'wroof', 'crown', 'tuck', 'flank'];

/**
 * Build the half cross-section (x >= 0) control polygon for one station.
 * Bottom centre -> underfloor -> sill -> widest point -> shoulder -> tumblehome -> roof rail -> crown.
 */
function halfProfile(p) {
  const { yb, ys, w, ybelt, wbelt, yroof, wroof, crown, tuck, flank } = p;
  const widest = Math.max(w, wbelt);
  const yWidest = lerp(ys, ybelt, 0.34 + flank * 0.3);
  return [
    [0, yb],
    [widest * 0.46, yb + tuck * 0.02],
    [widest * 0.84, ys - tuck * 0.03],
    [widest * 0.985, ys + (ybelt - ys) * 0.16],
    [widest, yWidest],
    [lerp(widest, wbelt, 0.66), lerp(yWidest, ybelt, 0.72)],
    [wbelt, ybelt],
    [lerp(wbelt, wroof, 0.52), lerp(ybelt, yroof, 0.55)],
    [lerp(wbelt, wroof, 0.88), lerp(ybelt, yroof, 0.9)],
    [wroof, yroof - crown * 0.055],
    [wroof * 0.42, yroof - crown * 0.012],
    [0, yroof],
  ];
}

/**
 * Choose where along Z to place the sampled stations.
 *
 * A uniform (or merely end-biased) distribution spends the same number of rings on a flat door
 * as it does on the roof arc and the rear haunch, which is exactly why those two read as faceted
 * while the sill is over-tessellated: "polys are countable" is a *distribution* failure before it
 * is a budget one. Here the profile tracks are sampled finely, the rate at which the section is
 * CHANGING is integrated along the car, and the stations are placed at equal increments of that
 * integral. Rings then crowd wherever the surface is actually turning — nose dome, roof arc,
 * haunch, tail tuck — and thin out along the straight flanks, at identical triangle cost.
 *
 * The end bias is kept on top: the nose and tail are capped by domes and need a dense last ring
 * regardless of how gently the section happens to be changing there.
 */
function stationZs(keys, S, z0, z1) {
  const M = 400;
  const span = Math.max(z1 - z0, 1e-6);
  const p0 = {};
  const p1 = {};
  const p2 = {};
  const w = new Float64Array(M);
  const h = span / (M - 1);
  for (let i = 0; i < M; i++) {
    const z = z0 + h * i;
    const za = Math.max(z0, z - h);
    const zb = Math.min(z1, z + h);
    for (const f of P_FIELDS) {
      p0[f] = trackAt(keys, f, za);
      p1[f] = trackAt(keys, f, z);
      p2[f] = trackAt(keys, f, zb);
    }
    // First derivative: how fast the section is growing/shrinking. Second derivative: how fast
    // that rate is itself turning — the silhouette curvature the eye actually counts facets on.
    let d1 = 0;
    let d2 = 0;
    for (const f of P_FIELDS) {
      const a = (p2[f] - p0[f]) / (2 * h);
      const b = (p2[f] - 2 * p1[f] + p0[f]) / (h * h);
      d1 += a * a;
      d2 += b * b;
    }
    // Ends: the dome caps weld onto the first/last ring, so keep those dense unconditionally.
    const u = i / (M - 1);
    const endBias = 1.2 * (Math.exp(-u * u * 90) + Math.exp(-(1 - u) * (1 - u) * 90));
    w[i] = 1 + Math.sqrt(d1) * 1.5 + Math.sqrt(d2) * 0.35 + endBias;
  }
  // Integrate, then invert: equal increments of accumulated "shape" -> station positions.
  const cum = new Float64Array(M);
  let acc = 0;
  for (let i = 0; i < M; i++) {
    acc += w[i];
    cum[i] = acc;
  }
  const total = cum[M - 1];
  const zs = new Array(S);
  let j = 0;
  for (let i = 0; i < S; i++) {
    const target = (i / (S - 1)) * total;
    while (j < M - 1 && cum[j] < target) j++;
    const c0 = j > 0 ? cum[j - 1] : 0;
    const t = clamp01((target - c0) / Math.max(cum[j] - c0, 1e-9));
    zs[i] = clamp(z0 + h * (j - 1 + t), z0, z1);
  }
  zs[0] = z0;
  zs[S - 1] = z1;
  // The arch cut and every surface probe assume strict monotonicity in Z.
  for (let i = 1; i < S; i++) if (zs[i] <= zs[i - 1]) zs[i] = zs[i - 1] + 1e-5;
  return zs;
}

/**
 * Loft a closed body surface from station keys.
 *
 * @param {object} o
 * @param {Array}  o.stations  keyed profiles: { z, yb, ys, w, ybelt, wbelt, yroof, wroof, crown, tuck, flank }
 * @param {number} o.rings     stations sampled along Z
 * @param {number} o.half      samples per half-profile
 * @param {Array}  o.arches    [{ z, y, r, halfWidth, lipOut, depth, front }]
 * @returns {{ geometry: THREE.BufferGeometry, grid: Float32Array, rings, ringLen }}
 */
export function loftBody(o) {
  const keys = o.stations;
  const S = o.rings ?? 46;
  const K = o.half ?? 20;
  const RING = K * 2 - 2; // shared bottom-centre & top-centre vertices
  const z0 = keys[0].z;
  const z1 = keys[keys.length - 1].z;

  const zs = stationZs(keys, S, z0, z1);

  const grid = new Float32Array(S * RING * 3);
  const p = {};
  for (let i = 0; i < S; i++) {
    const z = zs[i];
    for (const f of P_FIELDS) p[f] = trackAt(keys, f, z);
    const ctrl = halfProfile(p);
    const half = resample2D(ctrl, K);
    for (let j = 0; j < RING; j++) {
      // j: 0..K-1 right half (bottom->top), K..RING-1 left half (top->bottom)
      let x, y;
      if (j < K) {
        x = half[j][0];
        y = half[j][1];
      } else {
        const m = RING - j; // K-1 .. 1
        x = -half[m][0];
        y = half[m][1];
      }
      const b = (i * RING + j) * 3;
      grid[b] = x;
      grid[b + 1] = y;
      grid[b + 2] = z;
    }
  }

  if (o.warp) applyWarp(grid, S, RING, o.warp);
  // Arch openings are computed AFTER the warp so the rim lands on the final surface.
  const archMask = o.arches && o.arches.length ? openArches(grid, S, RING, K, o.arches, zs) : null;

  // ---- skin ----
  const quads = (S - 1) * RING;
  const posArr = new Float32Array(quads * 6 * 3);
  const uvArr = new Float32Array(quads * 6 * 2);
  let pi = 0,
    ui = 0;
  const push = (i, j, u, v) => {
    const b = (i * RING + j) * 3;
    posArr[pi++] = grid[b];
    posArr[pi++] = grid[b + 1];
    posArr[pi++] = grid[b + 2];
    uvArr[ui++] = u;
    uvArr[ui++] = v;
  };
  // Faces are emitted grouped so the greenhouse can be a *glass* material group on the same
  // continuous surface — that is how you get glass that follows the body with zero seam.
  const groupFn = o.group ?? null;
  const nGroups = o.groupCount ?? 1;
  const geo = new THREE.BufferGeometry();
  let start = 0;
  for (let gI = 0; gI < nGroups; gI++) {
    for (let i = 0; i < S - 1; i++) {
      const u0 = i / (S - 1),
        u1 = (i + 1) / (S - 1);
      for (let j = 0; j < RING; j++) {
        if (groupFn && groupFn(i, j, grid, RING, zs[i], S) !== gI) continue;
        const j2 = (j + 1) % RING;
        // A quad that touches the wheel opening is not drawn — that IS the arch hole.
        if (
          archMask &&
          (archMask[i * RING + j] ||
            archMask[i * RING + j2] ||
            archMask[(i + 1) * RING + j] ||
            archMask[(i + 1) * RING + j2])
        )
          continue;
        const v0 = j / RING,
          v1 = (j + 1) / RING;
        // Ring index runs bottom-centre -> +X flank -> roof, stations run nose -> tail, so this
        // winding order is the one that puts the front faces (and the normals) OUTSIDE.
        push(i, j, u0, v0);
        push(i + 1, j2, u1, v1);
        push(i + 1, j, u1, v0);
        push(i, j, u0, v0);
        push(i, j2, u0, v1);
        push(i + 1, j2, u1, v1);
      }
    }
    const count = pi / 3 - start;
    if (count > 0) geo.addGroup(start, count, gI);
    start += count;
  }

  geo.setAttribute('position', new THREE.BufferAttribute(posArr.subarray(0, pi), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvArr.subarray(0, ui), 2));
  geo.computeBoundingBox();
  return { geometry: geo, grid, rings: S, ringLen: RING, zs, archMask };
}

/** Widest half-width of every station — the flank reference the arch cut and liner both use. */
export function stationHalfWidths(grid, S, RING) {
  const out = new Float32Array(S);
  for (let i = 0; i < S; i++) {
    let m = 0;
    for (let j = 0; j < RING; j++) m = Math.max(m, Math.abs(grid[(i * RING + j) * 3]));
    out[i] = m;
  }
  return out;
}

/**
 * Close an open end of the loft with a DOMED cap — a few shrinking rings swept round a quarter
 * ellipse, ending in a tip.
 *
 * A flat fan to the profile centroid (see `capRing`) is what a nose and tail used to get, and it
 * is the single most obvious "untextured slab bolted to the model" artefact there is: every
 * triangle shares one normal, so the panel takes no specular, matches nothing around it, and
 * reads as a separate flat sticker. A dome carries the surface round, so the highlight runs off
 * the nose and the tail panel has an edge radius like a real pressing.
 *
 * @param {number} depth how far the dome bulges past the end station, metres
 * @param {number} flat  0..1 — how flat the centre stays (1 = a rear panel, 0 = a bullet nose)
 */
export function domeCap(grid, S, RING, ringIndex, depth = 0.07, flip = false, flat = 0.5, rows = 4) {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let j = 0; j < RING; j++) {
    const b = (ringIndex * RING + j) * 3;
    cx += grid[b];
    cy += grid[b + 1];
    cz += grid[b + 2];
  }
  cx /= RING;
  cy /= RING;
  cz /= RING;

  const dir = flip ? -1 : 1;
  const ringsOut = [];
  for (let k = 0; k <= rows; k++) {
    const t = k / rows;
    const a = t * Math.PI * 0.5;
    // `flat` biases the shrink late and the push-out early, which is the difference between a
    // rounded rear panel and a torpedo.
    const s = Math.pow(Math.cos(a), 1 - flat * 0.55);
    const dz = depth * Math.pow(Math.sin(a), 1 + flat * 1.6);
    const row = new Float32Array(RING * 3);
    for (let j = 0; j < RING; j++) {
      const b = (ringIndex * RING + j) * 3;
      row[j * 3] = cx + (grid[b] - cx) * s;
      row[j * 3 + 1] = cy + (grid[b + 1] - cy) * s;
      row[j * 3 + 2] = cz + dir * dz;
    }
    ringsOut.push(row);
  }

  const verts = [];
  const push = (row, j) => verts.push(row[j * 3], row[j * 3 + 1], row[j * 3 + 2]);
  for (let k = 0; k < rows; k++) {
    const A = ringsOut[k];
    const B = ringsOut[k + 1];
    for (let j = 0; j < RING; j++) {
      const j2 = (j + 1) % RING;
      // The tail dome runs in +Z, the same direction the loft's own stations do, so it takes the
      // loft's winding verbatim; the nose dome runs in -Z and takes the reverse. Get this the
      // wrong way round and the cap's front faces are culled, leaving the dark inner skin
      // showing through — a black panel across the back of the car.
      if (flip) {
        push(A, j); push(B, j); push(B, j2);
        push(A, j); push(B, j2); push(A, j2);
      } else {
        push(A, j); push(B, j2); push(B, j);
        push(A, j); push(A, j2); push(B, j2);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((verts.length / 3) * 2), 2));
  return geo;
}

/** Cap an open end of the loft with a fan to the profile centroid (nose / tail face). */
export function capRing(grid, S, RING, ringIndex, inset = 0, flip = false) {
  let cx = 0,
    cy = 0,
    cz = 0;
  for (let j = 0; j < RING; j++) {
    const b = (ringIndex * RING + j) * 3;
    cx += grid[b];
    cy += grid[b + 1];
    cz += grid[b + 2];
  }
  cx /= RING;
  cy /= RING;
  cz /= RING;
  cz += flip ? -inset : inset;
  const pos = new Float32Array(RING * 9);
  let k = 0;
  for (let j = 0; j < RING; j++) {
    const j2 = (j + 1) % RING;
    const a = (ringIndex * RING + j) * 3;
    const b = (ringIndex * RING + j2) * 3;
    const tri = flip
      ? [cx, cy, cz, grid[b], grid[b + 1], grid[b + 2], grid[a], grid[a + 1], grid[a + 2]]
      : [cx, cy, cz, grid[a], grid[a + 1], grid[a + 2], grid[b], grid[b + 1], grid[b + 2]];
    for (const v of tri) pos[k++] = v;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return geo;
}

// ---------------------------------------------------------------------------- arches

/**
 * Mark the loft vertices that fall inside a wheel opening and roll the surviving rim into a lip.
 *
 * Rules, all of which exist because breaking one of them visibly destroys the car:
 *  - only vertices on the FLANK are eligible (`|x| >= inner * stationHalfWidth`), so the
 *    underfloor centre and the roof crown are never punched through;
 *  - the opening is the arch DISC, `dz^2 + dy^2 < r^2`, not merely "below the arch arc". Cutting
 *    everything below the arc leaves the whole lower flank open for the full length of the arch,
 *    so the car gains a metre-wide black hole either side of each tyre with no bodywork between
 *    the sill and the wing. The disc gives a real round wheel opening with the rocker intact;
 *  - at least two ring rows of fender always survive above the opening, so a low fender can
 *    never let the cut eat out through the top of the wing;
 *  - nothing is displaced in Y or Z except the single rim row, which is only ever moved DOWN
 *    onto the arc — the grid therefore stays monotone in Z and cannot fold through itself.
 *
 * @returns {Uint8Array} per-vertex mask, 1 = inside the opening
 */
function openArches(grid, S, RING, K, arches, zs) {
  const mask = new Uint8Array(S * RING);
  const halfMax = new Float32Array(S);
  for (let i = 0; i < S; i++) {
    let m = 0;
    for (let j = 0; j < K; j++) m = Math.max(m, grid[(i * RING + j) * 3]);
    halfMax[i] = m;
  }

  for (const a of arches) {
    const zc = a.z;
    const yc = a.y;
    const r = a.r;
    const inner = a.inner ?? 0.56;
    const lipOut = a.lipOut ?? 0.014;

    for (let i = 0; i < S; i++) {
      const dz = zs[i] - zc;
      if (Math.abs(dz) >= r) continue;
      const h2 = r * r - dz * dz;
      const thresh = halfMax[i] * inner;

      // contiguous flank band on the +X half
      let jA = -1;
      let jB = -1;
      for (let j = 1; j < K - 1; j++) {
        if (grid[(i * RING + j) * 3] >= thresh) {
          if (jA < 0) jA = j;
          jB = j;
        }
      }
      if (jA < 0 || jB - jA < 3) continue;

      const jLimit = jB - 2; // two rows of fender always survive above the opening
      let jCut = -1;
      for (let j = jA; j <= jLimit; j++) {
        const dy = grid[(i * RING + j) * 3 + 1] - yc;
        if (dy * dy >= h2) continue;
        jCut = j;
        mask[i * RING + j] = 1;
        const m = RING - j;
        if (m > 0 && m < RING) mask[i * RING + m] = 1;
      }
      if (jCut < 0) continue;

      // NOTE: the rim row is deliberately NOT snapped onto the arc. Snapping one row per station
      // while its neighbours keep their height turns the cut into a row of red teeth pointing
      // into the wheel opening. The cut is left as a clean staircase that is always OUTSIDE the
      // arc, and the arch lip (a swept tube on the exact circle, see CarBody.archLip) covers it.
      // The rows above the cut still get flared so the fender carries a blister into the lip.
      const jr = jCut + 1;
      for (const [jj, f] of [
        [jr, 1],
        [jr + 1, 0.55],
        [jr + 2, 0.22],
      ]) {
        if (jj <= 0 || jj >= K) continue;
        for (const idx of [jj, RING - jj]) {
          if (idx <= 0 || idx >= RING) continue;
          const b = idx * 3 + i * RING * 3;
          const ax = Math.abs(grid[b]);
          if (ax > 1e-4) grid[b] *= 1 + (lipOut * f) / Math.max(ax, 0.25);
        }
      }
    }
  }
  return mask;
}

/** Freeform sculpt hook: fn(x,y,z) -> [x,y,z]. Used for scoops, hips, cab-forward skew. */
function applyWarp(grid, S, RING, fn) {
  const N = S * RING;
  const o = [0, 0, 0];
  for (let v = 0; v < N; v++) {
    const b = v * 3;
    fn(grid[b], grid[b + 1], grid[b + 2], o);
    grid[b] = o[0];
    grid[b + 1] = o[1];
    grid[b + 2] = o[2];
  }
}

// ---------------------------------------------------------------------------- primitives

/**
 * Sweep a 2D closed profile along a path of frames. Used for wings, mirrors, exhaust tips,
 * diffuser fins — anything that wants real thickness and rounded edges.
 */
export function sweepProfile(profile, path, { closed = false, cap = true } = {}) {
  const P = profile.length;
  const N = path.length;
  const verts = [];
  const idx = [];
  for (let i = 0; i < N; i++) {
    const f = path[i];
    for (let j = 0; j < P; j++) {
      const [u, v] = profile[j];
      verts.push(
        f.o[0] + f.x[0] * u + f.y[0] * v,
        f.o[1] + f.x[1] * u + f.y[1] * v,
        f.o[2] + f.x[2] * u + f.y[2] * v
      );
    }
  }
  const segs = closed ? N : N - 1;
  for (let i = 0; i < segs; i++) {
    const i2 = (i + 1) % N;
    for (let j = 0; j < P; j++) {
      const j2 = (j + 1) % P;
      const a = i * P + j,
        b = i2 * P + j,
        c = i2 * P + j2,
        d = i * P + j2;
      idx.push(a, b, c, a, c, d);
    }
  }
  if (cap && !closed) {
    for (const [ring, flip] of [
      [0, true],
      [N - 1, false],
    ]) {
      const base = verts.length / 3;
      let cx = 0,
        cy = 0,
        cz = 0;
      for (let j = 0; j < P; j++) {
        cx += verts[(ring * P + j) * 3];
        cy += verts[(ring * P + j) * 3 + 1];
        cz += verts[(ring * P + j) * 3 + 2];
      }
      verts.push(cx / P, cy / P, cz / P);
      for (let j = 0; j < P; j++) {
        const j2 = (j + 1) % P;
        if (flip) idx.push(base, ring * P + j2, ring * P + j);
        else idx.push(base, ring * P + j, ring * P + j2);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Straight extrusion along +Z of a closed 2D profile. */
export function extrude(profile, len, taper = 1) {
  const path = [
    { o: [0, 0, -len / 2], x: [1, 0, 0], y: [0, 1, 0] },
    { o: [0, 0, len / 2], x: [taper, 0, 0], y: [0, taper, 0] },
  ];
  return sweepProfile(profile, path);
}

/** Rounded-rectangle profile — the workhorse for wings, splitters, mirror stalks. */
export function roundedRect(w, h, r, seg = 4) {
  const pts = [];
  r = Math.min(r, w / 2, h / 2);
  const corners = [
    [w / 2 - r, h / 2 - r, 0],
    [-(w / 2 - r), h / 2 - r, Math.PI / 2],
    [-(w / 2 - r), -(h / 2 - r), Math.PI],
    [w / 2 - r, -(h / 2 - r), -Math.PI / 2],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
}

/** Aerofoil (NACA-ish) profile, chord along X, camber up. */
export function aerofoil(chord, thick, camber = 0.06, seg = 12) {
  const top = [],
    bot = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const x = t * chord - chord / 2;
    const yt = thick * (1.4845 * Math.sqrt(t) - 0.63 * t - 1.758 * t * t + 1.4215 * t ** 3);
    const yc = camber * chord * Math.sin(Math.PI * t) * 0.5;
    top.push([x, yc + yt]);
    bot.push([x, yc - yt * 0.55]);
  }
  return [...top, ...bot.reverse().slice(1, -1)];
}

/** Merge a list of geometries that share an attribute layout (position+uv+normal). */
export function mergeGeos(list) {
  const out = [];
  let total = 0;
  for (const g of list) {
    const ng = g.index ? g.toNonIndexed() : g;
    if (!ng.attributes.uv) {
      ng.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((ng.attributes.position.count) * 2), 2));
    }
    if (!ng.attributes.normal) ng.computeVertexNormals();
    out.push(ng);
    total += ng.attributes.position.count;
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let po = 0,
    uo = 0;
  for (const g of out) {
    pos.set(g.attributes.position.array, po);
    nor.set(g.attributes.normal.array, po);
    uv.set(g.attributes.uv.array, uo);
    po += g.attributes.position.array.length;
    uo += g.attributes.uv.array.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/**
 * Planar-project UVs from object space, choosing the plane per triangle from its dominant normal
 * axis. Detail geometry is built from sweeps and boxes that carry no UVs at all, so every texture
 * we hang on them (carbon weave, brushed alu, scratches) would otherwise sample a single texel.
 * Derivative-based tangent frames also blow up on a constant UV, so this is a correctness fix as
 * much as a look fix.
 */
export function boxUV(geo, scale = 1.6) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position.array;
  const n = g.attributes.normal?.array;
  const uv = new Float32Array((p.length / 3) * 2);
  for (let t = 0; t < p.length; t += 9) {
    let nx, ny, nz;
    if (n) {
      nx = Math.abs(n[t] + n[t + 3] + n[t + 6]);
      ny = Math.abs(n[t + 1] + n[t + 4] + n[t + 7]);
      nz = Math.abs(n[t + 2] + n[t + 5] + n[t + 8]);
    } else {
      nx = ny = 0;
      nz = 1;
    }
    for (let k = 0; k < 3; k++) {
      const i = t + k * 3;
      const o = (i / 3) * 2;
      let u, v;
      if (nx >= ny && nx >= nz) {
        u = p[i + 2];
        v = p[i + 1];
      } else if (ny >= nz) {
        u = p[i];
        v = p[i + 2];
      } else {
        u = p[i];
        v = p[i + 1];
      }
      uv[o] = u * scale;
      uv[o + 1] = v * scale;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Cylindrical UVs about the +X axis — the right projection for wheels and lathed parts. */
export function cylUV(geo, uRepeat = 6, vScale = 3) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position.array;
  const uv = new Float32Array((p.length / 3) * 2);
  for (let i = 0, o = 0; i < p.length; i += 3, o += 2) {
    uv[o] = ((Math.atan2(p[i + 2], p[i + 1]) / (Math.PI * 2)) * uRepeat + uRepeat) % uRepeat;
    uv[o + 1] = Math.hypot(p[i + 1], p[i + 2]) * vScale;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Mirror a geometry across X, flipping winding so normals stay outward. */
export function mirrorX(geo) {
  const g = (geo.index ? geo.toNonIndexed() : geo).clone();
  const p = g.attributes.position.array;
  for (let i = 0; i < p.length; i += 3) p[i] = -p[i];
  // flip winding
  for (let i = 0; i < p.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      const t = p[i + 3 + k];
      p[i + 3 + k] = p[i + 6 + k];
      p[i + 6 + k] = t;
    }
  }
  if (g.attributes.uv) {
    const u = g.attributes.uv.array;
    for (let i = 0; i < u.length; i += 6) {
      for (let k = 0; k < 2; k++) {
        const t = u[i + 2 + k];
        u[i + 2 + k] = u[i + 4 + k];
        u[i + 4 + k] = t;
      }
    }
  }
  g.computeVertexNormals();
  return g;
}

export function triCount(obj) {
  let t = 0;
  obj.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      t += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  return t;
}

export { clamp, clamp01, lerp };
