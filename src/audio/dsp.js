/**
 * Low-level synthesis primitives. Everything here is pure Web Audio — no files, no fetches.
 *
 * The important one is `buildEngineWave()`: it synthesises an engine's periodic waveform from
 * its firing order by summing per-cylinder exhaust pulses **in the frequency domain**, which is
 * what makes a cross-plane V8 burble and a flat-plane V8 scream from the same code path.
 */
import { makeRng } from '../core/MathX.js';

export const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ noise */

/**
 * Loop length for every noise bed. Long enough that the crossfade-looped result has no audible
 * period, short enough that generating one costs a few milliseconds even on a 96 kHz device.
 */
export const NOISE_SECONDS = 2;

const _noiseCache = new WeakMap();

/**
 * Looping noise buffers, cached per AudioContext. `colour`:
 *   'white'  — flat
 *   'pink'   — -3 dB/oct (Voss-McCartney-ish IIR); the natural bed for wind/road
 *   'brown'  — -6 dB/oct, for rumble
 *   'velvet' — sparse impulses; excellent excitation for ringing filter banks (crunch/scrape)
 * Buffers are stereo and decorrelated so anything built on them has natural width.
 */
export function noiseBuffer(ac, colour = 'white', seconds = NOISE_SECONDS) {
  let byCtx = _noiseCache.get(ac);
  if (!byCtx) _noiseCache.set(ac, (byCtx = new Map()));
  const key = `${colour}:${seconds}`;
  if (byCtx.has(key)) return byCtx.get(key);

  const n = Math.max(1, Math.floor(ac.sampleRate * seconds));
  const buf = ac.createBuffer(2, n, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rng = makeRng(0xa17d0 + ch * 7919 + colour.length * 131);
    if (colour === 'pink') {
      // Paul Kellet's economy pink filter.
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const w = rng() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else if (colour === 'brown') {
      let last = 0;
      for (let i = 0; i < n; i++) {
        last = (last + (rng() * 2 - 1) * 0.06) * 0.996;
        d[i] = last * 5.2;
      }
    } else if (colour === 'velvet') {
      const density = 0.02;
      for (let i = 0; i < n; i++) d[i] = rng() < density ? (rng() < 0.5 ? -1 : 1) : 0;
    } else {
      for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
    }
    // Seamless loop: crossfade the last 40 ms into the head.
    const xf = Math.min(Math.floor(ac.sampleRate * 0.04), (n / 4) | 0);
    for (let i = 0; i < xf; i++) {
      const t = i / xf;
      const a = d[n - xf + i];
      const b = d[i];
      d[n - xf + i] = a * (1 - t) + b * t;
    }
    // Normalise every colour to the same RMS so a gain of 0.2 means the same thing whichever
    // noise a voice happens to use. Without this, brown noise arrives ~16 dB hotter than white.
    let sum = 0;
    for (let i = 0; i < n; i++) sum += d[i] * d[i];
    const rms = Math.sqrt(sum / n);
    if (rms > 1e-9) {
      const k = 0.3 / rms;
      for (let i = 0; i < n; i++) d[i] *= k;
    }
  }
  byCtx.set(key, buf);
  return buf;
}

/** A started, looping stereo noise source. Cheap; one per persistent voice. */
export function noiseSource(ac, colour = 'white', seconds = NOISE_SECONDS) {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, colour, seconds);
  src.loop = true;
  src.loopEnd = src.buffer.duration;
  return src;
}

/* ------------------------------------------------- impulse response (verb) */

/**
 * Procedural impulse response: a handful of discrete early reflections followed by an
 * exponentially decaying, progressively low-passed diffuse tail. Sounds like a place
 * rather than a delay line, and costs ~1 ms to build.
 */
export function buildImpulseResponse(ac, opts = {}) {
  const seconds = opts.seconds ?? 1.1;
  const decay = opts.decay ?? 2.6;
  const predelay = opts.predelay ?? 0.012;
  const damping = opts.damping ?? 0.42; // 0 = bright tail, 1 = very dark
  const width = opts.width ?? 0.85;
  const sr = ac.sampleRate;
  const n = Math.max(16, Math.floor(sr * seconds));
  // `into`/`only` let the caller render one channel per frame. The ConvolverNode spec requires the
  // buffer to match the context sample rate, so there is no cheaper shortcut than splitting the work.
  const buf = opts.into ?? ac.createBuffer(2, n, sr);
  const rng = makeRng((opts.seed ?? 0x5eaf00d) + (opts.only ?? 0) * 7919);

  const early = opts.early ?? [
    [0.011, 0.62], [0.019, -0.44], [0.029, 0.38], [0.041, -0.27],
    [0.058, 0.22], [0.077, -0.16], [0.101, 0.12],
  ];

  // The envelope and the damping coefficient are smooth over hundreds of milliseconds, so they are
  // evaluated on a coarse grid and interpolated. Doing pow()/exp() per sample costs ~15 ms on a
  // 96 kHz device — a dropped frame — for a result that is bit-for-bit inaudible.
  const GRID = 64;
  const pd = Math.floor(predelay * sr);
  const tail = Math.max(1, n - pd);
  const steps = Math.ceil(tail / GRID) + 2;
  const envG = new Float64Array(steps);
  const dampG = new Float64Array(steps);
  for (let s = 0; s < steps; s++) {
    const i = Math.min(tail, s * GRID);
    const t = i / sr;
    envG[s] = Math.pow(Math.max(0, 1 - i / tail), decay) * Math.exp(-t * 1.1);
    dampG[s] = 1 - Math.min(0.995, damping * 0.45 + Math.min(0.5, t * damping * 0.9));
  }

  for (let ch = 0; ch < 2; ch++) {
    if (opts.only !== undefined && opts.only !== ch) continue;
    const d = buf.getChannelData(ch);
    const skew = ch === 0 ? 1 : 1 + width * 0.13;
    // Diffuse tail: noise * exp decay, one-pole low-passed with a cutoff that closes over time.
    let lp = 0;
    let peak = 0;
    const inv = 1 / GRID;
    for (let i = pd; i < n; i++) {
      const x = (i - pd) * inv;
      const s = x | 0;
      const f = x - s;
      const env = envG[s] + (envG[s + 1] - envG[s]) * f;
      const a = dampG[s] + (dampG[s + 1] - dampG[s]) * f;
      lp += a * ((rng() * 2 - 1) - lp);
      const v = lp * env;
      d[i] = v;
      const av = v < 0 ? -v : v;
      if (av > peak) peak = av;
    }
    for (const [tt, g] of early) {
      const i = Math.floor(tt * skew * sr) + pd;
      if (i < n) {
        d[i] += g * (ch === 0 ? 1 : 1 - width * 0.3) * (0.85 + rng() * 0.3);
        const av = Math.abs(d[i]);
        if (av > peak) peak = av;
      }
    }
    // Normalise so the send level means the same thing on every device sample rate.
    if (peak > 0) {
      const k = 0.5 / peak;
      for (let i = pd; i < n; i++) d[i] *= k;
    }
  }
  return buf;
}

/* --------------------------------------------------------- engine waveform */

/**
 * Build a PeriodicWave for one engine cycle (720° of crank = 2 revolutions).
 *
 * Because the wave period IS one full four-stroke cycle, harmonic `k` of the wave corresponds
 * exactly to engine order `k/2`. Half-orders are therefore representable — and half-order energy
 * is precisely what an unevenly-fired bank (cross-plane V8, boxer) produces. Nothing about the
 * burble is faked: it falls out of summing the cylinders at their real firing angles.
 *
 * Each cylinder contributes a blowdown pulse modelled as (decay exponential − attack exponential),
 * whose closed-form spectrum is 1/(1+j2πkτd) − 1/(1+j2πkτa). τ is expressed as a fraction of the
 * cycle, so shortening τ (hard on-throttle, open valve) genuinely moves energy up the series.
 *
 * @param {BaseAudioContext} ac
 * @param {object} cfg   engine config: { cylinders:[{angle,bank}], banks:{[id]:{gain,tauScale}} }
 * @param {object} o     { tauDecay, tauAttack, harmonics, knee, tilt, scatter, jitterDeg, seed, rough }
 */
export function buildEngineWave(ac, cfg, o = {}) {
  const N = Math.max(8, Math.min(o.harmonics ?? 220, 512));
  const tauD = Math.max(1e-4, o.tauDecay ?? 0.055);
  const tauA = Math.max(1e-5, Math.min(o.tauAttack ?? 0.011, tauD * 0.9));
  const knee = o.knee ?? 90;
  const tilt = o.tilt ?? 0; // >0 lifts the top end (rasp / straight pipe)
  const rough = o.rough ?? 0.35;
  const rng = makeRng(o.seed ?? 0x9e3779b9);

  const cyls = cfg.cylinders;
  const banks = cfg.banks ?? {};
  // Per-cylinder personality: fixed for the life of the wave set so a car sounds like itself.
  const dev = cyls.map(() => ({
    g: 1 + rng.gauss() * (o.scatter ?? 0.06),
    a: rng.gauss() * (o.jitterDeg ?? 1.4),
  }));

  const real = new Float32Array(N + 1);
  const imag = new Float32Array(N + 1);

  // Group cylinders by bank so each bank can have its own pulse shape + level.
  const byBank = new Map();
  cyls.forEach((c, i) => {
    const b = c.bank ?? 'a';
    if (!byBank.has(b)) byBank.set(b, []);
    byBank.get(b).push({ ...c, ...dev[i] });
  });

  for (let k = 1; k <= N; k++) {
    const w = TAU * k;
    let accR = 0;
    let accI = 0;
    for (const [bankId, list] of byBank) {
      const bank = banks[bankId] ?? {};
      const bg = bank.gain ?? 1;
      const td = tauD * (bank.tauScale ?? 1);
      const ta = tauA * (bank.tauScale ?? 1);
      // pulse spectrum P(k) = 1/(1+jwτd) − 1/(1+jwτa)
      const dD = 1 + (w * td) ** 2;
      const dA = 1 + (w * ta) ** 2;
      const pR = 1 / dD - 1 / dA;
      const pI = -(w * td) / dD + (w * ta) / dA;
      // cylinder phasor sum Σ g·e^{-jkφ}
      let sR = 0;
      let sI = 0;
      for (const c of list) {
        const phi = (TAU * k * ((c.angle + c.a) % 720)) / 720;
        sR += c.g * Math.cos(phi);
        sI -= c.g * Math.sin(phi);
      }
      // Unequal-length headers: each bank's pulses reach the tailpipe at a different time.
      // A pure phase term — and the main reason a cross-plane V8's banks don't cancel.
      const del = bank.delay ?? 0;
      if (del) {
        const dp = -TAU * k * del;
        const cr = Math.cos(dp);
        const ci = Math.sin(dp);
        const nR = sR * cr - sI * ci;
        sI = sR * ci + sI * cr;
        sR = nR;
      }
      accR += bg * (pR * sR - pI * sI);
      accI += bg * (pR * sI + pI * sR);
    }

    // Spectral shaping: hard knee at the top (the resonator bank + rasp layer own the treble),
    // optional tilt for straight-pipe rasp, and phase roughening so it never reads as a synth.
    let mag = Math.hypot(accR, accI);
    let ph = Math.atan2(accI, accR);
    const order = k / 2;
    mag *= Math.exp(-Math.pow(k / knee, 1.35));
    if (tilt) mag *= 1 + tilt * Math.min(1, order / 12);
    if (rough && k > 10) ph += rng.gauss() * rough * Math.min(1, (k - 10) / 40);

    real[k] = mag * Math.cos(ph);
    imag[k] = -mag * Math.sin(ph);
  }

  return ac.createPeriodicWave(real, imag, { disableNormalization: false });
}

/* ------------------------------------------------------------- misc curves */

/** tanh-ish soft clipper. Guarantees |y| < 1 for any input — the last line against clipping. */
export function softClipCurve(amount = 1.6, n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return c;
}

/** Symmetric odd-harmonic distortion for exhaust rasp / speaker grit. */
export function driveCurve(drive = 3, n = 1024) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = ((1 + drive) * x) / (1 + drive * Math.abs(x));
  }
  return c;
}

/* ------------------------------------------------------------ param helpers */

/** setTargetAtTime with a guard against non-finite values sneaking in from physics. */
export function ramp(param, value, time, tc = 0.03) {
  if (!param) return;
  const v = Number.isFinite(value) ? value : 0;
  param.setTargetAtTime(v, time, Math.max(tc, 0.001));
}

export function setNow(param, value, time) {
  if (!param) return;
  param.setValueAtTime(Number.isFinite(value) ? value : 0, time);
}

/** Percussive AD envelope on a gain, scheduled from `t0`. */
export function envAD(gain, t0, peak, attack, decay, floor = 0.0006) {
  const g = gain.gain;
  g.cancelScheduledValues(t0);
  g.setValueAtTime(Math.max(floor, g.value * 0.0001 + floor), t0);
  g.linearRampToValueAtTime(Math.max(peak, floor * 2), t0 + Math.max(attack, 0.0005));
  g.exponentialRampToValueAtTime(floor, t0 + Math.max(attack, 0.0005) + Math.max(decay, 0.01));
  g.linearRampToValueAtTime(0, t0 + Math.max(attack, 0.0005) + Math.max(decay, 0.01) + 0.01);
}

export const dbToGain = (db) => Math.pow(10, db / 20);
