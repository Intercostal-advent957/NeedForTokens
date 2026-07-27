/**
 * Headless audio verification. Renders the real synthesis graph into an OfflineAudioContext and
 * asserts on the actual samples — level, clipping, and spectrum.
 *
 * This file is only ever loaded on demand by `src/audio/selftest.mjs` (`await import(...)` from the
 * dev server); nothing in the game imports it, so it never reaches a production bundle.
 *
 * Run:  node src/audio/selftest.mjs
 */
import { AudioSystem } from './AudioSystem.js';
import { EngineVoice } from './EngineVoice.js';
import { CAR_DEFS } from '../vehicle/carDefs.js';
import { profileNameForCar } from './engineProfiles.js';

const SR = 48000;

/* ------------------------------------------------------------------- FFT */

/** In-place iterative radix-2 Cooley–Tukey. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Averaged magnitude spectrum (Welch, Hann window) over a sample window. */
function spectrum(data, start, end, N = 16384) {
  const mag = new Float64Array(N / 2);
  const hop = N / 2;
  let frames = 0;
  for (let off = start; off + N <= end; off += hop) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = data[off + i] * w;
    }
    fft(re, im);
    for (let i = 0; i < N / 2; i++) mag[i] += Math.hypot(re[i], im[i]);
    frames++;
  }
  if (frames) for (let i = 0; i < mag.length; i++) mag[i] /= frames;
  return { mag, N, frames };
}

const binHz = (N) => SR / N;

/** Peak bin with parabolic interpolation, restricted to [fMin, fMax]. */
function dominant(mag, N, fMin = 40, fMax = 6000) {
  const df = binHz(N);
  const lo = Math.max(1, Math.floor(fMin / df));
  const hi = Math.min(mag.length - 2, Math.ceil(fMax / df));
  let bi = lo;
  for (let i = lo; i <= hi; i++) if (mag[i] > mag[bi]) bi = i;
  const a = mag[bi - 1];
  const b = mag[bi];
  const c = mag[bi + 1];
  const d = a - 2 * b + c;
  const frac = d !== 0 ? (0.5 * (a - c)) / d : 0;
  return { freq: (bi + frac) * df, bin: bi, mag: b };
}

function centroid(mag, N, fMin = 60, fMax = 12000) {
  const df = binHz(N);
  let num = 0;
  let den = 0;
  for (let i = Math.floor(fMin / df); i < Math.min(mag.length, fMax / df); i++) {
    num += i * df * mag[i];
    den += mag[i];
  }
  return den > 0 ? num / den : 0;
}

/** Energy in a narrow band around `f` (±3 bins), used to read individual engine orders. */
function bandEnergy(mag, N, f, halfBins = 3) {
  const df = binHz(N);
  const c = Math.round(f / df);
  let e = 0;
  for (let i = Math.max(0, c - halfBins); i <= Math.min(mag.length - 1, c + halfBins); i++) e += mag[i] * mag[i];
  return e;
}

/**
 * TONAL energy at `f`: the peak in ±2 bins minus the local broadband floor (median of the
 * surrounding ±(6…28) bins). Without the floor subtraction the rasp/noise layer swamps everything
 * and every engine looks alike.
 */
function tonalEnergy(mag, N, f) {
  const df = binHz(N);
  const c = Math.round(f / df);
  if (c < 8 || c + 28 >= mag.length) return 0;
  let peak = 0;
  for (let i = c - 2; i <= c + 2; i++) peak = Math.max(peak, mag[i]);
  const around = [];
  for (let i = c - 28; i <= c + 28; i++) if (Math.abs(i - c) > 5) around.push(mag[i]);
  around.sort((a, b) => a - b);
  const floor = around[Math.floor(around.length / 2)] || 0;
  const v = Math.max(0, peak - floor);
  return v * v;
}

/** Peak within ±tol of a predicted frequency — used to follow a specific engine order. */
function trackPartial(mag, N, fPredicted, tol = 0.12) {
  const df = binHz(N);
  const lo = Math.max(1, Math.floor((fPredicted * (1 - tol)) / df));
  const hi = Math.min(mag.length - 2, Math.ceil((fPredicted * (1 + tol)) / df));
  let bi = lo;
  for (let i = lo; i <= hi; i++) if (mag[i] > mag[bi]) bi = i;
  const a = mag[bi - 1];
  const b = mag[bi];
  const c = mag[bi + 1];
  const d = a - 2 * b + c;
  const frac = d !== 0 ? (0.5 * (a - c)) / d : 0;
  return { freq: (bi + frac) * df, mag: b };
}

function levels(chData) {
  let peak = 0;
  let sum = 0;
  let clipped = 0;
  const n = chData[0].length;
  for (const d of chData) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      sum += d[i] * d[i];
    }
  }
  const rms = Math.sqrt(sum / (n * chData.length));
  return { peak, rms, clipped, dbPeak: 20 * Math.log10(peak || 1e-9), dbRms: 20 * Math.log10(rms || 1e-9) };
}

/* --------------------------------------------------------------- renderers */

/**
 * Render one EngineVoice through a representative master chain, driven by a scripted
 * VehicleState timeline. Returns the mono-summed buffer plus the schedule map.
 */
async function renderEngine(def, timeline, seconds, opts = {}) {
  const oac = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
  const out = oac.createGain();
  out.gain.value = 0.6;
  out.connect(oac.destination);

  const voice = new EngineVoice(oac, def, {
    dest: out,
    harmonics: opts.harmonics ?? 240,
    startTime: 0,
  });

  const dt = 1 / 120;
  for (let i = 0; i * dt < seconds; i++) {
    const t = i * dt;
    const s = timeline(t);
    if (!s) continue;
    voice.update(s, t, { dt, gain: 1 });
  }
  const buf = await oac.startRendering();
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) * 0.5;
  return { mono, buf, channels: [L, R] };
}

const fakeWheel = (surface = 'asphalt') => ({
  contact: true,
  surface,
  grip: 1,
  compression: 0.5,
  slipRatio: 0,
  slipAngle: 0,
  slipSpeed: 0,
  load: 3600,
  lockedUp: false,
  spinningUp: false,
});

const fakeState = (o = {}) => ({
  rpm: 4000,
  gear: 3,
  engineLoad: 0.8,
  throttle: 1,
  brake: 0,
  speed: 45,
  speedKmh: 162,
  nosActive: false,
  airborne: false,
  wheels: [fakeWheel(), fakeWheel(), fakeWheel(), fakeWheel()],
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  ...o,
});

/* ------------------------------------------------------------------- tests */

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  return pass;
}

/** A: full mix — every subsystem live, driven by real captured VehicleStates. */
async function testFullMix(frames, seconds) {
  const oac = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
  const def = frames[0]?.def ?? CAR_DEFS[0];
  const fauxCtx = {
    bus: { on: () => () => {} },
    cars: { player: { def, state: null }, instances: [] },
    settings: { tier: 'high' },
    camera: null,
  };
  const audio = new AudioSystem(fauxCtx);
  audio.attachContext(oac, { tier: 'high', def });

  const dt = 1 / 60;
  for (let i = 0; i < frames.length && i * dt < seconds; i++) {
    const f = frames[i];
    const st = { ...f.state, wheels: f.state.wheels };
    fauxCtx.cars.player.state = st;
    audio.offlineTime = i * dt;
    // exercise the event paths too
    if (i === 40) audio._onCountdown({ n: 3 });
    if (i === 120) audio._onStart();
    if (f.shift) audio._onShift({ car: fauxCtx.cars.player, up: true });
    if (f.collision) audio._onCollision({ car: fauxCtx.cars.player, impulse: f.collision, tag: 'barrier' });
    if (f.land) audio._onLand({ car: fauxCtx.cars.player, impact: f.land });
    audio.update(dt, fauxCtx);
  }
  const buf = await oac.startRendering();
  const ch = [buf.getChannelData(0), buf.getChannelData(1)];
  const lv = levels(ch);

  check('full mix does not clip', lv.clipped === 0, `${lv.clipped} samples at/over full scale`);
  check('full mix peak in range', lv.peak > 0.08 && lv.peak < 0.995, `peak ${lv.peak.toFixed(3)} (${lv.dbPeak.toFixed(1)} dBFS)`);
  check(
    'full mix RMS in range',
    lv.dbRms > -32 && lv.dbRms < -9,
    `rms ${lv.rms.toFixed(4)} (${lv.dbRms.toFixed(1)} dBFS)`
  );
  const half = Math.floor(ch[0].length / 2);
  let diff = 0;
  for (let i = 0; i < half; i++) diff += Math.abs(ch[0][i] - ch[1][i]);
  check('mix is stereo (channels decorrelated)', diff / half > 1e-4, `mean |L-R| = ${(diff / half).toFixed(5)}`);
  return lv;
}

/** B: dominant partial must track rpm. */
async function testRpmTracking() {
  const def = CAR_DEFS.find((d) => d.id === 'apex-gt');
  const plateaus = [2200, 3200, 4600, 6400, 8000];
  const hold = 0.9;
  const seconds = plateaus.length * hold;
  const { mono } = await renderEngine(
    def,
    (t) => {
      const i = Math.min(plateaus.length - 1, Math.floor(t / hold));
      return fakeState({ rpm: plateaus[i], engineLoad: 0.8, throttle: 1 });
    },
    seconds
  );

  const CYL = 8;
  const rows = [];
  for (let i = 0; i < plateaus.length; i++) {
    // skip the first 300 ms of each plateau so the ramps have settled
    const start = Math.floor((i * hold + 0.3) * SR);
    const end = Math.floor((i * hold + hold - 0.02) * SR);
    const { mag, N } = spectrum(mono, start, end, 16384);
    const cycleHz = plateaus[i] / 120;
    const firingHz = cycleHz * CYL; // engine order 4 for a V8
    const d = dominant(mag, N, 60, 6000);
    const f = trackPartial(mag, N, firingHz, 0.1);
    rows.push({
      rpm: plateaus[i],
      cycleHz: +cycleHz.toFixed(2),
      firingHz: +firingHz.toFixed(1),
      measuredHz: +f.freq.toFixed(1),
      errPct: +((100 * (f.freq - firingHz)) / firingHz).toFixed(2),
      loudestHz: +d.freq.toFixed(1),
      loudestK: +(d.freq / cycleHz).toFixed(2), // must be an integer: a harmonic of the cycle
      centroidHz: Math.round(centroid(mag, N)),
    });
  }

  const tracks = rows.every((r) => Math.abs(r.errPct) < 3);
  check(
    'firing-order fundamental tracks rpm exactly (<3% error)',
    tracks,
    rows.map((r) => `${r.rpm}rpm: ${r.firingHz}Hz predicted → ${r.measuredHz}Hz (${r.errPct}%)`).join('  ')
  );
  const locked = rows.every((r) => Math.abs(r.loudestK - Math.round(r.loudestK)) < 0.06);
  check(
    'loudest partial is always an exact harmonic of the engine cycle',
    locked,
    rows.map((r) => `${r.rpm}rpm k=${r.loudestK}`).join('  ')
  );
  let rising = true;
  for (let i = 1; i < rows.length; i++) if (rows[i].centroidHz <= rows[i - 1].centroidHz) rising = false;
  check(
    'perceived pitch (spectral centroid) rises with rpm',
    rising,
    rows.map((r) => `${r.rpm}→${r.centroidHz}Hz`).join('  ')
  );
  return rows;
}

/** C: load must measurably change harmonic content at constant rpm. */
async function testLoadTimbre() {
  const def = CAR_DEFS.find((d) => d.id === 'apex-gt');
  const rpm = 5200;
  const cases = [
    { name: 'overrun', throttle: 0.0, engineLoad: 0.0 },
    { name: 'part', throttle: 0.35, engineLoad: 0.3 },
    { name: 'full', throttle: 1.0, engineLoad: 1.0 },
  ];
  const rows = [];
  for (const c of cases) {
    const { mono } = await renderEngine(
      def,
      () => fakeState({ rpm, throttle: c.throttle, engineLoad: c.engineLoad }),
      1.4
    );
    const { mag, N } = spectrum(mono, Math.floor(0.45 * SR), Math.floor(1.35 * SR), 16384);
    const cycleHz = rpm / 120;
    // energy in orders 1..4 vs orders 8..20
    let lowE = 0;
    let highE = 0;
    for (let k = 2; k <= 8; k++) lowE += bandEnergy(mag, N, cycleHz * k);
    for (let k = 16; k <= 40; k++) highE += bandEnergy(mag, N, cycleHz * k);
    rows.push({
      name: c.name,
      centroidHz: Math.round(centroid(mag, N)),
      hiLoRatio: +(highE / (lowE || 1e-12)).toFixed(4),
    });
  }
  const [over, part, full] = rows;
  check(
    'load brightens the spectrum (centroid rises with throttle)',
    full.centroidHz > part.centroidHz && part.centroidHz > over.centroidHz,
    rows.map((r) => `${r.name}=${r.centroidHz}Hz`).join('  ')
  );
  check(
    'on-throttle has materially more upper-harmonic energy than overrun',
    full.hiLoRatio > over.hiLoRatio * 3,
    rows.map((r) => `${r.name} hi/lo=${r.hiLoRatio}`).join('  ')
  );
  return rows;
}

/** D: every car archetype must be spectrally distinct — and the V8s for the right reason. */
async function testCarCharacter() {
  const rows = [];
  for (const def of CAR_DEFS) {
    const rpm = Math.round((def.idleRpm || 0) + ((def.redline ?? 7000) - (def.idleRpm || 0)) * 0.72);
    const { mono } = await renderEngine(def, () => fakeState({ rpm, throttle: 1, engineLoad: 0.95 }), 1.3);
    const { mag, N } = spectrum(mono, Math.floor(0.4 * SR), Math.floor(1.25 * SR), 16384);
    const cycleHz = rpm / 120;
    // Orders 0.5 … 12 in half-order steps: odd k are the half-orders (uneven per-bank firing).
    // Tonal (floor-subtracted) energy only — the broadband rasp layer would otherwise dominate.
    const orders = [];
    let halfE = 0;
    let intE = 0;
    for (let k = 1; k <= 24; k++) {
      const e = tonalEnergy(mag, N, cycleHz * k);
      orders.push(e);
      if (k % 2 === 1) halfE += e;
      else intE += e;
    }
    const total = orders.reduce((a, b) => a + b, 0) || 1e-12;
    rows.push({
      id: def.id,
      profile: profileNameForCar(def),
      rpm,
      centroidHz: Math.round(centroid(mag, N)),
      halfOrderPct: +((100 * halfE) / (halfE + intE)).toFixed(1),
      profileVec: orders.map((e) => e / total),
    });
  }

  // pairwise cosine similarity of the normalised order profiles
  const cos = (a, b) => {
    let d = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      d += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return d / (Math.sqrt(na * nb) || 1e-12);
  };
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      pairs.push({
        a: rows[i].id,
        b: rows[j].id,
        sim: +cos(rows[i].profileVec, rows[j].profileVec).toFixed(3),
      });
    }
  }
  const worst = pairs.reduce((w, p) => (p.sim > w.sim ? p : w), pairs[0]);
  check(
    'all six cars are spectrally distinct (order-profile cosine < 0.97)',
    worst.sim < 0.97,
    `most similar pair: ${worst.a} vs ${worst.b} = ${worst.sim}`
  );

  const cross = rows.find((r) => r.profile === 'v8muscle');
  const flat = rows.find((r) => r.profile === 'v8flatplane');
  if (cross && flat) {
    check(
      'cross-plane V8 has the half-order burble a flat-plane V8 lacks',
      cross.halfOrderPct > flat.halfOrderPct * 1.6,
      `cross-plane ${cross.halfOrderPct}% vs flat-plane ${flat.halfOrderPct}% of firing-order energy`
    );
  }
  const ev = rows.find((r) => r.profile === 'ev');
  if (ev && cross) {
    check(
      'EV sits far above the combustion cars in the spectrum',
      ev.centroidHz > cross.centroidHz * 1.4,
      `ev ${ev.centroidHz} Hz vs v8muscle ${cross.centroidHz} Hz`
    );
  }
  return { rows: rows.map(({ profileVec, ...r }) => r), pairs };
}

/** E: an rpm sweep must be continuous — no zipper/aliasing blowups. */
async function testSweep() {
  const def = CAR_DEFS.find((d) => d.id === 'nocturne');
  const secs = 3.0;
  const { mono, channels } = await renderEngine(
    def,
    (t) => fakeState({ rpm: 1000 + (t / secs) * 8000, throttle: 1, engineLoad: 0.9 }),
    secs
  );
  const lv = levels(channels);
  check('rpm sweep does not clip the voice', lv.peak < 0.999, `peak ${lv.peak.toFixed(3)}`);
  // sample-to-sample discontinuity: catches parameter jumps and NaN
  let maxJump = 0;
  let nans = 0;
  for (let i = 1; i < mono.length; i++) {
    if (!Number.isFinite(mono[i])) nans++;
    const j = Math.abs(mono[i] - mono[i - 1]);
    if (j > maxJump) maxJump = j;
  }
  check('sweep contains no NaN/Inf samples', nans === 0, `${nans} bad samples`);
  check('sweep is free of parameter-jump discontinuities', maxJump < 0.35, `max Δsample ${maxJump.toFixed(4)}`);

  // The firing fundamental (order 5 for a V10) must climb smoothly with the sweep.
  const pts = [];
  const pred = [];
  for (let i = 0; i < 6; i++) {
    const t0 = 0.25 + i * 0.45;
    const { mag, N } = spectrum(mono, Math.floor(t0 * SR), Math.floor((t0 + 0.4) * SR), 8192);
    const rpmAt = 1000 + ((t0 + 0.2) / secs) * 8000;
    const firingHz = (rpmAt / 120) * 10; // 10 cylinders → engine order 5
    pred.push(Math.round(firingHz));
    pts.push(+trackPartial(mag, N, firingHz, 0.09).freq.toFixed(0));
  }
  let monoUp = true;
  for (let i = 1; i < pts.length; i++) if (pts[i] <= pts[i - 1] * 1.02) monoUp = false;
  // The slope is the exact test: each step of the sweep must move the firing order by the
  // predicted amount. The small constant offset below is the deliberate portamento on the
  // oscillator frequency (setTargetAtTime), plus the analysis window's centre-of-mass.
  const dMeas = pts.slice(1).map((v, i) => v - pts[i]);
  const dPred = pred.slice(1).map((v, i) => v - pred[i]);
  const slopeOk = dMeas.every((d, i) => Math.abs(d - dPred[i]) / dPred[i] < 0.06);
  const lagHz = pts.reduce((a, v, i) => a + (pred[i] - v), 0) / pts.length;
  check('sweep pitch rises monotonically', monoUp, `firing order Hz: ${pts.join(' \u2192 ')}`);
  check(
    'sweep slope matches the predicted firing frequency exactly (<6%)',
    slopeOk,
    `\u0394measured ${dMeas.join(',')} Hz vs \u0394predicted ${dPred.join(',')} Hz ` +
      `(constant portamento lag ${lagHz.toFixed(1)} Hz \u2248 ${((lagHz / 10) * 120 / 2667).toFixed(3)} s)`
  );
  return { levels: lv, pts, pred, lagHz: +lagHz.toFixed(1) };
}

/** F: tyres, wind and impacts must actually produce signal and stay bounded. */
async function testLayers() {
  const def = CAR_DEFS[0];
  const out = {};
  // Tyres at the limit
  {
    const oac = new OfflineAudioContext(2, SR * 1.2, SR);
    const g = oac.createGain();
    g.connect(oac.destination);
    const { TyreVoice } = await import('./TyreVoice.js');
    const v = new TyreVoice(oac, { dest: g, startTime: 0 });
    const slid = fakeState({ speed: 30, speedKmh: 108 });
    for (const w of slid.wheels) {
      w.slipAngle = 0.28;
      w.slipSpeed = 9;
      w.slipRatio = 0.3;
    }
    for (let i = 0; i * (1 / 120) < 1.2; i++) v.update(slid, i / 120, {});
    const b = await oac.startRendering();
    const lv = levels([b.getChannelData(0), b.getChannelData(1)]);
    const { mag, N } = spectrum(b.getChannelData(0), SR * 0.3, SR * 1.15, 8192);
    const d = dominant(mag, N, 400, 6000);
    out.tyre = { ...lv, peakHz: Math.round(d.freq) };
    check('tyre squeal produces audible signal', lv.rms > 0.01, `rms ${lv.rms.toFixed(4)}`);
    check('tyre squeal resonance sits in the squeal band (0.7–3.5 kHz)', d.freq > 700 && d.freq < 3500, `${Math.round(d.freq)} Hz`);
    check('tyre voice does not clip', lv.peak < 0.999, `peak ${lv.peak.toFixed(3)}`);
  }
  // Wind at speed vs at rest
  {
    const { AmbienceVoice } = await import('./AmbienceVoice.js');
    const run = async (kmh) => {
      const oac = new OfflineAudioContext(2, SR * 1.0, SR);
      const g = oac.createGain();
      g.connect(oac.destination);
      const v = new AmbienceVoice(oac, { dest: g, startTime: 0 });
      const st = fakeState({ speedKmh: kmh, speed: kmh / 3.6 });
      for (let i = 0; i * (1 / 120) < 1.0; i++) v.update(st, i / 120, {});
      const b = await oac.startRendering();
      const lv = levels([b.getChannelData(0), b.getChannelData(1)]);
      const { mag, N } = spectrum(b.getChannelData(0), SR * 0.35, SR * 0.95, 8192);
      return { ...lv, centroidHz: Math.round(centroid(mag, N)) };
    };
    const slow = await run(40);
    const fast = await run(300);
    out.wind = { slow, fast };
    check('wind level rises with speed', fast.rms > slow.rms * 2.5, `40 km/h rms ${slow.rms.toFixed(4)} → 300 km/h ${fast.rms.toFixed(4)}`);
    check('wind brightens with speed', fast.centroidHz > slow.centroidHz * 1.25, `${slow.centroidHz} Hz → ${fast.centroidHz} Hz`);
  }
  // Impact: modal ring-down
  {
    const { SfxBank } = await import('./SfxBank.js');
    const oac = new OfflineAudioContext(2, SR * 1.5, SR);
    const g = oac.createGain();
    g.connect(oac.destination);
    const bank = new SfxBank(oac, { dest: g, startTime: 0 });
    bank.trigger('impact', { strength: 0.9, volume: 1, tag: 'barrier' }, 0.05);
    bank.trigger('land', { strength: 0.7 }, 0.6);
    bank.trigger('backfire', { strength: 0.8 }, 0.95);
    for (let i = 0; i * (1 / 120) < 1.5; i++) bank.update(1 / 120, i / 120, { speed: 20 });
    const b = await oac.startRendering();
    const d0 = b.getChannelData(0);
    const lv = levels([d0, b.getChannelData(1)]);
    // ring-down: energy 150 ms after the hit must be well below the transient but not zero
    const win = (a, bb) => {
      let s = 0;
      for (let i = Math.floor(a * SR); i < Math.floor(bb * SR); i++) s += d0[i] * d0[i];
      return Math.sqrt(s / Math.max(1, Math.floor((bb - a) * SR)));
    };
    const hit = win(0.05, 0.08);
    const ring = win(0.2, 0.32);
    out.impact = { ...lv, hitRms: +hit.toFixed(5), ringRms: +ring.toFixed(5) };
    check('impact produces a transient', hit > 0.01, `transient rms ${hit.toFixed(4)}`);
    check('impact rings down like metal (tail present but 6–60 dB below the hit)', ring > hit * 0.001 && ring < hit * 0.5, `hit ${hit.toFixed(4)} → tail ${ring.toFixed(4)}`);
    check('sfx bank does not clip', lv.peak < 0.999, `peak ${lv.peak.toFixed(3)}`);
  }
  return out;
}

/** G: music bed schedules notes and stays quiet enough not to fight the engine. */
async function testMusic() {
  const { MusicBed } = await import('./MusicBed.js');
  const oac = new OfflineAudioContext(2, SR * 4, SR);
  const g = oac.createGain();
  g.gain.value = 0.5; // musicVolume default
  g.connect(oac.destination);
  const m = new MusicBed(oac, { dest: g, startTime: 0 });
  m.setSection('race', 0.05);
  for (let i = 0; i * (1 / 60) < 4; i++) m.update(1 / 60, i / 60, { engine: 0, sfx: 0 });
  const b = await oac.startRendering();
  const lv = levels([b.getChannelData(0), b.getChannelData(1)]);
  check('music bed produces signal', lv.rms > 0.004, `rms ${lv.rms.toFixed(4)} (${lv.dbRms.toFixed(1)} dBFS)`);
  check('music bed does not clip', lv.peak < 0.999, `peak ${lv.peak.toFixed(3)}`);
  check(
    'music bed is present but leaves headroom (-30…-14 dBFS RMS at musicVolume)',
    lv.dbRms < -14 && lv.dbRms > -30,
    `${lv.dbRms.toFixed(1)} dBFS`
  );

  // ducking must measurably pull it down
  const oac2 = new OfflineAudioContext(2, SR * 4, SR);
  const g2 = oac2.createGain();
  g2.gain.value = 0.5;
  g2.connect(oac2.destination);
  const m2 = new MusicBed(oac2, { dest: g2, startTime: 0 });
  m2.setSection('race', 0.05);
  for (let i = 0; i * (1 / 60) < 4; i++) m2.update(1 / 60, i / 60, { engine: 1, sfx: 0.5 });
  const b2 = await oac2.startRendering();
  const lv2 = levels([b2.getChannelData(0), b2.getChannelData(1)]);
  check('music ducks under the engine', lv2.rms < lv.rms * 0.75, `${lv.dbRms.toFixed(1)} → ${lv2.dbRms.toFixed(1)} dBFS`);
  return { open: lv, ducked: lv2 };
}

/* ---------------------------------------------------------------- entry point */

/** Prints a readable FFT/level summary and returns the full report. */
export async function runAudioSelfTest(frames = [], opts = {}) {
  results.length = 0;
  const report = { sampleRate: SR };

  report.rpmTracking = await testRpmTracking();
  report.loadTimbre = await testLoadTimbre();
  report.carCharacter = await testCarCharacter();
  report.sweep = await testSweep();
  report.layers = await testLayers();
  report.music = await testMusic();
  if (frames.length > 8) report.fullMix = await testFullMix(frames, opts.seconds ?? 6);
  else check('captured game frames available', false, 'no frames captured — full-mix test skipped');

  report.checks = results.map((r) => ({ ...r }));
  report.passed = results.filter((r) => r.pass).length;
  report.failed = results.filter((r) => !r.pass).length;
  return report;
}

if (typeof window !== 'undefined') window.__NFT_AUDIO_TEST = runAudioSelfTest;
