import * as THREE from 'three';
import { makeRng, clamp01 } from '../../core/MathX.js';
import { CityTextures } from './CityTextures.js';
import { CityMaterials } from './CityMaterials.js';
import { BuildingFactory } from './BuildingFactory.js';
import { CityLayout, GlowBuilder } from './CityLayout.js';
import { buildApron } from './CityGround.js';
import { buildTunnel } from './Tunnel.js';
import { buildSkyline, buildGroundHaze } from './Skyline.js';
import { buildDistrictFill, PLAZA } from './DistrictFill.js';
import { LightPool } from './LightPool.js';

/**
 * Everything that surrounds the circuit: buildings, street furniture, signage, vegetation, the
 * underpass and the far skyline. Owned by the CITY lane (CONTRACTS.md §16); reads `ctx.world.track`,
 * `ctx.env` and `ctx.settings` and never writes outside `src/world/city/`.
 *
 * Budget strategy
 * ---------------
 * - One InstancedMesh per building archetype per sector — a sector of ~20 buildings is 4-7 draws.
 * - Street furniture, signage and ground cover are merged per sector: 1 draw each.
 * - Beyond the LOD radius a sector collapses to a single merged box mesh with a procedural
 *   window grid: 1 draw, ~1.5k triangles.
 * - Beyond the draw distance a sector is hidden outright.
 * - 0-12 pooled point lights follow the camera; nothing else in the city emits real light.
 */
const _WHITE = new THREE.Color(1, 1, 1);

export class CitySystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.sectors = [];
    this.lights = [];
    this.rng = makeRng(0x0c17ba5e);
    this._night = 0;
    this._acc = 0;
    this._camPos = new THREE.Vector3();
    this.stats = { archetypes: 0, buildings: 0, sectorTris: 0, fixtures: 0 };
  }

  async init() {
    const { scene, settings } = this.ctx;
    const track = this.ctx.world?.track;
    this.root = new THREE.Group();
    this.root.name = 'City';
    this.root.matrixAutoUpdate = false;
    scene.add(this.root);
    if (!track) {
      console.warn('[city] no ctx.world.track — city skipped');
      return this;
    }

    const density = settings?.get('cityDensity') ?? 1;
    const vegetation = settings?.get('vegetation') ?? 1;

    // ---- textures & materials
    this.textures = new CityTextures(this.ctx).build();
    this.mats = new CityMaterials(this.ctx, this.textures);

    // ---- archetypes
    const factory = new BuildingFactory(makeRng(0x5b1d9c));
    const archetypes = factory.build();
    this.archetypes = archetypes;
    this.stats.archetypes = archetypes.length;

    // ---- layout
    this.layout = new CityLayout(this.ctx, {
      track,
      archetypes,
      materials: this.mats,
      rng: makeRng(0x1a7c33),
      density,
      vegetation,
      plaza: PLAZA,
    });
    const sectors = this.layout.build();
    this.sectors = sectors;

    this.nearRoot = new THREE.Group();
    this.nearRoot.name = 'CityNear';
    this.nearRoot.matrixAutoUpdate = false;
    this.farRoot = new THREE.Group();
    this.farRoot.name = 'CityFar';
    this.farRoot.matrixAutoUpdate = false;
    this.glowRoot = new THREE.Group();
    this.glowRoot.name = 'CityGlow';
    this.glowRoot.matrixAutoUpdate = false;
    this.root.add(this.nearRoot, this.farRoot, this.glowRoot);

    for (const s of sectors) {
      s.near.visible = false;
      this.nearRoot.add(s.near);
      if (s.far) {
        s.far.visible = false;
        this.farRoot.add(s.far);
      }
      if (s.glow) {
        s.glow.visible = false;
        this.glowRoot.add(s.glow);
      }
      s.near.traverse((o) => {
        if (o.isMesh) this.stats.buildings += o.isInstancedMesh ? o.count : 0;
      });
    }

    // ---- ground apron
    const staticRoot = new THREE.Group();
    staticRoot.name = 'CityStatic';
    staticRoot.matrixAutoUpdate = false;
    this.root.add(staticRoot);
    for (const g of buildApron(track, this.layout, 10, this.ctx.world)) {
      const m = new THREE.Mesh(g, this.mats.surface);
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      staticRoot.add(m);
    }

    // ---- tunnel
    const tunnel = buildTunnel(track);
    this.tunnel = tunnel;
    this.tunnelRoot = new THREE.Group();
    this.tunnelRoot.matrixAutoUpdate = false;
    for (const g of tunnel.meshes) {
      const m = new THREE.Mesh(g, this.mats.surface);
      m.castShadow = false;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      this.tunnelRoot.add(m);
    }
    this.root.add(this.tunnelRoot);

    // tunnel glows go into their own always-on mesh
    if (tunnel.glows.length) {
      const gb = new GlowBuilder();
      for (const g of tunnel.glows) gb.add(g.x, g.y, g.z, g.size, g.color);
      this.tunnelGlow = new THREE.Mesh(gb.geometry(), this.mats.glow);
      this.tunnelGlow.matrixAutoUpdate = false;
      this.tunnelGlow.renderOrder = 8;
      this.root.add(this.tunnelGlow);
    }

    // ---- background district fill (infield + outfield out to the skyline)
    const fill = buildDistrictFill(track, makeRng(0x2ef411), {}, this.ctx.world);
    for (const g of fill.geos) {
      const m = new THREE.Mesh(g, this.mats.surface);
      m.matrixAutoUpdate = false;
      m.castShadow = false;
      m.receiveShadow = false;
      staticRoot.add(m);
    }
    this.stats.fillBlocks = fill.placed;

    // ---- far skyline + haze ring
    const centre = new THREE.Vector3(
      (track.bounds.min.x + track.bounds.max.x) * 0.5,
      0,
      (track.bounds.min.z + track.bounds.max.z) * 0.5
    );
    const halfSpan = Math.max(
      track.bounds.max.x - track.bounds.min.x,
      track.bounds.max.z - track.bounds.min.z
    ) * 0.5;
    const skyInner = halfSpan + 560;
    this.skylineRoot = new THREE.Group();
    this.skylineRoot.matrixAutoUpdate = false;
    for (const g of buildSkyline(makeRng(0x77c1a2), centre, skyInner, skyInner + 2400)) {
      const m = new THREE.Mesh(g, this.mats.surface);
      m.matrixAutoUpdate = false;
      m.castShadow = false;
      m.receiveShadow = false;
      this.skylineRoot.add(m);
    }
    const haze = new THREE.Mesh(buildGroundHaze(centre, skyInner + 2600, skyInner - 140), this.mats.surface);
    haze.matrixAutoUpdate = false;
    haze.receiveShadow = false;
    this.skylineRoot.add(haze);
    this.root.add(this.skylineRoot);

    // ---- light pool
    this.pool = new LightPool(scene, this._poolSize(settings?.tier));
    for (const f of this.layout.fixtures) this.pool.add(f);
    for (const f of tunnel.fixtures) this.pool.add(f);
    this.stats.fixtures = this.pool.fixtures.length;
    this.lights = this.pool.lights.map((l) => l.light);

    let tris = 0;
    this.root.traverse((o) => {
      if (o.isMesh && o.geometry?.index) tris += (o.geometry.index.count / 3) * (o.isInstancedMesh ? o.count : 1);
    });
    this.stats.sectorTris = Math.round(tris);
    console.info(
      `[city] ${this.stats.archetypes} archetypes, ${this.stats.buildings} buildings, ` +
        `${this.stats.fixtures} fixtures, ${this.stats.fillBlocks} fill blocks, ${(tris / 1000) | 0}k tris authored`
    );

    this._applyEnv(true);
    return this;
  }

  _poolSize(tier) {
    return { low: 2, medium: 5, high: 8, ultra: 12 }[tier] ?? 8;
  }

  /** Night factor. Lights come on through dusk, not at midnight. */
  _nightFactor() {
    const env = this.ctx.env;
    const h = env?.timeOfDay ?? 18;
    const evening = clamp01((h - 17.2) / 2.4);
    const morning = clamp01((7.6 - h) / 2.0);
    let n = Math.max(evening, morning);
    const p = env?.preset;
    if (p === 'stormy') n = Math.max(n, 0.45);
    else if (p === 'overcast') n = Math.max(n, 0.22);
    return n;
  }

  _applyEnv(force = false) {
    const env = this.ctx.env;
    const night = this._nightFactor();
    this._night = force ? night : this._night + (night - this._night) * 0.25;
    // The foliage shader needs the key light itself to do transmission (see CityMaterials).
    // Guarded per CONTRACTS.md §16: if the env lane has not populated these yet, the material
    // keeps its defaults rather than throwing.
    const sun = env?.sunDirection
      ? {
          dir: env.sunDirection,
          color: env.sunLight?.color ?? _WHITE,
          // Moonlight is the key at night; without it a backlit canopy is pure black.
          intensity: Math.min(6, (env.sunLight?.intensity ?? 0) + (env.moonLight?.intensity ?? 0) * 0.8) * 0.20,
        }
      : null;
    const sky = env?.hemi ? { color: env.hemi.color, intensity: Math.min(2.5, env.hemi.intensity) } : null;
    this.mats.setFrame({
      time: this.ctx.time?.elapsed ?? 0,
      night: this._night,
      litFrac: 0.2 + this._night * 0.32,
      wet: env?.wetness ?? 0,
      emissive: 1,
      wind: 0.6 + (env?.rainIntensity ?? 0) * 1.3,
      glow: 1,
      tunnelFill: 0.26,
      sun,
      sky,
    });
    if (env?.envMap) this.mats.setEnvMap(env.envMap);
  }

  update(dt, ctx) {
    if (!this.sectors.length) return;
    const cam = ctx.camera;
    this._camPos.copy(cam.position);
    this._applyEnv();

    const settings = ctx.settings;
    const drawDistance = settings?.get('drawDistance') ?? 1600;
    const nearDist = Math.min(520, drawDistance * 0.34);
    const glowDist = Math.min(drawDistance, 620);

    // sector LOD — cheap enough to do every frame (34 distance tests)
    let nearCount = 0;
    const maxNear = { low: 4, medium: 7, high: 10, ultra: 14 }[settings?.tier] ?? 10;
    const ordered = this._order || (this._order = this.sectors.slice());
    for (const s of ordered) s._d = Math.hypot(s.centre.x - cam.position.x, s.centre.z - cam.position.z) - s.radius * 0.55;
    ordered.sort((a, b) => a._d - b._d);

    for (const s of ordered) {
      const d = s._d;
      let want;
      if (d > drawDistance) want = 0; // hidden
      else if (d > nearDist || nearCount >= maxNear) want = 1; // merged LOD box
      else {
        want = 2;
        nearCount++;
      }
      if (want !== s.state) {
        s.state = want;
        s.near.visible = want === 2;
      }
      // Halos are a night-only effect; hiding them in daylight is 34 free draw calls. They are
      // also a *near-field* effect: a 3 m sprite 900 m away lands inside one pixel and is
      // swallowed by the fog, so capping them well inside the draw distance buys back another
      // handful of draws per frame for nothing visible.
      if (s.glow) s.glow.visible = want >= 1 && this._night > 0.04 && d < glowDist;
    }

    this._shadowCasters(ordered, settings);
    this._cameraPocket(ordered, cam);
    this.pool?.update(dt, this._camPos, { night: this._night, radius: 110 });
  }

  /**
   * Shadow-caster policy.
   *
   * The sun shadow is a cascaded second (third, fourth…) render of everything with
   * `castShadow`, so a detailed facade costs its full vertex load once per cascade. Nothing in
   * the city casts its detail geometry. Instead every sector already carries a merged
   * low-poly silhouette mesh (the LOD box mesh, ~1.5k triangles for ~20 buildings) and *that*
   * is the only caster:
   *
   *  - sector is FAR  -> the silhouette mesh is what you see; it also casts.
   *  - sector is NEAR -> the detailed instances are what you see, and the silhouette mesh is
   *                      re-materialled to `shadowOnly` (colorWrite/depthWrite off). It costs
   *                      one no-op draw in the beauty pass and remains the shadow caster.
   *                      The shadow map never sees the material anyway — three renders casters
   *                      with its own depth material — so the silhouette is what gets rasterised.
   *  - street furniture, signage, vegetation, glows, the district fill and the skyline never
   *    cast at all.
   *
   * Result: N merged casters instead of hundreds of instanced facades, where N is 2/4/6/8 by
   * tier. Everything still receives shadows normally.
   */
  _shadowCasters(ordered, settings) {
    const K = { low: 2, medium: 4, high: 6, ultra: 8 }[settings?.tier] ?? 6;
    let casters = 0;
    let casterTris = 0;
    for (let i = 0; i < ordered.length; i++) {
      const s = ordered[i];
      const proxy = s.far;
      if (!proxy) continue;
      const alive = s.state !== 0;
      const cast = alive && i < K;
      // When the sector is NEAR, the silhouette is `shadowOnly` — no colour, no depth. If it is
      // not also a shadow caster it is a completely empty draw call, so drop it outright.
      const needed = alive && (s.state === 1 || cast);
      if (proxy.visible !== needed) proxy.visible = needed;
      const wantMat = s.state === 2 ? this.mats.shadowOnly : this.mats.surface;
      if (proxy.material !== wantMat) proxy.material = wantMat;
      if (proxy.castShadow !== cast) proxy.castShadow = cast;
      if (cast) {
        casters++;
        casterTris += proxy.geometry.index.count / 3;
      }
    }
    // The tunnel has to occlude the sun or daylight pours through the ceiling onto the
    // carriageway. It is five merged meshes and only casts when you are near it.
    if (this.tunnelRoot) {
      const t = this.tunnel?.frames?.[0]?.p;
      const near = t ? Math.hypot(t.x - this._camPos.x, t.z - this._camPos.z) < 700 : false;
      for (const m of this.tunnelRoot.children) {
        if (m.castShadow !== near) m.castShadow = near;
        if (near) {
          casters++;
          casterTris += (m.geometry.index?.count ?? 0) / 3;
        }
      }
    }
    this.stats.shadowCasters = casters;
    this.stats.shadowTris = Math.round(casterTris);
    this.ctx.debug?.log?.('cityShadowCasters', casters);
    this.ctx.debug?.log?.('cityShadowTris', Math.round(casterTris));
  }

  /**
   * Photo / orbit / cinematic poses are authored relative to the car, so they routinely end up
   * *inside* a building — you get a black frame full of interior back-faces. Collapse any
   * instance whose bounds swallow the camera (nearest sectors only, ~40 AABB tests) and restore
   * it as soon as the camera leaves. Chase and bumper cameras never trigger this.
   */
  _cameraPocket(ordered, cam) {
    const p = cam.position;
    const M = 3.0;
    const touched = this._pocketTouched || (this._pocketTouched = new Set());
    const nowHidden = new Set();

    {
      for (let s = 0; s < Math.min(8, ordered.length); s++) {
        const sec = ordered[s];
        if (sec.state !== 2 || !sec.boxes) continue;
        for (const b of sec.boxes) {
          if (
            p.x > b.min.x - M && p.x < b.max.x + M &&
            p.z > b.min.z - M && p.z < b.max.z + M &&
            p.y > b.min.y - M && p.y < b.max.y + M
          ) {
            nowHidden.add(b);
            const im = b.im;
            if (!im.userData.hidden.has(b.i)) {
              im.userData.hidden.add(b.i);
              const a = im.instanceMatrix.array;
              const o = b.i * 16;
              for (let k = 0; k < 12; k++) a[o + k] = 0;
              im.instanceMatrix.needsUpdate = true;
              touched.add(im);
            }
          }
        }
      }
    }
    // restore anything no longer occluding
    if (touched.size) {
      for (const im of touched) {
        if (!im.userData.hidden.size) continue;
        let changed = false;
        for (const i of Array.from(im.userData.hidden)) {
          let still = false;
          for (const b of nowHidden) if (b.im === im && b.i === i) still = true;
          if (still) continue;
          im.userData.hidden.delete(i);
          const a = im.instanceMatrix.array;
          const base = im.userData.base;
          for (let k = 0; k < 16; k++) a[i * 16 + k] = base[i * 16 + k];
          changed = true;
        }
        if (changed) im.instanceMatrix.needsUpdate = true;
      }
      if (!nowHidden.size) touched.clear();
    }
  }

  onQuality(tier) {
    this.pool?.setCount(this._poolSize(tier));
    this.lights = this.pool ? this.pool.lights.map((l) => l.light) : [];
    for (const s of this.sectors) s.state = -1;
  }

  dispose() {
    this.pool?.dispose();
    this.root?.traverse((o) => o.geometry?.dispose?.());
    for (const a of this.archetypes || []) a.geometry?.dispose?.();
    this.mats?.dispose();
    this.textures?.dispose();
    this.root?.removeFromParent();
  }
}
