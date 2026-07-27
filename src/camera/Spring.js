/**
 * Spring-damper primitives for the camera rig.
 *
 * The whole camera is modelled as a mass on a spring rather than an exponential lerp. The
 * difference matters: a lerp always lags proportionally to speed (the faster the car, the further
 * behind the camera sits, forever), whereas a damped spring with velocity feed-forward has *zero*
 * steady-state error at constant velocity and only deflects when the target accelerates. That
 * deflection is the entire "weight" of a AAA chase cam — the camera squats back when you get on
 * the throttle and swings through corners because the target turned, not because the maths is slow.
 *
 *   a = k·(target − x) − c·(v − ff·targetVel)
 *   k = ω²          ω = 2πf
 *   c = 2·ζ·ω       ζ = 1 is critical damping (no overshoot), ζ < 1 overshoots (used for punches)
 *
 * Integrated with semi-implicit Euler at a FIXED tick (see CAMERA_TICK) so a 30 fps machine and a
 * 600 fps machine converge to the same trajectory.
 */
import * as THREE from 'three';
import { TAU, clamp } from '../core/MathX.js';

/** Camera integration tick. 240 Hz keeps even the stiff cockpit springs (ω≈60) rock stable. */
export const CAMERA_TICK = 1 / 240;
/** Never chew through more than this many ticks in one frame — a stall must not spiral. */
export const CAMERA_MAX_TICKS = 16;

const _zero = new THREE.Vector3();

export class Spring3 {
  /**
   * @param {number} freq natural frequency in Hz — how fast it converges
   * @param {number} zeta damping ratio; 1 = critical
   * @param {number} feedForward 0..1 of the target's velocity the damper ignores
   */
  constructor(freq = 3, zeta = 1, feedForward = 1) {
    this.freq = freq;
    this.zeta = zeta;
    this.feedForward = feedForward;
    this.value = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.maxSpeed = Infinity;
  }

  configure(freq, zeta = this.zeta, feedForward = this.feedForward) {
    this.freq = freq;
    this.zeta = zeta;
    this.feedForward = feedForward;
    return this;
  }

  snap(v) {
    this.value.copy(v);
    this.vel.set(0, 0, 0);
    return this;
  }

  /** Kick the spring's velocity — impacts, landings, NOS punches. */
  impulse(v) {
    this.vel.add(v);
    return this;
  }

  /** Advance exactly `h` seconds. Call from the fixed-tick loop only. */
  integrate(target, targetVel, h) {
    const w = TAU * this.freq;
    const k = w * w;
    const c = 2 * this.zeta * w;
    const ff = this.feedForward;
    const tv = targetVel || _zero;
    const val = this.value;
    const vel = this.vel;

    vel.x += (k * (target.x - val.x) - c * (vel.x - ff * tv.x)) * h;
    vel.y += (k * (target.y - val.y) - c * (vel.y - ff * tv.y)) * h;
    vel.z += (k * (target.z - val.z) - c * (vel.z - ff * tv.z)) * h;

    if (this.maxSpeed < Infinity) {
      const sp = vel.length();
      if (sp > this.maxSpeed) vel.multiplyScalar(this.maxSpeed / sp);
    }

    val.x += vel.x * h;
    val.y += vel.y * h;
    val.z += vel.z * h;

    if (!Number.isFinite(val.x) || !Number.isFinite(val.y) || !Number.isFinite(val.z)) {
      val.copy(target);
      vel.set(0, 0, 0);
    }
    return val;
  }
}

export class Spring1 {
  constructor(freq = 3, zeta = 1, feedForward = 0) {
    this.freq = freq;
    this.zeta = zeta;
    this.feedForward = feedForward;
    this.value = 0;
    this.vel = 0;
  }

  configure(freq, zeta = this.zeta) {
    this.freq = freq;
    this.zeta = zeta;
    return this;
  }

  snap(v) {
    this.value = v;
    this.vel = 0;
    return this;
  }

  impulse(v) {
    this.vel += v;
    return this;
  }

  integrate(target, h, targetVel = 0) {
    const w = TAU * this.freq;
    const k = w * w;
    const c = 2 * this.zeta * w;
    this.vel += (k * (target - this.value) - c * (this.vel - this.feedForward * targetVel)) * h;
    this.value += this.vel * h;
    if (!Number.isFinite(this.value)) {
      this.value = target;
      this.vel = 0;
    }
    return this.value;
  }
}

/**
 * Spring on a circular quantity. Wraps the error into (-π, π] so a heading that crosses ±180°
 * takes the short way round instead of unwinding the long way.
 */
export class SpringAngle {
  constructor(freq = 3, zeta = 1) {
    this.freq = freq;
    this.zeta = zeta;
    this.value = 0;
    this.vel = 0;
  }

  configure(freq, zeta = this.zeta) {
    this.freq = freq;
    this.zeta = zeta;
    return this;
  }

  snap(v) {
    this.value = v;
    this.vel = 0;
    return this;
  }

  integrate(target, h, targetVel = 0) {
    const w = TAU * this.freq;
    const k = w * w;
    const c = 2 * this.zeta * w;
    let err = target - this.value;
    err = ((err + Math.PI) % TAU + TAU) % TAU - Math.PI;
    this.vel += (k * err - c * (this.vel - targetVel)) * h;
    this.vel = clamp(this.vel, -40, 40);
    this.value += this.vel * h;
    if (!Number.isFinite(this.value)) {
      this.value = target;
      this.vel = 0;
    }
    // keep the stored angle bounded so precision never degrades over a long session
    if (this.value > Math.PI || this.value < -Math.PI) {
      this.value = ((this.value + Math.PI) % TAU + TAU) % TAU - Math.PI;
    }
    return this.value;
  }
}

/** Critically-damped scalar low-pass — for cleaning up noisy physics signals (g-force, etc). */
export class Lowpass {
  constructor(rate = 6, initial = 0) {
    this.rate = rate;
    this.value = initial;
  }
  step(target, dt) {
    this.value += (target - this.value) * (1 - Math.exp(-this.rate * dt));
    if (!Number.isFinite(this.value)) this.value = target;
    return this.value;
  }
  snap(v) {
    this.value = v;
    return this;
  }
}
