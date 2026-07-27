/**
 * A complete engine voice: firing-order wavetable set → muffler → exhaust/intake resonator bank
 * → soft drive, plus a firing-synchronous rasp layer and (where fitted) turbo spool + wastegate.
 *
 * Design notes
 * ------------
 * • All four wavetables share one frequency automation and are started at the same instant, so they
 *   stay phase-locked and crossfading between them is a true spectral morph, not a chorus.
 * • The oscillator frequency is the ENGINE CYCLE rate (rpm/120), i.e. one 720° four-stroke cycle per
 *   wave period. Harmonic k of the table is therefore engine order k/2 exactly.
 * • Timbre is driven by throttle + engineLoad, not rpm alone: τ (exhaust pulse width) shortens under
 *   load, which physically moves energy up the harmonic series. Off throttle we crossfade to an
 *   overrun table with a long, soft pulse and almost no top end.
 * • Every schedulable call takes an explicit `time`, so the whole voice can be driven deterministically
 *   inside an OfflineAudioContext by the self-test.
 */
import * as MathX from '../core/MathX.js';
import { buildEngineWave, noiseSource, ramp, driveCurve, TAU } from './dsp.js';
import { profileForCar, getLayout } from './engineProfiles.js';

const { clamp, clamp01, lerp, damp } = MathX;
const SPEED_OF_SOUND = 343;

/** Build the four blend tables for a profile (cached per AudioContext + profile). */
const _waveCache = new WeakMap();
function waveSet(ac, profile, layoutName, harmonics) {
  let byCtx = _waveCache.get(ac);
  if (!byCtx) _waveCache.set(ac, (byCtx = new Map()));
  const key = `${layoutName}:${harmonics}`;
  if (byCtx.has(key)) return byCtx.get(key);

  let set;
  if (profile.layout === 'ev') {
    set = buildEvWaves(ac, profile, harmonics);
  } else {
    const layout = getLayout(profile.layout);
    const common = {
      harmonics,
      scatter: profile.wave.scatter,
      jitterDeg: profile.wave.jitterDeg,
      seed: 0x51ee7 + layoutName.length * 7919,
    };
    set = {
      idle: buildEngineWave(ac, layout, { ...common, ...profile.wave.idle }),
      cruise: buildEngineWave(ac, layout, { ...common, ...profile.wave.cruise }),
      power: buildEngineWave(ac, layout, { ...common, ...profile.wave.power }),
      overrun: buildEngineWave(ac, layout, { ...common, ...profile.wave.overrun }),
    };
  }
  byCtx.set(key, set);
  return set;
}

/**
 * EV tables. Same half-order indexing (harmonic k = order k/2) so the frequency code is shared,
 * but the content is a sparse comb: reduction-gear mesh orders, motor pole-pair orders and a
 * little inverter switching fuzz as sidebands around the mesh.
 */
function buildEvWaves(ac, profile, harmonics) {
  const N = Math.min(harmonics, 256);
  const make = (scale, meshBoost, lowBoost, sideband) => {
    const real = new Float32Array(N + 1);
    const imag = new Float32Array(N + 1);
    const rng = MathX.makeRng(0xe7 + Math.floor(meshBoost * 1000));
    for (const o of profile.ev.orders) {
      const k = Math.round(o.n * 2 * scale);
      if (k < 1 || k > N) continue;
      const boost = o.n >= 6 ? meshBoost : lowBoost;
      const ph = rng() * TAU;
      const g = o.g * boost;
      real[k] += g * Math.cos(ph);
      imag[k] -= g * Math.sin(ph);
      // switching sidebands ±1 half-order around the mesh orders
      if (sideband > 0 && o.n >= 6) {
        for (const d of [-1, 1]) {
          const ks = k + d;
          if (ks >= 1 && ks <= N) {
            const p2 = rng() * TAU;
            real[ks] += g * sideband * Math.cos(p2);
            imag[ks] -= g * sideband * Math.sin(p2);
          }
        }
      }
    }
    return ac.createPeriodicWave(real, imag, { disableNormalization: false });
  };
  return {
    idle: make(1, 0.35, 1.0, 0.05),
    cruise: make(1, 0.8, 0.8, 0.16),
    power: make(1, 1.25, 0.55, 0.3),
    overrun: make(1, 0.95, 0.25, 0.1), // regen: mesh whine, no torque rumble
  };
}

export class EngineVoice {
  /**
   * @param {BaseAudioContext} ac
   * @param {object} def   CarDef (§8)
   * @param {object} o     { spatial, dest, reverbSend, harmonics, startTime }
   */
  constructor(ac, def, o = {}) {
    this.ac = ac;
    this.def = def ?? {};
    this.profile = profileForCar(def);
    this.spatial = !!o.spatial;
    this.isEv = this.profile.layout === 'ev';
    this.idleRpm = Math.max(this.def.idleRpm ?? 800, this.isEv ? 0 : 500);
    this.redline = Math.max(this.def.redline ?? 7000, this.idleRpm + 1000);
    this.loudness = 0;
    this.boost = 0;
    this._lastThrottle = 0;
    this._lastGear = 1;
    this._doppler = 0;
    this._active = true;

    const t0 = o.startTime ?? ac.currentTime;
    const harmonics = o.harmonics ?? (this.spatial ? 96 : 240);
    const waves = waveSet(ac, this.profile, this.profile.layout, harmonics);

    /* ---------------- output chain ---------------- */
    this.out = ac.createGain();
    this.out.gain.value = 0;

    if (this.spatial) {
      const p = ac.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 6;
      p.maxDistance = 320;
      p.rolloffFactor = 1.35;
      p.coneInnerAngle = 360;
      this.panner = p;
      this.out.connect(p);
      this.output = p;
    } else {
      this.output = this.out;
    }
    if (o.dest) this.output.connect(o.dest);

    // soft drive — a little odd-harmonic grit, like a real exhaust into a mic
    this.drive = ac.createWaveShaper();
    this.drive.curve = driveCurve(this.spatial ? 0.6 : 1.5);
    this.drive.oversample = this.spatial ? 'none' : '2x';
    this.drive.connect(this.out);

    // Trim BEFORE the shaper. A WaveShaper clamps its input to ±1, so the resonator bank's boost
    // has to be paid back here or the drive stage turns into a hard clipper.
    this.trim = ac.createGain();
    this.trim.gain.value = this.spatial ? 0.55 : 0.4;
    this.trim.connect(this.drive);

    /* ---------------- resonator bank ---------------- */
    // Peaking filters standing in for exhaust pipe modes, header collector, airbox and cabin boom.
    this.resonators = [];
    let node = this.trim;
    const resList = this.spatial ? this.profile.resonators.slice(0, 2) : this.profile.resonators;
    for (let i = resList.length - 1; i >= 0; i--) {
      const r = resList[i];
      const f = ac.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = clamp(r.track ? 120 : r.f, 20, ac.sampleRate * 0.45);
      f.Q.value = r.q;
      f.gain.value = r.g;
      f.connect(node);
      node = f;
      this.resonators.unshift({ node: f, spec: r });
    }

    // muffler / butterfly valve
    this.muffler = ac.createBiquadFilter();
    this.muffler.type = 'lowpass';
    this.muffler.frequency.value = this.profile.muffler.lo;
    this.muffler.Q.value = this.profile.muffler.q;
    this.muffler.connect(node);

    // A gentle high-pass keeps DC/sub-20 Hz junk out of the limiter. Profiles with no combustion
    // (EV) set `hpf` high to strip the torque rumble that a motor simply does not make.
    this.hp = ac.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = Math.max(this.profile.hpf ?? 32, this.spatial ? 90 : 0);
    this.hp.Q.value = 0.5;
    this.hp.connect(this.muffler);

    /** Public injection point: backfires/pops fed here inherit the exhaust resonances. */
    this.exhaustIn = this.hp;

    /* ---------------- wavetable oscillators ---------------- */
    this.mix = ac.createGain();
    this.mix.gain.value = 1;
    this.mix.connect(this.hp);

    const slots = this.spatial ? ['cruise', 'power', 'overrun'] : ['idle', 'cruise', 'power', 'overrun'];
    this.osc = {};
    for (const name of slots) {
      const osc = ac.createOscillator();
      osc.setPeriodicWave(waves[name]);
      const g = ac.createGain();
      g.gain.value = 0;
      osc.connect(g).connect(this.mix);
      osc.start(t0);
      this.osc[name] = { osc, gain: g };
    }
    this.oscList = Object.values(this.osc);

    /* ---------------- rasp / turbulence ---------------- */
    if (!this.spatial) {
      const rp = this.profile.rasp;
      this.raspSrc = noiseSource(ac, 'pink');
      this.raspBp = ac.createBiquadFilter();
      this.raspBp.type = 'bandpass';
      this.raspBp.frequency.value = rp.band[0];
      this.raspBp.Q.value = rp.q;
      this.raspGain = ac.createGain();
      this.raspGain.gain.value = 0;
      this.raspSrc.connect(this.raspBp).connect(this.raspGain).connect(this.mix);
      this.raspSrc.start(t0);

      // Firing-synchronous amplitude modulation: the rasp chuffs in time with the exhaust pulses.
      // (Connections SUM with the automated value on an AudioParam, which is exactly what we want.)
      this.chuff = ac.createOscillator();
      this.chuff.type = 'sawtooth';
      this.chuffDepth = ac.createGain();
      this.chuffDepth.gain.value = 0;
      this.chuff.connect(this.chuffDepth).connect(this.raspGain.gain);
      this.chuff.start(t0);
    }

    /* ---------------- turbo ---------------- */
    const tb = this.profile.turbo;
    if (tb && !this.spatial) {
      this.turbo = { spec: tb };
      const whine = ac.createOscillator();
      whine.type = 'triangle';
      whine.frequency.value = tb.whineLo;
      const wg = ac.createGain();
      wg.gain.value = 0;
      const wf = ac.createBiquadFilter();
      wf.type = 'bandpass';
      wf.frequency.value = tb.whineLo;
      wf.Q.value = 1.4;
      whine.connect(wg).connect(wf).connect(this.hp);
      whine.start(t0);

      // second, quieter partial an octave and a fifth up gives the "jet" quality
      const whine2 = ac.createOscillator();
      whine2.type = 'sine';
      const wg2 = ac.createGain();
      wg2.gain.value = 0;
      whine2.connect(wg2).connect(wf);
      whine2.start(t0);

      // compressor-wheel air noise
      const air = noiseSource(ac, 'white');
      const abp = ac.createBiquadFilter();
      abp.type = 'bandpass';
      abp.frequency.value = 3200;
      abp.Q.value = 1.1;
      const ag = ac.createGain();
      ag.gain.value = 0;
      air.connect(abp).connect(ag).connect(this.hp);
      air.start(t0);

      // wastegate / blow-off path (one-shot, always resident — no per-event node churn)
      const bov = noiseSource(ac, 'white');
      const bbp = ac.createBiquadFilter();
      bbp.type = 'bandpass';
      bbp.frequency.value = 2600;
      bbp.Q.value = 0.85;
      const bg = ac.createGain();
      bg.gain.value = 0;
      bov.connect(bbp).connect(bg).connect(this.out);
      bov.start(t0);

      Object.assign(this.turbo, { whine, wg, whine2, wg2, wf, abp, ag, bg, bbp });
    }

    if (o.reverbSend) {
      this.send = ac.createGain();
      this.send.gain.value = this.spatial ? 0.12 : 0.22;
      this.out.connect(this.send).connect(o.reverbSend);
    }
  }

  /** Blend weights for the four tables from rpm + load. Pure function — the self-test asserts on it. */
  static blend(rpmN, load) {
    const p = clamp01(0.1 + 0.55 * load + 0.45 * rpmN);
    const on = 0.32 + 0.68 * load;
    const gIdle = Math.max(0, 1 - p / 0.5) * on;
    const gCruise = clamp01(1 - Math.abs(p - 0.5) / 0.5) * on;
    const gPower = Math.max(0, (p - 0.5) / 0.5) * on;
    const gOver = (1 - load) * (0.3 + 0.5 * rpmN);
    return { idle: gIdle, cruise: gCruise, power: gPower, overrun: gOver, p, on };
  }

  /**
   * @param {object} s  VehicleState (§9) — only rpm/engineLoad/throttle/gear/nosActive are required
   * @param {number} t  audio-context time to schedule at
   * @param {object} o  { gain, dt, doppler (cents) }
   */
  update(s, t, o = {}) {
    if (!this._active) return;
    const ac = this.ac;
    const dt = o.dt ?? 1 / 60;
    const prof = this.profile;

    const rpm = clamp(Number.isFinite(s?.rpm) ? s.rpm : this.idleRpm, this.idleRpm * 0.6, this.redline * 1.06);
    const rpmN = clamp01((rpm - this.idleRpm) / (this.redline - this.idleRpm));
    const throttle = clamp01(s?.throttle ?? 0);
    const engineLoad = clamp01(s?.engineLoad ?? 0);
    const load = clamp01(0.62 * throttle + 0.52 * engineLoad);
    const nos = s?.nosActive ? 1 : 0;

    // ---- frequency: one full four-stroke cycle per wave period ----
    // A touch of idle wander keeps the bottom end alive; it vanishes under load.
    const wander = this.isEv ? 0 : Math.sin(t * 5.7) * 0.006 + Math.sin(t * 13.3) * 0.003;
    const cycleHz = Math.max(0.6, (rpm / 120) * (1 + wander * (1 - load)));
    const smoothing = lerp(0.055, 0.014, load); // snappier throttle response under load
    for (const v of this.oscList) {
      ramp(v.osc.frequency, cycleHz, t, smoothing);
      if (o.doppler) ramp(v.osc.detune, o.doppler, t, 0.05);
    }

    // ---- table blend ----
    const b = EngineVoice.blend(rpmN, load);
    const tcMix = 0.045;
    if (this.osc.idle) ramp(this.osc.idle.gain.gain, b.idle * 0.9, t, tcMix);
    ramp(this.osc.cruise.gain.gain, b.cruise, t, tcMix);
    ramp(this.osc.power.gain.gain, b.power, t, tcMix);
    ramp(this.osc.overrun.gain.gain, b.overrun * (this.isEv ? 0.5 : 0.8), t, tcMix);

    // ---- muffler / butterfly ----
    const m = prof.muffler;
    const open = Math.pow(clamp01(0.22 * rpmN + 0.78 * load), 0.8) + nos * 0.18;
    ramp(this.muffler.frequency, clamp(lerp(m.lo, m.hi, clamp01(open)), 60, ac.sampleRate * 0.46), t, 0.05);

    // rpm-tracking resonances (intake trumpet / gear mesh orders)
    for (const r of this.resonators) {
      if (!r.spec.track) continue;
      const f = clamp((rpm / 60) * r.spec.track, 40, ac.sampleRate * 0.44);
      ramp(r.node.frequency, f, t, 0.06);
    }

    // ---- rasp ----
    if (this.raspGain) {
      const rp = prof.rasp;
      const rf = lerp(rp.band[0], rp.band[1], clamp01(0.45 * rpmN + 0.55 * load));
      ramp(this.raspBp.frequency, rf, t, 0.07);
      const rg = rp.gain * (0.12 + 0.55 * load + 0.45 * rpmN) * (1 + nos * 0.8);
      ramp(this.raspGain.gain, rg, t, 0.05);
      // firing rate = cycles/s × cylinders/2
      const cylCount = prof.layout === 'ev' ? 2 : getLayout(prof.layout).cylinders.length;
      ramp(this.chuff.frequency, clamp(cycleHz * cylCount * 0.5, 1, 4000), t, smoothing);
      ramp(this.chuffDepth.gain, rg * lerp(0.85, 0.25, load), t, 0.06);
    }

    // ---- turbo ----
    if (this.turbo) {
      const tb = this.turbo.spec;
      const target = load * clamp01((rpmN + 0.12) / 0.55);
      const rate = target > this.boost ? tb.spoolUp : tb.spoolDown;
      this.boost = damp(this.boost, target, rate, clamp(dt, 0.001, 0.1));
      const bst = clamp01(this.boost);
      const wf = lerp(tb.whineLo, tb.whineHi, Math.pow(bst, 0.75) * (0.35 + 0.65 * rpmN));
      ramp(this.turbo.whine.frequency, wf, t, 0.08);
      ramp(this.turbo.whine2.frequency, wf * 1.503, t, 0.08);
      ramp(this.turbo.wf.frequency, clamp(wf * 1.1, 100, ac.sampleRate * 0.45), t, 0.08);
      const wgain = tb.whineGain * Math.pow(bst, 1.25) * (0.35 + 0.65 * rpmN);
      ramp(this.turbo.wg.gain, wgain, t, 0.06);
      ramp(this.turbo.wg2.gain, wgain * 0.35, t, 0.06);
      ramp(this.turbo.abp.frequency, lerp(2200, 6200, bst), t, 0.08);
      ramp(this.turbo.ag.gain, 0.05 * bst * (0.4 + 0.6 * load), t, 0.06);

      // Lift off boost → wastegate chatter.
      if (this._lastThrottle - throttle > 0.28 && bst > 0.35) this.blowOff(bst * tb.bov, t);
    }

    // ---- output level ----
    // Engines are loud but must leave room for tyres and impacts; this curve is the mix's backbone.
    const base = prof.gain * (0.1 + 0.34 * rpmN + 0.4 * load + 0.1 * rpmN * load);
    const lvl = base * (o.gain ?? 1) * (this.isEv ? 0.9 : 1);
    this.loudness = clamp01(base);
    ramp(this.out.gain, lvl, t, 0.04);

    this._lastThrottle = throttle;
    this._lastGear = s?.gear ?? this._lastGear;
  }

  /** Wastegate / blow-off: a pressure release with a short chattering flutter tail. */
  blowOff(strength = 1, t = this.ac.currentTime) {
    if (!this.turbo) return;
    const s = clamp01(strength);
    const g = this.turbo.bg.gain;
    const f = this.turbo.bbp.frequency;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0008, t);
    g.linearRampToValueAtTime(0.14 * s + 0.01, t + 0.012);
    g.exponentialRampToValueAtTime(0.02 * s + 0.002, t + 0.09);
    g.exponentialRampToValueAtTime(0.0008, t + 0.28 + 0.15 * s);
    f.cancelScheduledValues(t);
    f.setValueAtTime(3400, t);
    f.exponentialRampToValueAtTime(1500, t + 0.16);
    f.exponentialRampToValueAtTime(900, t + 0.32);
    this.boost *= 0.25;
  }

  /** Momentary ignition cut for an upshift — the little hole in the note that sells a shift. */
  cut(depth = 0.7, dur = 0.07, t = this.ac.currentTime) {
    const g = this.out.gain;
    const cur = Math.max(g.value, 0.0001);
    g.cancelScheduledValues(t);
    g.setValueAtTime(cur, t);
    g.linearRampToValueAtTime(cur * (1 - clamp01(depth)) + 0.0005, t + 0.012);
    g.setTargetAtTime(cur, t + dur, 0.03);
  }

  /** Position + velocity for spatialised voices; also returns the doppler shift in cents. */
  place(pos, vel, listenerPos, listenerVel, t) {
    if (!this.panner || !pos) return 0;
    const p = this.panner;
    if (p.positionX) {
      ramp(p.positionX, pos.x, t, 0.02);
      ramp(p.positionY, pos.y, t, 0.02);
      ramp(p.positionZ, pos.z, t, 0.02);
    } else if (p.setPosition) {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    // Web Audio dropped built-in doppler, so compute the radial component ourselves.
    let cents = 0;
    if (vel && listenerPos) {
      const dx = pos.x - listenerPos.x;
      const dy = pos.y - listenerPos.y;
      const dz = pos.z - listenerPos.z;
      const d = Math.hypot(dx, dy, dz) || 1e-3;
      const rvx = vel.x - (listenerVel?.x ?? 0);
      const rvy = vel.y - (listenerVel?.y ?? 0);
      const rvz = vel.z - (listenerVel?.z ?? 0);
      const closing = (rvx * dx + rvy * dy + rvz * dz) / d; // + = receding
      const ratio = SPEED_OF_SOUND / clamp(SPEED_OF_SOUND + closing, 60, 900);
      cents = clamp(1200 * Math.log2(ratio), -700, 700);
      this._doppler = damp(this._doppler, cents, 22, 1 / 60);
      cents = this._doppler;
    }
    return cents;
  }

  setSendLevel(v, t = this.ac.currentTime) {
    if (this.send) ramp(this.send.gain, v, t, 0.1);
  }

  silence(t = this.ac.currentTime) {
    ramp(this.out.gain, 0, t, 0.05);
    this.loudness = 0;
  }

  dispose() {
    this._active = false;
    try {
      for (const v of this.oscList) v.osc.stop();
      this.raspSrc?.stop();
      this.chuff?.stop();
      if (this.turbo) {
        this.turbo.whine.stop();
        this.turbo.whine2.stop();
      }
      this.output.disconnect();
    } catch {
      /* already stopped */
    }
  }
}
