/**
 * Small pure helpers shared by the race lane. No three.js, no allocation in the hot paths.
 *
 * Everything here works in *arc length along the circuit* (metres), because that is the only
 * coordinate in which "who is ahead" and "how far to the corner" are meaningful on a closed loop.
 */

/** Shortest signed difference `a - b` on a loop of length L, wrapped into [-L/2, +L/2]. */
export function arcDelta(a, b, L) {
  let d = (a - b) % L;
  if (d > L * 0.5) d -= L;
  else if (d < -L * 0.5) d += L;
  return d;
}

/** Forward distance you must travel from `b` to reach `a`, in [0, L). */
export function arcAhead(a, b, L) {
  let d = (a - b) % L;
  if (d < 0) d += L;
  return d;
}

/** Wrap a lap fraction into [0,1). */
export function wrap01(t) {
  let x = t % 1;
  if (x < 0) x += 1;
  return x;
}

/**
 * A projection record with the same shape `Track.project()` writes.
 * Every caller that needs to hold a projection across another `project()` call owns one of these
 * (the Track hands out a single shared scratch object otherwise — see CONTRACTS.md §7).
 */
export function makeProj() {
  return {
    t: 0,
    s: 0,
    index: 0,
    u: 0,
    lateral: 0,
    width: 0,
    onTrack: false,
    height: 0,
    distance: 0,
  };
}

/** Deterministic, C1-continuous 1D wobble. Used for per-driver "hands" noise. */
export function wobble(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n) => {
    let t = Math.imul(n + seed * 7919, 374761393);
    t = (t << 13) ^ t;
    return 1 - ((t * (t * t * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * u;
}

/** mm:ss.cc — used by the results table and by the harness. */
export function fmtLap(t) {
  if (!Number.isFinite(t) || t <= 0) return '--:--.--';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}
