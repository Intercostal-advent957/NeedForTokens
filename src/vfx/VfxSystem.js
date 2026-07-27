import * as THREE from 'three';
import { clamp01 } from '../core/MathX.js';

import { DepthPass } from './DepthPass.js';
import { SmokeField } from './SmokeField.js';
import { StreakField } from './StreakField.js';
import { SkidMarks } from './SkidMarks.js';
import { Rain } from './Rain.js';
import { ScreenGrab, HeatHaze } from './Distortion.js';
import { Overlay } from './Overlay.js';
import { FlashPool } from './FlashPool.js';
import { Jets } from './Jets.js';
import { surfaceOf, BUDGET_SPLIT, TIER } from './presets.js';
import { disposeVfxTextures } from './vfxTextures.js';

/**
 * VfxSystem — CONTRACTS.md §11.
 *
 * ARCHITECTURE
 *   One GPU-instanced field per effect family, never one draw call per particle:
 *     SmokeField   analytic GPU sim, lit + soft   — tyre smoke, dust, spray, exhaust, splashes
 *     StreakField  ×2, CPU sim, velocity-stretched — sparks/flame (additive) and debris (lit)
 *     Rain         camera-locked analytic volume   — falling rain, never runs out
 *     SkidMarks    growing ribbon, one vertex ring — persistent rubber/dust decals
 *     HeatHaze     grab-pass refraction quads      — exhaust shimmer, NOS shockwave
 *     Jets         pooled lathe flame bodies       — NOS jets, backfire licks
 *     FlashPool    pooled point lights + glows     — real dynamic light on every hot event
 *     Overlay      one clip-space quad             — speed lines, tunnel vision, lens droplets
 *
 *   Total live instances are capped at `settings.get('particleBudget')` (see presets.js).
 *   The update loop performs zero allocations: every emitter takes plain numbers, every pool is
 *   a preallocated typed array, and all vector maths runs through module-scope scratch objects.
 */
export class VfxSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = new THREE.Group();
    this.root.name = 'vfx';
    this.root.matrixAutoUpdate = false;
    this.root.frustumCulled = false;

    this.depth = new DepthPass(ctx);
    this.grab = new ScreenGrab(ctx);

    this.cars = new Map(); // CarInstance -> per-car emitter state (allocated once per car)
    this.stats = { smoke: 0, hot: 0, cool: 0, skid: 0, rain: 0, peak: 0 };

    this._speedLinesManual = 0;
    this._unsubs = [];
    this._excludeRoots = [];
    this._tier = null;
  }

  async init() {
    const { scene, settings } = this.ctx;
    scene.add(this.root);

    this.depth.init();
    const tier = settings.tier ?? 'high';
    const t = TIER[tier] ?? TIER.high;
    const P = settings.get('particleBudget') ?? 3000;

    this.smoke = new SmokeField(this.ctx, this.depth, this.root, Math.round(P * BUDGET_SPLIT.smoke)).init();
    this.hot = new StreakField(this.ctx, this.depth, this.root, {
      capacity: Math.round(P * BUDGET_SPLIT.hot),
      mode: 'hot',
    }).init();
    this.cool = new StreakField(this.ctx, this.depth, this.root, {
      capacity: Math.round(P * BUDGET_SPLIT.cool),
      mode: 'cool',
    }).init();
    this.rain = new Rain(this.ctx, this.depth, this.root, Math.round(P * BUDGET_SPLIT.rain)).init();
    this.skids = new SkidMarks(this.ctx, this.root, t.skid).init();
    this.haze = new HeatHaze(this.ctx, this.depth, this.grab, this.root, t.haze).init();
    this.flashes = new FlashPool(this.ctx, this.root, t.flashes).init();
    this.jets = new Jets(this.ctx, this.root, t.jets).init();
    this.overlay = new Overlay(this.ctx, this.grab, this.root).init();

    // Everything translucent we own must be invisible to our own depth pre-pass.
    this._excludeRoots = [this.root];

    this.onQuality(tier);
    this._subscribe();
    return this;
  }

  // ------------------------------------------------------------------ events (§2)
  _subscribe() {
    const bus = this.ctx.bus;
    const on = (name, fn) => this._unsubs.push(bus.on(name, fn) ?? (() => bus.off(name, fn)));

    on('car:collision', (e) => this._onCollision(e));
    on('car:shift', (e) => this._onShift(e));
    on('car:backfire', (e) => this._onBackfire(e));
    on('car:nos', (e) => this._onNos(e));
    on('car:land', (e) => this._onLand(e));
    on('wheel:surface', (e) => this._onSurfaceChange(e));
    on('race:restart', () => this.skids?.clear());
  }

  _onCollision({ car, impulse = 0, point, normal, tag }) {
    if (!point) return;
    const mag = clamp01(impulse / 26000);
    if (mag < 0.02) return;

    const st = car?.state;
    const sp = st ? st.velocity.length() : 8;
    _n.set(normal?.x ?? 0, normal?.y ?? 0, normal?.z ?? 1);
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    _n.normalize();

    // Sparks fly along the *grazing* direction, not along the normal — they are shed metal,
    // so they follow the tangent of the impact, spraying into a fan.
    _v.copy(st?.velocity ?? _up).addScaledVector(_n, -(st?.velocity ?? _up).dot(_n));
    if (_v.lengthSq() < 0.5) _v.copy(_n).cross(_up);
    _v.normalize();

    // Physics emits a collision every frame while the car scrapes a barrier. Budget the shower
    // over time instead of firing a full burst per event, or a long scrape looks like fireworks.
    const cs = this._carState(car);
    const now = this.ctx.time.elapsed;
    const since = cs ? now - (cs.lastCollision ?? -1) : 1;
    if (cs) cs.lastCollision = now;
    const sustained = since < 0.25;
    const n = sustained
      ? Math.min(Math.round(since * 240 * (0.3 + mag)), 14)
      : Math.round(10 + mag * 60);
    this._sparkFan(point.x, point.y, point.z, _v.x, _v.y, _v.z, _n.x, _n.y, _n.z, n, Math.min(sp, 40));

    if (!sustained && tag !== 'car') this.emitDebris(point, _v, Math.round(3 + mag * 12));
    if (!sustained || Math.random() < 0.12) {
      this.flash(point, 0xffc47a, 6 + mag * 26, 5 + mag * 9, 0.11 + mag * 0.08);
    }
    if (sustained) {
      this.ctx.cameras?.shake?.(clamp01(impulse / 60000) * 0.3, 0.12);
      return;
    }

    // A hard hit also throws a burst of dust/paint smoke.
    const g = this._groundY(point.x, point.z, point.y);
    for (let i = 0; i < 3 + (mag * 8) | 0; i++) {
      this.smoke.spawn(
        point.x + (Math.random() - 0.5) * 0.5, point.y + Math.random() * 0.4, point.z + (Math.random() - 0.5) * 0.5,
        _v.x * 2 + (Math.random() - 0.5) * 3, 0.6 + Math.random() * 2.2, _v.z * 2 + (Math.random() - 0.5) * 3,
        0.22, 1.5 + mag * 2.0, 0.75 + Math.random() * 0.5,
        0.44, 0.42, 0.40, 0.34 + mag * 0.3,
        0.55, 2.0, 0.24, 0.0, g, (Math.random() - 0.5) * 3.0
      );
    }
    this.ctx.cameras?.shake?.(clamp01(impulse / 38000) * 0.95, 0.35);
  }

  _onShift({ car, up }) {
    if (!up) return;
    const st = car?.state;
    if (!st) return;
    // Lift-off / upshift backfire: likelier the harder the engine was working.
    const strength = clamp01((st.engineLoad ?? 0.4) * 0.8 + (st.rpm ?? 0) / 9000 * 0.5);
    if (Math.random() < 0.35 + strength * 0.5) this._backfire(car, 0.45 + strength * 0.55);
    else this._exhaustPuff(car, 0.5);
  }

  _onBackfire({ car, strength = 1 }) {
    this._backfire(car, clamp01(strength));
  }

  _onNos({ car, active }) {
    const s = this._carState(car);
    if (s) s.nos = !!active;
    if (active && car?.nosPorts?.length) {
      for (let i = 0; i < car.nosPorts.length; i++) {
        car.nosPorts[i].getWorldPosition(_p);
        this.flash(_p, 0x88ccff, 26, 11, 0.16);
      }
    }
  }

  _onLand({ car, impact = 0 }) {
    const st = car?.state;
    if (!st) return;
    const mag = clamp01(impact / 12);
    if (mag < 0.05) return;
    for (let i = 0; i < 4; i++) {
      const w = st.wheels[i];
      if (!w?.contactPoint) continue;
      const surf = surfaceOf(w.surface);
      const n = 3 + Math.round(mag * 9);
      for (let k = 0; k < n; k++) {
        this.smoke.spawn(
          w.contactPoint.x + (Math.random() - 0.5) * 0.4, w.contactPoint.y + 0.06, w.contactPoint.z + (Math.random() - 0.5) * 0.4,
          (Math.random() - 0.5) * 4.5, 0.5 + Math.random() * 1.6, (Math.random() - 0.5) * 4.5,
          surf.size0 * 0.9, surf.size1 * (0.7 + mag * 0.6), surf.life * 0.7,
          surf.smoke[0], surf.smoke[1], surf.smoke[2], 0.22 + mag * 0.3,
          surf.turb, 2.1, surf.buoyancy * 0.7, surf.glow, w.contactPoint.y, (Math.random() - 0.5) * 2.4
        );
      }
      if (mag > 0.55 && (w.surface === 'asphalt' || w.surface === 'concrete' || w.surface === 'metal')) {
        _v.copy(st.velocity).setY(0).normalize();
        this._sparkFan(
          w.contactPoint.x, w.contactPoint.y + 0.02, w.contactPoint.z,
          _v.x, 0.15, _v.z, 0, 1, 0, Math.round(mag * 26), 14
        );
      }
    }
    this.ctx.cameras?.shake?.(mag * 0.5, 0.25);
  }

  _onSurfaceChange({ car, wheel, surface }) {
    const st = car?.state;
    const w = st?.wheels?.[wheel];
    if (!w?.contact) return;
    const surf = surfaceOf(surface);
    if (surf.debris <= 0 && surf.rate < 40) return;
    for (let i = 0; i < 4; i++) {
      this.smoke.spawn(
        w.contactPoint.x, w.contactPoint.y + 0.05, w.contactPoint.z,
        (Math.random() - 0.5) * 2.5, 0.4 + Math.random() * 1.0, (Math.random() - 0.5) * 2.5,
        surf.size0, surf.size1 * 0.7, surf.life * 0.6,
        surf.smoke[0], surf.smoke[1], surf.smoke[2], 0.20,
        surf.turb, 2.0, surf.buoyancy, surf.glow, w.contactPoint.y, (Math.random() - 0.5) * 2.5
      );
    }
  }

  // ------------------------------------------------------------------ public API (§11)
  /** emitSmoke(pos, dir, amount, opts) */
  emitSmoke(p, dir, amount, opts) {
    if (!p) return;
    const o = opts || _EMPTY;
    const c = o.color || _GREY;
    const size = o.size ?? 1.4;
    const life = o.life ?? 1.6;
    const n = Math.min(Math.max(amount | 0, 0), 48);
    const gy = o.groundY ?? this._groundY(p.x, p.z, p.y);
    const dx = dir?.x ?? 0;
    const dy = dir?.y ?? 0;
    const dz = dir?.z ?? 0;
    for (let i = 0; i < n; i++) {
      this.smoke.spawn(
        p.x + (Math.random() - 0.5) * size * 0.35,
        p.y + Math.random() * size * 0.2,
        p.z + (Math.random() - 0.5) * size * 0.35,
        dx * 0.22 + (Math.random() - 0.5) * 1.4,
        dy * 0.12 + 0.35 + Math.random() * 0.7,
        dz * 0.22 + (Math.random() - 0.5) * 1.4,
        size * 0.22, size * (1.5 + Math.random() * 0.8), life * (0.75 + Math.random() * 0.5),
        c[0], c[1], c[2], o.opacity ?? 0.42,
        o.turbulence ?? 0.42, o.drag ?? 1.6, o.buoyancy ?? 0.28, o.glow ?? 0,
        gy, (Math.random() - 0.5) * 2.2
      );
    }
  }

  /** emitSparks(pos, normal, amount, opts) */
  emitSparks(p, normal, amount, opts) {
    if (!p) return;
    const o = opts || _EMPTY;
    _n.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    _n.normalize();
    _v.copy(_n).cross(_up);
    if (_v.lengthSq() < 1e-4) _v.set(1, 0, 0);
    _v.normalize();
    this._sparkFan(
      p.x, p.y, p.z, _v.x, _v.y, _v.z, _n.x, _n.y, _n.z,
      Math.min(Math.max(amount | 0, 0), 140), o.speed ?? 12
    );
  }

  /** emitDebris(pos, dir, amount) */
  emitDebris(p, dir, amount, opts) {
    if (!p) return;
    const o = opts || _EMPTY;
    const col = o.color || _DEBRIS;
    const gy = this._groundY(p.x, p.z, p.y);
    const n = Math.min(Math.max(amount | 0, 0), 40);
    const dx = dir?.x ?? 0;
    const dy = dir?.y ?? 0.4;
    const dz = dir?.z ?? 0;
    for (let i = 0; i < n; i++) {
      const sp = (o.speed ?? 6) * (0.4 + Math.random() * 1.1);
      this.cool.spawn(
        p.x, p.y + 0.05, p.z,
        dx * sp * 0.55 + (Math.random() - 0.5) * sp,
        Math.abs(dy) * sp * 0.3 + 1.2 + Math.random() * sp * 0.5,
        dz * sp * 0.55 + (Math.random() - 0.5) * sp,
        0.7 + Math.random() * 0.9, o.width ?? 0.055, o.stretch ?? 0.012,
        col[0], col[1], col[2],
        0, gy, 0.55, 11.0, 0.34, 6 + Math.random() * 22, 0, 0.2
      );
    }
  }

  /** addSkid(pos, dir, width, opacity, surface) */
  addSkid(pos, dir, width, opacity, surface) {
    this.skids?.addSkid(pos, dir, width, opacity, surface);
  }

  /** flash(pos, color, intensity, radius, life) */
  flash(pos, color, intensity, radius, life) {
    this.flashes?.flash(pos, color, intensity, radius, life);
  }

  /** setSpeedLines(t) — 0..1. Layers on top of the automatic speed/NOS driver. */
  setSpeedLines(t) {
    this._speedLinesManual = clamp01(t || 0);
  }

  // ------------------------------------------------------------------ internals
  _carState(car) {
    if (!car) return null;
    let s = this.cars.get(car);
    if (!s) {
      s = {
        smokeAcc: new Float32Array(4),
        sprayAcc: new Float32Array(4),
        debrisAcc: new Float32Array(4),
        skidKeys: [null, null, null, null],
        exhaustAcc: 0,
        nosAcc: 0,
        lastCollision: -1,
        nos: false,
        wasNos: false,
        idleAcc: 0,
      };
      const id = car.id ?? Math.random().toString(36).slice(2);
      for (let i = 0; i < 4; i++) s.skidKeys[i] = `${id}#${this.cars.size}#${i}`;
      this.cars.set(car, s);
    }
    return s;
  }

  _groundY(x, z, fallback) {
    const g = this.ctx.world?.sampleGround?.(x, z);
    return g ? g.height : (fallback ?? 0);
  }

  _sparkFan(px, py, pz, tx, ty, tz, nx, ny, nz, count, speed) {
    const gy = this._groundY(px, pz, py) ;
    const n = Math.min(count | 0, 140);
    for (let i = 0; i < n; i++) {
      const s = speed * (0.35 + Math.random() * 1.25);
      const spread = 0.75;
      const vx = tx * s + (Math.random() - 0.5) * s * spread + nx * s * 0.28;
      const vy = ty * s + Math.random() * s * 0.42 + ny * s * 0.3 + 1.5;
      const vz = tz * s + (Math.random() - 0.5) * s * spread + nz * s * 0.28;
      this.hot.spawn(
        px, py + 0.04, pz, vx, vy, vz,
        0.35 + Math.random() * 0.55, 0.022 + Math.random() * 0.018, 0.016,
        1.0, 0.72, 0.34,
        0.75 + Math.random() * 0.25, gy, 0.9, 13.5, 0.42, 0, 0.4, 0.25
      );
    }
  }

  _backfire(car, strength) {
    const ports = car?.exhausts;
    if (!ports?.length) return;
    const st = car.state;
    for (let i = 0; i < ports.length; i++) {
      const port = ports[i];
      port.getWorldPosition(_p);
      port.getWorldQuaternion(_q);
      _back.set(0, 0, 1).applyQuaternion(_q); // car local +Z is rearward
      const carV = st?.velocity ?? _zero;
      const gy = this._groundY(_p.x, _p.z, _p.y);

      this.jets.pulse(`bf${car.id ?? ''}${i}`, port, 0.6 + strength * 0.9, 0.09 + strength * 0.09, 'backfire');

      const jet = 7 + strength * 13;
      const n = 5 + Math.round(strength * 12);
      for (let k = 0; k < n; k++) {
        this.hot.spawn(
          _p.x, _p.y, _p.z,
          carV.x + _back.x * jet * (0.5 + Math.random()) + (Math.random() - 0.5) * 2.4,
          carV.y + _back.y * jet * 0.4 + Math.random() * 1.6,
          carV.z + _back.z * jet * (0.5 + Math.random()) + (Math.random() - 0.5) * 2.4,
          0.10 + Math.random() * 0.16, 0.07 + Math.random() * 0.05, 0.010,
          1.0, 0.55, 0.18,
          0.85 + Math.random() * 0.15, gy, 3.6, 2.5, 0, 0, 0.9, 1.0
        );
      }
      // Unburnt fuel = a fat black soot puff right behind the flame.
      for (let k = 0; k < 2 + (strength * 4) | 0; k++) {
        this.smoke.spawn(
          _p.x, _p.y, _p.z,
          carV.x + _back.x * 3.5 + (Math.random() - 0.5) * 1.6,
          carV.y + 0.8 + Math.random() * 0.9,
          carV.z + _back.z * 3.5 + (Math.random() - 0.5) * 1.6,
          0.16, 1.1 + strength * 0.9, 0.85 + Math.random() * 0.5,
          0.10, 0.095, 0.09, 0.30 + strength * 0.2,
          0.6, 2.4, 0.34, 0.0, gy, (Math.random() - 0.5) * 4
        );
      }
      this.haze.spawn(
        _p.x + _back.x * 0.3, _p.y, _p.z + _back.z * 0.3,
        carV.x + _back.x * 4, carV.y + 0.6, carV.z + _back.z * 4,
        0.35, 0.35, 1.1, 0.9 * strength
      );
      this.flash(_p, 0xff8a3c, 14 + strength * 34, 6 + strength * 6, 0.075 + strength * 0.06);
    }
  }

  _exhaustPuff(car, amount) {
    const ports = car?.exhausts;
    if (!ports?.length) return;
    const st = car.state;
    const carV = st?.velocity ?? _zero;
    for (let i = 0; i < ports.length; i++) {
      ports[i].getWorldPosition(_p);
      ports[i].getWorldQuaternion(_q);
      _back.set(0, 0, 1).applyQuaternion(_q);
      const gy = this._groundY(_p.x, _p.z, _p.y);
      this.smoke.spawn(
        _p.x, _p.y, _p.z,
        carV.x + _back.x * 2.2 + (Math.random() - 0.5) * 0.8,
        carV.y + 0.5 + Math.random() * 0.5,
        carV.z + _back.z * 2.2 + (Math.random() - 0.5) * 0.8,
        0.05, 0.24 + amount * 0.34, 0.45 + Math.random() * 0.3,
        0.22, 0.215, 0.21, 0.035 + amount * 0.075,
        0.5, 2.8, 0.36, 0.0, gy, (Math.random() - 0.5) * 4
      );
    }
  }

  // ------------------------------------------------------------------ frame
  update(dt, ctx) {
    if (dt <= 0) dt = 1 / 120;
    const camPos = ctx.camera.position;
    let autoLines = 0;
    let nosAmount = 0;
    let dropletWant = 0;

    const instances = ctx.cars?.instances;
    if (instances) {
      for (let ci = 0; ci < instances.length; ci++) {
        const car = instances[ci];
        const st = car?.state;
        if (!st) continue;
        const distSq = _p.copy(st.position).distanceToSquared(camPos);
        const isPlayer = car === ctx.player || car.isPlayer;
        if (!isPlayer && distSq > 130 * 130) continue;
        const detail = isPlayer ? 1 : distSq < 45 * 45 ? 0.75 : 0.35;
        this._updateCar(car, st, dt, detail, isPlayer);
        if (isPlayer) {
          const kmh = Math.abs(st.speedKmh ?? 0);
          const fast = clamp01((kmh - 120) / 170);
          autoLines = fast * 0.8;
          // NOS only sells velocity when there IS velocity — a standing burnout must not
          // trigger the tunnel.
          nosAmount = st.nosActive ? fast * 0.9 + clamp01((kmh - 60) / 90) * 0.1 : 0;
        }
      }
    }

    // ---- weather ----
    const rainI = ctx.env?.rainIntensity ?? 0;
    const wet = ctx.env?.wetness ?? 0;
    if (rainI > 0.02) this._rainSplashes(dt, rainI);
    // Droplets only when the lens is physically on the car (hood/bumper/interior). Testing the
    // camera *distance* rather than the mode string keeps this correct whatever the camera lane
    // decides to call its views.
    const ppos = ctx.player?.state?.position;
    const onCar = ppos ? ppos.distanceToSquared(camPos) < 3.4 * 3.4 : false;
    if (onCar && (rainI > 0.02 || wet > 0.45)) {
      dropletWant = clamp01(rainI * 0.85 + wet * 0.25);
    }

    // ---- overlay ----
    this._speedLinesManual = Math.max(0, this._speedLinesManual - dt * 1.4);
    this.overlay.setSpeedLines(Math.max(autoLines, this._speedLinesManual));
    this.overlay.setNos(nosAmount);
    this.overlay.setDroplets(dropletWant);

    // ---- systems ----
    this.smoke.update(dt);
    this.hot.update(dt);
    this.cool.update(dt);
    this.rain.update(dt);
    this.skids.update(dt);
    this.haze.update(dt);
    this.jets.update(dt);
    this.flashes.update(dt);
    this.overlay.update(dt);

    // ---- bookkeeping ----
    if ((ctx.time.frame & 15) === 0) {
      this.stats.smoke = this.smoke.countLive();
      this.stats.hot = this.hot.count;
      this.stats.cool = this.cool.count;
      this.stats.rain = this.rain.geo.instanceCount;
      this.stats.skid = this.skids.head;
      const total = this.stats.smoke + this.stats.hot + this.stats.cool + this.stats.rain;
      if (total > this.stats.peak) this.stats.peak = total;
      ctx.debug?.log?.('vfx', total);
      ctx.debug?.log?.('vfxPeak', this.stats.peak);
    }
  }

  _updateCar(car, st, dt, detail, isPlayer) {
    const cs = this._carState(car);
    const def = car.def || _EMPTY;
    const wheelW = (def.wheelWidth ?? 0.26) * 0.92;
    const restLoad = Math.max((def.mass ?? 1400) * 9.81 * 0.25, 1);
    const env = this.ctx.env;
    const wet = clamp01(env?.wetness ?? 0);
    const rainI = clamp01(env?.rainIntensity ?? 0);
    const speed = Math.abs(st.speed ?? 0);

    for (let i = 0; i < 4; i++) {
      const w = st.wheels[i];
      if (!w) continue;
      const key = cs.skidKeys[i];
      if (!w.contact) {
        this.skids.trace(key, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 'asphalt');
        continue;
      }
      const cp = w.contactPoint;
      const surf = surfaceOf(w.surface);
      const loadF = clamp01(w.load / restLoad);

      // ---- contact-patch velocity (car velocity + spin about the CoG) ----
      _r.copy(cp).sub(st.position);
      _vel.copy(st.angularVelocity).cross(_r).add(st.velocity);
      const travel = _vel.length();

      // ---- slip severity ----
      const slip = w.slipSpeed ?? 0;
      let sev = clamp01((slip - 2.2) / 9);
      if (w.lockedUp) sev = Math.max(sev, clamp01(speed / 20));
      if (w.spinningUp) sev = Math.max(sev, clamp01(Math.abs(w.slipRatio) * 1.35));
      sev *= 0.45 + 0.55 * loadF;
      // Driven/rear tyres are the ones that light up in a drift; front smoke is secondary.
      if (i < 2) sev *= 0.62;
      const offRoad = surf.debris > 0 || surf.rate > 50;

      // ================= skid ribbon =================
      const skidOp = clamp01(sev * 1.25) * surf.skid * (1 - wet * 0.45);
      if (skidOp > 0.02 && travel > 1.2) {
        this.skids.trace(
          key, cp.x, cp.y, cp.z,
          w.contactNormal.x, w.contactNormal.y, w.contactNormal.z,
          _vel.x, _vel.y, _vel.z,
          wheelW, Math.min(skidOp * 0.8, 0.8), w.surface
        );
      } else {
        this.skids.trace(key, cp.x, cp.y, cp.z, 0, 1, 0, 0, 0, 0, wheelW, 0, w.surface);
      }

      // ================= tyre smoke / dust =================
      // Off-road wheels throw material just by rolling; tarmac needs real slip.
      const rollDust = offRoad ? clamp01((travel - 4) / 22) * 0.7 * loadF : 0;
      const drive = Math.max(sev, rollDust);
      if (drive > 0.03) {
        const rate = surf.rate * Math.pow(drive, 0.9) * detail * (1 + wet * 0.5);
        cs.smokeAcc[i] += rate * dt;
        let budget = 6;
        while (cs.smokeAcc[i] >= 1 && budget-- > 0) {
          cs.smokeAcc[i] -= 1;
          this._tyrePuff(st, w, cp, surf, drive, wet, travel);
        }
        if (cs.smokeAcc[i] > 3) cs.smokeAcc[i] = 3;
      } else {
        cs.smokeAcc[i] = 0;
      }

      // ================= debris / clippings =================
      if (surf.debris > 0 && travel > 3) {
        cs.debrisAcc[i] += surf.debris * clamp01((travel - 3) / 20) * 34 * detail * dt * (0.4 + drive);
        let budget = 4;
        while (cs.debrisAcc[i] >= 1 && budget-- > 0) {
          cs.debrisAcc[i] -= 1;
          const sp = 2 + travel * 0.35;
          this.cool.spawn(
            cp.x + (Math.random() - 0.5) * 0.3, cp.y + 0.05, cp.z + (Math.random() - 0.5) * 0.3,
            -_vel.x * 0.28 + (Math.random() - 0.5) * sp,
            1.5 + Math.random() * sp * 0.55,
            -_vel.z * 0.28 + (Math.random() - 0.5) * sp,
            0.65 + Math.random() * 0.8, 0.035 + Math.random() * 0.05, 0.010,
            surf.debrisColor[0], surf.debrisColor[1], surf.debrisColor[2],
            0, cp.y, 0.5, 12.5, 0.3, 8 + Math.random() * 26, 0, 0.2
          );
        }
        if (cs.debrisAcc[i] > 3) cs.debrisAcc[i] = 3;
      }

      // ================= road spray =================
      const sprayDrive = clamp01(Math.max(rainI * 1.05, wet * 0.85)) * clamp01((travel - 5) / 26);
      if (sprayDrive > 0.02 && !offRoad) {
        const rear = i >= 2 ? 1.5 : 1.0;
        cs.sprayAcc[i] += sprayDrive * 74 * rear * detail * dt;
        let budget = 6;
        while (cs.sprayAcc[i] >= 1 && budget-- > 0) {
          cs.sprayAcc[i] -= 1;
          this._sprayPuff(st, cp, _vel, travel, sprayDrive, rear);
        }
        if (cs.sprayAcc[i] > 4) cs.sprayAcc[i] = 4;
      } else {
        cs.sprayAcc[i] = 0;
      }

      // ================= bottoming out =================
      // Suspension force, not compression: a hard hit is one where the spring is carrying
      // several g, which is when the floor pan actually kisses the tarmac.
      if (w.load > restLoad * 2.9 && w.compression > 0.9 && speed > 14 && Math.random() < dt * 7 * detail) {
        _v.copy(st.velocity).setY(0);
        if (_v.lengthSq() > 1) _v.normalize();
        else _v.set(0, 0, -1);
        this._sparkFan(cp.x, cp.y + 0.02, cp.z, -_v.x, 0.18, -_v.z, 0, 1, 0, 5 + ((speed * 0.25) | 0), 8);
      }
    }

    // ================= exhaust, NOS, heat haze =================
    this._updateExhaust(car, st, cs, dt, detail, isPlayer);
  }

  _tyrePuff(st, w, cp, surf, drive, wet, travel) {
    // Smoke rolls off the back of the contact patch, tumbling away from the direction of travel
    // and outward from the car — that lateral kick is what makes a drift plume read as a drift.
    const back = -0.16 - drive * 0.10;
    const kick = 1.6 + drive * 4.5;
    const wetMix = clamp01(wet * 1.2);
    const vx = _vel.x * back + (Math.random() - 0.5) * kick;
    const vz = _vel.z * back + (Math.random() - 0.5) * kick;
    const vy = 0.35 + Math.random() * (0.8 + drive * 1.4);

    // Wet tarmac produces bright steam instead of grey rubber smoke.
    const r = surf.smoke[0] + (0.92 - surf.smoke[0]) * wetMix;
    const g = surf.smoke[1] + (0.94 - surf.smoke[1]) * wetMix;
    const b = surf.smoke[2] + (0.98 - surf.smoke[2]) * wetMix;

    const scale = 0.7 + drive * 0.75 + clamp01(travel / 45) * 0.35;
    this.smoke.spawn(
      cp.x + (Math.random() - 0.5) * 0.34,
      cp.y + 0.05 + Math.random() * 0.14,
      cp.z + (Math.random() - 0.5) * 0.34,
      vx, vy, vz,
      surf.size0 * scale, surf.size1 * scale * (0.8 + Math.random() * 0.5),
      surf.life * (0.7 + Math.random() * 0.55) * (1 - wetMix * 0.45),
      r, g, b,
      (0.165 + drive * 0.235) * (1 - wetMix * 0.25),
      surf.turb * (0.8 + drive * 0.7), surf.drag,
      surf.buoyancy + wetMix * -0.25, surf.glow + wetMix * 0.35,
      cp.y, (Math.random() - 0.5) * (1.6 + drive * 3.2)
    );
    void st;
    void w;
  }

  _sprayPuff(st, cp, vel, travel, drive, rear) {
    // A rooster tail: fast, backwards, low, short-lived and bright — lit water, not smoke.
    const back = -0.30 - drive * 0.12;
    const spread = 1.0 + travel * 0.055;
    this.smoke.spawn(
      cp.x + (Math.random() - 0.5) * 0.3,
      cp.y + 0.04 + Math.random() * 0.12,
      cp.z + (Math.random() - 0.5) * 0.3,
      vel.x * back + (Math.random() - 0.5) * spread,
      0.6 + Math.random() * (1.1 + rear * 1.1),
      vel.z * back + (Math.random() - 0.5) * spread,
      0.13, (0.72 + rear * 0.72) * (0.7 + drive * 0.8), 0.5 + Math.random() * 0.42,
      0.90, 0.93, 0.98,
      0.075 + drive * 0.105,
      0.30, 2.4, -0.30, 0.38, cp.y, (Math.random() - 0.5) * 5
    );
    void st;
  }

  _rainSplashes(dt, intensity) {
    // Impact splashes on the road just around the camera — the cue that the rain is *hitting*
    // something rather than passing through the world.
    const ctx = this.ctx;
    const cam = ctx.camera.position;
    const budget = 34 * intensity * (ctx.settings.get('particleBudget') >= 3000 ? 1 : 0.4);
    this._splashAcc = (this._splashAcc || 0) + budget * dt;
    let n = Math.min(this._splashAcc | 0, 8);
    this._splashAcc -= n;
    _fwd.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion).setY(0);
    if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
    _fwd.normalize();
    while (n-- > 0) {
      const rad = 3 + Math.random() * 16;
      const ang = Math.random() * 6.2831853;
      const x = cam.x + _fwd.x * rad * 0.6 + Math.cos(ang) * rad * 0.7;
      const z = cam.z + _fwd.z * rad * 0.6 + Math.sin(ang) * rad * 0.7;
      const gy = this._groundY(x, z, 0);
      this.smoke.spawn(
        x, gy + 0.015, z,
        (Math.random() - 0.5) * 0.35, 0.35 + Math.random() * 0.5, (Math.random() - 0.5) * 0.35,
        0.02, 0.11 + Math.random() * 0.09, 0.16 + Math.random() * 0.10,
        0.86, 0.90, 0.96, 0.26,
        0.03, 4.5, -1.6, 0.85, gy, 0
      );
    }
  }

  _updateExhaust(car, st, cs, dt, detail, isPlayer) {
    const ports = car.exhausts;
    if (!ports?.length) return;
    const nosPorts = car.nosPorts || ports;
    const carV = st.velocity;
    const load = clamp01(st.engineLoad ?? 0);
    const nos = !!st.nosActive || cs.nos;

    // ---- NOS jets ----
    if (nos) {
      cs.nosAcc += dt * 150 * detail;
      for (let i = 0; i < nosPorts.length; i++) {
        const port = nosPorts[i];
        this.jets.drive(`nos${car.id ?? ''}${i}`, port, 1, 'nos');
        port.getWorldPosition(_p);
        port.getWorldQuaternion(_q);
        _back.set(0, 0, 1).applyQuaternion(_q);
        const gy = this._groundY(_p.x, _p.z, _p.y);

        let budget = 5;
        while (cs.nosAcc >= 1 && budget-- > 0) {
          cs.nosAcc -= 1;
          const jet = 16 + Math.random() * 16;
          this.hot.spawn(
            _p.x, _p.y, _p.z,
            carV.x + _back.x * jet + (Math.random() - 0.5) * 2.0,
            carV.y + _back.y * jet * 0.3 + (Math.random() - 0.5) * 1.2,
            carV.z + _back.z * jet + (Math.random() - 0.5) * 2.0,
            0.08 + Math.random() * 0.10, 0.055 + Math.random() * 0.04, 0.008,
            0.42, 0.68, 1.0,
            0.9, gy, 3.0, 0.6, 0, 0, 1.4, 1.0
          );
        }
        if (cs.nosAcc > 4) cs.nosAcc = 4;

        if (isPlayer && Math.random() < dt * 26) {
          this.haze.spawn(
            _p.x + _back.x * 0.5, _p.y, _p.z + _back.z * 0.5,
            carV.x + _back.x * 9, carV.y + 0.4, carV.z + _back.z * 9,
            0.28, 0.26, 0.85, 0.55
          );
        }
        if (Math.random() < dt * 14) this.flash(_p, 0x7fb8ff, 16, 9, 0.09);
      }
    } else {
      cs.nosAcc = 0;
    }
    cs.wasNos = nos;

    // ---- part-throttle exhaust haze + idle smoke ----
    if (detail > 0.5) {
      cs.exhaustAcc += dt * (2.2 + load * 7.5) * detail;
      while (cs.exhaustAcc >= 1) {
        cs.exhaustAcc -= 1;
        this._exhaustPuff(car, 0.25 + load * 0.5);
      }
      if (isPlayer && load > 0.35 && Math.random() < dt * (4 + load * 12)) {
        const port = ports[(Math.random() * ports.length) | 0];
        port.getWorldPosition(_p);
        port.getWorldQuaternion(_q);
        _back.set(0, 0, 1).applyQuaternion(_q);
        this.haze.spawn(
          _p.x + _back.x * 0.25, _p.y, _p.z + _back.z * 0.25,
          carV.x + _back.x * 3.5, carV.y + 0.5, carV.z + _back.z * 3.5,
          0.5, 0.20, 0.80, 0.16 + load * 0.24
        );
      }
    }
  }

  // ------------------------------------------------------------------ late / quality / resize
  lateUpdate() {
    // Runs after physics + camera, before PostFxSystem.render(). Never touches the framebuffer.
    // The pre-pass only earns its keep when something actually needs a soft edge, so on a clean
    // lap with no smoke, spray or rain on screen we skip the whole extra scene traversal.
    const now = this.ctx.time.elapsed;
    const needed =
      now < this.smoke.aliveUntil ||
      this.rain.intensity > 0.001 ||
      this.hot.count > 0 ||
      this.cool.count > 0 ||
      this.haze.count > 0;
    if (!needed) return;
    this.depth.render(this._excludeRoots);
  }

  onQuality(tier) {
    const settings = this.ctx.settings;
    tier = tier || settings.tier || 'high';
    const t = TIER[tier] ?? TIER.high;
    if (this._tier === tier) return;
    this._tier = tier;
    const P = settings.get('particleBudget') ?? 3000;

    this.smoke?.setCapacity(Math.round(P * BUDGET_SPLIT.smoke));
    this.hot?.setCapacity(Math.round(P * BUDGET_SPLIT.hot));
    this.cool?.setCapacity(Math.round(P * BUDGET_SPLIT.cool));
    this.rain?.setCapacity(Math.round(P * BUDGET_SPLIT.rain));
    this.skids?.setCapacity(t.skid);
    this.flashes?.setCapacity(t.flashes);
    this.jets?.setCapacity(t.jets);
    if (this.haze) {
      this.haze.enabled = t.haze > 0;
      this.haze.setCapacity(Math.max(t.haze, 8));
    }
    this.grab.enabled = t.haze > 0;
    this.depth.setEnabled(t.soft);
    if (t.soft) {
      this.depth.setScale(t.depthScale);
      this.depth.interval = t.depthInterval || 1;
    }
    this.stats.peak = 0;
  }

  onResize(w, h) {
    this.depth.onResize();
    this.grab.onResize();
    this.overlay?.onResize(w, h);
  }

  dispose() {
    for (const u of this._unsubs) {
      try {
        u?.();
      } catch {
        /* ignore */
      }
    }
    this._unsubs.length = 0;
    this.smoke?.dispose();
    this.hot?.dispose();
    this.cool?.dispose();
    this.rain?.dispose();
    this.skids?.dispose();
    this.haze?.dispose();
    this.jets?.dispose();
    this.flashes?.dispose();
    this.overlay?.dispose();
    this.grab?.dispose();
    this.depth?.dispose();
    this.ctx.scene.remove(this.root);
    disposeVfxTextures();
    this.cars.clear();
  }
}

// ------------------------------------------------------------------ module scratch (no per-frame alloc)
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _r = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _back = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _EMPTY = {};
const _GREY = [0.80, 0.80, 0.82];
const _DEBRIS = [0.22, 0.21, 0.21];
