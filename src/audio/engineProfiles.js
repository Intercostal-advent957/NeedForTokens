/**
 * Engine acoustic profiles — firing orders, bank layout, resonator banks, turbo character.
 *
 * A profile is *physical*, not a list of magic numbers: cylinders are listed at their real crank
 * angles across a 720° four-stroke cycle and grouped into exhaust banks. The waveform synthesiser
 * (dsp.buildEngineWave) turns that directly into a spectrum, so a cross-plane V8 (uneven per-bank
 * firing) gains half-order energy and burbles, while a flat-plane V8 (even per-bank firing) does
 * not and screams. Nothing is hand-drawn.
 */

/** Even firing angles across the 720° cycle for `n` cylinders. */
const even = (n) => Array.from({ length: n }, (_, i) => (i * 720) / n);

/** Assign alternate banks (typical of a V engine with a flat-plane crank). */
const alternate = (angles) => angles.map((angle, i) => ({ angle, bank: i % 2 ? 'r' : 'l' }));

const single = (angles) => angles.map((angle) => ({ angle, bank: 'l' }));

/* ---------------------------------------------------------- firing layouts */

const LAYOUTS = {
  i3: { cylinders: single(even(3)), banks: { l: { gain: 1 } } },
  i4: { cylinders: single(even(4)), banks: { l: { gain: 1 } } },
  i5: { cylinders: single(even(5)), banks: { l: { gain: 1 } } },
  i6: { cylinders: single(even(6)), banks: { l: { gain: 1 } } },

  // Boxer 6: banks alternate, so each bank fires 240°/120°/360° — the classic uneven warble.
  flat6: {
    cylinders: [
      { angle: 0, bank: 'l' }, { angle: 120, bank: 'r' }, { angle: 240, bank: 'l' },
      { angle: 360, bank: 'r' }, { angle: 480, bank: 'l' }, { angle: 600, bank: 'r' },
    ],
    banks: { l: { gain: 1.0, tauScale: 1.0 }, r: { gain: 0.7, tauScale: 1.3, delay: 0.022 } },
  },

  // Cross-plane V8. Combined firing is perfectly even at 90°, but each bank sees 90/180/90/270 —
  // the resulting half-order content IS the American V8 lope. Unequal bank gain/length exaggerates it.
  v8cross: {
    cylinders: [
      { angle: 0, bank: 'l' }, { angle: 90, bank: 'r' }, { angle: 180, bank: 'r' },
      { angle: 270, bank: 'l' }, { angle: 360, bank: 'r' }, { angle: 450, bank: 'l' },
      { angle: 540, bank: 'l' }, { angle: 630, bank: 'r' },
    ],
    banks: {
      l: { gain: 1.0, tauScale: 1.0, delay: 0 },
      r: { gain: 0.72, tauScale: 1.32, delay: 0.026 },
    },
  },

  // Flat-plane V8: each bank fires evenly at 180°, combined at 90°. The banks cancel at every
  // half-order, so there is no burble at all — just a hard, high 4th-order shriek.
  v8flat: {
    cylinders: alternate(even(8)),
    banks: { l: { gain: 1.0, tauScale: 1.0 }, r: { gain: 0.985, tauScale: 1.015 } },
  },

  v10: { cylinders: alternate(even(10)), banks: { l: { gain: 1 }, r: { gain: 0.95, tauScale: 1.04 } } },
  v12: { cylinders: alternate(even(12)), banks: { l: { gain: 1 }, r: { gain: 0.97, tauScale: 1.02 } } },
};

/* --------------------------------------------------------------- profiles */

/**
 * Each profile supplies:
 *  layout      — firing geometry (above)
 *  wave        — τ (pulse) endpoints for idle / cruise / power / overrun, + knee & tilt
 *  resonators  — peaking filters modelling exhaust standing waves, airbox and body boom.
 *                `track` > 0 makes a peak follow rpm (a rotating-order resonance, e.g. gear whine).
 *  muffler     — lowpass sweep range with load (butterfly valve behaviour)
 *  rasp        — broadband intake/turbulence layer
 *  turbo       — null for NA
 *  gain        — voice trim
 */
export const ENGINE_PROFILES = {
  /** Cross-plane V8 muscle: lopey idle, deep chest, lazy top end. */
  v8muscle: {
    layout: 'v8cross',
    wave: {
      idle: { tauDecay: 0.1, tauAttack: 0.042, knee: 34, tilt: 0.0, rough: 0.5 },
      cruise: { tauDecay: 0.075, tauAttack: 0.022, knee: 54, tilt: 0.08, rough: 0.42 },
      power: { tauDecay: 0.055, tauAttack: 0.0105, knee: 88, tilt: 0.2, rough: 0.32 },
      overrun: { tauDecay: 0.125, tauAttack: 0.062, knee: 26, tilt: -0.1, rough: 0.6 },
      scatter: 0.08,
      jitterDeg: 2.2,
    },
    resonators: [
      { f: 68, q: 3.0, g: 6.5 },    // 2.5 m exhaust, 1st mode
      { f: 137, q: 3.6, g: 5.0 },   // 2nd mode
      { f: 214, q: 4.2, g: 3.4 },
      { f: 420, q: 1.5, g: -4.5 },  // muffler notch
      { f: 96, q: 1.1, g: 4.0 },    // cabin boom
    ],
    muffler: { lo: 620, hi: 5200, q: 0.9 },
    rasp: { band: [420, 2600], q: 0.85, gain: 0.14 },
    turbo: null,
    gain: 1.0,
  },

  /** Flat-plane V8, race exhaust: hard, metallic, no burble. */
  v8flatplane: {
    layout: 'v8flat',
    wave: {
      idle: { tauDecay: 0.082, tauAttack: 0.03, knee: 44, tilt: 0.06, rough: 0.42 },
      cruise: { tauDecay: 0.06, tauAttack: 0.0145, knee: 74, tilt: 0.18, rough: 0.34 },
      power: { tauDecay: 0.043, tauAttack: 0.0062, knee: 120, tilt: 0.36, rough: 0.24 },
      overrun: { tauDecay: 0.105, tauAttack: 0.046, knee: 34, tilt: 0.0, rough: 0.55 },
      scatter: 0.022,
      jitterDeg: 0.5,
    },
    resonators: [
      { f: 92, q: 2.6, g: 6.0 },
      { f: 186, q: 3.4, g: 4.5 },
      { f: 690, q: 2.0, g: 3.5 },   // header collector
      { f: 1450, q: 1.5, g: 2.5 },  // straight-pipe bark
      { f: 300, q: 1.2, g: -3.0 },
    ],
    muffler: { lo: 900, hi: 9000, q: 0.75 },
    rasp: { band: [900, 5200], q: 0.7, gain: 0.2 },
    turbo: null,
    gain: 1.0,
  },

  /** V10 screamer: 5th-order wail, very bright, minimal low end. */
  v10screamer: {
    layout: 'v10',
    wave: {
      idle: { tauDecay: 0.07, tauAttack: 0.024, knee: 54, tilt: 0.12, rough: 0.4 },
      cruise: { tauDecay: 0.05, tauAttack: 0.0115, knee: 92, tilt: 0.26, rough: 0.3 },
      power: { tauDecay: 0.037, tauAttack: 0.0051, knee: 148, tilt: 0.5, rough: 0.2 },
      overrun: { tauDecay: 0.09, tauAttack: 0.038, knee: 40, tilt: 0.08, rough: 0.5 },
      scatter: 0.024,
      jitterDeg: 0.5,
    },
    resonators: [
      { f: 118, q: 2.2, g: 3.0 },
      { f: 780, q: 2.2, g: 4.0 },
      { f: 1900, q: 1.8, g: 3.5 },
      { f: 3400, q: 1.4, g: 2.0 },
      { f: 260, q: 1.3, g: -5.0 },
      { f: 2.9, q: 2.4, g: 3.5, track: 2.9 }, // intake-trumpet order that rises with rpm
    ],
    muffler: { lo: 1300, hi: 13000, q: 0.7 },
    rasp: { band: [1600, 7000], q: 0.6, gain: 0.24 },
    turbo: null,
    gain: 0.98,
  },

  /** Turbo I4: buzzy 2nd order, big spool, chuffy BOV. */
  turboI4: {
    layout: 'i4',
    wave: {
      idle: { tauDecay: 0.1, tauAttack: 0.038, knee: 36, tilt: 0.0, rough: 0.5 },
      cruise: { tauDecay: 0.075, tauAttack: 0.02, knee: 60, tilt: 0.14, rough: 0.4 },
      power: { tauDecay: 0.055, tauAttack: 0.0108, knee: 96, tilt: 0.3, rough: 0.3 },
      overrun: { tauDecay: 0.13, tauAttack: 0.06, knee: 28, tilt: -0.15, rough: 0.62 },
      scatter: 0.06,
      jitterDeg: 1.9,
    },
    resonators: [
      { f: 128, q: 3.0, g: 6.5 },
      { f: 255, q: 3.4, g: 4.0 },
      { f: 560, q: 2.2, g: 3.5 },
      { f: 1150, q: 1.8, g: 3.0 },
      { f: 380, q: 1.1, g: -4.0 },
    ],
    muffler: { lo: 700, hi: 7000, q: 0.85 },
    rasp: { band: [700, 4200], q: 0.8, gain: 0.19 },
    turbo: { whineLo: 1700, whineHi: 8200, whineGain: 0.1, spoolUp: 0.9, spoolDown: 2.6, bov: 1.0 },
    gain: 0.95,
  },

  /** Turbo I6: silky 3rd order, long spool, sonorous. */
  turboI6: {
    layout: 'i6',
    wave: {
      idle: { tauDecay: 0.088, tauAttack: 0.033, knee: 40, tilt: 0.04, rough: 0.42 },
      cruise: { tauDecay: 0.066, tauAttack: 0.0175, knee: 66, tilt: 0.16, rough: 0.34 },
      power: { tauDecay: 0.05, tauAttack: 0.009, knee: 108, tilt: 0.3, rough: 0.26 },
      overrun: { tauDecay: 0.115, tauAttack: 0.052, knee: 30, tilt: -0.1, rough: 0.56 },
      scatter: 0.035,
      jitterDeg: 0.9,
    },
    resonators: [
      { f: 84, q: 2.8, g: 6.0 },
      { f: 172, q: 3.2, g: 4.2 },
      { f: 640, q: 2.0, g: 3.5 },
      { f: 1750, q: 1.5, g: 3.2 },
      { f: 330, q: 1.2, g: -3.5 },
    ],
    muffler: { lo: 780, hi: 8200, q: 0.8 },
    rasp: { band: [800, 4600], q: 0.75, gain: 0.17 },
    turbo: { whineLo: 1400, whineHi: 7200, whineGain: 0.12, spoolUp: 1.15, spoolDown: 2.2, bov: 0.85 },
    gain: 0.97,
  },

  /** Warm NA flat-6 — reserved for roster growth; the boxer warble comes free from the layout. */
  flat6na: {
    layout: 'flat6',
    wave: {
      idle: { tauDecay: 0.09, tauAttack: 0.034, knee: 42, tilt: 0.04, rough: 0.46 },
      cruise: { tauDecay: 0.068, tauAttack: 0.018, knee: 68, tilt: 0.18, rough: 0.36 },
      power: { tauDecay: 0.052, tauAttack: 0.0092, knee: 112, tilt: 0.34, rough: 0.26 },
      overrun: { tauDecay: 0.118, tauAttack: 0.054, knee: 32, tilt: -0.05, rough: 0.58 },
      scatter: 0.055,
      jitterDeg: 1.3,
    },
    resonators: [
      { f: 104, q: 2.6, g: 5.5 }, { f: 208, q: 3.0, g: 4.0 },
      { f: 820, q: 2.0, g: 3.5 }, { f: 2100, q: 1.5, g: 2.2 }, { f: 340, q: 1.2, g: -3.5 },
    ],
    muffler: { lo: 820, hi: 9000, q: 0.78 },
    rasp: { band: [1000, 5000], q: 0.7, gain: 0.2 },
    turbo: null,
    gain: 0.98,
  },

  /**
   * EV. No combustion at all: the voice is a rotating-order set (motor pole-pair whine + reduction
   * gear mesh) plus inverter switching sidebands. The "wave" here is a sparse harmonic comb, which
   * is exactly what a PWM inverter driving a helical reduction gear sounds like.
   */
  ev: {
    layout: 'ev',
    ev: {
      // orders relative to motor revolutions; motor spins ~8-9x wheel speed
      orders: [
        { n: 1, g: 0.07 }, { n: 2, g: 0.05 },
        { n: 8, g: 0.7 },    // reduction-gear mesh — the whine you actually hear
        { n: 16, g: 0.56 }, { n: 24, g: 0.34 }, { n: 32, g: 0.2 },
        { n: 12, g: 0.28 },  // motor pole pairs
        { n: 36, g: 0.16 }, { n: 48, g: 0.09 },
      ],
      switching: 3400, // inverter carrier, drifts with load
    },
    wave: { scatter: 0.02, jitterDeg: 0 },
    hpf: 190,
    resonators: [
      { f: 1200, q: 2.4, g: 4.0 },
      { f: 3100, q: 2.0, g: 3.5 },
      { f: 6200, q: 1.4, g: 2.5 },
      { f: 260, q: 1.0, g: -7.0 },
    ],
    muffler: { lo: 3600, hi: 16000, q: 0.6 },
    rasp: { band: [3200, 11000], q: 0.9, gain: 0.075 },
    turbo: null,
    gain: 0.82,
  },
};

/** Resolve a firing layout by name. */
export function getLayout(name) {
  return LAYOUTS[name] ?? LAYOUTS.i4;
}

/**
 * Map a CarDef to a profile. Explicit per-id assignments for the shipped roster; everything else
 * is inferred from the def so cars added by the car-art lane still sound sane.
 */
const BY_ID = {
  'apex-gt': 'v8flatplane',   // 640 hp / 8600 rpm AWD hypercar — hard flat-plane bark
  nocturne: 'v10screamer',    // 9200 rpm RWD — the screamer of the roster
  vantablack: 'v8muscle',     // "PHANTOM V8", 7200 rpm — cross-plane lope
  zenith: 'turboI6',          // "ZENITH TURBO" AWD — sonorous straight six
  volt: 'ev',                 // "VOLT SPEC-E" — 14000 rpm, single ratio, idle 0
  ember: 'turboI4',           // 340 hp FWD hot hatch
};

export function profileForCar(def) {
  if (!def) return ENGINE_PROFILES.turboI4;
  const explicit = BY_ID[def.id];
  if (explicit && ENGINE_PROFILES[explicit]) return ENGINE_PROFILES[explicit];

  // --- inference fallback ---
  const redline = def.redline ?? 7000;
  const power = def.power ?? 300;
  const gears = def.gearRatios?.length ?? 6;
  if ((def.idleRpm ?? 800) <= 1 || (gears <= 1 && redline > 10000)) return ENGINE_PROFILES.ev;
  if (redline >= 8800 && power >= 500) return ENGINE_PROFILES.v10screamer;
  if (power >= 560) return ENGINE_PROFILES.v8flatplane;
  if (redline <= 7400 && power >= 420) return ENGINE_PROFILES.v8muscle;
  if (power >= 400) return ENGINE_PROFILES.turboI6;
  return ENGINE_PROFILES.turboI4;
}

/** Human-readable archetype id, used by the self-test report. */
export function profileNameForCar(def) {
  const p = profileForCar(def);
  return Object.keys(ENGINE_PROFILES).find((k) => ENGINE_PROFILES[k] === p) ?? 'unknown';
}
