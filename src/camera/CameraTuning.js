/**
 * Per-mode camera tuning.
 *
 * Distances/heights are metres relative to the car's origin (which sits on the road surface —
 * the car mesh root is at ground level, body centre ≈ 0.7 m up). Frequencies are Hz for the
 * spring rig in Spring.js; zeta is the damping ratio.
 *
 * Calibrated against reference/nfs-1222680-01.jpg (Heat, chase cam, daylight) by projecting the
 * car's bounding box into NDC and matching it to the press shot, not by eye:
 *
 *   the car's on-screen box is ~0.30 of frame width and ~0.30 of frame height, WIDER than it is
 *   tall in pixels (~0.6 h/w) because the lens sits barely above the roofline. Its roof breaks
 *   just under the horizon, and the frame is a ~55° vertical lens, not a fisheye.
 *
 * The two numbers that matter and were both wrong: `height` (2.02 put the lens 0.8 m over the
 * roof, so the shot was the car's roof plan, not its rear) and `fov` (58 + 13.5 speed + 8.5 NOS
 * reached 73° vertical ≈ 104° horizontal — the road ahead shrank to a smear round the vanishing
 * point and the buildings at the frame edge stretched into wedges). Distance was already right.
 */

const chase = {
  // --- rig geometry ---
  distance: 6.9, // metres behind the car
  distanceSpeed: 1.5, // extra metres at top speed
  // Just over the roofline (the car is ~1.25 m tall). Higher than this and the camera looks down
  // at the car's roof instead of its rear — the single most common way a chase cam reads amateur.
  height: 1.62, // metres above the car origin
  heightSpeed: 0.22,
  lateral: 0.0,
  lookHeight: 0.95, // aim point height above the car origin
  lookAhead: 15.0, // metres in front of the car the aim point sits
  lookAheadSpeed: 9.0,

  // --- spring response --- position trails, aim leads (different rates is the whole trick)
  posFreq: 1.55,
  posZeta: 1.0,
  posFeedForward: 0.97,
  aimFreq: 3.4,
  aimZeta: 1.0,
  aimFeedForward: 1.0,
  yawFreq: 2.1,
  yawZeta: 0.95,

  // --- lens ---
  // three.js `fov` is VERTICAL. At 16:9 a 50° vertical lens is already ~80° horizontal; the old
  // 58 + 13.5 + 8.5 stack peaked past 100° horizontal, which is where straight buildings at the
  // frame edge shear into wedges. Keep the speed pump — it is what sells velocity — but on a
  // lens that still has a foreground.
  fov: 50,
  fovSpeed: 8.5, // widening at 320 km/h
  fovNos: 6.0,
  fovDrift: 3.0,
  fovFreq: 1.9,
  fovZeta: 0.62, // under-damped so NOS *punches* instead of ramping

  // --- feel ---
  anticipation: 1.0, // corner look-ahead scale
  driftOrbit: 1.0, // outside-of-slide orbit scale
  accelPull: 1.35, // metres of pull-back at 1 g of acceleration
  brakePush: 1.0, // metres of push-in at 1 g of braking
  rollGain: 0.052, // radians of camera roll per g of lateral acceleration
  bankFollow: 0.42, // how much of the car's own roll the camera inherits
  shake: 1.0,
  vibration: 0.0, // engine vibration (body-mounted cams only)
  airLift: 1.0,
  minGroundClearance: 0.55,
  probeRadius: 0.42,
  lookBack: true,

  // --- collision avoidance limits (see Occlusion.js) ---
  // The floor on the boom. The occlusion solver may pull in for a wall, but never past this:
  // a slightly clipped barrier reads as a near miss, a camera in the parcel shelf reads as a bug.
  // Matched to the car: ~4 m behind clears the boot and still shows a car-length of road ahead.
  minDistance: 3.9, // metres behind the car, measured horizontally
  // Must stay BELOW the nominal `height` or it stops being a floor and becomes the camera height:
  // the clamp would fire every frame and quietly undo the tuning above. 1.3 m is just above the
  // roof (~1.25 m), which is all this is for — never let the lens end up inside the car.
  minHeight: 1.3, // metres above the car's origin
  // How far outside the drivable half-width the boom may swing before it is eased back.
  corridorMargin: 1.2,
  // Ray hits closer than this to the pivot are the car's own bodywork or geometry running
  // alongside it — never something between the lens and the car. The ray starts here.
  selfRadius: 2.6,
  // Keep this far clear of a barrier that sits at lens height. A guardrail 1 m off the lens
  // eats a third of the frame even though it never occludes the car.
  wallClearance: 2.0,
};

export const TUNING = {
  chase,

  chaseFar: {
    ...chase,
    distance: 9.4,
    distanceSpeed: 1.9,
    height: 2.45,
    heightSpeed: 0.32,
    lookHeight: 1.05,
    lookAhead: 17.0,
    posFreq: 1.25,
    aimFreq: 2.8,
    yawFreq: 1.7,
    fov: 45,
    fovSpeed: 7.5,
    fovNos: 5.0,
    anticipation: 1.2,
    driftOrbit: 1.15,
    accelPull: 1.6,
    rollGain: 0.04,
    shake: 0.8,
    minGroundClearance: 0.7,
    probeRadius: 0.5,
    minDistance: 5.6,
    minHeight: 1.9,
    corridorMargin: 1.5,
    selfRadius: 3.0,
    wallClearance: 2.2,
  },

  // Body-mounted rigs: almost rigid to the car, very wide, high-frequency engine buzz.
  hood: {
    ...chase,
    bodyMounted: true,
    // local offsets, resolved against the car def in CameraSystem
    mountHeight: 0.82, // × def.height
    mountForward: 0.22, // × def.length (positive = toward the nose)
    lookHeight: 1.05,
    lookAhead: 30,
    lookAheadSpeed: 14,
    posFreq: 9.0,
    posZeta: 1.0,
    aimFreq: 7.0,
    yawFreq: 8.0,
    yawZeta: 1.0,
    fov: 70,
    fovSpeed: 9,
    fovNos: 6,
    fovDrift: 0,
    fovFreq: 2.4,
    fovZeta: 0.6,
    anticipation: 0.28,
    driftOrbit: 0.0,
    accelPull: 0.12,
    brakePush: 0.1,
    rollGain: 0.03,
    bankFollow: 0.82,
    shake: 1.25,
    vibration: 1.0,
    airLift: 0.15,
    minGroundClearance: 0.3,
    probeRadius: 0.15,
    lookBack: false,
    // Bolted to the car — the occlusion solver never runs for these.
    minDistance: 0,
    minHeight: 0,
    wallClearance: 0,
  },

  bumper: {
    ...chase,
    bodyMounted: true,
    mountHeight: 0.4,
    mountForward: 0.58, // just ahead of the nose
    lookHeight: 0.55,
    lookAhead: 34,
    lookAheadSpeed: 16,
    posFreq: 11.0,
    posZeta: 1.0,
    aimFreq: 8.0,
    yawFreq: 9.5,
    yawZeta: 1.0,
    fov: 74,
    fovSpeed: 9.5,
    fovNos: 6,
    fovDrift: 0,
    fovFreq: 2.6,
    fovZeta: 0.58,
    anticipation: 0.22,
    driftOrbit: 0.0,
    accelPull: 0.08,
    brakePush: 0.06,
    rollGain: 0.026,
    bankFollow: 0.9,
    shake: 1.5,
    vibration: 1.35,
    airLift: 0.1,
    minGroundClearance: 0.22,
    probeRadius: 0.12,
    lookBack: false,
    minDistance: 0,
    minHeight: 0,
    wallClearance: 0,
  },

  orbit: {
    ...chase,
    distance: 8.0,
    height: 2.6,
    lookHeight: 0.72,
    lookAhead: 0,
    lookAheadSpeed: 0,
    posFreq: 2.6,
    aimFreq: 4.0,
    fov: 44,
    fovSpeed: 0,
    fovNos: 0,
    fovDrift: 0,
    anticipation: 0,
    driftOrbit: 0,
    accelPull: 0,
    brakePush: 0,
    rollGain: 0,
    bankFollow: 0,
    shake: 0.25,
    airLift: 0,
    minGroundClearance: 0.5,
    probeRadius: 0.3,
    lookBack: false,
    minDistance: 4.6,
    minHeight: 1.5,
    corridorMargin: 2.0,
    selfRadius: 3.0,
    wallClearance: 1.4,
  },

  cinematic: {
    ...chase,
    posFreq: 2.2,
    aimFreq: 3.2,
    fov: 40,
    fovSpeed: 6,
    fovNos: 4,
    fovDrift: 0,
    fovFreq: 1.4,
    fovZeta: 0.85,
    anticipation: 0,
    driftOrbit: 0,
    accelPull: 0,
    brakePush: 0,
    rollGain: 0.012,
    bankFollow: 0,
    shake: 0.45,
    airLift: 0,
    minGroundClearance: 0.35,
    probeRadius: 0.3,
    lookBack: false,
    // The director deliberately parks low and close for some setups; only stop it clipping.
    minDistance: 2.4,
    minHeight: 0.5,
    corridorMargin: 6.0,
    selfRadius: 2.6,
    wallClearance: 1.0,
  },
};

/** Roughness per surface — drives the high-frequency road shake. */
export const SURFACE_ROUGHNESS = {
  asphalt: 0.12,
  concrete: 0.2,
  metal: 0.25,
  curb: 1.0,
  dirt: 0.85,
  grass: 0.7,
  water: 0.3,
};

export const MODES = ['chase', 'chaseFar', 'hood', 'bumper', 'cinematic', 'orbit', 'photo'];
/** The subset the V key cycles through. */
export const CYCLE_MODES = ['chase', 'chaseFar', 'hood', 'bumper'];
