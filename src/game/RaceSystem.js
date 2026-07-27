import * as THREE from 'three';
import { OPPONENT_PAINTS } from '../vehicle/carDefs.js';
import { clamp, clamp01 } from '../core/MathX.js';
import { AiDriver, AI_TUNING } from './AiDriver.js';
import { DRIVER_PROFILES, RUBBER_BAND, perfIndex } from './DriverProfiles.js';
import { RaceRules } from './RaceRules.js';
import { GhostRecorder } from './GhostRecorder.js';
import { arcDelta, fmtLap, makeProj, wrap01 } from './racemath.js';

/**
 * Grid, laps, standings, AI drivers, event modes. See CONTRACTS.md §14.
 *
 * Timing runs off `fixedUpdate` rather than `update`, so `race.time`, the physics integration and
 * the lap/checkpoint bookkeeping can never disagree — including when the frame loop clamps its
 * substep budget (see main.js MAX_SUBSTEPS) or when the QA harness runs with a time scale.
 *
 * Events emitted (CONTRACTS.md §2): race:countdown, race:start, race:finish, lap:complete,
 * checkpoint. Additive, non-breaking extras used by the HUD/audio lanes if they want them:
 * race:sector, race:wrongway, race:respawn, race:position, race:mode.
 */

/** Seconds of countdown before the lights go out. */
const COUNTDOWN = 3.2;
/** Seconds the car is frozen after a manual reset. */
const RESET_PENALTY = 1.5;
/** Seconds off-track before the "off track" flag latches (used for wrong-way/reset prompts). */
const OFFTRACK_WARN = 1.5;
/** Seconds a car may be wrong-way before it is flagged. */
const WRONGWAY_WARN = 1.2;
/** Seconds after the winner takes the flag before the remaining cars are classified anyway. */
const FINISH_GRACE = 90;
/** Speed a respawned car is released at, m/s (~50 km/h — enough not to stall the field). */
const RESPAWN_SPEED = 13;
/** Normal-velocity change (m/s) at which barrier contact counts as a hit rather than a brush. */
const BARRIER_HIT_MS = 3;

export const RACE_MODES = {
  circuit: { laps: 3, opponents: true, rubberBand: true, ghost: false, label: 'CIRCUIT RACE' },
  sprint: { laps: 1, opponents: true, rubberBand: true, ghost: false, label: 'SPRINT' },
  timeTrial: { laps: 3, opponents: false, rubberBand: false, ghost: true, label: 'TIME TRIAL' },
  drift: { laps: 2, opponents: true, rubberBand: false, ghost: false, label: 'DRIFT TRIAL' },
};

export class RaceSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.phase = 'idle';
    this.time = 0;
    this.totalLaps = 3;
    this.standings = [];
    this.opponents = [];
    this.paused = false;
    this.mode = 'circuit';
    this.modeLabel = RACE_MODES.circuit.label;
    this.wrongWay = false;
    this.offTrack = false;
    this.ghost = new GhostRecorder();
    this.driftScore = 0;
    this.autopilot = false; // QA/attract mode: the AI drives the player's car too

    this._drivers = new Map(); // CarInstance -> AiDriver
    this._vehicles = new Map(); // CarInstance -> physics vehicle record
    this._projs = new Map(); // CarInstance -> owned projection record
    this._traffic = { cars: [], byCar: new Map() };
    this._events = [];
    this._lastCount = null;
    this._penalty = 0;
    this._standingsClock = 0;
    this._playerWrongWayT = 0;
    this._playerOffTrackT = 0;
    this._finishedAt = 0;
    this._raceOver = false;
    this._barrierHits = new Map();
    this._barrierTaps = new Map();
    this._prevPos = new Map();
  }

  async init() {
    const { cars, physics, world, bus } = this.ctx;
    const spawns = world.spawnPoints;
    this.track = world.track;
    this.rules = new RaceRules(this.track);
    this.totalLaps = RACE_MODES[this.mode].laps ?? world.track.laps;

    // ---------- grid ----------
    const player = cars.spawn('apex-gt', {
      isPlayer: true,
      position: spawns[0].position,
      quaternion: spawns[0].quaternion,
    });
    physics.attach(player);
    player.state.position.copy(spawns[0].position);
    player.state.quaternion.copy(spawns[0].quaternion);
    this.ctx.cameras.setTarget(player);
    this.ctx.player = player;

    // Seed the grid so the strongest profile is in the strongest car — a real grid is ordered by
    // pace, and it keeps "did the quicker driver win?" a question about the AI, not about who
    // drew the hot hatch.
    const roster = cars.defs
      .filter((d) => d.id !== 'apex-gt')
      .slice()
      .sort((a, b) => perfIndex(b) - perfIndex(a));
    const n = Math.min(DRIVER_PROFILES.length - 1, spawns.length - 1);
    for (let i = 0; i < n; i++) {
      const def = roster[i % roster.length];
      const sp = spawns[i + 1];
      const paint = OPPONENT_PAINTS[i % OPPONENT_PAINTS.length];
      const car = cars.spawn(def.id, { position: sp.position, quaternion: sp.quaternion, paint });
      car.setPaint(paint);
      physics.attach(car);
      car.state.position.copy(sp.position);
      car.state.quaternion.copy(sp.quaternion);
      this.opponents.push(car);
    }

    for (const c of cars.instances) {
      this._vehicles.set(c, physics.vehicles.find((v) => v.car === c) ?? null);
      this._projs.set(c, makeProj());
      this._barrierHits.set(c, 0);
      this._barrierTaps.set(c, 0);
    }
    this._buildDrivers();

    // Barrier contact, split two ways. `taps` is every reported touch — brushing a wall on the
    // exit kerb counts. `hits` is contact hard enough to cost real time (a normal-velocity change
    // above BARRIER_HIT_MS), which is what "hit a barrier" actually means to a driver.
    bus.on('car:collision', (e) => {
      if (e?.tag !== 'barrier' || !this._barrierHits.has(e.car)) return;
      this._barrierTaps.set(e.car, (this._barrierTaps.get(e.car) ?? 0) + 1);
      const dv = (e.impulse ?? 0) / Math.max(e.car?.def?.mass ?? 1400, 1);
      if (dv >= BARRIER_HIT_MS) this._barrierHits.set(e.car, this._barrierHits.get(e.car) + 1);
    });

    this.start();
    return this;
  }

  /** (Re)create AI drivers from DRIVER_PROFILES. Index 0 is reserved for the player. */
  _buildDrivers() {
    this._drivers.clear();
    this.opponents.forEach((car, i) => {
      const veh = this._vehicles.get(car);
      if (!veh) return;
      const profile = DRIVER_PROFILES[(i + 1) % DRIVER_PROFILES.length];
      this._drivers.set(car, new AiDriver(car, veh, this.ctx, profile, i + 1));
      car.driverName = profile.name;
    });
    const p = this.ctx.cars.player;
    if (p) {
      p.driverName = 'YOU';
      const veh = this._vehicles.get(p);
      if (veh) this._playerAi = new AiDriver(p, veh, this.ctx, DRIVER_PROFILES[0], 0);
    }
  }

  /**
   * Replace the driver strength of each opponent — used by the behavioural harness to A/B the AI,
   * and available for a difficulty setting. `skill` is the headline number; consistency moves with
   * it because a stronger driver is both quicker and tidier, and the two must not fight.
   */
  setSkills(list) {
    this.opponents.forEach((car, i) => {
      const d = this._drivers.get(car);
      if (!d || list[i] === undefined) return;
      const v = clamp01(list[i]);
      d.applyProfile({ ...d.profile, skill: v, consistency: clamp01(0.45 + 0.5 * v) });
    });
  }

  /** Attach/detach the AI to the player's car (attract mode + headless full-grid tests). */
  setAutopilot(on) {
    this.autopilot = !!on;
    const p = this.ctx.cars.player;
    if (on && !this._playerAi && p) {
      const veh = this._vehicles.get(p);
      if (veh) this._playerAi = new AiDriver(p, veh, this.ctx, DRIVER_PROFILES[0], 0);
    }
    this._playerAi?.resync();
  }

  /** Switch event type. Must be followed by restart() to take effect cleanly. */
  setMode(mode) {
    if (!RACE_MODES[mode]) return false;
    this.mode = mode;
    this.modeLabel = RACE_MODES[mode].label;
    this.totalLaps = RACE_MODES[mode].laps;
    this.ctx.bus.emit('race:mode', { mode, label: this.modeLabel, laps: this.totalLaps });
    return true;
  }

  get cfg() {
    return RACE_MODES[this.mode] ?? RACE_MODES.circuit;
  }

  // ================================================================= phases

  start() {
    this.phase = 'countdown';
    this.time = -COUNTDOWN;
    this._lastCount = null;
    this._raceOver = false;
    this._finishedAt = 0;
    this._penalty = 0;
    this.driftScore = 0;
    this.wrongWay = false;
    this.offTrack = false;
    this.rules = new RaceRules(this.track);
    const grid = this.ctx.world.spawnPoints;
    this.ctx.cars.instances.forEach((c, i) => {
      const sp = grid[Math.min(i, grid.length - 1)];
      const proj = this.track.project(sp.position, -1, this._projs.get(c));
      this.rules.reset(c, proj.t, 0);
      this._barrierHits.set(c, 0);
      this._barrierTaps.set(c, 0);
    });
    this.ghost.restartLap();
    this._emitCountdown(3);
    this._rebuildStandings();
  }

  restart() {
    const { world, physics } = this.ctx;
    const spawns = world.spawnPoints;
    this.totalLaps = this.cfg.laps;
    this.ctx.cars.instances.forEach((c, i) => {
      const sp = spawns[Math.min(i, spawns.length - 1)];
      physics.reset(c, sp.position, sp.quaternion);
      if (c.state) {
        c.state.driftScore = 0;
        c.state.nosAmount = 1;
        c.state.damage.total = 0;
      }
    });
    for (const d of this._drivers.values()) {
      d.reset();
      d.resync();
    }
    this._playerAi?.reset();
    this._playerAi?.resync();
    this.ghost.reset(); // a ghost belongs to one event; never carry it into the next
    this.start();
  }

  togglePause() {
    this.paused = !this.paused;
    this.ctx.game.paused = this.paused;
    this.ctx.hud?.setScreen?.(this.paused ? 'paused' : 'race');
  }

  _emitCountdown(n) {
    if (this._lastCount === n) return;
    this._lastCount = n;
    this.ctx.bus.emit('race:countdown', { n: Math.max(n, 0) });
  }

  // ================================================================= QA hooks

  /**
   * Drop the player onto the track at normalised position `t`, in a *clean racing state*.
   *
   * Used by the automated screenshot/QA harness. It must leave nothing half-initialised: the
   * countdown is cancelled and the UI told to clear it (`race:countdown {n:0}` — the documented
   * way to say "GO", which every listener already handles), the clock is rebased, lap bookkeeping
   * is placed consistently at `t` (checkpoints behind the drop point credited, the rest still to
   * be earned — see RaceRules.place), and the AI pack is arranged around the player at racing
   * spacing with their controllers resynced.
   */
  teleportPlayer(t, lateral = 0, speedKmh = 0) {
    const { world, physics, cars } = this.ctx;
    const track = world.track;
    const p = track.placeAt(t, lateral, 0.65);
    physics.reset(cars.player, p.position, p.quaternion);
    if (speedKmh) physics.setVelocityAlong?.(cars.player, speedKmh / 3.6);

    // --- clean racing state -------------------------------------------------------------
    this.phase = 'racing';
    this.paused = false;
    this.time = 0;
    this._penalty = 0;
    this._raceOver = false;
    this._finishedAt = 0;
    this.wrongWay = false;
    this.offTrack = false;
    this._playerWrongWayT = 0;
    this._playerOffTrackT = 0;
    // Cancel the countdown and tell the UI to clear it. n = 0 is "GO" in CONTRACTS §2, and the
    // HUD wipes the element shortly after — which is exactly the state we want to land in.
    this._lastCount = 0;
    this.ctx.bus.emit('race:countdown', { n: 0 });
    this.ctx.bus.emit('race:start');

    this.rules = new RaceRules(this.track);
    this.rules.place(cars.player, wrap01(t), 0, 0);
    this.ghost.restartLap();

    // --- pack, positioned around the player at racing spacing ---------------------------
    const L = track.length;
    const halfW = track.widthAt(wrap01(t));
    this.opponents.forEach((c, i) => {
      // alternate ahead/behind so the player is genuinely mid-pack, not leading a queue
      const rank = Math.floor(i / 2) + 1;
      const dir = i % 2 === 0 ? 1 : -1;
      const along = dir * (6 + rank * 7.5);
      const side = ((i % 4 < 2 ? -1 : 1) * (1.6 + (i % 3) * 1.15)) + lateral * 0.4;
      const tt = wrap01(t + along / L);
      const lat = clamp(side, -(halfW - 1.4), halfW - 1.4);
      const q = track.placeAt(tt, lat, 0.65);
      physics.reset(c, q.position, q.quaternion);
      if (speedKmh) physics.setVelocityAlong?.(c, (speedKmh * (0.95 + 0.012 * i)) / 3.6);
      this.rules.place(c, tt, 0, 0);
      const d = this._drivers.get(c);
      if (d) {
        d.resync();
        d.hint = tt;
      }
    });
    this._playerAi?.resync();
    this._syncTraffic();
    this._rebuildStandings();
  }

  /** Teleport any car. Exposed for the behavioural harness' checkpoint-cheat test. */
  teleportCar(car, t, lateral = 0, speedKmh = 0, creditCheckpoints = false) {
    const track = this.ctx.world.track;
    const p = track.placeAt(wrap01(t), lateral, 0.65);
    this.ctx.physics.reset(car, p.position, p.quaternion);
    if (speedKmh) this.ctx.physics.setVelocityAlong?.(car, speedKmh / 3.6);
    if (creditCheckpoints) this.rules.place(car, wrap01(t), this.time, this.rules.record(car).lap);
    else this.rules.noteJump(car, wrap01(t));
    this._drivers.get(car)?.resync();
    if (car === this.ctx.cars.player) this._playerAi?.resync();
  }

  // ================================================================= simulation

  fixedUpdate(dt) {
    if (this.paused) return;
    const { cars, input } = this.ctx;

    // ---- phase clock (fixed-step so timing can never drift from physics) ----
    if (this.phase === 'countdown') {
      this.time += dt;
      const n = Math.ceil(-this.time);
      if (n >= 0) this._emitCountdown(n);
      if (this.time >= 0) {
        this.time = 0;
        this.phase = 'racing';
        this._emitCountdown(0);
        this.ctx.bus.emit('race:start');
      }
    } else if (this.phase === 'racing' || (this.phase === 'finished' && !this._raceOver)) {
      this.time += dt;
    }

    const live = this.phase === 'racing' || (this.phase === 'finished' && !this._raceOver);
    this._syncTraffic();

    // ---- player ----
    this._drivePlayer(dt, live, input, cars.player);

    // ---- opponents ----
    const racingOpponents = live && this.cfg.opponents !== false;
    for (const car of this.opponents) {
      const d = this._drivers.get(car);
      if (!d) continue;
      if (!racingOpponents) {
        d.hold(dt, this.phase === 'countdown' ? 1 : 0.6);
        continue;
      }
      const rec = this.rules.record(car);
      if (rec.finished) {
        // Cool-down lap: keep driving the line so nobody parks on the racing line, but at pace.
        d.update(dt, this._traffic, 0, false);
        const veh = this._vehicles.get(car);
        if (veh) veh.controls.throttle *= 0.35;
        continue;
      }
      d.update(dt, this._traffic, this._gapToPlayer(car), this.cfg.rubberBand !== false);
      if (d.wantsRespawn) this._respawn(car, 'ai');
    }

    if (this.phase === 'countdown' || this.phase === 'idle') return;

    // ---- rules ----
    this._stepRules(dt);
    this._stepPlayerFlags(dt);

    if (this.cfg.ghost) this.ghost.record(dt, cars.player?.state);
    if (this.mode === 'drift' && cars.player?.state) {
      this.driftScore = cars.player.state.driftScore ?? 0;
    }

    this._standingsClock += dt;
    if (this._standingsClock >= 0.05) {
      this._standingsClock = 0;
      this._rebuildStandings();
    }
  }

  _drivePlayer(dt, live, input, player) {
    const pv = this._vehicles.get(player);
    if (!pv) return;
    if (this._penalty > 0) {
      this._penalty -= dt;
      pv.controls.throttle = 0;
      pv.controls.brake = 1;
      pv.controls.steer = 0;
      pv.controls.nos = 0;
      pv.controls.handbrake = 0;
      return;
    }
    if (this.autopilot && this._playerAi) {
      if (live) {
        this._playerAi.update(dt, this._traffic, this._gapToLeader(player), false);
        if (this._playerAi.wantsRespawn) this._respawn(player, 'ai');
      } else this._playerAi.hold(dt, this.phase === 'countdown' ? 1 : 0.4);
      return;
    }
    const s = input.state;
    pv.controls.throttle = live ? s.throttle : 0;
    pv.controls.brake = live ? s.brake : this.phase === 'countdown' ? 1 : s.brake;
    pv.controls.steer = s.steer;
    pv.controls.handbrake = s.handbrake;
    pv.controls.nos = live ? s.nos : 0;
    if (s.reset && live) this._respawn(player, 'manual');
  }

  /** One projection per car per tick, shared by the AI, the rules and the standings. */
  _syncTraffic() {
    const track = this.ctx.world.track;
    const list = this._traffic.cars;
    list.length = 0;
    this._traffic.byCar.clear();
    for (const car of this.ctx.cars.instances) {
      const st = car.state;
      if (!st) continue;
      const proj = track.project(st.position, this.rules.record(car).t, this._projs.get(car));
      const entry = {
        car,
        proj,
        s: proj.t * track.length,
        t: proj.t,
        lateral: proj.lateral,
        speed: Math.max(st.speed, 0),
        isPlayer: car === this.ctx.cars.player,
      };
      list.push(entry);
      this._traffic.byCar.set(car, entry);
    }
  }

  _stepRules(dt) {
    const totalLaps = this.totalLaps;
    for (const entry of this._traffic.cars) {
      const car = entry.car;
      const evs = this.rules.step(car, entry.proj, this.time, totalLaps, this._events);
      for (const e of evs) {
        if (e.type === 'lap') {
          const rec = this.rules.record(car);
          this.ctx.bus.emit('lap:complete', { car, lap: e.lap, time: e.time, best: e.best });
          if (car === this.ctx.cars.player && this.cfg.ghost) this.ghost.commitLap(e.time);
          void rec;
        } else if (e.type === 'checkpoint') {
          this.ctx.bus.emit('checkpoint', { car, index: e.index, time: e.time });
        } else if (e.type === 'sector') {
          this.ctx.bus.emit('race:sector', { car, sector: e.sector, time: e.time });
        } else if (e.type === 'cut') {
          this.ctx.bus.emit('race:cut', { car, missing: e.missing });
          if (car === this.ctx.cars.player) this.ctx.hud?.toast?.('LAP INVALID — CHECKPOINT MISSED', 2200);
        } else if (e.type === 'finish') {
          this._onCarFinished(car);
        }
      }
    }
    void dt;
  }

  /**
   * A car took the flag. The *player's* race ending is what flips the phase to 'finished' and
   * fires race:finish (that is when the results screen is due); the rest of the field keeps
   * racing so the classification is real, until everyone is home or FINISH_GRACE expires.
   */
  _onCarFinished(car) {
    const isPlayer = car === this.ctx.cars.player;
    if (isPlayer && this.phase !== 'finished') {
      this.phase = 'finished';
      this._finishedAt = this.time;
      this._rebuildStandings();
      this.ctx.bus.emit('race:finish', { standings: this.standings });
    }
    if (this.ctx.cars.instances.every((c) => this.rules.record(c).finished)) {
      if (this.phase !== 'finished') {
        this.phase = 'finished';
        this._finishedAt = this.time;
        this._rebuildStandings();
        this.ctx.bus.emit('race:finish', { standings: this.standings });
      }
      this._raceOver = true;
      this._rebuildStandings();
    }
  }

  _stepPlayerFlags(dt) {
    const player = this.ctx.cars.player;
    const entry = this._traffic.byCar.get(player);
    if (!entry || !player.state) return;
    if (this.phase === 'finished' && this._raceOver) return;

    const track = this.ctx.world.track;
    const fwd = _v1.set(0, 0, -1).applyQuaternion(player.state.quaternion);
    const tan = track.tangentAt(entry.t, _v2);
    const along = fwd.dot(tan);
    const v = Math.abs(player.state.speed);

    if (along < -0.25 && v > 3) this._playerWrongWayT += dt;
    else this._playerWrongWayT = Math.max(0, this._playerWrongWayT - dt * 2);
    const wrong = this._playerWrongWayT > WRONGWAY_WARN;
    if (wrong !== this.wrongWay) {
      this.wrongWay = wrong;
      this.ctx.bus.emit('race:wrongway', { active: wrong, car: player });
      if (wrong) this.ctx.hud?.toast?.('WRONG WAY', 1600);
    }

    const off = Math.abs(entry.lateral) - (entry.proj.width || track.widthAt(entry.t));
    if (off > 0.6) this._playerOffTrackT += dt;
    else this._playerOffTrackT = Math.max(0, this._playerOffTrackT - dt * 2);
    const offNow = this._playerOffTrackT > OFFTRACK_WARN;
    if (offNow !== this.offTrack) {
      this.offTrack = offNow;
      this.ctx.bus.emit('race:offtrack', { active: offNow, car: player });
    }
  }

  /**
   * Put a car back on the racing line facing the right way, at the same arc position (so a
   * respawn can never buy progress) with a short penalty.
   */
  _respawn(car, reason = 'manual') {
    const track = this.ctx.world.track;
    const rec = this.rules.record(car);
    const t = wrap01(rec.t);
    const lateral = track.racingLine.offsetAt(t);
    const p = track.placeAt(t, lateral, 0.7);
    this.ctx.physics.reset(car, p.position, p.quaternion);
    this.ctx.physics.setVelocityAlong?.(car, RESPAWN_SPEED);
    this.rules.noteJump(car, t);
    rec.respawns++;
    const d = this._drivers.get(car);
    if (d) {
      d.resync();
      d.stats.respawns++;
    }
    if (car === this.ctx.cars.player) {
      this._playerAi?.resync();
      this._penalty = RESET_PENALTY;
      this._playerWrongWayT = 0;
      this._playerOffTrackT = 0;
      if (this.cfg.ghost) this.ghost.restartLap();
      this.ctx.hud?.toast?.('RESET', 1200);
    }
    this.ctx.bus.emit('race:respawn', { car, reason });
  }

  /** Signed metres from `car` to the player: + means the car is BEHIND the player. */
  _gapToPlayer(car) {
    const player = this.ctx.cars.player;
    const a = this.rules.record(car);
    const b = this.rules.record(player);
    if (!a || !b) return 0;
    const L = this.track.length;
    // include laps so a lapped car doesn't read as "just ahead"
    return (b.lap - a.lap) * L + arcDelta(b.s, a.s, L);
  }

  /** Same, but relative to whoever is leading — used when the player car is on autopilot. */
  _gapToLeader(car) {
    const lead = this.standings[0]?.car;
    if (!lead || lead === car) return 0;
    const a = this.rules.record(car);
    const b = this.rules.record(lead);
    const L = this.track.length;
    return (b.lap - a.lap) * L + arcDelta(b.s, a.s, L);
  }

  // ================================================================= standings

  _rebuildStandings() {
    const ordered = this.rules.order(this.ctx.cars.instances);
    const L = this.track.length;
    const lead = ordered[0] ? this.rules.record(ordered[0]) : null;
    const list = [];
    for (let i = 0; i < ordered.length; i++) {
      const car = ordered[i];
      const r = this.rules.record(car);
      // Distance gap while racing; once both cars are classified, the gap that matters is time.
      const gap = lead ? (lead.lap - r.lap) * L + arcDelta(lead.s, r.s, L) : 0;
      const timeGap = r.finished && lead?.finished ? r.finishTime - lead.finishTime : 0;
      list.push({
        car,
        name: car.driverName ?? car.def?.name ?? 'DRIVER',
        position: i + 1,
        lap: Math.min(r.lap + 1, this.totalLaps),
        lapsDone: r.lap,
        progress: r.progress,
        lapTime: this.time - r.lapStart,
        lastLap: r.lastLap,
        bestLap: r.best,
        sectors: r.sectors,
        totalTime: r.finished ? r.finishTime : this.time,
        finished: r.finished,
        finishTime: r.finishTime,
        gap: Math.max(gap, 0),
        timeGap,
        checkpoint: r.nextCp,
        driftScore: car.state?.driftScore ?? 0,
      });
    }
    // Drift events are scored, not raced.
    if (this.mode === 'drift') {
      list.sort((a, b) => b.driftScore - a.driftScore);
      list.forEach((e, i) => (e.position = i + 1));
    }
    this.standings = list;

    const p = this.ctx.cars.player;
    const pos = list.find((e) => e.car === p)?.position ?? 1;
    if (pos !== this._prevPlayerPos) {
      this._prevPlayerPos = pos;
      this.ctx.bus.emit('race:position', { car: p, position: pos, of: list.length });
    }
  }

  update(dt) {
    if (this.paused) return;
    // Classify the field once the grace period after the winner expires.
    if (this.phase === 'finished' && !this._raceOver) {
      if (this.time - this._finishedAt > FINISH_GRACE) {
        this._raceOver = true;
        this._rebuildStandings();
      }
    }
    void dt;
  }

  // ================================================================= public API

  getPosition(car) {
    return this.standings.find((s) => s.car === car)?.position ?? 1;
  }

  getProgress(car) {
    return this.rules?.record(car)?.progress ?? 0;
  }

  /** Player's current lap number, 1-based. */
  get laps() {
    const r = this.rules?.record(this.ctx.cars?.player);
    return Math.min((r?.lap ?? 0) + 1, this.totalLaps);
  }

  /** Best lap of the player, seconds (0 if none yet). */
  get bestLap() {
    return this.rules?.record(this.ctx.cars?.player)?.best ?? 0;
  }

  /** Driver line-up, for a UI standings board. */
  get drivers() {
    return this.ctx.cars.instances.map((c) => ({
      car: c,
      name: c.driverName,
      profile: this._drivers.get(c)?.profile ?? null,
    }));
  }

  // ================================================================= diagnostics

  /**
   * Machine-readable state for the behavioural harness (tools/racetest.mjs). Everything the tests
   * assert on is derived from here, and it is deliberately independent of `standings` so the two
   * can be cross-checked against each other.
   */
  debugSnapshot() {
    const track = this.ctx.world.track;
    const L = track.length;
    return {
      phase: this.phase,
      time: this.time,
      mode: this.mode,
      totalLaps: this.totalLaps,
      trackLength: L,
      checkpoints: track.checkpoints.length,
      raceOver: this._raceOver,
      rubberBand: { ...RUBBER_BAND, enabled: this.cfg.rubberBand !== false },
      cars: this.ctx.cars.instances.map((car) => {
        const r = this.rules.record(car);
        const d = this._drivers.get(car) ?? (car === this.ctx.cars.player ? this._playerAi : null);
        const st = car.state;
        const proj = this._traffic.byCar.get(car)?.proj;
        const halfW = proj ? proj.width : track.widthAt(r.t);
        const up = st ? _v1.set(0, 1, 0).applyQuaternion(st.quaternion).y : 1;
        const fwd = st ? _v1.set(0, 0, -1).applyQuaternion(st.quaternion) : null;
        const along = fwd ? fwd.dot(track.tangentAt(r.t, _v2)) : 1;
        return {
          name: car.driverName ?? car.def.name,
          def: car.def.id,
          isPlayer: car === this.ctx.cars.player,
          skill: d?.profile?.skill ?? null,
          bravery: d?.profile?.bravery ?? null,
          aggression: d?.profile?.aggression ?? null,
          consistency: d?.profile?.consistency ?? null,
          lap: r.lap,
          nextCp: r.nextCp,
          progress: r.progress,
          t: r.t,
          s: r.s,
          lateral: r.lateral,
          halfWidth: halfW,
          offTrack: Math.abs(r.lateral) - halfW > 0.6,
          flipped: up < 0.25,
          wrongWay: along < -0.25,
          speedKmh: st?.speedKmh ?? 0,
          laps: r.laps.slice(),
          best: r.best,
          lastLap: r.lastLap,
          sectors: r.sectors.slice(),
          bestSectors: r.bestSectors.slice(),
          finished: r.finished,
          finishTime: r.finishTime,
          finishOrder: r.finishOrder,
          invalidCuts: r.invalidCuts,
          respawns: r.respawns,
          barrierHits: this._barrierHits.get(car) ?? 0,
          barrierTaps: this._barrierTaps.get(car) ?? 0,
          position: this.getPosition(car),
          driftScore: st?.driftScore ?? 0,
          ai: d
            ? {
                mode: d.mode,
                band: d.band,
                trim: d.trim,
                steerTrim: d.steerTrim,
                yawCap: d.yawCap,
                brakeDemand: d.brakeDemand,
                targetSpeed: d.targetSpeed,
                offset: d.offset,
                mistakes: d.stats.mistakes,
                passes: d.stats.passes,
                offTrackTime: d.stats.offTrack,
                maxOffTrack: d.stats.maxOffTrack,
                respawns: d.stats.respawns,
              }
            : null,
        };
      }),
    };
  }

  /** Human-readable results table — used by the harness and available to the UI lane. */
  resultsTable() {
    return this.standings.map((s) => ({
      pos: s.position,
      name: s.name,
      car: s.car.def.name,
      laps: s.lapsDone,
      best: fmtLap(s.bestLap),
      total: s.finished ? fmtLap(s.finishTime) : '--',
      gap:
        s.position === 1
          ? '--'
          : s.finished && s.timeGap
            ? `+${s.timeGap.toFixed(2)}s`
            : `+${s.gap.toFixed(0)}m`,
    }));
  }

  get tuning() {
    return AI_TUNING;
  }

  dispose() {}
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
