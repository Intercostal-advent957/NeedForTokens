#!/usr/bin/env node
/**
 * Builds a BLIND A/B comparison set: each of our QA frames paired against the closest-matching
 * official Need for Speed press screenshot, randomly ordered, and normalised so the only
 * difference a judge can perceive is rendering quality.
 *
 * Normalisation matters. Without it the test is worthless — a judge would just spot the PNG,
 * or the different resolution, or the HUD, and answer from that instead of from image quality.
 * So both sides are re-encoded to identical dimensions and identical format via `sips`,
 * and our side MUST be captured with --nohud (verify it actually worked — see below).
 *
 *   node tools/screenshot.mjs --out shots/blind-src --nohud
 *   node tools/blindpair.mjs --shots shots/blind-src --out shots/blind --seed 12345
 *
 * Output:
 *   shots/blind/pair-01/{A.png,B.png}   <- give these to the critic
 *   shots/blind/PAIRS.md                <- neutral index, safe to show the critic
 *   shots/blind/_key.json               <- the answer key. NEVER show this to the critic.
 */
import { mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const SHOTS = path.resolve(ROOT, arg('shots', 'shots/blind-src'));
const OUT = path.resolve(ROOT, arg('out', 'shots/blind'));
const REF = path.resolve(ROOT, 'reference');
const W = parseInt(arg('width', '1920'), 10);
const H = parseInt(arg('height', '1080'), 10);

// Deterministic shuffle so a run can be reproduced from its seed. Keep the ORIGINAL value —
// `rnd()` mutates `seed`, so recording it afterwards would store the end state and make the
// run unreproducible, which defeats the point of seeding it at all.
const SEED = parseInt(arg('seed', String(Date.now() % 2147483647)), 10) >>> 0;
let seed = SEED;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Normalise both sides to identical dimensions and identical FORMAT.
 *
 * Deliberately PNG, not JPEG. Re-encoding our clean render to JPEG introduced 8×8 block
 * quantisation in smooth gradients (sky, car paint) that a judge correctly read as a
 * *rendering* bug — while the reference press shots, already being JPEGs, had long since
 * absorbed their own artefacts. That biased the test against us for a reason that had
 * nothing to do with render quality. Decoding both to PNG adds no new loss to either side.
 */
async function normalise(src, dst) {
  await run('sips', ['-s', 'format', 'png', '-z', String(H), String(W), src, '--out', dst]);
}

const catalogPath = path.join(REF, 'catalog.json');
if (!existsSync(catalogPath)) {
  console.error(`No ${catalogPath}. Run the reference categoriser first.`);
  process.exit(1);
}
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const pairing = catalog.pairing || {};

const files = (await readdir(SHOTS)).filter((f) => f.endsWith('.png'));
if (!files.length) {
  console.error(`No PNGs in ${SHOTS}. Capture with: node tools/screenshot.mjs --out ${arg('shots','shots/blind-src')} --nohud`);
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const key = {};
const index = [];
let n = 0;

for (const f of files.sort()) {
  const shotName = f.replace(/\.png$/, '');
  const refFile = pairing[shotName];
  if (!refFile) {
    console.log(`  – ${shotName}: no reference pairing, skipped`);
    continue;
  }
  const refPath = path.join(REF, refFile);
  if (!existsSync(refPath)) {
    console.log(`  – ${shotName}: reference ${refFile} missing, skipped`);
    continue;
  }

  n++;
  const dir = path.join(OUT, `pair-${String(n).padStart(2, '0')}`);
  await mkdir(dir, { recursive: true });

  const oursFirst = rnd() < 0.5;
  const oursSlot = oursFirst ? 'A' : 'B';
  const refSlot = oursFirst ? 'B' : 'A';

  await normalise(path.join(SHOTS, f), path.join(dir, `${oursSlot}.png`));
  await normalise(refPath, path.join(dir, `${refSlot}.png`));

  key[`pair-${String(n).padStart(2, '0')}`] = {
    shot: shotName,
    ours: oursSlot,
    reference: refSlot,
    referenceFile: refFile,
    referenceTitle: catalog.images?.find((i) => i.file === refFile)?.title ?? 'unknown',
  };
  index.push({ pair: `pair-${String(n).padStart(2, '0')}`, shot: shotName });
  console.log(`  ✓ pair-${String(n).padStart(2, '0')}  (${shotName} vs ${refFile})`);
}

await writeFile(path.join(OUT, '_key.json'), JSON.stringify({ seed: SEED, pairs: key }, null, 2));

const md = [
  '# Blind comparison set',
  '',
  'Each folder holds two frames, `A.png` and `B.png`, at identical resolution and identical',
  'encoding. One is from a shipped AAA racing game; the other is from a game in development.',
  'The order is randomised per pair and is not recorded anywhere you can see.',
  '',
  '| pair | folder |',
  '| --- | --- |',
  ...index.map((i) => `| ${i.pair} | \`${path.relative(ROOT, path.join(OUT, i.pair))}\` |`),
  '',
].join('\n');
await writeFile(path.join(OUT, 'PAIRS.md'), md);

console.log(`\n${n} blind pairs written to ${OUT}`);
console.log(`Answer key: ${path.join(OUT, '_key.json')} (do not show the critic)`);
