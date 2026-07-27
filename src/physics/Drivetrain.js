/**
 * Engine, clutch, gearbox and differential — Need for Tokens, physics lane.
 *
 * Torque flows: torqueCurve -> clutch -> gearbox -> final drive -> centre diff (AWD only)
 * -> axle diffs -> wheels. Wheel speeds are NOT averaged: each wheel keeps its own spin and
 * the differential distributes torque between them, so a lifted inside wheel really does spin
 * up and a limited-slip really does drag the car straight on corner exit.
 *
 * Engine inertia is *reflected* onto the driven wheels (I_eng * ratio^2). That is both
 * physically right and what makes the wheel-spin integration unconditionally stable in first
 * gear at 120 Hz — without it the reflected inertia mismatch is ~20:1 and the wheels ring.
 */

import { clamp, clamp01, curveAt } from '../core/MathX.js';

const RPM_TO_RAD = (2 * Math.PI) / 60;
const RAD_TO_RPM = 60 / (2 * Math.PI);

/** Build the immutable drivetrain description for a car def. */
export function makeDrivetrain(def) {
  const ratios = def.gearRatios?.length ? def.gearRatios.slice() : [1];
  // Peak crank torque chosen so max POWER over the curve equals def.power.
  let bestP = 0;
  for (const [rpm, frac] of def.torqueCurve) bestP = Math.max(bestP, rpm * frac);
  const peakTorque = bestP > 0 ? (def.power * 745.7) / (bestP * RPM_TO_RAD) : 400;

  const awd = def.drivetrain === 'awd';
  const fwd = def.drivetrain === 'fwd';
  return {
    ratios,
    final: def.finalDrive,
    peakTorque,
    redline: def.redline,
    idle: Math.max(def.idleRpm, 0),
    electric: def.idleRpm <= 1 && ratios.length === 1,
    // engine + flywheel + clutch pack, kg m^2
    inertia: def.idleRpm <= 1 ? 0.09 : clamp(def.mass / 9000, 0.13, 0.3),
    efficiency: 0.9,
    // axle torque split, front fraction
    frontSplit: awd ? 0.4 : fwd ? 1 : 0,
    // limited-slip: preload (Nm) and torque-sensitive locking fraction
    lsd: {
      preload: def.class === 'S' ? 160 : 110,
      lockAccel: 0.55,
      lockCoast: 0.28,
      viscous: 26, // Nm per rad/s of cross-axle speed difference
    },
    centre: { viscous: awd ? 90 : 0, maxLock: awd ? 900 : 0 },
    // engine braking coefficient (Nm per rad/s of crank speed) on a closed throttle
    engineBrake: def.idleRpm <= 1 ? 0.06 : 0.055,
    shiftTime: 0.16,
    upShiftAt: 0.965,
    downShiftAt: 0.46,
  };
}

/** Gear ratio including final drive. gear: -1 reverse, 0 neutral, 1..n */
export function totalRatio(dt, gear) {
  if (gear === 0) return 0;
  if (gear < 0) return -Math.abs(dt.ratios[0]) * dt.final * 0.82;
  return dt.ratios[clamp(gear - 1, 0, dt.ratios.length - 1)] * dt.final;
}

/** Which wheel indices this drivetrain drives. FL,FR,RL,RR */
export function drivenWheels(def) {
  return def.drivetrain === 'fwd' ? [0, 1] : def.drivetrain === 'rwd' ? [2, 3] : [0, 1, 2, 3];
}

/**
 * Crank torque at a given rpm and throttle, including idle governor, rev limiter bounce and
 * engine braking on overrun.
 * @returns {number} Nm at the crank
 */
export function engineTorque(dt, def, rpm, throttle, st) {
  const redline = dt.redline;
  // --- rev limiter: cut, then hold the cut until the revs have dropped, so it BOUNCES
  if (rpm >= redline) st.limiter = 0.09;
  if (st.limiter > 0) {
    st.limiterActive = true;
    if (rpm < redline - 380) st.limiter = 0;
  } else st.limiterActive = false;
  const cut = st.limiterActive ? 0 : 1;

  const frac = curveAt(def.torqueCurve, clamp(rpm, def.torqueCurve[0][0], redline));
  let t = frac * dt.peakTorque * clamp01(throttle) * cut;

  if (!dt.electric) {
    // idle governor — enough torque to hold idle, fading out above it
    if (rpm < dt.idle + 220) {
      const need = clamp01((dt.idle + 120 - rpm) / 400);
      t = Math.max(t, need * dt.peakTorque * 0.14);
    }
    // pumping / friction losses on a closed throttle
    const overrun = 1 - clamp01(throttle * 2.2);
    t -= overrun * (dt.engineBrake * rpm * RPM_TO_RAD + dt.peakTorque * 0.02);
  } else {
    // an EV regenerates instead of pumping
    const overrun = 1 - clamp01(throttle * 2.2);
    t -= overrun * dt.engineBrake * rpm * RPM_TO_RAD;
  }
  return t;
}

/**
 * Automatic gearbox with kickdown, rev-matched downshifts and a shift-cut window.
 * Mutates `s.gear` / `g` and returns true when a shift was started.
 */
export function updateGearbox(dt, def, s, g, ctrl, wheelSpin, dtime, emit) {
  g.shiftTimer = Math.max(0, g.shiftTimer - dtime);
  g.postShift = Math.max(0, g.postShift - dtime);
  const n = dt.ratios.length;
  if (dt.electric || n <= 1) {
    // single-speed: only reverse selection
    s.gear = g.wantReverse ? -1 : 1;
    return false;
  }
  if (g.shiftTimer > 0) return false;

  // Reverse / forward selection at a standstill.
  //
  // Two guards, both learned the hard way:
  //  - the brake must be HELD, or every hard stop drops the car into reverse and the next
  //    throttle input goes backwards;
  //  - the car must have DRIVEN at some point since the last reverse selection. RaceSystem
  //    holds brake = 1 for the whole countdown, so without this the car sits on the grid in
  //    reverse and every race start is a wasted 0.2 s shifting out of it.
  const v = s.speed;
  if (Math.abs(v) > 2) g.hasMoved = true;
  if (Math.abs(v) < 0.5 && ctrl.brake > 0.5 && ctrl.throttle < 0.05 && g.hasMoved) g.stopHold += dtime;
  else g.stopHold = 0;
  if (g.stopHold > 0.45 && v > -12) {
    g.hasMoved = false;
    if (s.gear !== -1) {
      s.gear = -1;
      g.shiftTimer = 0.24;
      return true;
    }
  } else if (s.gear === -1 && (ctrl.throttle > 0.15 || v > 0.4)) {
    s.gear = 1;
    g.shiftTimer = 0.2;
    return true;
  }
  if (s.gear <= 0) return false;

  const rpm = s.rpm;
  const load = clamp01(ctrl.throttle);
  // Shift up later the harder you are on the throttle; cruise short-shifts for smoothness.
  const upAt = dt.redline * (dt.upShiftAt - (1 - load) * 0.2);
  const dnAt = dt.redline * (dt.downShiftAt + load * 0.16);

  if (s.gear < n && rpm > upAt && v > 1.5 && g.postShift === 0) {
    s.gear++;
    g.shiftTimer = dt.shiftTime;
    g.postShift = 0.5;
    g.blip = 0;
    emit?.(s.gear, true);
    return true;
  }
  if (s.gear > 1 && rpm < dnAt && g.postShift === 0) {
    // Rev-match: work out the revs the lower gear will need and blip to them.
    const rNext = totalRatio(dt, s.gear - 1);
    const target = Math.abs(wheelSpin) * rNext * RAD_TO_RPM;
    g.blip = clamp01((target - rpm) / Math.max(dt.redline * 0.35, 1));
    s.gear--;
    g.shiftTimer = dt.shiftTime * 0.85;
    g.postShift = 0.42;
    emit?.(s.gear, false);
    return true;
  }
  return false;
}

/**
 * Clutch engagement 0..1 — 1 means locked (engine and gearbox turn as one rigid shaft).
 * Open during a shift, slipping below `lockSpeed`, locked otherwise.
 */
export function clutchEngagement(dt, s, g, ctrl) {
  if (g.shiftTimer > 0) {
    // fully open at the start of the shift, back in by the end
    const k = g.shiftTimer / Math.max(dt.shiftTime, 1e-3);
    return clamp01(1 - k * 1.25);
  }
  if (dt.electric) return 1;
  const lockSpeed = 3.2;
  const v = Math.abs(s.speed);
  if (v < lockSpeed) return clamp01((v / lockSpeed) ** 0.7);
  return 1;
}

/**
 * Torque a SLIPPING clutch can pass, in Nm at the crank.
 *
 * The capacity rises with engine speed, which is the whole trick behind a good standing start:
 * at idle the clutch barely bites, so the engine is free to rev; as the revs climb the clutch
 * grabs harder, and the engine settles at whatever speed makes transmitted torque equal engine
 * torque — a launch-rpm plateau, exactly like slipping a real clutch or a launch-control map.
 * Get this wrong (a fixed speed-matching coupling) and the engine is dragged to idle off the
 * line and the car crawls away from a standstill.
 */
export function clutchCapacity(dt, rpm, throttle, engagement) {
  const span = Math.max(dt.redline * 0.5 - dt.idle, 1);
  const rev = clamp01((rpm - dt.idle * 1.04) / span);
  const bite = 0.1 + 1.3 * rev * rev;
  const creep = throttle > 0.02 ? 1 : 0.35;
  return dt.peakTorque * bite * creep * (0.35 + 0.65 * engagement);
}

/**
 * Distribute `axleTorque` between two wheels through a differential.
 * Writes into `out[0]`, `out[1]`.
 *
 * open  : equal torque, speeds free
 * lsd   : equal torque plus a locking torque that drags the fast wheel toward the slow one,
 *         scaled by drive torque (ramp angle) and by cross-axle speed difference (viscous)
 */
export function splitAxle(cfg, axleTorque, wA, wB, open, out) {
  const half = axleTorque * 0.5;
  if (open) {
    out[0] = half;
    out[1] = half;
    return;
  }
  const dw = wA - wB;
  const ramp = axleTorque >= 0 ? cfg.lockAccel : cfg.lockCoast;
  const maxLock = cfg.preload + Math.abs(axleTorque) * ramp;
  let lock = clamp(dw * cfg.viscous, -maxLock, maxLock);
  // a locked diff cannot create energy: never push the slow wheel past the fast one
  out[0] = half - lock;
  out[1] = half + lock;
}

export { RPM_TO_RAD, RAD_TO_RPM };
