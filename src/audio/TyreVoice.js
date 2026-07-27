/**
 * Tyre voices — the sound that tells the player where the limit is.
 *
 * Four persistent voices, no per-frame node creation:
 *   • front squeal  • rear squeal   — a band-defining bandpass plus two high-Q peaking resonances
 *                                     whose centre and Q rise with slip, with a small vibrato so it
 *                                     "sings" instead of whistling
 *   • scrub                          — locked-wheel broadband roar with a judder tremolo
 *   • spray                          — loose-surface (grass/dirt) gravel rattle keyed to slip speed
 *
 * Squeal is a stick-slip oscillation of the tread block, so its pitch depends on slip *velocity*
 * and tread stiffness (i.e. load), not just slip angle — modelled below.
 */
import { clamp, clamp01, lerp } from '../core/MathX.js';
import { noiseSource, ramp } from './dsp.js';

/** How much a surface can squeal, and how it colours the rumble. */
export const SURFACE = {
  asphalt: { squeal: 1.0, bright: 1.0, loose: 0.0, roar: 1.0, roarLp: 900 },
  concrete: { squeal: 0.92, bright: 1.12, loose: 0.0, roar: 1.15, roarLp: 1200 },
  curb: { squeal: 0.5, bright: 1.25, loose: 0.1, roar: 1.6, roarLp: 1500 },
  metal: { squeal: 0.7, bright: 1.5, loose: 0.0, roar: 1.3, roarLp: 2200 },
  dirt: { squeal: 0.1, bright: 0.7, loose: 1.0, roar: 1.25, roarLp: 520 },
  grass: { squeal: 0.05, bright: 0.6, loose: 0.85, roar: 0.95, roarLp: 380 },
  water: { squeal: 0.25, bright: 0.8, loose: 0.55, roar: 1.1, roarLp: 700 },
  gravel: { squeal: 0.08, bright: 0.8, loose: 1.15, roar: 1.35, roarLp: 620 },
};
export const surfaceInfo = (s) => SURFACE[s] ?? SURFACE.asphalt;

/**
 * One squeal voice. A broad bandpass sets the band, then two peaking filters supply the sharp
 * stick–slip resonances. Peaking rather than cascaded bandpasses matters: two high-Q bandpasses in
 * series throw away ~26 dB of broadband level, which is why a naive squeal is always too quiet.
 */
function squealVoice(ac, dest, t0, seed) {
  const src = noiseSource(ac, 'white');
  const bp1 = ac.createBiquadFilter();
  bp1.type = 'bandpass';
  bp1.frequency.value = 1100;
  bp1.Q.value = 3;
  const bp2 = ac.createBiquadFilter();
  bp2.type = 'peaking';
  bp2.frequency.value = 1100;
  bp2.Q.value = 11;
  bp2.gain.value = 14;
  const peak = ac.createBiquadFilter();
  peak.type = 'peaking';
  peak.frequency.value = 2200;
  peak.Q.value = 7;
  peak.gain.value = 9;
  const makeup = ac.createGain();
  makeup.gain.value = 3.0;
  const g = ac.createGain();
  g.gain.value = 0;

  // vibrato — tread blocks never stick/slip at a perfectly constant rate
  const lfo = ac.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 7.3 + seed * 1.9;
  const lfoAmt = ac.createGain();
  lfoAmt.gain.value = 26;
  lfo.connect(lfoAmt).connect(bp2.frequency);
  lfo.start(t0);

  src.connect(bp1).connect(bp2).connect(peak).connect(makeup).connect(g).connect(dest);
  src.start(t0);
  return { src, bp1, bp2, peak, g, lfoAmt };
}

export class TyreVoice {
  constructor(ac, o = {}) {
    this.ac = ac;
    const t0 = o.startTime ?? ac.currentTime;
    this.out = ac.createGain();
    this.out.gain.value = 1;
    if (o.dest) this.out.connect(o.dest);
    if (o.reverbSend) {
      this.send = ac.createGain();
      this.send.gain.value = 0.18;
      this.out.connect(this.send).connect(o.reverbSend);
    }

    this.front = squealVoice(ac, this.out, t0, 0);
    this.rear = squealVoice(ac, this.out, t0, 1);

    /* ---- scrub: locked wheels dragging ---- */
    this.scrubSrc = noiseSource(ac, 'pink');
    this.scrubLp = ac.createBiquadFilter();
    this.scrubLp.type = 'lowpass';
    this.scrubLp.frequency.value = 1600;
    this.scrubLp.Q.value = 0.8;
    this.scrubPk = ac.createBiquadFilter();
    this.scrubPk.type = 'peaking';
    this.scrubPk.frequency.value = 420;
    this.scrubPk.Q.value = 1.6;
    this.scrubPk.gain.value = 7;
    this.scrubG = ac.createGain();
    this.scrubG.gain.value = 0;
    this.scrubSrc.connect(this.scrubLp).connect(this.scrubPk).connect(this.scrubG).connect(this.out);
    this.scrubSrc.start(t0);
    // judder — the wheel hops as it locks
    this.judder = ac.createOscillator();
    this.judder.type = 'sine';
    this.judder.frequency.value = 34;
    this.judderAmt = ac.createGain();
    this.judderAmt.gain.value = 0;
    this.judder.connect(this.judderAmt).connect(this.scrubG.gain);
    this.judder.start(t0);

    /* ---- spray: gravel/grass ---- */
    this.spraySrc = noiseSource(ac, 'white');
    this.sprayBp = ac.createBiquadFilter();
    this.sprayBp.type = 'bandpass';
    this.sprayBp.frequency.value = 1800;
    this.sprayBp.Q.value = 0.7;
    this.sprayHp = ac.createBiquadFilter();
    this.sprayHp.type = 'highpass';
    this.sprayHp.frequency.value = 500;
    this.sprayG = ac.createGain();
    this.sprayG.gain.value = 0;
    this.spraySrc.connect(this.sprayHp).connect(this.sprayBp).connect(this.sprayG).connect(this.out);
    this.spraySrc.start(t0);

    this.loudness = 0;
  }

  /**
   * @param {object} s VehicleState
   * @param {number} t schedule time
   * @param {object} o { gain }
   */
  update(s, t, o = {}) {
    const wheels = s?.wheels;
    const gain = o.gain ?? 1;
    if (!wheels || wheels.length < 4) {
      this._quiet(t);
      return;
    }
    const speed = Math.abs(s.speed ?? 0);
    const speedN = clamp01(speed / 60);

    let lock = 0;
    let loose = 0;
    let looseBright = 1;
    const axle = [
      { slip: 0, spd: 0, load: 0, squealMul: 0, n: 0 },
      { slip: 0, spd: 0, load: 0, squealMul: 0, n: 0 },
    ];

    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      if (!w) continue;
      const a = axle[i < 2 ? 0 : 1];
      const info = surfaceInfo(w.surface);
      const contact = w.contact ? 1 : 0;
      a.n++;
      if (!contact) continue;
      const sa = Math.abs(w.slipAngle ?? 0);
      const sr = Math.abs(w.slipRatio ?? 0);
      // Squeal onset ~3.5° of slip angle, or ~12% slip ratio; saturates well before the tyre lets go.
      const angleN = clamp01((sa - 0.06) / 0.3);
      const ratioN = clamp01((sr - 0.12) / 0.55);
      a.slip = Math.max(a.slip, Math.max(angleN, ratioN * 0.92) * info.squeal);
      a.spd = Math.max(a.spd, w.slipSpeed ?? 0);
      a.load = Math.max(a.load, clamp01((w.load ?? 0) / 6000));
      a.squealMul = Math.max(a.squealMul, info.squeal);
      if (w.lockedUp) lock = Math.max(lock, 1);
      else if (sr > 0.45 && speed > 4) lock = Math.max(lock, clamp01((sr - 0.45) / 0.6) * 0.6);
      if (info.loose > 0) {
        loose = Math.max(loose, info.loose);
        looseBright = info.bright;
      }
    }

    for (let i = 0; i < 2; i++) {
      const a = axle[i];
      const v = i === 0 ? this.front : this.rear;
      const slipSpeedN = clamp01(a.spd / 13);
      // Needs both angle AND relative sliding velocity: a tyre at big slip but low speed is silent.
      const amt = clamp01(a.slip * Math.pow(slipSpeedN, 0.55)) * clamp01(speed / 6);
      // Stick–slip frequency climbs with sliding velocity and with tread stiffness (load).
      const f1 = clamp(760 + 980 * slipSpeedN + 260 * a.load + 190 * speedN, 300, 4200);
      ramp(v.bp1.frequency, f1 * 1.15, t, 0.05);
      ramp(v.bp2.frequency, f1, t, 0.05);
      ramp(v.bp1.Q, lerp(1.8, 3.6, clamp01(amt)), t, 0.08);
      ramp(v.bp2.Q, lerp(6, 16, clamp01(amt * 1.2)), t, 0.08);
      ramp(v.peak.frequency, clamp(f1 * (1.94 + 0.2 * a.load), 400, 9000), t, 0.06);
      ramp(v.peak.Q, lerp(4, 9, clamp01(amt)), t, 0.08);
      ramp(v.lfoAmt.gain, 18 + 60 * amt, t, 0.1);
      // Rear squeal is the drift cue — give it a touch more presence.
      ramp(v.g.gain, amt * amt * (i === 0 ? 0.3 : 0.38) * gain, t, 0.035);
      a.amt = amt;
    }

    /* scrub */
    const scrubAmt = clamp01(lock * clamp01(speed / 9));
    ramp(this.scrubG.gain, scrubAmt * 0.3 * gain, t, 0.03);
    ramp(this.scrubLp.frequency, clamp(900 + 1800 * speedN, 300, 6000), t, 0.06);
    ramp(this.judder.frequency, clamp(22 + 46 * speedN, 8, 120), t, 0.06);
    ramp(this.judderAmt.gain, scrubAmt * 0.14 * gain, t, 0.05);

    /* loose surface spray */
    const looseAmt = clamp01(loose * (0.25 + 0.75 * clamp01(speed / 28)));
    ramp(this.sprayG.gain, looseAmt * 0.2 * gain, t, 0.06);
    ramp(this.sprayBp.frequency, clamp(1100 * looseBright + 2200 * speedN, 200, 9000), t, 0.08);
    ramp(this.sprayBp.Q, lerp(0.6, 1.6, looseAmt), t, 0.1);

    this.loudness = clamp01(Math.max(axle[0].amt ?? 0, axle[1].amt ?? 0) * 0.9 + scrubAmt * 0.5);
  }

  _quiet(t) {
    ramp(this.front.g.gain, 0, t, 0.08);
    ramp(this.rear.g.gain, 0, t, 0.08);
    ramp(this.scrubG.gain, 0, t, 0.08);
    ramp(this.sprayG.gain, 0, t, 0.08);
    this.loudness = 0;
  }

  dispose() {
    try {
      this.front.src.stop();
      this.rear.src.stop();
      this.scrubSrc.stop();
      this.spraySrc.stop();
      this.judder.stop();
      this.out.disconnect();
    } catch {
      /* ignore */
    }
  }
}
