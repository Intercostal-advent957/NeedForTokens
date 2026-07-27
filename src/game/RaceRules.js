import { arcDelta } from './racemath.js';

/**
 * Lap, checkpoint and timing bookkeeping — one record per car.
 *
 * ANTI-CUT DESIGN
 * ---------------
 * A lap only counts if the car crossed *every* `track.checkpoints` entry, **in order**, since the
 * last time it crossed the start/finish line. The rules are:
 *
 *  - Progress is measured as arc length `s` along the centreline (t * length). Each tick we take
 *    the signed wrapped delta `ds`. Checkpoints whose arc position lies inside `(sPrev, sNow]`
 *    are candidates.
 *  - A candidate is only *credited* if it is exactly the checkpoint we were waiting for
 *    (`nextCp`). Cross them out of order — by cutting a chicane, driving across the infield of a
 *    hairpin, or reversing over one — and the counter simply does not advance, so the lap can
 *    never be closed.
 *  - `|ds| > JUMP_LIMIT` is a discontinuity (teleport, respawn, a projection flip on a hairpin).
 *    Nothing is credited across it; we just resync `sPrev`. This is what makes the QA teleport
 *    hook and the respawn safe: they move the car but they can never buy it a lap.
 *  - The car must be within `CROSS_TOLERANCE` metres of the drivable corridor at the crossing,
 *    so driving round the outside of a checkpoint gate does not count either.
 *
 * Lap 1 starts at the green light with the grid *behind* the line, so the very first crossing of
 * checkpoint 0 is ignored (nextCp is 1 at that point, not N) — exactly as in real racing.
 */

/** One tick of arc movement larger than this is treated as a teleport, metres. */
export const JUMP_LIMIT = 25;
/**
 * How far outside the drivable corridor a checkpoint crossing is still accepted, metres.
 *
 * Generous on purpose. The anti-cut guarantee comes from *ordering* and from JUMP_LIMIT, not from
 * this number: a car that runs wide onto the run-off and rejoins has still driven the whole
 * circuit and must keep its lap, whereas a car that cuts the infield of a hairpin skips a
 * checkpoint entirely and is rejected however close to the road it stayed.
 */
export const CROSS_TOLERANCE = 30.0;
/** Number of timed sectors the checkpoint list is grouped into. */
export const SECTORS = 3;

export function makeRecord() {
  return {
    lap: 0, // completed laps
    nextCp: 1, // checkpoint index we are waiting for (0 = start/finish line)
    cpCount: 0, // checkpoints credited this lap
    s: 0,
    sPrev: 0,
    t: 0,
    lateral: 0,
    progress: 0, // lap + t — the sort key for standings
    lapStart: 0,
    lastLap: 0,
    best: 0,
    laps: [], // every completed lap time
    sector: 0,
    sectorStart: 0,
    sectors: [0, 0, 0],
    bestSectors: [0, 0, 0],
    finished: false,
    finishTime: 0,
    finishOrder: 0,
    started: false,
    invalidCuts: 0, // times a start-line crossing was rejected for missing checkpoints
    respawns: 0,
  };
}

export class RaceRules {
  /** @param {import('../world/Track.js').Track} track */
  constructor(track) {
    this.track = track;
    this.cpCount = track.checkpoints.length;
    this.cpS = track.checkpoints.map((c) => c.t * track.length);
    // sector boundary checkpoint indices: [0, n/3, 2n/3]
    this.sectorOf = new Array(this.cpCount);
    for (let i = 0; i < this.cpCount; i++) {
      this.sectorOf[i] = Math.min(SECTORS - 1, Math.floor((i * SECTORS) / this.cpCount));
    }
    this.records = new Map();
    this.finishCount = 0;
  }

  record(car) {
    let r = this.records.get(car);
    if (!r) this.records.set(car, (r = makeRecord()));
    return r;
  }

  /** Put a car back on the grid: lap 0, waiting for checkpoint 1, timers zeroed. */
  reset(car, t, time = 0) {
    const r = makeRecord();
    r.s = t * this.track.length;
    r.sPrev = r.s;
    r.t = t;
    r.lapStart = time;
    r.sectorStart = time;
    r.progress = t - 1;
    this.records.set(car, r);
    return r;
  }

  /**
   * Drop the car in mid-race at `t` on lap `lap` with all preceding checkpoints deemed taken.
   * Used by the QA teleport hook, which is explicitly not a gameplay path — it must produce a
   * *consistent* state rather than a cheatable one.
   */
  place(car, t, time, lap = 0) {
    const r = this.reset(car, t, time);
    r.lap = lap;
    // Credit only the checkpoints strictly behind the drop point, so the car still has to drive
    // the rest of the lap properly.
    let next = 1;
    for (let i = 1; i < this.cpCount; i++) if (this.cpS[i] <= t * this.track.length) next = i + 1;
    r.nextCp = next;
    r.cpCount = next - 1;
    r.sector = this.sectorOf[Math.min(next, this.cpCount) % this.cpCount];
    r.started = true;
    r.progress = this._progressOf(r, t);
    return r;
  }

  /** Called when a car is teleported/respawned without gaining progress. */
  noteJump(car, t) {
    const r = this.record(car);
    r.s = t * this.track.length;
    r.sPrev = r.s;
    r.t = t;
  }

  /**
   * Advance one car. Returns a list of events for the caller to emit
   * (kept as a reused array so this allocates nothing in the steady state).
   */
  step(car, proj, time, totalLaps, out) {
    out.length = 0;
    const L = this.track.length;
    const r = this.record(car);
    const sNow = proj.t * L;
    const ds = arcDelta(sNow, r.sPrev, L);

    if (Math.abs(ds) > JUMP_LIMIT) {
      // Discontinuity — credit nothing.
      r.sPrev = sNow;
      r.s = sNow;
      r.t = proj.t;
      r.lateral = proj.lateral;
      r.progress = this._progressOf(r, proj.t);
      return out;
    }

    if (ds > 0 && !r.finished) {
      const onTrack = Math.abs(proj.lateral) <= (proj.width || 0) + CROSS_TOLERANCE;
      // Walk every checkpoint whose arc position falls in (sPrev, sNow]. At <=25 m of travel per
      // tick this is at most one, but the loop keeps it correct at any timestep.
      for (let i = 0; i < this.cpCount; i++) {
        const cs = this.cpS[i];
        // did we sweep past cs going forward, allowing for the wrap at s = 0?
        const before = arcDelta(cs, r.sPrev, L);
        if (!(before > 0 && before <= ds)) continue;
        if (!onTrack) continue;

        if (i === 0) {
          // start/finish line
          if (r.nextCp === this.cpCount) {
            r.lap++;
            r.cpCount = 0;
            r.nextCp = 1;
            const lapTime = time - r.lapStart;
            r.lastLap = lapTime;
            r.laps.push(lapTime);
            if (!r.best || lapTime < r.best) r.best = lapTime;
            // close the final sector
            this._closeSector(r, time);
            r.lapStart = time;
            r.sectorStart = time;
            r.sector = 0;
            out.push({ type: 'lap', lap: r.lap, time: lapTime, best: r.best });
            if (r.lap >= totalLaps && !r.finished) {
              r.finished = true;
              r.finishTime = time;
              r.finishOrder = ++this.finishCount;
              out.push({ type: 'finish', time });
            }
          } else if (r.started) {
            // Crossed the line without the full set of checkpoints — course cut, rejected.
            r.invalidCuts++;
            out.push({ type: 'cut', missing: this.cpCount - r.nextCp });
          } else {
            // First crossing off the grid: this is the start of lap 1, not the end of one.
            r.started = true;
            r.lapStart = time;
            r.sectorStart = time;
          }
        } else if (i === r.nextCp) {
          r.nextCp++;
          r.cpCount++;
          out.push({ type: 'checkpoint', index: i, time });
          // sector boundary?
          if (this.sectorOf[i] !== r.sector) {
            this._closeSector(r, time);
            r.sector = this.sectorOf[i];
            r.sectorStart = time;
            out.push({ type: 'sector', sector: r.sector, time: r.sectors[(r.sector + SECTORS - 1) % SECTORS] });
          }
        }
      }
    }

    r.sPrev = sNow;
    r.s = sNow;
    r.t = proj.t;
    r.lateral = proj.lateral;
    r.progress = this._progressOf(r, proj.t);
    return out;
  }

  /**
   * Sort key for standings.
   *
   * The subtlety is the grid: it sits *behind* the start line, so a car that has not taken the
   * start yet is at t = 0.99 and would otherwise sort as though it were most of a lap ahead of
   * the cars that have just crossed. Until a car has been past checkpoint 0 once, its lap counter
   * is treated as -1, which puts the whole grid in the right order from the first tick.
   */
  _progressOf(r, t) {
    return (r.started ? r.lap : r.lap - 1) + t;
  }

  _closeSector(r, time) {
    const i = r.sector;
    const dt = time - r.sectorStart;
    if (dt > 0.5) {
      r.sectors[i] = dt;
      if (!r.bestSectors[i] || dt < r.bestSectors[i]) r.bestSectors[i] = dt;
    }
  }

  /**
   * Sort into a finishing order that is correct across different laps:
   * finished cars first by the order they took the flag, then everyone else by lap + lap fraction.
   */
  order(cars) {
    return cars.slice().sort((a, b) => {
      const ra = this.record(a);
      const rb = this.record(b);
      if (ra.finished !== rb.finished) return ra.finished ? -1 : 1;
      if (ra.finished && rb.finished) return ra.finishOrder - rb.finishOrder;
      return rb.progress - ra.progress;
    });
  }
}
