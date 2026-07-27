/**
 * Driver aids — Need for Tokens, physics lane.
 *
 * Design rule: **an assist may only ever remove authority from the car, never add authority the
 * player did not ask for.** ABS releases brake pressure, TC releases throttle, the stability
 * helper trims steering *toward the direction the car is already travelling*. None of them
 * generate a yaw moment out of nothing, which is what the old arcade yaw torque did and why it
 * fought the player: it forced the nose to a geometric heading regardless of what was under the
 * tyres. Every gain below fades to zero as the player's own input grows, so a deliberate
 * provocation (big steering, handbrake, or throttle in a slide) is never resisted.
 *
 * Everything here is per-vehicle mutable state carried in `a` and tuned by the constants at the
 * top. Player and AI both run them; AI simply never provokes.
 */

import { clamp, clamp01, damp, lerp } from '../core/MathX.js';

export function makeAssistState() {
  return {
    abs: [0, 0, 0, 0], // per-wheel brake modulation 0..1
    absActive: false,
    tc: 1, // throttle multiplier
    tcCut: 0,
    counter: 0, // counter-steer trim, radians of extra steer
    stability: 0, // 0..1 how hard the stability helper is working (for debug/hud)
    driftIntent: 0, // 0..1 — how much the player is asking for a slide
    driftHold: 0,
    yawFilter: 0,
    // ---- ESP (see stabilityControl) ----
    espMoment: 0, // Nm about the car's up axis, smoothed
    espBrake: 0, // 0..1 of def.brakeTorque asked of the outer front wheel
    espSide: 0, // -1 brake the LEFT front, +1 brake the RIGHT front, 0 none
    espCut: 0, // 0..1 of engine torque withheld
    espAmount: 0, // 0..1 how hard the ESP is working
    yawRef: 0, // rad/s the steering angle is actually asking for
    betaPrev: 0, // last tick's body slip angle, for the rate estimate
    betaDot: 0, // rad/s, filtered
  };
}

export const ASSIST = {
  absSlipTarget: 0.13, // slip ratio ABS tries to hold under braking
  absRelease: 9.0, // how fast pressure is dumped
  absApply: 4.5, // how fast it is restored
  absMinSpeed: 2.2,

  tcSlipTarget: 0.17,
  tcRelease: 7.0,
  tcApply: 2.2,
  tcFloor: 0.24, // never cut more than this much of the throttle
  tcMinSpeed: 0.8,

  counterMax: 0.85, // fraction of the steering lock the helper may add
  // Body slip past which anti-spin ALWAYS works. Deliberately the same 46 deg as `ESP.betaFree`
  // so the two halves of the spin arrest agree on where a drift stops being a drift: below it
  // the player owns the wheel completely, above it the assist starts winding on opposite lock.
  spinCap: 0.80,
  spinGain: 2.2, // rad of opposite lock per rad of slip past `spinCap` (the ESP does the rest)
  // Anti-spin gets its OWN, larger authority — more than one lock — because a player trying to
  // spin the car holds full lock INTO the slide, and 0.85 of a lock cannot even cancel that.
  // Past 40 degrees of slip you are not steering any more, so the assist is allowed the wheel.
  spinAuthority: 1.9,
  counterGain: 1.05,
  counterFadeSpeed: 6, // m/s below which the helper does nothing
  yawDampGain: 0.55,
  gripSteerLimit: 1.15, // cap front slip angle at this multiple of the tyre's peak
};

/**
 * ============================ SPIN ARREST (ESP) TUNING ============================
 * The one job of this block is: **a player may slide, a player may not spin.**
 *
 * An arcade drift lives between about 20 and 45 degrees of body slip. Everything below
 * `betaFree` is therefore completely untouched — no moment, no brake, no torque cut — so
 * provoking and holding a slide feels exactly as it did before this existed. Past `betaFree`
 * the correction ramps in over `betaSpan` with a smoothstep, so the car *gathers itself up*
 * rather than snapping straight, and by `betaFree + betaSpan` it has full authority. That upper
 * figure is the practical ceiling on sustainable slip angle.
 *
 * Raise `betaFree` for a driftier car, lower it for a safer one. Set `authority` to 0 to
 * disable the whole system (the car will then spin — that is what it did before).
 * =================================================================================
 */
export const ESP = {
  // --- where the assist starts caring ---
  betaFree: 0.80, // rad, 46 deg — top of the "this is a drift, leave it alone" band
  betaSpan: 0.36, // rad, 21 deg — ramp width; full authority at 67 deg of body slip
  // A player actively provoking (handbrake, throttle-on-lock) is allowed this much extra angle
  // before the assist wakes up, so a deliberate entry is never clipped at its peak.
  driftBonus: 0.16, // rad, 9 deg at full drift intent
  // Look-ahead on the slip angle: the controller acts on where the car WILL be this many
  // seconds from now if nothing changes. A held drift has a slip rate of ~0 so this adds
  // nothing to it; a car swinging through 30 deg at 90 deg/s is on its way to 55 and gets
  // caught now instead of after it has already gone past. Without it the correction always
  // arrives about 30 degrees too late, which is the difference between a 67 deg peak and a
  // 100 deg one.
  preview: 0.26, // seconds
  minSpeed: 4, // m/s of PLANAR speed below which none of this runs

  // --- reference yaw rate (steady-state bicycle model) ---
  // Characteristic speed of the understeer gradient: r = v*tan(d) / (L * (1 + (v/vCh)^2)).
  // Lower = the reference expects less rotation at speed, so the ESP intervenes sooner.
  charSpeed: 32, // m/s
  yawDeadband: 0.25, // rad/s of yaw error tolerated before any moment is made at all
  yawGain: 3.4, // 1/s — corrective yaw acceleration per rad/s of error (x yaw inertia)

  // --- how much authority it may ever have ---
  // The virtual yaw moment is capped at this fraction of the moment the tyres could physically
  // produce (mu * m * g * wheelbase/2), so the assist can never out-muscle the car itself.
  momentCap: 0.45,
  // Direct slip-angle recovery: yaw acceleration, rad/s^2, pulling the nose back toward the
  // direction of travel at full authority. This is the term that ENDS a spin rather than merely
  // stopping it getting worse.
  slipGain: 2.2,
  // Brake vectoring: fraction of def.brakeTorque put through the OUTER FRONT wheel at full
  // authority. Real ESP does the whole job this way; here it carries the honest half of it.
  brakeAuthority: 0.55,
  // Engine torque withheld at full authority. Feeding 640 hp into a car that is already
  // 70 degrees sideways is what turns a slide into a spin.
  torqueCut: 0.55,
  authority: 1, // master scale, 0..1. 0 disables the ESP entirely.
};

/**
 * ABS. Per wheel, holds slip ratio near `absSlipTarget` under braking.
 * Returns the brake pressure multiplier for that wheel.
 */
export function absModulate(a, i, slipRatio, brakeCmd, speed, lockedThreshold, dt) {
  if (brakeCmd <= 0.01 || Math.abs(speed) < ASSIST.absMinSpeed) {
    a.abs[i] = damp(a.abs[i], 1, 12, dt);
    return a.abs[i];
  }
  // slipRatio is negative under braking; how far past the target are we?
  const over = -slipRatio - lockedThreshold;
  const rate = over > 0 ? -ASSIST.absRelease * clamp01(over / 0.25) : ASSIST.absApply * 0.5;
  a.abs[i] = clamp(a.abs[i] + rate * dt, 0.08, 1);
  return a.abs[i];
}

/**
 * Traction control. One global throttle multiplier (a real TC cuts spark, not one wheel), driven
 * by the worst driven-wheel slip. Faded out completely when the player is asking for a drift.
 */
export function tractionControl(a, worstSlip, speed, driftIntent, dt) {
  const target = ASSIST.tcSlipTarget + driftIntent * 0.85;
  const over = worstSlip - target;
  if (Math.abs(speed) < ASSIST.tcMinSpeed && worstSlip < target * 2) {
    a.tc = damp(a.tc, 1, 6, dt);
    a.tcCut = 0;
    return a.tc;
  }
  // Release scales with HOW FAR past the target we are, not just whether we are past it: a 0.2
  // overshoot is a gentle trim, a 2.0 overshoot is a wheel that has already let go.
  const rate = over > 0 ? -ASSIST.tcRelease * clamp01(over / 0.4) * (1 + Math.min(over, 3) * 1.6) : ASSIST.tcApply;
  const floor = lerp(ASSIST.tcFloor, 1, clamp01(driftIntent * 1.6));
  a.tc = clamp(a.tc + rate * dt, floor, 1);
  a.tcCut = 1 - a.tc;
  return a.tc;
}

/**
 * Steering assist / counter-steer helper.
 *
 * ------------------------------- SIGN CONVENTION, VERIFIED -------------------------------
 * Forward is -Z, right is +X, so a POSITIVE rotation about +Y turns the car LEFT.
 *   * `steerAngle > 0` points the front wheels RIGHT and commands a NEGATIVE yaw rate.
 *   * `beta > 0` means the velocity lies to the RIGHT of the nose, which is what a LEFT-hand
 *     slide looks like from inside the car.
 *   * Opposite lock therefore has the **same sign as beta**: in a left-hand drift (beta > 0)
 *     the driver steers RIGHT (steerAngle > 0), pointing the wheels along the direction of
 *     travel. Measured, not assumed — `atan2` of the body-frame velocity in a provoked slide.
 *
 * This was inverted for a while, and an assist that steers *into* the slide does not merely
 * fail to help: it actively cancels the player's own opposite lock (a commanded -27 deg came
 * out as +2 deg at the tyre) and the car spins every time. If you change a sign here, re-run
 * `node src/physics/telemetry.mjs --only drift,spin` before you believe yourself.
 * -----------------------------------------------------------------------------------------
 *
 * Three terms, none of which ever add rotation the driver did not ask for:
 *
 *  1. **Slip-angle limiter.** Beyond the front tyre's peak slip angle, extra lock produces less
 *     grip, not more — a real driver feels this through the wheel and stops adding lock. We do
 *     it for the player, but only above `counterFadeSpeed` and only up to the point where the
 *     front tyre is at its peak. It never reduces steering below what the tyre can use.
 *
 *  2. **Counter-steer.** In a slide the helper pulls the wheels toward `frontKin` — the
 *     direction the front axle is genuinely travelling — which is exactly what a driver does.
 *     Gain scales with how far past the stable slip angle the car is, and is cut by the
 *     player's own aligned input so a player already catching the slide is not double-counted.
 *
 *  3. **Anti-spin.** Never fades with driver input. A player may provoke and hold a big slide;
 *     they may not spin.
 *
 * Every gate uses PLANAR speed, never the forward component. At 90 degrees of body slip the
 * forward component passes through zero while the car is still doing 100 km/h, so a
 * forward-speed gate switches every assist off at precisely the moment they are needed — which
 * is how a 45 degree slide used to become a 180 degree spin.
 *
 * Returns the final steer angle in radians.
 */
export function steerAssist(a, o, dt) {
  const {
    steerInput, // -1..1 player
    steerLock, // rad
    speed, // SIGNED forward m/s (body -Z component)
    speedPlanar, // horizontal speed magnitude, m/s — what every gate below uses
    lateralV, // body lateral m/s (+ = sliding right)
    betaTrue, // true signed heading-vs-velocity angle, rad (-pi..pi]
    yawRate, // rad/s
    wheelbase,
    peakSlip, // front tyre peak slip angle, rad
    driftIntent, // 0..1
    handbrake,
    grounded, // 0..1
  } = o;

  const vP = Math.abs(speedPlanar ?? speed);
  const fade = clamp01((vP - ASSIST.counterFadeSpeed) / 8) * grounded;
  let steer = steerInput * steerLock;
  if (fade <= 0.001) {
    a.counter = damp(a.counter, 0, 10, dt);
    a.stability = 0;
    return steer;
  }

  a.yawFilter = damp(a.yawFilter, yawRate, 40, dt);
  const bT = betaTrue === undefined ? Math.atan2(lateralV, Math.max(vP, 1)) : betaTrue;

  // ---- 1. slip-angle limiter on the front axle
  // Front tyre slip = steer - (lateral velocity at the front axle) / speed.
  // The front axle sits at body z = -wheelbase/2, and (w x r).x = -w_y * r_z, hence MINUS.
  // The denominator is the SIGNED forward speed floored at 1 m/s, so once the car is travelling
  // backwards `frontKin` saturates toward +-90 deg — full opposite lock — instead of folding
  // back on itself the way a magnitude-floored denominator does.
  const vFrontLat = lateralV - a.yawFilter * (wheelbase * 0.5);
  const frontKin = Math.atan2(vFrontLat, Math.max(speed, 1));
  const limit = peakSlip * ASSIST.gripSteerLimit;
  const maxUseful = frontKin + Math.sign(steer || 1) * limit;
  const minUseful = frontKin - Math.sign(steer || 1) * limit;
  // Only clamp when the player's lock is *beyond useful*, and only by the excess.
  let limited = steer;
  if (Math.sign(steer) > 0 && steer > maxUseful && maxUseful > 0) limited = maxUseful;
  else if (Math.sign(steer) < 0 && steer < minUseful && minUseful < 0) limited = minUseful;
  // Blend the limiter in with speed, and fade it out when the player is provoking.
  const limitStrength = fade * (1 - clamp01(driftIntent * 1.25)) * (1 - handbrake * 0.9);
  steer = lerp(steer, limited, clamp01(limitStrength) * 0.85);

  // ---- 2. counter-steer helper
  // Steer TOWARD `frontKin`: point the front wheels where the front axle is actually going.
  // That is the definition of catching a slide, and it carries the correct sign for free.
  const stableBeta = peakSlip * 0.9;
  const excess = clamp01((Math.abs(bT) - stableBeta) / 0.34);
  // A player already steering the right way needs no help; one steering the wrong way gets more.
  const playerAligned = clamp01(
    Math.sign(bT || 1) * Math.sign(steerInput || 0) * Math.abs(steerInput)
  );
  const need =
    (frontKin - steer) *
    ASSIST.counterGain *
    excess *
    (1 - playerAligned * 0.75) *
    (1 - clamp01(driftIntent * 0.8));

  // Yaw-rate damping, so a snap-oversteer is caught as it develops. Only the OVER-rotation is
  // damped — how much faster the car is yawing than the steering angle asked for — so the term
  // is identically zero in understeer and can never sharpen the driver's own turn-in.
  // Ackermann yaw rate for steer angle d is -v*tan(d)/L (negative = right turn, see above).
  const yawAck = -(Math.tan(steer) * speed) / Math.max(wheelbase, 1);
  const over = Math.max(0, Math.abs(a.yawFilter) - Math.abs(yawAck)) * Math.sign(a.yawFilter || 1);
  // Steering with the sign of the yaw rate commands the opposite rotation, so this opposes it.
  const damping = over * ASSIST.yawDampGain * 0.06 * clamp01(vP / 22);

  // ---- 3. anti-spin. Unlike everything above this NEVER fades with driver input: a player is
  // allowed to provoke and hold a big slide, but they are not allowed to spin. Past `spinCap`
  // the helper winds on opposite lock in proportion to the excess, which is exactly what a
  // driver does and is invisible until you are already sideways enough to be in trouble.
  // Uses the TRUE slip angle: the floored one saturates at ~85 deg, so anti-spin built on it
  // stops responding exactly when the car needs it most.
  const spinExcess = Math.max(0, Math.abs(bT) - ASSIST.spinCap) * Math.sign(bT || 1);
  const antiSpin = clamp(
    spinExcess * ASSIST.spinGain * clamp01(vP / 9),
    -steerLock * ASSIST.spinAuthority,
    steerLock * ASSIST.spinAuthority
  );

  const target =
    clamp(
      (need + damping) * fade,
      -steerLock * ASSIST.counterMax,
      steerLock * ASSIST.counterMax
    ) + antiSpin;
  a.counter = damp(a.counter, target, 14, dt);
  a.stability = clamp01(Math.abs(a.counter) / (steerLock * ASSIST.counterMax + 1e-6));

  return clamp(steer + a.counter, -steerLock * 1.45, steerLock * 1.45);
}

/**
 * ESP — yaw-moment stability control, i.e. the spin arrest.
 *
 * Compares the yaw rate the car actually has against the **reference yaw rate implied by the
 * steering angle and the speed** (steady-state bicycle model, limited by what friction can
 * deliver), and makes a corrective moment out of the difference. Three actuators, in the order
 * a real system would use them:
 *
 *   1. **Brake vectoring** — brake the OUTER FRONT wheel. Braking force acts backwards at body
 *      x, giving a yaw moment of -x*F, so the wheel on the outside of the rotation opposes it.
 *      This is grip the car already has, so it is the honest half of the intervention.
 *   2. **Engine torque cut** — stop feeding the slide.
 *   3. **A virtual yaw moment** — the backstop, capped at `momentCap` of the moment the tyres
 *      could physically produce, and only ever in the direction that REMOVES rotation.
 *
 * Authority is a smoothstep of how far the (predicted) body slip angle is past `betaFree`, so:
 *   - below 46 deg (55 with full drift intent) it is *exactly zero* and a drift is untouched;
 *   - it ramps in over the next 21 deg rather than snapping;
 *   - 67 deg is the practical ceiling, and measured peaks land within a degree or two of it.
 *
 * Writes its result into `a` and returns the authority 0..1.
 */
export function stabilityControl(a, o, dt) {
  const {
    yawRate, // rad/s about the car's up axis, + = rotating LEFT
    steerAngle, // rad, final front-wheel angle, + = right
    speedPlanar, // horizontal speed magnitude, m/s
    betaTrue, // signed heading-vs-velocity angle, rad
    wheelbase,
    mass,
    mu, // peak friction actually available (def.tyreGrip * surface grip)
    inertiaY, // yaw inertia, kg m^2
    grounded, // 0..1 fraction of wheels on the ground
    driftIntent, // 0..1
  } = o;

  const vP = Math.abs(speedPlanar);

  // Rate of change of the body slip angle, unwrapped across the +-pi seam and lightly filtered.
  let d = betaTrue - a.betaPrev;
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  a.betaPrev = betaTrue;
  // `betaTrue` is defined as 0 below walking pace, so crossing that threshold looks like a
  // 60 rad/s slip rate. Hold the estimate at zero until the car is genuinely moving.
  a.betaDot = vP < 2 ? 0 : damp(a.betaDot, dt > 1e-6 ? d / dt : 0, 26, dt);
  // Only OUTWARD growth counts: a car already gathering itself up needs no anticipation.
  const growth = Math.max(0, a.betaDot * Math.sign(betaTrue || 1));
  const betaMag = Math.abs(betaTrue) + growth * ESP.preview;

  // How far past a *drift* are we? 0 inside the drift band, 1 at the ceiling. `driftBonus`
  // widens the free band for a player who is deliberately provoking, so a committed entry is
  // never clipped at its peak — but it can never switch the system off.
  const free = ESP.betaFree + ESP.driftBonus * clamp01(driftIntent);
  const x = clamp01((betaMag - free) / Math.max(ESP.betaSpan, 1e-3));
  const ramp = x * x * (3 - 2 * x); // smoothstep: ramps in, never snaps
  const authority =
    ramp * clamp01((vP - ESP.minSpeed) / 6) * clamp01(grounded) * clamp01(ESP.authority);

  // Reference yaw rate. +steerAngle steers RIGHT and a right turn is a NEGATIVE rotation about
  // +Y, hence the leading minus. The understeer term keeps the reference realistic at speed,
  // and the friction limit keeps it inside what the tyres could ever deliver (|v * r| <= mu g).
  const und = 1 + (vP * vP) / (ESP.charSpeed * ESP.charSpeed);
  let yawRef = -(vP * Math.tan(clamp(steerAngle, -0.9, 0.9))) / (Math.max(wheelbase, 1) * und);
  const yawLimit = (mu * 9.81) / Math.max(vP, 4);
  a.yawRef = yawRef = clamp(yawRef, -yawLimit, yawLimit);

  if (authority <= 1e-4) {
    a.espMoment = damp(a.espMoment, 0, 9, dt);
    a.espBrake = damp(a.espBrake, 0, 9, dt);
    a.espCut = damp(a.espCut, 0, 9, dt);
    a.espSide = 0;
    a.espAmount = 0;
    return 0;
  }

  // Yaw error, with a deadband so ordinary hard cornering never trips it.
  const raw = yawRate - yawRef;
  const err =
    raw > ESP.yawDeadband ? raw - ESP.yawDeadband : raw < -ESP.yawDeadband ? raw + ESP.yawDeadband : 0;

  // 1. yaw-error moment. Positive moment = yaw LEFT.
  let moment = -err * ESP.yawGain * inertiaY * authority;
  // Never ADD rotation: the correction may only ever subtract from what the car already has.
  // (Real ESP does help a car rotate in understeer; that is a handling aid, not a spin arrest,
  // and it has no business firing at 60 degrees of slip.)
  if (moment * yawRate > 0) moment = 0;

  // 2. slip-angle ceiling. The term above stops the rotation growing; this one actively brings
  // the nose back toward the direction of travel, which is what ends a spin. Reducing a
  // POSITIVE beta (velocity to the right of the nose) means yawing RIGHT = a negative moment.
  moment += -Math.sign(betaTrue || 1) * ESP.slipGain * inertiaY * authority;

  // 3. cap against the moment the tyres could physically make, so the assist can never
  // out-muscle the car itself.
  const cap = ESP.momentCap * mu * mass * 9.81 * Math.max(wheelbase * 0.5, 0.5);
  moment = clamp(moment, -cap, cap);

  // Brake vectoring. M = -x*F, so a positive moment needs the LEFT (x < 0) wheel.
  const side = moment > 0 ? -1 : 1;
  const brake = clamp01((Math.abs(err) / 1.1 + 0.35) * authority) * ESP.brakeAuthority;

  a.espMoment = damp(a.espMoment, moment, 16, dt);
  a.espBrake = damp(a.espBrake, brake, 16, dt);
  a.espSide = side;
  a.espCut = damp(a.espCut, ESP.torqueCut * authority, 12, dt);
  a.espAmount = authority;
  return authority;
}

/**
 * How much the player is asking to be sideways, 0..1. Drives every assist fade above, and the
 * drift scoring window. Handbrake is an instant yes; big steering plus big throttle is a slow
 * yes; lifting off cancels it over a few tenths so recovery is smooth rather than abrupt.
 */
export function driftIntent(a, ctrl, speedPlanar, beta, dt) {
  // PLANAR speed, not the forward component: at 90 deg of slip the forward component is ~0
  // while the car is still doing 100 km/h, and gating on it made intent collapse to zero for
  // reasons that had nothing to do with what the player was asking for.
  const v = Math.abs(speedPlanar);
  const provoke =
    clamp01(ctrl.handbrake * 1.4) * 0.9 +
    clamp01(Math.abs(ctrl.steer) - 0.45) * clamp01(ctrl.throttle - 0.5) * 1.8 +
    clamp01(Math.abs(beta) / 0.5) * clamp01(ctrl.throttle - 0.3) * 1.2;
  // Past ~55 deg of body slip the player is no longer asking for a drift, they are spinning.
  // Letting intent stay high there keeps traction control switched off and the counter-steer
  // helper faded out, which is precisely the wrong combination — so intent decays away, TC
  // returns, the rear tyres get their lateral grip back, and the slide is arrested. The player
  // never sees an intervention; the car simply refuses to spin.
  const runaway = 1 - clamp01((Math.abs(beta) - 0.95) / 0.45);
  const want = clamp01(provoke) * clamp01((v - 6) / 10) * runaway;
  // Hold briefly after the provocation ends so the car does not snap straight the instant the
  // handbrake is released — that is the difference between a drift and a twitch.
  a.driftHold = want > a.driftHold ? want : damp(a.driftHold, want, 2.6, dt);
  a.driftIntent = clamp01(a.driftHold);
  return a.driftIntent;
}
