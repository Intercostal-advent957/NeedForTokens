/**
 * Corner anticipation.
 *
 * The single biggest tell of an amateur chase cam is that it only ever reacts: the car turns, then
 * the camera follows. A professional one swings *before* the turn-in so the corner is already
 * revealed when you need to commit to a line.
 *
 * We do that by asking the track where we will be in ~1 second and measuring the angle between the
 * current direction of travel and that point. That signed angle then (a) rotates the aim point into
 * the corner and (b) rotates the camera the *other* way, to the outside, which widens the view
 * across the apex and pushes the car off-centre — exactly the composition in the NFS press shots.
 *
 * Everything here is guarded: the track lane is being rewritten in parallel, so if `project()` or
 * `racingLine` is missing we degrade to a yaw-rate predictor that needs nothing but VehicleState.
 */
import * as THREE from 'three';
import { clamp, clamp01, wrapAngle, smoothstep } from '../core/MathX.js';
import { Lowpass } from './Spring.js';

/** Yaw of a world direction, matching three.js: yaw 0 looks down -Z, +yaw turns left (+X → -Z). */
export function yawOf(x, z) {
  return Math.atan2(-x, -z);
}

export class TrackAnticipation {
  constructor() {
    this.yaw = 0; // signed lead angle, + = corner goes left
    this.curvature = 0; // 1/m along the look-ahead window
    this.tightness = 0; // 0..1 normalised corner severity
    this.confidence = 0; // 0 = no track data, 1 = fully trusted
    this.aimPoint = new THREE.Vector3();
    this.hasTrack = false;
    // Corridor: where the car sits across the road, and the frame to clamp the camera into.
    this.lateral = 0;
    this.halfWidth = 9;
    this.trackPoint = new THREE.Vector3();
    this.trackRight = new THREE.Vector3(1, 0, 0);
    this.hasCorridor = false;
    /** 0..1 — inside a tunnel bore, where there is no headroom to lift the boom into. */
    this.tunnel = 0;
    this._track = null;
    this._camProj = null;
    /** Road gradient along the direction of travel (dy/ds). The car's own pitch is useless for
     *  this — it bucks under acceleration and over kerbs, which would pump the camera height. */
    this.slope = 0;
    this._slopeLp = new Lowpass(2.2);
    this._yawLp = new Lowpass(5.5);
    this._curvLp = new Lowpass(3.0);
    this._hint = -1;
    this._sample = new THREE.Vector3();
    this._acc = new THREE.Vector3();
  }

  reset() {
    this._yawLp.snap(0);
    this._curvLp.snap(0);
    this.yaw = 0;
    this.curvature = 0;
    this.tightness = 0;
    this._hint = -1;
  }

  /**
   * @param {object} ctx        game context
   * @param {object} state      VehicleState
   * @param {number} travelYaw  yaw the camera currently considers "forward"
   * @param {number} speed      m/s (horizontal)
   * @param {number} dt         seconds
   */
  update(ctx, state, travelYaw, speed, dt) {
    const track = ctx.world?.track;
    const pos = state.position;
    this._track = track ?? null;

    let raw = 0;
    let curv = 0;
    let conf = 0;
    this.hasCorridor = false;
    this.tunnel = 0;

    if (track?.project && track?.pointAt) {
      try {
        const proj = track.project(pos, this._hint);
        if (proj && Number.isFinite(proj.t)) {
          this._hint = proj.t;
          const len = track.length || 1000;

          // Corridor frame — used to keep the camera between the barriers.
          if (track.rightAt) {
            track.pointAt(proj.t, this.trackPoint);
            track.rightAt(proj.t, this.trackRight);
            this.lateral = proj.lateral ?? 0;
            this.halfWidth = proj.width ?? track.widthAt?.(proj.t) ?? 9;
            this.hasCorridor = Number.isFinite(this.trackPoint.x) && this.halfWidth > 0.5;
          }
          const bore = track.tunnelAt?.(proj.t);
          if (Number.isFinite(bore)) this.tunnel = clamp01(bore);

          // Which way round the loop are we actually going?
          const tan = track.tangentAt?.(proj.t, _tan);
          let dir = 1;
          if (tan) {
            const fx = -Math.sin(travelYaw);
            const fz = -Math.cos(travelYaw);
            dir = fx * tan.x + fz * tan.z >= 0 ? 1 : -1;
            this.slope = this._slopeLp.step(clamp(tan.y * dir, -0.45, 0.45), dt);
            this.hasSlope = true;
          }

          // Look further ahead the faster we go: ~1.1 s of travel, floored so it still works parked.
          const ahead = clamp(16 + speed * 1.15, 22, 110);
          const line = track.racingLine?.pointAt ? track.racingLine : null;

          // Weighted aim point over three probes — a single probe snaps between corner phases.
          const W = [0.22, 0.33, 0.45];
          const D = [0.42, 0.74, 1.0];
          this._acc.set(0, 0, 0);
          let wsum = 0;
          for (let i = 0; i < 3; i++) {
            const t = proj.t + (dir * ahead * D[i]) / len;
            const p = line ? line.pointAt(t, this._sample) : track.pointAt(t, this._sample);
            if (!p || !Number.isFinite(p.x)) continue;
            this._acc.addScaledVector(p, W[i]);
            wsum += W[i];
          }
          if (wsum > 0) {
            this._acc.multiplyScalar(1 / wsum);
            this.aimPoint.copy(this._acc);
            const dx = this._acc.x - pos.x;
            const dz = this._acc.z - pos.z;
            if (dx * dx + dz * dz > 1) {
              raw = wrapAngle(yawOf(dx, dz) - travelYaw);
              conf = 1;
            }
          }

          if (track.curvatureAt) {
            // Average curvature over the window, signed (+ = left) in track direction.
            let k = 0;
            let n = 0;
            for (let i = 1; i <= 4; i++) {
              const t = proj.t + (dir * ahead * (i / 4)) / len;
              const c = track.curvatureAt(t);
              if (Number.isFinite(c)) {
                k += c;
                n++;
              }
            }
            if (n) curv = (k / n) * dir;
          }
        }
      } catch {
        conf = 0;
      }
    }

    this.hasTrack = conf > 0;
    if (!this.hasSlope) this.slope = this._slopeLp.step(0, dt);
    this.hasSlope = false;

    // Yaw-rate predictor. Used alone when there's no track, and always mixed in a little because
    // it reacts instantly — the track term anticipates, this term keeps up.
    const yawRate = state.angularVelocity?.y ?? 0;
    const predicted = clamp(yawRate * 0.42, -0.55, 0.55);
    if (!this.hasTrack) {
      raw = predicted;
      // steering intent helps at low yaw rates (turn-in, before the car has rotated)
      raw += clamp((state.steer ?? 0) * 0.22, -0.3, 0.3);
    } else {
      raw = raw * 0.82 + predicted * 0.3;
    }

    // Anticipation is pointless when parked and dangerous when reversing.
    const gate = smoothstep(2.5, 14, speed) * (state.speed < -0.5 ? 0 : 1);
    raw = clamp(raw, -0.5, 0.5) * gate;

    this.yaw = this._yawLp.step(raw, dt);
    this.curvature = this._curvLp.step(curv, dt);
    this.tightness = clamp01(Math.abs(this.curvature) * 55);
    this.confidence = conf;
    return this.yaw;
  }

  /**
   * Ease a world point back inside `limit` metres of the centreline, in place.
   *
   * Measured at the point's OWN projection, not the car's: seven metres back down the road the
   * centreline has moved, and on a tight corner using the car's frame under-reports the camera's
   * true offset by most of a metre — exactly where the wall is.
   *
   * The knee leaves a small residual so the correction eases in rather than hitting a stop; keep
   * it well under a metre or the clamp stops being a clamp (the original 0.9 m knee let the boom
   * sit a metre outside a limit it was supposed to enforce).
   */
  /** |lateral offset| of a world point from the centreline, or NaN if the track can't say. */
  lateralAt(p) {
    const track = this._track;
    if (!track?.project || !this.hasCorridor) return NaN;
    let proj;
    try {
      proj = track.project(p, this._hint, (this._camProj ||= track.constructor?.makeProjection?.()));
    } catch {
      return NaN;
    }
    return Number.isFinite(proj?.lateral) ? Math.abs(proj.lateral) : NaN;
  }

  clampInside(p, limit, knee = 0.3) {
    const track = this._track;
    if (!track?.project || !this.hasCorridor || !(limit > 0)) return;
    let proj;
    try {
      proj = track.project(p, this._hint, (this._camProj ||= track.constructor?.makeProjection?.()));
    } catch {
      return;
    }
    const lat = proj?.lateral;
    if (!Number.isFinite(lat)) return;
    const over = Math.abs(lat) - limit;
    if (over <= 0) return;
    // Horizontal right vector: `lateral` is measured in plan view, so the correction must be too.
    const r = (track.flatRightAt ?? track.rightAt)?.call(track, proj.t, _right);
    if (!r || !Number.isFinite(r.x)) return;
    const move = (over - knee * (1 - Math.exp(-over / knee))) * (lat > 0 ? -1 : 1);
    p.x += r.x * move;
    p.z += r.z * move;
  }
}

const _tan = new THREE.Vector3();
const _right = new THREE.Vector3();
