import * as THREE from 'three';
import { EventBus } from './core/EventBus.js';
import { Input } from './core/Input.js';
import { Settings } from './core/Settings.js';
import { makeRng, clamp } from './core/MathX.js';
import { ProceduralAssets } from './core/Assets.js';

import { EnvironmentSystem } from './env/EnvironmentSystem.js';
import { WorldSystem } from './world/WorldSystem.js';
import { CitySystem } from './world/city/CitySystem.js';
import { CarSystem } from './vehicle/CarSystem.js';
import { PhysicsSystem } from './physics/PhysicsSystem.js';
import { CameraSystem } from './camera/CameraSystem.js';
import { VfxSystem } from './vfx/VfxSystem.js';
import { AudioSystem } from './audio/AudioSystem.js';
import { UiSystem } from './ui/UiSystem.js';
import { RaceSystem } from './game/RaceSystem.js';
import { PostFxSystem } from './render/PostFxSystem.js';

const FIXED_DT = 1 / 120; // physics tick
const MAX_SUBSTEPS = 8;

/**
 * The QA harness drives the game through Playwright and reads the canvas back, which needs
 * `preserveDrawingBuffer`. Players do not: it costs a full-framebuffer copy every frame and,
 * on Windows/ANGLE-D3D11 with a hybrid GPU, is a known cause of a permanently black canvas.
 * So it is opt-in — `navigator.webdriver` covers the harness, `?qa=1` covers manual capture.
 */
function urlFlag(name) {
  try {
    return new URLSearchParams(location.search).has(name);
  } catch {
    return false;
  }
}

function isQaSession() {
  try {
    return navigator.webdriver === true || urlFlag('qa');
  } catch {
    return urlFlag('qa');
  }
}

class Game {
  constructor() {
    this.canvas = document.getElementById('viewport');
    this.bus = new EventBus();
    this.rng = makeRng(0x5eed1234);
    this.running = false;
    this.paused = false;
    this.accumulator = 0;
    this.frame = 0;
    this.fps = 60;
    this._fpsSmooth = 60;
    this._last = 0;
    this._bootStep = 0;
  }

  async boot() {
    const status = document.querySelector('.boot-status');
    const bar = document.querySelector('.boot-bar i');
    const steps = [];
    const progress = (label, frac) => {
      if (status) status.textContent = label.toUpperCase();
      if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    };

    // ---------- renderer ----------
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false, // we use post-process AA; MSAA fights the composer
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      preserveDrawingBuffer: isQaSession(),
    });
    renderer.debug.checkShaderErrors = true;
    this._installGpuGuards(renderer);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.info.autoReset = false;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.matrixWorldAutoUpdate = true;
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.15, 6000);
    camera.position.set(0, 4, 12);
    this.camera = camera;

    // ?safemode=1 — lowest tier, no post-processing, no auto-adjust. This is a diagnostic: if
    // the game is black normally but renders in safe mode, the fault is in the post chain on
    // that driver, which narrows it from "somewhere in the renderer" to one of eleven passes.
    this.safeMode = urlFlag('safemode');
    const settings = new Settings(this.bus, this.safeMode ? 'low' : Settings.detect(renderer));
    settings.autoAdjust = !this.safeMode;
    const input = new Input(this.bus, this.canvas);
    const assets = new ProceduralAssets(renderer, settings);

    const ctx = {
      THREE,
      renderer,
      scene,
      camera,
      canvas: this.canvas,
      bus: this.bus,
      input,
      settings,
      assets,
      rng: this.rng,
      time: { dt: 0, elapsed: 0, frame: 0, scale: 1 },
      player: null,
      debug: { enabled: false, values: {}, log: (k, v) => (ctx.debug.values[k] = v) },
      game: this,
    };
    this.ctx = ctx;

    this._applyPixelRatio();

    // ---------- construct systems ----------
    // Construction is cheap and dependency-free; init() is where the work happens, and by then
    // every ctx.<system> reference is already populated.
    ctx.env = this.env = new EnvironmentSystem(ctx);
    ctx.world = this.world = new WorldSystem(ctx);
    ctx.city = this.city = new CitySystem(ctx);
    ctx.cars = this.cars = new CarSystem(ctx);
    ctx.physics = this.physics = new PhysicsSystem(ctx);
    ctx.cameras = this.cameras = new CameraSystem(ctx);
    ctx.vfx = this.vfx = new VfxSystem(ctx);
    ctx.audio = this.audio = new AudioSystem(ctx);
    ctx.hud = this.hud = new UiSystem(ctx);
    ctx.race = this.race = new RaceSystem(ctx);
    ctx.post = this.post = new PostFxSystem(ctx);

    const phases = [
      ['generating materials', () => assets.init()],
      ['building sky & lighting', () => this.env.init()],
      ['carving the circuit', () => this.world.init()],
      ['raising the city', () => this.city.init()],
      ['assembling vehicles', () => this.cars.init()],
      ['calibrating suspension', () => this.physics.init()],
      ['mounting cameras', () => this.cameras.init()],
      ['loading effects', () => this.vfx.init()],
      ['tuning exhaust note', () => this.audio.init()],
      ['painting the hud', () => this.hud.init()],
      ['forming the grid', () => this.race.init()],
      ['compiling shaders', () => this.post.init()],
    ];

    for (let i = 0; i < phases.length; i++) {
      const [label, fn] = phases[i];
      await progress(label, i / phases.length);
      try {
        await fn();
      } catch (err) {
        console.error(`[boot] "${label}" failed:`, err);
        this._bootError(label, err);
        throw err;
      }
    }
    await progress('ready', 1);

    if (this._shaderFailed || this.safeMode) this.post._failed = true;
    if (this.safeMode) {
      console.warn('[gpu] safe mode — post-processing bypassed, tier pinned to low');
      this._notice('Safe mode: post-processing off, lowest quality.', true);
    }

    // Warm the shader cache so the first seconds of gameplay don't stutter.
    scene.traverse((o) => {
      if (o.isMesh) o.frustumCulled = o.frustumCulled ?? true;
    });
    renderer.compile(scene, camera);

    window.addEventListener('resize', () => this.onResize());
    this.bus.on('quality:change', ({ tier }) => {
      this._applyPixelRatio();
      for (const s of this._systems()) s.onQuality?.(tier ?? settings.tier);
    });

    // Audio needs a gesture; arm it on the first meaningful interaction.
    const unlock = () => {
      this.audio.unlock?.();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    document.getElementById('boot')?.classList.add('done');
    setTimeout(() => document.getElementById('boot')?.remove(), 900);

    this.bus.emit('game:ready');
    this.running = true;
    this._last = performance.now();
    requestAnimationFrame(this._tick);
    this._installTestHooks();
    return this;
  }

  _bootError(label, err) {
    const el = document.getElementById('boot');
    if (!el) return;
    el.classList.add('error');
    el.innerHTML = `<div class="boot-inner"><div class="boot-logo">NEED<span>FOR</span>TOKENS</div>
      <div class="boot-status" style="color:#ff5a5a">BOOT FAILED — ${label}</div>
      <pre style="max-width:70ch;white-space:pre-wrap;opacity:.7;font-size:11px">${String(
        err?.stack || err
      )
        .replace(/</g, '&lt;')
        .slice(0, 1400)}</pre></div>`;
  }

  /**
   * Two GPU failure modes that produce a black screen with a *successful* boot, which is why
   * neither was caught by the existing try/catch in PostFxSystem:
   *
   *  - A shader that compiles on ANGLE-Metal (macOS) but not ANGLE-D3D11 (Windows). Three logs
   *    the link error and carries on, so the pass silently draws nothing and the composite is
   *    black. Nothing throws, so the chain's own fallback never fires.
   *  - Context loss. Windows resets the driver on a GPU hang far more readily than macOS does
   *    (TDR, 2 s default) and without a handler the canvas stays black forever.
   *
   * In both cases the game itself is fine — only the post chain is expendable — so drop it and
   * keep rendering rather than presenting a dead screen.
   */
  _installGpuGuards(renderer) {
    renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const log = (sh) => (gl.getShaderInfoLog(sh) || '').trim();
      const name = program.name || program.diagnostics?.material?.name || 'unnamed';
      console.error(
        `[gpu] shader "${name}" failed to build on this driver — dropping post-processing.\n` +
          `vertex: ${log(vs)}\nfragment: ${log(fs)}\nlink: ${(
            gl.getProgramInfoLog(program) || ''
          ).trim()}`
      );
      // A shader can fail while procedural assets are still building, before PostFxSystem
      // exists, so latch it — boot re-applies the latch once the chain is constructed.
      this._shaderFailed = true;
      if (this.post) this.post._failed = true;
      this._notice(
        `A rendering effect isn’t supported by this GPU driver — running without post-processing. ` +
          `Details in the browser console (F12).`
      );
    };

    this.canvas.addEventListener('webglcontextlost', (e) => {
      // Without preventDefault the context is never eligible for restoration.
      e.preventDefault();
      this.running = false;
      console.error('[gpu] WebGL context lost');
      this._notice('The graphics driver reset. Reload the page to continue.', true);
    });

    this.canvas.addEventListener('webglcontextrestored', () => {
      console.warn('[gpu] WebGL context restored — reloading to rebuild GPU resources');
      location.reload();
    });
  }

  /** Non-blocking corner banner; never covers the road. */
  _notice(text, persist = false) {
    let el = document.getElementById('nft-notice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'nft-notice';
      document.getElementById('ui-root')?.appendChild(el) ?? document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    if (!persist) setTimeout(() => el.classList.remove('show'), 9000);
  }

  _systems() {
    return [
      this.env,
      this.world,
      this.city,
      this.cars,
      this.physics,
      this.cameras,
      this.vfx,
      this.audio,
      this.hud,
      this.race,
      this.post,
    ].filter(Boolean);
  }

  /**
   * Device pixel ratio alone does not bound the cost of a frame: a 4K monitor at ratio 1 is
   * 8.3 MP, four times the 1080p the tiers were tuned against, and the whole post chain is
   * per-pixel. So each tier also carries a pixel budget, and we scale the ratio down until the
   * drawing buffer fits inside it — a slightly soft image being very much better than a
   * quarter-rate one.
   */
  _applyPixelRatio() {
    const s = this.ctx.settings;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const budget = s.get('maxPixels') ?? Infinity;

    let pr = Math.min(window.devicePixelRatio || 1, s.get('pixelRatio') ?? 1);
    const pixels = w * h * pr * pr;
    if (pixels > budget) pr *= Math.sqrt(budget / pixels);
    pr = Math.max(pr, 0.5); // below this the SMAA pass has nothing left to work with

    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
  }

  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._applyPixelRatio();
    this.post?.resize?.(w, h);
    for (const s of this._systems()) s.onResize?.(w, h);
  }

  _tick = (now) => {
    if (!this.running) return;
    requestAnimationFrame(this._tick);

    let dt = (now - this._last) / 1000;
    this._last = now;
    if (!Number.isFinite(dt)) dt = 1 / 60;
    dt = clamp(dt, 0, 0.25);
    this._fpsSmooth += (1 / Math.max(dt, 1e-4) - this._fpsSmooth) * 0.06;
    this.fps = this._fpsSmooth;

    const ctx = this.ctx;
    const scaled = dt * ctx.time.scale;
    ctx.time.dt = scaled;
    ctx.time.elapsed += scaled;
    ctx.time.frame = ++this.frame;

    const speedKmh = ctx.player?.state?.speedKmh ?? 0;
    if (this._autoDrive) this._steerAlongTrack();
    ctx.input.update(dt, Math.abs(speedKmh));

    if (ctx.input.state.pause) this.race?.togglePause?.();
    if (ctx.input.state.camera) this.cameras?.cycleMode?.();

    if (!this.paused) {
      // ---- fixed-step simulation ----
      this.accumulator += scaled;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
        this.physics.step(FIXED_DT);
        this.race.fixedUpdate?.(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === MAX_SUBSTEPS) this.accumulator = 0; // don't spiral

      // ---- variable-step update, fixed order ----
      this.env.update(scaled, ctx);
      this.world.update(scaled, ctx);
      this.city.update(scaled, ctx);
      this.cars.update(scaled, ctx); // pushes physics state onto meshes
      this.race.update(scaled, ctx);
      this.cameras.update(scaled, ctx);
      this.vfx.update(scaled, ctx);
      this.audio.update(scaled, ctx);
      this.hud.update(scaled, ctx);
      for (const s of this._systems()) s.lateUpdate?.(scaled, ctx);
    } else {
      this.hud.update(scaled, ctx);
      this.cameras.update(scaled, ctx);
    }

    this.renderer.info.reset();
    this.post.render(scaled);
    ctx.debug.values.draws = this.renderer.info.render.calls;
    ctx.debug.values.tris = this.renderer.info.render.triangles;
    ctx.debug.values.fps = this.fps;
    this.ctx.settings.observeFrame(dt);
    if (this._onFrame) this._onFrame();
  };

  /**
   * QA autopilot. Several capture scenarios just hold full throttle, which sends the car off the
   * circuit before the frame is taken and produces a shot of a dust cloud in a field rather than
   * of the game. This steers the player along the racing line so action shots are reproducible.
   * It writes through the same `__NFT_INPUT_OVERRIDE` channel the harness already uses, so it
   * needs no cooperation from RaceSystem.
   */
  _steerAlongTrack() {
    const ctx = this.ctx;
    const track = ctx.world?.track;
    const s = ctx.player?.state;
    if (!track || !s) return;
    const cfg = this._autoDrive;
    try {
      const proj = track.project(s.position, this._adHint ?? -1);
      this._adHint = proj.t;
      const speed = Math.max(Math.abs(s.speed ?? 0), 1);
      // Look further ahead the faster we go, in metres converted to normalised track units.
      const ahead = Math.min(12 + speed * 0.75, 90) / track.length;
      const line = track.racingLine ?? track;
      const aim = line.pointAt((proj.t + ahead) % 1, _adAim);
      const fwd = _adFwd.set(0, 0, -1).applyQuaternion(s.quaternion);
      const right = _adRight.set(1, 0, 0).applyQuaternion(s.quaternion);
      const to = _adTo.subVectors(aim, s.position);
      to.y = 0;
      if (to.lengthSq() < 1e-6) return;
      to.normalize();
      const lat = to.dot(right);
      const fwdDot = to.dot(fwd);
      let steer = clamp(lat * 2.6, -1, 1);
      if (fwdDot < 0) steer = Math.sign(lat) || 1; // facing away — turn around
      // Ease off the throttle if we're carrying too much speed for what's coming.
      const target = line.speedAt ? line.speedAt((proj.t + ahead * 0.6) % 1) : 1e3;
      const over = speed - target * (cfg.pace ?? 1.0);
      window.__NFT_INPUT_OVERRIDE = {
        throttle: over > 0 ? Math.max(0, (cfg.throttle ?? 1) - over * 0.08) : (cfg.throttle ?? 1),
        brake: over > 12 ? Math.min(1, (over - 12) * 0.05) : 0,
        steer,
        handbrake: cfg.handbrake ?? 0,
        nos: cfg.nos ?? 0,
      };
    } catch {
      /* track mid-rebuild; leave the previous override in place */
    }
  }

  /** Hooks the automated visual-QA harness drives. See tools/screenshot.mjs. */
  _installTestHooks() {
    const g = this;
    const ctx = this.ctx;
    window.__NFT = {
      get ctx() {
        return ctx;
      },
      get frame() {
        return g.frame;
      },
      get fps() {
        return g.fps;
      },
      get stats() {
        return { ...ctx.debug.values, tier: ctx.settings.tier };
      },
      ready: true,
      waitFrames(n = 2) {
        return new Promise((res) => {
          let left = n;
          const prev = g._onFrame;
          g._onFrame = () => {
            if (--left <= 0) {
              g._onFrame = prev;
              res();
            }
          };
        });
      },
      /** Advance `seconds` of SIMULATED time. Frame-count waiting is wrong at 400+ fps. */
      settle(seconds = 1.0) {
        return new Promise((res) => {
          const until = ctx.time.elapsed + seconds;
          const prev = g._onFrame;
          g._onFrame = () => {
            if (ctx.time.elapsed >= until) {
              g._onFrame = prev;
              res();
            }
          };
        });
      },
      drive(ov) {
        g._autoDrive = null;
        window.__NFT_INPUT_OVERRIDE = ov || null;
      },
      /**
       * Steer the player along the racing line so action shots stay on the circuit.
       * `opts`: { throttle, nos, handbrake, pace } — `pace` scales the target speed
       * (0.9 = conservative, 1.1 = ragged edge). Pass `false` to hand control back.
       */
      autoDrive(on = true, opts = {}) {
        if (!on) {
          g._autoDrive = null;
          window.__NFT_INPUT_OVERRIDE = null;
          return;
        }
        g._adHint = -1;
        g._autoDrive = { throttle: 1, nos: 0, handbrake: 0, pace: 1.0, ...opts };
      },
      /**
       * Pins the tier. Asking for a specific quality means "render at this", not "start here" —
       * for the capture harness a tier that drifts mid-shot-list silently invalidates every
       * comparison made from it, and for a player choosing Ultra by hand it is just wrong.
       * Pass `auto` to hand control back to the frame-rate governor.
       */
      setQuality(t, { auto = false } = {}) {
        ctx.settings.autoAdjust = !!auto;
        ctx.settings.setTier(t);
      },
      setTimeOfDay(h) {
        ctx.env.setTimeOfDay?.(h);
      },
      setPreset(p) {
        ctx.env.setPreset?.(p);
      },
      setWeather(w) {
        ctx.env.setWeather?.(w);
      },
      setCamera(m) {
        ctx.cameras.setMode?.(m);
      },
      photo(pose) {
        ctx.cameras.setPhotoPose?.(pose);
      },
      /**
       * Hide the whole UI overlay for clean comparison captures.
       * Must be `display`, not `visibility`: the UI stylesheet re-asserts
       * `visibility: visible` on individual screens, and a descendant can override an
       * inherited `visibility: hidden`. `display: none` cannot be overridden that way.
       */
      hideHud(v = true) {
        const r = document.getElementById('ui-root');
        if (r) r.style.display = v ? 'none' : '';
      },
      screen(name) {
        ctx.hud.setScreen?.(name);
      },
      /**
       * Is this frame worth keeping? Two capture failures got all the way into a blind
       * comparison before anyone noticed: the camera ended up inside a building wall, and
       * buried in a grass verge — both produced a frame that was mostly one flat quad with no
       * car in it. A judge scores those as catastrophic rendering failures, which is not what
       * they are. The harness asserts this before saving an action shot.
       */
      validate() {
        const car = ctx.player;
        const cam = ctx.camera;
        if (!car?.state || !cam) return { ok: false, reason: 'no player or camera' };

        // Regardless of camera mode: if the car has left the circuit, the frame is showing a
        // field, not the game. This is what produced a "camera parked in the grass verge with
        // no car in shot" frame that reached a blind comparison.
        const track = ctx.world?.track;
        if (track) {
          const proj = track.project(car.state.position, -1);
          if (!proj.onTrack) {
            return { ok: false, onTrack: false, reason: `car off track (lateral ${proj.lateral.toFixed(1)}m)` };
          }
        }

        // In hood/bumper cams the car is behind the lens by design, so "car on screen" is the
        // wrong test. What still matters is that the lens has not ended up inside geometry.
        const mode = ctx.cameras?.mode;
        if (mode === 'hood' || mode === 'bumper') {
          const g = ctx.world?.sampleGround?.(cam.position.x, cam.position.z);
          const buried = g && Number.isFinite(g.height) && cam.position.y < g.height + 0.15;
          return {
            ok: !buried,
            onScreen: true,
            occluded: false,
            reason: buried ? 'camera at or below ground' : '',
            mode,
          };
        }

        const p = _vTmp.copy(car.state.position);
        p.y += 0.6;
        const ndc = _vTmp2.copy(p).project(cam);
        const onScreen = Math.abs(ndc.x) <= 0.98 && Math.abs(ndc.y) <= 0.98 && ndc.z > -1 && ndc.z < 1;
        // Is anything solid between the camera and the car?
        const toCar = _vTmp3.subVectors(p, cam.position);
        const dist = toCar.length();
        let occluded = false;
        if (dist > 0.5) {
          toCar.divideScalar(dist);
          const hit = ctx.physics?.raycast?.(cam.position, toCar, dist - 0.4);
          occluded = !!hit?.hit && hit.distance < dist - 0.6;
        }
        const reason = !onScreen ? 'car off screen' : occluded ? 'camera occluded from car' : '';
        return { ok: onScreen && !occluded, onScreen, occluded, distance: dist, reason };
      },
      teleport(t, lateral = 0, speedKmh = 0) {
        ctx.race?.teleportPlayer?.(t, lateral, speedKmh);
      },
      timeScale(s) {
        ctx.time.scale = s;
      },
      pause(v = true) {
        g.paused = v;
      },
      errors: [],
    };
    window.addEventListener('error', (e) =>
      window.__NFT.errors.push(String(e.message || e.error))
    );
    window.addEventListener('unhandledrejection', (e) =>
      window.__NFT.errors.push(String(e.reason))
    );
  }
}

// Scratch vectors for the QA autopilot — allocating these per frame would show up in profiles.
const _adAim = new THREE.Vector3();
const _adFwd = new THREE.Vector3();
const _adRight = new THREE.Vector3();
const _adTo = new THREE.Vector3();
const _vTmp = new THREE.Vector3();
const _vTmp2 = new THREE.Vector3();
const _vTmp3 = new THREE.Vector3();

const game = new Game();
window.__GAME = game;
game.boot().catch((err) => console.error('[boot] fatal', err));
