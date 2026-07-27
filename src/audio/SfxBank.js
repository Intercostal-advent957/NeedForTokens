/**
 * One-shot SFX. Every voice is built once at unlock and retriggered by re-scheduling envelopes —
 * no node is ever created while the game is running, so a 12-car pile-up costs zero allocations.
 *
 * The metallic crunch is a modal synthesis: a 3 ms noise burst excites a bank of very high-Q
 * bandpasses tuned to inharmonic ratios, and they ring down at different rates. That is how panel
 * steel actually behaves, and it is why it reads as metal rather than as "a noise burst".
 */
import { clamp, clamp01, lerp } from '../core/MathX.js';
import { noiseSource, envAD, ramp, setNow } from './dsp.js';

const NOOP_HANDLE = { stop() {}, setVolume() {}, setRate() {} };

/** Routes a voice either dry (2D) or through a panner (3D), with no graph churn. */
function makeRoute(ac, dry, spatialDest) {
  const input = ac.createGain();
  const dryG = ac.createGain();
  dryG.gain.value = 1;
  input.connect(dryG).connect(dry);
  let panner = null;
  let wetG = null;
  if (spatialDest) {
    panner = ac.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 8;
    panner.maxDistance = 400;
    panner.rolloffFactor = 1.2;
    wetG = ac.createGain();
    wetG.gain.value = 0;
    input.connect(wetG).connect(panner).connect(spatialDest);
  }
  return {
    input,
    place(pos, t) {
      if (!panner) return;
      if (pos) {
        if (panner.positionX) {
          setNow(panner.positionX, pos.x, t);
          setNow(panner.positionY, pos.y, t);
          setNow(panner.positionZ, pos.z, t);
        } else panner.setPosition?.(pos.x, pos.y, pos.z);
        setNow(wetG.gain, 1, t);
        setNow(dryG.gain, 0, t);
      } else {
        setNow(wetG.gain, 0, t);
        setNow(dryG.gain, 1, t);
      }
    },
  };
}

/* ------------------------------------------------------------------ voices */

function crunchVoice(ac, dry, spatial, t0, seed) {
  const route = makeRoute(ac, dry, spatial);
  const src = noiseSource(ac, 'white');
  const burst = ac.createGain();
  burst.gain.value = 0;
  src.connect(burst);
  src.start(t0);

  // Per-hit level sits BEFORE the routing split, or it would control nothing.
  const out = ac.createGain();
  out.gain.value = 0;
  out.connect(route.input);

  // modal bank — inharmonic, metal-plate-like
  const ratios = [1, 1.59, 2.37, 3.14, 4.51, 6.09, 8.2];
  const qs = [26, 34, 30, 22, 18, 14, 10];
  const gs = [1, 0.8, 0.66, 0.5, 0.36, 0.24, 0.15];
  const modes = ratios.map((r, i) => {
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 220 * r;
    f.Q.value = qs[i] * (0.85 + ((seed * 37 + i * 11) % 30) / 100);
    const g = ac.createGain();
    g.gain.value = gs[i];
    burst.connect(f).connect(g).connect(out);
    return { f, g, r };
  });

  // broadband crack + body boom
  const crack = ac.createBiquadFilter();
  crack.type = 'highpass';
  crack.frequency.value = 2200;
  const crackG = ac.createGain();
  crackG.gain.value = 0;
  src.connect(crack).connect(crackG).connect(out);

  const boomOsc = ac.createOscillator();
  boomOsc.type = 'sine';
  boomOsc.frequency.value = 70;
  const boomG = ac.createGain();
  boomG.gain.value = 0;
  boomOsc.connect(boomG).connect(out);
  boomOsc.start(t0);

  return { route, burst, modes, crack, crackG, boomOsc, boomG, out, until: 0 };
}

function thudVoice(ac, dry, spatial, t0) {
  const route = makeRoute(ac, dry, spatial);
  const src = noiseSource(ac, 'brown');
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 400;
  const g = ac.createGain();
  g.gain.value = 0;
  src.connect(lp).connect(g).connect(route.input);
  src.start(t0);

  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 62;
  const og = ac.createGain();
  og.gain.value = 0;
  osc.connect(og).connect(route.input);
  osc.start(t0);

  // suspension / bushing creak
  const cbp = ac.createBiquadFilter();
  cbp.type = 'bandpass';
  cbp.frequency.value = 780;
  cbp.Q.value = 5;
  const cg = ac.createGain();
  cg.gain.value = 0;
  src.connect(cbp).connect(cg).connect(route.input);

  return { route, lp, g, osc, og, cbp, cg, until: 0 };
}

function clunkVoice(ac, dry, spatial, t0) {
  const route = makeRoute(ac, dry, spatial);
  const src = noiseSource(ac, 'white');
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1900;
  bp.Q.value = 3.4;
  const g = ac.createGain();
  g.gain.value = 0;
  src.connect(bp).connect(g).connect(route.input);
  src.start(t0);

  const osc = ac.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = 180;
  const og = ac.createGain();
  og.gain.value = 0;
  osc.connect(og).connect(route.input);
  osc.start(t0);
  return { route, bp, g, osc, og, until: 0 };
}

function popVoice(ac, dry, spatial, t0) {
  const route = makeRoute(ac, dry, spatial);
  const src = noiseSource(ac, 'white');
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 900;
  bp.Q.value = 1.6;
  const g = ac.createGain();
  g.gain.value = 0;
  src.connect(bp).connect(g).connect(route.input);
  src.start(t0);

  // the "thump" of unburnt fuel lighting in the pipe
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 150;
  const og = ac.createGain();
  og.gain.value = 0;
  osc.connect(og).connect(route.input);
  osc.start(t0);
  return { route, bp, g, osc, og, until: 0 };
}

function toneVoice(ac, dry, t0) {
  const osc = ac.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = 880;
  const osc2 = ac.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.value = 1760;
  const g2 = ac.createGain();
  g2.gain.value = 0.3;
  const g = ac.createGain();
  g.gain.value = 0;
  osc.connect(g);
  osc2.connect(g2).connect(g);
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5200;
  g.connect(lp).connect(dry);
  osc.start(t0);
  osc2.start(t0);
  return { osc, osc2, g, lp, until: 0 };
}

/* ------------------------------------------------------------------- bank */

export class SfxBank {
  constructor(ac, o = {}) {
    this.ac = ac;
    const t0 = o.startTime ?? ac.currentTime;
    this.dry = o.dest;
    this.spatialDest = o.spatialDest ?? null;
    this.reverbSend = o.reverbSend ?? null;

    this.bus = ac.createGain();
    this.bus.gain.value = 1;
    if (this.dry) this.bus.connect(this.dry);
    if (this.reverbSend) {
      this.send = ac.createGain();
      this.send.gain.value = 0.25;
      this.bus.connect(this.send).connect(this.reverbSend);
    }

    const n = o.pool ?? { crunch: 3, thud: 2, clunk: 3, pop: 3, tone: 2 };
    this.pools = {
      crunch: Array.from({ length: n.crunch }, (_, i) => crunchVoice(ac, this.bus, this.spatialDest, t0, i)),
      thud: Array.from({ length: n.thud }, () => thudVoice(ac, this.bus, this.spatialDest, t0)),
      clunk: Array.from({ length: n.clunk }, () => clunkVoice(ac, this.bus, this.spatialDest, t0)),
      pop: Array.from({ length: n.pop }, () => popVoice(ac, this.bus, this.spatialDest, t0)),
      tone: Array.from({ length: n.tone }, () => toneVoice(ac, this.bus, t0)),
    };

    /* ------- sustained voices ------- */
    this.scrape = this._buildScrape(t0);
    this.nos = this._buildNos(t0);

    this.loudness = 0;
    this._decay = 0;
  }

  /** Least-recently-finished voice; steals the oldest if all are busy. Caps polyphony for free. */
  _take(kind, t) {
    const pool = this.pools[kind];
    if (!pool?.length) return null;
    let best = pool[0];
    for (const v of pool) {
      if (v.until <= t) return v;
      if (v.until < best.until) best = v;
    }
    return best;
  }

  /* ---------------------------------------------------------- scrape (sustained) */
  _buildScrape(t0) {
    const ac = this.ac;
    const route = makeRoute(ac, this.bus, this.spatialDest);
    const src = noiseSource(ac, 'white');
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 2.2;
    const pk = ac.createBiquadFilter();
    pk.type = 'peaking';
    pk.frequency.value = 5200;
    pk.Q.value = 3;
    pk.gain.value = 8;
    const g = ac.createGain();
    g.gain.value = 0;
    src.connect(bp).connect(pk).connect(g).connect(route.input);
    src.start(t0);
    // grinding modulation
    const lfo = ac.createOscillator();
    lfo.type = 'sawtooth';
    lfo.frequency.value = 41;
    const lfoAmt = ac.createGain();
    lfoAmt.gain.value = 0;
    lfo.connect(lfoAmt).connect(g.gain);
    lfo.start(t0);
    return { route, bp, pk, g, lfo, lfoAmt, level: 0 };
  }

  /* ---------------------------------------------------------- NOS (sustained) */
  _buildNos(t0) {
    const ac = this.ac;
    const src = noiseSource(ac, 'white');
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 4200;
    bp.Q.value = 1.1;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const g = ac.createGain();
    g.gain.value = 0;
    src.connect(hp).connect(bp).connect(g).connect(this.bus);
    src.start(t0);

    // the pitched whoosh that rides the hiss on activation
    const sweepSrc = noiseSource(ac, 'pink');
    const sweepBp = ac.createBiquadFilter();
    sweepBp.type = 'bandpass';
    sweepBp.frequency.value = 400;
    sweepBp.Q.value = 4.5;
    const sweepG = ac.createGain();
    sweepG.gain.value = 0;
    sweepSrc.connect(sweepBp).connect(sweepG).connect(this.bus);
    sweepSrc.start(t0);

    const tone = ac.createOscillator();
    tone.type = 'sine';
    tone.frequency.value = 220;
    const toneG = ac.createGain();
    toneG.gain.value = 0;
    tone.connect(toneG).connect(this.bus);
    tone.start(t0);

    return { src, bp, hp, g, sweepBp, sweepG, tone, toneG, active: false };
  }

  /* ------------------------------------------------------------------ API */

  /**
   * @param {string} name
   * @param {object} opts { volume, strength, position, rate, surface }
   * @param {number} t
   */
  trigger(name, opts = {}, t = this.ac.currentTime) {
    const vol = clamp(opts.volume ?? 1, 0, 4);
    const str = clamp01(opts.strength ?? 1);
    const pos = opts.position || null;
    switch (name) {
      case 'impact':
      case 'crunch':
      case 'collision':
        return this._impact(str, vol, pos, t, opts.tag);
      case 'land':
      case 'thud':
        return this._land(str, vol, pos, t);
      case 'shift':
        return this._shift(str, vol, pos, t, opts.up !== false);
      case 'backfire':
      case 'pop':
        return this._pop(str, vol, pos, t);
      case 'nos':
        return this._nos(opts.active !== false, vol, t);
      case 'scrape':
        this.scrape.level = Math.max(this.scrape.level, str);
        this.scrape.route.place(pos, t);
        return this._handleFor(this.scrape.g, null);
      case 'countdown':
        return this._tone(opts.final ? 1320 : 660, opts.final ? 0.55 : 0.2, vol * (opts.final ? 1 : 0.75), t);
      case 'ui':
      case 'beep':
        return this._tone(opts.freq ?? 1180, 0.09, vol * 0.35, t);
      case 'lap':
        return this._tone(opts.freq ?? 990, 0.28, vol * 0.5, t);
      default:
        return NOOP_HANDLE;
    }
  }

  _handleFor(gainNode, voice, baseRate) {
    const ac = this.ac;
    return {
      stop: () => {
        const t = ac.currentTime;
        gainNode.gain.cancelScheduledValues(t);
        gainNode.gain.setTargetAtTime(0, t, 0.02);
        if (voice) voice.until = t;
      },
      setVolume: (v) => ramp(gainNode.gain, clamp(v, 0, 4), ac.currentTime, 0.03),
      setRate: (r) => {
        if (!voice || !baseRate) return;
        const f = clamp(baseRate * (Number.isFinite(r) ? r : 1), 20, 18000);
        if (voice.bp) ramp(voice.bp.frequency, f, ac.currentTime, 0.02);
        if (voice.osc) ramp(voice.osc.frequency, f * 0.12, ac.currentTime, 0.02);
      },
    };
  }

  _impact(str, vol, pos, t, tag) {
    const v = this._take('crunch', t);
    if (!v) return NOOP_HANDLE;
    v.route.place(pos, t);
    // Heavier hits ring lower and longer; car-on-car is duller than car-on-barrier.
    const metal = tag === 'car' ? 0.6 : 1;
    const base = lerp(340, 130, str) * (tag === 'prop' ? 1.5 : 1);
    const ring = lerp(0.14, 0.6, str) * metal;
    for (const m of v.modes) {
      setNow(m.f.frequency, clamp(base * m.r, 30, 16000), t);
    }
    // 3 ms excitation burst — the filters do the rest
    envAD(v.burst, t, 0.9 * (0.4 + 0.6 * str), 0.0016, 0.006 + 0.02 * str);
    envAD(v.crackG, t, 0.32 * str * metal, 0.001, 0.03 + 0.05 * str);
    setNow(v.crack.frequency, lerp(3400, 1500, str), t);
    // low body boom
    setNow(v.boomOsc.frequency, lerp(96, 48, str), t);
    v.boomOsc.frequency.exponentialRampToValueAtTime(lerp(70, 33, str), t + 0.12);
    envAD(v.boomG, t, 0.5 * str, 0.004, 0.1 + 0.22 * str);
    const level = clamp(0.62 * vol * (0.25 + 0.75 * str), 0, 1.4);
    setNow(v.out.gain, level, t);
    v.until = t + ring + 0.3;
    this._decay = Math.max(this._decay, 0.35 + str * 0.5);
    return this._handleFor(v.out, v, base);
  }

  _land(str, vol, pos, t) {
    const v = this._take('thud', t);
    if (!v) return NOOP_HANDLE;
    v.route.place(pos, t);
    const f = lerp(78, 44, str);
    setNow(v.osc.frequency, f * 1.8, t);
    v.osc.frequency.exponentialRampToValueAtTime(f, t + 0.09);
    envAD(v.og, t, 0.55 * vol * (0.35 + 0.65 * str), 0.004, 0.16 + 0.2 * str);
    setNow(v.lp.frequency, lerp(280, 620, str), t);
    envAD(v.g, t, 0.4 * vol * str, 0.003, 0.11 + 0.14 * str);
    setNow(v.cbp.frequency, lerp(950, 640, str), t);
    envAD(v.cg, t, 0.12 * vol * str, 0.006, 0.13);
    v.until = t + 0.45;
    this._decay = Math.max(this._decay, 0.3 * str);
    return this._handleFor(v.og, v, f);
  }

  _shift(str, vol, pos, t, up) {
    const v = this._take('clunk', t);
    if (!v) return NOOP_HANDLE;
    v.route.place(pos, t);
    setNow(v.bp.frequency, up ? 2400 : 1700, t);
    v.bp.frequency.exponentialRampToValueAtTime(up ? 1200 : 900, t + 0.05);
    envAD(v.g, t, 0.2 * vol * (0.5 + 0.5 * str), 0.0012, 0.045);
    setNow(v.osc.frequency, up ? 230 : 175, t);
    v.osc.frequency.exponentialRampToValueAtTime(up ? 120 : 96, t + 0.07);
    envAD(v.og, t, 0.14 * vol, 0.002, 0.07);
    v.until = t + 0.16;
    return this._handleFor(v.g, v, 2400);
  }

  _pop(str, vol, pos, t) {
    const v = this._take('pop', t);
    if (!v) return NOOP_HANDLE;
    v.route.place(pos, t);
    const f = lerp(700, 1500, Math.random() * 0.5 + str * 0.5);
    setNow(v.bp.frequency, f, t);
    v.bp.frequency.exponentialRampToValueAtTime(f * 0.45, t + 0.06);
    setNow(v.bp.Q, lerp(1.1, 2.6, str), t);
    envAD(v.g, t, 0.42 * vol * (0.35 + 0.65 * str), 0.0008, 0.035 + 0.05 * str);
    setNow(v.osc.frequency, lerp(190, 120, str), t);
    v.osc.frequency.exponentialRampToValueAtTime(lerp(110, 62, str), t + 0.07);
    envAD(v.og, t, 0.3 * vol * str, 0.002, 0.06 + 0.06 * str);
    v.until = t + 0.2;
    return this._handleFor(v.g, v, f);
  }

  _tone(freq, dur, vol, t) {
    const v = this._take('tone', t);
    if (!v) return NOOP_HANDLE;
    setNow(v.osc.frequency, freq, t);
    setNow(v.osc2.frequency, freq * 2.001, t);
    setNow(v.lp.frequency, clamp(freq * 5, 200, 16000), t);
    envAD(v.g, t, clamp(0.16 * vol, 0, 0.5), 0.006, dur);
    v.until = t + dur + 0.05;
    return this._handleFor(v.g, v, freq);
  }

  _nos(active, vol, t) {
    const n = this.nos;
    n.active = active;
    if (active) {
      // pressurised release: hiss swells, whoosh sweeps up, bottle tone drops away
      ramp(n.g.gain, 0.17 * vol, t, 0.05);
      setNow(n.bp.frequency, 2600, t);
      n.bp.frequency.exponentialRampToValueAtTime(5200, t + 0.35);
      setNow(n.sweepBp.frequency, 260, t);
      n.sweepBp.frequency.exponentialRampToValueAtTime(3800, t + 0.42);
      envAD(n.sweepG, t, 0.3 * vol, 0.02, 0.5);
      setNow(n.tone.frequency, 140, t);
      n.tone.frequency.exponentialRampToValueAtTime(520, t + 0.3);
      envAD(n.toneG, t, 0.07 * vol, 0.02, 0.34);
    } else {
      // cut-out: pressure drops, a short valve chirp on the way down
      ramp(n.g.gain, 0, t, 0.06);
      setNow(n.bp.frequency, Math.max(n.bp.frequency.value, 1500), t);
      n.bp.frequency.exponentialRampToValueAtTime(900, t + 0.22);
      setNow(n.sweepBp.frequency, 2600, t);
      n.sweepBp.frequency.exponentialRampToValueAtTime(420, t + 0.2);
      envAD(n.sweepG, t, 0.14 * vol, 0.008, 0.2);
    }
    return this._handleFor(n.g, null);
  }

  /** Called every frame: decays the sustained scrape and reports SFX loudness for ducking. */
  update(dt, t, o = {}) {
    const s = this.scrape;
    s.level = Math.max(0, s.level - dt * 3.2);
    const spd = clamp01((o.speed ?? 0) / 45);
    ramp(s.g.gain, s.level * 0.26 * (0.3 + 0.7 * spd), t, 0.04);
    ramp(s.bp.frequency, clamp(1600 + 3400 * spd, 300, 12000), t, 0.06);
    ramp(s.lfo.frequency, clamp(28 + 90 * spd, 8, 400), t, 0.06);
    ramp(s.lfoAmt.gain, s.level * 0.1, t, 0.05);
    this._decay = Math.max(0, this._decay - dt * 1.6);
    this.loudness = clamp01(Math.max(this._decay, s.level * 0.8));
  }

  dispose() {
    try {
      this.bus.disconnect();
    } catch {
      /* ignore */
    }
  }
}
