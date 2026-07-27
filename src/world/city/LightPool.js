import * as THREE from 'three';

/**
 * A fixed pool of THREE.PointLights that chase the camera.
 *
 * The city registers thousands of emissive fixtures; only a handful can be real lights. The
 * pool size never changes at runtime (changing the light count forces every material in the
 * scene to recompile), so lights are recycled: each frame the nearest unclaimed fixtures win,
 * and hand-overs cross-fade over ~0.3 s so nothing pops.
 *
 * Fixtures live in a uniform spatial hash, so "nearest 8 of 4000" is a few dozen distance
 * tests, not a full sort.
 */
const CELL = 40;

export class LightPool {
  constructor(scene, count = 8) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'CityLights';
    scene.add(this.group);
    this.fixtures = [];
    this.grid = new Map();
    this.lights = [];
    this.count = 0;
    this.setCount(count);
    this._acc = 0;
    this._cand = [];
  }

  setCount(n) {
    n = Math.max(0, n | 0);
    while (this.lights.length < n) {
      const l = new THREE.PointLight(0xffffff, 0, 30, 2);
      l.castShadow = false;
      l.visible = false;
      this.group.add(l);
      this.lights.push({ light: l, fixture: null, fade: 0, want: 0 });
    }
    while (this.lights.length > n) {
      const e = this.lights.pop();
      e.light.removeFromParent();
      e.light.dispose?.();
    }
    this.count = n;
  }

  /** @param f { x,y,z, color, intensity, dist } — world space */
  add(f) {
    const i = this.fixtures.length;
    this.fixtures.push(f);
    const k = this._key(f.x, f.z);
    let arr = this.grid.get(k);
    if (!arr) this.grid.set(k, (arr = []));
    arr.push(i);
    return i;
  }

  _key(x, z) {
    return `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  }

  /** Nearest candidates within `radius` of (x,z). */
  _gather(x, z, radius) {
    const out = this._cand;
    out.length = 0;
    const cr = Math.ceil(radius / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const r2 = radius * radius;
    for (let dz = -cr; dz <= cr; dz++) {
      for (let dx = -cr; dx <= cr; dx++) {
        const arr = this.grid.get(`${cx + dx},${cz + dz}`);
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const f = this.fixtures[arr[i]];
          const d = (f.x - x) * (f.x - x) + (f.z - z) * (f.z - z);
          if (d < r2) out.push({ f, d });
        }
      }
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  update(dt, camPos, { night = 1, radius = 95, gain = 1 } = {}) {
    if (!this.count) return;
    this._acc += dt;
    const rate = Math.min(1, dt * 4.2);

    if (this._acc > 0.12) {
      this._acc = 0;
      const cand = this._gather(camPos.x, camPos.z, radius);
      const claimed = new Set();
      // keep lights that are still among the best candidates
      const bestN = Math.min(this.count, cand.length);
      const bestSet = new Set();
      for (let i = 0; i < bestN; i++) bestSet.add(cand[i].f);
      for (const e of this.lights) {
        if (e.fixture && bestSet.has(e.fixture)) {
          claimed.add(e.fixture);
          e.want = 1;
        } else {
          e.want = 0;
        }
      }
      // hand faded-out lights to the best unclaimed candidates
      for (const e of this.lights) {
        if (e.want === 1 || e.fade > 0.02) continue;
        for (let i = 0; i < bestN; i++) {
          const f = cand[i].f;
          if (claimed.has(f)) continue;
          claimed.add(f);
          e.fixture = f;
          e.want = 1;
          e.light.color.setHex(f.color);
          e.light.distance = f.dist ?? 30;
          e.light.position.set(f.x, f.y, f.z);
          break;
        }
      }
    }

    for (const e of this.lights) {
      e.fade += (e.want - e.fade) * rate;
      const f = e.fixture;
      if (!f) {
        e.light.visible = false;
        continue;
      }
      const nightGain = f.tunnel ? 1 : 0.12 + night * 0.88;
      const power = (f.intensity ?? 12) * e.fade * nightGain * gain;
      e.light.intensity = power;
      e.light.visible = power > 0.03;
      if (e.want === 1) e.light.position.set(f.x, f.y, f.z);
    }
  }

  dispose() {
    for (const e of this.lights) {
      e.light.removeFromParent();
      e.light.dispose?.();
    }
    this.lights.length = 0;
    this.group.removeFromParent();
  }
}
