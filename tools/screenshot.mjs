#!/usr/bin/env node
/**
 * Automated visual-QA harness for Need for Tokens.
 *
 * Boots the game in headless Chromium with real GPU rasterisation (ANGLE/Metal), drives it
 * through the shot list in tools/shotlist.mjs, and writes PNGs a critic agent can look at.
 *
 *   node tools/screenshot.mjs                          # all shots -> shots/latest/
 *   node tools/screenshot.mjs --out shots/iter03       # custom output dir
 *   node tools/screenshot.mjs --only 01,04,07          # subset (prefix match)
 *   node tools/screenshot.mjs --width 1920 --height 1080
 *   node tools/screenshot.mjs --quality ultra
 *   node tools/screenshot.mjs --smoke                  # boot check only, exits non-zero on error
 *
 * Exit code is non-zero if the game failed to boot or logged a console/page error, so this
 * doubles as the build gate.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { SHOTS } from './shotlist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const OUT = path.resolve(ROOT, arg('out', 'shots/latest'));
const WIDTH = parseInt(arg('width', '1920'), 10);
const HEIGHT = parseInt(arg('height', '1080'), 10);
const QUALITY = arg('quality', 'high');
const ONLY = arg('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SMOKE = flag('smoke');
const NOHUD = flag('nohud'); // for blind A/B: reference press shots have no HUD either
const KEEP = flag('keep-server');
const PORT = parseInt(arg('port', '5273'), 10);
const BOOT_TIMEOUT = parseInt(arg('timeout', '90000'), 10);

// ---------------------------------------------------------------- server
function portOpen(port) {
  return new Promise((res) => {
    const s = net.createConnection({ port, host: '127.0.0.1' }, () => {
      s.destroy();
      res(true);
    });
    s.on('error', () => res(false));
    s.setTimeout(400, () => {
      s.destroy();
      res(false);
    });
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
    detached: false,
  });
  proc.stdout.on('data', (d) => process.env.NFT_VERBOSE && process.stdout.write(`[vite] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await portOpen(PORT)) return proc;
    await new Promise((r) => setTimeout(r, 300));
  }
  proc.kill('SIGKILL');
  throw new Error('vite failed to start within 45s');
}

const t0 = Date.now();
const log = (...a) => console.log(`[shot +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------------------------------------------------------------- main
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
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader', // fallback if metal is unavailable
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
      '--force-color-profile=srgb',
      '--disable-lcd-text',
      '--hide-scrollbars',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--js-flags=--max-old-space-size=4096',
    ],
  });

  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });

  page.on('console', (m) => {
    const txt = m.text();
    if (m.type() === 'error') {
      consoleErrors.push(txt);
      console.error('  [console.error]', txt.slice(0, 400));
    } else if (m.type() === 'warning' && /THREE|shader|WebGL/i.test(txt)) {
      console.warn('  [console.warn]', txt.slice(0, 300));
    } else if (process.env.NFT_VERBOSE) {
      console.log('  [console]', txt.slice(0, 300));
    }
  });
  page.on('pageerror', (e) => {
    pageErrors.push(String(e.message || e));
    console.error('  [pageerror]', String(e.message || e).slice(0, 600));
  });

  log(`navigating to http://127.0.0.1:${PORT}/`);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  log('waiting for game boot…');
  try {
    // Race the boot signal against a hard page error so a syntax error fails in ~1s, not 90.
    await Promise.race([
      page.waitForFunction(() => window.__NFT && window.__NFT.ready, null, {
        timeout: BOOT_TIMEOUT,
        polling: 200,
      }),
      new Promise((_, rej) => {
        const check = setInterval(() => {
          if (pageErrors.length) {
            clearInterval(check);
            rej(new Error(`page error during boot: ${pageErrors[0]}`));
          }
        }, 200);
        setTimeout(() => clearInterval(check), BOOT_TIMEOUT).unref?.();
      }),
    ]);
  } catch (e) {
    await mkdir(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, '00-BOOT-FAILURE.png') });
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    throw new Error(
      `game did not boot within ${BOOT_TIMEOUT}ms.\n--- page text ---\n${bodyText}\n` +
        `--- console errors ---\n${consoleErrors.slice(0, 10).join('\n')}\n` +
        `--- page errors ---\n${pageErrors.slice(0, 10).join('\n')}`
    );
  }

  /**
   * Re-establish the game after a reload. While lane authors are editing, vite's HMR can reload
   * the page at any moment and `window.__NFT` vanishes mid-capture. Every interaction goes
   * through this so a reload costs a retry instead of failing the run.
   */
  async function ensureReady(label = '') {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.waitForFunction(() => window.__NFT && window.__NFT.ready, null, {
          timeout: 45000,
          polling: 150,
        });
        return true;
      } catch {
        console.warn(`  [harness] game not ready${label ? ` before ${label}` : ''}; reloading…`);
        await page.goto(`http://127.0.0.1:${PORT}/`, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      }
    }
    return false;
  }

  const gpu = await page
    .evaluate(() => {
      const gl = window.__GAME?.renderer?.getContext?.();
      const d = gl?.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
    })
    .catch(() => 'unknown');
  log(`booted. gpu = ${gpu}`);

  /** Run `fn` against the page, re-establishing the game if an HMR reload lands mid-call. */
  async function evalSafe(fn, arg, label = '') {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await page.evaluate(fn, arg);
      } catch (e) {
        if (!/destroyed|navigation|__NFT/i.test(String(e))) throw e;
        console.warn(`  [harness] reload during ${label || 'evaluate'}; re-establishing…`);
        await ensureReady(label);
      }
    }
    throw new Error(`page kept reloading during ${label || 'evaluate'}`);
  }

  await ensureReady('setup');
  await evalSafe((q) => window.__NFT.setQuality(q), QUALITY, 'setQuality');
  await evalSafe(() => window.__NFT.settle(1.0), undefined, 'initial settle');

  if (SMOKE) {
    await mkdir(OUT, { recursive: true });
    await evalSafe(() => window.__NFT.settle(1.5), undefined, 'smoke settle');
    await page.screenshot({ path: path.join(OUT, 'smoke.png') });
    const stats = await evalSafe(() => window.__NFT.stats, undefined, 'smoke stats');
    log('smoke stats', JSON.stringify(stats));
  } else {
    if (existsSync(OUT) && flag('clean')) await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });

    const shots = ONLY.length ? SHOTS.filter((s) => ONLY.some((o) => s.name.startsWith(o))) : SHOTS;
    log(`capturing ${shots.length} shots at ${WIDTH}x${HEIGHT} (${QUALITY})`);

    const manifest = [];
    for (const shot of shots) {
      const before = Date.now();
      try {
        if (!(await ensureReady(shot.name))) throw new Error('game never became ready');
        await page.evaluate((q) => window.__NFT.setQuality(q), QUALITY);
        // Reset transient state between shots so they don't contaminate each other.
        await page.evaluate(() => {
          window.__NFT.drive(null);
          window.__NFT.hideHud(false);
          window.__NFT.timeScale(1);
          window.__NFT.setWeather?.({ wetness: 0, rain: 0 });
        });
        await page.evaluate(() => window.__NFT.settle(0.35));

        await page.evaluate(async (src) => {
          // eslint-disable-next-line no-new-func
          const fn = new Function('nft', `return (${src})(nft)`);
          await fn(window.__NFT);
        }, shot.setup.toString());

        if (NOHUD) {
          await page.evaluate(() => window.__NFT.hideHud(true));
          // Verify it actually worked rather than trusting it. A blind comparison where our
          // frames still carry a HUD is not a comparison — the judge identifies them instantly
          // and every quality score is worthless. This has already happened once.
          const hudVisible = await page
            .evaluate(() => {
              const r = document.getElementById('ui-root');
              if (!r) return false;
              const cs = getComputedStyle(r);
              if (cs.display === 'none') return false;
              // A descendant can re-assert visibility, so check painted descendants too.
              return [...r.querySelectorAll('*')].some((el) => {
                const s = getComputedStyle(el);
                return (
                  s.visibility !== 'hidden' &&
                  s.display !== 'none' &&
                  parseFloat(s.opacity) > 0.01 &&
                  el.getBoundingClientRect().width > 4
                );
              });
            })
            .catch(() => false);
          if (hudVisible) {
            throw new Error(
              'hideHud() did not hide the overlay — refusing to capture a --nohud frame with UI in it'
            );
          }
        }

        // A couple of extra frames so TAA/motion-blur history is converged.
        await page.evaluate(() => window.__NFT.waitFrames(4));

        // Reject frames where the hero car is off screen or the camera ended up inside
        // geometry. Two such frames reached a blind comparison and were scored as rendering
        // failures, which is not what they were. Showcase/menu shots opt out via `noValidate`.
        if (!shot.noValidate) {
          const v = await page
            .evaluate(() => window.__NFT.validate?.() ?? { ok: true })
            .catch(() => ({ ok: true }));
          if (!v.ok) {
            console.warn(`  [harness] ${shot.name}: invalid frame (${v.reason}) — retrying once`);
            await page.evaluate(() => window.__NFT.settle(1.2));
            const v2 = await page
              .evaluate(() => window.__NFT.validate?.() ?? { ok: true })
              .catch(() => ({ ok: true }));
            if (!v2.ok) throw new Error(`invalid frame: ${v2.reason}`);
          }
        }

        const file = path.join(OUT, `${shot.name}.png`);
        await page.screenshot({ path: file, animations: 'allow' });
        const stats = await page.evaluate(() => window.__NFT?.stats ?? {}).catch(() => ({}));
        manifest.push({ name: shot.name, brief: shot.brief, file: path.basename(file), stats });
        log(
          `  ✓ ${shot.name}  (${((Date.now() - before) / 1000).toFixed(1)}s, ${Math.round(
            stats.fps || 0
          )}fps, ${stats.draws || 0} draws, ${Math.round((stats.tris || 0) / 1000)}k tris)`
        );
      } catch (e) {
        console.error(`  ✗ ${shot.name} failed:`, String(e).slice(0, 500));
        manifest.push({ name: shot.name, brief: shot.brief, error: String(e).slice(0, 800) });
      }
    }

    const runtimeErrors = await page.evaluate(() => window.__NFT?.errors ?? []).catch(() => []);
    await writeFile(
      path.join(OUT, 'manifest.json'),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          width: WIDTH,
          height: HEIGHT,
          quality: QUALITY,
          gpu,
          shots: manifest,
          consoleErrors: consoleErrors.slice(0, 40),
          pageErrors: pageErrors.slice(0, 40),
          runtimeErrors: runtimeErrors.slice(0, 40),
        },
        null,
        2
      )
    );
    log(`wrote ${manifest.filter((m) => !m.error).length}/${shots.length} shots to ${OUT}`);
  }

  const fatal = pageErrors.length > 0;
  if (fatal) {
    console.error(`\n${pageErrors.length} page error(s) — see above.`);
    process.exitCode = 2;
  }
  if (consoleErrors.length) {
    console.error(`\n${consoleErrors.length} console error(s).`);
    if (!process.exitCode) process.exitCode = 1;
  }
} catch (err) {
  console.error('[shot] FATAL:', err?.stack || err);
  process.exitCode = 3;
} finally {
  await browser?.close().catch(() => {});
  if (server && !KEEP) {
    try {
      server.kill('SIGTERM');
      setTimeout(() => server.kill('SIGKILL'), 2000).unref?.();
    } catch {
      /* ignore */
    }
  }
  log('done');
  // Vite can keep the loop alive; force exit once everything is flushed.
  setTimeout(() => process.exit(process.exitCode || 0), 400).unref?.();
}
