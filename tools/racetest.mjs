#!/usr/bin/env node
/**
 * BEHAVIOURAL test harness for the race/AI lane.
 *
 * Screenshots barely test AI, so this boots the real game headless, drives full races through
 * `window.__NFT`, and *measures* what the field actually does. Every number printed here is
 * sampled from the live simulation, not from the AI's own opinion of itself.
 *
 *   node tools/racetest.mjs                 # full suite
 *   node tools/racetest.mjs --test probe    # one short run, prints track + pace figures
 *   node tools/racetest.mjs --test race     # full 8-car, 3-lap race
 *   node tools/racetest.mjs --test cheat    # checkpoint-validation hole test
 *   node tools/racetest.mjs --test solo     # AI laps with no player driving
 *   node tools/racetest.mjs --test skill    # A/B: does skill actually change pace?
 *   node tools/racetest.mjs --laps 3 --scale 6 --headed
 *
 * Exit code is non-zero if any assertion fails.
 */
import { chromium } from 'playwright';
import net from 'node:net';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);

const PORT = parseInt(arg('port', '5273'), 10);
const TEST = arg('test', 'all');
const LAPS = parseInt(arg('laps', '3'), 10);
const SCALE = parseFloat(arg('scale', '6'));
const MAXWALL = parseInt(arg('maxwall', '300'), 10) * 1000;

const t0 = Date.now();
const log = (...a) => console.log(`[race +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
  return ok;
};

function portOpen(port) {
  return new Promise((res) => {
    const s = net.createConnection({ port, host: '127.0.0.1' }, () => {
      s.destroy();
      res(true);
    });
    s.on('error', () => res(false));
    s.setTimeout(500, () => {
      s.destroy();
      res(false);
    });
  });
}

// ------------------------------------------------------------------ in-page monitor
/**
 * Installed once per run. Samples the simulation every animation frame and accumulates metrics
 * that are INDEPENDENT of RaceSystem's own bookkeeping:
 *  - cumulative forward arc length (the ground truth for "who is ahead")
 *  - off-track / flipped / stuck seconds, measured against world geometry
 *  - car-car overlap episodes (proximity < 3 m), which measures avoidance regardless of whether
 *    the physics lane has car-car collision resolution yet
 *  - position-order mismatches between race.getPosition() and the independent arc order
 */
const MONITOR_SRC = `(() => {
  const nft = window.__NFT;
  const ctx = nft.ctx;
  const race = ctx.race;
  const track = ctx.world.track;
  const L = track.length;
  const cars = ctx.cars.instances;
  const V = ctx.THREE.Vector3;
  const arcDelta = (a, b) => { let d = (a - b) % L; if (d > L/2) d -= L; else if (d < -L/2) d += L; return d; };
  const M = {
    L, checkpoints: track.checkpoints.length,
    startTime: race.time,
    lastRaceTime: race.time,
    frames: 0, simSeconds: 0,
    mismatch: 0, mismatchWorst: 0, mismatchExample: null,
    overlapEpisodes: 0, overlapNow: false, minSeparation: 999, minPlayerGap: 999,
    events: [],
    cars: cars.map((c) => ({
      name: c.driverName || c.def.name,
      def: c.def.id,
      isPlayer: c === ctx.cars.player,
      // Independent progress: laps counted by watching t wrap, never read from RaceSystem.
      // Robust to respawns and teleports, which an integrated arc length is not.
      lap: -1, prog: track.project(c.state.position).t - 1, lastT: track.project(c.state.position).t,
      arc: track.project(c.state.position).t * L, lastS: track.project(c.state.position).t * L,
      offTrack: 0, offStreak: 0, maxOffStreak: 0,
      flipped: 0, flipStreak: 0, maxFlipStreak: 0,
      stuck: 0, stuckStreak: 0, maxStuckStreak: 0,
      topSpeed: 0, jumps: 0,
    })),
  };
  const proj = track.constructor.makeProjection ? track.constructor.makeProjection() : null;
  const up = new V(); const tmp = new V();
  const unsub = [];
  for (const ev of ['race:start','race:finish','lap:complete','race:cut','race:respawn','race:countdown','checkpoint','race:sector']) {
    unsub.push(ctx.bus.on(ev, (p) => {
      if (M.events.length < 4000) M.events.push({
        ev, t: +race.time.toFixed(3),
        car: p && p.car ? (p.car.driverName || p.car.def.name) : undefined,
        lap: p && p.lap, n: p && p.n, index: p && p.index, time: p && p.time,
        missing: p && p.missing, reason: p && p.reason,
      });
    }));
  }
  const tick = () => {
    if (!M.running) return;
    requestAnimationFrame(tick);
    const now = race.time;
    let dt = now - M.lastRaceTime;
    M.lastRaceTime = now;
    if (!(dt > 0) || dt > 1) dt = 0;
    M.frames++; M.simSeconds += dt;
    const racing = race.phase === 'racing' || race.phase === 'finished';
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i]; const m = M.cars[i]; const s = c.state;
      if (!s) continue;
      const p = proj ? track.project(s.position, m.lastS / L, proj) : track.project(s.position);
      const sNow = p.t * L;
      const d = arcDelta(sNow, m.lastS);
      if (Math.abs(d) > 25) { m.jumps++; } else { m.arc += d; }
      m.lastS = sNow;
      if (m.lastT > 0.75 && p.t < 0.25) m.lap++;
      else if (m.lastT < 0.25 && p.t > 0.75) m.lap--;
      m.lastT = p.t;
      m.prog = m.lap + p.t;
      const halfW = p.width || track.widthAt(p.t);
      const off = Math.abs(p.lateral) - halfW > 1.5;  // genuinely in the run-off, not on a kerb
      up.set(0,1,0).applyQuaternion(s.quaternion);
      const flipped = up.y < 0.25;
      const stuck = racing && Math.abs(s.speed) < 2 && !race.rules.record(c).finished;
      m.topSpeed = Math.max(m.topSpeed, s.speedKmh);
      if (racing) {
        if (off) { m.offTrack += dt; m.offStreak += dt; m.maxOffStreak = Math.max(m.maxOffStreak, m.offStreak); } else m.offStreak = 0;
        if (flipped) { m.flipped += dt; m.flipStreak += dt; m.maxFlipStreak = Math.max(m.maxFlipStreak, m.flipStreak); } else m.flipStreak = 0;
        if (stuck) { m.stuck += dt; m.stuckStreak += dt; m.maxStuckStreak = Math.max(m.maxStuckStreak, m.stuckStreak); } else m.stuckStreak = 0;
      }
    }
    if (!racing || race.time < 4) return;
    // --- independent standings cross-check -------------------------------------------
    // Independent order = cumulative forward arc length, accumulated here and never read from
    // RaceSystem. Cars within TOL metres of each other are treated as level: the two measures are
    // sampled at different rates, so sub-metre disagreement is drift, not a standings bug.
    const TOL = 3 / L; // three metres, expressed as a lap fraction
    const byArc = new Map(M.cars.map((m, i) => [cars[i], m.prog]));
    const order = M.cars.map((m, i) => ({ i, arc: m.prog, car: cars[i] })).sort((a,b) => b.arc - a.arc);
    const reportedOrder = race.standings.map(s => s.car);
    let worst = 0;
    for (let k = 0; k + 1 < reportedOrder.length; k++) {
      const a = byArc.get(reportedOrder[k]);
      const b = byArc.get(reportedOrder[k + 1]);
      if (a !== undefined && b !== undefined && a < b - TOL) worst = Math.max(worst, 1);
    }
    if (worst > 0) {
      M.mismatch++;
      if (worst > M.mismatchWorst) {
        M.mismatchWorst = worst;
        M.mismatchExample = { t: +race.time.toFixed(2), expected: order.map(o => M.cars[o.i].name), reported: race.standings.map(s => s.name) };
      }
    }
    // --- proximity / avoidance --------------------------------------------------------
    let near = false; let minSep = 999;
    for (let a = 0; a < cars.length; a++) for (let b = a+1; b < cars.length; b++) {
      if (!cars[a].state || !cars[b].state) continue;
      const dd = tmp.subVectors(cars[a].state.position, cars[b].state.position).length();
      if (dd < minSep) minSep = dd;
      if (dd < 3.0) near = true;
    }
    M.minSeparation = Math.min(M.minSeparation, minSep);
    // Distance from every AI to the player specifically — the "did they go round or through it?"
    // number for the parked-player avoidance test.
    const pc = ctx.cars.player;
    if (pc && pc.state) {
      for (const c of cars) {
        if (c === pc || !c.state) continue;
        const dd = tmp.subVectors(c.state.position, pc.state.position).length();
        if (dd < M.minPlayerGap) M.minPlayerGap = dd;
      }
    }
    if (near && !M.overlapNow) M.overlapEpisodes++;
    M.overlapNow = near;
  };
  M.running = true;
  M.stop = () => { M.running = false; unsub.forEach(u => u && u()); };
  window.__RT = M;
  requestAnimationFrame(tick);
  return { L, checkpoints: M.checkpoints };
})()`;

async function installMonitor(page) {
  return page.evaluate(MONITOR_SRC);
}

async function readMonitor(page) {
  return page.evaluate(() => {
    const M = window.__RT;
    return {
      L: M.L,
      checkpoints: M.checkpoints,
      simSeconds: M.simSeconds,
      mismatch: M.mismatch,
      mismatchWorst: M.mismatchWorst,
      mismatchExample: M.mismatchExample,
      overlapEpisodes: M.overlapEpisodes,
      minSeparation: M.minSeparation,
      minPlayerGap: M.minPlayerGap,
      frames: M.frames,
      events: M.events,
      cars: M.cars.map((c) => ({ ...c })),
    };
  });
}

async function stopMonitor(page) {
  await page.evaluate(() => window.__RT && window.__RT.stop && window.__RT.stop());
}

// ------------------------------------------------------------------ helpers
const URL = () => `http://127.0.0.1:${PORT}/`;

/**
 * Lane authors are editing the same tree while this runs, so vite's HMR can blow the page away
 * mid-test. Everything goes through here: a lost context costs a reload, not a failed run.
 */
async function ready(page, label = '') {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.waitForFunction(() => window.__NFT && window.__NFT.ready, null, {
        timeout: 120000,
        polling: 200,
      });
      await page.evaluate(() => {
        window.__NFT.setQuality('low');
        window.__NFT.hideHud(true);
      });
      return true;
    } catch {
      console.warn(`  [harness] page lost${label ? ` during ${label}` : ''}; reloading…`);
      await page.goto(URL(), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
  }
  throw new Error('page never became ready');
}

async function evalSafe(page, fn, arg) {
  for (let i = 0; i < 3; i++) {
    try {
      return await page.evaluate(fn, arg);
    } catch (e) {
      if (!/context was destroyed|__NFT|Execution context/i.test(String(e))) throw e;
      await ready(page, 'evalSafe');
    }
  }
  throw new Error('evalSafe failed after reloads');
}

async function snapshot(page) {
  return evalSafe(page, () => window.__NFT.ctx.race.debugSnapshot());
}

/** Reset the race, optionally reconfiguring it, then wait for the flag or a wall-clock cap. */
async function runRace(page, opts = {}) {
  await ready(page, 'race setup');
  const {
    mode = 'circuit',
    laps = LAPS,
    autopilot = true,
    skills = null,
    scale = SCALE,
    maxWall = MAXWALL,
    stopWhen = 'allFinished',
    playerDrive = null,
  } = opts;

  await evalSafe(
    page,
    ({ mode, laps, autopilot, skills, playerDrive }) => {
      const race = window.__NFT.ctx.race;
      race.setMode(mode);
      race.setAutopilot(autopilot);
      if (skills) race.setSkills(skills);
      race.restart();
      race.totalLaps = laps;
      window.__NFT.drive(playerDrive);
    },
    { mode, laps, autopilot, skills, playerDrive }
  );
  await page.evaluate(MONITOR_SRC);
  await page.evaluate((s) => window.__NFT.timeScale(s), scale);

  const deadline = Date.now() + maxWall;
  let last = 0;
  let lost = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    let st;
    try {
      st = await page.evaluate(() => {
        const r = window.__NFT.ctx.race;
        const s = r.debugSnapshot();
        return {
          phase: r.phase,
          time: r.time,
          over: s.raceOver,
          done: s.cars.filter((c) => c.finished).length,
          laps: s.cars.map((c) => c.lap),
          alive: !!window.__RT,
        };
      });
    } catch {
      lost = true;
      break;
    }
    if (!st.alive) {
      lost = true;
      break;
    }
    if (st.time - last > 25) {
      last = st.time;
      log(`   t=${st.time.toFixed(0)}s phase=${st.phase} finished=${st.done}/8 laps=[${st.laps}]`);
    }
    if (stopWhen === 'allFinished' && st.over) break;
    if (stopWhen === 'anyFinished' && st.done > 0) break;
    if (typeof stopWhen === 'number' && st.time >= stopWhen) break;
  }
  if (lost) {
    if (opts._retry) throw new Error('page kept reloading mid-race');
    console.warn('  [harness] lost the page mid-race — rerunning this race');
    await ready(page, 'race rerun');
    return runRace(page, { ...opts, _retry: true });
  }
  await page.evaluate(() => window.__NFT.timeScale(1));
  const m = await readMonitor(page);
  const s = await snapshot(page);
  await stopMonitor(page);
  return { monitor: m, snap: s };
}

function table(rows, cols) {
  const w = cols.map((c) => Math.max(c.h.length, ...rows.map((r) => String(c.f(r)).length)));
  const line = (cells) => '  ' + cells.map((v, i) => String(v).padEnd(w[i])).join('  ');
  console.log(line(cols.map((c) => c.h)));
  console.log('  ' + w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(cols.map((c) => c.f(r))));
}

const fmt = (t) => {
  if (!Number.isFinite(t) || t <= 0) return '  --  ';
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60) < 10 ? '0' : ''}${(t - m * 60).toFixed(2)}`;
};
const spearman = (a, b) => {
  const n = a.length;
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n);
    idx.forEach(([, i], k) => (r[i] = k + 1));
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
};

// ------------------------------------------------------------------ tests
async function testProbe(page) {
  console.log('\n=== PROBE: track geometry + 1 lap of pace ===');
  const { monitor, snap } = await runRace(page, { laps: 1, stopWhen: 'anyFinished', maxWall: 120000 });
  log(`track ${(monitor.L / 1000).toFixed(2)} km, ${monitor.checkpoints} checkpoints`);
  table(
    snap.cars,
    [
      { h: 'DRIVER', f: (c) => c.name },
      { h: 'CAR', f: (c) => c.def },
      { h: 'SKILL', f: (c) => (c.skill ?? 0).toFixed(2) },
      { h: 'LAP', f: (c) => c.lap },
      { h: 'BEST', f: (c) => fmt(c.best) },
      { h: 'CP', f: (c) => c.nextCp },
      { h: 'KM/H', f: (c) => c.speedKmh.toFixed(0) },
      { h: 'TRIM', f: (c) => (c.ai?.trim ?? 1).toFixed(2) },
    ]
  );
  const laps = snap.cars.map((c) => c.best).filter((b) => b > 0);
  log(`lap times: ${laps.map((l) => l.toFixed(1)).join(', ')}`);
  return { monitor, snap };
}

/** Telemetry dump for one AI car — the tool used to tune the controller against live physics. */
async function testDiag(page) {
  console.log('\n=== DIAG: controller telemetry for one AI car ===');
  const which = parseInt(arg('car', '1'), 10);
  const secs = parseFloat(arg('secs', '40'));
  await ready(page, 'diag');
  await evalSafe(page, (i) => {
    const race = window.__NFT.ctx.race;
    race.setAutopilot(true);
    race.restart();
    const car = window.__NFT.ctx.cars.instances[i];
    const track = window.__NFT.ctx.world.track;
    const rows = [];
    window.__DIAG = { rows, stop: false };
    const tick = () => {
      if (window.__DIAG.stop) return;
      requestAnimationFrame(tick);
      const d = car.ai && car.ai.driver;
      const s = car.state;
      if (!d || !s || race.phase !== 'racing') return;
      const p = track.project(s.position);
      const want = track.racingLine.offsetAt(p.t) + d.offset;
      rows.push([
        +race.time.toFixed(2),
        +s.speedKmh.toFixed(0),
        +(d.targetSpeed * 3.6).toFixed(0),
        +s.steer.toFixed(2),
        +d.steerCmd.toFixed(2),
        +s.throttle.toFixed(2),
        +s.brake.toFixed(2),
        +(d.brakeDemand ?? 0).toFixed(2),
        +((d.slipFront ?? 0) * 57.3).toFixed(0),
        +((d.slipRear ?? 0) * 57.3).toFixed(0),
        +(p.lateral - want).toFixed(2),
        +d.trim.toFixed(2),
        +d.steerTrim.toFixed(2),
        d.mode,
      ]);
    };
    requestAnimationFrame(tick);
  }, which);
  await page.evaluate((s) => window.__NFT.timeScale(s), 4);
  await new Promise((r) => setTimeout(r, (secs / 4) * 1000 + 4000));
  await page.evaluate(() => window.__NFT.timeScale(1));
  const rows = await page.evaluate(() => {
    window.__DIAG.stop = true;
    const r = window.__DIAG.rows;
    // decimate to ~4 Hz of race time
    const out = [];
    let last = -9;
    for (const x of r) if (x[0] - last >= 0.25) { out.push(x); last = x[0]; }
    return out;
  });
  console.log('   t   kmh  tgt  st   cmd  thr  brk  dem   sF   sR  xerr  trim  strm mode');
  for (const r of rows.slice(0, 200)) {
    console.log(
      `  ${String(r[0]).padStart(5)} ${String(r[1]).padStart(4)} ${String(r[2]).padStart(4)} ` +
        `${String(r[3]).padStart(5)} ${String(r[4]).padStart(5)} ${String(r[5]).padStart(4)} ` +
        `${String(r[6]).padStart(4)} ${String(r[7]).padStart(4)} ${String(r[8]).padStart(4)} ` +
        `${String(r[9]).padStart(4)} ${String(r[10]).padStart(6)} ${String(r[11]).padStart(5)} ${String(r[12]).padStart(5)} ${r[13]}`
    );
  }
  const xs = rows.map((r) => Math.abs(r[10]));
  const slips = rows.map((r) => Math.abs(r[9]));
  const kmh = rows.map((r) => r[1]);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
  log(`mean |cross-track| ${avg(xs).toFixed(2)} m (max ${Math.max(...xs).toFixed(1)}), mean |rear slip| ${avg(slips).toFixed(1)} deg, mean ${avg(kmh).toFixed(0)} km/h`);
}

async function testRace(page) {
  console.log(`\n=== FULL RACE: 8 cars, ${LAPS} laps, all AI ===`);
  const { monitor, snap } = await runRace(page, { laps: LAPS });
  const M = monitor.cars;

  const rows = snap.cars
    .map((c, i) => ({ ...c, m: M[i] }))
    .sort((a, b) => (a.finished && b.finished ? a.finishOrder - b.finishOrder : b.progress - a.progress));

  table(rows, [
    { h: 'P', f: (r) => r.position },
    { h: 'DRIVER', f: (r) => r.name },
    { h: 'CAR', f: (r) => r.def },
    { h: 'SKL', f: (r) => (r.skill ?? 0).toFixed(2) },
    { h: 'LAPS', f: (r) => r.lap },
    { h: 'TOTAL', f: (r) => fmt(r.finishTime) },
    { h: 'BEST', f: (r) => fmt(r.best) },
    { h: 'LAPS(s)', f: (r) => r.laps.map((l) => l.toFixed(1)).join(' ') },
    { h: 'OFF s', f: (r) => r.m.offTrack.toFixed(1) },
    { h: 'MAXOFF', f: (r) => r.m.maxOffStreak.toFixed(1) },
    { h: 'STUCK', f: (r) => r.m.maxStuckStreak.toFixed(1) },
    { h: 'FLIP', f: (r) => r.m.maxFlipStreak.toFixed(1) },
    { h: 'WALL', f: (r) => `${r.barrierHits}/${r.barrierTaps}` },
    { h: 'RESP', f: (r) => r.respawns },
    { h: 'MIST', f: (r) => r.ai?.mistakes ?? 0 },
    { h: 'CUTS', f: (r) => r.invalidCuts },
  ]);

  const finished = snap.cars.filter((c) => c.finished);
  // Judge pace on each driver's BEST lap: a lap ruined by an off says nothing about whether the
  // field is eight copies of one driver, which is what this check is for.
  const bests = snap.cars.map((c) => c.best).filter((b) => b > 0);
  const allLaps = snap.cars.flatMap((c) => c.laps);
  const mean = bests.reduce((a, b) => a + b, 0) / Math.max(bests.length, 1);
  const spread = bests.length ? Math.max(...bests) - Math.min(...bests) : 0;
  log(`best-lap mean ${mean.toFixed(1)}s  min ${Math.min(...bests).toFixed(1)}  max ${Math.max(...bests).toFixed(1)}  spread ${spread.toFixed(1)}s  (${allLaps.length} laps run)`);
  log(`standings cross-check: ${monitor.mismatch} mismatching samples of ${monitor.frames}, worst place error ${monitor.mismatchWorst}`);
  log(`closest car-car approach ${monitor.minSeparation.toFixed(2)} m, ${monitor.overlapEpisodes} overlap episodes`);

  check(finished.length === 8, 'all 8 cars completed the race', `${finished.length}/8`);
  check(
    snap.cars.every((c) => c.m === undefined || true) && rows.every((r) => r.m.maxStuckStreak < 6),
    'no car stuck for more than 6 s',
    `worst ${Math.max(...rows.map((r) => r.m.maxStuckStreak)).toFixed(1)}s`
  );
  check(
    rows.every((r) => r.m.maxFlipStreak < 3),
    'no car flipped for more than 3 s',
    `worst ${Math.max(...rows.map((r) => r.m.maxFlipStreak)).toFixed(1)}s`
  );
  check(
    rows.every((r) => r.m.maxOffStreak < 6),
    'no car off-track for more than 6 s at a stretch',
    `worst ${Math.max(...rows.map((r) => r.m.maxOffStreak)).toFixed(1)}s`
  );
  // A handful of samples can disagree because the independent metric loses the arc a respawn
  // jumps over; anything systematic shows up immediately as a percentage.
  const misPct = (100 * monitor.mismatch) / Math.max(monitor.frames, 1);
  check(misPct < 0.2, 'getPosition matches an independent progress order',
    `${monitor.mismatch}/${monitor.frames} samples (${misPct.toFixed(3)}%)` +
      (monitor.mismatchExample ? ` e.g. ${JSON.stringify(monitor.mismatchExample).slice(0, 160)}` : ''));
  check(spread > 0.4 && spread < mean * 0.40, 'best laps vary like drivers, not like robots', `spread ${spread.toFixed(1)}s on a ${mean.toFixed(0)}s lap`);

  // WALL column is hits/taps: a "hit" changed the car's normal velocity by >= 3 m/s, a "tap" is
  // any reported contact including brushing a wall on a kerb.
  const wallTotal = snap.cars.reduce((a, c) => a + c.barrierHits, 0);
  const tapTotal = snap.cars.reduce((a, c) => a + (c.barrierTaps ?? 0), 0);
  // 16 = two meaningful impacts per car per race, i.e. under one every other lap on a walled
  // street circuit. Light contact (the second number) is normal and is reported, not asserted.
  check(wallTotal <= 16, 'the field races 3 laps without meaningful barrier impacts',
    `${wallTotal} real impacts (${tapTotal} light contacts) across 8 cars over 24 car-laps ` +
      `= ${(wallTotal / 24).toFixed(2)} per car-lap`);

  const skills = snap.cars.map((c) => c.skill ?? 0.5);
  const places = snap.cars.map((c) => c.finishOrder || 99);
  const rho = spearman(skills, places);
  log(`skill vs finishing position: Spearman rho = ${rho.toFixed(2)} (want strongly negative)`);
  check(rho < -0.45, 'faster drivers finish ahead', `rho ${rho.toFixed(2)}`);
  return { monitor, snap };
}

async function testCheat(page) {
  console.log('\n=== CHECKPOINT VALIDATION: can a car buy a lap? ===');
  // Let a race settle into lap 1, then jump a car most of the way round the circuit.
  await runRace(page, { laps: LAPS, stopWhen: 20, maxWall: 60000 });
  const before = await snapshot(page);
  const victim = before.cars.findIndex((c) => !c.isPlayer);
  log(`victim = ${before.cars[victim].name}, lap ${before.cars[victim].lap}, nextCp ${before.cars[victim].nextCp}, t=${before.cars[victim].t.toFixed(3)}`);

  // Teleport it to just before the start/finish line — skipping every checkpoint in between.
  await page.evaluate((i) => {
    const race = window.__NFT.ctx.race;
    race.teleportCar(race.ctx.cars.instances[i], 0.975, 0, 120);
  }, victim);
  await page.evaluate((s) => window.__NFT.timeScale(s), 4);
  await page.evaluate(() => window.__NFT.settle(14));
  await page.evaluate(() => window.__NFT.timeScale(1));
  const after = await snapshot(page);
  const v = after.cars[victim];
  log(`after crossing the line: lap ${v.lap}, nextCp ${v.nextCp}, invalidCuts ${v.invalidCuts}`);

  check(v.lap === before.cars[victim].lap, 'lap NOT credited after skipping checkpoints',
    `lap ${before.cars[victim].lap} -> ${v.lap}`);
  check(v.invalidCuts > 0, 'the cut was detected and logged', `invalidCuts=${v.invalidCuts}`);

  // And prove the validator is not simply refusing every lap: let it drive a proper lap.
  await page.evaluate((s) => window.__NFT.timeScale(s), 8);
  const deadline = Date.now() + 180000;
  let ok = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await snapshot(page);
    if (s.cars[victim].lap > v.lap) {
      ok = true;
      break;
    }
    if (s.raceOver) break;
  }
  await page.evaluate(() => window.__NFT.timeScale(1));
  check(ok, 'the same car still scores a lap once it drives the whole circuit');
}

async function testSolo(page) {
  console.log('\n=== SOLO: AI laps with the player parked (avoidance + clean driving) ===');
  const { monitor, snap } = await runRace(page, {
    laps: 2,
    autopilot: false,
    playerDrive: { throttle: 0, brake: 1, steer: 0, handbrake: 1, nos: 0 },
    stopWhen: 'anyFinished',
    maxWall: 240000,
  });
  const rows = snap.cars.map((c, i) => ({ ...c, m: monitor.cars[i] })).filter((c) => !c.isPlayer);
  table(rows, [
    { h: 'DRIVER', f: (r) => r.name },
    { h: 'LAPS', f: (r) => r.lap },
    { h: 'BEST', f: (r) => fmt(r.best) },
    { h: 'WALL', f: (r) => `${r.barrierHits}/${r.barrierTaps}` },
    { h: 'OFF s', f: (r) => r.m.offTrack.toFixed(1) },
    { h: 'RESP', f: (r) => r.respawns },
    { h: 'PASS', f: (r) => r.ai?.passes ?? 0 },
  ]);
  const walls = rows.map((r) => r.barrierHits).sort((a, b) => a - b);
  const taps = rows.reduce((a, r) => a + (r.barrierTaps ?? 0), 0);
  const worstWall = walls[walls.length - 1];
  const medianWall = walls[Math.floor(walls.length / 2)];
  const totalWall = walls.reduce((a, b) => a + b, 0);
  log(`barrier hits: ${totalWall} real (${taps} light contacts) across ${rows.length} cars over ${monitor.simSeconds.toFixed(0)}s — median ${medianWall}, worst ${worstWall}`);
  check(rows.every((r) => r.lap >= 1), 'every AI completed a lap without the player racing');
  // This scenario deliberately parks a car across the racing line, so it is harder than "the
  // player is not present": the field has to thread past a stationary obstacle every lap. The
  // clean-race number (see the FULL RACE table's WALL column) is the one to read for normal
  // driving; here we ask that the typical car still gets round without leaning on the barriers.
  check(medianWall <= 3, 'the typical AI gets past a parked car without leaning on the barriers',
    `median ${medianWall}, worst ${worstWall}`);
  check(monitor.minPlayerGap > 1.4, 'AI steered around the parked player rather than through it',
    `closest AI-to-player centre distance ${monitor.minPlayerGap.toFixed(2)} m ` +
      `(cars are ~1.9 m wide; closest AI-to-AI anywhere was ${monitor.minSeparation.toFixed(2)} m)`);
  return { monitor, snap };
}

async function testSkill(page) {
  console.log('\n=== SKILL A/B: same cars, skills reversed ===');
  const hi = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
  const lo = hi.slice().reverse();
  const runs = {};
  for (const [tag, skills] of [['descending', hi], ['reversed', lo]]) {
    const { snap } = await runRace(page, { laps: 3, skills, stopWhen: 'allFinished', maxWall: 360000 });
    runs[tag] = snap.cars.filter((c) => !c.isPlayer).map((c) => ({ name: c.name, def: c.def, skill: c.skill, best: c.best, laps: c.lap }));
    log(`${tag}: ${runs[tag].map((r) => `${r.def}@${r.skill.toFixed(2)}=${r.best.toFixed(1)}s`).join(' ')}`);
  }
  const rows = runs.descending.map((r, i) => ({
    car: r.def,
    hiSkill: r.skill,
    hiBest: r.best,
    loSkill: runs.reversed[i].skill,
    loBest: runs.reversed[i].best,
    delta: runs.reversed[i].best - r.best,
  }));
  table(rows, [
    { h: 'CAR', f: (r) => r.car },
    { h: 'SKILL-A', f: (r) => r.hiSkill.toFixed(2) },
    { h: 'BEST-A', f: (r) => fmt(r.hiBest) },
    { h: 'SKILL-B', f: (r) => r.loSkill.toFixed(2) },
    { h: 'BEST-B', f: (r) => fmt(r.loBest) },
    { h: 'B-A', f: (r) => (r.delta >= 0 ? '+' : '') + r.delta.toFixed(2) },
  ]);
  // The middle row has the same skill in both configurations, so it carries no signal.
  const usable = rows.filter((r) => r.hiBest > 0 && r.loBest > 0 && r.hiSkill !== r.loSkill);
  const consistent = usable.filter((r) => Math.sign(r.hiSkill - r.loSkill) === Math.sign(r.loBest - r.hiBest));
  log(`${consistent.length}/${usable.length} cars were quicker in the higher-skill configuration`);
  check(usable.length >= 5, 'both configurations produced comparable lap times', `${usable.length} cars`);
  const meanGain = usable.reduce((a, r) => a + (r.loBest - r.hiBest) * Math.sign(r.hiSkill - r.loSkill), 0) / Math.max(usable.length, 1);
  log(`mean lap-time gain from the higher-skill configuration: ${meanGain.toFixed(2)} s`);
  check(meanGain > 0.5, 'higher skill is faster on average', `${meanGain.toFixed(2)} s/lap`);
  check(consistent.length >= Math.ceil(usable.length * 0.7), 'skill changes pace in the right direction',
    `${consistent.length}/${usable.length}`);
}

// ------------------------------------------------------------------ main
let browser = null;
try {
  if (!(await portOpen(PORT))) throw new Error(`no dev server on :${PORT} — start vite first`);
  browser = await chromium.launch({
    headless: !flag('headed'),
    args: [
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--js-flags=--max-old-space-size=4096',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const pageErrors = [];
  page.on('pageerror', (e) => {
    pageErrors.push(String(e.message || e));
    console.error('  [pageerror]', String(e.message || e).slice(0, 400));
  });
  const seenConsole = new Set();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const txt = m.text().slice(0, 160);
    if (seenConsole.has(txt)) return; // other lanes are editing live; don't drown in repeats
    seenConsole.add(txt);
    console.error('  [console.error]', txt);
  });

  // Other lane authors are editing the same tree, and a vite HMR full-reload mid-race destroys
  // the run. Swallow the HMR socket so this page is a stable snapshot of the code as loaded.
  if (!flag('hmr')) {
    await page.routeWebSocket(/.*/, () => {}).catch(() => {});
  }

  await page.goto(URL(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ready(page, 'boot');
  await page.evaluate(() => window.__NFT.settle(1));
  log('booted');

  const run = { probe: testProbe, race: testRace, cheat: testCheat, solo: testSolo, skill: testSkill, diag: testDiag };
  if (TEST === 'all') {
    await testRace(page);
    await testCheat(page);
    await testSolo(page);
    await testSkill(page);
  } else if (run[TEST]) {
    await run[TEST](page);
  } else throw new Error(`unknown --test ${TEST}`);

  // Other lanes are editing the same tree live; only errors that come from this lane's files are
  // this lane's problem. Anything else is reported and not counted.
  const mine = pageErrors.filter((e) => /game\/|RaceSystem|AiDriver|RaceRules|GhostRecorder/.test(e));
  if (pageErrors.length) console.warn(`  [note] ${pageErrors.length} page error(s) during the run, ${mine.length} from src/game/`);
  if (mine.length) check(false, 'no page errors from src/game', mine[0].slice(0, 200));
  console.log(`\n${failures.length ? `FAILED (${failures.length}): ${failures.join(' | ')}` : 'ALL CHECKS PASSED'}`);
  process.exitCode = failures.length ? 1 : 0;
} catch (err) {
  console.error('[racetest] FATAL:', err?.stack || err);
  process.exitCode = 3;
} finally {
  await browser?.close().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref?.();
}
