import * as THREE from 'three';

/**
 * Time-trial ghost.
 *
 * Records the player's pose at a fixed rate for the lap in progress. When a lap turns out to be
 * the best so far, that buffer is promoted to the ghost and playback restarts from the next lap.
 *
 * The data is exposed rather than drawn: `race.ghost.sample(tSinceLapStart, out)` fills a
 * position + quaternion, and whoever owns the visuals (car-art / render lane) can attach a
 * translucent car to it. Nothing here touches the scene graph, so it cannot collide with another
 * lane's meshes.
 */
const RATE = 20; // Hz

export class GhostRecorder {
  constructor() {
    this.active = false;
    this.bestLap = 0;
    this.frames = null; // Float32Array, 8 floats per frame: x y z qx qy qz qw speed
    this.count = 0;
    this._buf = new Float32Array(8 * RATE * 400); // 400 s of headroom
    this._n = 0;
    this._acc = 0;
    this._out = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), speed: 0 };
  }

  reset() {
    this.frames = null;
    this.count = 0;
    this.bestLap = 0;
    this._n = 0;
    this._acc = 0;
    this.active = false;
  }

  /** Discard the lap in progress (start of a new lap, or a reset). */
  restartLap() {
    this._n = 0;
    this._acc = 0;
  }

  /** Sample the live car. `dt` is the fixed timestep. */
  record(dt, state) {
    if (!state) return;
    this._acc += dt;
    const step = 1 / RATE;
    if (this._acc < step) return;
    this._acc -= step;
    const i = this._n * 8;
    if (i + 8 > this._buf.length) return;
    this._buf[i] = state.position.x;
    this._buf[i + 1] = state.position.y;
    this._buf[i + 2] = state.position.z;
    this._buf[i + 3] = state.quaternion.x;
    this._buf[i + 4] = state.quaternion.y;
    this._buf[i + 5] = state.quaternion.z;
    this._buf[i + 6] = state.quaternion.w;
    this._buf[i + 7] = state.speed;
    this._n++;
  }

  /** Promote the lap just finished if it beat the ghost. */
  commitLap(lapTime) {
    if (this._n > 4 && (!this.bestLap || lapTime < this.bestLap)) {
      this.bestLap = lapTime;
      this.frames = this._buf.slice(0, this._n * 8);
      this.count = this._n;
      this.active = true;
    }
    this.restartLap();
  }

  /** Pose of the ghost `t` seconds into its lap. Returns null when there is no ghost yet. */
  sample(t, out = this._out) {
    if (!this.active || this.count < 2) return null;
    const f = Math.min(Math.max(t * RATE, 0), this.count - 1.001);
    const i0 = Math.floor(f);
    const a = f - i0;
    const i1 = Math.min(i0 + 1, this.count - 1);
    const A = i0 * 8;
    const B = i1 * 8;
    const F = this.frames;
    out.position.set(
      F[A] + (F[B] - F[A]) * a,
      F[A + 1] + (F[B + 1] - F[A + 1]) * a,
      F[A + 2] + (F[B + 2] - F[A + 2]) * a
    );
    _qa.set(F[A + 3], F[A + 4], F[A + 5], F[A + 6]);
    _qb.set(F[B + 3], F[B + 4], F[B + 5], F[B + 6]);
    out.quaternion.copy(_qa).slerp(_qb, a);
    out.speed = F[A + 7] + (F[B + 7] - F[A + 7]) * a;
    return out;
  }

  /** Seconds of recorded ghost lap. */
  get duration() {
    return this.count / RATE;
  }
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
