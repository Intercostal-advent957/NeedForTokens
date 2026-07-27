/**
 * Cinematic director — used for the intro, the results screen and replays.
 *
 * Rather than one wandering camera, this is a *cut* editor: it picks a framed shot, holds it for a
 * few seconds, then cuts to a different kind of shot. Static shots (trackside pan, low wide pass)
 * are anchored to a point on the track ahead of the car and pan to hold it; attached shots (wheel
 * close-up, front three-quarter, drone) live in the car's frame and travel with it.
 *
 * The director only *proposes* a pose; CameraSystem still springs, collision-checks and shakes it.
 */
import * as THREE from 'three';
import { clamp, clamp01, makeRng, smoothstep } from '../core/MathX.js';

const SHOTS = [
  'tracksidePan',
  'lowWidePass',
  'wheelLevel',
  'frontThreeQuarter',
  'droneFollow',
  'chaseHero',
];

export class CinematicDirector {
  constructor(seed = 0x1d3a7) {
    this.rng = makeRng(seed);
    this.shot = 'chaseHero';
    this.time = 0;
    this.duration = 4;
    this.cut = false; // true on the frame a new shot starts
    this.anchored = false; // true while the camera is parked in the world, not riding the car
    this.fov = 40;
    this.position = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this._anchor = new THREE.Vector3();
    this._side = 1;
    this._lastShot = '';
  }

  reset() {
    this.time = this.duration; // force a cut on the next update
    this.cut = false;
  }

  /**
   * @param {object} ctx
   * @param {object} state VehicleState of the subject car
   * @param {number} dt
   * @param {number} speed m/s
   */
  update(ctx, state, dt, speed) {
    this.cut = false;
    this.time += dt;
    if (this.time >= this.duration) this._pickShot(ctx, state, speed);

    const pos = state.position;
    const q = state.quaternion;
    const fwd = _f.set(0, 0, -1).applyQuaternion(q);
    const flatF = _ff.set(fwd.x, 0, fwd.z);
    if (flatF.lengthSq() < 1e-6) flatF.set(0, 0, -1);
    flatF.normalize();
    const flatR = _fr.set(-flatF.z, 0, flatF.x);
    const k = clamp01(this.time / Math.max(this.duration, 0.001));
    this.anchored = this.shot === 'tracksidePan' || this.shot === 'lowWidePass';

    switch (this.shot) {
      // ---- static: the car drives past a parked camera ------------------------------
      case 'tracksidePan':
      case 'lowWidePass': {
        this.position.copy(this._anchor);
        this.lookAt.copy(pos).addScaledVector(_up, this.shot === 'lowWidePass' ? 0.55 : 0.8);
        // ease the aim slightly ahead of the car so it never feels like it's being chased by the lens
        this.lookAt.addScaledVector(flatF, clamp(speed * 0.18, 0, 7) * (1 - k * 0.6));
        this.fov = this.shot === 'lowWidePass' ? 52 : 34;
        // cut early once the car is past and shrinking away
        if (this.position.distanceToSquared(pos) > 95 * 95) this.time = this.duration;
        break;
      }

      // ---- attached: rides with the car ---------------------------------------------
      case 'wheelLevel': {
        this.position
          .copy(pos)
          .addScaledVector(flatF, 1.15 + Math.sin(this.time * 0.6) * 0.25)
          .addScaledVector(flatR, this._side * 1.85)
          .addScaledVector(_up, 0.34);
        this.lookAt
          .copy(pos)
          .addScaledVector(flatF, 0.9)
          .addScaledVector(flatR, this._side * 0.5)
          .addScaledVector(_up, 0.42);
        this.fov = 38;
        break;
      }

      case 'frontThreeQuarter': {
        // The hero angle: ahead of the car, off to one side, slightly high, looking back into it.
        const swing = Math.sin(this.time * 0.35) * 0.6;
        this.position
          .copy(pos)
          .addScaledVector(flatF, 7.4 + swing)
          .addScaledVector(flatR, this._side * (4.4 + swing * 0.4))
          .addScaledVector(_up, 2.15);
        this.lookAt.copy(pos).addScaledVector(_up, 0.72).addScaledVector(flatF, 0.4);
        this.fov = 36;
        break;
      }

      case 'droneFollow': {
        const drop = smoothstep(0, 1, k);
        this.position
          .copy(pos)
          .addScaledVector(flatF, -(13 - drop * 5.5))
          .addScaledVector(flatR, this._side * (3.4 - drop * 2.6))
          .addScaledVector(_up, 7.5 - drop * 4.6);
        this.lookAt.copy(pos).addScaledVector(_up, 0.75).addScaledVector(flatF, 4);
        this.fov = 40;
        break;
      }

      case 'chaseHero':
      default: {
        const orbit = (k - 0.5) * 0.9 * this._side;
        const c = Math.cos(orbit);
        const s = Math.sin(orbit);
        const ox = flatF.x * c + flatR.x * s;
        const oz = flatF.z * c + flatR.z * s;
        this.position
          .set(pos.x - ox * 8.6, pos.y + 2.35, pos.z - oz * 8.6)
          .addScaledVector(flatR, this._side * 0.6);
        this.lookAt.copy(pos).addScaledVector(_up, 0.85).addScaledVector(flatF, 3.5);
        this.fov = 42;
        break;
      }
    }

    return this;
  }

  _pickShot(ctx, state, speed) {
    const rng = this.rng;
    let next = SHOTS[rng.int(0, SHOTS.length - 1)];
    if (next === this._lastShot) next = SHOTS[(SHOTS.indexOf(next) + 1) % SHOTS.length];
    // Static shots need real speed to be worth cutting to.
    if ((next === 'tracksidePan' || next === 'lowWidePass') && speed < 14) next = 'frontThreeQuarter';

    this.shot = next;
    this._lastShot = next;
    this.time = 0;
    this.duration = next === 'tracksidePan' || next === 'lowWidePass' ? rng.range(2.4, 3.6) : rng.range(3.4, 5.2);
    this._side = rng.sign();
    this.cut = true;

    if (next === 'tracksidePan' || next === 'lowWidePass') {
      this._anchorStatic(ctx, state, speed, next);
    }
  }

  /** Park the camera on the verge, ahead of the car, so it drives into shot. */
  _anchorStatic(ctx, state, speed, shot) {
    const pos = state.position;
    const track = ctx.world?.track;
    const lead = clamp(18 + speed * 1.5, 26, 90);
    const low = shot === 'lowWidePass';
    const height = low ? 0.42 : 2.2;
    const side = this._side;

    let placed = false;
    if (track?.project && track?.pointAt && track?.rightAt) {
      try {
        const proj = track.project(pos);
        const tan = track.tangentAt(proj.t, _tan);
        const fwd = _f.set(0, 0, -1).applyQuaternion(state.quaternion);
        const dir = fwd.x * tan.x + fwd.z * tan.z >= 0 ? 1 : -1;
        const t = proj.t + (dir * lead) / (track.length || 1000);
        const p = track.pointAt(t, _p);
        const rgt = track.rightAt(t, _r);
        const w = track.widthAt?.(t) ?? 9;
        const off = low ? w * 0.62 : w * 1.55 + 3.5;
        this._anchor.copy(p).addScaledVector(rgt, side * off);
        this._anchor.y += height;
        placed = true;
      } catch {
        placed = false;
      }
    }
    if (!placed) {
      const fwd = _f.set(0, 0, -1).applyQuaternion(state.quaternion);
      const flatF = _ff.set(fwd.x, 0, fwd.z).normalize();
      const flatR = _fr.set(-flatF.z, 0, flatF.x);
      this._anchor
        .copy(pos)
        .addScaledVector(flatF, lead)
        .addScaledVector(flatR, side * (low ? 6 : 14));
      this._anchor.y += height;
    }

    // Keep it out of the dirt.
    const g = ctx.world?.sampleGround?.(this._anchor.x, this._anchor.z);
    if (g && Number.isFinite(g.height)) this._anchor.y = Math.max(this._anchor.y, g.height + height);
  }
}

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _ff = new THREE.Vector3();
const _fr = new THREE.Vector3();
const _p = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
