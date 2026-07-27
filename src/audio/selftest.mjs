#!/usr/bin/env node
/**
 * Audio verification driver.
 *
 * Boots the real game in headless Chromium, drives the car with the QA hooks, records the actual
 * per-frame VehicleState, then replays those states into the synthesis graph inside an
 * OfflineAudioContext and asserts on the rendered samples (level, clipping, spectrum).
 *
 * Chromium is launched with --mute-audio, so nothing is audible; the assertions are numeric.
 *
 *   node src/audio/selftest.mjs
 *   node src/audio/selftest.mjs --json report.json
 *
 * Exits non-zero if any check fails or the page logs an error.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PORT = parseInt(arg('port', '5273'), 10);
const SECONDS = parseFloat(arg('seconds', '6'));
const JSON_OUT = arg('json', '');

const t0 = Date.now();
const log = (...a) => console.log(`[audio +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

function portOpen(port) {
  return new Promise((res) => {
    const s = net.createConnection({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });
}

async function ensureServer() {
  if (await portOpen(PORT)) {
    log(`reusing dev server on :${PORT}`);
    return null;
  }
  log(`starting vite on :${PORT}`);
  const proc = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await portOpen(PORT)) return proc;
    await new Promise((r) => setTimeout(r, 300));
  }
  proc.kill('SIGKILL');
  throw new Error('vite failed to start');
}

let server = null;
let browser = null;
const consoleErrors = [];
const pageErrors = [];

try {
  server = await ensureServer();
  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--js-flags=--max-old-space-size=4096',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  // Other lanes are editing the same dev server; a hot reload halfway through a 6-second capture
  // destroys the execution context. Stub out Vite's HMR client so this page is frozen at load.
  await page.route('**/@vite/client', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body:
        'const noop=()=>{};' +
        'export const createHotContext=()=>({accept:noop,acceptExports:noop,dispose:noop,prune:noop,' +
        'decline:noop,invalidate:noop,on:noop,off:noop,send:noop,data:{}});' +
        'export const updateStyle=noop;export const removeStyle=noop;' +
        'export const injectQuery=(u)=>u;export const ErrorOverlay=class{};export default {};',
    })
  );
  page.on('console', (m) => {
    if (m.type() === 'error') {
      consoleErrors.push(m.text());
      console.error('  [console.error]', m.text().slice(0, 300));
    }
  });
  page.on('pageerror', (e) => {
    pageErrors.push(String(e.message || e));
    console.error('  [pageerror]', String(e.message || e).slice(0, 400));
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__NFT && window.__NFT.ready, null, { timeout: 90000, polling: 200 });
  log('game booted');

  // Time unlock() — it runs inside the gesture handler, so it must not hitch the frame. The
  // ~90 ms AudioContext construction is deliberately paid during init(), behind the loading screen.
  const unlockInfo = await page.evaluate(() => {
    const a = window.__NFT.ctx.audio;
    const AC = window.AudioContext;
    const t0 = performance.now();
    const probe = new AC({ latencyHint: 'interactive' });
    const rawContextMs = +(performance.now() - t0).toFixed(1);
    probe.close();
    const stateBefore = a?.ac?.state ?? null;
    const t = performance.now();
    a.unlock();
    return {
      unlockMs: +(performance.now() - t).toFixed(2),
      rawContextCtorMs: rawContextMs,
      stateBefore,
      stateAfter: a?.ac?.state ?? null,
      sampleRate: a?.ac?.sampleRate ?? null,
    };
  });
  log('unlock:', JSON.stringify(unlockInfo));

  // Then the real gesture path, to prove main.js's wiring reaches an already-unlocked system.
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.mouse.up();

  // Cost of building the graph, task by task. Each entry is one frame's worth of work, so the
  // worst entry is the largest hitch the player can ever see from audio construction.
  const drain = await page.evaluate(async () => {
    const { AudioSystem } = await import('/src/audio/AudioSystem.js');
    const names = [
      'noise:white', 'noise:pink', 'noise:brown', 'ambience', 'engine',
      'sfx', 'tyres', 'reverb L', 'reverb R', 'music', 'opponents',
    ];
    let best = null;
    for (let k = 0; k < 3; k++) {
      const a = new AudioSystem(window.__NFT.ctx);
      a._createContext();
      const per = {};
      let i = 0;
      while (a._deferred.length) {
        const t = performance.now();
        a._deferred.shift()();
        per[names[i++] ?? `task${i}`] = +(performance.now() - t).toFixed(2);
      }
      const vals = Object.values(per);
      const run = {
        per,
        worstTaskMs: Math.max(...vals),
        totalMs: +vals.reduce((x, y) => x + y, 0).toFixed(1),
        sampleRate: a.ac.sampleRate,
      };
      if (!best || run.worstTaskMs < best.worstTaskMs) best = run; // discard JIT-cold outliers
      a.ac.close();
    }
    return best;
  });
  log(
    `graph build @${drain.sampleRate} Hz: ${drain.totalMs} ms total, spread over ${
      Object.keys(drain.per).length
    } frames — worst single frame ${drain.worstTaskMs} ms`
  );
  log(`  ${JSON.stringify(drain.per)}`);

  await page.evaluate(() => window.__NFT.settle(0.6));
  const built = await page.evaluate(() => {
    const a = window.__NFT.ctx.audio;
    const t = performance.now();
    a.unlock();
    return {
      reunlockMs: +(performance.now() - t).toFixed(3),
      engine: !!a.engine,
      tyres: !!a.tyres,
      ambience: !!a.ambience,
      sfx: !!a.sfx,
      music: !!a.music,
      convolver: !!a.convolver,
      profile: a.stats.profile,
      opponents: a.stats.opponents,
    };
  });
  log('graph:', JSON.stringify(built));

  // ---- record real physics states while driving flat out ----
  log(`recording ${SECONDS}s of driving…`);
  const frames = await page.evaluate(async (seconds) => {
    const nft = window.__NFT;
    const ctx = nft.ctx;
    nft.teleport(0.15, 0, 150);
    nft.drive({ throttle: 1, steer: 0.12, brake: 0, handbrake: 0, nos: 1 });
    await nft.settle(0.4);

    const snap = (s) => ({
      rpm: s.rpm,
      gear: s.gear,
      engineLoad: s.engineLoad,
      throttle: s.throttle,
      brake: s.brake,
      speed: s.speed,
      speedKmh: s.speedKmh,
      nosActive: !!s.nosActive,
      airborne: !!s.airborne,
      position: { x: s.position.x, y: s.position.y, z: s.position.z },
      velocity: { x: s.velocity.x, y: s.velocity.y, z: s.velocity.z },
      wheels: s.wheels.map((w) => ({
        contact: !!w.contact,
        surface: w.surface,
        slipRatio: w.slipRatio,
        slipAngle: w.slipAngle,
        slipSpeed: w.slipSpeed,
        load: w.load,
        lockedUp: !!w.lockedUp,
      })),
    });

    const out = [];
    const pending = { shift: false, collision: 0, land: 0 };
    const offs = [
      ctx.bus.on('car:shift', (e) => e.up && (pending.shift = true)),
      ctx.bus.on('car:collision', (e) => (pending.collision = Math.max(pending.collision, e.impulse || 0))),
      ctx.bus.on('car:land', (e) => (pending.land = Math.max(pending.land, e.impact || 0))),
    ];
    const need = Math.ceil(seconds * 60);
    await new Promise((res) => {
      const rec = () => {
        const s = ctx.player?.state ?? ctx.cars?.player?.state;
        if (s) {
          const f = snap(s);
          f.shift = pending.shift;
          f.collision = pending.collision;
          f.land = pending.land;
          pending.shift = false;
          pending.collision = 0;
          pending.land = 0;
          out.push(f);
        }
        if (out.length < need) requestAnimationFrame(rec);
        else res();
      };
      requestAnimationFrame(rec);
    });
    offs.forEach((o) => o && o());
    nft.drive(null);
    return { frames: out, def: ctx.cars?.player?.def?.id ?? null };
  }, SECONDS);
  log(`captured ${frames.frames.length} frames (player = ${frames.def})`);

  const perf = await page.evaluate(async () => {
    const a = window.__NFT.ctx.audio;
    const ctx = window.__NFT.ctx;
    // Re-form the pack so the spatial opponent voices are in range for the measurement.
    window.__NFT.teleport(0.3, 0, 140);
    await window.__NFT.settle(0.6);
    const s = [];
    for (let i = 0; i < 60; i++) {
      await window.__NFT.waitFrames(1);
      const t = performance.now();
      a.update(1 / 60, ctx);
      s.push(performance.now() - t);
    }
    s.sort((x, y) => x - y);
    return {
      fps: Math.round(window.__NFT.fps),
      updateMedianMs: +s[30].toFixed(3),
      updateP95Ms: +s[57].toFixed(3),
      opponentVoices: a.stats.opponents,
    };
  });
  log(`steady state: ${perf.fps} fps, audio.update() median ${perf.updateMedianMs} ms / p95 ${perf.updateP95Ms} ms, ${perf.opponentVoices} spatial opponent voices`);

  const rpms = frames.frames.map((f) => f.rpm);
  log(
    `state span: rpm ${Math.round(Math.min(...rpms))}–${Math.round(Math.max(...rpms))}, ` +
      `speed ${Math.round(Math.min(...frames.frames.map((f) => f.speedKmh)))}–` +
      `${Math.round(Math.max(...frames.frames.map((f) => f.speedKmh)))} km/h, ` +
      `gears ${[...new Set(frames.frames.map((f) => f.gear))].sort().join(',')}`
  );

  // ---- offline render + spectral analysis ----
  log('rendering offline & analysing…');
  const report = await page.evaluate(async ({ frames, seconds }) => {
    const mod = await import('/src/audio/selftest.js');
    const wrapped = frames.map((f) => ({ state: f, shift: f.shift, collision: f.collision, land: f.land }));
    return mod.runAudioSelfTest(wrapped, { seconds });
  }, { frames: frames.frames.map((f) => f), seconds: SECONDS });

  /* ------------------------------------------------------------- printout */
  const line = (s = '') => console.log(s);
  line();
  line('══════════════════════════ AUDIO SELF-TEST ══════════════════════════');
  line(`sample rate: ${report.sampleRate} Hz   (offline render, real synthesis graph)`);

  line();
  line('── rpm tracking (APEX GT-9, flat-plane V8, load 0.8) ──');
  line('    rpm   cycleHz   firing Hz   measured   err%   loudest Hz   k=f/cycle   centroid');
  for (const r of report.rpmTracking) {
    line(
      `  ${String(r.rpm).padStart(5)}   ${String(r.cycleHz).padStart(7)}   ${String(r.firingHz).padStart(9)}   ` +
        `${String(r.measuredHz).padStart(8)}  ${String(r.errPct).padStart(5)}   ${String(r.loudestHz).padStart(10)}   ` +
        `${String(r.loudestK).padStart(9)}   ${String(r.centroidHz).padStart(6)} Hz`
    );
  }

  line();
  line('── load-dependent timbre (5200 rpm) ──');
  for (const r of report.loadTimbre) {
    line(`  ${r.name.padEnd(9)} centroid ${String(r.centroidHz).padStart(5)} Hz   upper/lower order energy ${r.hiLoRatio}`);
  }

  line();
  line('── per-car character (72% of rev range, full load) ──');
  line('   car            profile         rpm    centroid   half-order share');
  for (const r of report.carCharacter.rows) {
    line(
      `  ${r.id.padEnd(13)} ${r.profile.padEnd(14)} ${String(r.rpm).padStart(5)}   ` +
        `${String(r.centroidHz).padStart(6)} Hz   ${String(r.halfOrderPct).padStart(5)} %`
    );
  }
  line('   order-profile similarity (1.0 = identical):');
  const sorted = report.carCharacter.pairs.slice().sort((a, b) => b.sim - a.sim).slice(0, 6);
  for (const p of sorted) line(`     ${p.a.padEnd(12)} vs ${p.b.padEnd(12)} ${p.sim}`);

  line();
  line('── sweep 1000→9000 rpm (NOCTURNE RS, V10) ──');
  line(`   peak partial: ${report.sweep.pts.join(' → ')} Hz`);
  line(
    `   peak ${report.sweep.levels.peak.toFixed(3)} (${report.sweep.levels.dbPeak.toFixed(1)} dBFS), ` +
      `rms ${report.sweep.levels.dbRms.toFixed(1)} dBFS, clipped samples ${report.sweep.levels.clipped}`
  );

  line();
  line('── layers ──');
  const L = report.layers;
  if (L.tyre) line(`   tyre squeal @0.28 rad slip: rms ${L.tyre.rms.toFixed(4)}, resonance ${L.tyre.peakHz} Hz, peak ${L.tyre.peak.toFixed(3)}`);
  if (L.wind)
    line(
      `   wind 40 km/h: rms ${L.wind.slow.rms.toFixed(4)} centroid ${L.wind.slow.centroidHz} Hz  →  ` +
        `300 km/h: rms ${L.wind.fast.rms.toFixed(4)} centroid ${L.wind.fast.centroidHz} Hz`
    );
  if (L.impact) line(`   impact: transient rms ${L.impact.hitRms}, ring-down @200 ms ${L.impact.ringRms}, peak ${L.impact.peak.toFixed(3)}`);
  if (report.music)
    line(
      `   music: ${report.music.open.dbRms.toFixed(1)} dBFS open  →  ${report.music.ducked.dbRms.toFixed(1)} dBFS ducked ` +
        `(peak ${report.music.open.peak.toFixed(3)})`
    );

  if (report.fullMix) {
    line();
    line('── full mix, driven by recorded gameplay ──');
    line(
      `   peak ${report.fullMix.peak.toFixed(3)} (${report.fullMix.dbPeak.toFixed(1)} dBFS)   ` +
        `rms ${report.fullMix.rms.toFixed(4)} (${report.fullMix.dbRms.toFixed(1)} dBFS)   ` +
        `clipped samples: ${report.fullMix.clipped}`
    );
  }

  line();
  line('── checks ──');
  for (const c of report.checks) {
    line(`  ${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? `\n      ${c.detail}` : ''}`);
  }
  line();
  line(`${report.passed} passed, ${report.failed} failed`);
  line('═════════════════════════════════════════════════════════════════════');

  if (JSON_OUT) {
    await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 2));
    log(`wrote ${JSON_OUT}`);
  }

  const runtimeErrors = await page.evaluate(() => window.__NFT.errors);
  if (runtimeErrors.length) console.error('runtime errors:', runtimeErrors.slice(0, 10));
  if (report.failed > 0) process.exitCode = 1;
  if (pageErrors.length || consoleErrors.length || runtimeErrors.length) process.exitCode = 2;
} catch (err) {
  console.error('[audio] FATAL:', err?.stack || err);
  process.exitCode = 3;
} finally {
  await browser?.close().catch(() => {});
  server?.kill?.('SIGTERM');
  setTimeout(() => process.exit(process.exitCode || 0), 300).unref?.();
}
