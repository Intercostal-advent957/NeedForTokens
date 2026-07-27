import * as THREE from 'three';
import { clamp, clamp01, noise1D, smoothstep, wrapAngle } from '../core/MathX.js';
import { CAMERA_TICK, CAMERA_MAX_TICKS, Lowpass, Spring1, Spring3, SpringAngle } from './Spring.js';
import { CYCLE_MODES, MODES, SURFACE_ROUGHNESS, TUNING } from './CameraTuning.js';
import { TrackAnticipation, yawOf } from './TrackLook.js';
import { OcclusionSolver } from './Occlusion.js';
import { CinematicDirector } from './CinematicDirector.js';

/**
 * Chase / hood / bumper / cinematic / orbit / photo cameras. See CONTRACTS.md §10.
 *
 * The rig is a spring-damper system, not a lerp (see Spring.js for why), integrated at a fixed
 * 240 Hz tick so it behaves identically at 30 and 600 fps. Position and aim run on deliberately
 * different springs — the aim is roughly twice as stiff as the boom, so the camera *looks* where
 * you are going before it has finished *moving* to where it should be. That split is what makes a
 * chase cam feel like a operator holding a shot instead of a rubber band.
 *
 * On top of the rig:
 *   - corner anticipation from the track (TrackLook.js)
 *   - drift framing: orbit to the outside of the slide so the car's angle reads
 *   - speed FOV with an under-damped NOS punch, accel pull-back / brake push-in, lateral roll
 *   - road + impact shake, engine vibration on the body-mounted cams
 *   - airborne lift and landing compression
 *   - collision avoidance with hysteresis (Occlusion.js)
 */
export class CameraSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.camera = ctx.camera;
    this.mode = 'chase';
    this.target = null;
    /** World m/s of the camera — PostFX motion blur reads this. */
    this.velocity = new THREE.Vector3();
    this.tuning = TUNING;

    // --- rig springs -------------------------------------------------------------
    const t = TUNING.chase;
    this._posSpring = new Spring3(t.posFreq, t.posZeta, t.posFeedForward);
    this._aimSpring = new Spring3(t.aimFreq, t.aimZeta, t.aimFeedForward);
    this._yawSpring = new SpringAngle(t.yawFreq, t.yawZeta);
    this._fovSpring = new Spring1(t.fovFreq, t.fovZeta);
    this._kick = new Spring3(2.15, 0.42, 0); // impact / NOS / landing displacement, rig space
    this._rollSpring = new Spring1(3.2, 0.85);
    this._fovSpring.snap(t.fov);

    // --- filtered signals --------------------------------------------------------
    this._gLat = new Lowpass(6.5);
    this._gLong = new Lowpass(3.6);
    this._drift = new Lowpass(3.4);
    this._driftSigned = new Lowpass(3.4);
    this._rough = new Lowpass(4.0);
    this._air = new Lowpass(3.0);
    this._lookBack = new Lowpass(6.0);
    this._speedLp = new Lowpass(2.5);
    this._pitchLp = new Lowpass(1.4);

    // --- helpers -----------------------------------------------------------------
    this._anticipate = new TrackAnticipation();
    this._occlusion = new OcclusionSolver();
    this._director = new CinematicDirector();

    // --- state -------------------------------------------------------------------
    this._acc = 0;
    this._shake = 0;
    this._shakeT = 0;
    this._shakeDur = 0.35;
    this._vibPhase = 0;
    this._photo = null;
    this._needSnap = true;
    this._lastCarPos = new THREE.Vector3();
    this._prev = new THREE.Vector3();
    this._lastSpeed = 0;
    this._frame = makeFrameState();
    /** Per-frame framing telemetry — see `_updateDiag`. Read-only for everyone else. */
    this.diag = {
      mode: 'chase',
      wantDist: 0,
      wantHeight: 0,
      back: 0,
      up: 0,
      fov: 0,
      speedKmh: 0,
      tunnel: 0,
      hasCorridor: false,
      halfWidth: 0,
      camLateral: NaN,
      carLateral: 0,
      occ: this._occlusion.debug,
    };
    this._unsub = [];
    // Bound once: the occlusion solver calls these per frame and must not allocate a closure.
    this._corridorClamp = (p) => this._clampToCorridor(p);
    this._onRoad = (p) => {
      const lat = this._anticipate.lateralAt(p);
      return Number.isFinite(lat) && lat <= this._anticipate.halfWidth + 2.0;
    };
  }

  async init() {
    const bus = this.ctx.bus;
    if (bus?.on) {
      this._unsub.push(
        bus.on('car:collision', (e) => this._onCollision(e)),
        bus.on('car:land', (e) => this._onLand(e)),
        bus.on('car:nos', (e) => this._onNos(e)),
        bus.on('car:shift', (e) => this._onShift(e))
      );
    }
    return this;
  }

  // ------------------------------------------------------------------ public API

  setTarget(car) {
    if (car !== this.target) this._needSnap = true;
    this.target = car;
  }

  setMode(m) {
    if (!MODES.includes(m)) return;
    if (m !== this.mode) {
      const boom = (x) => x === 'chase' || x === 'chaseFar';
      // Swapping between the two boom cams is a smooth pull-back; everything else is a hard cut.
      if (!(boom(m) && boom(this.mode))) this._needSnap = true;
      this.mode = m;
      if (m === 'cinematic') this._director.reset();
    }
    this.ctx.bus?.emit?.('camera:mode', { mode: m });
  }

  cycleMode() {
    const i = CYCLE_MODES.indexOf(this.mode);
    this.setMode(CYCLE_MODES[(i + 1) % CYCLE_MODES.length]);
  }

  shake(strength, duration = 0.35) {
    if (!(strength > 0)) return;
    if (strength >= this._shake || this._shakeT <= 0) this._shakeDur = Math.max(duration, 0.05);
    this._shake = Math.max(this._shake, strength);
    this._shakeT = Math.max(this._shakeT, duration);
  }

  /** Force the rig to the ideal pose on the next update — used after teleports/cuts. */
  snap() {
    this._needSnap = true;
  }

  /** Current aim point in world space (handy for audio/UI). */
  get lookAt() {
    return this._aimSpring.value;
  }

  get fov() {
    return this.camera.fov;
  }

  /**
   * Photo/QA camera. `position` and `lookAt` are relative to the target car (and rotated into
   * its heading) unless `absolute` is set — otherwise every showcase shot would frame world
   * origin instead of the car. DO NOT change these semantics: the screenshot harness and the
   * blind-comparison critic both depend on them.
   */
  setPhotoPose(pose) {
    this._photo = pose
      ? {
          position: toVec3(pose.position, 0, 1, 5),
          lookAt: toVec3(pose.lookAt, 0, 0, 0),
          fov: pose.fov ?? 40,
          absolute: !!pose.absolute,
          worldUp: !!pose.worldUp,
        }
      : null;
    if (this._photo) {
      this.mode = 'photo';
      this._fovSpring.snap(this._photo.fov);
      this._needSnap = true;
    }
  }

  // ------------------------------------------------------------------ events

  _onCollision(e) {
    if (!this._isSubject(e?.car)) return;
    const j = clamp01((e.impulse ?? 0) / 42000);
    this.shake(0.35 + j * 1.15, 0.28 + j * 0.4);
    // Shove the rig along the impact normal so the hit has weight.
    const n = e.normal;
    if (n && this._frame.valid) {
      const f = this._frame;
      const lat = n.x * f.rigRight.x + n.z * f.rigRight.z;
      const lon = n.x * f.rigFwd.x + n.z * f.rigFwd.z;
      this._kick.impulse(_v1.set(lat * j * 7, j * 3, -lon * j * 6));
    }
  }

  _onLand(e) {
    if (!this._isSubject(e?.car)) return;
    const i = clamp01((e.impact ?? 0) / 14);
    this.shake(0.25 + i * 0.9, 0.3 + i * 0.35);
    // Compression: the camera keeps falling for a beat, then the spring pushes it back up.
    this._kick.impulse(_v1.set(0, -(2.5 + i * 9), -(0.6 + i * 2.5)));
  }

  _onNos(e) {
    if (!this._isSubject(e?.car)) return;
    if (e.active) {
      this._fovSpring.impulse(46);
      this._kick.impulse(_v1.set(0, 0, 3.4));
      this.shake(0.16, 0.25);
    } else {
      this._fovSpring.impulse(-16);
    }
  }

  _onShift(e) {
    if (!this._isSubject(e?.car) || !e?.up) return;
    this._kick.impulse(_v1.set(0, 0, 0.85));
  }

  _isSubject(car) {
    if (!car) return false;
    return car === (this.target ?? this.ctx.player);
  }

  // ------------------------------------------------------------------ update

  update(dt, ctx) {
    const cam = this.camera;
    this._prev.copy(cam.position);
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;

    if (this.mode === 'photo' && this._photo) {
      this._updatePhoto(cam, dt);
      return;
    }

    const car = this.target ?? ctx.player;
    const s = car?.state;
    if (!s || !Number.isFinite(s.position?.x)) {
      this.velocity.multiplyScalar(Math.exp(-6 * dt));
      return;
    }

    this._prepareFrame(s, car, dt, ctx);

    if (this._needSnap) this._snapRig();

    // ---- fixed-tick integration ------------------------------------------------
    this._acc += dt;
    let steps = 0;
    while (this._acc >= CAMERA_TICK && steps < CAMERA_MAX_TICKS) {
      this._tick(CAMERA_TICK);
      this._acc -= CAMERA_TICK;
      steps++;
    }
    if (steps === CAMERA_MAX_TICKS) this._acc = 0;

    // ---- collision avoidance ---------------------------------------------------
    const f = this._frame;
    const finalPos = _pos;
    if (f.tune.bodyMounted) {
      finalPos.copy(this._posSpring.value);
      this._occlusion.reset();
    } else {
      _desired.copy(this._posSpring.value);
      this._occlusion.solve(
        ctx,
        f.pivot,
        _desired,
        {
          radius: f.tune.probeRadius,
          clearance: f.tune.minGroundClearance,
          dt: Math.max(dt, 1e-4),
          subject: car,
          carPos: f.carPos,
          minDistance: f.tune.minDistance ?? 0,
          minHeight: f.tune.minHeight ?? 0,
          selfRadius: f.tune.selfRadius ?? 2.6,
          wallClearance: f.tune.wallClearance ?? 0,
          // No headroom inside a bore: lifting over a kerb there puts the lens in the crown.
          maxLift: this._anticipate.tunnel > 0.35 ? 0.25 : Infinity,
          corridor: this._corridorClamp,
          onRoad: this._anticipate.hasCorridor ? this._onRoad : null,
        },
        finalPos
      );
    }

    // ---- write the camera ------------------------------------------------------
    cam.position.copy(finalPos);
    cam.up.set(0, 1, 0);
    _aim.copy(this._aimSpring.value);
    if (_aim.distanceToSquared(finalPos) < 0.04) _aim.addScaledVector(f.rigFwd, 1);
    // Guard the pose we are actually going to render, not just the spring target. The target was
    // framed from the ideal boom; the avoidance layers then moved the lens, and the aim spring
    // lags a violent slide — either can push the subject out of the composition on its own.
    if (!f.tune.bodyMounted && this.mode !== 'cinematic') this._frameGuard(finalPos, _aim);
    cam.lookAt(_aim);
    if (Math.abs(this._rollSpring.value) > 1e-4) cam.rotateZ(this._rollSpring.value);

    this._applyShake(cam, dt, ctx);

    const fov = clamp(this._fovSpring.value, 22, 118);
    if (Math.abs(cam.fov - fov) > 0.008) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    this._commitVelocity(cam, dt);
    this._updateDiag(cam, f);
    ctx.debug?.log?.('camMode', this.mode);
  }

  /**
   * Numbers, not vibes. `cameras.diag` is what you read when the framing is wrong: it says how
   * long the boom actually ended up, how long it wanted to be, and which avoidance layer took the
   * difference. Every previous regression here was diagnosed by eye and fixed by guesswork.
   */
  _updateDiag(cam, f) {
    const d = this.diag;
    d.mode = this.mode;
    d.wantDist = f.distance;
    d.wantHeight = f.height;
    d.back = Math.hypot(cam.position.x - f.carPos.x, cam.position.z - f.carPos.z);
    d.up = cam.position.y - f.carPos.y;
    d.fov = cam.fov;
    d.speedKmh = f.speedKmh;
    d.tunnel = this._anticipate.tunnel;
    d.hasCorridor = this._anticipate.hasCorridor;
    d.halfWidth = this._anticipate.halfWidth;
    d.camLateral = this._anticipate.lateralAt(cam.position);
    d.carLateral = this._anticipate.lateral;
    d.occ = this._occlusion.debug;
  }

  _updatePhoto(cam, dt) {
    this._resolvePhoto(_pos, _aim);
    cam.position.copy(_pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(_aim);
    if (cam.fov !== this._photo.fov) {
      cam.fov = this._photo.fov;
      cam.updateProjectionMatrix();
    }
    this._fovSpring.snap(this._photo.fov);
    this._commitVelocity(cam, dt);
  }

  _resolvePhoto(out, outLook) {
    const p = this._photo;
    const car = this.target ?? this.ctx.player;
    if (p.absolute || !car?.state) {
      out.copy(p.position);
      outLook.copy(p.lookAt);
      return;
    }
    const s = car.state;
    const yaw = p.worldUp ? _q.identity() : _q.copy(s.quaternion);
    out.copy(p.position).applyQuaternion(yaw).add(s.position);
    outLook.copy(p.lookAt).applyQuaternion(yaw).add(s.position);
  }

  _commitVelocity(cam, dt) {
    if (dt > 1e-5) {
      _v1.subVectors(cam.position, this._prev).divideScalar(dt);
      if (_v1.lengthSq() > 1e7) _v1.set(0, 0, 0); // teleport — don't smear the whole screen
      // The fixed tick means an occasional frame advances the rig zero times; smoothing over
      // ~80 ms recovers the true average without lagging a real acceleration.
      this.velocity.lerp(_v1, 1 - Math.exp(-14 * dt));
    }
  }

  // ------------------------------------------------------------------ per-frame prep

  _prepareFrame(s, car, dt, ctx) {
    const f = this._frame;
    const tune = TUNING[this.mode] ?? TUNING.chase;
    f.tune = tune;
    f.valid = true;
    f.dt = dt;

    // ---- basis ------------------------------------------------------------------
    f.carPos.copy(s.position);
    f.carFwd.set(0, 0, -1).applyQuaternion(s.quaternion);
    f.carRight.set(1, 0, 0).applyQuaternion(s.quaternion);
    f.carUp.set(0, 1, 0).applyQuaternion(s.quaternion);
    f.carVel.copy(s.velocity ?? _zero);

    const vx = f.carVel.x;
    const vz = f.carVel.z;
    const speed = Math.hypot(vx, vz);
    f.speed = speed;
    f.speedKmh = Math.abs(s.speedKmh ?? speed * 3.6);
    f.speedN = clamp01(f.speedKmh / 320);
    const speedSmooth = this._speedLp.step(f.speed, dt);

    // Teleport / respawn detection — the QA harness warps the car constantly.
    const jump = f.carPos.distanceTo(this._lastCarPos);
    if (jump > Math.max(speed * dt * 3, 6) && this._lastCarPos.lengthSq() > 0) this._needSnap = true;
    this._lastCarPos.copy(f.carPos);

    // ---- headings ---------------------------------------------------------------
    const headingYaw = yawOf(f.carFwd.x, f.carFwd.z);
    const travelYaw = speed > 1.2 && (s.speed ?? 1) > -0.5 ? yawOf(vx, vz) : headingYaw;
    f.headingYaw = headingYaw;

    // ---- drift ------------------------------------------------------------------
    const driftAngle = clamp(s.driftAngle ?? 0, -1.0, 1.0);
    const driftRaw = s.drifting ? clamp01((Math.abs(driftAngle) - 0.13) / 0.42) : 0;
    const drift = this._drift.step(driftRaw, dt);
    const driftSigned = this._driftSigned.step(s.drifting ? driftAngle : 0, dt);
    f.drift = drift;
    f.driftSigned = driftSigned;

    // ---- g-forces ---------------------------------------------------------------
    // gForce.x from physics is a body-frame derivative and reads ~0 in a steady corner, so the
    // honest number is the centripetal term v·ω. + = pushed to the car's right.
    const yawRate = clamp(s.angularVelocity?.y ?? 0, -4, 4);
    const gLatRaw = clamp(-speed * yawRate * 0.102 + (s.gForce?.x ?? 0) * 0.15, -2.6, 2.6);
    f.gLat = this._gLat.step(gLatRaw, dt);
    const dSpeed = dt > 1e-5 ? (f.speed - this._lastSpeed) / dt / 9.81 : 0;
    this._lastSpeed = f.speed;
    const gLongRaw = clamp(dSpeed * 0.5 + (s.gForce?.z ?? 0) * 0.5, -3, 3);
    f.gLong = this._gLong.step(gLongRaw, dt);
    f.yawRate = yawRate;

    // ---- surface / airborne -----------------------------------------------------
    let rough = 0;
    let contacts = 0;
    const wheels = s.wheels;
    if (wheels) {
      for (let i = 0; i < wheels.length; i++) {
        const w = wheels[i];
        if (!w?.contact) continue;
        contacts++;
        rough += SURFACE_ROUGHNESS[w.surface] ?? 0.15;
        if (w.lockedUp) rough += 0.35;
        if (w.spinningUp) rough += 0.2;
      }
    }
    f.roughness = this._rough.step(contacts ? rough / contacts : 0, dt);

    const airT = smoothstep(0.12, 0.65, s.airTime ?? 0);
    f.air = this._air.step(s.airborne ? airT : 0, dt);

    // ---- look back --------------------------------------------------------------
    const wantBack = tune.lookBack && ctx.input?.state?.lookBack ? 1 : 0;
    f.lookBack = this._lookBack.step(wantBack, dt);

    // ---- corner anticipation ----------------------------------------------------
    const anticip = this._anticipate.update(ctx, s, travelYaw, speed, dt) * tune.anticipation;
    f.anticipation = anticip * (1 - f.lookBack);
    f.tightness = this._anticipate.tightness;
    // Road gradient, not car pitch — see TrackLook. Falls back to a heavily filtered body pitch.
    f.slope = this._anticipate.hasTrack
      ? this._anticipate.slope
      : this._pitchLp.step(clamp(f.carFwd.y, -0.4, 0.4), dt) * 0.6;

    // ---- rig yaw target ---------------------------------------------------------
    // Behind the direction of *travel* during a slide (so the car shows its angle) and behind the
    // nose when planted (steadier, immune to counter-steer flicking).
    const travelBlend = clamp01(smoothstep(3, 15, speed) * (0.22 + 0.7 * drift));
    let yawTarget = headingYaw + wrapAngle(travelYaw - headingYaw) * travelBlend;
    // Swing to the outside of the corner: opposite the aim, which opens the view across the apex.
    yawTarget -= f.anticipation * 0.26;
    // Orbit to the outside of the slide so the car's angle reads. driftSigned > 0 = tail out to
    // the right of travel, so the outside is to the right. Clamped: this physics happily reports
    // 40° of slip and a raw proportional orbit would put the camera on the car's door.
    yawTarget -= clamp(driftSigned * 0.52 * tune.driftOrbit, -0.34, 0.34);
    yawTarget += f.lookBack * Math.PI;
    f.yawTarget = yawTarget;
    f.aimYaw = travelYaw + f.anticipation * 0.5 - clamp(driftSigned * 0.14, -0.1, 0.1);

    // ---- boom geometry ----------------------------------------------------------
    const speedT = clamp01(speedSmooth / 88);
    f.distance =
      tune.distance +
      tune.distanceSpeed * speedT +
      drift * 1.15 * tune.driftOrbit +
      f.air * 2.6 * tune.airLift +
      clamp(f.gLong, 0, 1.6) * tune.accelPull -
      clamp(-f.gLong, 0, 1.6) * tune.brakePush -
      f.tightness * 0.5;
    f.height =
      tune.height +
      tune.heightSpeed * speedT +
      f.air * 2.2 * tune.airLift +
      f.tightness * 0.18 -
      drift * 0.16 * tune.driftOrbit; // drop a little in a slide — a lower lens sells the angle
    f.lateral = tune.lateral;
    f.lookHeight = tune.lookHeight - f.air * 0.55 * tune.airLift;
    f.lookAhead =
      (tune.lookAhead + tune.lookAheadSpeed * speedT) * (1 - f.air * 0.35) * (1 - drift * 0.18);

    // ---- pivot (what we must keep sight of) -------------------------------------
    f.pivot.copy(f.carPos).addScaledVector(_up, 0.95);

    // ---- lens -------------------------------------------------------------------
    f.fovTarget =
      tune.fov +
      tune.fovSpeed * f.speedN +
      (s.nosActive ? tune.fovNos : 0) +
      drift * tune.fovDrift +
      f.air * 2.0;

    // ---- roll -------------------------------------------------------------------
    const carRoll = Math.asin(clamp(-f.carRight.y, -1, 1));
    f.rollTarget = clamp(-(f.gLat * tune.rollGain) - carRoll * tune.bankFollow * 0.9, -0.048, 0.048);

    // ---- mode-specific mounts ---------------------------------------------------
    if (tune.bodyMounted) {
      const def = car.def ?? {};
      f.mountUp = (def.height ?? 1.2) * tune.mountHeight;
      f.mountFwd = (def.length ?? 4.5) * tune.mountForward;
    }
    // Velocity feed-forward: right for anything riding the car, catastrophic for a parked camera
    // (the damper would push it downrange at the car's speed and hold a permanent offset).
    f.springVel = f.carVel;
    if (this.mode === 'cinematic') {
      this._director.update(ctx, s, dt, speed);
      if (this._director.cut) this._needSnap = true;
      if (this._director.anchored) f.springVel = _zero;
      f.fovTarget = this._director.fov + f.speedN * tune.fovSpeed + (s.nosActive ? tune.fovNos : 0);
    }
    if (this.mode === 'orbit') {
      f.orbitAngle = (ctx.time?.elapsed ?? 0) * 0.28;
    }
  }

  // ------------------------------------------------------------------ rig build + tick

  /** Desired camera pose for a given rig yaw. Runs inside the fixed tick. */
  _buildRig(yaw, outPos, outAim) {
    const f = this._frame;
    const tune = f.tune;

    if (tune.bodyMounted) {
      outPos
        .copy(f.carPos)
        .addScaledVector(f.carUp, f.mountUp)
        .addScaledVector(f.carFwd, f.mountFwd);
      // Aim along the car's real forward (so the horizon bobs with the suspension) flattened a
      // little for readability, then rotated by the anticipation lead.
      _dir.copy(f.carFwd);
      _dir.y *= 0.55;
      _dir.normalize().applyAxisAngle(_up, f.anticipation * 0.5);
      outAim
        .copy(outPos)
        .addScaledVector(_dir, f.lookAhead)
        .addScaledVector(_up, tune.lookHeight * 0.25);
      // Only the vertical part of an impact kick reaches a body-mounted cam, and heavily damped.
      outPos.addScaledVector(_up, this._kick.value.y * 0.014);
      return;
    }

    if (this.mode === 'cinematic') {
      outPos.copy(this._director.position);
      outAim.copy(this._director.lookAt);
      return;
    }

    // Boom rig: yaw + a slope-following pitch so the camera stays behind the car uphill.
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    f.rigFwd.set(-sy, f.slope * 0.85, -cy).normalize();
    f.rigRight.set(cy, 0, -sy);
    f.rigUp.crossVectors(f.rigRight, f.rigFwd).normalize();

    if (this.mode === 'orbit') {
      const a = f.orbitAngle;
      outPos
        .copy(f.carPos)
        .add(_v1.set(Math.cos(a) * f.distance, f.height, Math.sin(a) * f.distance));
      outAim.copy(f.carPos).addScaledVector(_up, f.tune.lookHeight);
      return;
    }

    outPos
      .copy(f.carPos)
      .addScaledVector(f.rigFwd, -f.distance)
      .addScaledVector(f.rigUp, f.height)
      .addScaledVector(f.rigRight, f.lateral);
    this._kickToWorld(outPos);
    this._clampToCorridor(outPos);

    const ay = f.aimYaw;
    _dir.set(-Math.sin(ay), f.slope * 0.9, -Math.cos(ay)).normalize();
    if (f.lookBack > 0.001) {
      // Rotate the aim round with the rig so look-back frames the road behind.
      _dir.applyAxisAngle(_up, f.lookBack * Math.PI);
    }
    outAim
      .copy(f.carPos)
      .addScaledVector(_up, f.lookHeight)
      .addScaledVector(_dir, f.lookAhead);
    this._frameGuard(outPos, outAim);
  }

  /**
   * Soft framing box. Anticipation and drift orbit both push the car away from the aim axis, and
   * with an arcade physics reporting 40° slip angles they can gang up and shove it off the side of
   * the screen. This measures the actual on-screen offset and rotates the aim back just enough to
   * keep the subject inside a horizontal box — the composition stays deliberate instead of lucky.
   */
  _frameGuard(camPos, aim) {
    const f = this._frame;
    const carYaw = yawOf(f.carPos.x - camPos.x, f.carPos.z - camPos.z);
    const aimYaw = yawOf(aim.x - camPos.x, aim.z - camPos.z);
    const off = wrapAngle(aimYaw - carYaw);
    const max = FRAME_MAX_OFFSET;
    if (Math.abs(off) <= max) return;
    _v1.subVectors(aim, camPos).applyAxisAngle(_up, (off > 0 ? max - off : -max - off));
    aim.copy(camPos).add(_v1);
  }

  /**
   * Keep the boom inside the road corridor.
   *
   * Reactive occlusion alone is not enough: when the car is scraping the outside wall, a camera
   * that swings wide for the corner ends up *behind* the barrier, and every fix from there is
   * ugly (jam the camera into the boot, or lift it into a helicopter shot). Constraining the
   * desired position to the drivable corridor in the first place means the occlusion solver only
   * ever has to deal with genuine obstacles.
   *
   * The limit follows the car rather than the tarmac. A flat multiple of the road half-width
   * looks right until the driver runs wide onto the run-off — then it pins the camera over the
   * white line while the subject leaves the corridor, and the car slides off the side of frame.
   * Wherever the car goes, the camera is allowed to follow; what actually stops it is the wall
   * stand-off in the occlusion solver, which knows where the barriers are.
   */
  _clampToCorridor(out) {
    const a = this._anticipate;
    if (!a.hasCorridor) return;
    a.clampInside(out, this._corridorLimit());
  }

  /**
   * How far off the centreline the boom may sit. Either it stays on the road (plus a margin for
   * the corner swing), or — when the driver has left the road — it goes as far as the car and a
   * metre more, which is roughly the chord a boom directly behind the car cuts on a bend anyway.
   */
  _corridorLimit() {
    const a = this._anticipate;
    const margin = this._frame.tune.corridorMargin ?? 1.2;
    const limit = Math.max(a.halfWidth * 1.08 + margin, Math.abs(a.lateral ?? 0) + 1.0);
    // A tunnel bore is furniture: it is in neither `world.barriers` nor `physics.raycast`, so no
    // reactive layer can ever see it — the pull-in, the stand-off and the lift are all blind in
    // there and measurably do nothing. The corridor is the ONLY thing holding the lens off four
    // metres of concrete, so in a bore it stops tracking the car and holds the carriageway: the
    // driver running wide onto the shoulder is exactly when a boom that follows him ends up with
    // its nose in the tiles, which is the whole tunnel failure (a grey wedge over half the frame).
    return a.tunnel > 0.35 ? Math.min(a.halfWidth + 1.1, Math.max(limit, 0)) : limit;
  }

  /** Apply the impact/NOS/landing kick, expressed in rig axes (x right, y up, z back). */
  _kickToWorld(out) {
    const k = this._kick.value;
    if (k.lengthSq() < 1e-6) return;
    const f = this._frame;
    out.addScaledVector(f.rigRight, k.x * 0.1);
    out.addScaledVector(_up, k.y * 0.055);
    out.addScaledVector(f.rigFwd, -k.z * 0.11);
  }

  _tick(h) {
    const f = this._frame;
    const tune = f.tune;
    this._posSpring.configure(tune.posFreq, tune.posZeta, tune.posFeedForward);
    this._aimSpring.configure(tune.aimFreq, tune.aimZeta, tune.aimFeedForward);
    this._yawSpring.configure(tune.yawFreq, tune.yawZeta);
    this._fovSpring.configure(tune.fovFreq, tune.fovZeta);

    const yaw = this._yawSpring.integrate(f.yawTarget, h);
    this._buildRig(yaw, _desired, _aimTarget);
    this._posSpring.integrate(_desired, f.springVel, h);
    this._aimSpring.integrate(_aimTarget, f.carVel, h);
    this._fovSpring.integrate(f.fovTarget, h);
    this._rollSpring.integrate(f.rollTarget, h);
    this._kick.integrate(_zero, null, h);
  }

  _snapRig() {
    const f = this._frame;
    if (!f.valid) return;
    this._yawSpring.snap(f.yawTarget);
    this._buildRig(f.yawTarget, _desired, _aimTarget);
    this._posSpring.snap(_desired);
    this._aimSpring.snap(_aimTarget);
    this._fovSpring.snap(f.fovTarget);
    this._rollSpring.snap(f.rollTarget);
    this._kick.snap(_zero);
    this._occlusion.reset();
    this._anticipate.reset();
    this._acc = 0;
    this._needSnap = false;
    this.velocity.set(0, 0, 0);
    this._prev.copy(_desired);
  }

  // ------------------------------------------------------------------ shake

  _applyShake(cam, dt, ctx) {
    const f = this._frame;
    const tune = f.tune;
    const el = ctx.time?.elapsed ?? 0;

    this._shakeT = Math.max(0, this._shakeT - dt);
    const impact = this._shakeT > 0 ? this._shake * (this._shakeT / this._shakeDur) ** 1.6 : 0;
    if (this._shakeT === 0) this._shake = 0;

    // Road shake: the faster you go and the coarser the surface, the more the rig chatters.
    const road =
      smoothstep(24, 78, f.speed) * (0.2 + f.roughness * 1.5) * tune.shake * (1 - f.air * 0.85);
    const amp = impact * 0.55 + road * 0.085;

    // Engine vibration for the body-mounted cams — tiny, fast, load-dependent.
    let vib = 0;
    if (tune.vibration > 0) {
      const s = (this.target ?? ctx.player)?.state;
      const load = clamp01((s?.engineLoad ?? 0) * 0.7 + (s?.nosActive ? 0.4 : 0));
      vib = (0.0022 + load * 0.0075) * tune.vibration;
    }

    if (amp < 0.0004 && vib < 1e-5) return;

    const t = el * 27;
    const t2 = el * 41;
    cam.position.x += noise1D(t, 11) * amp * 0.34 + noise1D(t2, 21) * vib;
    cam.position.y += noise1D(t, 12) * amp * 0.3 + noise1D(t2 * 1.3, 22) * vib * 1.4;
    cam.position.z += noise1D(t, 13) * amp * 0.22;
    cam.rotateX(noise1D(t * 1.17, 14) * amp * 0.016 + noise1D(t2 * 1.7, 23) * vib * 0.12);
    cam.rotateY(noise1D(t * 1.31, 15) * amp * 0.016 + noise1D(t2 * 1.9, 24) * vib * 0.1);
    cam.rotateZ(noise1D(t * 0.93, 16) * amp * 0.02);
  }

  // ------------------------------------------------------------------ lifecycle

  onQuality() {}
  onResize() {}

  dispose() {
    for (const off of this._unsub) off?.();
    this._unsub.length = 0;
  }
}

// ---------------------------------------------------------------------- helpers

function makeFrameState() {
  return {
    valid: false,
    tune: TUNING.chase,
    dt: 0,
    carPos: new THREE.Vector3(),
    carFwd: new THREE.Vector3(0, 0, -1),
    carRight: new THREE.Vector3(1, 0, 0),
    carUp: new THREE.Vector3(0, 1, 0),
    carVel: new THREE.Vector3(),
    springVel: null,
    rigFwd: new THREE.Vector3(0, 0, -1),
    rigRight: new THREE.Vector3(1, 0, 0),
    rigUp: new THREE.Vector3(0, 1, 0),
    pivot: new THREE.Vector3(),
    speed: 0,
    speedKmh: 0,
    speedN: 0,
    headingYaw: 0,
    yawTarget: 0,
    aimYaw: 0,
    anticipation: 0,
    tightness: 0,
    slope: 0,
    drift: 0,
    driftSigned: 0,
    gLat: 0,
    gLong: 0,
    yawRate: 0,
    roughness: 0,
    air: 0,
    lookBack: 0,
    distance: 7,
    height: 2,
    lateral: 0,
    lookHeight: 1,
    lookAhead: 14,
    fovTarget: 58,
    rollTarget: 0,
    mountUp: 1,
    mountFwd: 1,
    orbitAngle: 0,
  };
}

/** Accepts [x,y,z], {x,y,z} or a Vector3 — the harness passes arrays. */
function toVec3(v, dx = 0, dy = 0, dz = 0) {
  if (Array.isArray(v)) return new THREE.Vector3().fromArray(v);
  if (v && typeof v === 'object' && Number.isFinite(v.x)) return new THREE.Vector3(v.x, v.y, v.z);
  return new THREE.Vector3(dx, dy, dz);
}

/** Max horizontal angle between the aim axis and the car — ~15°, i.e. the car never leaves the
 *  middle two thirds of the frame no matter how hard the anticipation is swinging. */
const FRAME_MAX_OFFSET = 0.24;

const _v1 = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _aimTarget = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Vector3();
const _q = new THREE.Quaternion();
