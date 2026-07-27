/**
 * Need for Tokens — audio. Everything is synthesised at runtime with the Web Audio API.
 * There are no sample files, no fetches and no downloads. See CONTRACTS.md §12.
 *
 * Signal flow
 * -----------
 *                       ┌────────── reverbSend ──► convolver ──► verbReturn ──┐
 *   engine (player) ────┤                                                     │
 *   opponent engines ───┤──► spatialBus ─┐                                    │
 *   tyres ──────────────┤                ├──► sfxSum (sfxVolume) ─────────────┼──► preMaster
 *   wind / road ────────┤ (ducked)       │                                    │       │
 *   one-shot sfx ───────┘                ┘                                    │   limiter
 *   music (ducked by engine + sfx) ──────────► musicBus (musicVolume) ────────┘       │
 *                                                                                 softClip
 *                                                                                     │
 *                                                                        master (masterVolume)
 *                                                                                     │
 *                                                                                destination
 *
 * The limiter is a hard-knee compressor; the soft clipper after it is a tanh curve, so the final
 * output is mathematically incapable of exceeding full scale no matter what the game throws at it.
 */
import { clamp, clamp01, damp } from '../core/MathX.js';
import { buildImpulseResponse, softClipCurve, ramp, noiseBuffer } from './dsp.js';
import { EngineVoice } from './EngineVoice.js';
import { TyreVoice } from './TyreVoice.js';
import { AmbienceVoice } from './AmbienceVoice.js';
import { SfxBank } from './SfxBank.js';
import { MusicBed } from './MusicBed.js';
import { profileNameForCar } from './engineProfiles.js';

const NOOP = { stop() {}, setVolume() {}, setRate() {} };

const TIER = {
  low: { opponents: 0, hrtf: false, verb: 0.55, harmonics: 128, music: true },
  medium: { opponents: 2, hrtf: false, verb: 0.8, harmonics: 176, music: true },
  high: { opponents: 4, hrtf: true, verb: 0.95, harmonics: 240, music: true },
  ultra: { opponents: 5, hrtf: true, verb: 1.2, harmonics: 288, music: true },
};

export class AudioSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = true;
    this.masterVolume = 0.75;
    this.musicVolume = 0.5;
    this.sfxVolume = 0.9;
    this.ac = null;
    this.unlocked = false;
    this.listenerCamera = null;

    this._tier = TIER.high;
    this._deferred = [];
    this._opponentSlots = [];
    this._rebindCooldown = 0;
    this._engineDuck = 0;
    this._sfxDuck = 0;
    this._camMode = 'chase';
    this._lastVols = { m: -1, s: -1, mu: -1, en: null };
    this._listenerPos = { x: 0, y: 0, z: 0 };
    this._listenerVel = { x: 0, y: 0, z: 0 };
    this._lastListener = null;
    this._playerThrottle = 0;
    this._unsub = [];
    this._scrapeCarryover = 0;
    /**
     * Self-test hook. When non-null every schedule uses this instead of `ac.currentTime`, which is
     * what lets the whole system be driven deterministically inside an OfflineAudioContext.
     */
    this.offlineTime = null;
    this.stats = { voices: 0, opponents: 0, profile: '—' };
  }

  /** Current schedule time (see `offlineTime`). */
  _t() {
    return this.offlineTime ?? this.ac?.currentTime ?? 0;
  }

  /**
   * True when it is safe to schedule sound. Before the user's first gesture the context is
   * suspended and its clock is frozen — scheduling then would pile every event onto t=0 and fire
   * them all at once the moment audio starts.
   */
  _live() {
    return (
      this.unlocked &&
      this.enabled &&
      !!this.ac &&
      (this.offlineTime !== null || this.ac.state !== 'suspended')
    );
  }

  async init() {
    const bus = this.ctx?.bus;
    if (!bus) return this;
    const on = (name, fn) => this._unsub.push(bus.on(name, fn));

    on('car:shift', (e) => this._onShift(e));
    on('car:backfire', (e) => this._onBackfire(e));
    on('car:nos', (e) => this._onNos(e));
    on('car:collision', (e) => this._onCollision(e));
    on('car:land', (e) => this._onLand(e));
    on('race:countdown', (e) => this._onCountdown(e));
    on('race:start', () => this._onStart());
    on('race:finish', () => this._onFinish());
    on('lap:complete', (e) => this._onLap(e));
    on('camera:mode', (e) => (this._camMode = e?.mode ?? 'chase'));
    on('quality:change', (e) => this.onQuality(e?.tier));

    // Create the context here, during boot, rather than in the gesture handler. A browser will
    // happily construct an AudioContext without a gesture — it just starts `suspended` — and the
    // construction itself costs ~90 ms of audio-device startup. Paying that behind the loading
    // screen means unlock() is a resume() and never hitches the first frame of gameplay.
    this._createContext();
    return this;
  }

  /* ------------------------------------------------------------ lifecycle */

  _createContext() {
    if (this.ac) return true;
    try {
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return false;
      this._buildMaster(new AC({ latencyHint: 'interactive' }));
      this.unlocked = true;
      // Voice construction is drained one task per frame in update(), so no single frame pays for
      // the whole graph.
      this._deferred = [
        // Generating a noise bed is the single most expensive task here (a 2 s stereo buffer is
        // ~400k samples on a 96 kHz device), so each colour gets its own frame.
        () => noiseBuffer(this.ac, 'white'),
        () => noiseBuffer(this.ac, 'pink'),
        () => noiseBuffer(this.ac, 'brown'),
        () => this._buildAmbience(),
        () => this._buildEngine(),
        () => this._buildSfx(),
        () => this._buildTyres(),
        () => this._buildReverb(0),
        () => this._buildReverb(1),
        () => this._buildMusic(),
        () => this._buildOpponents(),
      ];
      return true;
    } catch (e) {
      console.warn('[audio] unavailable:', e);
      this.enabled = false;
      return false;
    }
  }

  /**
   * Called from a user gesture (main.js arms it on first pointerdown/keydown). By this point the
   * graph already exists, so this is a resume() — sub-millisecond.
   */
  unlock() {
    if (!this.ac && !this._createContext()) return;
    try {
      this.ac.resume?.();
    } catch (e) {
      console.warn('[audio] resume failed:', e);
    }
  }

  /** True once the context is actually producing sound (i.e. the gesture has happened). */
  get running() {
    return !!this.ac && this.ac.state === 'running';
  }

  /** Build against an explicit context (used by the offline self-test). */
  attachContext(ac, opts = {}) {
    this.ac = null;
    this._buildMaster(ac);
    this.unlocked = true;
    this._tier = TIER[opts.tier] ?? this._tier;
    this._buildAmbience();
    this._buildEngine(opts.def);
    this._buildSfx();
    this._buildTyres();
    this._buildReverb(0);
    this._buildReverb(1);
    if (opts.music !== false) this._buildMusic();
    this._deferred = [];
    return this;
  }

  _buildMaster(ac) {
    this.ac = ac;
    const t0 = ac.currentTime;
    this._startTime = t0;

    this.master = ac.createGain();
    this.master.gain.value = this.enabled ? this.masterVolume : 0;
    this.master.connect(ac.destination);

    // Final safety net: tanh soft clip — |y| < 1 for any input.
    this.softClip = ac.createWaveShaper();
    this.softClip.curve = softClipCurve(1.35);
    this.softClip.oversample = '2x';
    this.softClip.connect(this.master);

    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -3.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.limiter.connect(this.softClip);

    this.preMaster = ac.createGain();
    this.preMaster.gain.value = 0.72; // headroom
    this.preMaster.connect(this.limiter);

    this.sfxSum = ac.createGain();
    this.sfxSum.gain.value = this.sfxVolume;
    this.sfxSum.connect(this.preMaster);

    this.musicBus = ac.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.musicBus.connect(this.preMaster);

    this.engineBus = ac.createGain();
    this.engineBus.gain.value = 0.55;
    this.engineBus.connect(this.sfxSum);

    this.spatialBus = ac.createGain();
    this.spatialBus.gain.value = 0.8;
    this.spatialBus.connect(this.sfxSum);

    this.ambBus = ac.createGain();
    this.ambBus.gain.value = 0.7;
    this.ambBus.connect(this.sfxSum);

    this.sfxBus = ac.createGain();
    this.sfxBus.gain.value = 0.85;
    this.sfxBus.connect(this.sfxSum);

    // Sends exist immediately; the convolver is spliced in when it is built.
    this.reverbSend = ac.createGain();
    this.reverbSend.gain.value = 1;
    this.verbReturn = ac.createGain();
    this.verbReturn.gain.value = 0.5;
    this.verbReturn.connect(this.sfxSum);

    if (ac.listener?.forwardX) {
      ac.listener.forwardX.value = 0;
      ac.listener.forwardY.value = 0;
      ac.listener.forwardZ.value = -1;
      ac.listener.upX.value = 0;
      ac.listener.upY.value = 1;
      ac.listener.upZ.value = 0;
    }
  }

  _verbOpts() {
    return { seconds: this._tier.verb, decay: 2.4, damping: 0.5, predelay: 0.014 };
  }

  /**
   * The IR is rendered one channel per frame — a 1 s stereo tail is ~200k samples per channel and
   * rendering both at once is the single largest frame cost in the whole build.
   */
  _buildReverb(channel) {
    const ac = this.ac;
    if (!ac || this.convolver) return;
    const o = this._verbOpts();
    if (!this._verbBuffer) {
      this._verbBuffer = ac.createBuffer(2, Math.max(16, Math.floor(ac.sampleRate * o.seconds)), ac.sampleRate);
    }
    buildImpulseResponse(ac, { ...o, into: this._verbBuffer, only: channel });
    if (channel !== 1) return;
    this.convolver = ac.createConvolver();
    this.convolver.normalize = false;
    this.convolver.buffer = this._verbBuffer;
    this.reverbSend.connect(this.convolver).connect(this.verbReturn);
  }

  _buildAmbience() {
    if (this.ambience || !this.ac) return;
    this.ambience = new AmbienceVoice(this.ac, {
      dest: this.ambBus,
      startTime: this._startTime,
    });
  }

  _buildEngine(defOverride) {
    if (!this.ac) return;
    const def = defOverride ?? this.ctx?.cars?.player?.def ?? this.ctx?.player?.def;
    if (!def) return; // retried next frame
    if (this.engine && this.engine.def === def) return;
    this.engine?.dispose();
    this.engine = new EngineVoice(this.ac, def, {
      dest: this.engineBus,
      reverbSend: this.reverbSend,
      harmonics: this._tier.harmonics,
      startTime: this.ac.currentTime,
    });
    this.stats.profile = profileNameForCar(def);
  }

  _buildSfx() {
    if (this.sfx || !this.ac) return;
    this.sfx = new SfxBank(this.ac, {
      dest: this.sfxBus,
      spatialDest: this.spatialBus,
      reverbSend: this.reverbSend,
      startTime: this._startTime,
    });
  }

  _buildTyres() {
    if (this.tyres || !this.ac) return;
    this.tyres = new TyreVoice(this.ac, {
      dest: this.sfxBus,
      reverbSend: this.reverbSend,
      startTime: this._startTime,
    });
  }

  _buildMusic() {
    if (this.music || !this.ac || !this._tier.music) return;
    this.music = new MusicBed(this.ac, { dest: this.musicBus, startTime: this.ac.currentTime });
    const phase = this.ctx?.race?.phase;
    this.music.setSection(phase === 'racing' ? 'race' : phase === 'countdown' ? 'countdown' : 'idle');
  }

  _buildOpponents() {
    const n = this._tier.opponents;
    while (this._opponentSlots.length > n) this._opponentSlots.pop()?.voice?.dispose();
    while (this._opponentSlots.length < n) this._opponentSlots.push({ car: null, voice: null });
  }

  onQuality(tier) {
    const t = TIER[tier] ?? TIER[this.ctx?.settings?.tier] ?? TIER.high;
    this._tier = t;
    if (!this.unlocked) return;
    this._buildOpponents();
    if (this.convolver && this.convolver.buffer && Math.abs(this.convolver.buffer.duration - t.verb) > 0.2) {
      this._verbBuffer = null;
      this.convolver.buffer = buildImpulseResponse(this.ac, this._verbOpts());
    }
  }

  /* -------------------------------------------------------------- listener */

  setListener(camera) {
    this.listenerCamera = camera ?? null;
  }

  _updateListener(t, dt) {
    const ac = this.ac;
    const cam = this.listenerCamera ?? this.ctx?.camera;
    const L = ac?.listener;
    if (!cam || !L) return;
    const m = cam.matrixWorld?.elements;
    if (!m) return;

    const px = m[12];
    const py = m[13];
    const pz = m[14];
    // Three.js camera looks down its local -Z.
    const fx = -m[8];
    const fy = -m[9];
    const fz = -m[10];
    const ux = m[4];
    const uy = m[5];
    const uz = m[6];

    if (this._lastListener && dt > 1e-4) {
      const k = clamp01(dt * 12);
      this._listenerVel.x += ((px - this._lastListener.x) / dt - this._listenerVel.x) * k;
      this._listenerVel.y += ((py - this._lastListener.y) / dt - this._listenerVel.y) * k;
      this._listenerVel.z += ((pz - this._lastListener.z) / dt - this._listenerVel.z) * k;
    }
    this._lastListener = this._lastListener || { x: px, y: py, z: pz };
    this._lastListener.x = px;
    this._lastListener.y = py;
    this._lastListener.z = pz;
    this._listenerPos.x = px;
    this._listenerPos.y = py;
    this._listenerPos.z = pz;

    if (L.positionX) {
      // Short time constants: the listener must not lag the camera or panning smears.
      ramp(L.positionX, px, t, 0.012);
      ramp(L.positionY, py, t, 0.012);
      ramp(L.positionZ, pz, t, 0.012);
      ramp(L.forwardX, fx, t, 0.02);
      ramp(L.forwardY, fy, t, 0.02);
      ramp(L.forwardZ, fz, t, 0.02);
      ramp(L.upX, ux, t, 0.05);
      ramp(L.upY, uy, t, 0.05);
      ramp(L.upZ, uz, t, 0.05);
    } else {
      L.setPosition?.(px, py, pz);
      L.setOrientation?.(fx, fy, fz, ux, uy, uz);
    }
  }

  /* ---------------------------------------------------------------- events */

  _carOf(e) {
    return e?.car ?? null;
  }

  _isPlayer(car) {
    const p = this.ctx?.cars?.player ?? this.ctx?.player;
    return !car || car === p;
  }

  /** World position for spatialised event sfx; null for the player (heard dry, in the cabin). */
  _posOf(car, fallback) {
    if (!car || this._isPlayer(car)) return null;
    return car.state?.position ?? fallback ?? null;
  }

  _onShift({ car, up } = {}) {
    if (!this._live()) return;
    const t = this._t();
    const player = this._isPlayer(car);
    this.sfx?.trigger('shift', { volume: player ? 1 : 0.5, up, position: this._posOf(car) }, t);
    if (player && this.engine) {
      if (up) {
        this.engine.cut(0.75, 0.06, t);
        this.engine.blowOff(0.9, t + 0.02);
        // Ignition-cut overrun crackle: two or three pops in the pipe, not one.
        const s = clamp01(this._playerThrottle);
        if (s > 0.35) {
          this.sfx?.trigger('backfire', { strength: 0.55 + 0.45 * s, volume: 0.9 }, t + 0.045);
          this.sfx?.trigger('backfire', { strength: 0.3 + 0.3 * s, volume: 0.6 }, t + 0.075);
          if (s > 0.7) this.sfx?.trigger('backfire', { strength: 0.4, volume: 0.45 }, t + 0.108);
        }
      } else {
        this.engine.cut(0.3, 0.04, t);
      }
    }
  }

  _onBackfire({ car, strength = 1 } = {}) {
    if (!this._live()) return;
    const t = this._t();
    this.sfx?.trigger('backfire', {
      strength: clamp01(strength),
      volume: this._isPlayer(car) ? 1 : 0.5,
      position: this._posOf(car),
    }, t);
  }

  _onNos({ car, active } = {}) {
    if (!this._live()) return;
    if (!this._isPlayer(car)) return;
    this.sfx?.trigger('nos', { active: !!active, volume: 1 }, this._t());
  }

  _onCollision({ car, impulse = 0, point, tag } = {}) {
    if (!this._live()) return;
    const t = this._t();
    // impulse arrives in N·s; normalise against a ~1.4 t car hitting a wall at ~25 m/s.
    const str = clamp01(Math.abs(impulse) / 34000);
    const vol = this._isPlayer(car) ? 1 : 0.55;
    if (str < 0.02) return;
    this.sfx?.trigger('impact', { strength: str, volume: vol, position: this._posOf(car, point), tag }, t);
    // Glancing hits leave a scrape behind them.
    const s = car?.state ?? this.ctx?.cars?.player?.state;
    const glancing = str < 0.35 && Math.abs(s?.speed ?? 0) > 8;
    if (glancing && this._isPlayer(car)) this._scrapeCarryover = Math.max(this._scrapeCarryover, 0.55);
  }

  _onLand({ car, impact = 0 } = {}) {
    if (!this._live()) return;
    const str = clamp01(Math.abs(impact) / 11);
    this.sfx?.trigger('land', {
      strength: str,
      volume: this._isPlayer(car) ? 1 : 0.5,
      position: this._posOf(car),
    }, this._t());
  }

  _onCountdown({ n } = {}) {
    if (!this._live()) return;
    const t = this._t();
    this.music?.setSection('countdown', t);
    if (n === 3) this.music?.riser(3.05, t);
    this.sfx?.trigger('countdown', { final: n === 0, volume: 1 }, t);
  }

  _onStart() {
    if (!this._live()) return;
    const t = this._t();
    this.music?.setSection('race', t);
    this.music?.hit(t, 1);
  }

  _onFinish() {
    if (!this._live()) return;
    const t = this._t();
    this.music?.setSection('finish', t);
    this.music?.hit(t, 0.8);
  }

  _onLap({ car, lap } = {}) {
    if (!this._live()) return;
    if (!this._isPlayer(car)) return;
    const t = this._t();
    this.sfx?.trigger('lap', { volume: 0.8 }, t);
    const total = this.ctx?.race?.totalLaps ?? 3;
    if (lap >= total - 1 && this.ctx?.race?.phase !== 'finished') {
      this.music?.setSection('final', t);
      this.music?.riser(2.2, t);
    }
  }

  /* -------------------------------------------------------------- public API */

  /**
   * Fire a one-shot (or toggle a sustained voice). Returns a handle even when audio is unavailable,
   * so callers never need to null-check.
   * @param {string} name  'shift'|'impact'|'backfire'|'land'|'nos'|'scrape'|'countdown'|'lap'|'ui'
   * @param {object} opts  { volume, strength, position:{x,y,z}, rate, up, active, tag, freq }
   */
  play(name, opts = {}) {
    if (!this._live() || !this.sfx) return NOOP;
    try {
      const h = this.sfx.trigger(name, opts, this._t());
      if (opts.rate && h?.setRate) h.setRate(opts.rate);
      return h ?? NOOP;
    } catch (e) {
      console.warn('[audio] play failed', name, e);
      return NOOP;
    }
  }

  /* ---------------------------------------------------------------- update */

  update(dt, ctx) {
    if (!this.unlocked) return;
    const ac = this.ac;
    if (!ac) return;
    const t = this._t();
    const step = clamp(dt || 1 / 60, 1 / 480, 0.2);

    // volume / enable plumbing
    if (this._lastVols.en !== this.enabled || this._lastVols.m !== this.masterVolume) {
      ramp(this.master.gain, this.enabled ? clamp(this.masterVolume, 0, 1.5) : 0, t, 0.03);
      this._lastVols.en = this.enabled;
      this._lastVols.m = this.masterVolume;
    }
    if (this._lastVols.s !== this.sfxVolume) {
      ramp(this.sfxSum.gain, clamp(this.sfxVolume, 0, 1.5), t, 0.05);
      this._lastVols.s = this.sfxVolume;
    }
    if (this._lastVols.mu !== this.musicVolume) {
      ramp(this.musicBus.gain, clamp(this.musicVolume, 0, 1.5), t, 0.15);
      this._lastVols.mu = this.musicVolume;
    }
    if (!this.enabled) return;

    // While the context is suspended (pre-gesture) nothing is audible and currentTime is frozen —
    // keep building the graph, but don't run the schedulers against a clock that isn't moving.
    const suspended = this.ac.state === 'suspended' && this.offlineTime === null;

    // one deferred build per frame
    if (this._deferred.length) {
      const task = this._deferred.shift();
      try {
        task();
      } catch (e) {
        console.warn('[audio] deferred build failed', e);
      }
    } else if (!this.engine) {
      this._buildEngine(); // the player car does not exist yet when init() runs
    }
    if (suspended) return;

    this._updateListener(t, step);

    const player = ctx?.cars?.player ?? ctx?.player ?? null;
    const s = player?.state ?? null;
    this._playerThrottle = s?.throttle ?? 0;

    // Camera perspective changes the mix: inside the car you hear engine, outside you hear air.
    const inCar = this._camMode === 'hood' || this._camMode === 'bumper';
    const cine = this._camMode === 'cinematic' || this._camMode === 'orbit' || this._camMode === 'photo';
    const engineGain = inCar ? 1.16 : cine ? 0.82 : 1;
    const ambGain = inCar ? 0.75 : cine ? 1.1 : 1;

    /* ---- player engine ---- */
    if (this.engine && s) {
      if (player?.def && this.engine.def !== player.def) this._buildEngine(player.def);
      this.engine.update(s, t, { dt: step, gain: engineGain });
      this._engineDuck = damp(this._engineDuck, this.engine.loudness, 10, step);
    } else if (this.engine) {
      this.engine.silence(t);
      this._engineDuck = damp(this._engineDuck, 0, 6, step);
    }
    ramp(this.engineBus.gain, 0.55, t, 0.2);

    /* ---- tyres ---- */
    if (this.tyres) this.tyres.update(s, t, { gain: inCar ? 1.1 : 1 });

    /* ---- wind + road ---- */
    if (this.ambience) {
      this.ambience.update(s, t, { gain: ambGain, duck: this._engineDuck });
    }

    /* ---- sfx housekeeping ---- */
    if (this.sfx) {
      if (this._scrapeCarryover > 0) {
        this.sfx.trigger('scrape', { strength: this._scrapeCarryover }, t);
        this._scrapeCarryover = Math.max(0, this._scrapeCarryover - step * 1.4);
      }
      this.sfx.update(step, t, { speed: Math.abs(s?.speed ?? 0) });
      this._sfxDuck = damp(this._sfxDuck, this.sfx.loudness, 12, step);
    }

    /* ---- opponents ---- */
    this._updateOpponents(t, step, ctx);

    /* ---- music ---- */
    if (this.music) {
      this.music.update(step, t, {
        engine: this._engineDuck,
        sfx: Math.max(this._sfxDuck, (this.tyres?.loudness ?? 0) * 0.7),
      });
    }

    this.stats.voices =
      (this.engine ? 1 : 0) + this._opponentSlots.filter((x) => x.voice).length + (this.music ? 1 : 0);
  }

  /**
   * Assign the pooled spatial voices to the nearest opponents. Hysteresis + a rebind cooldown stop
   * the pack from thrashing the pool when cars trade places.
   */
  _updateOpponents(t, dt, ctx) {
    const slots = this._opponentSlots;
    if (!slots.length) return;
    const cars = ctx?.cars?.instances;
    const player = ctx?.cars?.player ?? ctx?.player ?? null;
    if (!cars?.length) return;

    this._rebindCooldown -= dt;
    const lp = this._listenerPos;

    if (this._rebindCooldown <= 0) {
      this._rebindCooldown = 0.4;
      const cand = [];
      for (const c of cars) {
        if (c === player || !c.state) continue;
        const p = c.state.position;
        const d = Math.hypot(p.x - lp.x, p.y - lp.y, p.z - lp.z);
        if (d < 260) cand.push({ car: c, d });
      }
      cand.sort((a, b) => a.d - b.d);
      const want = cand.slice(0, slots.length).map((x) => x.car);
      // free slots whose car dropped out
      for (const slot of slots) {
        if (slot.car && !want.includes(slot.car)) slot.car = null;
      }
      for (const car of want) {
        if (slots.some((sl) => sl.car === car)) continue;
        const free = slots.find((sl) => !sl.car);
        if (!free) break;
        free.car = car;
        if (!free.voice || free.voice.def !== car.def) {
          free.voice?.dispose();
          free.voice = new EngineVoice(this.ac, car.def, {
            spatial: true,
            dest: this.spatialBus,
            reverbSend: this.reverbSend,
            harmonics: Math.min(112, this._tier.harmonics),
            startTime: t,
          });
          if (free.voice.panner && !this._tier.hrtf) free.voice.panner.panningModel = 'equalpower';
        }
      }
    }

    let live = 0;
    for (const slot of slots) {
      if (!slot.voice) continue;
      if (!slot.car?.state) {
        slot.voice.silence(t);
        continue;
      }
      live++;
      const st = slot.car.state;
      const cents = slot.voice.place(st.position, st.velocity, lp, this._listenerVel, t);
      slot.voice.update(st, t, { dt, gain: 0.85, doppler: cents });
    }
    this.stats.opponents = live;
  }

  dispose() {
    for (const u of this._unsub) {
      try {
        u?.();
      } catch {
        /* ignore */
      }
    }
    this._unsub.length = 0;
    this.engine?.dispose();
    this.tyres?.dispose();
    this.ambience?.dispose();
    this.sfx?.dispose();
    this.music?.dispose();
    for (const s of this._opponentSlots) s.voice?.dispose();
    this._opponentSlots.length = 0;
    this.ac?.close?.();
    this.unlocked = false;
  }
}
