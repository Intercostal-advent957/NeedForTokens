import { hudMarkup } from './hudMarkup.js';
import { Minimap } from './Minimap.js';
import { headAt, tachSvg } from './Tachometer.js';
import {
  menuMarkup,
  garageMarkup,
  resultsMarkup,
  pausedMarkup,
  PAINTS,
  fmt,
  ordinal,
} from './screens.js';

const SCREENS = ['boot', 'menu', 'garage', 'race', 'results', 'paused', 'settings'];
const MAP_POOL = 12;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * NEED FOR TOKENS — HUD and front end. CONTRACTS.md §13.
 *
 * Design: "pit wall". Instruments are drawn as line + type directly on the image, not as glass
 * panels — a racing HUD must never occlude the driving line. Legibility over both a bright dusk
 * sky and a black tunnel comes from corner-anchored scrims plus a tight dark halo baked into the
 * type, never from a full-bleed panel.
 *
 * Zero per-frame allocation: every element is cached in `init()`, every write goes through
 * `_txt()` (which diffs against a cache) or is a `style.transform` / `style.opacity` /
 * `strokeDashoffset` assignment. No innerHTML, no object literals, no closures in `update()`.
 */
export class UiSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.screen = 'race';
    this.root = document.getElementById('ui-root');
    this.minimap = new Minimap();

    // --- per-frame scratch (never reallocated) ---
    this._c = Object.create(null); // textContent diff cache
    this._pt = { x: 0, y: 0 };
    this._fwd = { x: 0, y: 0, z: 0 };
    this._head = { x: 0, y: 0 };
    this._teleRows = new Map();

    this._instrumentsFor = null;
    this._tachLen = 300;
    this._mapLen = 300;
    this._lastPos = 0;
    this._driftHold = 0;
    this._lastDrift = 0;
    this._shift = -1;
    this._nosOn = false;
    this._evtSlot = 0;
    this._evtTimers = [null, null, null];
    this._teleOn = false;
    this._mapOn = true;
    this._builtGarage = false;
    this._selCar = null;
    this._paint = PAINTS[0][0];
    this._bestLap = 0;
  }

  // ------------------------------------------------------------------ init
  async init() {
    const ctx = this.ctx;
    this.root.innerHTML =
      `<div class="ui" data-screen="race">` +
      `<div class="hud" id="ui-hud">${hudMarkup(this.minimap.build(ctx.world?.track, MAP_POOL))}</div>` +
      `<div class="screen screen--menu" id="ui-menu"></div>` +
      `<div class="screen screen--garage" id="ui-garage"></div>` +
      `<div class="screen screen--results" id="ui-results"></div>` +
      `<div class="screen screen--paused" id="ui-paused"></div>` +
      `</div>`;

    const q = (s) => this.root.querySelector(s);
    this.el = {
      ui: q('.ui'),
      hud: q('#ui-hud'),
      menu: q('#ui-menu'),
      garage: q('#ui-garage'),
      results: q('#ui-results'),
      paused: q('#ui-paused'),

      cluster: q('#hud-cluster'),
      kmh: q('#hud-kmh'),
      gear: q('#hud-gear'),
      sweep: q('#tach-sweep-path'),
      tHead: q('#tach-head'),

      nos: q('#hud-nos'),
      nosFill: q('#hud-nos-fill'),

      pos: q('#hud-pos'),
      posSuf: q('#hud-pos-suf'),
      field: q('#hud-field'),
      lap: q('#hud-lap'),
      laps: q('#hud-laps'),

      lapTime: q('#hud-laptime'),
      best: q('#hud-best'),
      delta: q('#hud-delta'),
      deltaVal: q('#hud-delta-val'),

      map: q('.hud-map'),
      mapName: q('#map-name'),
      mapLap: q('#map-lap'),
      mapProg: q('#mm-prog'),
      me: q('#mm-me'),

      drift: q('#hud-drift'),
      driftVal: q('#hud-drift-val'),
      driftMult: q('#hud-drift-mult'),
      driftBar: q('#hud-drift-bar'),

      cd: q('#hud-cd'),
      cdNum: q('#hud-cd-num'),
      toast: q('#hud-toast'),
      toastTxt: q('#hud-toast-txt'),
      tele: q('#hud-tele'),
      teleRows: q('#hud-tele-rows'),
      events: this.root.querySelectorAll('.evt'),
      cars: this.root.querySelectorAll('.mm-car'),
    };

    if (this.el.sweep) {
      this._tachLen = this.el.sweep.getTotalLength();
      this.el.sweep.style.strokeDasharray = this._tachLen;
      this.el.sweep.style.strokeDashoffset = this._tachLen;
    }
    if (this.el.mapProg) {
      this._mapLen = this.el.mapProg.getTotalLength();
      this.el.mapProg.style.strokeDasharray = this._mapLen;
      this.el.mapProg.style.strokeDashoffset = this._mapLen;
    }

    this.el.menu.innerHTML = menuMarkup(ctx.cars?.defs ?? []);
    this._menuRows = this.el.menu.querySelectorAll('.nav-row');
    this._menuIdx = 0;
    this._syncMenu();

    this._wireBus();
    this._wirePointer();
    this._wireKeys();
    this.setScreen(this.screen);
    return this;
  }

  // ------------------------------------------------------------------ wiring
  _wireBus() {
    const bus = this.ctx.bus;
    if (!bus) return;

    bus.on('game:ready', () => {
      this._buildInstruments();
      const t = this.ctx.world?.track;
      if (t) {
        this._txt(this.el.laps, String(t.laps ?? this.ctx.race?.totalLaps ?? 3), 'laps');
        this._txt(this.el.field, String(this.ctx.cars?.instances?.length ?? 8), 'field');
      }
    });

    bus.on('race:countdown', ({ n }) => this._countdown(n));

    bus.on('race:start', () => {
      this._event('GREEN', 'GO GO GO', 'sig');
    });

    bus.on('lap:complete', ({ car, lap, time, best }) => {
      if (car && car !== this._player()) return;
      const isBest = best && Math.abs(time - best) < 1e-6;
      this._bestLap = best || this._bestLap;
      if (isBest && lap > 1) this._event('NEW BEST LAP', fmt(time), 'gold');
      else this._event(`LAP ${lap}`, fmt(time), 'ion');
    });

    bus.on('race:finish', () => {
      this.setScreen('results');
    });

    bus.on('car:nos', ({ car, active }) => {
      if (car && car !== this._player()) return;
      if (active) this._event('NITROUS', 'ENGAGED', 'ion');
    });

    bus.on('quality:change', ({ tier }) => {
      this._syncSeg('tier', tier ?? this.ctx.settings?.tier);
    });
    bus.on('camera:mode', ({ mode }) => this._syncSeg('camera', mode));
  }

  _wirePointer() {
    this.el.ui.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act], [data-car], [data-paint]');
      if (!b) return;
      e.preventDefault();
      if (b.dataset.paint) return this._pickPaint(b);
      if (b.dataset.car) return this._pickCar(b);
      this._action(b.dataset.act, b.dataset.v, b);
    });
    this.el.ui.addEventListener('pointerover', (e) => {
      const r = e.target.closest?.('.nav-row');
      if (!r || !this._menuRows) return;
      this._menuIdx = Array.prototype.indexOf.call(this._menuRows, r);
      this._syncMenu();
    });
  }

  _wireKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyT') {
        this._teleOn = !this._teleOn;
        this.el.tele.hidden = !this._teleOn;
        return;
      }
      if (this.screen === 'menu') {
        if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
          const n = this._menuRows.length;
          this._menuIdx = (this._menuIdx + (e.code === 'ArrowDown' ? 1 : n - 1)) % n;
          this._syncMenu();
        } else if (e.code === 'Enter' || e.code === 'Space') {
          this._action(this._menuRows[this._menuIdx]?.dataset.act);
        }
      } else if (this.screen === 'garage' || this.screen === 'settings') {
        if (e.code === 'Escape' || e.code === 'Enter') this.setScreen('menu');
      }
    });
  }

  _action(act, v, btn) {
    const ctx = this.ctx;
    switch (act) {
      case 'race':
        this.setScreen('race');
        if (ctx.race?.phase === 'idle') ctx.race.start?.();
        break;
      case 'garage':
        this.setScreen('garage');
        break;
      case 'settings':
        this.setScreen('settings');
        break;
      case 'menu':
        if (ctx.race?.paused) ctx.race.togglePause?.();
        this.setScreen('menu');
        break;
      case 'resume':
        if (ctx.race?.paused) ctx.race.togglePause?.();
        else this.setScreen('race');
        break;
      case 'restart':
        ctx.race?.restart?.();
        if (ctx.race?.paused) ctx.race.togglePause?.();
        this.setScreen('race');
        break;
      case 'tier':
        ctx.settings?.setTier?.(v);
        this._syncSeg('tier', v);
        break;
      case 'camera':
        ctx.cameras?.setMode?.(v);
        this._syncSeg('camera', v);
        break;
      case 'telemetry':
        this._teleOn = !this._teleOn;
        this.el.tele.hidden = !this._teleOn;
        btn?.classList.toggle('is-on', this._teleOn);
        break;
      case 'minimap':
        this._mapOn = !this._mapOn;
        this.el.map.classList.toggle('is-off', !this._mapOn);
        btn?.classList.toggle('is-on', !this._mapOn);
        break;
      default:
        break;
    }
  }

  _syncMenu() {
    if (!this._menuRows) return;
    for (let i = 0; i < this._menuRows.length; i++) {
      this._menuRows[i].classList.toggle('is-sel', i === this._menuIdx);
    }
  }

  _syncSeg(group, value) {
    const rows = this.root.querySelectorAll(`[data-act="${group}"]`);
    for (const r of rows) r.classList.toggle('is-on', r.dataset.v === value);
  }

  _pickCar(btn) {
    const id = btn.dataset.car;
    this._selCar = id;
    for (const r of this.el.garage.querySelectorAll('.car-row')) {
      r.classList.toggle('is-sel', r.dataset.car === id);
    }
    for (const s of this.el.garage.querySelectorAll('.spec')) {
      s.hidden = s.dataset.car !== id;
    }
  }

  _pickPaint(btn) {
    const hex = btn.dataset.paint;
    this._paint = hex;
    for (const s of this.el.garage.querySelectorAll('.sw')) {
      s.classList.toggle('is-sel', s === btn);
    }
    const name = this.el.garage.querySelector('#paint-name');
    if (name) name.textContent = btn.title || '';
    const n = parseInt(hex.slice(1), 16);
    this.ctx.cars?.player?.setPaint?.(n);
  }

  // ------------------------------------------------------------------ screens
  setScreen(name) {
    if (!SCREENS.includes(name)) return;
    this.screen = name;
    if (!this.el) return;

    if (name === 'garage' && !this._builtGarage) {
      this.el.garage.innerHTML = garageMarkup(this.ctx.cars?.defs ?? []);
      this._builtGarage = true;
      const first = this.el.garage.querySelector('.car-row');
      this._selCar = first?.dataset.car ?? null;
    }
    if (name === 'results') {
      this.el.results.innerHTML = resultsMarkup(
        this.ctx.race?.standings ?? [],
        this._player(),
        this.ctx.race?.totalLaps ?? 3
      );
    }
    if (name === 'paused' || name === 'settings') {
      this.el.paused.innerHTML = pausedMarkup(
        this.ctx.settings?.tier ?? 'high',
        this.ctx.cameras?.mode ?? 'chase'
      );
      this.el.paused.classList.toggle('is-settings', name === 'settings');
      this._pauseClock = this.el.paused.querySelector('#pause-clock');
      this._c.pclock = null;
      const head = this.el.paused.querySelector('.tag');
      if (head && name === 'settings') head.textContent = 'SETTINGS';
      const resume = this.el.paused.querySelector('[data-act="resume"]');
      if (resume && name === 'settings') {
        resume.textContent = 'BACK TO MENU';
        resume.dataset.act = 'menu';
      }
    }
    this.el.ui.dataset.screen = name;
  }

  toast(msg, ms = 2000) {
    if (!this.el) return;
    this.el.toastTxt.textContent = msg;
    this.el.toast.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.el.toast.classList.remove('show'), ms);
  }

  /** Pooled event popup — reuses three slots so nothing is allocated at runtime. */
  _event(kick, body, tone = 'ion', ms = 2400) {
    if (!this.el) return;
    const i = this._evtSlot;
    this._evtSlot = (i + 1) % this.el.events.length;
    const el = this.el.events[i];
    el.children[0].textContent = kick;
    el.children[1].textContent = body;
    el.dataset.tone = tone;
    // slots are recycled round-robin, so flex order keeps the newest event on top
    el.style.order = -(this._evtSeq = (this._evtSeq || 0) + 1);
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this._evtTimers[i]);
    this._evtTimers[i] = setTimeout(() => el.classList.remove('show'), ms);
  }

  _countdown(n) {
    const el = this.el?.cd;
    if (!el) return;
    this.el.cdNum.textContent = n > 0 ? String(n) : 'GO';
    el.dataset.go = n > 0 ? '0' : '1';
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    clearTimeout(this._cdT);
    this._cdT = setTimeout(() => el.classList.remove('pop'), n > 0 ? 1000 : 1100);
  }

  // ------------------------------------------------------------------ helpers
  _player() {
    return this.ctx.player ?? this.ctx.cars?.player ?? null;
  }

  _txt(el, v, key) {
    if (!el || this._c[key] === v) return;
    this._c[key] = v;
    el.textContent = v;
  }

  /**
   * Re-engrave the tach for the car actually being driven. Runs once per car, never in the
   * steady state — the scale has to agree with the sweep or the gauge reads as decoration.
   */
  _buildInstruments() {
    const p = this._player();
    const def = p?.def;
    if (!def || this._instrumentsFor === def.id) return;
    this._instrumentsFor = def.id;

    const old = this.el.cluster.querySelector('.tach');
    if (old) {
      old.outerHTML = tachSvg({ maxRpm: def.redline ?? 9000, minRpm: def.idleRpm ?? 0 });
      const q = (s) => this.root.querySelector(s);
      this.el.kmh = q('#hud-kmh');
      this.el.gear = q('#hud-gear');
      this.el.sweep = q('#tach-sweep-path');
      this.el.tHead = q('#tach-head');
      this._tachLen = this.el.sweep.getTotalLength();
      this.el.sweep.style.strokeDasharray = this._tachLen;
      this.el.sweep.style.strokeDashoffset = this._tachLen;
      this._c.kmh = null;
      this._c.gear = null;
    }

    const track = this.ctx.world?.track;
    this._txt(this.el.laps, String(track?.laps ?? this.ctx.race?.totalLaps ?? 3), 'laps');
    this._txt(this.el.field, String(this.ctx.cars?.instances?.length ?? 8), 'field');
  }

  /** standings lookup without allocating a closure every frame. */
  _standing(car) {
    const st = this.ctx.race?.standings;
    if (!st) return null;
    for (let i = 0; i < st.length; i++) if (st[i].car === car) return st[i];
    return null;
  }

  onResize() {
    /* SVG scales itself; nothing to recompute. */
  }

  // ------------------------------------------------------------------ update
  update(dt, ctx) {
    if (!this.el) return;
    if (this._instrumentsFor === null) this._buildInstruments();

    const player = this._player();
    const s = player?.state;
    const race = ctx.race;
    const showHud = this.screen === 'race' || this.screen === 'paused';

    if (s) {
      const def = player.def;

      // ---- speed -------------------------------------------------------
      const kmh = Math.abs(Math.round(s.speedKmh || 0));
      this._txt(this.el.kmh, String(kmh), 'kmh');

      // ---- gear --------------------------------------------------------
      this._txt(this.el.gear, s.gear < 0 ? 'R' : s.gear === 0 ? 'N' : String(s.gear), 'gear');

      // ---- tach --------------------------------------------------------
      const idle = def.idleRpm ?? 800;
      const red = def.redline ?? 8000;
      const f = clamp01(((s.rpm ?? idle) - idle) / Math.max(1, red - idle));
      this.el.sweep.style.strokeDashoffset = this._tachLen * (1 - f);
      const h = headAt(f, this._head);
      this.el.tHead.style.transform = `translate(${h.x.toFixed(1)}px,${h.y.toFixed(1)}px)`;
      this.el.tHead.style.opacity = f > 0.02 ? 1 : 0;

      const shift = f < 0.72 ? 0 : Math.min(7, Math.round(((f - 0.72) / 0.28) * 7));
      if (shift !== this._shift) {
        this._shift = shift;
        this.el.cluster.dataset.shift = shift;
      }

      // ---- nos ---------------------------------------------------------
      const nos = clamp01(s.nosAmount ?? 0);
      this.el.nosFill.style.transform = `scaleX(${nos.toFixed(3)})`;
      if (!!s.nosActive !== this._nosOn) {
        this._nosOn = !!s.nosActive;
        this.el.nos.classList.toggle('is-live', this._nosOn);
      }

      // ---- drift -------------------------------------------------------
      const score = Math.round(s.driftScore ?? 0);
      if (s.drifting) this._driftHold = 1.5;
      else this._driftHold -= dt;
      const driftOn = this._driftHold > 0 && score > 0;
      if (driftOn !== this._lastDrift) {
        this._lastDrift = driftOn;
        this.el.drift.classList.toggle('show', driftOn);
      }
      if (driftOn) {
        this._txt(this.el.driftVal, String(score), 'drift');
        const ang = Math.abs(s.driftAngle ?? 0);
        const mult = 1 + Math.min(3, ang / 0.32);
        this._txt(this.el.driftMult, `×${mult.toFixed(1)}`, 'driftm');
        this.el.driftBar.style.transform = `scaleX(${clamp01(ang / 1.05).toFixed(3)})`;
      }
    }

    // ---- race board -----------------------------------------------------
    if (race && s) {
      const pos = race.getPosition?.(player) ?? 1;
      if (pos !== this._lastPos) {
        if (this._lastPos && race.phase === 'racing') {
          if (pos < this._lastPos) this._event('OVERTAKE', `P${pos}`, 'ion', 1800);
          else this._event('POSITION LOST', `P${pos}`, 'sig', 1800);
        }
        this._lastPos = pos;
        this._txt(this.el.pos, String(pos), 'pos');
        this._txt(this.el.posSuf, ordinal(pos).slice(String(pos).length), 'possuf');
      }

      const totalLaps = race.totalLaps ?? 3;
      const lap = Math.min(race.laps ?? 1, totalLaps);
      this._txt(this.el.lap, String(lap), 'lap');
      this._txt(this.el.laps, String(totalLaps), 'laps');
      this._txt(this.el.field, String(ctx.cars?.instances?.length ?? 8), 'field');
      this._txt(this.el.mapLap, `${lap}/${totalLaps}`, 'maplap');

      const me = this._standing(player);
      const lapTime = Math.max(0, me?.lapTime ?? Math.max(race.time ?? 0, 0));
      this._txt(this.el.lapTime, fmt(lapTime), 'laptime');
      const best = me?.bestLap || this._bestLap;
      this._txt(this.el.best, best ? fmt(best) : '--:--', 'best');

      // pace delta: elapsed this lap vs. where the best lap was at the same point
      const prog = race.getProgress?.(player) ?? 0;
      const tInLap = prog - Math.floor(prog);
      if (best > 0 && race.phase === 'racing' && tInLap > 0.02) {
        const d = lapTime - best * tInLap;
        this._txt(this.el.deltaVal, `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}`, 'delta');
        const tone = d <= -0.05 ? 'up' : d >= 0.05 ? 'down' : 'even';
        if (tone !== this._deltaTone) {
          this._deltaTone = tone;
          this.el.delta.dataset.tone = tone;
        }
        if (!this._deltaShown) {
          this._deltaShown = true;
          this.el.delta.classList.add('show');
        }
      } else if (this._deltaShown) {
        this._deltaShown = false;
        this.el.delta.classList.remove('show');
      }

      // ---- minimap ------------------------------------------------------
      if (showHud && this._mapOn && this.minimap.ok) {
        this.el.mapProg.style.strokeDashoffset = this._mapLen * (1 - clamp01(tInLap));
        const insts = ctx.cars?.instances;
        const dots = this.el.cars;
        const nDots = dots.length;
        let di = 0;
        if (insts) {
          for (let i = 0; i < insts.length && di < nDots; i++) {
            const c = insts[i];
            const st = c?.state;
            if (!st || c === player) continue;
            const p = this.minimap.project(st.position.x, st.position.z, this._pt);
            const el = dots[di++];
            el.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`;
            el.style.opacity = 1;
          }
        }
        for (; di < nDots; di++) dots[di].style.opacity = 0;

        const p = this.minimap.project(s.position.x, s.position.z, this._pt);
        const q = s.quaternion;
        const fx = -2 * (q.x * q.z + q.w * q.y);
        const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
        const deg = (Math.atan2(fx, -fz) * 180) / Math.PI;
        this.el.me.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(
          1
        )}px) rotate(${deg.toFixed(1)}deg)`;
      }
    }

    // ---- telemetry -------------------------------------------------------
    if (this._teleOn) this._telemetry(ctx, s);

    // ---- pause clock -----------------------------------------------------
    if (this.screen === 'paused' && race && this._pauseClock) {
      this._txt(this._pauseClock, fmt(Math.max(0, race.time ?? 0)), 'pclock');
    }
  }

  _telemetry(ctx, s) {
    const v = ctx.debug?.values;
    if (v) for (const k in v) this._teleWrite(k, v[k], 't_');
    if (s) for (let i = 0; i < TELE_KEYS.length; i++) this._teleWrite(TELE_KEYS[i], s[TELE_KEYS[i]], 's_');
  }

  /** Rows are created once per key (amortised zero) and then only textContent is written. */
  _teleWrite(k, val, ns) {
    let cell = this._teleRows.get(ns + k);
    if (!cell) {
      const row = document.createElement('div');
      row.className = 'tele-row';
      const a = document.createElement('i');
      cell = document.createElement('b');
      a.textContent = k;
      row.appendChild(a);
      row.appendChild(cell);
      this.el.teleRows.appendChild(row);
      this._teleRows.set(ns + k, cell);
    }
    this._txt(
      cell,
      typeof val === 'number'
        ? (Number.isInteger(val) ? val : val.toFixed(2)).toString()
        : typeof val === 'boolean'
          ? val ? 'YES' : 'no'
          : String(val),
      ns + k
    );
  }

  dispose() {
    clearTimeout(this._toastT);
    clearTimeout(this._cdT);
    for (const t of this._evtTimers) clearTimeout(t);
  }
}

const TELE_KEYS = ['speedKmh', 'rpm', 'gear', 'engineLoad', 'nosAmount', 'driftAngle', 'airborne'];
