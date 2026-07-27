import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathX.js';
import {
  makeVehicle,
  placeVehicle,
  syncCom,
  syncOrigin,
  staticHubY,
  staticRideHeight,
  staticPen,
} from './Vehicle.js';
import { stepVehicle, alignToRoad } from './VehicleStep.js';
import {
  SegmentGrid,
  collideBarriers,
  collideCars,
  rayVsWall,
  rayVsSphere,
  rayVsBox,
} from './Collision.js';

/**
 * Raycast-suspension vehicle dynamics. See CONTRACTS.md §9.
 *
 * Sub-systems:
 *   Tyre.js        combined-slip Pacejka fit, load sensitivity, camber, relaxation
 *   Drivetrain.js  torque curve -> clutch -> gearbox -> centre diff -> LSDs -> wheels
 *   Assists.js     ABS, traction control, slip-angle limiter + counter-steer helper
 *   Collision.js   capsule-vs-segment barriers, car-vs-car, analytic ray primitives
 *   Vehicle.js     state construction + THE RIDE HEIGHT CONTRACT (read it before touching
 *                  `suspensionOffset`; the car-art lane consumes it to place wheel meshes)
 *
 * `step(dt)` is called at a fixed 120 Hz from main.js. It sub-steps internally when a car is
 * moving far enough per tick to risk stepping past a barrier segment, so the sim is stable and
 * tunnel-free from a standstill to 350 km/h.
 */
export class PhysicsSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.vehicles = [];
    this.grid = null;
    this.substepDistance = 0.45; // metres of travel per sub-step
    // Headroom, not a budget: main.js already fixes the tick at 120 Hz, so at 300 km/h this
    // resolves to 2. It matters when the frame accumulator hands us a long dt after a hitch —
    // 8 sub-steps keeps the per-step travel under the ~1 m capsule radius all the way to the
    // 150 m/s velocity ceiling, which is what makes tunnelling impossible rather than unlikely.
    this.maxSubsteps = 8;
    this.stats = { substeps: 0, contacts: 0 };
    this._ray = { hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), surface: 'asphalt', distance: 0, tag: null };
  }

  async init() {
    const segs = this.ctx.world?.barriers;
    if (segs?.length) this.grid = new SegmentGrid(segs, 24);
    return this;
  }

  // ------------------------------------------------------------------ lifecycle

  attach(car, params = {}) {
    const v = makeVehicle(car, car.def, params);
    placeVehicle(v, car.root?.position ?? new THREE.Vector3(), car.root?.quaternion);
    this.vehicles.push(v);
    return v.state;
  }

  detach(car) {
    const i = this.vehicles.findIndex((x) => x.car === car);
    if (i >= 0) this.vehicles.splice(i, 1);
  }

  get(car) {
    return this.vehicles.find((x) => x.car === car) || null;
  }

  reset(car, position, quaternion) {
    const v = this.get(car);
    if (!v) return;
    placeVehicle(v, position, quaternion);
    // Drop the car onto the road at exactly its static ride height so a teleport never starts
    // with the body 20 cm in the air (which then falls, bounces, and ruins a screenshot).
    const world = this.ctx.world;
    if (world?.sampleGround) {
      const g = world.sampleGround(position.x, position.z, -1);
      v.state.position.y = g.height + staticRideHeight(v.def);
      syncCom(v);
    }
    v.state.driftScore = 0;
    v.state.damage.front = v.state.damage.rear = v.state.damage.left = v.state.damage.right = 0;
    v.state.damage.total = 0;
    v.state.nosAmount = 1;
    car.setDamage?.('frontL', 0);
  }

  setVelocityAlong(car, speedMs) {
    const v = this.get(car);
    if (!v) return;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(v.state.quaternion);
    v.state.velocity.copy(fwd).multiplyScalar(speedMs);
    for (const w of v.state.wheels) w.spin = speedMs / v.def.wheelRadius;
    // pick a sane starting gear rather than screaming in first
    const D = v.dt;
    if (!D.electric && D.ratios.length > 1) {
      const wheelOmega = speedMs / v.def.wheelRadius;
      let g = 1;
      for (let i = D.ratios.length; i >= 1; i--) {
        const rpm = Math.abs(wheelOmega * D.ratios[i - 1] * D.final) * (60 / (2 * Math.PI));
        if (rpm < D.redline * 0.94) {
          g = i;
          break;
        }
      }
      v.state.gear = g;
      v.state.rpm = clamp(
        Math.abs(wheelOmega * D.ratios[g - 1] * D.final) * (60 / (2 * Math.PI)),
        D.idle,
        D.redline
      );
      v.omegaFree = v.state.rpm * ((2 * Math.PI) / 60);
    }
  }

  /** Put a broken or badly stuck car back on the road, facing the right way. */
  recover(v) {
    const s = v.state;
    const track = this.ctx.world?.track;
    if (!Number.isFinite(s.position.x + s.position.z)) s.position.set(0, 5, 0);
    s.velocity.set(0, 0, 0);
    s.angularVelocity.set(0, 0, 0);
    if (track) {
      const proj = track.project(s.position, v.groundHint);
      const p = track.placeAt(proj.t, clamp(proj.lateral || 0, -3, 3), staticRideHeight(v.def));
      placeVehicle(v, p.position, p.quaternion);
    } else {
      s.quaternion.identity();
      placeVehicle(v, s.position, s.quaternion);
    }
  }

  // ------------------------------------------------------------------ step

  step(dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    let fastest = 0;
    for (const v of this.vehicles) fastest = Math.max(fastest, v.state.velocity.length());
    const n = clamp(Math.ceil((fastest * dt) / this.substepDistance), 1, this.maxSubsteps);
    const h = dt / n;
    this.stats.substeps = n;
    for (let k = 0; k < n; k++) {
      for (const v of this.vehicles) stepVehicle(this, v, h);
      this._collide(h);
    }
  }

  _collide(dt) {
    const world = this.ctx.world;
    const barriers = world?.barriers;
    const bus = this.ctx.bus;
    const now = this.ctx.time?.elapsed ?? 0;

    for (const v of this.vehicles) {
      v.collisionCooldown = Math.max(0, v.collisionCooldown - dt);
      if (barriers?.length) {
        // Two solver iterations. One pass leaves ~0.6 m of residual penetration on a 300 km/h
        // hit because the positional correction is deliberately under-relaxed (a full push-out
        // pops the car); a second pass cleans that up without reintroducing the pop.
        for (let it = 0; it < 2; it++) {
          const worst = collideBarriers(
            v.state, v.def, v.invMass, v.invI, barriers, this.grid,
            it === 0 ? (point, normal, jn, tag) => this._onImpact(v, point, normal, jn, tag, now) : null
          );
          syncCom(v);
          if (worst <= 0) break;
        }
      }
      // props: treat each as an immovable cylinder for now; breakables just take the hit
      const props = world?.props;
      if (props?.length) {
        for (const p of props) {
          if (!p?.position) continue;
          const dx = v.state.position.x - p.position.x;
          const dz = v.state.position.z - p.position.z;
          const rr = (p.radius || 0.4) + v.def.width * 0.5;
          if (dx * dx + dz * dz > rr * rr) continue;
          const d = Math.max(1e-4, Math.hypot(dx, dz));
          const nx = dx / d;
          const nz = dz / d;
          v.state.position.x += nx * (rr - d);
          v.state.position.z += nz * (rr - d);
          const vn = v.state.velocity.x * nx + v.state.velocity.z * nz;
          if (vn < 0) {
            const j = -vn * (1 + 0.1) * (p.mass ? clamp01(1 - p.mass / (p.mass + v.def.mass)) : 1);
            v.state.velocity.x += nx * j;
            v.state.velocity.z += nz * j;
            this._onImpact(v, v.state.position, { x: nx, y: 0, z: nz }, Math.abs(vn) * v.def.mass * 0.25, 'prop', now);
          }
          syncCom(v);
        }
      }
    }

    // car vs car
    for (let i = 0; i < this.vehicles.length; i++) {
      for (let j = i + 1; j < this.vehicles.length; j++) {
        const A = this.vehicles[i];
        const B = this.vehicles[j];
        const dx = A.state.position.x - B.state.position.x;
        const dz = A.state.position.z - B.state.position.z;
        const reach = (A.def.length + B.def.length) * 0.5 + 0.6;
        if (dx * dx + dz * dz > reach * reach) continue;
        const jn = collideCars(A, B, (point, normal, impulse) => {
          this._onImpact(A, point, normal, impulse, 'car', now);
          this._onImpact(B, point, { x: -normal.x, y: -normal.y, z: -normal.z }, impulse, 'car', now);
        });
        if (jn > 0) {
          syncCom(A);
          syncCom(B);
        }
      }
    }
  }

  _onImpact(v, point, normal, impulse, tag, now) {
    const s = v.state;
    if (impulse < 60) return;
    s.lastCollision = { time: now, impulse, normal: new THREE.Vector3(normal.x, normal.y, normal.z) };
    // Damage region from where the hit landed in body space.
    const local = new THREE.Vector3(point.x, point.y, point.z)
      .sub(s.position)
      .applyQuaternion(new THREE.Quaternion().copy(s.quaternion).invert());
    const amount = clamp01(impulse / (v.def.mass * 9));
    const region = Math.abs(local.z) > Math.abs(local.x) ? (local.z < 0 ? 'front' : 'rear') : local.x < 0 ? 'left' : 'right';
    s.damage[region] = clamp01(s.damage[region] + amount * 0.5);
    s.damage.total = clamp01(Math.max(s.damage.total, (s.damage.front + s.damage.rear + s.damage.left + s.damage.right) / 3));
    const corner =
      local.z < 0 ? (local.x < 0 ? 'frontL' : 'frontR') : local.x < 0 ? 'rearL' : 'rearR';
    v.car.setDamage?.(corner, s.damage[region]);
    // drift run ends on contact
    if (impulse > v.def.mass * 0.8) v.driftTimer = 0;

    if (v.collisionCooldown > 0) return;
    v.collisionCooldown = 0.06;
    // `impulse` is the NORMAL IMPULSE in newton-seconds (kg m/s) — the momentum actually
    // exchanged, not a made-up 0..1 severity. VFX and audio scale off it, so for calibration:
    // a light kerb brush is ~2 000, a firm barrier scrape ~20 000, a 300 km/h head-on ~85 000.
    this.ctx.bus.emit('car:collision', {
      car: v.car,
      impulse,
      point: new THREE.Vector3(point.x, point.y, point.z),
      normal: new THREE.Vector3(normal.x, normal.y, normal.z),
      tag,
    });
  }

  // ------------------------------------------------------------------ queries

  /**
   * General world raycast. Tests, in one pass and returning the NEAREST hit:
   *   - the road/terrain heightfield (marched, then bisected to millimetre accuracy)
   *   - `world.barriers` as vertical quads
   *   - `world.props` as spheres
   *   - city occluder boxes (`ctx.city.sectors[].boxes`) when the city lane exposes them
   *
   * The camera lane uses this for occlusion, so it must report buildings, not just ground.
   *
   * VEHICLES ARE DELIBERATELY NOT TESTED. Every caller so far raycasts *from* a car (camera
   * occlusion, AI look-ahead), so testing car bodies would mean every query hitting the querying
   * car at distance ~0 and no sane way to exclude it without changing this signature. If a lane
   * ever needs car occlusion, add an overload — do not start testing them here.
   *
   * @returns {{hit:boolean, point?:Vector3, normal?:Vector3, surface?:string, distance:number, tag?:string}}
   */
  raycast(origin, dir, maxDist = 100) {
    const world = this.ctx.world;
    const d = _rd.copy(dir);
    if (d.lengthSq() < 1e-12) return { hit: false, distance: maxDist };
    d.normalize();

    let best = maxDist;
    let hit = null;

    // ---- barriers
    // The query radius must cover the whole ray. It used to be `maxDist * 0.5 + 30`, which for
    // any query longer than 60 m silently stopped testing barriers before the ray ended — a
    // 100 m occlusion probe saw nothing past 80 m and reported clear air through a wall.
    const segs = this.grid ? this.grid.query(origin, maxDist + 4, _rsegs) : world?.barriers;
    if (segs) {
      for (let i = 0; i < segs.length; i++) {
        const t = rayVsWall(origin, d, segs[i], best);
        if (t >= 0 && t < best) {
          best = t;
          hit = { normal: segs[i].normal, surface: 'concrete', tag: segs[i].tag || 'barrier' };
        }
      }
    }

    // ---- props
    const props = world?.props;
    if (props) {
      for (let i = 0; i < props.length; i++) {
        const p = props[i];
        if (!p?.position) continue;
        const t = rayVsSphere(origin, d, p.position, (p.radius || 0.4) + 0.2, best);
        if (t >= 0 && t < best) {
          best = t;
          const pt = _rp.copy(d).multiplyScalar(t).add(origin);
          hit = { normal: pt.clone().sub(p.position).normalize(), surface: 'metal', tag: 'prop' };
        }
      }
    }

    // ---- city boxes
    const sectors = this.ctx.city?.sectors;
    if (sectors) {
      for (let si = 0; si < sectors.length; si++) {
        const sec = sectors[si];
        if (!sec?.boxes) continue;
        for (let bi = 0; bi < sec.boxes.length; bi++) {
          const b = sec.boxes[bi];
          if (!b?.min || !b?.max) continue;
          const t = rayVsBox(origin, d, b.min, b.max, best);
          if (t >= 0 && t < best) {
            best = t;
            hit = { normal: _boxNormal(origin, d, t, b, _rn), surface: 'concrete', tag: 'building' };
          }
        }
      }
    }

    // ---- ground: march, then bisect. sampleGround is analytic so this is exact enough.
    if (world?.sampleGround) {
      const stepLen = clamp(maxDist / 96, 0.25, 2.5);
      let prev = 0;
      let prevGap = origin.y - world.sampleGround(origin.x, origin.z).height;
      for (let t = stepLen; t <= Math.min(best, maxDist); t += stepLen) {
        const px = origin.x + d.x * t;
        const py = origin.y + d.y * t;
        const pz = origin.z + d.z * t;
        const gap = py - world.sampleGround(px, pz).height;
        if (gap <= 0 && prevGap > 0) {
          let lo = prev;
          let hi = t;
          for (let k = 0; k < 12; k++) {
            const mid = (lo + hi) * 0.5;
            const g = world.sampleGround(origin.x + d.x * mid, origin.z + d.z * mid);
            if (origin.y + d.y * mid - g.height > 0) lo = mid;
            else hi = mid;
          }
          if (hi < best) {
            best = hi;
            const g = world.sampleGround(origin.x + d.x * hi, origin.z + d.z * hi);
            hit = { normal: g.normal.clone(), surface: g.surface, tag: 'ground' };
          }
          break;
        }
        prev = t;
        prevGap = gap;
      }
    }

    if (!hit) return { hit: false, distance: maxDist };
    const r = this._ray;
    r.hit = true;
    r.distance = best;
    r.point.copy(d).multiplyScalar(best).add(origin);
    r.normal.copy(hit.normal);
    r.surface = hit.surface;
    r.tag = hit.tag;
    return { hit: true, point: r.point.clone(), normal: r.normal.clone(), surface: r.surface, distance: best, tag: r.tag };
  }

  /** Ground height helper other lanes occasionally want. */
  groundAt(x, z) {
    return this.ctx.world?.sampleGround?.(x, z) ?? { height: 0, normal: new THREE.Vector3(0, 1, 0), surface: 'asphalt', grip: 1 };
  }

  update() {}
  onQuality() {}
  dispose() {
    this.vehicles.length = 0;
  }
}

function _boxNormal(o, d, t, b, out) {
  const px = o.x + d.x * t;
  const py = o.y + d.y * t;
  const pz = o.z + d.z * t;
  const eps = 0.02;
  if (Math.abs(px - b.min.x) < eps) return out.set(-1, 0, 0);
  if (Math.abs(px - b.max.x) < eps) return out.set(1, 0, 0);
  if (Math.abs(pz - b.min.z) < eps) return out.set(0, 0, -1);
  if (Math.abs(pz - b.max.z) < eps) return out.set(0, 0, 1);
  if (Math.abs(py - b.max.y) < eps) return out.set(0, 1, 0);
  return out.set(0, -1, 0);
}

const _rd = new THREE.Vector3();
const _rp = new THREE.Vector3();
const _rn = new THREE.Vector3();
const _rsegs = []; // raycast's own broad-phase buffer — see SegmentGrid.query()

export { staticHubY, staticRideHeight, staticPen, alignToRoad, syncOrigin };
