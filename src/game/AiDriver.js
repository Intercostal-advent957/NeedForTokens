import * as THREE from 'three';
import { clamp, clamp01, damp, DEG } from '../core/MathX.js';
import { arcAhead, arcDelta, makeProj, wobble, wrap01 } from './racemath.js';
import { RUBBER_BAND } from './DriverProfiles.js';

const G = 9.81;

/**
 * Tunables for the whole AI. Kept in one object so the behavioural harness can sweep them and so
 * a physics change only ever needs numbers touched here, never structure.
 */
export const AI_TUNING = {
  /** Decision rate. Between ticks the controls are only smoothed — this IS the reaction time. */
  THINK_HZ: 30,

  // ---- path following -------------------------------------------------------------------
  AIM_BASE: 9, // metres of look-ahead at a standstill
  AIM_PER_MS: 0.5, // + metres of look-ahead per m/s
  AIM_MIN: 12,
  AIM_MAX: 46,
  /**
   * Scaling from "geometrically required front-wheel angle" to the steer input.
   *
   * A real car needs ~1.0 here. This vehicle model does not: measured with a step-steer probe it
   * only achieves 0.2-0.35 of the Ackermann yaw rate, because the arcade rotation assist pushes
   * back against the tyres. So the nominal value is high AND `steerTrim` adapts it per driver at
   * runtime (see _adapt) — when the physics lane finishes the new tyre model the AI re-learns the
   * right authority within a couple of corners instead of needing a retune.
   */
  STEER_AUTHORITY: 3.2,
  /**
   * Extra steer per metre of cross-track error. Small on purpose: the aim point already contains
   * most of the correction, and a big value here turns the loop into an oscillator that throws
   * itself off the road at the first corner.
   */
  CROSS_GAIN: 0.28,
  /** Speed floor (m/s) used to normalise the cross-track term, so it is gentle at low speed. */
  CROSS_VREF: 14,
  /** Damping on the yaw-rate *error* (not the absolute rate — that would fight every corner). */
  YAW_DAMP: 0.10,
  /** Steering slew rate, in steer-units per second, before the reaction filter. */
  STEER_RATE: 3.0,
  /** Adaptive steer-gain limits — see _adapt(). */
  STEER_TRIM_MIN: 0.72,
  STEER_TRIM_MAX: 1.6,
  /** Steer reversals per second above which the loop is judged to be oscillating. */
  OSC_LIMIT: 1.1,
  /** Steering cap while rejoining: on a low-grip surface more lock just ploughs. */
  STEER_MAX_RECOVER: 0.72,

  // ---- slide handling -------------------------------------------------------------------
  /**
   * Slide handling works off the TYRES, not off the sideslip at the centre of gravity.
   *
   * Sideslip alone cannot tell understeer from oversteer — a car ploughing straight on and a car
   * with the back out both show a big angle, and they need opposite inputs. `state.wheels[i]
   * .slipAngle` can: compare the mean front slip angle with the mean rear one. Rear bigger means
   * the back is coming round (counter-steer, lift); front bigger means it is washing wide (ease
   * the lock, lift, let the fronts bite again).
   */
  /** Rear slip angle (rad) that counts as normal cornering rather than a slide. */
  REAR_SLIP_OK: 0.16,
  /** Rear must exceed front by this (rad) before it is called oversteer at all. */
  OVERSTEER_BAND: 0.045,
  /** Counter-steer gain applied to the rear slip angle beyond REAR_SLIP_OK. */
  COUNTER_GAIN: 1.15,
  /** Front-minus-rear slip (rad) at which the driver starts easing off for understeer. */
  UNDERSTEER_BAND: 0.14,
  /** Rear slip angle (rad) beyond which the driver abandons the apex and just catches the car. */
  SPIN_SLIP: 0.55,

  // ---- braking --------------------------------------------------------------------------
  /** Distance step of the forward speed scan, metres. */
  PLAN_STEP: 5,
  /** Longest look-ahead of the speed scan, metres. */
  PLAN_MAX: 320,
  /**
   * Fraction of the available braking capacity at which the driver comes off the throttle.
   * Below it they coast, above it they squeeze the brake in proportion. 1.0 = threshold braking.
   */
  BRAKE_ONSET: 0.55,
  /** Extra decel available from engine braking + drag, m/s^2. Deliberately conservative. */
  COAST_DECEL: 1.6,
  /** Longitudinal grip is a fraction of peak mu once you account for weight transfer & ABS. */
  BRAKE_MU_SCALE: 0.92,
  /**
   * Fraction of the friction circle the driver is willing to spend on cornering. The baked
   * racing-line speed profile is a model of a *generic* car; this is the AI working out its own
   * corner speed from the grip its tyres are actually reporting, and it takes the lower of the
   * two. That is what keeps the AI honest when the tyre model changes underneath it.
   */
  LAT_CAP: 0.95,
  /** Minimum throttle allowed when the friction circle is fully spent cornering. */
  THROTTLE_FLOOR: 0.12,
  /**
   * Learned yaw-rate ceiling, rad/s. Grip is not the only thing that limits corner speed — this
   * vehicle model also caps how fast the chassis will rotate, so a 20 m hairpin is simply not
   * takeable at the speed the grip circle says it is. The driver measures the fastest rotation it
   * has actually achieved recently and derives a third corner-speed limit, v <= yawCap / k, from
   * it. The ceiling only ever comes DOWN when the driver is at near-full lock and the car still
   * will not rotate; the rest of the time it creeps back up, so the estimate cannot spiral into
   * "I am slow, therefore I never rotate, therefore I must go slower".
   */
  YAWCAP_START: 0.8,
  YAWCAP_MIN: 0.35,
  YAWCAP_MAX: 3.0,
  /** Per-second upward creep when the driver is not at the steering limit. */
  YAWCAP_CREEP: 0.10,
  /** Steer input treated as "as much lock as is worth using". */
  STEER_SATURATED: 0.82,
  /** Hard cap on steering while racing. Beyond this the front tyres only scrub. */
  STEER_MAX: 0.95,

  // ---- traction -------------------------------------------------------------------------
  /** Driven-wheel slip ratio above which the throttle is eased. */
  WHEELSPIN_SLIP: 0.24,
  /** How hard to cut throttle per unit of excess slip ratio. */
  WHEELSPIN_CUT: 2.2,
  /** How hard to release the brake when a wheel locks (poor man's ABS; skill-scaled). */
  LOCKUP_RELEASE: 0.55,

  // ---- racecraft ------------------------------------------------------------------------
  /** Metres ahead within which another car is "traffic". */
  TRAFFIC_RANGE: 70,
  /** Lateral metres within which two cars are considered to be sharing the same piece of road. */
  TRAFFIC_WIDTH: 5.2,
  /** Minimum lateral clearance the AI wants when committing to a pass, metres. */
  PASS_CLEARANCE: 2.6,
  /** Once committed, hold the side for at least this long (seconds) so moves don't dither. */
  PASS_COMMIT: 2.6,
  /** Time-to-contact (s) below which the driver lifts, then brakes. */
  TTC_LIFT: 2.4,
  TTC_BRAKE: 1.2,
  /** Lateral push-away strength when a car is alongside, metres per second of correction. */
  AVOID_PUSH: 3.2,

  // ---- mistakes -------------------------------------------------------------------------
  /** Mean seconds between mistakes for a driver with consistency = 0. */
  MISTAKE_PERIOD: 26,
  /** Per-driver line noise amplitude in metres at consistency = 0. */
  NOISE_METRES: 1.15,

  // ---- recovery -------------------------------------------------------------------------
  /** Below this speed (m/s) for STUCK_TIME seconds the driver is considered stuck. */
  STUCK_SPEED: 2.0,
  STUCK_TIME: 2.5,
  /** Seconds of being stuck / flipped / far off track before asking for a respawn. */
  RESPAWN_TIME: 5.0,

  /** Margin kept between the car's chosen line and the edge of the track, metres. */
  EDGE_MARGIN: 2.0,
  /** Distance from the edge (m) inside which the driver actively tucks back toward the middle. */
  WALL_AWARE: 3.0,
  /** Strength of that tuck, metres of offset per metre of intrusion. */
  WALL_PUSH: 0.9,
};

const T = AI_TUNING;

/**
 * One opponent driver.
 *
 * Architecture, outermost loop first:
 *
 *   1. PERCEIVE   project onto the circuit, read the traffic snapshot, read the tyres.
 *   2. PLAN LINE  racing line + a lateral offset assembled from overtaking, defending,
 *                 collision avoidance and personality noise, clamped to the corridor.
 *   3. PLAN SPEED scan the racing-line speed profile ahead and find the *worst* required
 *                 deceleration; that is the braking point, and it is always upstream of the
 *                 corner rather than a reaction to being too fast in it.
 *   4. ACT        pure-pursuit steering + counter-steer + cross-track correction; throttle and
 *                 brake modulated by the grip actually available at the contact patches.
 *   5. RECOVER    slides, offs, wrong way, stuck — handled by overriding steps 3/4.
 *
 * Steps 1-3 run at THINK_HZ with a per-driver phase offset (reaction time); step 4 runs every
 * physics tick so the outputs stay smooth.
 */
export class AiDriver {
  /**
   * @param {object} car   CarInstance
   * @param {object} veh   the physics vehicle record (has .controls)
   * @param {object} ctx   game ctx
   * @param {object} profile DriverProfile
   * @param {number} seed
   */
  constructor(car, veh, ctx, profile, seed = 0) {
    this.car = car;
    this.veh = veh;
    this.ctx = ctx;
    this.seed = seed;
    this.profile = profile;
    this.proj = makeProj();

    // Personality -> derived coefficients, computed once.
    this.applyProfile(profile);

    this.reset();
  }

  applyProfile(p) {
    this.profile = p;
    const s = p.skill;
    /**
     * Corner-speed multiplier — the single biggest lever skill has on lap time. Applied to the
     * FINAL target (profile, grip and rotation limits alike), so a low-skill driver really does
     * run a margin inside the car's limit rather than just reading a smaller number off a table.
     * The adaptive grip trim below can only ever *subtract* from this, never add, so the skill
     * ordering of the field survives adaptation instead of being flattened by it.
     */
    this.paceScale = 0.78 + 0.24 * s;
    /** Braking-capacity multiplier: brave drivers brake later. */
    this.braveScale = 0.80 + 0.24 * p.bravery;
    /** How quickly they catch a slide. */
    this.catchGain = 0.55 + 0.75 * s;
    /** How well they modulate throttle/brake at the limit. */
    this.finesse = 0.35 + 0.65 * s;
    /**
     * Mistake rate, per second. Consistency sets the propensity; skill damps it, because a
     * quicker driver both makes fewer errors and gets away with the ones they do make.
     */
    this.mistakeRate = ((1 - p.consistency) * (1.35 - 0.7 * s)) / T.MISTAKE_PERIOD;
    /** Line noise amplitude, metres. */
    this.noiseAmp = T.NOISE_METRES * (1 - p.consistency) * 0.9;
    /** Reaction lag, seconds. */
    this.reaction = 0.09 + 0.16 * (1 - s);
    // Expose the live numbers on car.ai so the rest of the game (and the harness) can read them.
    const ai = (this.car.ai ||= {});
    Object.assign(ai, p, { driver: this });
  }

  reset() {
    this.think = 0;
    this.thinkPhase = ((this.seed * 0.618) % 1) / T.THINK_HZ;
    this.t = 0;
    this.s = 0;
    this.speed = 0;
    this.lateral = 0;
    this.hint = -1;
    this.offset = 0; // committed lateral offset from the RACING LINE, metres
    this.offsetTarget = 0;
    this.steerCmd = 0;
    this.throttleCmd = 0;
    this.brakeCmd = 0;
    this.nosCmd = 0;
    this.handbrakeCmd = 0;
    this.mode = 'race';
    this.passSide = 0;
    this.passTimer = 0;
    this.passTarget = null;
    this.mistake = null;
    this.mistakeTimer = 0;
    this.band = 0; // live rubber-band term
    this.trim = 1; // adaptive grip SAFETY trim (<= 1), see _adapt()
    this.steerTrim = 1; // adaptive steering gain, see _adapt()
    this.crossErr = 0;
    this._crossFilt = 0;
    this._oscFilt = 0;
    this._prevErr = 0;
    this.stuckTimer = 0;
    this.offTrackTimer = 0;
    this.flippedTimer = 0;
    this.wrongWayTimer = 0;
    this.wantsRespawn = false;
    this.age = 0;
    this.prevFwd = new THREE.Vector3(0, 0, -1);
    this.yawRate = 0;
    this.yawCap = T.YAWCAP_START;
    this.brakeDemand = 0;
    this.targetSpeed = 0;
    this.stats = { respawns: 0, mistakes: 0, offTrack: 0, maxOffTrack: 0, passes: 0 };
  }

  /** Called after a teleport/respawn so the reaction filters don't fight the new pose. */
  resync() {
    this.hint = -1;
    this.steerCmd = 0;
    this.brakeCmd = 0;
    this.throttleCmd = 0;
    this.stuckTimer = 0;
    this.offTrackTimer = 0;
    this.flippedTimer = 0;
    this.wrongWayTimer = 0;
    this.wantsRespawn = false;
    this.passTimer = 0;
    this.passSide = 0;
    this.mistake = null;
    this.offset = 0;
    this.offsetTarget = 0;
    const s = this.car.state;
    if (s) this.prevFwd.set(0, 0, -1).applyQuaternion(s.quaternion);
  }

  // ==================================================================== main entry

  /**
   * @param {number} dt      fixed timestep
   * @param {object} traffic { cars: Array<TrafficEntry>, self index lookup }
   * @param {number} rubberGap signed metres to the player (+ = this car is behind)
   */
  update(dt, traffic, rubberGap, rubberEnabled) {
    const s = this.car.state;
    if (!s) return;
    this.age += dt;

    // ---- 1. PERCEIVE (cheap parts every tick; the expensive plan runs at THINK_HZ) ----
    const fwd = _fwd.set(0, 0, -1).applyQuaternion(s.quaternion);
    const right = _right.set(1, 0, 0).applyQuaternion(s.quaternion);
    // Yaw rate measured from the heading itself, so it is independent of how the physics lane
    // chooses to sign angularVelocity.
    this.yawRate = _tmp.subVectors(fwd, this.prevFwd).dot(right) / Math.max(dt, 1e-4);
    this.prevFwd.copy(fwd);
    this.speed = s.speed;

    // Learned yaw ceiling. Only measured while composed and at the steering limit; otherwise it
    // creeps back up so a slow lap can never convince the driver the car cannot turn.
    const achieved = Math.abs(this.yawRate);
    const composed = this.mode === 'race' && Math.abs(this.slipRear ?? 0) < T.REAR_SLIP_OK * 1.5;
    if (composed && s.speed > 8 && Math.abs(this.steerCmd) > T.STEER_SATURATED) {
      this.yawCap = damp(this.yawCap, Math.max(achieved, T.YAWCAP_MIN), 1.0, dt);
    } else if (composed) {
      this.yawCap = Math.max(this.yawCap, achieved) + dt * T.YAWCAP_CREEP;
    }
    this.yawCap = clamp(this.yawCap, T.YAWCAP_MIN, T.YAWCAP_MAX);

    this._updateRubberBand(dt, rubberGap, rubberEnabled);

    this.think -= dt;
    if (this.think <= 0) {
      this.think += 1 / T.THINK_HZ;
      this._plan(traffic);
    }

    // ---- 4. ACT — smooth the planned controls onto the vehicle every tick ----
    const c = this.veh.controls;
    const rate = 1 / Math.max(this.reaction, 0.02);
    c.steer = damp(c.steer, this.steerCmd, rate * 1.6, dt);
    c.throttle = damp(c.throttle, this.throttleCmd, rate * 2.2, dt);
    c.brake = damp(c.brake, this.brakeCmd, rate * 3.2, dt);
    c.handbrake = this.handbrakeCmd;
    c.nos = this.nosCmd;
  }

  /** Freeze the car (countdown, finished, penalty). */
  hold(dt, brake = 1) {
    const c = this.veh.controls;
    c.throttle = 0;
    c.brake = brake;
    c.steer = damp(c.steer, 0, 8, dt);
    c.handbrake = 0;
    c.nos = 0;
    this.steerCmd = 0;
    this.throttleCmd = 0;
    this.brakeCmd = brake;
    const s = this.car.state;
    if (s) this.prevFwd.set(0, 0, -1).applyQuaternion(s.quaternion);
  }

  // ==================================================================== planning

  _plan(traffic) {
    const dt = 1 / T.THINK_HZ;
    const track = this.ctx.world.track;
    const s = this.car.state;
    const L = track.length;

    const proj = track.project(s.position, this.hint, this.proj);
    this.hint = proj.t;
    this.t = proj.t;
    this.s = proj.t * L;
    this.lateral = proj.lateral;

    const fwd = _fwd.set(0, 0, -1).applyQuaternion(s.quaternion);
    const up = _up2.set(0, 1, 0).applyQuaternion(s.quaternion);
    const tan = track.tangentAt(proj.t, _tan);
    const alongTrack = fwd.dot(tan);
    const v = Math.max(s.speed, 0);

    // Sideslip at the CoG (+ = travelling to its own right of where the nose points) plus the
    // per-axle slip angles that actually say what the car is doing.
    const slip = Math.atan2(s.localVelocity.x, Math.max(Math.abs(s.localVelocity.z), 1.5));
    this.slip = slip;
    this._readAxles(s, slip);

    this._health(dt, proj, up, alongTrack, v);
    this._adapt(dt, proj, slip, v);
    this._mistakes(dt);

    // ---- 2. PLAN LINE ----
    const halfW = track.widthAt(proj.t);
    const lineOff = track.racingLine.offsetAt(proj.t);
    let want = this._racecraft(dt, traffic, proj, L, halfW, lineOff, v);

    // personality wander — a human never holds a line to the centimetre
    want += wobble(this.age * 0.32, this.seed) * this.noiseAmp;

    // WALL AWARENESS. Avoidance and defending can both push a car out to the edge of the
    // corridor; clamping the *target* is not enough because the car overshoots it. Tuck actively
    // back toward the middle whenever we are already close to the barrier.
    const intrusion = Math.abs(proj.lateral) - (halfW - T.WALL_AWARE);
    this.wallNear = 0;
    if (intrusion > 0) {
      want -= Math.sign(proj.lateral) * intrusion * T.WALL_PUSH;
      this.wallNear = clamp01(intrusion / T.WALL_AWARE);
    }

    // clamp the *absolute* line (racing line + our offset) into the drivable corridor
    const limit = Math.max(0.4, halfW - T.EDGE_MARGIN);
    this.offsetTarget = clamp(lineOff + want, -limit, limit) - lineOff;
    // recovery mode wants the racing line, now
    if (this.mode === 'recover' || this.mode === 'spin') this.offsetTarget = 0;
    this.offset = damp(this.offset, this.offsetTarget, 3.2, dt);

    // ---- 3. PLAN SPEED ----
    const plan = this._speedPlan(proj, v, L);
    this.targetSpeed = plan.target;
    this.brakeDemand = plan.demand;

    // ---- 4. STEER ----
    this.steerCmd = this._steerFor(proj, v, fwd, slip, alongTrack, L);

    // ---- 5. PEDALS ----
    this._pedals(plan, v, slip, alongTrack, proj);
  }

  /** Mean front/rear slip angles and the signed understeer/oversteer balance. */
  _readAxles(s, slip) {
    const w = s.wheels;
    let fn = 0;
    let rn = 0;
    let f = 0;
    let r = 0;
    for (let i = 0; i < 4; i++) {
      const x = w[i];
      if (!x?.contact) continue;
      if (i < 2) {
        f += x.slipAngle;
        fn++;
      } else {
        r += x.slipAngle;
        rn++;
      }
    }
    // With a wheel in the air, fall back to the body sideslip rather than reading a stale zero.
    this.slipFront = fn ? f / fn : slip;
    this.slipRear = rn ? r / rn : slip;
    /** + = oversteering (rear working harder), - = understeering. */
    this.balance = Math.abs(this.slipRear) - Math.abs(this.slipFront);
  }

  // ------------------------------------------------------------------ line & racecraft

  /**
   * Returns the lateral offset (metres, + = right of the racing line) this driver wants, built
   * from overtaking, defending and avoidance. Committed side choices are held for PASS_COMMIT
   * seconds so a move is a move rather than a twitch.
   */
  _racecraft(dt, traffic, proj, L, halfW, lineOff, v) {
    const cars = traffic.cars;
    const me = traffic.byCar.get(this.car);
    if (!me) return 0;

    const p = this.profile;
    const limit = Math.max(0.4, halfW - T.EDGE_MARGIN);
    let offset = 0;
    let lift = 0; // 0..1 throttle scale-down requested by avoidance
    let emergency = 0; // 0..1 brake requested by avoidance

    this.passTimer = Math.max(0, this.passTimer - dt);

    // --- find the nearest relevant car ahead, and anyone alongside
    let ahead = null;
    let aheadGap = Infinity;
    let alongsideSide = 0;
    let alongsidePush = 0;

    for (const o of cars) {
      if (o.car === this.car) continue;
      const gapF = arcAhead(o.s, me.s, L); // 0..L, forward distance to them
      const dLat = o.lateral - me.lateral;
      const back = L - gapF; // how far they are behind us

      if (gapF < T.TRAFFIC_RANGE && gapF > 0.5) {
        if (Math.abs(dLat) < T.TRAFFIC_WIDTH && gapF < aheadGap) {
          aheadGap = gapF;
          ahead = o;
        }
      }
      // alongside window: overlapping in arc length, close laterally
      const overlap = Math.min(gapF, back);
      if (overlap < 5.5 && Math.abs(dLat) < 4.0) {
        const side = Math.sign(dLat) || 1;
        const squeeze = 1 - Math.abs(dLat) / 4.0;
        if (squeeze > alongsidePush) {
          alongsidePush = squeeze;
          alongsideSide = side;
        }
      }
      // someone attacking us from behind and close -> maybe defend
      if (back < 22 && back > 0.5 && Math.abs(dLat) < T.TRAFFIC_WIDTH && o.speed > me.speed + 0.5) {
        this._attacker = o;
        this._attackerAge = 0;
      }
    }

    // --- COLLISION AVOIDANCE ---------------------------------------------------------
    if (alongsidePush > 0.05) {
      // move away from them, and stop steering into them
      offset -= alongsideSide * alongsidePush * T.AVOID_PUSH * (1.25 - p.aggression * 0.5);
      // the car on the outside lifts a fraction — that is what stops two AI cars trading paint
      lift = Math.max(lift, alongsidePush * 0.28 * (1 - p.aggression * 0.6));
    }

    if (ahead) {
      // Steer AROUND anything sitting in our road, independently of the overtaking state machine.
      // Committing to a pass takes a decision; not driving into the back of a stopped car should
      // not.
      const align = 1 - Math.abs(ahead.lateral - me.lateral) / 4.0;
      if (align > 0 && aheadGap < 34) {
        // Go round the side that has room. Continuing on whichever side we happen to be is how
        // an AI swerves itself into the wall.
        const roomL = ahead.lateral + limit;
        const roomR = limit - ahead.lateral;
        const mySide = Math.sign(me.lateral - ahead.lateral) || 0;
        const roomMine = mySide > 0 ? roomR : roomL;
        const away = mySide !== 0 && roomMine > 3.2 ? mySide : roomR > roomL ? 1 : -1;
        offset += away * align * clamp01((34 - aheadGap) / 26) * 3.0;
      }

      const closing = v - ahead.speed;
      const gap = Math.max(aheadGap - 4.6, 0.2); // bumper-to-bumper distance
      const ttc = closing > 0.2 ? gap / closing : Infinity;
      if (ttc < T.TTC_LIFT) {
        const urgency = clamp01((T.TTC_LIFT - ttc) / (T.TTC_LIFT - T.TTC_BRAKE));
        lift = Math.max(lift, urgency * (0.85 - p.aggression * 0.25));
        if (ttc < T.TTC_BRAKE) emergency = Math.max(emergency, clamp01((T.TTC_BRAKE - ttc) / T.TTC_BRAKE));
      }
      // holding station: never sit inside 1.4 car lengths at matched speed
      if (gap < 6 && closing > -0.5) lift = Math.max(lift, clamp01((6 - gap) / 6) * 0.6);
    }

    // --- OVERTAKING ------------------------------------------------------------------
    if (ahead && this.mode === 'race') {
      const closing = v - ahead.speed;
      const wantMove =
        aheadGap < 12 + p.aggression * 26 &&
        (closing > 0.6 - p.aggression * 0.5 || aheadGap < 9) &&
        v > 8;
      if (wantMove) {
        if (this.passTimer <= 0 || this.passTarget !== ahead.car) {
          // Choose a side: prefer the one with more room to the edge, biased to the inside of
          // the *next* corner because that is where a pass actually sticks.
          const cornerK = track_curvatureAhead(this.ctx.world.track, proj.t, v);
          const insideSide = cornerK > 0.0016 ? -1 : cornerK < -0.0016 ? 1 : 0;
          const roomL = ahead.lateral - -limit; // room to the left of them
          const roomR = limit - ahead.lateral;
          let side = roomR > roomL ? 1 : -1;
          if (insideSide !== 0 && (insideSide === 1 ? roomR : roomL) > T.PASS_CLEARANCE + 1.2) {
            side = insideSide;
          }
          const room = side > 0 ? roomR : roomL;
          if (room > T.PASS_CLEARANCE) {
            if (this.passSide !== side || this.passTarget !== ahead.car) this.stats.passes++;
            this.passSide = side;
            this.passTarget = ahead.car;
            this.passTimer = T.PASS_COMMIT * (0.6 + p.patience * 0.8);
          }
        }
      }
      if (this.passSide !== 0 && this.passTimer > 0 && this.passTarget === ahead.car) {
        // Commit: aim for a line displaced from THEIR position, not from the racing line, so the
        // move actually clears the car we are passing.
        const wantAbs = ahead.lateral + this.passSide * (T.PASS_CLEARANCE + 0.6);
        const ramp = clamp01((T.TRAFFIC_RANGE - aheadGap) / 30);
        offset += (clamp(wantAbs, -limit, limit) - (lineOff + offset)) * ramp;
        lift *= 0.35; // committed — stop backing off
      }
    } else if (!ahead) {
      this.passSide = 0;
      this.passTarget = null;
    }

    // --- DEFENDING -------------------------------------------------------------------
    this._attackerAge = (this._attackerAge ?? 99) + dt;
    if (this._attacker && this._attackerAge < 0.5 && p.defend > 0.25) {
      const a = this._attacker;
      const theirSide = Math.sign(a.lateral - this.lateral) || 1;
      // Move ONCE to cover the side they are coming down. Not a weave — that reads as cheating.
      offset += theirSide * p.defend * 1.9 * clamp01(1 - Math.abs(a.lateral - this.lateral) / 6);
    }

    this._lift = clamp01(lift);
    this._emergency = clamp01(emergency);
    return offset;
  }

  // ------------------------------------------------------------------ speed plan

  /**
   * BRAKING POINTS.
   *
   * For every point d metres ahead on the racing line with target speed vt, the constant
   * deceleration needed to arrive there at vt is
   *
   *     aReq = (v^2 - vt^2) / (2 d)
   *
   * The braking point is simply where max(aReq) over the look-ahead crosses the deceleration the
   * tyres can actually deliver. That capacity is the friction ellipse evaluated with the lateral
   * acceleration already being used:
   *
   *     aBrake = sqrt( (mu g)^2 - (v^2 k)^2 ) * BRAKE_MU_SCALE   + engine braking + drag
   *
   * mu comes from the tyres on the ground right now (def.tyreGrip x mean wheel grip), so wet
   * tarmac, kerbs and grass all move the braking point on their own. `bravery` scales the
   * capacity the driver is willing to bet on, which is exactly what braking late means.
   */
  _speedPlan(proj, v, L) {
    const track = this.ctx.world.track;
    const mu = this._mu();
    const muG = mu * G;
    this._muG = muG;

    const kNow = Math.abs(track.racingLine.curvatureAt(proj.t));
    const aLatNow = Math.min(v * v * kNow, muG * 0.98);
    const aBrake =
      Math.sqrt(Math.max(muG * muG - aLatNow * aLatNow, muG * muG * 0.04)) * T.BRAKE_MU_SCALE +
      T.COAST_DECEL;
    const budget = Math.max(1.5, aBrake * this.braveScale * (this.mistake === 'late' ? 1.22 : 1));

    const targetNow = this._targetSpeedAt(proj.t);
    let demand = 0;
    let critical = targetNow;

    const horizon = clamp(30 + (v * v) / (2 * Math.max(budget, 2)), 40, T.PLAN_MAX);
    for (let d = T.PLAN_STEP; d <= horizon; d += T.PLAN_STEP) {
      const t = wrap01(proj.t + d / L);
      const vt = this._targetSpeedAt(t);
      if (vt >= v) continue;
      const aReq = (v * v - vt * vt) / (2 * d);
      const need = aReq / budget;
      if (need > demand) {
        demand = need;
        critical = vt;
      }
      // Once we are already far past full braking there is nothing further out to learn.
      if (demand > 1.6) break;
    }

    // How much of the friction circle cornering is already using, right now.
    this.latUse = clamp01(aLatNow / muG);
    return { target: targetNow, demand, critical, budget, mu, latUse: this.latUse };
  }

  /**
   * Grip-feasible target speed at `t` for THIS car and THIS driver, including rubber banding.
   *
   * Two independent estimates, lower wins:
   *   1. the circuit's baked profile, scaled for this car's tyres and this driver's pace;
   *   2. v = sqrt(mu g / k) from the grip the contact patches are reporting right now;
   *   3. v = yawCap / k from how fast this chassis has actually been able to rotate.
   */
  _targetSpeedAt(t) {
    const track = this.ctx.world.track;
    const base = track.racingLine.speedAt(t) * this.gripScale;
    const k = Math.abs(track.racingLine.curvatureAt(t));
    const own = k > 1e-5 ? Math.sqrt((this._muG * T.LAT_CAP) / k) : 1e4;
    const turnable = k > 1e-5 ? this.yawCap / k : 1e4; // chassis rotation limit
    return Math.min(base, own, turnable) * this.paceScale * this.trim * (1 + this.band);
  }

  /** Effective tyre mu right now, from the contact patches. */
  _mu() {
    const s = this.car.state;
    let g = 0;
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const w = s.wheels[i];
      if (w?.contact) {
        g += w.grip;
        n++;
      }
    }
    const mean = n ? g / n : 1;
    return this.car.def.tyreGrip * mean;
  }

  /**
   * The baked speed profile assumes a generic mu of 1.42 (see Track._buildSpeedProfile), so a
   * car with more or less grip than that must scale corner speeds by sqrt(mu ratio).
   */
  get gripScale() {
    return this._gripScale ?? (this._gripScale = Math.sqrt(this.car.def.tyreGrip / 1.42));
  }

  // ------------------------------------------------------------------ steering

  _steerFor(proj, v, fwd, slip, alongTrack, L) {
    const track = this.ctx.world.track;
    const s = this.car.state;
    const def = this.car.def;
    const lock = def.steerLockDeg * DEG;

    // Aim point: racing line + our committed offset, one look-ahead distance up the road.
    // Rejoining, the driver looks much closer in — a long preview from out in the run-off aims
    // parallel to the track and takes a couple of hundred metres to come back.
    const preview = this.mode === 'recover' ? 0.5 : 1;
    const Ld = clamp(T.AIM_BASE + v * T.AIM_PER_MS, T.AIM_MIN, T.AIM_MAX) * preview;
    const tAim = wrap01(proj.t + Ld / L);
    const aim = track.racingLine.pointAt(tAim, _aim);
    aim.addScaledVector(track.flatRightAt(tAim, _rt), this.offset);

    const toAim = _to.subVectors(aim, s.position);
    toAim.y = 0;
    const dist = toAim.length() || 1;
    toAim.multiplyScalar(1 / dist);
    const right = _right.set(1, 0, 0).applyQuaternion(s.quaternion);

    const lat = toAim.dot(right);
    const ahead = toAim.dot(fwd);
    // Angle to the aim point, + = to our right.
    let alpha = Math.atan2(lat, ahead);
    if (ahead < 0) alpha = Math.sign(lat || 1) * (Math.PI - Math.abs(alpha)) * 0.6; // turn around

    // Pure pursuit: the curvature of the arc through the aim point, and the Ackermann angle
    // that would produce it.
    const kappa = (2 * Math.sin(alpha)) / Math.max(dist, 2); // 1/m, + = turning right
    let delta = Math.atan(def.wheelbase * kappa);

    // Cross-track correction on the *line* itself. Pure pursuit alone drifts parallel to the
    // line when the vehicle response is not what the geometry assumes; this closes that loop and
    // makes the AI robust to the tyre model changing under it.
    const wantLat = track.racingLine.offsetAt(proj.t) + this.offset;
    const crossErr = wantLat - proj.lateral; // + = we need to move right
    this.crossErr = crossErr;
    delta += Math.atan2(T.CROSS_GAIN * crossErr, Math.max(v, T.CROSS_VREF));

    // Counter-steer, from the REAR tyres. Kept OUT of the authority scaling below — authority
    // compensates the path-following plant gain, whereas catching a slide is a direct angle and
    // needs no amplification.
    const rear = this.slipRear ?? 0;
    const oversteering = (this.balance ?? 0) > T.OVERSTEER_BAND;
    const excess = oversteering ? Math.max(0, Math.abs(rear) - T.REAR_SLIP_OK) : 0;
    const counter = excess > 0 ? Math.sign(rear) * excess * T.COUNTER_GAIN * this.catchGain : 0;
    // Understeer: more lock does nothing but scrub the fronts, so unwind a little instead.
    const under = Math.max(0, -(this.balance ?? 0) - T.UNDERSTEER_BAND);
    if (under > 0) delta *= clamp01(1 - under * 2.2);

    // Damp the yaw-rate ERROR. Damping the absolute rate would bleed steering out of every
    // steady-state corner; this only resists rotating faster or slower than the arc asks for.
    delta -= (this.yawRate - v * kappa) * T.YAW_DAMP * clamp01(v / 25);

    if (this.mode === 'spin') {
      // Fully committed catch: point the wheels where the car is actually going.
      const catchAngle = clamp(slip * 1.15 + (this.slipRear ?? 0) * 0.5, -lock, lock);
      return clamp(
        clamp((catchAngle / lock) * this.catchGain, -1, 1),
        this.steerCmd - 0.35,
        this.steerCmd + 0.35
      );
    }
    if (this.mode === 'recover' && alongTrack < 0.1) {
      // Genuinely pointing the wrong way: turn toward the road and stop trying to find the apex.
      delta = Math.sign(-proj.lateral || 1) * lock * 0.9;
    }

    // Path-following demand gets the (adaptive) authority; the slide catch does not. The total
    // is capped below full lock: past that the front tyres spend their grip budget on scrubbing
    // and the car turns *less*, so a real driver never gets there mid-corner either.
    const cap = this.mode === 'recover' ? T.STEER_MAX_RECOVER : T.STEER_MAX;
    let steer = clamp((delta / lock) * T.STEER_AUTHORITY * this.steerTrim + counter / lock, -cap, cap);
    if (this.mistake === 'snap') steer = clamp(steer + this._mistakeSign * 0.16, -1, 1);
    // slew limit — hands, not servos
    const maxStep = T.STEER_RATE / T.THINK_HZ;
    steer = clamp(steer, this.steerCmd - maxStep, this.steerCmd + maxStep);
    return steer;
  }

  // ------------------------------------------------------------------ pedals

  _pedals(plan, v, slip, alongTrack, proj) {
    const s = this.car.state;
    const p = this.profile;
    let throttle = 0;
    let brake = 0;

    if (this.mode === 'spin') {
      // Off the power, gentle brake, let the tyres find grip again.
      throttle = 0;
      brake = 0.28 * this.finesse;
    } else if (this.mode === 'recover') {
      // Off the island: rejoin at a speed the surface under the tyres can actually hold, and
      // never blast back across the racing line.
      // Rejoin slowly enough that the front tyres can still steer — ploughing back on at speed
      // is how an AI ends up beached in the run-off for ten seconds.
      const rejoin = Math.min(plan.target * 0.45, 6 + plan.mu * 8);
      throttle = alongTrack > 0.3 ? clamp01((rejoin - v) * 0.5) : 0.2;
      brake = v > rejoin * 1.25 ? clamp01((v - rejoin) * 0.08) : 0;
    } else {
      // ---- braking-point controller ----
      const d = plan.demand;
      if (d > T.BRAKE_ONSET) {
        brake = clamp01((d - T.BRAKE_ONSET) / (1.0 - T.BRAKE_ONSET));
        // low-skill drivers are clumsy: they arrive at full pedal too fast
        brake = clamp01(brake * (0.85 + 0.35 * (1 - this.finesse)));
      }
      // ---- throttle ----
      const err = plan.target - v;
      throttle = clamp01(err * 0.55);
      // Ease out of the throttle as the braking demand rises — this is the "lift" before the
      // brake, and it is what makes the AI look like it is anticipating rather than reacting.
      throttle *= clamp01((T.BRAKE_ONSET + 0.06 - plan.demand) / 0.35);
      if (brake > 0.02) throttle = 0;
      // FRICTION CIRCLE. Power taken while the tyres are already at the lateral limit comes
      // straight out of the cornering budget, which is exactly how an AI ends up ploughing off
      // the outside of a fast sweeper at full throttle. Cap the pedal by what is left.
      // A rear-drive car puts its power down through one axle carrying roughly half the weight,
      // so it runs out of combined grip long before an all-wheel-drive car does. Same circle,
      // steeper penalty.
      const left = Math.sqrt(Math.max(0, 1 - plan.latUse * plan.latUse));
      const share = this.car.def.drivetrain === 'awd' ? 1 : 1.6;
      throttle = Math.min(throttle, T.THROTTLE_FLOOR + Math.pow(left, share) * 1.15);
    }

    // ---- traction: back off when the driven wheels are actually slipping ----
    const drive = this.car.def.drivetrain;
    const idx = drive === 'fwd' ? [0, 1] : drive === 'rwd' ? [2, 3] : [0, 1, 2, 3];
    let spin = 0;
    let locked = 0;
    for (const i of idx) {
      const w = s.wheels[i];
      if (!w) continue;
      if (w.contact) spin = Math.max(spin, Math.abs(w.slipRatio) - T.WHEELSPIN_SLIP);
    }
    for (let i = 0; i < 4; i++) if (s.wheels[i]?.lockedUp) locked++;
    if (spin > 0) throttle *= clamp01(1 - spin * T.WHEELSPIN_CUT * this.finesse);

    // ---- sliding: the back stepping out cannot take more throttle ----
    const rearExcess = Math.max(0, Math.abs(this.slipRear ?? 0) - T.REAR_SLIP_OK);
    if (rearExcess > 0) throttle *= clamp01(1 - rearExcess * 5.5 * this.finesse);
    // ---- understeer: lift so the fronts get their grip back (and, if it is bad, trail brake) ----
    const underExcess = Math.max(0, -(this.balance ?? 0) - T.UNDERSTEER_BAND);
    if (underExcess > 0 && this.mode === 'race') {
      throttle *= clamp01(1 - underExcess * 3.0 * this.finesse);
      brake = Math.max(brake, clamp01((underExcess - 0.08) * 1.6) * 0.35 * this.finesse);
    }

    // ---- ABS by hand: release when the fronts lock. Low skill = keeps standing on it. ----
    if (locked > 0 && brake > 0.2) {
      brake *= 1 - T.LOCKUP_RELEASE * this.finesse * (locked / 4);
    }

    // ---- avoidance overrides ----
    throttle *= 1 - (this._lift ?? 0);
    // A light lift near the wall. Braking here was tried and made things worse: it upsets the car
    // exactly where it has least room to recover.
    if (this.wallNear > 0.2) throttle *= clamp01(1 - (this.wallNear - 0.2) * 0.5);
    if (this._emergency > 0) brake = Math.max(brake, this._emergency * 0.85);

    // ---- mistakes ----
    if (this.mistake === 'lock') {
      brake = 1;
      throttle = 0;
    } else if (this.mistake === 'lift') {
      throttle *= 0.15;
    }

    // ---- NOS: straights, at speed, and only when it will not upset the car ----
    const track = this.ctx.world.track;
    const straight = Math.abs(track.racingLine.curvatureAt(proj.t)) < 0.0022;
    const wantNos =
      this.mode === 'race' &&
      straight &&
      v > 28 &&
      brake < 0.05 &&
      throttle > 0.85 &&
      s.nosAmount > (this.band > 0.005 ? 0.12 : 0.35 - p.aggression * 0.2);
    this.nosCmd = wantNos ? 1 : 0;

    // ---- handbrake: only to rotate a genuinely tight hairpin, and only if skilled ----
    const kAhead = Math.abs(track_curvatureAhead(track, proj.t, v));
    this.handbrakeCmd =
      this.mode === 'race' && kAhead > 0.038 && v > 9 && v < 22 && p.skill > 0.82 && brake > 0.4
        ? 0.55
        : 0;

    this.throttleCmd = clamp01(throttle);
    this.brakeCmd = clamp01(brake);
  }

  // ------------------------------------------------------------------ adaptation

  /**
   * ADAPTIVE GRIP TRIM.
   *
   * The baked speed profile is a model; the tyre model is being rewritten under us. So the driver
   * measures the outcome: if the car is sliding or running wide of the line, the trim comes down
   * and the corner speeds with it; if it is planted and on the line, the trim creeps back up.
   * Range is deliberately narrow (+/-15%) so this cannot mask a real problem.
   */
  _adapt(dt, proj, slip, v) {
    if (v < 8) return;
    const wantLat = this.ctx.world.track.racingLine.offsetAt(proj.t) + this.offset;
    const err = proj.lateral - wantLat;
    const wide = Math.abs(err);
    const sliding = Math.abs(this.slipRear ?? slip) > T.REAR_SLIP_OK * 1.4 || Math.abs(slip) > 0.28;
    // "Running wide" has to be measured against the road you are on: 2.6 m is a big error on a
    // narrow section and nothing at all on a four-lane straight.
    const halfW = proj.width || 8;
    const veryWide = wide > Math.max(2.2, halfW * 0.32) && this.mode === 'race';
    // NOTE the ceiling of 1.0: the trim is a SAFETY trim. It may take pace away from a driver who
    // is over-driving the car, but it must never hand pace back above what their skill bought —
    // otherwise a cautious driver's trim creeps up, a fast driver's trim gets pulled down, and
    // the two meet in the middle with the whole grid at identical pace.
    // The floor is deliberately shallow (14%): the trim exists to stop a driver over-driving the
    // car, not to become the dominant term. Skill sets pace; this only shaves it.
    if (sliding || veryWide) this.trim = Math.max(0.86, this.trim - dt * 0.35);
    else if (wide < 1.6 && Math.abs(slip) < 0.14) this.trim = Math.min(1.0, this.trim + dt * 0.07);

    // --- adaptive STEER gain -------------------------------------------------------------
    // Measure the plant: persistent cross-track error while the wheel is NOT already at the stop
    // means the loop is too soft; reversing the wheel over and over means it is too stiff.
    //
    // Two guards stop this becoming the oscillator it is meant to prevent. It only learns while
    // the car is racing on the road — the error off in the run-off says nothing about steering
    // gain — and it only learns *upward* when there is unused lock left, because past the stop
    // more gain buys nothing and the loop would wind itself to the limit and stay there.
    const onRoad = Math.abs(proj.lateral) < (proj.width || 8) + 1.5;
    const reversal =
      Math.sign(this.steerCmd) !== Math.sign(this._prevSteer ?? 0) && Math.abs(this.steerCmd) > 0.25;
    this._prevSteer = this.steerCmd;
    this._oscFilt = (this._oscFilt ?? 0) + ((reversal ? 1 / dt : 0) - (this._oscFilt ?? 0)) * Math.min(1, dt * 2.2);
    if (this.mode !== 'race' || !onRoad) return;

    this._crossFilt = (this._crossFilt ?? 0) + (wide - (this._crossFilt ?? 0)) * Math.min(1, dt * 2.5);
    this._prevErr = err;
    const roomToTurn = Math.abs(this.steerCmd) < T.STEER_MAX * 0.7;
    if (this._oscFilt > T.OSC_LIMIT || Math.abs(this.slipRear ?? 0) > 0.3) {
      this.steerTrim = Math.max(T.STEER_TRIM_MIN, this.steerTrim - dt * 0.45);
    } else if (this._crossFilt > 1.4 && roomToTurn) {
      this.steerTrim = Math.min(T.STEER_TRIM_MAX, this.steerTrim + dt * 0.3);
    } else if (this._crossFilt < 0.6) {
      this.steerTrim += (1 - this.steerTrim) * dt * 0.25; // relax back toward geometric truth
    }
  }

  _updateRubberBand(dt, gap, enabled) {
    let want = 0;
    if (enabled && Number.isFinite(gap)) {
      const mag = clamp01((Math.abs(gap) - RUBBER_BAND.DEAD_GAP) / (RUBBER_BAND.FULL_GAP - RUBBER_BAND.DEAD_GAP));
      const bias = gap > 0 ? RUBBER_BAND.CATCH_UP : -RUBBER_BAND.HOLD_BACK;
      want = mag * RUBBER_BAND.MAX_GAIN * bias;
    }
    const step = RUBBER_BAND.RATE * dt;
    this.band = clamp(
      this.band + clamp(want - this.band, -step, step),
      -RUBBER_BAND.MAX_GAIN,
      RUBBER_BAND.MAX_GAIN
    );
  }

  // ------------------------------------------------------------------ health / recovery

  _health(dt, proj, up, alongTrack, v) {
    const halfW = proj.width || this.ctx.world.track.widthAt(proj.t);
    const off = Math.abs(proj.lateral) - halfW;
    const flipped = up.y < 0.25;

    if (off > 0.6) {
      this.offTrackTimer += dt;
      this.stats.offTrack += dt;
      this.stats.maxOffTrack = Math.max(this.stats.maxOffTrack, this.offTrackTimer);
    } else this.offTrackTimer = Math.max(0, this.offTrackTimer - dt * 2);

    if (Math.abs(v) < T.STUCK_SPEED) this.stuckTimer += dt;
    else this.stuckTimer = 0;

    if (flipped) this.flippedTimer += dt;
    else this.flippedTimer = 0;

    if (alongTrack < -0.2 && v > 3) this.wrongWayTimer += dt;
    else this.wrongWayTimer = Math.max(0, this.wrongWayTimer - dt * 1.5);

    const rear = Math.abs(this.slipRear ?? 0);
    if ((rear > T.SPIN_SLIP || Math.abs(this.slip ?? 0) > 0.85) && v > 6) this.mode = 'spin';
    else if (off > 1.8 || this.wrongWayTimer > 0.7) this.mode = 'recover';
    else this.mode = 'race';

    // Give up and ask for a respawn only when genuinely beached — never as a shortcut.
    this.wantsRespawn =
      this.flippedTimer > 2.5 ||
      this.stuckTimer > T.STUCK_TIME + 2.0 ||
      (off > 8 && this.offTrackTimer > 3.5) ||
      this.offTrackTimer > T.RESPAWN_TIME ||
      this.wrongWayTimer > 5;
  }

  /** Poisson-ish mistakes. Frequency and severity both come from `consistency` and `skill`. */
  _mistakes(dt) {
    if (this.mistakeTimer > 0) {
      this.mistakeTimer -= dt;
      if (this.mistakeTimer <= 0) this.mistake = null;
      return;
    }
    if (this.mode !== 'race') return;
    if (Math.random() > this.mistakeRate * dt) return;
    const roll = Math.random();
    this._mistakeSign = Math.random() < 0.5 ? -1 : 1;
    if (roll < 0.34) {
      this.mistake = 'lock'; // stood on the brakes, flat-spotted it
      this.mistakeTimer = 0.35 + Math.random() * 0.45;
    } else if (roll < 0.68) {
      this.mistake = 'late'; // braked too late for this corner
      this.mistakeTimer = 1.4 + Math.random() * 1.2;
    } else if (roll < 0.88) {
      this.mistake = 'snap'; // a twitch of the wheel
      this.mistakeTimer = 0.22 + Math.random() * 0.3;
    } else {
      this.mistake = 'lift'; // spooked, off the power mid-corner
      this.mistakeTimer = 0.4 + Math.random() * 0.6;
    }
    this.stats.mistakes++;
  }
}

/** Peak |curvature| of the racing line over the next braking-relevant stretch. */
function track_curvatureAhead(track, t, v) {
  const L = track.length;
  const span = clamp(12 + v * 1.1, 18, 90);
  let best = 0;
  for (let d = 4; d <= span; d += 6) {
    const k = track.racingLine.curvatureAt(wrap01(t + d / L));
    if (Math.abs(k) > Math.abs(best)) best = k;
  }
  // sign of the turn from the centreline curvature (+ = left per CONTRACTS §7)
  const sgn = Math.sign(track.curvatureAt(wrap01(t + span * 0.5 / L)) || 1);
  return Math.abs(best) * sgn;
}

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up2 = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _rt = new THREE.Vector3();
const _to = new THREE.Vector3();
const _tmp = new THREE.Vector3();
