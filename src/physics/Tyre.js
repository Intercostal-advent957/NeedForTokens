/**
 * Combined-slip tyre model — Need for Tokens, physics lane.
 *
 * A Pacejka-style Magic Formula fit with:
 *   - separate longitudinal / lateral peak slips and shape factors,
 *   - combined slip through a NORMALISED SLIP VECTOR, which gives a true friction ellipse
 *     with no seam or discontinuity where the two curves meet,
 *   - load sensitivity (grip per newton falls as vertical load rises) — this is the single
 *     property that makes weight transfer matter, and without it the car has no character,
 *   - a camber thrust term,
 *   - relaxation length, so force builds over ~0.5 m of rolling rather than instantly. This is
 *     what stops a 120 Hz sim from chattering when a wheel crosses a paint line.
 *
 * Sign convention (car space, -Z forward, +X right):
 *   slipRatio  kappa > 0  => wheel spinning faster than the road  => forward force
 *   slipAngle  alpha > 0  => contact patch sliding to the RIGHT   => force to the LEFT
 * Forces are returned in the WHEEL's own frame: fx along the wheel heading, fy along the
 * wheel's right vector. The caller rotates them into world space.
 */

import { clamp } from '../core/MathX.js';

/** Default coefficient set. Per-surface variants below scale these. */
export const TYRE = {
  // longitudinal
  Cx: 1.62,
  Ex: 0.94,
  kappaPeak: 0.115, // slip ratio at peak grip
  // lateral
  Cy: 1.36,
  Ey: 0.92,
  alphaPeak: 0.145, // ~8.3 deg
  // lateral peak is always slightly below longitudinal on a road tyre
  latScale: 0.965,
  // load sensitivity: mu = mu0 * (1 - kLoad * (Fz/Fz0 - 1)), clamped
  kLoad: 0.135,
  muMin: 0.62,
  muMax: 1.28,
  // camber thrust, N per newton of load per radian
  camberStiffness: 0.85,
  // relaxation length, metres
  relaxLong: 0.32,
  relaxLat: 0.52,
  // how much of the peak remains at full slide (tail of the magic curve)
  slideFloor: 0.72,
};

/**
 * Per-surface modifiers on top of `sampleGround().grip`.
 * `grip` already carries the friction level; these shape *how the surface behaves* — loose
 * surfaces reach peak at much larger slip and hold a longer, flatter tail, which is exactly
 * why a car on gravel slides progressively instead of snapping.
 */
export const SURFACE_FEEL = {
  asphalt: { peakScale: 1.0, tail: 1.0, roll: 1.0, noise: 0.0 },
  concrete: { peakScale: 1.05, tail: 1.02, roll: 1.05, noise: 0.0 },
  curb: { peakScale: 0.92, tail: 1.0, roll: 1.4, noise: 0.35 },
  metal: { peakScale: 0.8, tail: 1.05, roll: 1.0, noise: 0.1 },
  dirt: { peakScale: 1.9, tail: 1.18, roll: 2.6, noise: 0.5 },
  grass: { peakScale: 1.7, tail: 1.12, roll: 3.2, noise: 0.35 },
  water: { peakScale: 1.3, tail: 0.9, roll: 2.0, noise: 0.15 },
};

export function surfaceFeel(name) {
  return SURFACE_FEEL[name] || SURFACE_FEEL.asphalt;
}

/**
 * The Magic Formula, normalised so it peaks at exactly 1.0 at x = 1.
 * `x` is slip already divided by its peak slip, so one curve serves both axes.
 */
function magicN(x, C, E) {
  // peak of sin(C*atan(Bx - E(Bx - atan Bx))) is at C*atan(...) = pi/2
  const B = Math.tan(Math.PI / (2 * C));
  const bx = B * x;
  const y = Math.sin(C * Math.atan(bx - E * (bx - Math.atan(bx))));
  return y / Math.sin(C * Math.atan(B - E * (B - Math.atan(B))));
}

/**
 * Load-sensitive peak friction coefficient.
 * @param {number} mu0   nominal peak (def.tyreGrip * surface grip)
 * @param {number} Fz    current vertical load, N
 * @param {number} Fz0   nominal load (static per-wheel), N
 */
export function loadSensitiveMu(mu0, Fz, Fz0, k = TYRE.kLoad) {
  if (Fz <= 0 || Fz0 <= 0) return 0;
  const r = Fz / Fz0;
  const f = clamp(1 - k * (r - 1), TYRE.muMin, TYRE.muMax);
  return mu0 * f;
}

/**
 * Evaluate combined-slip forces for one tyre.
 *
 * @param {object} o
 *   kappa      longitudinal slip ratio (relaxed)
 *   alpha      slip angle in radians (relaxed)
 *   Fz         vertical load, N (>= 0)
 *   Fz0        nominal load, N
 *   mu0        nominal peak friction
 *   camber     camber angle, rad (+ = top of wheel leans right)
 *   feel       surfaceFeel() record
 *   out        { fx, fy, combined, saturation }
 */
export function tyreForce(o, out) {
  const T = TYRE;
  const Fz = Math.max(0, o.Fz);
  if (Fz < 1) {
    out.fx = 0;
    out.fy = 0;
    out.combined = 0;
    out.saturation = 0;
    return out;
  }
  const feel = o.feel || SURFACE_FEEL.asphalt;
  const mu = loadSensitiveMu(o.mu0, Fz, o.Fz0);

  // normalised slips — the combined-slip trick
  const kp = T.kappaPeak * feel.peakScale;
  const ap = T.alphaPeak * feel.peakScale;
  const sx = o.kappa / kp;
  const sy = Math.tan(clamp(o.alpha, -1.35, 1.35)) / ap;
  const s = Math.hypot(sx, sy);

  let fx = 0;
  let fy = 0;
  let n = 0;
  if (s > 1e-6) {
    // Blend the two shape factors by which axis dominates, so a pure-longitudinal slide keeps
    // the sharper drive curve and a pure-lateral slide keeps the softer cornering curve.
    const w = (sx * sx) / (s * s);
    const C = T.Cx * w + T.Cy * (1 - w);
    const E = T.Ex * w + T.Ey * (1 - w);
    n = magicN(s, C, E);
    // tail: never fall below the sliding floor, so a spinning wheel still does something
    const floor = T.slideFloor * feel.tail;
    if (s > 1) n = Math.max(n, floor * Math.min(1, 1 / (0.55 + 0.45 * s)) + floor * 0.35);
    const F = mu * Fz * n;
    const inv = 1 / s;
    fx = F * sx * inv;
    fy = -F * sy * inv * T.latScale;
  }

  // Camber thrust. It points in the direction the wheel LEANS, so body roll — which leans the
  // loaded outside wheel away from the corner — costs you grip. That is roll camber loss, and
  // it is why anti-roll bars make a car turn better.
  if (o.camber) {
    fy += T.camberStiffness * Fz * clamp(o.camber, -0.25, 0.25) * mu;
  }

  // hard ellipse guard: nothing may ever exceed mu*Fz*1.05
  const cap = mu * Fz * 1.05;
  const mag = Math.hypot(fx, fy);
  if (mag > cap && mag > 1e-6) {
    const k = cap / mag;
    fx *= k;
    fy *= k;
  }

  out.fx = fx;
  out.fy = fy;
  out.combined = Math.hypot(fx, fy);
  out.saturation = Math.min(2.5, s);
  out.mu = mu;
  return out;
}

/**
 * First-order relaxation of a slip quantity.
 * The tyre carcass needs to roll a relaxation length before the force is fully developed.
 * Below walking pace the length-based constant blows up, so we blend to a fixed fast filter.
 */
export function relax(current, target, speed, length, dt) {
  const v = Math.abs(speed);
  const rate = v > 0.5 ? v / Math.max(length, 0.05) : 12;
  const a = 1 - Math.exp(-clamp(rate, 0, 400) * dt);
  const next = current + (target - current) * a;
  return Number.isFinite(next) ? next : target;
}

/** Rolling resistance force magnitude for a loaded wheel. */
export function rollingResistance(Fz, speed, feel) {
  const crr = 0.0125 * (feel?.roll ?? 1);
  return Fz * crr * (1 + Math.min(Math.abs(speed), 100) * 0.004);
}
