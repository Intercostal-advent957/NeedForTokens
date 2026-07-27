/**
 * Camera collision avoidance.
 *
 * Layers, outermost first. Each one is cheaper to look at than the one below it, which is the
 * whole design: by the time we reach the reactive pull-in there should be almost nothing left
 * for it to do.
 *
 *  1. CORRIDOR (in CameraSystem._clampToCorridor) — keep the boom inside the road. Prevention.
 *  2. TERRAIN — the camera must never sink into the road, a kerb or a hillside. The fix is to
 *     *lift*, not to pull in, so we sample the ground along the whole boom (not just under the
 *     camera) and raise the far end until the entire segment clears.
 *  3. WALL STAND-OFF — barriers do not usually occlude the car, they just fill the frame when
 *     the lens is a metre off them. Sliding sideways off the wall fixes the shot; pulling in
 *     does not (the boom stays just as close to it).
 *  4. SOLID PULL-IN — a genuine obstacle *between* the lens and the car: a building corner, a
 *     bridge pier. Only then do we shorten the boom, and never below `minDistance`.
 *
 * WHY THE PULL-IN IS SO CONSERVATIVE
 * `physics.raycast()` used to be ground-only, so this layer almost never fired and could afford
 * to be twitchy. It now reports barriers, props and per-instance building AABBs, which changes
 * the input distribution completely:
 *   - Building boxes are *axis-aligned* bounds of rotated geometry, so a 45°-rotated tower
 *     reports a box up to 1.4x its real footprint — routinely overlapping the road it stands by.
 *   - A wall running alongside the boom gets hit at a glancing angle. Shortening the boom leaves
 *     the camera exactly as close to it: the hit is real, the pull-in is useless.
 *   - Anything within a couple of metres of the pivot is the car's own bodywork or the kerb next
 *     to it, never an occluder.
 * So: the ray starts outside the car, glancing hits are discounted, a hit has to eat a real
 * fraction of the boom for a sustained window before it moves anything, and there is a hard
 * floor in metres underneath the lot. Being wrong costs a frame of clipped wall; the failure the
 * other way is a shot of the car's roof, which is not a shot at all.
 */
import * as THREE from 'three';
import { clamp01 } from '../core/MathX.js';

const BARRIER_SEARCH_R2 = 60 * 60;
const STANDOFF_SEARCH_R2 = 40 * 40;
/** Above this we stop trying to hop over a wall and pull the boom in instead. */
const LIFT_LIMIT = 1.9;
/** Fraction of the boom an obstacle must swallow before it counts as occlusion at all. */
const OCCLUDE_DEADBAND = 0.16;
/** Seconds the boom must stay blocked before the camera starts moving in. */
const OCCLUDE_DELAY = 0.1;
/** Seconds of clear line-of-sight before it starts extending back out. */
const CLEAR_DELAY = 0.05;
/** |n·boom| under this is a graze along a near-parallel surface — pulling in would not help. */
const GRAZE_DOT = 0.3;
const GRAZE_RAMP = 0.25;
/** Hz. Cutting in is firm but no longer instant; recovering is deliberately not much slower. */
const PULL_RATE = 9;
const PUSH_RATE = 5;
/** A barrier whose top is further than this below the lens is out of frame anyway. */
const WALL_BELOW = 1.7;

export class OcclusionSolver {
  constructor() {
    this.frac = 1; // 0..1 of the desired boom length currently allowed
    this.lift = 0; // metres the camera has been raised off its ideal height
    this.blocked = false;
    this._dir = new THREE.Vector3();
    this._org = new THREE.Vector3();
    this._push = new THREE.Vector3(); // smoothed shove out of other cars
    this._wall = new THREE.Vector3(); // smoothed shove off barriers
    this._hold = 0; // seconds of sustained occlusion
    this._clear = 0; // seconds of sustained clear line-of-sight
    /**
     * Last frame's numbers, in metres. Free to read from the console / QA harness — this is the
     * only honest way to tell which layer moved the boom, and guessing is how the chase cam
     * ended up on the car's roof twice.
     */
    this.debug = {
      boom: 0,
      frac: 1,
      lift: 0,
      barrierFrac: 1,
      barrierLift: 0,
      rayTag: '',
      rayDist: -1,
      rayWeight: 0,
      phantom: false,
      dCorridor: 0,
      dStandOff: 0,
      dCars: 0,
      dMin: 0,
    };
  }

  reset() {
    this.frac = 1;
    this.lift = 0;
    this.blocked = false;
    this._push.set(0, 0, 0);
    this._wall.set(0, 0, 0);
    this._hold = 0;
    this._clear = 0;
  }

  /**
   * @param {object} ctx
   * @param {THREE.Vector3} pivot   point the camera must keep line-of-sight to (car, chest height)
   * @param {THREE.Vector3} desired ideal camera position (mutated in place with the lift)
   * @param {object} opts
   *   { radius, clearance, dt, terrain, solids, subject,
   *     carPos, minDistance, minHeight, selfRadius, wallClearance, maxLift, corridor }
   *   `corridor` is an optional (point) => void that eases a world point back inside the road.
   * @param {THREE.Vector3} out
   */
  solve(ctx, pivot, desired, opts, out) {
    const {
      radius = 0.4,
      clearance = 0.55,
      dt = 1 / 60,
      terrain = true,
      solids = true,
      carPos = null,
      minDistance = 0,
      minHeight = 0,
      selfRadius = 2.6,
      wallClearance = 0,
      maxLift = Infinity,
      corridor = null,
      onRoad = null,
    } = opts;
    const world = ctx.world;
    const dbg = this.debug;
    dbg.rayTag = '';
    dbg.rayDist = -1;
    dbg.rayWeight = 0;
    dbg.phantom = false;

    // ---------------------------------------------------------------- 0. walls
    // Armco is only about a metre tall, so the right answer to "the boom crosses a barrier" is
    // almost always to hop over it, not to slam the camera into the back of the car. Only when
    // the obstacle is genuinely tall (a building) do we fall back to pulling in.
    let barrierFrac = 1;
    let barrierLift = 0;
    if (solids) {
      const b = this._barriers(world, pivot, desired, radius);
      if (b.lift <= LIFT_LIMIT) barrierLift = b.lift;
      // A knee-high armco is never worth collapsing the whole boom for — you can see over it.
      else barrierFrac = Math.max(b.frac, 0.55);
    }
    dbg.barrierFrac = barrierFrac;
    dbg.barrierLift = barrierLift;

    // ---------------------------------------------------------------- 1. terrain lift
    let wantLift = barrierLift;
    if (terrain && world?.sampleGround) {
      const STEPS = 6;
      for (let i = 2; i <= STEPS; i++) {
        const f = i / STEPS;
        const x = pivot.x + (desired.x - pivot.x) * f;
        const z = pivot.z + (desired.z - pivot.z) * f;
        const y = pivot.y + (desired.y - pivot.y) * f;
        const g = safeGround(world, x, z);
        if (g === null) continue;
        const need = g + clearance + radius;
        if (y < need) {
          // raise the far end so this sample clears: y_end = pivot.y + (need - pivot.y)/f
          wantLift = Math.max(wantLift, (need - y) / f);
        }
      }
    }
    // `maxLift` is how much headroom the caller knows we have — inside a tunnel bore, lifting to
    // clear a kerb would put the lens through the crown, which nothing else here can see.
    wantLift = Math.min(wantLift, maxLift);
    // Lift snaps up fast (never clip) and settles down slowly (no bobbing over kerbs).
    const liftRate = wantLift > this.lift ? 26 : 3.2;
    this.lift += (wantLift - this.lift) * (1 - Math.exp(-liftRate * dt));
    if (!Number.isFinite(this.lift)) this.lift = 0;
    desired.y += this.lift;

    // ---------------------------------------------------------------- 2. solid pull-in
    const dir = this._dir.subVectors(desired, pivot);
    const dist = dir.length();
    if (dist < 1e-4) {
      out.copy(desired);
      this.frac = 1;
      return out;
    }
    dir.multiplyScalar(1 / dist);

    let free = barrierFrac;
    if (solids) {
      // Start the ray outside the car's own footprint. `physics.raycast` offers no exclusion
      // list, and a ray launched from the middle of the car reports the kerb it is straddling,
      // the armco it is scraping, and any building AABB overlapping the road it is on — all at
      // ~0 m, all of which would collapse the boom to nothing.
      // `dist * 0.6` alone quietly shrinks the skip below the car's own rear overhang once the
      // boom is short (a 3.9 m boom skipped only 2.34 m, and the bodywork reaches ~2.3 m) — which
      // is exactly the case where a self-hit is fatal. Skip the full self radius whenever there is
      // any boom left after it.
      const skip = Math.min(selfRadius, Math.max(dist * 0.6, dist - 0.6));
      this._org.copy(pivot).addScaledVector(dir, skip);
      const hit = safeRay(ctx, this._org, dir, dist - skip + radius);
      // distance 0 means the origin is inside the volume (an AABB swallowing the road). That is
      // not a line-of-sight blocker, and the corridor + minimum boom are the honest fix for it.
      if (hit && hit.hit && Number.isFinite(hit.distance) && hit.distance > 1e-3) {
        const n = hit.normal;
        const dot = n ? Math.abs(n.x * dir.x + n.y * dir.y + n.z * dir.z) : 1;
        const weight = clamp01((dot - GRAZE_DOT) / GRAZE_RAMP);
        // Nothing is built on the racing surface. A `building` report while both ends of the
        // boom are inside the corridor is therefore a phantom: the city lane publishes each
        // tower's world-axis-aligned bounds, and the AABB of a tower rotated 45° covers half
        // again its real footprint, routinely spilling over the kerb of the street it faces.
        // Believing it is what collapsed the chase cam onto the car's roof on this circuit.
        const phantom =
          hit.tag === 'building' && onRoad !== null && onRoad(this._org) && onRoad(desired);
        dbg.rayTag = hit.tag ?? 'hit';
        dbg.rayDist = skip + hit.distance;
        dbg.rayWeight = weight;
        dbg.phantom = phantom;
        if (weight > 0 && !phantom) {
          const d = skip + hit.distance - radius - 0.12;
          free = Math.min(free, 1 - (1 - clamp01(d / dist)) * weight);
        }
      }
    }

    // Deadband: a shallow bite out of the boom is not worth moving the camera for, and with the
    // extended raycast most frames now take a shallow bite off something.
    let target = free >= 1 - OCCLUDE_DEADBAND ? 1 : free;
    // …and never wind the integrator down past the hard floor below. `_enforceMinimum` would
    // catch it anyway, but a `frac` parked at 0.1 against a clamp holding the lens at 3.9 m means
    // the recovery starts with a dead zone and then snaps. Floor it here so the boom always eases.
    if (minDistance > 0) target = Math.max(target, clamp01(minDistance / dist));

    // Hysteresis, both ways. Cutting in needs the block to persist — a single grazing frame on a
    // guardrail post must not collapse the boom — and recovery needs only a beat.
    if (target < this.frac - 0.01) {
      this._hold += dt;
      this._clear = 0;
      if (this._hold >= OCCLUDE_DELAY) {
        this.frac += (target - this.frac) * (1 - Math.exp(-PULL_RATE * dt));
      }
    } else {
      this._clear += dt;
      this._hold = Math.max(0, this._hold - dt * 2);
      if (target > this.frac + 0.01 && this._clear >= CLEAR_DELAY) {
        this.frac += (target - this.frac) * (1 - Math.exp(-PUSH_RATE * dt));
      }
    }
    this.frac = clamp01(this.frac);
    if (!Number.isFinite(this.frac)) this.frac = 1;
    this.blocked = this.frac < 0.985;

    out.copy(pivot).addScaledVector(dir, dist * this.frac);
    dbg.boom = dist;
    dbg.frac = this.frac;
    dbg.lift = this.lift;

    // Other cars: never sit inside an opponent's bodywork. A shove out sideways beats a pull-in
    // here — the rival is moving, so the situation resolves itself in half a second.
    _mark.copy(out);
    this._avoidCars(ctx, out, opts.subject, radius, dt);
    dbg.dCars = _mark.distanceTo(out);

    // ---------------------------------------------------------------- 3. framing constraints
    // The corridor is applied to the *final* position too, not just to the spring target: the
    // boom spring overshoots on turn-in and that overshoot is what put the lens in the wall.
    _mark.copy(out);
    if (corridor) corridor(out);
    dbg.dCorridor = _mark.distanceTo(out);
    _mark.copy(out);
    this._standOff(world, out, wallClearance, dt);
    dbg.dStandOff = _mark.distanceTo(out);
    _mark.copy(out);
    this._enforceMinimum(out, carPos, dir, minDistance, minHeight);
    dbg.dMin = _mark.distanceTo(out);

    // Final safety: whatever happened above, stay off the deck.
    if (terrain && world?.sampleGround) {
      const g = safeGround(world, out.x, out.z);
      if (g !== null && out.y < g + clearance) out.y = g + clearance;
    }
    return out;
  }

  /**
   * The floor under everything else. Fully occluded is a bad frame; inside the car's roof is not
   * a frame at all, so this wins over every avoidance layer above and is deliberately a hard
   * clamp in metres rather than another weight in the blend.
   */
  _enforceMinimum(out, carPos, dir, minDistance, minHeight) {
    if (!carPos) return;
    if (minDistance > 0) {
      let dx = out.x - carPos.x;
      let dz = out.z - carPos.z;
      let back = Math.hypot(dx, dz);
      if (back < 0.05) {
        // Degenerate: sitting on the car. Fall back to straight down the boom.
        dx = dir.x;
        dz = dir.z;
        back = Math.hypot(dx, dz);
        if (back < 1e-3) return;
      }
      if (back < minDistance) {
        const k = minDistance / back;
        out.x = carPos.x + dx * k;
        out.z = carPos.z + dz * k;
      }
    }
    if (minHeight > 0 && out.y < carPos.y + minHeight) out.y = carPos.y + minHeight;
  }

  /**
   * Slide off a barrier that is at lens height. This is the layer that actually earns its keep
   * now the raycast sees walls: a guardrail one metre to the side never blocks the car, it just
   * takes a third of the frame, and no amount of shortening the boom moves it out of shot.
   */
  _standOff(world, out, clear, dt) {
    const push = this._wall;
    let wantX = 0;
    let wantZ = 0;
    const list = clear > 0 ? world?.barriers : null;
    if (list?.length) {
      for (let i = 0; i < list.length; i++) {
        const seg = list[i];
        const p = seg.a;
        const q = seg.b;
        if (!p || !q) continue;
        const mx = (p.x + q.x) * 0.5 - out.x;
        const mz = (p.z + q.z) * 0.5 - out.z;
        if (mx * mx + mz * mz > STANDOFF_SEARCH_R2) continue;

        const ex = q.x - p.x;
        const ez = q.z - p.z;
        const len2 = ex * ex + ez * ez || 1e-6;
        let u = ((out.x - p.x) * ex + (out.z - p.z) * ez) / len2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = out.x - (p.x + ex * u);
        const dz = out.z - (p.z + ez * u);
        const d2 = dx * dx + dz * dz;
        if (d2 >= clear * clear) continue;
        // A wall well below the lens is already out of frame; hopping it is the terrain layer's job.
        const top = p.y + (q.y - p.y) * u + (seg.height ?? 1);
        if (top < out.y - WALL_BELOW) continue;

        const d = Math.sqrt(d2);
        const k = clear - d;
        const n = seg.normal;
        // Push straight off the wall, unless we are already on its far side — then the only way
        // back into shot is through the barrier line, along its inward normal.
        if (d > 1e-3 && (!n || dx * n.x + dz * n.z > 0)) {
          wantX += (dx / d) * k;
          wantZ += (dz / d) * k;
        } else if (n) {
          wantX += n.x * (k + d);
          wantZ += n.z * (k + d);
        }
      }
    }
    // Same shape as the car avoidance: snap away, ease back.
    const rate = wantX * wantX + wantZ * wantZ > push.lengthSq() ? 16 : 4;
    const a = 1 - Math.exp(-rate * dt);
    push.x += (wantX - push.x) * a;
    push.z += (wantZ - push.z) * a;
    if (!Number.isFinite(push.x) || !Number.isFinite(push.z)) push.set(0, 0, 0);
    out.x += push.x;
    out.z += push.z;
  }

  _avoidCars(ctx, out, subject, radius, dt) {
    const list = ctx.cars?.instances;
    const push = this._push;
    let wantX = 0;
    let wantZ = 0;
    if (list?.length) {
      for (let i = 0; i < list.length; i++) {
        const car = list[i];
        if (!car || car === subject) continue;
        const p = car.state?.position ?? car.root?.position;
        if (!p) continue;
        const dx = out.x - p.x;
        const dz = out.z - p.z;
        const dy = out.y - p.y;
        if (dy > 2.2 || dy < -1.4) continue; // we're clear over/under it
        const need = (car.def?.width ?? 1.95) * 0.62 + radius + 0.35;
        const d2 = dx * dx + dz * dz;
        if (d2 >= need * need || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const k = (need - d) / d;
        wantX += dx * k;
        wantZ += dz * k;
      }
    }
    const rate = wantX * wantX + wantZ * wantZ > push.lengthSq() ? 22 : 4.5;
    const a = 1 - Math.exp(-rate * dt);
    push.x += (wantX - push.x) * a;
    push.z += (wantZ - push.z) * a;
    if (!Number.isFinite(push.x) || !Number.isFinite(push.z)) push.set(0, 0, 0);
    out.x += push.x;
    out.z += push.z;
  }

  /**
   * Scan the boom against the world's 2D wall segments.
   * @returns {{frac:number, lift:number}} how far along the boom is clear, and how much higher
   *          the far end would have to be for the whole boom to clear every wall it crosses.
   */
  _barriers(world, pivot, desired, radius) {
    const list = world?.barriers;
    const res = _res;
    res.frac = 1;
    res.lift = 0;
    if (!list || !list.length) return res;
    const ax = pivot.x;
    const az = pivot.z;
    const bx = desired.x;
    const bz = desired.z;
    const ex = bx - ax;
    const ez = bz - az;
    const boomLen = Math.hypot(ex, ez) || 1;
    for (let i = 0; i < list.length; i++) {
      const seg = list[i];
      const p = seg.a;
      const q = seg.b;
      if (!p || !q) continue;
      const mx = (p.x + q.x) * 0.5 - ax;
      const mz = (p.z + q.z) * 0.5 - az;
      if (mx * mx + mz * mz > BARRIER_SEARCH_R2) continue;

      const fx = q.x - p.x;
      const fz = q.z - p.z;
      const denom = ex * fz - ez * fx;
      if (Math.abs(denom) < 1e-9) continue;
      const gx = p.x - ax;
      const gz = p.z - az;
      const t = (gx * fz - gz * fx) / denom; // along the boom
      const u = (gx * ez - gz * ex) / denom; // along the barrier
      if (t <= 0 || t >= 1 || u < 0 || u > 1) continue;

      // Are we flying over it? Barrier tops sit at (segment y) + height.
      const wallTop = p.y + (q.y - p.y) * u + (seg.height ?? 1);
      const camY = pivot.y + (desired.y - pivot.y) * t;
      const need = wallTop + radius + 0.15;
      if (camY > need) continue;

      // How much higher would the far end have to be for this crossing to clear?
      res.lift = Math.max(res.lift, (need - camY) / Math.max(t, 0.05));
      // …and where we'd have to stop if we can't lift.
      const back = (radius + 0.15) / boomLen;
      res.frac = Math.min(res.frac, clamp01(t - back));
    }
    return res;
  }
}

const _res = { frac: 1, lift: 0 };
const _mark = new THREE.Vector3();

function safeGround(world, x, z) {
  try {
    const g = world.sampleGround(x, z);
    const h = g?.height;
    // `hasGround` false means the query left the generated world and `height` is a clamped edge
    // value, not a real surface — clamping the boom to it would drag the camera to the horizon.
    if (g && g.hasGround === false) return null;
    return Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

function safeRay(ctx, origin, dir, dist) {
  const rc = ctx.physics?.raycast;
  if (typeof rc !== 'function' || !(dist > 0)) return null;
  try {
    return rc.call(ctx.physics, origin, dir, dist);
  } catch {
    return null;
  }
}
