/**
 * Procedural music bed. Original composition, generated live — a driving 16th-note pulse in A minor
 * that layers parts in and out with race state.
 *
 * Every instrument is a persistent monophonic voice retriggered by envelope, so the sequencer
 * allocates nothing. Scheduling is lookahead-based off `ac.currentTime` (never setInterval), so it
 * stays in time regardless of frame rate and works identically inside an OfflineAudioContext.
 *
 * Mix discipline: the whole bed is band-limited (nothing above ~9 kHz, little below 45 Hz) and
 * sidechained to the engine, so it occupies the gaps rather than competing.
 */
import { clamp, clamp01 } from '../core/MathX.js';
import { noiseSource, ramp, setNow, envAD } from './dsp.js';

const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);

// i – VI – III – VII in A minor. Root notes are MIDI numbers.
const PROG = [
  { root: 33, chord: [57, 60, 64] }, // Am
  { root: 29, chord: [53, 57, 60] }, // F
  { root: 36, chord: [55, 60, 64] }, // C
  { root: 31, chord: [55, 59, 62] }, // G
];

const BASS_STEPS = [0, 2, 3, 5, 6, 8, 10, 11, 13, 14];
const BASS_OCT = { 0: 0, 3: 0, 6: 12, 8: 0, 11: 12, 14: 0 };
const ARP_STEPS = [0, 2, 4, 6, 8, 10, 12, 14];
const ARP_SHAPE = [0, 1, 2, 1, 2, 1, 0, 2];
const KICK_STEPS = [0, 4, 8, 12];
const HAT_STEPS = [2, 6, 10, 14];
const HAT_16 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const CLAP_STEPS = [4, 12];

/** Section mixes: which layers are audible and how bright. */
const SECTIONS = {
  idle: { pad: 0.55, bass: 0.0, kick: 0.0, hat: 0.0, clap: 0.0, arp: 0.18, lead: 0, cut: 900, tempo: 1 },
  menu: { pad: 0.6, bass: 0.35, kick: 0.0, hat: 0.22, clap: 0, arp: 0.3, lead: 0, cut: 1400, tempo: 1 },
  countdown: { pad: 0.7, bass: 0.5, kick: 0.0, hat: 0.3, clap: 0, arp: 0.25, lead: 0, cut: 1100, tempo: 1 },
  race: { pad: 0.34, bass: 0.9, kick: 0.85, hat: 0.5, clap: 0.4, arp: 0.5, lead: 0, cut: 3200, tempo: 1 },
  final: { pad: 0.3, bass: 1.0, kick: 0.95, hat: 0.72, clap: 0.55, arp: 0.62, lead: 0.5, cut: 5200, tempo: 1.045 },
  finish: { pad: 0.75, bass: 0.28, kick: 0.0, hat: 0.0, clap: 0, arp: 0.34, lead: 0.22, cut: 1800, tempo: 0.98 },
};

export class MusicBed {
  constructor(ac, o = {}) {
    this.ac = ac;
    const t0 = o.startTime ?? ac.currentTime;
    this.bpm = o.bpm ?? 126;
    this.step = 0;
    this.nextStepTime = t0 + 0.08;
    this.section = 'idle';
    this.target = SECTIONS.idle;
    this.mix = { ...SECTIONS.idle };
    this.enabled = true;

    this.out = ac.createGain();
    this.out.gain.value = 1;
    this.duck = ac.createGain();
    this.duck.gain.value = 1;
    // Keep the bed out of the engine's way at both ends of the spectrum.
    this.tone = ac.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 9000;
    this.tone.Q.value = 0.6;
    this.hp = ac.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 34;
    // A drum-driven bed has a ~19 dB crest factor; without glue compression it has to sit so low
    // that it disappears under the engine. Compress, then make up — same peak, ~9 dB more body.
    this.glue = ac.createDynamicsCompressor();
    this.glue.threshold.value = -20;
    this.glue.knee.value = 8;
    this.glue.ratio.value = 4;
    this.glue.attack.value = 0.006;
    this.glue.release.value = 0.18;
    this.makeup = ac.createGain();
    this.makeup.gain.value = 2.4;
    this.out.connect(this.tone).connect(this.hp).connect(this.glue).connect(this.makeup).connect(this.duck);
    if (o.dest) this.duck.connect(o.dest);

    // shared short delay for arp/lead — costs one node pair, adds a lot of space
    this.delay = ac.createDelay(1.0);
    this.delay.delayTime.value = (60 / this.bpm) * 0.75;
    this.fb = ac.createGain();
    this.fb.gain.value = 0.3;
    this.delayTone = ac.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayTone.frequency.value = 2600;
    this.delay.connect(this.delayTone).connect(this.fb).connect(this.delay);
    this.delayTone.connect(this.out);

    this._buildVoices(t0);
    this._applyMix(t0, true);
  }

  _buildVoices(t0) {
    const ac = this.ac;

    /* ---- pad: three detuned sawtooth pairs, slow filter ---- */
    this.padOsc = [];
    this.padFilter = ac.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 700;
    this.padFilter.Q.value = 1.1;
    this.padGain = ac.createGain();
    this.padGain.gain.value = 0;
    this.padFilter.connect(this.padGain).connect(this.out);
    for (let i = 0; i < 6; i++) {
      const o = ac.createOscillator();
      o.type = i % 2 ? 'sawtooth' : 'triangle';
      o.frequency.value = 220;
      o.detune.value = i % 2 ? 7 : -7;
      const g = ac.createGain();
      g.gain.value = 0.16;
      o.connect(g).connect(this.padFilter);
      o.start(t0);
      this.padOsc.push(o);
    }
    // slow movement so the pad breathes
    this.padLfo = ac.createOscillator();
    this.padLfo.type = 'sine';
    this.padLfo.frequency.value = 0.07;
    this.padLfoAmt = ac.createGain();
    this.padLfoAmt.gain.value = 180;
    this.padLfo.connect(this.padLfoAmt).connect(this.padFilter.frequency);
    this.padLfo.start(t0);

    /* ---- bass: saw pair + sub ---- */
    this.bassFilter = ac.createBiquadFilter();
    this.bassFilter.type = 'lowpass';
    this.bassFilter.frequency.value = 500;
    this.bassFilter.Q.value = 6;
    this.bassGain = ac.createGain();
    this.bassGain.gain.value = 0;
    this.bassLevel = ac.createGain();
    this.bassLevel.gain.value = 0;
    this.bassFilter.connect(this.bassGain).connect(this.bassLevel).connect(this.out);
    this.bassOsc = [];
    for (let i = 0; i < 2; i++) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = i ? 9 : -9;
      const g = ac.createGain();
      g.gain.value = 0.3;
      o.connect(g).connect(this.bassFilter);
      o.start(t0);
      this.bassOsc.push(o);
    }
    this.subOsc = ac.createOscillator();
    this.subOsc.type = 'sine';
    this.subGain = ac.createGain();
    this.subGain.gain.value = 0.42;
    this.subOsc.connect(this.subGain).connect(this.bassGain);
    this.subOsc.start(t0);

    /* ---- kick ---- */
    this.kickOsc = ac.createOscillator();
    this.kickOsc.type = 'sine';
    this.kickOsc.frequency.value = 50;
    this.kickGain = ac.createGain();
    this.kickGain.gain.value = 0;
    this.kickLevel = ac.createGain();
    this.kickLevel.gain.value = 0;
    this.kickOsc.connect(this.kickGain).connect(this.kickLevel).connect(this.out);
    this.kickOsc.start(t0);
    this.kickClickSrc = noiseSource(ac, 'white');
    this.kickClickHp = ac.createBiquadFilter();
    this.kickClickHp.type = 'highpass';
    this.kickClickHp.frequency.value = 1400;
    this.kickClick = ac.createGain();
    this.kickClick.gain.value = 0;
    this.kickClickSrc.connect(this.kickClickHp).connect(this.kickClick).connect(this.kickLevel);
    this.kickClickSrc.start(t0);

    /* ---- hat ---- */
    this.hatSrc = noiseSource(ac, 'white');
    this.hatHp = ac.createBiquadFilter();
    this.hatHp.type = 'highpass';
    this.hatHp.frequency.value = 7200;
    this.hatBp = ac.createBiquadFilter();
    this.hatBp.type = 'bandpass';
    this.hatBp.frequency.value = 9600;
    this.hatBp.Q.value = 1.1;
    this.hatGain = ac.createGain();
    this.hatGain.gain.value = 0;
    this.hatLevel = ac.createGain();
    this.hatLevel.gain.value = 0;
    this.hatSrc.connect(this.hatHp).connect(this.hatBp).connect(this.hatGain).connect(this.hatLevel).connect(this.out);
    this.hatSrc.start(t0);

    /* ---- clap ---- */
    this.clapSrc = noiseSource(ac, 'white');
    this.clapBp = ac.createBiquadFilter();
    this.clapBp.type = 'bandpass';
    this.clapBp.frequency.value = 1500;
    this.clapBp.Q.value = 1.4;
    this.clapPk = ac.createBiquadFilter();
    this.clapPk.type = 'peaking';
    this.clapPk.frequency.value = 2600;
    this.clapPk.Q.value = 2.4;
    this.clapPk.gain.value = 6;
    this.clapGain = ac.createGain();
    this.clapGain.gain.value = 0;
    this.clapLevel = ac.createGain();
    this.clapLevel.gain.value = 0;
    this.clapSrc.connect(this.clapBp).connect(this.clapPk).connect(this.clapGain).connect(this.clapLevel).connect(this.out);
    this.clapSrc.start(t0);

    /* ---- arp ---- */
    this.arpFilter = ac.createBiquadFilter();
    this.arpFilter.type = 'lowpass';
    this.arpFilter.frequency.value = 2200;
    this.arpFilter.Q.value = 7;
    this.arpGain = ac.createGain();
    this.arpGain.gain.value = 0;
    this.arpLevel = ac.createGain();
    this.arpLevel.gain.value = 0;
    this.arpFilter.connect(this.arpGain).connect(this.arpLevel);
    this.arpLevel.connect(this.out);
    this.arpSend = ac.createGain();
    this.arpSend.gain.value = 0.3;
    this.arpLevel.connect(this.arpSend).connect(this.delay);
    this.arpOsc = [];
    for (let i = 0; i < 2; i++) {
      const o = ac.createOscillator();
      o.type = i ? 'square' : 'sawtooth';
      o.detune.value = i ? 6 : -6;
      const g = ac.createGain();
      g.gain.value = i ? 0.16 : 0.24;
      o.connect(g).connect(this.arpFilter);
      o.start(t0);
      this.arpOsc.push(o);
    }

    /* ---- lead (final lap) ---- */
    this.leadFilter = ac.createBiquadFilter();
    this.leadFilter.type = 'lowpass';
    this.leadFilter.frequency.value = 3000;
    this.leadFilter.Q.value = 3;
    this.leadGain = ac.createGain();
    this.leadGain.gain.value = 0;
    this.leadLevel = ac.createGain();
    this.leadLevel.gain.value = 0;
    this.leadFilter.connect(this.leadGain).connect(this.leadLevel);
    this.leadLevel.connect(this.out);
    this.leadSend = ac.createGain();
    this.leadSend.gain.value = 0.34;
    this.leadLevel.connect(this.leadSend).connect(this.delay);
    this.leadOsc = [];
    for (let i = 0; i < 3; i++) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = (i - 1) * 11;
      const g = ac.createGain();
      g.gain.value = 0.17;
      o.connect(g).connect(this.leadFilter);
      o.start(t0);
      this.leadOsc.push(o);
    }

    /* ---- riser (countdown / final-lap transition) ---- */
    this.riserSrc = noiseSource(ac, 'pink');
    this.riserBp = ac.createBiquadFilter();
    this.riserBp.type = 'bandpass';
    this.riserBp.frequency.value = 300;
    this.riserBp.Q.value = 4;
    this.riserGain = ac.createGain();
    this.riserGain.gain.value = 0;
    this.riserSrc.connect(this.riserBp).connect(this.riserGain).connect(this.out);
    this.riserSrc.start(t0);
  }

  /* --------------------------------------------------------------- control */

  setSection(name, t = this.ac.currentTime) {
    if (!SECTIONS[name] || this.section === name) return;
    this.section = name;
    this.target = SECTIONS[name];
    this._applyMix(t, false);
  }

  _applyMix(t, instant) {
    const tc = instant ? 0.001 : 1.2;
    const m = this.target;
    ramp(this.padGain.gain, m.pad * 0.3, t, tc);
    ramp(this.bassLevel.gain, m.bass * 0.42, t, tc);
    ramp(this.kickLevel.gain, m.kick * 0.62, t, tc);
    ramp(this.hatLevel.gain, m.hat * 0.2, t, tc);
    ramp(this.clapLevel.gain, m.clap * 0.24, t, tc);
    ramp(this.arpLevel.gain, m.arp * 0.24, t, tc);
    ramp(this.leadLevel.gain, m.lead * 0.2, t, tc);
    ramp(this.padFilter.frequency, clamp(m.cut * 0.55, 120, 12000), t, tc);
    this.mix = m;
  }

  /** Upward sweep — used under the countdown and when the final lap starts. */
  riser(dur = 2.6, t = this.ac.currentTime) {
    setNow(this.riserBp.frequency, 180, t);
    this.riserBp.frequency.exponentialRampToValueAtTime(5200, t + dur);
    const g = this.riserGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0008, t);
    g.exponentialRampToValueAtTime(0.16, t + dur * 0.92);
    g.exponentialRampToValueAtTime(0.0008, t + dur + 0.35);
  }

  /** Big downbeat impact — race start / finish line. */
  hit(t = this.ac.currentTime, strength = 1) {
    setNow(this.kickOsc.frequency, 150, t);
    this.kickOsc.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    envAD(this.kickGain, t, 0.9 * strength, 0.002, 0.34);
    envAD(this.clapGain, t, 0.5 * strength, 0.002, 0.22);
    setNow(this.kickLevel.gain, Math.max(this.kickLevel.gain.value, 0.5), t);
    setNow(this.clapLevel.gain, Math.max(this.clapLevel.gain.value, 0.3), t);
  }

  /* ------------------------------------------------------------ sequencer */

  /** Lookahead scheduler. Call once per frame; `t` is the current audio time. */
  update(dt, t, o = {}) {
    if (!this.enabled) return;
    const lookahead = 0.24;
    const stepDur = 60 / (this.bpm * (this.mix.tempo ?? 1)) / 4;
    let guard = 0;
    while (this.nextStepTime < t + lookahead && guard++ < 64) {
      this._scheduleStep(this.step, this.nextStepTime, stepDur);
      this.nextStepTime += stepDur;
      this.step = (this.step + 1) % 64; // 4 bars
    }
    // If the context was suspended for a long time, resync instead of spraying notes.
    if (this.nextStepTime < t - 0.5) this.nextStepTime = t + 0.05;

    // sidechain: engine first, then transient sfx
    const duckAmt = clamp01((o.engine ?? 0) * 0.62 + (o.sfx ?? 0) * 0.5);
    ramp(this.duck.gain, 1 - duckAmt * 0.55, t, 0.09);
    ramp(this.delay.delayTime, stepDur * 3, t, 0.4);
    void dt;
  }

  _scheduleStep(step, t, stepDur) {
    const bar = (step >> 4) & 3;
    const s = step & 15;
    const ch = PROG[bar];
    const m = this.mix;

    /* pad follows the chord */
    if (s === 0) {
      for (let i = 0; i < 6; i++) {
        const n = ch.chord[i % 3] + (i >= 3 ? -12 : 0);
        ramp(this.padOsc[i].frequency, mtof(n), t, 0.25);
      }
    }

    /* bass */
    if (m.bass > 0.01 && BASS_STEPS.includes(s)) {
      const oct = BASS_OCT[s] ?? 0;
      const f = mtof(ch.root + oct);
      setNow(this.bassOsc[0].frequency, f, t);
      setNow(this.bassOsc[1].frequency, f, t);
      setNow(this.subOsc.frequency, f * 0.5, t);
      const accent = s === 0 || s === 8 ? 1 : 0.72;
      envAD(this.bassGain, t, 0.85 * accent, 0.004, stepDur * (s % 3 === 0 ? 1.5 : 0.85));
      setNow(this.bassFilter.frequency, clamp(f * (3 + 4 * accent) + m.cut * 0.15, 90, 6000), t);
      this.bassFilter.frequency.exponentialRampToValueAtTime(clamp(f * 2.2, 70, 4000), t + stepDur * 1.2);
    }

    /* drums */
    if (m.kick > 0.01 && KICK_STEPS.includes(s)) {
      setNow(this.kickOsc.frequency, 128, t);
      this.kickOsc.frequency.exponentialRampToValueAtTime(41, t + 0.11);
      envAD(this.kickGain, t, 0.95, 0.0015, 0.2);
      envAD(this.kickClick, t, 0.16, 0.0008, 0.012);
    }
    if (m.hat > 0.01) {
      const list = m.hat > 0.6 ? HAT_16 : HAT_STEPS;
      if (list.includes(s)) {
        const open = s === 14;
        setNow(this.hatBp.frequency, open ? 8200 : 10400, t);
        envAD(this.hatGain, t, open ? 0.5 : s % 2 ? 0.24 : 0.4, 0.0006, open ? 0.14 : 0.028);
      }
    }
    if (m.clap > 0.01 && CLAP_STEPS.includes(s)) {
      // three quick slaps then a body — a real clap is never one hit
      envAD(this.clapGain, t, 0.35, 0.001, 0.012);
      envAD(this.clapGain, t + 0.011, 0.45, 0.001, 0.014);
      envAD(this.clapGain, t + 0.024, 0.7, 0.001, 0.11);
    }

    /* arp */
    if (m.arp > 0.01 && ARP_STEPS.includes(s)) {
      const idx = ARP_SHAPE[ARP_STEPS.indexOf(s)];
      const n = ch.chord[idx] + (s >= 8 ? 12 : 0);
      const f = mtof(n);
      setNow(this.arpOsc[0].frequency, f, t);
      setNow(this.arpOsc[1].frequency, f, t);
      envAD(this.arpGain, t, 0.7, 0.003, stepDur * 1.1);
      setNow(this.arpFilter.frequency, clamp(f * 2 + m.cut, 200, 11000), t);
      this.arpFilter.frequency.exponentialRampToValueAtTime(clamp(f * 1.4 + 300, 150, 8000), t + stepDur * 1.6);
    }

    /* lead — sparse, only in the final-lap / finish sections */
    if (m.lead > 0.01 && (s === 0 || s === 6 || s === 11)) {
      const deg = [0, 2, 1][(bar + (s === 6 ? 1 : 0)) % 3];
      const f = mtof(ch.chord[deg] + 12);
      for (const o of this.leadOsc) setNow(o.frequency, f, t);
      envAD(this.leadGain, t, 0.6, 0.012, stepDur * (s === 0 ? 3.2 : 1.6));
      setNow(this.leadFilter.frequency, clamp(f * 3 + 900, 400, 12000), t);
    }
  }

  dispose() {
    try {
      for (const o of [...this.padOsc, ...this.bassOsc, ...this.arpOsc, ...this.leadOsc]) o.stop();
      this.subOsc.stop();
      this.kickOsc.stop();
      this.padLfo.stop();
      this.hatSrc.stop();
      this.clapSrc.stop();
      this.kickClickSrc.stop();
      this.riserSrc.stop();
      this.duck.disconnect();
    } catch {
      /* ignore */
    }
  }
}
