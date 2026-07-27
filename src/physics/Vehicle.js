/**
 * Per-vehicle state construction — Need for Tokens, physics lane.
 *
 * ============================ RIDE HEIGHT CONTRACT (read this) ============================
 * This is the contract between the physics lane and the car-art lane. Getting it wrong makes
 * the car float above the road or bury its tyres in it, and it has already happened once.
 *
 *   hardpoint (body frame)  = ( +-track/2, def.cog.y, +-wheelbase/2 )
 *   suspension rest length  = def.suspension.travel          (hardpoint -> hub, fully extended)
 *   hub (body frame)        = ( x, def.cog.y - travel + pen, z )    pen = compression, metres
 *   static compression      = pen0 = mass * 9.81 / (4 * suspension.stiffness)
 *   STATIC HUB HEIGHT       = def.cog.y - travel + pen0     === CarBody.staticHubY(def)
 *
 * `state.wheels[i].suspensionOffset` is **the deviation of the hub from its STATIC rest height,
 * in metres, positive = compressed**:
 *
 *     suspensionOffset = pen - pen0                       // physics writes this
 *     pivot.position.y = staticHubY(def) + suspensionOffset   // CarSystem consumes it
 *
 * so it reads 0 at rest, `-pen0` at full droop, and `travel - pen0` at full bump.
 *
 * THE BUG THIS REPLACED: physics used to publish `pen - travel` while CarSystem added it to the
 * already-compressed rest height, double-counting the static compression and dropping every
 * wheel a further `travel - pen0` = 114 mm into the tarmac. The body then *looked* like it was
 * hovering, because the visible tyre/road junction was 11 cm up the sidewall instead of at the
 * contact patch. Both halves of this contract must move together — if you change what
 * `suspensionOffset` means, change `staticHubY()` in `src/vehicle/CarBody.js` and
 * `CarSystem.applyPhysics` in the same breath, and re-run
 * `node src/physics/telemetry.mjs --only ride`, which measures the RENDERED wheel against the
 * RENDERED road and fails the instant the two sides disagree.
 *
 * At static equilibrium the car ORIGIN sits at
 *     position.y = groundY + wheelRadius - staticHubY(def)
 * which for the hero car is 26 mm. That is the number the floating-car regression test asserts.
 * =========================================================================================
 *
 * Dynamics are integrated about the CENTRE OF MASS, which is `def.cog` above/behind the visual
 * origin. `state.position` stays the visual origin because that is what CarSystem parents the
 * shell to; the centre of mass is carried alongside in `v.com`. Doing it any other way puts the
 * roll axis on the road surface, and then lateral tyre force produces no roll moment at all —
 * no weight transfer, no dive, no squat, nothing for the camera to key off.
 */

import * as THREE from 'three';
import { clamp } from '../core/MathX.js';
import { makeDrivetrain } from './Drivetrain.js';
import { makeAssistState } from './Assists.js';
import { TYRE } from './Tyre.js';

export const G = 9.81;

/** Compression of one corner under its share of the static weight, metres. */
export function staticPen(def) {
  return (def.mass * G * 0.25) / Math.max(def.suspension.stiffness, 1);
}

/** Must agree with `staticHubY()` in src/vehicle/CarBody.js. */
export function staticHubY(def) {
  const p = staticPen(def);
  return def.cog.y - def.suspension.travel + Math.min(p, def.suspension.travel);
}

/** Height of the visual origin above the road at static rest. */
export function staticRideHeight(def) {
  return def.wheelRadius - staticHubY(def);
}

export function makeVehicleState(def) {
  const s = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    localVelocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    speed: 0,
    speedKmh: 0,
    rpm: Math.max(def.idleRpm, 0),
    gear: 1,
    engineLoad: 0,
    clutch: 1,
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: 0,
    nosAmount: 1,
    nosActive: false,
    wheels: [],
    gForce: new THREE.Vector3(0, 1, 0),
    drifting: false,
    driftAngle: 0,
    driftScore: 0,
    airborne: false,
    airTime: 0,
    damage: { front: 0, rear: 0, left: 0, right: 0, total: 0 },
    odometer: 0,
    distanceTravelled: 0,
    lastCollision: null,

    // ---- additions (never rename or remove anything above) ----
    brakeHeat: 0,
    steerAngle: 0, // final front-wheel angle after assists, rad
    slipAngle: 0, // body slip angle, rad (=== driftAngle, kept for clarity)
    absActive: false,
    tcActive: false,
    assist: 0, // 0..1 how hard the stability helper is working
    driftIntent: 0, // 0..1 how much the player is asking to be sideways
    driftCombo: 1,
    wheelsOnGround: 0,
    surface: 'asphalt',
    rideHeight: 0, // origin above the road, metres
    engineOmega: 0, // rad/s at the crank
    shiftLight: 0, // 0..1
    espActive: false, // stability control intervening
    espAmount: 0, // 0..1 how hard
  };
  const pen0 = staticPen(def);
  const fz0 = def.mass * G * 0.25;
  for (let i = 0; i < 4; i++) {
    s.wheels.push({
      contact: false,
      contactPoint: new THREE.Vector3(),
      contactNormal: new THREE.Vector3(0, 1, 0),
      surface: 'asphalt',
      grip: 1,
      compression: 0.5,
      suspensionForce: fz0,
      suspensionOffset: 0, // === pen - staticPen(def). See the header.
      slipRatio: 0,
      slipAngle: 0,
      slipSpeed: 0,
      steerAngle: 0,
      spin: 0,
      angle: 0,
      load: fz0,
      lockedUp: false,
      spinningUp: false,
      // ---- additions ----
      pen: pen0,
      camber: 0,
      forceLong: 0,
      forceLat: 0,
      saturation: 0,
      absMod: 1,
      driveTorque: 0,
    });
  }
  return s;
}

/**
 * Rigid-body inertia about the centre of mass. A car is not a solid box — the mass is
 * concentrated low and centrally — so the box tensor is scaled by measured-ish factors.
 * Yaw inertia is the one that matters for handling: too high and the car will not rotate,
 * too low and it spins on its own axis like a fairground ride.
 */
export function makeInertia(def) {
  const m = def.mass;
  const L = def.length;
  const W = def.width;
  const H = def.height;
  const I = new THREE.Vector3(
    (m * (H * H + L * L)) / 12 * 0.82, // pitch, about X
    (m * (W * W + L * L)) / 12 * 0.86, // yaw,   about Y
    (m * (W * W + H * H)) / 12 * 0.72 // roll,  about Z
  );
  return I;
}

export function makeVehicle(car, def, params = {}) {
  const state = makeVehicleState(def);
  const I = makeInertia(def);
  const pen0 = staticPen(def);

  // static axle load split from the longitudinal centre of gravity
  const wb = def.wheelbase;
  const frontShare = clamp((wb * 0.5 - def.cog.z) / wb, 0.3, 0.7);

  const v = {
    car,
    def,
    state,
    params,
    controls: { throttle: 0, brake: 0, steer: 0, handbrake: 0, nos: 0, shiftUp: false, shiftDown: false },

    // --- rigid body ---
    com: new THREE.Vector3(), // centre of mass, world
    cog: new THREE.Vector3(def.cog.x, def.cog.y, def.cog.z),
    inertia: I,
    invI: new THREE.Vector3(1 / I.x, 1 / I.y, 1 / I.z),
    invMass: 1 / def.mass,

    // --- suspension ---
    restLen: def.suspension.travel,
    pen0,
    // hardpoints relative to the CENTRE OF MASS, body frame
    hard: [
      new THREE.Vector3(-def.track / 2 - def.cog.x, 0, -wb / 2 - def.cog.z),
      new THREE.Vector3(def.track / 2 - def.cog.x, 0, -wb / 2 - def.cog.z),
      new THREE.Vector3(-def.track / 2 - def.cog.x, 0, wb / 2 - def.cog.z),
      new THREE.Vector3(def.track / 2 - def.cog.x, 0, wb / 2 - def.cog.z),
    ],
    // nominal per-wheel load, used for tyre load sensitivity
    fz0: [
      (def.mass * G * frontShare) / 2,
      (def.mass * G * frontShare) / 2,
      (def.mass * G * (1 - frontShare)) / 2,
      (def.mass * G * (1 - frontShare)) / 2,
    ],
    frontShare,

    // --- drivetrain ---
    dt: makeDrivetrain(def),
    gear: {
      shiftTimer: 0,
      postShift: 0,
      blip: 0,
      wantReverse: false,
      limiter: 0,
      limiterActive: false,
      stopHold: 0, // seconds the brake has been held at a standstill
      hasMoved: false, // has this car driven since the last reverse selection?
    },
    omegaFree: Math.max(def.idleRpm, 0) * ((2 * Math.PI) / 60),
    wheelInertia: Math.max(0.9, 0.5 * (def.wheelRadius * 62) * def.wheelRadius * def.wheelRadius * 1.6),

    // --- assists ---
    assist: makeAssistState(),

    // --- bookkeeping ---
    groundHint: -1,
    lastSurface: ['asphalt', 'asphalt', 'asphalt', 'asphalt'],
    airTimer: 0,
    landVel: 0,
    backfire: 0,
    collisionCooldown: 0,
    driftTimer: 0,
    prevSpeed: 0,
    nanGuard: 0,
    aeroCl: def.downforce * 0.16,
    aeroCd: def.dragCoeff * def.frontalArea,
    peakSlip: TYRE.alphaPeak,
    steerLock: def.steerLockDeg * (Math.PI / 180),
  };
  car.state = state;
  return v;
}

/** Place a vehicle at a transform, at rest, with the suspension already settled. */
export function placeVehicle(v, position, quaternion) {
  const s = v.state;
  s.position.copy(position);
  if (quaternion) s.quaternion.copy(quaternion).normalize();
  s.velocity.set(0, 0, 0);
  s.angularVelocity.set(0, 0, 0);
  s.localVelocity.set(0, 0, 0);
  s.speed = 0;
  s.speedKmh = 0;
  s.gear = 1;
  s.rpm = Math.max(v.def.idleRpm, 0);
  s.airborne = false;
  s.airTime = 0;
  s.drifting = false;
  s.driftAngle = 0;
  s.gForce.set(0, 1, 0);
  v.omegaFree = s.rpm * ((2 * Math.PI) / 60);
  v.gear.shiftTimer = 0;
  v.gear.postShift = 0;
  v.gear.stopHold = 0;
  v.gear.hasMoved = false;
  // Clear the driver aids too. A teleported car carrying a half-released ABS channel or a wound
  // -up counter-steer trim behaves differently from a fresh one, which makes every measurement
  // depend on whatever happened before it.
  v.assist.abs[0] = v.assist.abs[1] = v.assist.abs[2] = v.assist.abs[3] = 1;
  v.assist.tc = 1;
  v.assist.tcCut = 0;
  v.assist.counter = 0;
  v.assist.stability = 0;
  v.assist.driftIntent = 0;
  v.assist.driftHold = 0;
  v.assist.yawFilter = 0;
  v.assist.espMoment = 0;
  v.assist.espBrake = 0;
  v.assist.espSide = 0;
  v.assist.espCut = 0;
  v.assist.espAmount = 0;
  v.assist.yawRef = 0;
  v.assist.betaPrev = 0;
  v.assist.betaDot = 0;
  s.espActive = false;
  s.espAmount = 0;
  v.driftTimer = 0;
  v.backfire = 0;
  v.collisionCooldown = 0;
  v.groundHint = -1;
  v.airTimer = 0;
  for (const w of v.state.wheels) {
    w.spin = 0;
    w.slipRatio = 0;
    w.slipAngle = 0;
    w.pen = v.pen0;
    w.compression = v.pen0 / v.restLen;
    w.suspensionOffset = 0;
    w.absMod = 1;
  }
  syncCom(v);
}

/** Recompute the world centre of mass from the visual origin. */
export function syncCom(v) {
  v.com.copy(v.cog).applyQuaternion(v.state.quaternion).add(v.state.position);
}

/** Write the visual origin back from the world centre of mass. */
export function syncOrigin(v) {
  v.state.position.copy(v.cog).applyQuaternion(v.state.quaternion).multiplyScalar(-1).add(v.com);
}
