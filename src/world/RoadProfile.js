/**
 * The road cross-section, in one place.
 *
 * The mesh builder, the barrier builder and `sampleGround` all derive from this file. That is
 * not tidiness for its own sake: if the collision height disagrees with the rendered height by
 * even a couple of centimetres the car buzzes, and if the barrier visual disagrees with the
 * barrier segment you get invisible walls. One source of truth, three consumers.
 *
 * All lateral values are METRES from the centreline (+ = right). All `dy` values are metres
 * relative to the banked centreline plane, so world height = centre.y + up.y*dy + right.y*lateral.
 */

export const CAMBER = 0.022; // 2.2% crown — water runs to the gutters
export const KERB_RAMP = 0.20; // horizontal run of the kerb's sloped inner face
export const KERB_LIP = 0.12; // outer drop from kerb top down to the shoulder
export const KERB_LIP_DROP = 0.045;
export const SHOULDER_W = 2.6;
export const SHOULDER_DROP = 0.13;
export const RUNOFF_DIP = 0.03;
export const RUNOFF_RISE = 0.30; // run-off climbs to the barrier plinth
export const VERGE_RISE = 2.2;
export const VERGE_W = 13;

/** Reusable profile record. One per caller — never share across threads of control. */
export function makeProfile() {
  return {
    W: 9, kL: 0, kR: 0, kwL: 0.85, kwR: 0.85, roL: 9, roR: 9,
    edge: 0, shL: 0, shR: 0, soL: 0, soR: 0, barL: 0, barR: 0,
    typeL: 0, typeR: 0, style: 0, tunnel: 0,
  };
}

/** Fill `out` with the cross-section parameters at baked sample index `i`. Allocation-free. */
export function profileAt(track, i, out) {
  const f = track.features;
  const W = track._width[i];
  const kwL = Math.max(0.85, f.kerbWL[i]);
  const kwR = Math.max(0.85, f.kerbWR[i]);
  out.W = W;
  out.kL = f.kerbL[i];
  out.kR = f.kerbR[i];
  out.kwL = kwL;
  out.kwR = kwR;
  out.roL = f.runoffW[i * 2];
  out.roR = f.runoffW[i * 2 + 1];
  out.edge = -CAMBER * W;
  out.shL = W + kwL + KERB_LIP;
  out.shR = W + kwR + KERB_LIP;
  out.soL = out.shL + SHOULDER_W;
  out.soR = out.shR + SHOULDER_W;
  out.barL = out.soL + out.roL;
  out.barR = out.soR + out.roR;
  out.typeL = f.runoffType[i * 2];
  out.typeR = f.runoffType[i * 2 + 1];
  out.style = f.kerbStyle[i];
  out.tunnel = f.tunnel[i];
  return out;
}

/** Interpolate a profile between two baked samples (for continuous ground height). */
export function lerpProfile(a, b, u, out) {
  const l = (x, y) => x + (y - x) * u;
  out.W = l(a.W, b.W);
  out.kL = l(a.kL, b.kL);
  out.kR = l(a.kR, b.kR);
  out.kwL = l(a.kwL, b.kwL);
  out.kwR = l(a.kwR, b.kwR);
  out.roL = l(a.roL, b.roL);
  out.roR = l(a.roR, b.roR);
  out.edge = l(a.edge, b.edge);
  out.shL = l(a.shL, b.shL);
  out.shR = l(a.shR, b.shR);
  out.soL = l(a.soL, b.soL);
  out.soR = l(a.soR, b.soR);
  out.barL = l(a.barL, b.barL);
  out.barR = l(a.barR, b.barR);
  out.typeL = u < 0.5 ? a.typeL : b.typeL;
  out.typeR = u < 0.5 ? a.typeR : b.typeR;
  out.style = u < 0.5 ? a.style : b.style;
  out.tunnel = l(a.tunnel, b.tunnel);
  return out;
}

/**
 * Height of the road surface at lateral offset `x`, relative to the banked centreline plane.
 * This is the function the physics feels. It is piecewise-linear outside the road and quadratic
 * (the crown) inside it, and it matches the rendered mesh station-for-station.
 */
export function surfaceDy(p, x) {
  const ax = Math.abs(x);
  const W = p.W;
  const right = x >= 0;
  const k = right ? p.kR : p.kL;
  const kw = right ? p.kwR : p.kwL;
  const sh = right ? p.shR : p.shL;
  const so = right ? p.soR : p.soL;
  const bar = right ? p.barR : p.barL;
  const edge = p.edge;

  if (ax <= W) {
    const u = ax / W;
    return -CAMBER * W * u * u; // the crown
  }
  if (ax <= W + KERB_RAMP) {
    // sloped inner kerb face — ~20 deg, rideable
    return edge + k * ((ax - W) / KERB_RAMP);
  }
  if (ax <= W + kw) return edge + k; // kerb top
  if (ax <= sh) {
    const u = (ax - (W + kw)) / Math.max(1e-4, sh - (W + kw));
    return edge + k + (-KERB_LIP_DROP - k) * u; // drop off the back of the kerb
  }
  if (ax <= so) {
    const u = (ax - sh) / SHOULDER_W;
    return edge - KERB_LIP_DROP + (-SHOULDER_DROP + KERB_LIP_DROP) * u; // asphalt shoulder
  }
  const ro = Math.max(1e-3, bar - so);
  if (ax <= so + ro * 0.4) {
    const u = (ax - so) / (ro * 0.4);
    return edge - SHOULDER_DROP - RUNOFF_DIP * u; // run-off dips then climbs away
  }
  if (ax <= bar) {
    const u = (ax - (so + ro * 0.4)) / (ro * 0.6);
    return edge - SHOULDER_DROP - RUNOFF_DIP + (RUNOFF_RISE + RUNOFF_DIP) * u;
  }
  const u = Math.min(1, (ax - bar) / VERGE_W);
  return edge - SHOULDER_DROP + RUNOFF_RISE + VERGE_RISE * u; // embankment behind the barrier
}

/**
 * d(surfaceDy)/dx — the lateral slope, signed with respect to `x`. The ground normal is
 * `normalize(up - right * slope)`, which is what gives the crown its drainage tilt and lets the
 * car actually feel a kerb lift a wheel.
 */
export function surfaceSlope(p, x) {
  const ax = Math.abs(x);
  const sg = x >= 0 ? 1 : -1;
  const W = p.W;
  const right = x >= 0;
  const k = right ? p.kR : p.kL;
  const kw = right ? p.kwR : p.kwL;
  const sh = right ? p.shR : p.shL;
  const so = right ? p.soR : p.soL;
  const bar = right ? p.barR : p.barL;

  if (ax <= W) return (-2 * CAMBER * x) / W; // already signed
  if (ax <= W + KERB_RAMP) return (sg * k) / KERB_RAMP;
  if (ax <= W + kw) return 0;
  if (ax <= sh) return (sg * (-KERB_LIP_DROP - k)) / Math.max(1e-4, sh - (W + kw));
  if (ax <= so) return (sg * (-SHOULDER_DROP + KERB_LIP_DROP)) / SHOULDER_W;
  const ro = Math.max(1e-3, bar - so);
  if (ax <= so + ro * 0.4) return (sg * -RUNOFF_DIP) / (ro * 0.4);
  if (ax <= bar) return (sg * (RUNOFF_RISE + RUNOFF_DIP)) / (ro * 0.6);
  if (ax <= bar + VERGE_W) return (sg * VERGE_RISE) / VERGE_W;
  return 0;
}

/** Surface id + grip at lateral offset `x`. Kept branch-light; called ~8000x/second. */
export const SURFACES = {
  asphalt: { surface: 'asphalt', grip: 1.0 },
  worn: { surface: 'asphalt', grip: 0.96 },
  curb: { surface: 'curb', grip: 0.88 },
  shoulder: { surface: 'concrete', grip: 0.82 },
  gravel: { surface: 'dirt', grip: 0.46 },
  grass: { surface: 'grass', grip: 0.38 },
  // City hardstanding: the ground BETWEEN the buildings — concrete slab, service road, parking
  // lot, paved plaza. Not part of the cross-section, so `bandAt` never returns it; it is what
  // `sampleGround` answers with outside the corridor wherever the terrain bakes as built-up.
  // Dusty and jointed rather than laid for grip: a shade under asphalt, nowhere near turf.
  hardstanding: { surface: 'concrete', grip: 0.87 },
};

export function bandAt(p, x) {
  const ax = Math.abs(x);
  const right = x >= 0;
  const k = right ? p.kR : p.kL;
  const kw = right ? p.kwR : p.kwL;
  const sh = right ? p.shR : p.shL;
  const so = right ? p.soR : p.soL;
  if (ax <= p.W - 0.35) return SURFACES.asphalt;
  if (ax <= p.W) return SURFACES.worn; // the painted edge line, marginally slicker
  if (ax <= sh) return k > 0.012 ? SURFACES.curb : SURFACES.shoulder;
  if (ax <= so) return SURFACES.shoulder;
  return (right ? p.typeR : p.typeL) > 0.5 ? SURFACES.gravel : SURFACES.grass;
}

/**
 * Band id per cross-section station, left to right. Ordered so the shader can test ranges:
 *   0 road · 1 shoulder · 2 kerb · 3 run-off · 4 verge
 * (`band < 1.5` is the asphalt family, `< 2.5` is kerb, the rest is ground.)
 * Duplicated offsets in `crossSection` are hard material seams, so paint stops dead at the kerb
 * instead of smearing over it.
 */
export const BAND_LAYOUT = [
  4, 4, 3, 3, 3, 1, 1, 2, 2, 2, 2,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  2, 2, 2, 2, 1, 1, 3, 3, 3, 4, 4,
];
export const M = BAND_LAYOUT.length; // 31
export const CENTRE_STATION = 15;

export function crossSection(off, dy, p) {
  const e = p.edge;
  off[0] = -(p.barL + VERGE_W); dy[0] = e - SHOULDER_DROP + RUNOFF_RISE + VERGE_RISE;
  off[1] = -p.barL;             dy[1] = e - SHOULDER_DROP + RUNOFF_RISE;
  off[2] = off[1];              dy[2] = dy[1];
  off[3] = -(p.soL + (p.barL - p.soL) * 0.4); dy[3] = e - SHOULDER_DROP - RUNOFF_DIP;
  off[4] = -p.soL;              dy[4] = e - SHOULDER_DROP;
  off[5] = off[4];              dy[5] = dy[4];
  off[6] = -p.shL;              dy[6] = e - KERB_LIP_DROP;
  off[7] = off[6];              dy[7] = dy[6];
  off[8] = -(p.W + p.kwL);      dy[8] = e + p.kL;
  off[9] = -(p.W + KERB_RAMP);  dy[9] = e + p.kL;
  off[10] = -p.W;               dy[10] = e;
  off[11] = -p.W;               dy[11] = e;
  off[12] = -p.W * 0.66;        dy[12] = -CAMBER * p.W * 0.4356;
  off[13] = -p.W * 0.33;        dy[13] = -CAMBER * p.W * 0.1089;
  off[14] = -p.W * 0.12;        dy[14] = -CAMBER * p.W * 0.0144;
  off[15] = 0;                  dy[15] = 0;
  off[16] = p.W * 0.12;         dy[16] = dy[14];
  off[17] = p.W * 0.33;         dy[17] = dy[13];
  off[18] = p.W * 0.66;         dy[18] = dy[12];
  off[19] = p.W;                dy[19] = e;
  off[20] = p.W;                dy[20] = e;
  off[21] = p.W + KERB_RAMP;    dy[21] = e + p.kR;
  off[22] = p.W + p.kwR;        dy[22] = e + p.kR;
  off[23] = p.shR;              dy[23] = e - KERB_LIP_DROP;
  off[24] = off[23];            dy[24] = dy[23];
  off[25] = p.soR;              dy[25] = e - SHOULDER_DROP;
  off[26] = off[25];            dy[26] = dy[25];
  off[27] = p.soR + (p.barR - p.soR) * 0.4; dy[27] = e - SHOULDER_DROP - RUNOFF_DIP;
  off[28] = p.barR;             dy[28] = e - SHOULDER_DROP + RUNOFF_RISE;
  off[29] = off[28];            dy[29] = dy[28];
  off[30] = p.barR + VERGE_W;   dy[30] = e - SHOULDER_DROP + RUNOFF_RISE + VERGE_RISE;
}
