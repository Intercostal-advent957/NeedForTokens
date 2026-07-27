/**
 * The integrator — Need for Tokens, physics lane.
 *
 * One call = one 120 Hz tick for one car. Order matters and is deliberate:
 *
 *   1. basis + kinematics        (where are we, how fast, which way is up)
 *   2. driver aids read LAST tick's slip and decide this tick's authority
 *   3. suspension  -> vertical load per wheel  (weight transfer lives here, not in a fudge)
 *   4. tyres       -> longitudinal + lateral force from that load
 *   5. drivetrain  -> wheel spin, which feeds next tick's slip ratio
 *   6. aero, then integrate about the centre of mass
 *   7. bookkeeping: g-force, drift, events, NaN guards
 *
 * Weight transfer is NOT applied as a formula. The suspension springs carry it: tyre forces act
 * at the contact patch, the contact patch is ~0.45 m below the centre of mass, so braking pitches
 * the body forward, which compresses the front springs, which raises the front vertical load,
 * which — through the tyre model's load sensitivity — changes the grip. That whole chain is what
 * makes the car feel like a car, and it is why the body visibly dives, squats and rolls.
 */

import * as THREE from 'three';
import { clamp, clamp01, damp, lerp } from '../core/MathX.js';
import { G, syncCom, syncOrigin } from './Vehicle.js';
import { TYRE, surfaceFeel, tyreForce, relax, rollingResistance } from './Tyre.js';
import {
  totalRatio,
  drivenWheels,
  engineTorque,
  updateGearbox,
  clutchEngagement,
  clutchCapacity,
  splitAxle,
  RPM_TO_RAD,
  RAD_TO_RPM,
} from './Drivetrain.js';
import { absModulate, tractionControl, steerAssist, driftIntent, stabilityControl } from './Assists.js';

const RHO = 1.225;
const MAX_ANG = 7.0; // rad/s — nothing on four wheels rotates faster than this

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _iq = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _lvl = new THREE.Quaternion();
const _force = new THREE.Vector3();
const _torque = new THREE.Vector3();
const _hard = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _vAt = new THREE.Vector3();
const _wF = new THREE.Vector3();
const _wR = new THREE.Vector3();
const _n = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _spec = new THREE.Vector3();
const _tf = { fx: 0, fy: 0, combined: 0, saturation: 0, mu: 1 };
const _pen = [0, 0, 0, 0];
const _axle = [0, 0];

export function stepVehicle(sys, v, dt) {
  const s = v.state;
  const def = v.def;
  const world = sys.ctx.world;
  const c = v.controls;
  const A = v.assist;
  const D = v.dt;

  // ---------------------------------------------------------------- 1. basis
  const q = s.quaternion;
  _iq.copy(q).invert();
  const fwd = _fwd.set(0, 0, -1).applyQuaternion(q);
  const right = _right.set(1, 0, 0).applyQuaternion(q);
  const up = _up.set(0, 1, 0).applyQuaternion(q);

  s.localVelocity.copy(s.velocity).applyQuaternion(_iq);
  const vFwd = -s.localVelocity.z;
  const vLat = s.localVelocity.x;
  s.speed = vFwd;
  s.speedKmh = vFwd * 3.6;
  const absV = Math.abs(vFwd);
  const yawRate = s.angularVelocity.dot(up);

  // Two slip angles, on purpose:
  //  `beta`     — floored denominator, tame near a standstill, used by the CONTROLLERS.
  //  `betaTrue` — the real signed angle between heading and velocity, in (-pi, pi]. The floored
  //               one saturates near 85 deg, so on its own it cannot tell a big drift from a
  //               full spin — which is exactly the distinction the anti-spin logic needs.
  const beta = Math.atan2(vLat, Math.max(absV, 1));
  // PLANAR speed — the magnitude of the horizontal velocity, which is what the car is actually
  // doing. Every stability gate uses this and never `absV`: at 90 deg of body slip the forward
  // component passes through zero while the car is still travelling at 100 km/h, so gating on
  // it disables ABS-of-the-yaw-axis at exactly the moment a spin needs arresting.
  const planarV = Math.hypot(s.velocity.x, s.velocity.z);
  const betaTrue = planarV > 1 ? Math.atan2(s.localVelocity.x, -s.localVelocity.z) : 0;
  s.slipAngle = beta;

  // ---------------------------------------------------------------- 2. driver aids
  const intent = driftIntent(A, c, planarV, betaTrue, dt);
  s.driftIntent = intent;

  const grounded = clamp01(s.wheelsOnGround / 4);
  const steerAngle = steerAssist(
    A,
    {
      steerInput: clamp(c.steer, -1, 1),
      steerLock: v.steerLock,
      speed: vFwd,
      speedPlanar: planarV,
      lateralV: vLat,
      betaTrue,
      yawRate,
      wheelbase: def.wheelbase,
      peakSlip: v.peakSlip,
      driftIntent: intent,
      handbrake: clamp01(c.handbrake),
      grounded,
    },
    dt
  );
  s.steerAngle = steerAngle;
  s.assist = A.stability;

  // ---------------------------------------------------------------- 2b. spin arrest (ESP)
  // Runs here, before the throttle and brake are resolved, because it trims both. Its inputs
  // are pure kinematics plus the steer angle just computed, so nothing downstream is needed.
  // See stabilityControl() in Assists.js for what it does and the ESP block for the tuning.
  let muNow = 0;
  for (let i = 0; i < 4; i++) muNow += s.wheels[i].grip;
  muNow = def.tyreGrip * (muNow * 0.25 || 1);
  const espAmount = stabilityControl(
    A,
    {
      yawRate,
      steerAngle,
      speedPlanar: planarV,
      betaTrue,
      wheelbase: def.wheelbase,
      mass: def.mass,
      mu: muNow,
      inertiaY: v.inertia.y,
      grounded,
      driftIntent: intent,
    },
    dt
  );
  s.espAmount = espAmount;
  s.espActive = espAmount > 0.02;

  // ---------------------------------------------------------------- NOS
  if (c.nos > 0.5 && s.nosAmount > 0.01 && absV > 1) {
    if (!s.nosActive) sys.ctx.bus.emit('car:nos', { car: v.car, active: true });
    s.nosActive = true;
    s.nosAmount = clamp01(s.nosAmount - (def.nos.drain / 100) * dt);
  } else {
    if (s.nosActive) {
      sys.ctx.bus.emit('car:nos', { car: v.car, active: false });
      v.backfire = 0.9;
    }
    s.nosActive = false;
    s.nosAmount = clamp01(s.nosAmount + (def.nos.refill / 100) * dt * 0.25);
  }

  // ---------------------------------------------------------------- 3. suspension
  _force.set(0, 0, 0);
  _torque.set(0, 0, 0);
  _force.y -= def.mass * G;

  const restLen = v.restLen;
  const kSpring = def.suspension.stiffness;
  const cBump = def.suspension.damping;
  const cReb = def.suspension.damping * 1.55;
  let contacts = 0;

  for (let i = 0; i < 4; i++) {
    const w = s.wheels[i];
    const isFront = i < 2;
    w.steerAngle = isFront ? steerAngle : 0;

    _hard.copy(v.hard[i]).applyQuaternion(q).add(v.com);
    const g = world.sampleGround(_hard.x, _hard.z, v.groundHint);
    if (i === 0) v.groundHint = g.t ?? v.groundHint;
    _n.copy(g.normal);
    if (!(_n.lengthSq() > 0.25)) _n.set(0, 1, 0);

    // Distance along the car's own down axis from the hardpoint to where the tyre would touch
    // the local ground plane. See the RIDE HEIGHT CONTRACT in Vehicle.js.
    const nDotUp = Math.max(0.18, _n.dot(up));
    const h0 = (_hard.y - g.height) * _n.y;
    const len = (h0 - def.wheelRadius) / nDotUp;
    let pen = restLen - len;
    _pen[i] = pen;

    if (pen > -0.001 && pen < restLen + def.wheelRadius) {
      contacts++;
      w.contact = true;
      w.surface = g.surface;
      w.grip = g.grip;
      w.pen = clamp(pen, 0, restLen * 1.22);
      w.compression = clamp01(w.pen / restLen);
      // >>> RIDE HEIGHT CONTRACT (Vehicle.js): hub deviation from its STATIC rest height <<<
      w.suspensionOffset = clamp(w.pen - v.pen0, -v.pen0, restLen - v.pen0);
      w.contactNormal.copy(_n);
      w.contactPoint.copy(up).multiplyScalar(-(restLen - w.pen + def.wheelRadius)).add(_hard);
      w.contactPoint.addScaledVector(_n, -def.wheelRadius * 0.0);
    } else {
      w.contact = false;
      w.pen = 0;
      w.compression = 0;
      w.suspensionOffset = -v.pen0; // full droop
      w.contactNormal.set(0, 1, 0);
      w.load = 0;
      w.suspensionForce = 0;
      w.forceLong = 0;
      w.forceLat = 0;
      w.slipSpeed = 0;
      w.saturation = 0;
      w.lockedUp = false;
    }
  }

  // Anti-roll bars: axle-wise, resisting the DIFFERENCE IN SUSPENSION DEFLECTION.
  //
  // The bar must see clamped travel, not the raw ray distance. A wheel in the air reports a
  // penetration of -0.4 m or worse, and feeding that straight into a 22 kN/m bar injects a
  // 13 kN phantom force into an axle that is not even touching the road — which pumps energy
  // into the suspension until the whole car launches itself off a flat straight.
  const arb = def.suspension.antiRoll || 0;
  const dF = clamp(_pen[0], 0, restLen) - clamp(_pen[1], 0, restLen);
  const dR = clamp(_pen[2], 0, restLen) - clamp(_pen[3], 0, restLen);
  const arbCap = def.mass * G * 0.85;
  const arbF = clamp(arb * dF, -arbCap, arbCap);
  const arbR = clamp(arb * 0.86 * dR, -arbCap, arbCap);
  const arbAdd = [arbF, -arbF, arbR, -arbR];

  s.wheelsOnGround = contacts;

  for (let i = 0; i < 4; i++) {
    const w = s.wheels[i];
    if (!w.contact) continue;
    _hard.copy(v.hard[i]).applyQuaternion(q).add(v.com);
    _arm.copy(w.contactPoint).sub(v.com);
    _vAt.copy(s.angularVelocity).cross(_arm).add(s.velocity);
    const vN = _vAt.dot(w.contactNormal);

    let fN = kSpring * w.pen + arbAdd[i];
    // Progressive bump stop over the last 18% of travel — this is what absorbs a landing
    // instead of letting the chassis punch through the road, and what makes a big kerb feel
    // like a kerb. It also gets extra DAMPING, because a pure spring bump stop is a trampoline
    // and would launch the car straight back into the air.
    const over = w.pen - restLen * 0.82;
    if (over > 0) {
      const u = over / (restLen * 0.18);
      fN += kSpring * 26 * over * u;
      if (vN < 0) fN -= cBump * 2.6 * clamp01(u) * vN;
    }
    fN -= (vN < 0 ? cBump : cReb) * vN;
    fN = clamp(fN, 0, def.mass * G * 12);

    w.suspensionForce = fN;
    w.load = fN;
    _force.addScaledVector(w.contactNormal, fN);
    _torque.add(_tmp.copy(_arm).cross(_tmp2.copy(w.contactNormal).multiplyScalar(fN)));
  }

  // ---------------------------------------------------------------- 4/5. tyres + drivetrain
  const driven = drivenWheels(def);
  const isDriven = [false, false, false, false];
  for (const i of driven) isDriven[i] = true;

  // ---- engine speed. Slaved to the driven wheels through the gearbox when the clutch is in.
  const ratio = totalRatio(D, s.gear);
  let drivenAvg = 0;
  if (driven.length) {
    for (const i of driven) drivenAvg += s.wheels[i].spin;
    drivenAvg /= driven.length;
  }
  const clutch = clutchEngagement(D, s, v.gear, c);
  s.clutch = clutch;

  const throttleIn = clamp01(c.throttle);
  // Traction control looks at a LOAD-WEIGHTED slip across the driven wheels, not the worst one.
  // A lightly loaded inside wheel lighting up mid-corner is the differential's problem, not a
  // reason to cut power to the whole car — cutting on it costs half a second to 100 km/h.
  let slipNum = 0;
  let slipDen = 0;
  for (const i of driven) {
    const wgt = Math.max(200, s.wheels[i].load);
    slipNum += s.wheels[i].slipRatio * wgt;
    slipDen += wgt;
  }
  const worstSlip = slipDen > 0 ? slipNum / slipDen : 0;
  const tc = tractionControl(A, worstSlip, planarV, intent, dt);
  s.tcActive = tc < 0.985;
  // ESP torque cut. Feeding 640 hp into a car that is already past the drift band is what turns
  // a slide into a spin, so power is withheld in proportion to the ESP's authority — zero
  // inside the drift band, so throttle-on drifting is untouched.
  const espTorque = 1 - clamp01(A.espCut);
  const throttle = clamp01(Math.max(throttleIn * tc * espTorque, v.gear.blip));
  v.gear.blip = Math.max(0, v.gear.blip - dt * 3.2);

  const omegaSlaved = Math.abs(drivenAvg * ratio);
  const idleOmega = Math.max(D.idle, 0) * RPM_TO_RAD;
  let crankT = engineTorque(D, def, s.rpm, throttle, v.gear);
  if (s.nosActive) crankT *= 1 + def.nos.boost;
  if (v.gear.shiftTimer > 0 && !D.electric) crankT *= 0.14;

  // Clutch. Locked => engine and driveline are one rigid shaft and the engine's inertia is
  // reflected onto the wheels. Slipping => a torque-capacity coupling, with the engine free to
  // rev against it. See clutchCapacity() for why the capacity has to grow with revs.
  // Only declare it locked once the two sides are actually turning at the same speed. Snapping
  // to locked while the engine is 200 rad/s adrift dumps that mismatch into the tyres as a
  // torque spike, which reads on the telemetry as a -0.22 slip-ratio grab a metre off the line.
  const synced = Math.abs(v.omegaFree - omegaSlaved) < 30;
  const locked = D.electric || (clutch > 0.999 && synced);
  let clutchT; // torque actually reaching the gearbox input, Nm at the crank
  if (locked) {
    clutchT = crankT;
    v.omegaFree = Math.max(omegaSlaved, idleOmega);
  } else if (v.gear.shiftTimer > 0) {
    // Mid-shift: the clutch is out, so synchronise the crank to the speed the NEW gear will
    // need. That is what a twin-clutch box does, and it means re-engagement is seamless
    // instead of a bang — it also gives downshifts their rev-match for free.
    clutchT = 0;
    const sync = Math.abs(drivenAvg * totalRatio(D, s.gear));
    v.omegaFree = damp(v.omegaFree, Math.max(sync, idleOmega), 20, dt);
  } else {
    // Launch control. First gear multiplies crank torque by ~12, so ANY meaningful clutch bite
    // is far past what the tyres can hold and you get a 3.0 slip-ratio spike followed by the
    // engine being yanked to idle. Cap the clutch at the torque the driven tyres can actually
    // put down (plus a slice for a bit of theatre), and let traction control trim it further.
    let cap = clutchCapacity(D, s.rpm, throttleIn, clutch);
    if (Math.abs(ratio) > 1e-3) {
      let drivenLoad = 0;
      for (const i of driven) drivenLoad += s.wheels[i].load;
      if (drivenLoad > 1) {
        const gripCap =
          (def.tyreGrip * drivenLoad * def.wheelRadius) / Math.abs(ratio * D.efficiency);
        cap = Math.min(cap, gripCap);
      }
    }
    cap *= 0.5 + 0.5 * tc;
    clutchT = clamp((v.omegaFree - omegaSlaved) * 18, -cap * 0.12, cap);
    v.omegaFree += ((crankT - clutchT) / D.inertia) * dt;
    v.omegaFree = clamp(v.omegaFree, idleOmega, D.redline * RPM_TO_RAD * 1.06);
    if (clutch < 0.02) clutchT = 0;
  }
  const omega = locked ? Math.max(omegaSlaved, idleOmega) : v.omegaFree;
  s.engineOmega = omega;
  const rpmTarget = clamp(omega * RAD_TO_RPM, D.electric ? 0 : D.idle, D.redline * 1.05);
  s.rpm = damp(s.rpm, rpmTarget, 34, dt);
  s.shiftLight = clamp01((s.rpm - D.redline * 0.86) / (D.redline * 0.13));

  // ---- gearbox
  const beforeGear = s.gear;
  updateGearbox(D, def, s, v.gear, c, drivenAvg, dt, (gear, upShift) => {
    sys.ctx.bus.emit('car:shift', { car: v.car, gear, up: upShift });
    if (upShift && throttleIn > 0.6) v.backfire = Math.max(v.backfire, 0.55 + throttleIn * 0.4);
  });
  if (s.gear !== beforeGear) {
    // the ratio changed under us; recompute so this tick's torque is applied in the new gear
    v.gear.postShift = Math.max(v.gear.postShift, 0.2);
  }

  // ---- torque to the axles through the differentials
  let gearboxOut = clutchT * ratio * D.efficiency;
  if (!Number.isFinite(gearboxOut)) gearboxOut = 0;
  const fSpin = (s.wheels[0].spin + s.wheels[1].spin) * 0.5;
  const rSpin = (s.wheels[2].spin + s.wheels[3].spin) * 0.5;
  let frontT = gearboxOut * D.frontSplit;
  let rearT = gearboxOut * (1 - D.frontSplit);
  if (D.centre.viscous > 0) {
    const lock = clamp(D.centre.viscous * (fSpin - rSpin), -D.centre.maxLock, D.centre.maxLock);
    frontT -= lock;
    rearT += lock;
  }
  const wheelT = [0, 0, 0, 0];
  const hbCmd = clamp01(c.handbrake);
  if (def.drivetrain !== 'rwd') {
    splitAxle(D.lsd, frontT, s.wheels[0].spin, s.wheels[1].spin, def.drivetrain === 'fwd' && def.class === 'B', _axle);
    wheelT[0] = _axle[0];
    wheelT[1] = _axle[1];
  }
  if (def.drivetrain !== 'fwd') {
    // The handbrake declutches the rear axle. Without this, full throttle simply cancels the
    // handbrake torque, the rear wheels never lock, and a handbrake "drift" is a 5 degree
    // grippy turn — which is exactly what the telemetry measured before this line existed.
    splitAxle(D.lsd, rearT * (1 - hbCmd * 0.92), s.wheels[2].spin, s.wheels[3].spin, false, _axle);
    wheelT[2] = _axle[0];
    wheelT[3] = _axle[1];
  }

  // ---- per wheel: slip, force, spin
  // Engine inertia reflected through the gearing — ONCE, shared across the driven wheels. Adding
  // the full I*ratio^2 to each of four wheels quadruples the driveline inertia and costs a
  // 640 hp AWD car most of its acceleration (measured: 0.98 g instead of 1.35 g in first).
  // Ramp it with clutch engagement rather than switching it on at lock-up: a step change in
  // effective inertia while a big torque is flowing shows up as a wheel-spin spike.
  const reflected =
    (D.inertia * ratio * ratio * D.efficiency * (locked ? 1 : clutch * clutch)) /
    Math.max(driven.length, 1);
  const brakeCmd = clamp01(c.brake);
  const hb = clamp01(c.handbrake);
  // ESP brake vectoring, sized in section 2b. It is applied to the OUTER FRONT wheel only.
  const espBrake = A.espBrake > 0.002 ? def.brakeTorque * A.espBrake : 0;
  const espSide = A.espSide;
  let absAny = false;

  for (let i = 0; i < 4; i++) {
    const w = s.wheels[i];
    const isFront = i < 2;
    const R = def.wheelRadius;
    const feel = surfaceFeel(w.surface);

    // wheel axes projected into the contact plane
    _wF.copy(fwd).applyAxisAngle(up, -w.steerAngle);
    _wR.copy(right).applyAxisAngle(up, -w.steerAngle);
    if (w.contact) {
      _wF.addScaledVector(w.contactNormal, -_wF.dot(w.contactNormal)).normalize();
      _wR.addScaledVector(w.contactNormal, -_wR.dot(w.contactNormal)).normalize();
    }

    let fx = 0;
    let fy = 0;
    if (w.contact) {
      _arm.copy(w.contactPoint).sub(v.com);
      _vAt.copy(s.angularVelocity).cross(_arm).add(s.velocity);
      const vF = _vAt.dot(_wF);
      const vR = _vAt.dot(_wR);
      const roll = w.spin * R;

      // kinematic slip, then relaxation — the tyre must roll before it pulls
      const denom = Math.max(Math.abs(vF), 1.6);
      const kapTarget = clamp((roll - vF) / denom, -3, 3);
      const alpTarget = Math.atan2(vR, Math.max(Math.abs(vF), 0.9));
      w.slipRatio = relax(w.slipRatio, kapTarget, Math.max(Math.abs(vF), Math.abs(roll)), TYRE.relaxLong, dt);
      w.slipAngle = relax(w.slipAngle, alpTarget, Math.abs(vF), TYRE.relaxLat, dt);
      w.slipSpeed = Math.hypot(roll - vF, vR);

      // camber from body roll relative to the road (roll camber loss)
      w.camber = -Math.asin(clamp(w.contactNormal.dot(_wR), -0.4, 0.4)) * 0.55;

      const muBase = def.tyreGrip * w.grip * (isFront ? 1.0 : 1.005);
      // Handbrake unloads the rear tyres laterally so the back steps out — but the cut FADES
      // OUT as the car gets sideways, handing grip back exactly when the driver needs it to
      // catch the slide. Without that fade a handbrake tap at 130 km/h is a spin, not a drift.
      const hbFade = 1 - clamp01((Math.abs(beta) - 0.62) / 0.55);
      const latCut = 1 - hb * (isFront ? 0.0 : 0.5 * hbFade);
      _tf.kappa = w.slipRatio;
      _tf.alpha = w.slipAngle * latCut;
      _tf.Fz = w.load;
      _tf.Fz0 = v.fz0[i];
      _tf.mu0 = muBase;
      _tf.camber = w.camber;
      _tf.feel = feel;
      tyreForce(_tf, _tf);
      fx = _tf.fx;
      fy = _tf.fy;
      w.saturation = _tf.saturation;

      // rolling resistance, always opposing the contact patch's motion
      const rr = rollingResistance(w.load, vF, feel);
      fx -= Math.sign(vF) * Math.min(rr, Math.abs(fx) + rr);

      w.forceLong = fx;
      w.forceLat = fy;
      _force.addScaledVector(_wF, fx);
      _force.addScaledVector(_wR, fy);
      _tmp2.copy(_wF).multiplyScalar(fx).addScaledVector(_wR, fy);
      _torque.add(_tmp.copy(_arm).cross(_tmp2));
    } else {
      w.slipRatio = damp(w.slipRatio, 0, 6, dt);
      w.slipAngle = damp(w.slipAngle, 0, 6, dt);
      w.camber = 0;
    }

    // ---- brakes (ABS) ----
    let brakeMax = def.brakeTorque * (isFront ? 0.62 : 0.38) * brakeCmd;
    if (!isFront) brakeMax += def.brakeTorque * 0.9 * hb;
    // ESP brake vectoring. Braking force acts backwards (+Z in body space) at body x, giving a
    // yaw moment of -x*F, so the wheel on the outside of the rotation opposes it. Capped at
    // roughly the torque the contact patch can hold: a fully locked wheel makes the same
    // longitudinal force but throws away all of its lateral grip, which in a spin is exactly
    // the grip that brings the nose back round.
    if (espBrake > 0 && isFront && Math.sign(v.hard[i].x) === espSide) {
      brakeMax += Math.min(espBrake, def.tyreGrip * w.grip * w.load * def.wheelRadius * 0.92);
    }
    let mod = 1;
    if (w.contact && brakeCmd > 0.01 && hb < 0.4) {
      mod = absModulate(A, i, w.slipRatio, brakeCmd, vFwd, 0.13, dt);
      if (mod < 0.9) absAny = true;
    } else {
      A.abs[i] = damp(A.abs[i], 1, 12, dt);
    }
    w.absMod = mod;
    const brakeT = brakeMax * mod;

    // ---- spin dynamics ----
    const Ieff = v.wheelInertia + (isDriven[i] ? reflected : 0);
    const react = w.contact ? -fx * def.wheelRadius : 0;
    let tq = wheelT[i] + react;
    if (!w.contact) tq -= Math.sign(w.spin) * Math.min(Math.abs(w.spin) * 1.4, 30);
    let spin = w.spin + (tq / Math.max(Ieff, 0.4)) * dt;
    // brake as a separate, clamped step so it can never reverse the wheel in one tick
    if (brakeT > 0) {
      const dv = (brakeT / Math.max(Ieff, 0.4)) * dt;
      spin = Math.abs(spin) <= dv ? 0 : spin - Math.sign(spin) * dv;
    }
    if (!Number.isFinite(spin)) spin = w.contact ? _vAt.dot(_wF) / def.wheelRadius : 0;
    // sanity clamp: nothing rolls faster than 3x road speed + a launch allowance
    const vRoad = w.contact ? Math.abs(_vAt.dot(_wF)) : Math.abs(vFwd);
    const cap = (vRoad + 26) / def.wheelRadius;
    w.spin = clamp(spin, -cap, cap);
    w.angle += w.spin * dt;
    if (w.angle > 1e6 || w.angle < -1e6) w.angle = 0;
    w.driveTorque = wheelT[i];
    w.lockedUp = w.contact && brakeT > 10 && Math.abs(w.spin * def.wheelRadius) < Math.abs(vFwd) * 0.55 && absV > 2.5;
    w.spinningUp = w.contact && w.slipRatio > 0.22;

    if (w.surface !== v.lastSurface[i]) {
      v.lastSurface[i] = w.surface;
      sys.ctx.bus.emit('wheel:surface', { car: v.car, wheel: i, surface: w.surface, slip: w.slipSpeed });
    }
  }
  s.absActive = absAny;
  s.surface = s.wheels[2].contact ? s.wheels[2].surface : s.wheels[0].surface;
  s.engineLoad = clamp01(throttle * (0.35 + 0.65 * clamp01(s.rpm / Math.max(D.redline, 1))));

  // ---------------------------------------------------------------- 5b. spin arrest (ESP)
  //
  // Steering alone cannot save a car that is already 100 degrees sideways — the front tyres run
  // out of lock — and brake vectoring alone is too weak once the outer front is barely loaded.
  // So the controller in section 2b also produces a virtual yaw moment, capped at a fraction of
  // what the tyres could physically make and clamped so it can only ever REMOVE rotation. It is
  // identically zero below `ESP.betaFree`, so a 20-45 degree drift never feels it at all.
  if (Math.abs(A.espMoment) > 1) _torque.addScaledVector(up, A.espMoment);

  // ---------------------------------------------------------------- 6. aero
  const v2 = s.velocity.lengthSq();
  if (v2 > 0.04) {
    const qDyn = 0.5 * RHO * v2;
    const drag = qDyn * v.aeroCd;
    const down = qDyn * v.aeroCl * def.frontalArea;
    _tmp.copy(s.velocity).normalize();
    _force.addScaledVector(_tmp, -(drag + down * 0.25));
    // 42/58 split so downforce also loads the rear on a straight
    _force.addScaledVector(up, -down);
    _torque.addScaledVector(right, -down * (def.wheelbase * 0.08));
  }

  // ---------------------------------------------------------------- airborne
  const wasAir = s.airborne;
  s.airborne = contacts === 0;
  if (s.airborne) {
    s.airTime += dt;
    if (!wasAir && s.airTime > 0) sys.ctx.bus.emit('car:airborne', { car: v.car });
    // gentle auto-level: rotate the car's up back toward world up, and damp spin. Small enough
    // that a deliberate jump still looks wild, strong enough that you never land on the roof.
    if (s.airTime > 0.1) {
      const k = clamp01((s.airTime - 0.1) * 2.2);
      _tmp.set(0, 1, 0);
      _tmp2.copy(up).cross(_tmp); // axis that rotates up -> worldUp
      // Scale by how far over we are, so a small hop is untouched and a real tumble is caught.
      const tip = 1 - clamp01(up.y);
      _torque.addScaledVector(_tmp2, def.mass * (2.1 + 5.5 * tip) * k);
      _torque.addScaledVector(s.angularVelocity, -def.mass * 0.55 * k);
    }
    v.landVel = s.velocity.y;
  } else {
    if (wasAir && s.airTime > 0.18) {
      sys.ctx.bus.emit('car:land', { car: v.car, impact: Math.abs(v.landVel) });
    }
    s.airTime = 0;
  }

  // ---------------------------------------------------------------- 7. integrate
  _acc.copy(_force).multiplyScalar(v.invMass);
  if (!Number.isFinite(_acc.x + _acc.y + _acc.z)) _acc.set(0, 0, 0);
  s.velocity.addScaledVector(_acc, dt);
  // hard speed ceiling — 150 m/s is 540 km/h, well past anything drivable
  if (s.velocity.lengthSq() > 22500) s.velocity.setLength(150);
  syncCom(v);
  v.com.addScaledVector(s.velocity, dt);

  // Torque is accumulated in world space but the inertia tensor is diagonal in BODY space, so
  // rotate into the body, divide, and rotate back. Skipping this makes a rolled car pitch.
  const I = v.inertia;
  _tmp2.copy(_torque).applyQuaternion(_iq);
  _tmp2.set(_tmp2.x / I.x, _tmp2.y / I.y, _tmp2.z / I.z).applyQuaternion(q);
  if (Number.isFinite(_tmp2.x + _tmp2.y + _tmp2.z)) s.angularVelocity.addScaledVector(_tmp2, dt);
  s.angularVelocity.multiplyScalar(1 - clamp01(0.55 * dt));
  if (s.angularVelocity.lengthSq() > MAX_ANG * MAX_ANG) s.angularVelocity.setLength(MAX_ANG);

  const w0 = s.angularVelocity;
  const wLen = w0.length();
  if (wLen > 1e-7) {
    _dq.setFromAxisAngle(_tmp.copy(w0).multiplyScalar(1 / wLen), wLen * dt);
    s.quaternion.premultiply(_dq).normalize();
  }
  syncOrigin(v);

  // ---------------------------------------------------------------- ground guard
  // Never let the body sink through the road: an analytic heightfield means we always know the
  // truth, so a single positional correction is enough and it cannot tunnel at any speed.
  {
    const g = world.sampleGround(s.position.x, s.position.z, v.groundHint);
    // The origin sits ~25 mm over the road at rest, so anything below the road surface means
    // the floorpan is inside the tarmac. Analytic heightfield => we always know the truth, so
    // one positional correction is enough and it cannot tunnel at any speed.
    const floor = g.height - 0.05;
    if (s.position.y < floor) {
      const lift = floor - s.position.y;
      s.position.y = floor;
      if (s.velocity.y < 0) s.velocity.y *= -0.1;
      syncCom(v);
      void lift;
    }
  }

  // ---------------------------------------------------------------- 8. bookkeeping
  s.throttle = throttleIn;
  s.brake = brakeCmd;
  s.steer = clamp(c.steer, -1, 1);
  s.handbrake = hb;
  s.rideHeight = 0;
  {
    const g = world.sampleGround(s.position.x, s.position.z, v.groundHint);
    s.rideHeight = s.position.y - g.height;
  }

  // g-force: the specific force an accelerometer at the centre of mass would read, in body
  // axes. x = lateral (+ right), y = vertical (1.0 at rest), z = longitudinal (+ = speeding up).
  // This is exact — it includes the centripetal term, so it does NOT read zero in a steady
  // corner the way a frame-to-frame velocity difference does.
  _spec.copy(_acc);
  _spec.y += G;
  _spec.applyQuaternion(_iq).multiplyScalar(1 / G);
  s.gForce.set(
    damp(s.gForce.x, clamp(_spec.x, -6, 6), 22, dt),
    damp(s.gForce.y, clamp(_spec.y, -6, 8), 22, dt),
    damp(s.gForce.z, clamp(-_spec.z, -6, 6), 22, dt)
  );

  s.brakeHeat = damp(s.brakeHeat, clamp01(brakeCmd * clamp01(absV / 34) + (absAny ? 0.15 : 0)), 2.4, dt);

  // ---- drift ----
  // TRUE signed angle between the car's heading and its velocity, in (-pi, pi]. The `beta` used
  // by the assists deliberately floors the forward term for control stability, which compresses
  // everything past ~85 deg into a plateau — fine for a controller, useless for the camera, VFX
  // and HUD, which need to tell a big drift from an actual spin.
  const planar = Math.hypot(s.localVelocity.x, s.localVelocity.z);
  s.driftAngle = planar > 1 ? Math.atan2(s.localVelocity.x, -s.localVelocity.z) : 0;
  const rearSlip = (Math.abs(s.wheels[2].slipAngle) + Math.abs(s.wheels[3].slipAngle)) * 0.5;
  const dA = Math.abs(s.driftAngle);
  const wantDrift =
    planar > 7 && contacts >= 2 && (dA > 0.14 || (rearSlip > v.peakSlip * 1.25 && dA > 0.09));
  v.driftTimer = wantDrift ? v.driftTimer + dt : Math.max(0, v.driftTimer - dt * 2.6);
  // Hysteresis only where it is needed. A car hovering either side of the threshold must not
  // flicker the flag — VFX keys smoke and skid marks off it — but a car that is already 11 deg
  // sideways is unambiguously drifting, and making the smoke wait 80 ms for a timer to fill is
  // 80 ms of a visibly sliding car with clean tyres.
  s.drifting = v.driftTimer > 0.08 || (wantDrift && dA > 0.2);
  if (s.drifting) {
    s.driftCombo = Math.min(6, 1 + v.driftTimer * 0.45);
    s.driftScore += Math.min(dA, 1.4) * planar * dt * 5.5 * s.driftCombo;
  } else if (v.driftTimer <= 0) s.driftCombo = 1;

  // ---- backfire ----
  if (!D.electric) {
    const overrun = throttleIn < 0.06 && s.rpm > D.redline * 0.55 && absV > 12;
    if (overrun && Math.random() < 2.2 * dt) v.backfire = Math.max(v.backfire, 0.35);
    if (v.gear.limiterActive && Math.random() < 6 * dt) v.backfire = Math.max(v.backfire, 0.5);
    if (v.backfire > 0.01) {
      sys.ctx.bus.emit('car:backfire', { car: v.car, strength: v.backfire });
      v.backfire = 0;
    }
  }

  s.distanceTravelled += absV * dt;
  s.odometer += absV * dt;
  v.prevSpeed = vFwd;

  // ---------------------------------------------------------------- NaN guard
  if (
    !Number.isFinite(s.position.x + s.position.y + s.position.z) ||
    !Number.isFinite(s.velocity.x + s.velocity.y + s.velocity.z) ||
    !Number.isFinite(s.quaternion.x + s.quaternion.w)
  ) {
    console.warn('[physics] non-finite state — recovering vehicle');
    sys.recover(v);
  }
}

/** Level a car's roll/pitch onto the road without moving it — used after a reset or recovery. */
export function alignToRoad(v, world) {
  const s = v.state;
  const g = world.sampleGround(s.position.x, s.position.z, v.groundHint);
  _up.set(0, 1, 0).applyQuaternion(s.quaternion);
  _lvl.setFromUnitVectors(_up, g.normal);
  s.quaternion.premultiply(_lvl).normalize();
  s.position.y = g.height + (v.def.wheelRadius - (v.def.cog.y - v.restLen + v.pen0));
  syncCom(v);
}
