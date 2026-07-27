/**
 * Collision — Need for Tokens, physics lane.
 *
 * The car is a **capsule in XZ**: two spheres on the longitudinal axis, radius = half the body
 * width. That is a much better fit than a lateral push against the track half-width, because it
 * has a real contact point, which means a real moment arm, which means a glancing hit on the
 * nose spins the car instead of teleporting it sideways.
 *
 * Barriers come from `world.barriers` (CONTRACTS.md §7): 2D XZ segments with an inward `normal`,
 * a `height` above the segment's own y, a `restitution` and a `tag`.
 *
 * Impulses are solved properly against the body's world-space inverse inertia, with Coulomb
 * friction along the wall, so scraping a barrier scrubs speed and pulls the nose in the way a
 * real wall-ride does.
 */

import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathX.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _r = new THREE.Vector3();
const _j = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** World-space I^-1 * v for a body whose inertia is diagonal in its own frame. */
export function applyInvInertia(quat, invI, v, out) {
  out.copy(v).applyQuaternion(_q.copy(quat).invert());
  out.set(out.x * invI.x, out.y * invI.y, out.z * invI.z);
  return out.applyQuaternion(quat);
}

/**
 * The two capsule sphere centres of a car, in world space.
 *
 * NOTE the private scratch: callers pass module-level scratch vectors as `outA`/`outB`, so this
 * must never use one of those as its own temporary. It did once, and `outA.copy(pos).add(_a)`
 * with `outA === _a` silently produced 2*position — every capsule end landed hundreds of metres
 * away and the car drove through every wall in the game without a single contact.
 */
const _capOff = new THREE.Vector3();
export function capsuleEnds(state, def, outA, outB) {
  const half = Math.max(0.1, def.length * 0.5 - def.width * 0.5);
  _capOff.set(0, 0, -half).applyQuaternion(state.quaternion);
  outA.copy(state.position).add(_capOff);
  outB.copy(state.position).sub(_capOff);
  return Math.max(0.35, def.width * 0.5);
}

/** Closest point on segment ab to p, in XZ only. Returns the parameter u in 0..1. */
function closestOnSegXZ(p, a, b, out) {
  const ex = b.x - a.x;
  const ez = b.z - a.z;
  const len2 = ex * ex + ez * ez;
  const u = len2 > 1e-9 ? clamp01(((p.x - a.x) * ex + (p.z - a.z) * ez) / len2) : 0;
  out.set(a.x + ex * u, a.y + (b.y - a.y) * u, a.z + ez * u);
  return u;
}

/**
 * Resolve one contact against a static wall.
 * @returns {number} the normal impulse magnitude applied (N s), 0 if there was no contact
 */
const _rc = { r: new THREE.Vector3(), vc: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), t: new THREE.Vector3(), j: new THREE.Vector3() };
export function resolveStaticContact(state, invMass, invI, point, normal, depth, restitution, friction) {
  // Private scratch — `point` and `normal` are the caller's scratch vectors, so this routine
  // must not touch the shared pool or it will corrupt them mid-solve.
  const S = _rc;
  // Positional correction. Shallow contacts are under-relaxed so the car is not popped off the
  // wall; deep ones are pushed out in full, because a car pressed into a barrier at 300 km/h
  // will otherwise accumulate metres of penetration over successive frames.
  const relax = 0.8 + 0.2 * clamp01(depth / 0.35);
  state.position.addScaledVector(normal, Math.min(depth, 0.8) * relax);

  S.r.copy(point).sub(state.position);
  S.vc.copy(state.angularVelocity).cross(S.r).add(state.velocity);
  const vn = S.vc.dot(normal);
  if (vn >= 0) return 0;

  // effective mass along the normal
  applyInvInertia(state.quaternion, invI, S.a.copy(S.r).cross(normal), S.b);
  const k = invMass + S.b.cross(S.r).dot(normal);
  if (!(k > 1e-9)) return 0;

  const jn = (-(1 + restitution) * vn) / k;
  S.j.copy(normal).multiplyScalar(jn);

  // tangential — Coulomb friction along the wall, which is what scrubs speed off a wall-ride
  S.t.copy(S.vc).addScaledVector(normal, -vn);
  const vtLen = S.t.length();
  if (vtLen > 1e-4) {
    S.t.multiplyScalar(1 / vtLen);
    applyInvInertia(state.quaternion, invI, S.a.copy(S.r).cross(S.t), S.b);
    const kt = invMass + S.b.cross(S.r).dot(S.t);
    let jt = kt > 1e-9 ? -vtLen / kt : 0;
    jt = clamp(jt, -friction * jn, friction * jn);
    S.j.addScaledVector(S.t, jt);
  }

  state.velocity.addScaledVector(S.j, invMass);
  applyInvInertia(state.quaternion, invI, S.a.copy(S.r).cross(S.j), S.b);
  state.angularVelocity.add(S.b);
  return jn;
}

/**
 * Test the car capsule against every nearby barrier segment.
 * `emit(point, normal, impulse, tag)` is called once per resolved contact.
 */
const _near = [];
export function collideBarriers(state, def, invMass, invI, barriers, index, emit) {
  const rad = capsuleEnds(state, def, _a, _b);
  const ends = [_a, _b];
  let worst = 0;
  // Own output buffer: `emit` fires a bus event from inside the loop below and a listener may
  // legitimately raycast, which queries the same grid.
  const near = index ? index.query(state.position, def.length + 6, _near) : barriers;
  for (let bi = 0; bi < near.length; bi++) {
    const seg = near[bi];
    for (let s = 0; s < 2; s++) {
      const p = ends[s];
      const cp = closestOnSegXZ(p, seg.a, seg.b, _c);
      const dx = p.x - _c.x;
      const dz = p.z - _c.z;
      const dist = Math.hypot(dx, dz);
      if (dist > rad) continue;
      // vertical overlap: the car's body sits between position.y - 0.1 and + height
      const wallTop = _c.y + seg.height;
      const carLow = p.y - 0.25;
      const carHigh = p.y + (def.height ?? 1.2) * 0.8;
      if (carLow > wallTop || carHigh < _c.y - 0.6) continue;

      // Outward normal: prefer the authored inward normal, but flip it if we are behind the
      // wall, and fall back to the separation direction on a degenerate hit.
      _n.copy(seg.normal);
      if (dist > 1e-4) {
        _n.set(dx / dist, 0, dz / dist);
        if (_n.dot(seg.normal) < -0.15) _n.copy(seg.normal); // came through: push back inside
      }
      _n.y = 0;
      if (_n.lengthSq() < 1e-8) continue;
      _n.normalize();

      const depth = rad - dist + 0.005;
      const contact = _d.set(_c.x, Math.min(p.y, wallTop) - 0.1, _c.z);
      const jn = resolveStaticContact(
        state,
        invMass,
        invI,
        contact,
        _n,
        depth,
        seg.restitution ?? 0.3,
        0.42
      );
      if (jn > worst) {
        worst = jn;
        if (jn > 1) emit?.(contact, _n, jn, seg.tag || 'barrier');
      }
    }
  }
  return worst;
}

/** Broad-phase over static segments: a uniform XZ grid built once. */
export class SegmentGrid {
  constructor(segments, cell = 24) {
    this.cell = cell;
    this.map = new Map();
    this.segments = segments;
    this._out = [];
    // Dedupe by stamp rather than `out.includes()`. A 120 m raycast query touches ~80 cells and
    // several hundred segments, and a linear membership scan over that is quadratic. The index
    // is built here so we never have to write a marker onto the world lane's own objects.
    this._index = new Map();
    this._seen = new Int32Array(segments.length);
    this._stamp = 0;
    for (let i = 0; i < segments.length; i++) this._index.set(segments[i], i);
    for (const s of segments) {
      const x0 = Math.min(s.a.x, s.b.x);
      const x1 = Math.max(s.a.x, s.b.x);
      const z0 = Math.min(s.a.z, s.b.z);
      const z1 = Math.max(s.a.z, s.b.z);
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++) {
        for (let cz = Math.floor(z0 / cell); cz <= Math.floor(z1 / cell); cz++) {
          const k = cx * 73856093 ^ cz * 19349663;
          let list = this.map.get(k);
          if (!list) this.map.set(k, (list = []));
          list.push(s);
        }
      }
    }
  }

  /**
   * Segments whose cells overlap the square of side 2*radius around `p`.
   *
   * `out` MUST be supplied by any caller that holds the result across a call which can re-enter
   * physics. `collideBarriers` emits `car:collision` from inside its own loop, listeners are
   * free to call `physics.raycast()`, and raycast queries this grid — so a single shared output
   * buffer means the collision loop finishes iterating a completely different array.
   */
  query(p, radius, out = this._out) {
    out.length = 0;
    const c = this.cell;
    const stamp = ++this._stamp;
    const seen = this._seen;
    const index = this._index;
    const x0 = Math.floor((p.x - radius) / c);
    const x1 = Math.floor((p.x + radius) / c);
    const z0 = Math.floor((p.z - radius) / c);
    const z1 = Math.floor((p.z + radius) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.map.get(cx * 73856093 ^ cz * 19349663);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          const id = index.get(s);
          if (id === undefined) {
            if (!out.includes(s)) out.push(s);
            continue;
          }
          if (seen[id] === stamp) continue;
          seen[id] = stamp;
          out.push(s);
        }
      }
    }
    return out;
  }
}

/**
 * Car vs car. Capsule-vs-capsule reduced to sphere pairs — four tests per pair, which is plenty
 * for eight cars and gives a believable nose-to-quarter-panel nudge.
 * `emit(point, normal, impulse)` fires once per pair on a meaningful hit.
 */
export function collideCars(A, B, emit) {
  const radA = capsuleEnds(A.state, A.def, _a, _b);
  const endsA = [_a.clone(), _b.clone()];
  const radB = capsuleEnds(B.state, B.def, _c, _d);
  const endsB = [_c.clone(), _d.clone()];
  const rsum = radA + radB;
  let best = null;
  let bestDepth = 0;
  for (const pa of endsA) {
    for (const pb of endsB) {
      const dx = pa.x - pb.x;
      const dy = (pa.y - pb.y) * 0.5;
      const dz = pa.z - pb.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > rsum || d < 1e-5) continue;
      const depth = rsum - d;
      if (depth > bestDepth) {
        bestDepth = depth;
        best = {
          n: new THREE.Vector3(dx / d, 0, dz / d),
          p: new THREE.Vector3((pa.x + pb.x) * 0.5, (pa.y + pb.y) * 0.5, (pa.z + pb.z) * 0.5),
        };
      }
    }
  }
  if (!best) return 0;
  if (best.n.lengthSq() < 1e-8) best.n.set(1, 0, 0);
  best.n.normalize();

  const sa = A.state;
  const sb = B.state;
  const imA = 1 / A.def.mass;
  const imB = 1 / B.def.mass;
  const total = imA + imB;
  // split the positional correction by inverse mass
  sa.position.addScaledVector(best.n, (bestDepth * 0.8 * imA) / total);
  sb.position.addScaledVector(best.n, (-bestDepth * 0.8 * imB) / total);

  const ra = _e.copy(best.p).sub(sa.position);
  const rb = _n.copy(best.p).sub(sb.position);
  const va = new THREE.Vector3().copy(sa.angularVelocity).cross(ra).add(sa.velocity);
  const vb = new THREE.Vector3().copy(sb.angularVelocity).cross(rb).add(sb.velocity);
  const rel = va.sub(vb);
  const vn = rel.dot(best.n);
  if (vn >= 0) return 0;

  const ia = new THREE.Vector3();
  const ib = new THREE.Vector3();
  applyInvInertia(sa.quaternion, A.invI, new THREE.Vector3().copy(ra).cross(best.n), ia);
  applyInvInertia(sb.quaternion, B.invI, new THREE.Vector3().copy(rb).cross(best.n), ib);
  const k =
    total +
    ia.cross(ra).dot(best.n) +
    ib.cross(rb).dot(best.n);
  if (!(k > 1e-9)) return 0;

  const e = 0.22;
  const jn = (-(1 + e) * vn) / k;
  const J = new THREE.Vector3().copy(best.n).multiplyScalar(jn);

  sa.velocity.addScaledVector(J, imA);
  sb.velocity.addScaledVector(J, -imB);
  const wa = new THREE.Vector3();
  applyInvInertia(sa.quaternion, A.invI, new THREE.Vector3().copy(ra).cross(J), wa);
  sa.angularVelocity.add(wa);
  const wb = new THREE.Vector3();
  applyInvInertia(sb.quaternion, B.invI, new THREE.Vector3().copy(rb).cross(J), wb);
  sb.angularVelocity.sub(wb);

  if (jn > 1) emit?.(best.p, best.n, jn);
  return jn;
}

/**
 * Ray vs one barrier segment, treated as a vertical quad from `a.y` to `a.y + height`.
 * Returns the ray parameter or -1.
 */
export function rayVsWall(o, dir, seg, maxDist) {
  const ex = seg.b.x - seg.a.x;
  const ez = seg.b.z - seg.a.z;
  // plane through the segment with the horizontal normal
  const nx = -ez;
  const nz = ex;
  const nl = Math.hypot(nx, nz);
  if (nl < 1e-6) return -1;
  const px = nx / nl;
  const pz = nz / nl;
  const denom = dir.x * px + dir.z * pz;
  if (Math.abs(denom) < 1e-7) return -1;
  const t = ((seg.a.x - o.x) * px + (seg.a.z - o.z) * pz) / denom;
  if (t < 0 || t > maxDist) return -1;
  const hx = o.x + dir.x * t;
  const hy = o.y + dir.y * t;
  const hz = o.z + dir.z * t;
  const len2 = ex * ex + ez * ez;
  const u = ((hx - seg.a.x) * ex + (hz - seg.a.z) * ez) / (len2 || 1);
  if (u < 0 || u > 1) return -1;
  const baseY = seg.a.y + (seg.b.y - seg.a.y) * u;
  if (hy < baseY - 0.05 || hy > baseY + seg.height) return -1;
  return t;
}

/** Ray vs an axis-aligned box (THREE.Box3-like {min,max}); returns entry t or -1. */
export function rayVsBox(o, dir, min, max, maxDist) {
  let tmin = 0;
  let tmax = maxDist;
  for (const ax of ['x', 'y', 'z']) {
    const d = dir[ax];
    if (Math.abs(d) < 1e-8) {
      if (o[ax] < min[ax] || o[ax] > max[ax]) return -1;
      continue;
    }
    const inv = 1 / d;
    let t1 = (min[ax] - o[ax]) * inv;
    let t2 = (max[ax] - o[ax]) * inv;
    if (t1 > t2) {
      const s = t1;
      t1 = t2;
      t2 = s;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/** Ray vs a sphere; returns the nearest positive t or -1. */
export function rayVsSphere(o, dir, centre, radius, maxDist) {
  const ox = o.x - centre.x;
  const oy = o.y - centre.y;
  const oz = o.z - centre.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  return t >= 0 && t <= maxDist ? t : -1;
}
