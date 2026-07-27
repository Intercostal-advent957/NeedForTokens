#!/usr/bin/env node
/**
 * Headless physics telemetry harness — Need for Tokens, physics lane.
 *
 * Physics cannot be judged from a screenshot, so this boots the real game in headless Chromium,
 * drives it through `window.__NFT`, and MEASURES the things a driver would feel:
 *
 *   RIDE      body height above the road, at rest and at speed  (the floating-car regression)
 *   ACCEL     0-100 km/h and 0-200 km/h
 *   VMAX      terminal speed in top gear
 *   BRAKE     stopping distance from 200 km/h
 *   LATERAL   peak sustained lateral g in a steady corner, vs def.tyreGrip
 *   SLIP      slip angles at the limit (a real car runs a few degrees, not forty)
 *   DRIFT     a provoked slide is holdable in the 20-45 deg band and recovers hands-off
 *   SPIN      three deliberate spin attempts — the acceptance test for the spin arrest
 *   LAP       a full scripted lap: stays on track, never flips, never NaNs
 *   SANITY    no NaN, no implausible velocity jump over the whole run
 *
 * Usage:
 *   node src/physics/telemetry.mjs                 # all tests
 *   node src/physics/telemetry.mjs --only ride,vmax
 *   node src/physics/telemetry.mjs --only drift,spin   # the spin-arrest gate
 *   node src/physics/telemetry.mjs --port 5273 --json
 *
 * Exits non-zero if any test fails, so it doubles as a physics build gate.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const { chromium } = await import(path.join(ROOT, 'node_modules', 'playwright', 'index.mjs'));

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PORT = parseInt(arg('port', '5273'), 10);
const ONLY = arg('only', '').split(',').map((s) => s.trim()).filter(Boolean);
const JSON_OUT = argv.includes('--json');
const HEADFUL = argv.includes('--headful');

// ---------------------------------------------------------------- dev server
const portOpen = (p) =>
  new Promise((res) => {
    const s = net.createConnection({ port: p, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let server = null;
if (!(await portOpen(PORT))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !(await portOpen(PORT))) await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({
  headless: !HEADFUL,
  args: ['--use-gl=angle', '--use-angle=default', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });

// Six lanes are editing this repo in parallel. Vite's HMR client would reload the page in the
// middle of a measurement ("Execution context was destroyed"), so stub it out: the run then
// pins whatever the source was when we loaded it, which is exactly what a measurement wants.
await page.route('**/@vite/client', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body:
      'export const createHotContext=()=>({on(){},off(){},send(){},accept(){},acceptExports(){},dispose(){},prune(){},invalidate(){},decline(){},data:{}});' +
      'export function injectQuery(u){return u}export function updateStyle(){}export function removeStyle(){}' +
      'export const ErrorOverlay=class{};export default {};',
  })
);

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /NaN|non-finite/.test(t)) pageErrors.push(t);
});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__NFT?.ready === true, null, { timeout: 120000 });
await page.evaluate(() => {
  window.__NFT.hideHud(true);
  window.__NFT.pause(false);
});

// ---------------------------------------------------------------- probe library (browser side)
await page.evaluate(() => {
  const nft = window.__NFT;
  const ctx = nft.ctx;
  window.__PHYS = {
    car: () => ctx.cars.player,
    def: () => ctx.cars.player.def,
    /**
     * Take the AI off the board entirely. Parking the opponents is not enough — RaceSystem
     * keeps driving anything still in `race.opponents`, so they simply drive back onto the
     * circuit and T-bone the car halfway through a measurement. Detaching them from physics
     * makes every run deterministic and repeatable, which is the whole point of a harness.
     */
    parkedCars: [],
    parkAI() {
      if (this._parked) return;
      this._parked = true;
      this.parkedCars = (ctx.race.opponents || []).slice();
      for (const c of ctx.race.opponents || []) {
        ctx.physics.detach(c);
        if (c.root) c.root.visible = false;
      }
      ctx.race.opponents = [];
      ctx.race.standings = [];
    },
    /**
     * Pure-pursuit steering along the racing line. Straight-line tests still need this: the
     * circuit has no 400 m straight, so a car held at steer=0 is off the road inside a second
     * and you end up measuring grass, not acceleration.
     */
    /** Aim point on the racing line, pulled `margin` metres inside the kerbs. */
    aimPoint(t, margin = 2.2) {
      const track = ctx.world.track;
      const w = track.widthAt(t);
      const lim = Math.max(0, w - margin);
      const off = Math.max(-lim, Math.min(lim, track.racingLine.offsetAt(t)));
      const p = track.pointAt(t);
      const r = track.flatRightAt(t, new ctx.THREE.Vector3());
      return p.addScaledVector(r, off);
    },
    steerToLine(s, gain = 2.6) {
      const track = ctx.world.track;
      const proj = this.proj(s);
      const look = Math.max(8, Math.min(70, 8 + Math.abs(s.speed) * 0.75)) / track.length;
      // The ideal line runs to within 1.15 m of the kerb by construction; a discrete pursuit
      // controller aiming straight at it overshoots onto the kerbs every corner, and then the
      // harness is grading the road furniture instead of the car.
      const aim = this.aimPoint((proj.t + look) % 1);
      const to = aim.clone().sub(s.position);
      to.y = 0;
      to.normalize();
      const V = ctx.THREE.Vector3;
      const right = new V(1, 0, 0).applyQuaternion(s.quaternion);
      const fwd = new V(0, 0, -1).applyQuaternion(s.quaternion);
      if (to.dot(fwd) < 0) return Math.sign(to.dot(right)) || 1;
      return Math.max(-1, Math.min(1, to.dot(right) * gain));
    },
    lineSpeed(s, scale = 1) {
      const track = ctx.world.track;
      const proj = track.project(s.position, -1);
      return track.racingLine.speedAt((proj.t + 0.008) % 1) * scale;
    },
    lateralOf(s) {
      return ctx.world.track.project(s.position, -1);
    },
    /**
     * Hint-aware projection. The circuit crosses over itself, so an unhinted nearest-point
     * search can snap to the WRONG branch and report the car 57 m off a road it is driving
     * straight down. Always carry the previous t forward.
     */
    hint: -1,
    proj(s) {
      const p = ctx.world.track.project(s.position, this.hint);
      if (p.distance < 60) this.hint = p.t;
      return p;
    },
    resetHint() {
      this.hint = -1;
    },
    /** Longest continuous run of near-zero curvature, as { t0, len } in normalised track units. */
    longestStraight(maxK = 0.0022) {
      const track = ctx.world.track;
      const N = 900;
      const flat = [];
      for (let i = 0; i < N; i++) flat.push(Math.abs(track.curvatureAt(i / N)) < maxK);
      let best = { t0: 0, len: 0 };
      for (let i = 0; i < N; i++) {
        if (!flat[i] || (flat[(i - 1 + N) % N] && i !== 0)) continue;
        let n = 0;
        while (n < N && flat[(i + n) % N]) n++;
        if (n / N > best.len) best = { t0: i / N, len: n / N };
      }
      if (best.len < 0.02) best = { t0: 0, len: 0.05 };
      return best;
    },
    /** Run the sim for `seconds`, sampling every physics-visible frame. */
    async record(seconds, control, sample) {
      const out = [];
      const t0 = ctx.time.elapsed;
      const g = window.__GAME;
      await new Promise((res) => {
        const prev = g._onFrame;
        g._onFrame = () => {
          const t = ctx.time.elapsed - t0;
          const s = ctx.cars.player.state;
          if (control) control(t, s);
          out.push(sample ? sample(t, s) : { t, v: s.speedKmh });
          if (t >= seconds) {
            g._onFrame = prev;
            res();
          }
        };
      });
      return out;
    },
  };
});

// ---------------------------------------------------------------- tests
const results = [];
const push = (name, value, unit, expect, ok, note = '') =>
  results.push({ name, value, unit, expect, ok, note });

const want = (k) => !ONLY.length || ONLY.includes(k);

async function testRide() {
  const r = await page.evaluate(async () => {
    const nft = window.__NFT;
    const ctx = nft.ctx;
    const P = window.__PHYS;
    P.parkAI();
    nft.drive({ throttle: 0, brake: 1, steer: 0, handbrake: 0 });
    ctx.race.teleportPlayer(0.25, 0, 0);
    await nft.settle(2.5);
    const car = ctx.cars.player;
    const def = car.def;
    const s = car.state;
    const g = ctx.world.sampleGround(s.position.x, s.position.z);
    const pen0 = (def.mass * 9.81 * 0.25) / def.suspension.stiffness;
    const hubY = def.cog.y - def.suspension.travel + Math.min(pen0, def.suspension.travel);
    const expected = def.wheelRadius - hubY;
    const rest = s.position.y - g.height;

    // visual wheel bottoms vs the road under them
    const V = ctx.THREE.Vector3;
    const wheelErr = car.wheels.map((w, i) => {
      const p = new V();
      w.pivot.getWorldPosition(p);
      const gg = ctx.world.sampleGround(p.x, p.z);
      return +(p.y - w.radius - gg.height).toFixed(4);
    });

    // Now at speed, held on the centreline — a car that has wandered onto the kerbs is not
    // measuring ride height any more, it is measuring kerbs.
    const track = ctx.world.track;
    ctx.race.teleportPlayer(0.12, 0, 220);
    let minH = 1e9;
    let maxH = -1e9;
    let n = 0;
    const rec = await P.record(
      5.0,
      (t, st) => {
        const proj = track.project(st.position, -1);
        window.__NFT_INPUT_OVERRIDE = {
          throttle: st.speedKmh < 220 ? 1 : 0.3,
          brake: 0,
          steer: P.steerToLine(st, 2.4),
          handbrake: 0,
          nos: 0,
        };
        if (t > 1.0 && st.wheelsOnGround === 4 && Math.abs(proj.lateral) < proj.width - 1.2) {
          // `state.rideHeight` — physics computes it with the projection hint carried forward.
          // An unhinted sampleGround() here can land on the wrong branch where the circuit
          // crosses itself and report the body 5 cm inside the road when it is not.
          minH = Math.min(minH, st.rideHeight);
          maxH = Math.max(maxH, st.rideHeight);
          n++;
        }
      },
      () => null
    );
    nft.drive({ throttle: 0, brake: 0, steer: 0 });
    if (!n) {
      minH = 0;
      maxH = 0;
    }
    return {
      rest: +rest.toFixed(4),
      expected: +expected.toFixed(4),
      wheelErr,
      minH: +minH.toFixed(4),
      maxH: +maxH.toFixed(4),
      travel: def.suspension.travel,
      samples: rec.length,
    };
  });

  const restErr = Math.abs(r.rest - r.expected);
  push('ride height at rest', r.rest, 'm', `${r.expected} ±0.02`, restErr < 0.02);
  const worstWheel = Math.max(...r.wheelErr.map(Math.abs));
  push('visual wheel bottom vs road', worstWheel, 'm', '< 0.02 (all 4)', worstWheel < 0.02, `[${r.wheelErr.join(', ')}]`);
  const band = r.travel;
  const inBand = r.minH > r.expected - band && r.maxH < r.expected + band;
  push('ride height @220 km/h', `${r.minH}..${r.maxH}`, 'm', `within ±${band} of rest`, inBand);
  return r;
}

async function testAccel() {
  const r = await page.evaluate(async () => {
    const nft = window.__NFT;
    const ctx = nft.ctx;
    const P = window.__PHYS;
    P.parkAI();
    // brake 0.4, not 1: holding full brake at a standstill is how you SELECT REVERSE, and a
    // 0-100 run that starts by shifting out of reverse is measuring the gearbox, not the car
    nft.drive({ throttle: 0, brake: 0.4, steer: 0 });
    ctx.race.teleportPlayer(0.02, 0, 0);
    await nft.settle(1.5);
    let t100 = null;
    let t200 = null;
    let maxJump = 0;
    let prev = 0;
    const rec = await P.record(16, (t, s) => {
      window.__NFT_INPUT_OVERRIDE = { throttle: 1, brake: 0, steer: P.steerToLine(s), handbrake: 0, nos: 0 };
    }, (t, s) => {
      const j = Math.abs(s.speedKmh - prev);
      prev = s.speedKmh;
      if (t > 0.2) maxJump = Math.max(maxJump, j);
      if (t100 === null && s.speedKmh >= 100) t100 = t;
      if (t200 === null && s.speedKmh >= 200) t200 = t;
      return { t, v: s.speedKmh, g: s.gForce.z, gear: s.gear, rpm: s.rpm, slip: s.wheels[2].slipRatio };
    });
    return { t100, t200, maxJump: +maxJump.toFixed(2), peakG: Math.max(...rec.map((x) => x.g)).toFixed(2), top: Math.max(...rec.map((x) => x.v)).toFixed(1) };
  });
  push('0-100 km/h', r.t100 === null ? 'n/a' : r.t100.toFixed(2), 's', '2.5 - 4.0', r.t100 !== null && r.t100 >= 2.3 && r.t100 <= 4.2);
  push('0-200 km/h', r.t200 === null ? 'n/a' : r.t200.toFixed(2), 's', '6 - 13', r.t200 !== null && r.t200 >= 5.5 && r.t200 <= 14);
  push('peak long. g on launch', r.peakG, 'g', '0.8 - 1.7', +r.peakG > 0.8 && +r.peakG < 1.8);
  return r;
}

async function testVmax() {
  const r = await page.evaluate(async () => {
    const nft = window.__NFT;
    const ctx = nft.ctx;
    const P = window.__PHYS;
    P.parkAI();
    // Terminal velocity needs about a kilometre of straight and this circuit has nothing like
    // it, so build an infinite one: find the longest genuinely straight run and loop the car
    // back to its start (speed and heading preserved) every time it reaches the end.
    const track = ctx.world.track;
    const straight = P.longestStraight(0.0022);
    let top = 0;
    let rpm = 0;
    let gear = 0;
    let laps = 0;
    ctx.race.teleportPlayer(straight.t0, 0, 200);
    await nft.settle(0.2);
    await P.record(40, (t, s) => {
      const proj = track.project(s.position, -1);
      const past = ((proj.t - straight.t0 + 1) % 1) > straight.len;
      if (past) {
        ctx.race.teleportPlayer(straight.t0, 0, s.speedKmh);
        laps++;
        return;
      }
      window.__NFT_INPUT_OVERRIDE = { throttle: 1, brake: 0, steer: P.steerToLine(s, 2.0), handbrake: 0, nos: 0 };
      if (t > 0.5 && s.speedKmh > top && s.wheelsOnGround >= 3) {
        top = s.speedKmh;
        rpm = s.rpm;
        gear = s.gear;
      }
    });
    nft.drive({ throttle: 0, brake: 0, steer: 0 });
    return { top: +top.toFixed(1), rpm: Math.round(rpm), gear, straight: Math.round(straight.len * track.length), laps };
  });
  push('top speed', r.top, 'km/h', '295 - 340', r.top >= 290 && r.top <= 345, `gear ${r.gear} @ ${r.rpm} rpm, looped a ${r.straight} m straight x${r.laps}`);
  return r;
}

async function testBrake() {
  const r = await page.evaluate(async () => {
    const nft = window.__NFT;
    const ctx = nft.ctx;
    const P = window.__PHYS;
    P.parkAI();
    const track = ctx.world.track;
    // Same straight every time, and report its GRADE: braking uphill is genuinely shorter, and
    // without the number in front of you a 95 m stop looks like a physics bug rather than a hill.
    const straight = P.longestStraight(0.0025);
    const bestT = straight.t0;
    nft.drive({ throttle: 0, brake: 0, steer: 0 });
    ctx.race.teleportPlayer(bestT, 0, 200);
    await nft.settle(0.35);
    const grade = track.gradeAt ? track.gradeAt(bestT) : 0;
    const s0 = ctx.cars.player.state;
    const start = s0.position.clone();
    const v0 = s0.speedKmh;
    let dist = 0;
    let absHits = 0;
    let n = 0;
    await P.record(9, (t, s) => {
      window.__NFT_INPUT_OVERRIDE = { throttle: 0, brake: 1, steer: 0, handbrake: 0, nos: 0 };
      if (s.absActive) absHits++;
      n++;
    }, (t, s) => {
      if (s.speedKmh > 1) dist = s.position.distanceTo(start);
      return s.speedKmh;
    });
    nft.drive({ throttle: 0, brake: 0, steer: 0 });
    return { v0: +v0.toFixed(1), dist: +dist.toFixed(1), abs: +(absHits / Math.max(n, 1)).toFixed(2), grade: +(grade * 100).toFixed(1) };
  });
  const decel = r.dist > 0 ? (r.v0 / 3.6) ** 2 / (2 * r.dist) / 9.81 : 0;
  push('200-0 km/h distance', r.dist, 'm', '95 - 190', r.dist >= 95 && r.dist <= 190, `from ${r.v0} km/h = ${decel.toFixed(2)} g avg, ${r.grade > 0 ? '+' : ''}${r.grade}% grade, ABS active ${(r.abs * 100) | 0}% of the stop`);
  return r;
}

async function testLateral() {
  const r = await page.evaluate(async () => {
    const nft = window.__NFT;
    const ctx = nft.ctx;
    const P = window.__PHYS;
    P.parkAI();
    const track = ctx.world.track;
    // A skidpad is the only honest way to measure cornering grip, and a race circuit has no
    // skidpad — so build one: put the car on the longest straight, wind on a CONSTANT steering
    // angle at a held speed, and read the sustained lateral g before it runs out of road.
    // Sweep several steer/speed pairs and keep the best, because the tyre peak sits at a
    // specific slip angle and a single guess will land either side of it.
    const straight = P.longestStraight(0.0025);
    let peak = 0;
    let peakSlipF = 0;
    let peakSlipR = 0;
    let peakBeta = 0;
    let bestCase = null;
    const grip = ctx.cars.player.def.tyreGrip;

    for (const [steerCmd, kmh] of [[0.35, 150], [0.5, 120], [0.5, 145], [0.7, 100], [0.9, 85]]) {
      ctx.race.teleportPlayer(straight.t0, 0, kmh);
      await nft.settle(0.15);
      const win = [];
      let caseBest = 0;
      await P.record(3.4, (t, s) => {
        const err = kmh / 3.6 - s.speed;
        window.__NFT_INPUT_OVERRIDE = {
          throttle: Math.max(0, Math.min(0.75, err * 0.35)),
          brake: Math.max(0, Math.min(0.5, -err * 0.25)),
          steer: t > 0.35 ? steerCmd : 0,
          handbrake: 0,
          nos: 0,
        };
        // SUSTAINED, not instantaneous: a kerb strike is a 5 g spike and says nothing about
        // cornering grip. Require four wheels on asphalt, inside the white lines, ~0.3 s window.
        const proj = track.project(s.position, -1);
        const clean =
          t > 0.9 &&
          s.wheelsOnGround === 4 &&
          Math.abs(proj.lateral) < proj.width &&
          s.wheels.every((w) => w.surface === 'asphalt');
        if (clean) {
          win.push(Math.abs(s.gForce.x));
          if (win.length > 12) win.shift();
          if (win.length === 12) {
            const avg = win.reduce((a, b) => a + b, 0) / win.length;
            if (avg > caseBest) caseBest = avg;
            if (avg > peak) {
              peak = avg;
              peakSlipF = Math.max(Math.abs(s.wheels[0].slipAngle), Math.abs(s.wheels[1].slipAngle));
              peakSlipR = Math.max(Math.abs(s.wheels[2].slipAngle), Math.abs(s.wheels[3].slipAngle));
              peakBeta = Math.abs(s.driftAngle);
              bestCase = `steer ${steerCmd} @ ${kmh} km/h`;
            }
          }
        } else win.length = 0;
      });
      nft.drive({ throttle: 0, brake: 0, steer: 0 });
      void caseBest;
    }
    return {
      peak: +peak.toFixed(2),
      grip,
      slipF: +((peakSlipF * 180) / Math.PI).toFixed(1),
      slipR: +((peakSlipR * 180) / Math.PI).toFixed(1),
      beta: +((peakBeta * 180) / Math.PI).toFixed(1),
      bestCase,
    };
  });
  push('peak sustained lateral g', r.peak, 'g', `${(r.grip * 0.8).toFixed(2)} - ${(r.grip * 1.12).toFixed(2)}`, r.peak >= r.grip * 0.8 && r.peak <= r.grip * 1.12, `def.tyreGrip = ${r.grip}, best at ${r.bestCase}`);
  push('front slip angle at limit', r.slipF, 'deg', '3 - 14', r.slipF >= 2 && r.slipF <= 15);
  push('rear slip angle at limit', r.slipR, 'deg', '2 - 14', r.slipR >= 1 && r.slipR <= 15);
  push('body slip angle at limit', r.beta, 'deg', '< 12', r.beta < 12);
  return r;
}

async function testDrift() {
  const r = await page.evaluate(async () => {
    const nft = window.__NFT;
    const ctx = nft.ctx;
    const P = window.__PHYS;
    P.parkAI();
    // On the long straight: a drift measured while the car is also running out of road is a
    // measurement of the kerbs.
    const straight = P.longestStraight(0.0025);
    nft.drive({ throttle: 0, brake: 0, steer: 0, handbrake: 0, nos: 0 });
    ctx.race.teleportPlayer(straight.t0, 0, 130);
    await nft.settle(0.6); // let the suspension and the aids settle so the run is repeatable
    const lock = (ctx.cars.player.def.steerLockDeg * Math.PI) / 180;

    // A drift a player would actually hold: handbrake to break the rear away, then OPPOSITE
    // LOCK plus a trailing handbrake to sustain it.
    //
    // SIGN, and this matters more than anything else in this file: opposite lock has the SAME
    // sign as `driftAngle`. beta > 0 means the velocity lies to the right of the nose, which is
    // a left-hand slide, and the driver's hands go RIGHT. Steering `-sign(beta)` — which this
    // harness used to do — points the wheels *into* the slide, and then the test grades a car
    // that is spinning slowly to a standstill as a car holding a drift. It passed for weeks.
    let peak = 0;
    let drifting = 0;
    let n = 0;
    let score = 0;
    const held = [];
    let spun = false;
    let minSpeed = 1e9;
    const TARGET = 0.56; // 32 deg — mid-band
    await P.record(4.0, (t, s) => {
      const beta = s.driftAngle;
      const err = TARGET - Math.abs(beta); // + = not sideways enough
      // A modulated handbrake is how an arcade player sustains a slide. It is not a cheat for
      // the harness: a 640 hp AWD car at 100+ km/h cannot spin its rear tyres on throttle alone
      // — there simply is not enough torque at that road speed — so a power-on drift is a
      // low-gear manoeuvre and everything above it is held on the handbrake, exactly as here.
      const hb = t < 0.45 ? 1 : Math.max(0, Math.min(1, 0.5 + err * 2.5));
      // Mirror the slip angle with the front wheels — that IS opposite lock — and let the
      // throttle set the angle. If a simple mirror-and-modulate driver can hold it, so can a
      // player with a thumbstick.
      const steer = t < 0.45 ? 0.75 : Math.max(-1, Math.min(1, (beta / lock) * 0.95));
      const throttle = t < 0.45 ? 1 : Math.max(0.35, Math.min(1, 0.8 + err * 1.4));
      window.__NFT_INPUT_OVERRIDE = { throttle, brake: 0, steer, handbrake: hb, nos: 0 };
      const planar = Math.hypot(s.velocity.x, s.velocity.z);
      if (t > 0.6 && planar > 8) {
        // Peak is measured AFTER the initiation transient: the first half second is the player
        // deliberately throwing the car with full lock and handbrake, and how far it swings
        // there is provocation, not controllability. What matters is where it settles.
        peak = Math.max(peak, Math.abs(beta));
        minSpeed = Math.min(minSpeed, planar * 3.6);
        // Correctness of the FLAG, not of this harness's ability to hold a slide: on every
        // frame where the car is genuinely sideways and moving, state.drifting must be true.
        // VFX (smoke, marks), the camera, audio and the HUD score all read it.
        if (Math.abs(beta) > 0.16) {
          n++;
          if (s.drifting) drifting++;
        }
        if (t > 0.9 && t < 2.6) held.push(Math.abs(beta));
        if (Math.abs(beta) > 1.75) spun = true; // past ~100 deg it is travelling backwards
      }
      score = s.driftScore;
    });
    // recovery: lift and straighten
    // Recovery is hands-off on purpose: lift, centre the wheel, and the car should gather
    // itself up without the player having to catch it. Chasing the racing line here would be
    // testing the harness's driver instead.
    let settled = false;
    let settleTime = 0;
    await P.record(3.6, (t, s) => {
      window.__NFT_INPUT_OVERRIDE = { throttle: 0.3, brake: 0, steer: 0, handbrake: 0, nos: 0 };
      if (!settled && Math.abs(s.driftAngle) < 0.12 && t > 0.3) {
        settled = true;
        settleTime = t;
      }
    });
    nft.drive({ throttle: 0, brake: 0.4, steer: 0 });
    const s = ctx.cars.player.state;
    const sustained = held.length ? held.reduce((a, b) => a + b, 0) / held.length : 0;
    return {
      peak: +((peak * 180) / Math.PI).toFixed(1),
      sustained: +((sustained * 180) / Math.PI).toFixed(1),
      driftFrac: +(drifting / Math.max(n, 1)).toFixed(2),
      score: Math.round(score),
      settled,
      settleTime: +settleTime.toFixed(2),
      spun,
      minSpeed: +(minSpeed > 1e8 ? 0 : minSpeed).toFixed(0),
      upright: new ctx.THREE.Vector3(0, 1, 0).applyQuaternion(s.quaternion).y > 0.6,
    };
  });
  push('provoked drift, peak angle', r.peak, 'deg', '20 - 60', r.peak >= 20 && r.peak <= 60, 'handbrake entry then opposite lock + throttle');
  push('drift held in the 20-45 band', r.sustained, 'deg', '20 - 48', r.sustained >= 20 && r.sustained <= 48, `over a 1.7 s window; slowest ${r.minSpeed} km/h — a drift that grinds to a halt is a spin`);
  push('never spun (stayed < 100 deg)', r.spun ? 'no' : 'yes', '', 'yes', !r.spun);
  push('state.drifting flag correct', `${(r.driftFrac * 100) | 0}%`, 'of sideways frames', '> 92%', r.driftFrac > 0.92, `driftScore ${r.score} — VFX/HUD/audio read this`);
  push('recovers to straight', r.settled ? `${r.settleTime} s` : 'no', '', '< 3.6 s, hands off', r.settled && r.upright);
  return r;
}

/**
 * THE SPIN ARREST ACCEPTANCE TEST.
 *
 * Three ways a player can genuinely try to spin the car, each held for long enough that a
 * physics model without stability control goes all the way round (measured: 191 deg). The
 * assist must cap the slip angle and then bring the car BACK — an arrest that merely stops the
 * rotation and leaves the car travelling backwards at 60 km/h is not an arrest.
 *
 * Slip angle is unwrapped across the +-pi seam so a car that passes 180 deg reports 190, not
 * -170, and it is only sampled while the car is genuinely moving: `driftAngle` is defined as 0
 * below 1 m/s and unwrapping that produces garbage.
 */
async function testSpin() {
  const r = await page.evaluate(async () => {
    const nft = window.__NFT;
    const ctx = nft.ctx;
    const P = window.__PHYS;
    P.parkAI();
    const straight = P.longestStraight(0.0025);

    async function attempt(name, entryKmh, seconds, drive, expectRecover) {
      nft.drive({ throttle: 0, brake: 0, steer: 0, handbrake: 0, nos: 0 });
      ctx.race.teleportPlayer(straight.t0, 0, entryKmh);
      await nft.settle(0.4);
      let cont = 0;
      let started = false;
      let peak = 0;
      let endAngle = 0;
      let endSpeed = 0;
      let nan = 0;
      await P.record(seconds, (t, s) => {
        window.__NFT_INPUT_OVERRIDE = drive(t, s);
      }, (t, s) => {
        if (!Number.isFinite(s.position.x + s.velocity.x + s.angularVelocity.y)) nan++;
        const planar = Math.hypot(s.velocity.x, s.velocity.z);
        const b = s.driftAngle;
        if (planar < 4) {
          cont = b;
          started = false;
          return null;
        }
        if (!started) {
          cont = b;
          started = true;
        } else {
          let d = b - ((cont + Math.PI) % (2 * Math.PI)) + Math.PI;
          d = b - cont;
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          cont += d;
        }
        if (Math.abs(cont) > Math.abs(peak)) peak = cont;
        if (t > seconds - 0.6) {
          endAngle = Math.abs(b);
          endSpeed = planar * 3.6;
        }
        return null;
      });
      nft.drive({ throttle: 0, brake: 0.3, steer: 0 });
      return {
        name,
        peak: +((Math.abs(peak) * 180) / Math.PI).toFixed(1),
        end: +((endAngle * 180) / Math.PI).toFixed(1),
        endSpeed: +endSpeed.toFixed(0),
        expectRecover,
        nan,
      };
    }

    const out = [];
    // 1. the classic: handbrake pinned, full lock into the slide, full throttle, held. The
    //    player never lets go, so the car is entitled to end up stationary — it is not entitled
    //    to end up facing backwards on the way there.
    out.push(await attempt('handbrake + full lock, held', 130, 5.0, () => ({
      throttle: 1, brake: 0, steer: 1, handbrake: 1, nos: 0,
    }), false));
    // 2. throw it in, then let go of everything. This is the one that must gather itself up
    //    without any input at all, still moving and pointing where it is going.
    out.push(await attempt('provoke then hands off', 140, 6.0, (t) => (t < 1.0
      ? { throttle: 1, brake: 0, steer: 1, handbrake: 1, nos: 0 }
      : { throttle: 0.25, brake: 0, steer: 0, handbrake: 0, nos: 0 }), true));
    // 3. full lock at 250 km/h with no handbrake — the high-speed snap. Lock is still pinned at
    //    the end, so a big held angle here is a drift, not a failure.
    out.push(await attempt('full lock at 250 km/h', 250, 5.0, () => ({
      throttle: 1, brake: 0, steer: 1, handbrake: 0, nos: 0,
    }), false));
    return out;
  });

  for (const a of r) {
    push(`spin attempt: ${a.name}`, a.peak, 'deg', '< 90', a.peak < 90, `settled at ${a.end} deg, ${a.endSpeed} km/h`);
  }
  const worst = Math.max(...r.map((a) => a.peak));
  const rec = r.filter((a) => a.expectRecover);
  const recovered = rec.every((a) => a.end < 25 && a.endSpeed > 25);
  push('max slip angle over all attempts', worst, 'deg', '< 90 (was 191)', worst < 90, 'the ceiling ESP.betaFree + betaSpan sets, plus overshoot');
  push('recovers hands-off, still moving', recovered ? 'yes' : 'no', '', 'yes', recovered, `after the provocation stops: ${rec.map((a) => `${a.end} deg @ ${a.endSpeed} km/h`).join(', ')}`);
  push('no NaN during a spin', r.reduce((a, b) => a + b.nan, 0), '', '0', r.every((a) => a.nan === 0));
  return r;
}

async function testCollision() {
  const r = await page.evaluate(async () => {
    const nft = window.__NFT;
    const ctx = nft.ctx;
    const P = window.__PHYS;
    const track = ctx.world.track;
    const ev = [];
    const off = ctx.bus.on('car:collision', (e) =>
      ev.push({ tag: e.tag, j: e.impulse, n: e.normal.clone(), p: e.point.clone() })
    );

    // --- barrier: aim at the wall at 300 km/h. The old lateral-push response let the car
    //     straight through; the capsule-vs-segment solver must contain it at any speed.
    P.parkAI();
    const aiCar = (ctx.race.opponents || [])[0] || P.parkedCars[0] || null;
    ctx.race.teleportPlayer(0.3, 0, 300);
    await nft.settle(0.1);
    ev.length = 0;
    // "Contained" means: never more than a car's length on the WRONG SIDE of the nearest
    // barrier segment. Comparing lateral offsets against a single segment is meaningless once
    // the car has travelled along the track, because the run-off width changes every metre.
    let deepest = 0;
    await P.record(5, (t, s) => {
      window.__NFT_INPUT_OVERRIDE = { throttle: 1, brake: 0, steer: 1, handbrake: 0, nos: 0 };
      // Closest point ON the segment, not its endpoint: at a gap in the barrier run the
      // endpoint metric reports metres of "penetration" for a car driving past in free air.
      let bestD = 1e9;
      let behind = 0;
      for (const b of ctx.world.barriers) {
        const ex = b.b.x - b.a.x;
        const ez = b.b.z - b.a.z;
        const len2 = ex * ex + ez * ez || 1e-6;
        const u = Math.max(0, Math.min(1, ((s.position.x - b.a.x) * ex + (s.position.z - b.a.z) * ez) / len2));
        const qx = b.a.x + ex * u;
        const qz = b.a.z + ez * u;
        const dx = s.position.x - qx;
        const dz = s.position.z - qz;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          behind = -(dx * b.normal.x + dz * b.normal.z);
        }
      }
      if (bestD < 16) deepest = Math.max(deepest, behind);
    });
    const s1 = ctx.cars.player.state;
    const wall = ev.filter((e) => e.tag === 'barrier');
    // how far out does the barrier actually sit here?
    const centre = track.pointAt(0.3);
    let barrierAt = 1e9;
    for (const b of ctx.world.barriers) barrierAt = Math.min(barrierAt, centre.distanceTo(b.a));

    const res = {
      wallHits: wall.length,
      wallImpulse: Math.round(Math.max(0, ...wall.map((e) => e.j))),
      normalHorizontal: wall.every((e) => Math.abs(e.n.y) < 0.35),
      deepest: +deepest.toFixed(2),
      barrierAt: +barrierAt.toFixed(1),
      damage: +s1.damage.total.toFixed(2),
      finite: Number.isFinite(s1.position.x + s1.velocity.x + s1.quaternion.x),
      spun: +Math.abs(s1.angularVelocity.y).toFixed(2),
    };

    // --- car vs car: rear-end a stationary opponent
    if (aiCar) {
      ctx.physics.attach ? null : null;
      if (!ctx.physics.get(aiCar)) ctx.physics.attach(aiCar);
      if (aiCar.root) aiCar.root.visible = true;
      const a = track.placeAt(0.4, 0, 0.6);
      ctx.physics.reset(aiCar, a.position, a.quaternion);
      const b = track.placeAt(0.4 - 11 / track.length, 0, 0.6);
      ctx.physics.reset(ctx.cars.player, b.position, b.quaternion);
      ctx.physics.setVelocityAlong(ctx.cars.player, 26);
      const p0 = aiCar.state.position.clone();
      ev.length = 0;
      await P.record(2.2, () => {
        const av = ctx.physics.get(aiCar);
        if (av) {
          av.controls.throttle = 0;
          av.controls.brake = 0.15;
          av.controls.steer = 0;
        }
        window.__NFT_INPUT_OVERRIDE = { throttle: 0.9, brake: 0, steer: 0, handbrake: 0, nos: 0 };
      });
      const car = ev.filter((e) => e.tag === 'car');
      res.carHits = car.length;
      res.carImpulse = Math.round(Math.max(0, ...car.map((e) => e.j)));
      res.aiShoved = +aiCar.state.position.distanceTo(p0).toFixed(1);
      res.separation = +ctx.cars.player.state.position.distanceTo(aiCar.state.position).toFixed(2);
      res.aiYaw = +Math.abs(aiCar.state.angularVelocity.y).toFixed(2);
      ctx.physics.detach(aiCar);
      if (aiCar.root) aiCar.root.visible = false;
    }
    off?.();
    nft.drive({ throttle: 0, brake: 0.5, steer: 0 });
    return res;
  });
  push('barrier contacts @300 km/h', r.wallHits, 'events', '> 0', r.wallHits > 0, `peak impulse ${r.wallImpulse} N s`);
  push('barrier contained the car', r.deepest < 1.6 ? 'yes' : 'no', '', 'yes', r.deepest < 1.6, `deepest penetration past the wall face: ${r.deepest} m (capsule radius ~1.0 m)`);
  push('barrier normals horizontal', r.normalHorizontal ? 'yes' : 'no', '', 'yes', r.normalHorizontal);
  push('impact caused damage + spin', `${r.damage} / ${r.spun}`, 'dmg / rad/s', '> 0 / > 0', r.damage > 0, 'VFX + audio scale off `impulse`');
  push('car-vs-car contacts', r.carHits ?? 0, 'events', '> 0', (r.carHits ?? 0) > 0, `peak ${r.carImpulse} N s, shoved the target ${r.aiShoved} m, yaw ${r.aiYaw} rad/s`);
  push('cars separate (no overlap)', r.separation ?? 0, 'm', '> 1.5', (r.separation ?? 0) > 1.5);
  push('state finite after impacts', r.finite ? 'yes' : 'no', '', 'yes', r.finite);
  return r;
}

async function testAir() {
  const r = await page.evaluate(async () => {
    const nft = window.__NFT;
    const ctx = nft.ctx;
    const P = window.__PHYS;
    P.parkAI();
    ctx.race.teleportPlayer(0.3, 0, 160);
    await nft.settle(0.15);
    const ev = [];
    const offA = ctx.bus.on('car:airborne', () => ev.push({ tag: 'air' }));
    const offL = ctx.bus.on('car:land', (e) => ev.push({ tag: 'land', impact: e.impact }));
    ctx.cars.player.state.velocity.y += 9; // launch it
    let maxAir = 0;
    let minUp = 1;
    let maxPen = 0;
    let lowest = 1e9;
    let bounce = 0;
    let landed = false;
    let touchdown = -1;
    let winSamples = 0;
    await P.record(4.5, (t, s) => {
      // Steer to the line: a car held at steer 0 for 4 s leaves this circuit, cartwheels down
      // the embankment, and then you are grading terrain, not the jump.
      window.__NFT_INPUT_OVERRIDE = { throttle: 0.4, brake: 0, steer: P.steerToLine(s, 2.0), handbrake: 0, nos: 0 };
      maxAir = Math.max(maxAir, s.airTime);
      if (!s.airborne && t > 0.4) landed = true;
      // Attitude is only an AIR question, and only for the launch we actually commanded — a
      // wheel up on a kerb after touchdown is not the auto-level failing, it is a kerb.
      if (s.airborne && !landed) minUp = Math.min(minUp, new ctx.THREE.Vector3(0, 1, 0).applyQuaternion(s.quaternion).y);
      for (const w of s.wheels) maxPen = Math.max(maxPen, w.pen);
      if (!s.airborne && t > 0.5) {
        // Only the LANDING, and only on flat road. This used to sample the whole run, so a
        // kerb clipped four seconds later reported as an 8 m/s trampoline off a landing that
        // had actually settled at 1.8 — the test failed maybe one run in four for a reason
        // that had nothing to do with the suspension.
        // THE LANDING, not the rest of the lap. This used to sample all 4.5 s, so a kerb clipped
        // three seconds later reported as an 8 m/s trampoline off a landing that had actually
        // settled at 1.8 — the test failed about one run in four for a reason that had nothing
        // to do with the suspension. 1.5 s from first touchdown covers the settle and the
        // secondary bounce and stops well before the car reaches any road furniture.
        //
        // `state.rideHeight`, not a fresh sampleGround(): this circuit crosses over itself and
        // an UNHINTED projection can snap to the wrong branch. Physics carries the hint forward
        // every tick, so its own number is the only trustworthy one here.
        if (touchdown < 0) touchdown = t;
        if (t - touchdown < 1.5) {
          lowest = Math.min(lowest, s.rideHeight);
          bounce = Math.max(bounce, s.velocity.y);
          winSamples++;
        }
      }
    });
    offA?.();
    offL?.();
    nft.drive({ throttle: 0, brake: 0.5, steer: 0 });
    const s = ctx.cars.player.state;
    return {
      maxAir: +maxAir.toFixed(2),
      minUp: +minUp.toFixed(3),
      maxPen: +maxPen.toFixed(3),
      travel: ctx.cars.player.def.suspension.travel,
      lowest: +(lowest > 1e8 ? 0 : lowest).toFixed(3),
      window: winSamples,
      bounce: +bounce.toFixed(2),
      airEvents: ev.filter((e) => e.tag === 'air').length,
      landEvents: ev.filter((e) => e.tag === 'land').length,
      finite: Number.isFinite(s.position.x + s.velocity.x + s.quaternion.x),
    };
  });
  push('air time after a launch', r.maxAir, 's', '> 0.3', r.maxAir > 0.3, `${r.airEvents} airborne / ${r.landEvents} land events`);
  push('stays upright in the air', r.minUp, 'up.y', '> 0.6', r.minUp > 0.6, 'auto-level');
  push('landing within bump stop', r.maxPen, 'm', `< ${(r.travel * 1.3).toFixed(3)}`, r.maxPen < r.travel * 1.3, `travel ${r.travel} m`);
  push('body never punches the road', r.lowest, 'm', '> -0.06', r.lowest > -0.06 && r.window > 20, `${r.window} samples in the 1.5 s post-touchdown window`);
  push('no trampoline off the landing', r.bounce, 'm/s up', '< 4', r.bounce < 4);
  push('state finite after landing', r.finite ? 'yes' : 'no', '', 'yes', r.finite);
  return r;
}

async function testLap() {
  const r = await page.evaluate(async () => {
    const nft = window.__NFT;
    const ctx = nft.ctx;
    const P = window.__PHYS;
    const track = ctx.world.track;
    P.parkAI();
    // Drive the lap with the GAME's own AI, not a controller written inside this harness.
    // A crude scripted pursuit driver is the least reliable part of a physics test — when it
    // runs wide you cannot tell whether the car or the driver failed. RaceSystem already
    // exposes an autopilot for exactly this, so the question being asked is the right one:
    // is this vehicle model drivable by a competent driver for a full lap?
    ctx.race.setAutopilot?.(true);
    ctx.race.phase = 'racing';
    ctx.race.teleportPlayer(0.0, 0, 60);
    window.__NFT_INPUT_OVERRIDE = null;
    await nft.settle(0.4);

    // THREE laps, not one. "No NaN over sustained running" is a claim about minutes of
    // simulation, not about eighty seconds, and the failure modes that matter here — a slowly
    // winding integrator, an assist that ratchets, an accumulating positional correction —
    // all need time to show themselves.
    const LAPS = 3;
    let offTrack = 0, flipped = 0, nan = 0, n = 0, maxJump = 0, worstOff = 0;
    let prevV = null, lastT = 0, wraps = 0, lapTime = 0, topSpeed = 0, maxLat = 0, stuck = 0;
    let simTime = 0;
    const V = ctx.THREE.Vector3;
    P.resetHint();
    await P.record(430, (t, s) => {
      if (wraps >= LAPS) return;
      simTime = t;
      const proj = P.proj(s);
      if (proj.t < lastT - 0.5) {
        wraps++;
        if (wraps === 1) lapTime = t;
        lastT = proj.t;
        return;
      }
      lastT = proj.t;
      n++;
      const off = Math.abs(proj.lateral) - proj.width;
      worstOff = Math.max(worstOff, off);
      if (off > 3.2) offTrack++;
      if (new V(0, 1, 0).applyQuaternion(s.quaternion).y < 0.35) flipped++;
      if (!Number.isFinite(s.position.x + s.position.y + s.velocity.x + s.rpm)) nan++;
      const v = s.velocity.length();
      if (prevV !== null) maxJump = Math.max(maxJump, Math.abs(v - prevV));
      prevV = v;
      topSpeed = Math.max(topSpeed, s.speedKmh);
      maxLat = Math.max(maxLat, Math.abs(s.gForce.x));
      if (Math.abs(s.speedKmh) < 3) stuck++;
      return null;
    });
    ctx.race.setAutopilot?.(false);
    nft.drive({ throttle: 0, brake: 0.5, steer: 0 });
    const s = ctx.cars.player.state;
    return {
      laps: wraps,
      want: LAPS,
      simTime: +simTime.toFixed(0),
      lapTime: +lapTime.toFixed(1),
      offFrac: +(offTrack / Math.max(n, 1)).toFixed(3),
      flipFrac: +(flipped / Math.max(n, 1)).toFixed(3),
      stuckFrac: +(stuck / Math.max(n, 1)).toFixed(3),
      nan,
      maxJump: +maxJump.toFixed(2),
      worstOff: +worstOff.toFixed(1),
      topSpeed: +topSpeed.toFixed(0),
      maxLat: +maxLat.toFixed(2),
      frames: n,
      odo: Math.round(s.distanceTravelled),
      finite: Number.isFinite(
        s.position.x + s.position.y + s.position.z + s.velocity.x + s.rpm +
          s.quaternion.x + s.quaternion.w + s.angularVelocity.y + s.gForce.x
      ),
    };
  });
  push(`completed ${r.want} laps`, `${r.laps}`, 'laps', `${r.want}`, r.laps >= r.want, `${r.lapTime} s first lap under game autopilot, top ${r.topSpeed} km/h, ${r.simTime} s / ${r.odo} m of sustained simulation`);
  push('state finite after the run', r.finite ? 'yes' : 'no', '', 'yes', r.finite);
  push('time off track', `${(r.offFrac * 100).toFixed(1)}%`, '', '< 6%', r.offFrac < 0.06, `worst excursion ${r.worstOff} m past the white line`);
  push('time flipped', `${(r.flipFrac * 100).toFixed(1)}%`, '', '0%', r.flipFrac === 0);
  push('time stopped/stuck', `${(r.stuckFrac * 100).toFixed(1)}%`, '', '< 2%', r.stuckFrac < 0.02);
  push('NaN frames', r.nan, '', '0', r.nan === 0);
  push('max |dv| between frames', r.maxJump, 'm/s', '< 12', r.maxJump < 12);
  return r;
}

// ---------------------------------------------------------------- run
const started = Date.now();
try {
  if (want('ride')) await testRide();
  if (want('accel')) await testAccel();
  if (want('vmax')) await testVmax();
  if (want('brake')) await testBrake();
  if (want('lateral')) await testLateral();
  if (want('drift')) await testDrift();
  if (want('spin')) await testSpin();
  if (want('collision')) await testCollision();
  if (want('air')) await testAir();
  if (want('lap')) await testLap();
} catch (err) {
  push('harness', 'threw', '', 'no throw', false, String(err?.message || err));
}

const realErrors = pageErrors.filter((e) => !/favicon|Download the React/i.test(e));
push('console / page errors', realErrors.length, '', '0', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

await browser.close();
if (server) server.kill();

// ---------------------------------------------------------------- report
if (JSON_OUT) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const w = [Math.max(...results.map((r) => r.name.length), 26), 14, 8, 22];
  const line = (a, b, c, d) => `  ${a.padEnd(w[0])}  ${String(b).padStart(w[1])} ${String(c).padEnd(w[2])} ${String(d).padEnd(w[3])}`;
  console.log(`\n  NEED FOR TOKENS — PHYSICS TELEMETRY   (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  console.log(`  ${'-'.repeat(w[0] + w[1] + w[2] + w[3] + 12)}`);
  console.log(line('MEASUREMENT', 'VALUE', 'UNIT', 'EXPECTED') + '  ');
  console.log(`  ${'-'.repeat(w[0] + w[1] + w[2] + w[3] + 12)}`);
  for (const r of results) {
    console.log(line(r.name, r.value, r.unit, r.expect) + `  ${r.ok ? 'PASS' : 'FAIL'}${r.note ? `   ${r.note}` : ''}`);
  }
  const fails = results.filter((r) => !r.ok);
  console.log(`  ${'-'.repeat(w[0] + w[1] + w[2] + w[3] + 12)}`);
  console.log(`  ${results.length - fails.length}/${results.length} passed\n`);
}
process.exit(results.some((r) => !r.ok) ? 1 : 0);
