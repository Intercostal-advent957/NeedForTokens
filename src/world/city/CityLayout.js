import * as THREE from 'three';
import { GeoBuilder, KIND, col, tint } from './Geo.js';
import { PROPS, catenary, utilityPole } from './PropFactory.js';
import { placeSign, billboard } from './Signage.js';
import { GroundCover, treeGeometry, TREE_SPECIES } from './Vegetation.js';
import { terrainMeshY } from './CityGround.js';
import { TUNNEL_T0, TUNNEL_T1 } from './Tunnel.js';

/**
 * Turns the circuit into a city.
 *
 * The loop is cut into arc sectors; each sector owns its buildings (InstancedMesh per archetype),
 * one merged street-furniture mesh, one merged signage mesh, one merged ground-cover mesh, two
 * instanced tree meshes and one additive glow mesh — about 10 draw calls for a whole block, and
 * exactly 1 when the sector falls back to its merged LOD box mesh.
 *
 * Placement rules: nothing within 20 m of any part of the centreline (the loop passes close to
 * itself in two places, so this is a real constraint), nothing overlapping an already-placed
 * footprint, and nothing inside the tunnel corridor.
 */

const SECTORS = 34;
const CELL = 9; // occupancy grid
/** Which two of the five tree species each sector plants. Coprime-ish with SECTORS on purpose. */
const TREE_PAIRS = [[0, 1], [2, 3], [4, 0], [1, 2], [3, 4], [0, 2], [1, 4], [2, 0], [3, 1], [4, 3], [0, 4]];
const TUNNEL_RAMP = 0.011;

const DISTRICTS = [
  { name: 'downtown', weights: { glassTower: 4, officeBlock: 4, midrise: 3, retail: 2, apartmentSlab: 2, parking: 1, brickWalkup: 1, warehouse: 0 }, lamp: 26, trees: 0.9, signs: 1.0 },
  { name: 'strip', weights: { retail: 5, midrise: 3, brickWalkup: 3, parking: 2, warehouse: 1, officeBlock: 1, apartmentSlab: 1, glassTower: 0 }, lamp: 30, trees: 1.2, signs: 1.3 },
  { name: 'industrial', weights: { warehouse: 6, parking: 2, midrise: 1, retail: 1, officeBlock: 1, brickWalkup: 0, apartmentSlab: 0, glassTower: 0 }, lamp: 40, trees: 0.35, signs: 0.5 },
  { name: 'residential', weights: { apartmentSlab: 4, brickWalkup: 5, midrise: 3, retail: 2, parking: 1, officeBlock: 0, warehouse: 0, glassTower: 0 }, lamp: 32, trees: 1.6, signs: 0.6 },
];

/**
 * Where the pavement top sits above the centreline plane. Must match CityGround's KERB_TOP or
 * lamp posts stand on air and bins sink into the flags.
 */
const PAVE_Y = 0.145;
const PAVE_REACH = 4.6; // lateral from `at().lat` at which the pavement ends
const FOOT_N = 5; // ground samples per axis across a footprint
const MAX_FALL = 6.0; // reject a plot whose ground varies more than this across the footprint

export class CityLayout {
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.world = ctx.world;
    this.track = opts.track;
    this.archetypes = opts.archetypes;
    this.mats = opts.materials;
    this.rng = opts.rng;
    this.density = opts.density ?? 1;
    this.vegetation = opts.vegetation ?? 1;
    this.plaza = opts.plaza || [];
    this.sectors = [];
    this.fixtures = [];
    this.occupancy = new Set();
    this._rects = new Map();
    this._byStyle = new Map();
    for (let i = 0; i < this.archetypes.length; i++) {
      const s = this.archetypes[i].style;
      if (!this._byStyle.has(s)) this._byStyle.set(s, []);
      this._byStyle.get(s).push(i);
    }
    /**
     * Five species, but still only TWO InstancedMeshes per sector — see TREE_PAIRS. Widening
     * the library costs five small geometries; widening the per-sector mesh count would cost
     * 34 extra draw calls, and the city lane is already the biggest consumer of the budget
     * (CONTRACTS.md §0: < 900 draws).
     */
    this.treeGeos = TREE_SPECIES.map((_, i) => treeGeometry(this.rng, i));
  }

  // ------------------------------------------------------------------ helpers
  _occupied(x, z, r) {
    const c = Math.ceil(r / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let dz = -c; dz <= c; dz++)
      for (let dx = -c; dx <= c; dx++) if (this.occupancy.has((cx + dx) * 65536 + (cz + dz))) return true;
    return false;
  }
  _occupy(x, z, r) {
    const c = Math.ceil(r / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let dz = -c; dz <= c; dz++)
      for (let dx = -c; dx <= c; dx++) this.occupancy.add((cx + dx) * 65536 + (cz + dz));
  }

  _pickArchetype(district) {
    const w = district.weights;
    let total = 0;
    for (const k in w) total += w[k] * (this._byStyle.get(k)?.length ? 1 : 0);
    let r = this.rng() * total;
    for (const k in w) {
      const list = this._byStyle.get(k);
      if (!list || !list.length) continue;
      r -= w[k];
      if (r <= 0) return list[this.rng.int(0, list.length - 1)];
    }
    return this.rng.int(0, this.archetypes.length - 1);
  }

  /**
   * Ground height at a world XZ, from the track lane's height field. Everything the city stands
   * on goes through here: buildings, plinths, street furniture, trees. Guarded so a missing
   * WorldSystem degrades to the old road-relative behaviour rather than throwing.
   */
  groundY(x, z, fallback) {
    const g = this.world?.sampleGround?.(x, z);
    let h = g && Number.isFinite(g.height) ? g.height : null;
    const t = terrainMeshY(this.world, x, z);
    if (t !== null && (h === null || t > h)) h = t;
    return h === null ? fallback : h;
  }

  /**
   * The archetype's *ground-contacting* plan rectangle in local metres, cached per archetype.
   * Deliberately the geometry bounding box and not `A.w/A.d`: a warehouse's loading dock sticks
   * out 6 m past the nominal footprint, and it is exactly that overhang the aerial catches
   * hanging in mid-air.
   */
  _rectOf(A) {
    let r = this._rects.get(A);
    if (!r) {
      const bb = A.geometry.boundingBox;
      r = { x0: bb.min.x, x1: bb.max.x, z0: bb.min.z, z1: bb.max.z };
      this._rects.set(A, r);
    }
    return r;
  }

  /**
   * Seat a footprint on the terrain.
   *
   * Samples a grid over the plan rectangle and returns the base height plus the plinth extent.
   * The base sits a fraction of the way up the fall rather than on the minimum, so a building
   * on a slope cuts into the uphill side and gains a podium on the downhill side — which is
   * what a real one does. `bottom` is below every sample, so there is never daylight beneath.
   */
  _seat(px, pz, rect, scl, yaw, fallback) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    let min = Infinity;
    let max = -Infinity;
    for (let j = 0; j < FOOT_N; j++) {
      const lz = (rect.z0 + ((rect.z1 - rect.z0) * j) / (FOOT_N - 1)) * scl;
      for (let i = 0; i < FOOT_N; i++) {
        const lx = (rect.x0 + ((rect.x1 - rect.x0) * i) / (FOOT_N - 1)) * scl;
        const h = this.groundY(px + lx * c + lz * s, pz - lx * s + lz * c, fallback);
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    const fall = max - min;
    const seat = min + Math.min(1.6, fall * 0.42);
    // The plinth foot clears the lowest sample by a margin that grows with the fall, because
    // the ground between samples can dip further on rough terrain than it does at them.
    return { base: seat - 0.3, bottom: min - Math.max(1.0, fall * 0.45), top: seat, fall };
  }

  /** Blend factor for the tunnel corridor: 1 inside, ramping out over TUNNEL_RAMP. */
  tunnelBlend(t) {
    const d0 = shortest(t, TUNNEL_T0);
    const d1 = shortest(t, TUNNEL_T1);
    if (t > TUNNEL_T0 && t < TUNNEL_T1) return 1;
    const near = Math.min(Math.abs(d0), Math.abs(d1));
    return Math.max(0, 1 - near / TUNNEL_RAMP);
  }

  // ------------------------------------------------------------------ build
  build() {
    const track = this.track;
    this.deckY = -Infinity;
    for (let i = 0; i <= 40; i++) {
      const t = TUNNEL_T0 + ((TUNNEL_T1 - TUNNEL_T0) * i) / 40;
      this.deckY = Math.max(this.deckY, track.pointAt(t).y);
    }
    this.deckY += 10.2;

    for (let s = 0; s < SECTORS; s++) this.sectors.push(this._buildSector(s));
    return this.sectors;
  }

  _buildSector(index) {
    const R = this.rng;
    const track = this.track;
    const t0 = index / SECTORS;
    const t1 = (index + 1) / SECTORS;
    const district = DISTRICTS[districtFor(index)];

    const surf = new GeoBuilder(); // street furniture + sign frames
    const sign = new GeoBuilder(); // sign faces (atlas UVs)
    const glow = new GlowBuilder();
    const cover = new GroundCover();
    const far = new GeoBuilder();
    const placements = new Map(); // archetype index -> { m:[], c:[] }
    const trees = [[], []];
    const fixtures = [];
    const out = { fixtures, glows: [] };

    const arcLen = (t1 - t0) * track.length;
    const centre = track.pointAt((t0 + t1) * 0.5);
    let maxR = arcLen * 0.6 + 40;

    // ---------------------------------------------------------- buildings
    const rows = this.density > 0.85 ? 3 : this.density > 0.55 ? 2 : 1;
    for (const side of [-1, 1]) {
      for (let row = 0; row < rows; row++) {
        const baseLat = [24, 62, 112][row] + R.range(-3, 8);
        let s = R.range(0, 18);
        let guard = 0;
        while (s < arcLen && guard++ < 60) {
          const t = t0 + (s / track.length);
          const tb = this.tunnelBlend(t);
          const ai = this._pickArchetype(district);
          const A = this.archetypes[ai];
          const step = Math.max(A.w, 12) + R.range(5, 16) * (row === 0 ? 1 : 1.35);

          // tunnel corridor: only rows 1+ survive, and they sit on the deck
          if (tb > 0.4 && row === 0) {
            s += step;
            continue;
          }

          const lat = baseLat + R.range(-4, 6) + (row === 0 ? 0 : R.range(0, 22));
          const f = track.frameAt(t);
          const px = f.position.x + f.binormal.x * side * lat;
          const pz = f.position.z + f.binormal.z * side * lat;
          const radius = Math.max(A.w, A.d) * 0.55;

          const proj = track.project(_tmp.set(px, 0, pz));
          const clearance = 19 + radius * 0.55;
          let inPlaza = false;
          for (const pl of this.plaza) if (Math.hypot(px - pl.x, pz - pl.z) < pl.r + radius) inPlaza = true;
          if (inPlaza || proj.distance < clearance || this._occupied(px, pz, radius * 0.85)) {
            s += step * 0.55;
            continue;
          }

          // face the road (local +Z toward the centreline), sometimes turned away on back rows
          const dirX = -side * f.binormal.x;
          const dirZ = -side * f.binormal.z;
          let yaw = Math.atan2(dirX, dirZ);
          if (row > 0 && R.chance(0.32)) yaw += Math.PI;
          yaw += R.range(-0.06, 0.06);

          const scl = 1 + R.range(-0.1, 0.14);

          // ---- SEAT ON THE GROUND.
          // The old code put every building at the height of the *centreline* at this `t`,
          // which is a different place entirely once you are 24-134 m off to the side and the
          // verge has risen 2 m or the terrain has fallen into a valley. That is what put
          // daylight under the towers in the QA aerial.
          const roadY = f.position.y - 0.05;
          const rect = this._rectOf(A);
          const seat = this._seat(px, pz, rect, scl, yaw, roadY);
          if (seat.fall > MAX_FALL) {
            // Too steep to seat honestly — a building half-swallowed by a hillside looks worse
            // than an empty plot, and there is always another plot further along.
            s += step * 0.6;
            continue;
          }
          this._occupy(px, pz, radius * 0.8);
          let py = seat.base;
          if (tb > 0.4 && Math.abs(lat) < 34) py = lerpN(py, this.deckY - 0.05, tb);

          const m = new THREE.Matrix4();
          m.makeRotationY(yaw);
          m.scale(_scale.set(scl, 1 + R.range(-0.08, 0.2), scl));
          m.setPosition(px, py, pz);

          // ---- plinth. A base course tall enough to bridge the fall across the footprint, so
          // on sloping ground the building gains a podium instead of showing a gap. It goes
          // into the sector's merged furniture mesh (no extra draw call) AND into the merged
          // far-LOD silhouette — the silhouette is what a distant sector actually renders and
          // what casts the sun shadow, so a plinth that only existed up close would leave the
          // same gap the moment the camera stepped back.
          const plinthTop = Math.max(py + 0.3, seat.top);
          const plinthBot = Math.min(seat.bottom, py - 0.4);
          const prx = (rect.x0 + rect.x1) * 0.5;
          const prz = (rect.z0 + rect.z1) * 0.5;
          const pw = rect.x1 - rect.x0 + 0.9 / scl;
          const pd = rect.z1 - rect.z0 + 0.9 / scl;
          const plinthCol = tint(0x63656a, 0.82 + R.range(0, 0.34));
          const plinthSeed = R();
          _mp.makeRotationY(yaw);
          _mp.scale(_scale.set(scl, 1, scl));
          _mp.setPosition(px, 0, pz);
          for (const gb of [surf, far]) {
            gb.push(_mp);
            gb.box(prx, (plinthTop + plinthBot) * 0.5, prz, pw, plinthTop - plinthBot, pd, {
              color: plinthCol,
              kind: KIND.CONCRETE,
              seed: plinthSeed,
              faces: 63 & ~4 & ~8,
            });
            gb.pop();
          }

          let e = placements.get(ai);
          if (!e) placements.set(ai, (e = { m: [], c: [] }));
          e.m.push(m);
          const tintv = 0.86 + R.range(0, 0.3);
          e.c.push(new THREE.Color(tintv * R.range(0.94, 1.06), tintv, tintv * R.range(0.94, 1.04)));

          // far LOD silhouette
          far.push(m);
          for (const sl of A.silhouette)
            far.box(0, (sl.y0 + sl.y1) * 0.5, 0, sl.w, sl.y1 - sl.y0, sl.d, {
              color: tint(0x585c63, tintv),
              kind: KIND.FARFACADE,
              seed: R(),
              faces: 63 & ~8,
            });
          far.pop();

          // --- attachments. The archetype describes them in local space; lift to world here.
          const front = row === 0 && tb < 0.4;
          if (front && A.signSlots?.length) {
            const budget = district.signs;
            for (const slot of A.signSlots) {
              if (!R.chance(Math.min(1, budget * (slot.type === 'roof' ? 0.55 : 0.9)))) continue;
              const local = { glows: [], fixtures: [] };
              surf.push(m);
              sign.push(m);
              placeSign(sign, surf, slot, R, local);
              sign.pop();
              surf.pop();
              for (const g of local.glows) {
                const p = _v1.set(g.x, g.y, g.z).applyMatrix4(m);
                glow.add(p.x, p.y, p.z, g.size, g.color);
              }
              for (const fx of local.fixtures) {
                const p = _v1.set(fx.x, fx.y, fx.z).applyMatrix4(m);
                fixtures.push({ x: p.x, y: p.y, z: p.z, color: fx.color, intensity: fx.intensity, dist: fx.dist });
              }
            }
          }
          for (const fx of A.fixtures || []) {
            const p = _v1.set(fx.x, fx.y, fx.z).applyMatrix4(m);
            fixtures.push({ x: p.x, y: p.y, z: p.z, color: fx.color, intensity: fx.intensity, dist: fx.dist });
          }
          for (const g of A.glows || []) {
            const p = _v1.set(g.x, g.y, g.z).applyMatrix4(m);
            glow.add(p.x, p.y, p.z, g.size, g.color);
          }
          maxR = Math.max(maxR, Math.hypot(px - centre.x, pz - centre.z) + radius + A.h * 0.25);

          s += step;
        }
      }
    }

    // ---------------------------------------------------------- street furniture
    this._street(surf, sign, glow, cover, trees, fixtures, out, {
      t0,
      t1,
      arcLen,
      district,
      index,
    });

    // ---------------------------------------------------------- assemble
    const nearGroup = new THREE.Group();
    nearGroup.name = `sector-${index}-near`;
    nearGroup.matrixAutoUpdate = false;

    const boxes = [];
    for (const [ai, e] of placements) {
      const A = this.archetypes[ai];
      const im = new THREE.InstancedMesh(A.geometry, this.mats.surface, e.m.length);
      im.name = `bld-${A.style}-${index}`;
      for (let i = 0; i < e.m.length; i++) {
        im.setMatrixAt(i, e.m[i]);
        im.setColorAt(i, e.c[i]);
        // World AABB per instance — used to punch a hole for cinematic cameras that would
        // otherwise end up inside a building (see CitySystem._cameraPocket).
        const bb = A.geometry.boundingBox.clone().applyMatrix4(e.m[i]);
        boxes.push({ im, i, min: bb.min.clone(), max: bb.max.clone() });
      }
      im.userData.base = im.instanceMatrix.array.slice();
      im.userData.hidden = new Set();
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      // Detail facades never cast — the sector's merged silhouette mesh is the only caster.
      im.castShadow = false;
      im.receiveShadow = true;
      im.userData.isBuilding = true;
      im.matrixAutoUpdate = false;
      im.frustumCulled = true;
      nearGroup.add(im);
    }
    if (!surf.isEmpty) {
      const mesh = new THREE.Mesh(surf.geometry(`furn-${index}`), this.mats.surface);
      // Street furniture contributes nothing legible to a 2048² cascade and would cost a full
      // re-render of a few thousand small boxes per cascade.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      nearGroup.add(mesh);
    }
    if (!sign.isEmpty) {
      const mesh = new THREE.Mesh(sign.geometry(`sign-${index}`), this.mats.signage);
      mesh.matrixAutoUpdate = false;
      nearGroup.add(mesh);
    }
    if (!cover.isEmpty) {
      const mesh = new THREE.Mesh(cover.geometry(), this.mats.foliage);
      mesh.matrixAutoUpdate = false;
      nearGroup.add(mesh);
    }
    // Neighbouring sectors draw their two tree slots from different species, so a run down the
    // street never repeats the same silhouette twice — at no extra draw-call cost.
    const species = TREE_PAIRS[index % TREE_PAIRS.length];
    for (let v = 0; v < 2; v++) {
      if (!trees[v].length) continue;
      const im = new THREE.InstancedMesh(this.treeGeos[species[v]], this.mats.foliage, trees[v].length);
      for (let i = 0; i < trees[v].length; i++) {
        im.setMatrixAt(i, trees[v][i].m);
        im.setColorAt(i, trees[v][i].c);
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.matrixAutoUpdate = false;
      nearGroup.add(im);
    }

    for (const g of out.glows) glow.add(g.x, g.y, g.z, g.size, g.color);
    let glowMesh = null;
    if (!glow.isEmpty) {
      glowMesh = new THREE.Mesh(glow.geometry(), this.mats.glow);
      glowMesh.matrixAutoUpdate = false;
      glowMesh.frustumCulled = true;
      glowMesh.renderOrder = 8;
    }

    let farMesh = null;
    if (!far.isEmpty) {
      farMesh = new THREE.Mesh(far.geometry(`far-${index}`), this.mats.surface);
      farMesh.matrixAutoUpdate = false;
      farMesh.castShadow = false;
      farMesh.receiveShadow = false;
      farMesh.frustumCulled = true;
    }

    for (const f of fixtures) this.fixtures.push(f);
    nearGroup.updateMatrixWorld(true);

    return {
      index,
      t0,
      t1,
      centre,
      radius: maxR,
      boxes,
      near: nearGroup,
      far: farMesh,
      glow: glowMesh,
      state: -1,
    };
  }

  // ------------------------------------------------------------------ street kit
  _street(surf, sign, glow, cover, trees, fixtures, out, o) {
    const R = this.rng;
    const track = this.track;
    const { t0, arcLen, district, index } = o;
    const veg = this.vegetation;

    const at = (s) => {
      const t = t0 + s / track.length;
      const f = track.frameAt(t);
      const tb = this.tunnelBlend(t);
      const wr = track.widthAt(t) * 1.35;
      const lat = lerpN(wr + 1.9, 20.5, tb);
      // Street furniture stands ON the pavement, so it takes the pavement's height, not the
      // carriageway's — otherwise every bin and lamp base is buried 20 cm in the flags.
      const y = lerpN(f.position.y + PAVE_Y, this.deckY, tb);
      return { t, f, tb, lat, y };
    };

    /**
     * Height for a prop at (px,pz). On the pavement it stays locked to the kerb; past the
     * pavement it sits on the terrain, which is where the old code kept putting trees two
     * metres above the ground on the outside of a banked corner.
     */
    const propY = (a, latOff, px, pz) => {
      if (latOff <= PAVE_REACH || a.tb > 0.4) return a.y;
      const t = Math.min(1, (latOff - PAVE_REACH) / 7);
      const g = this.groundY(px, pz, a.y);
      return a.y + (g + 0.06 - a.y) * t;
    };

    const place = (s, side, latOff, yawOff, fn, opts) => {
      const a = at(s);
      const lat = a.lat + latOff;
      const px = a.f.position.x + a.f.binormal.x * side * lat;
      const pz = a.f.position.z + a.f.binormal.z * side * lat;
      const yaw = Math.atan2(-side * a.f.binormal.x, -side * a.f.binormal.z) + (yawOff || 0);
      _m.makeRotationY(yaw);
      _m.setPosition(px, propY(a, latOff, px, pz), pz);
      surf.push(_m);
      const res = fn(surf, R, opts);
      surf.pop();
      if (res) {
        for (const f of res.fixtures || []) {
          const p = _v1.set(f.x, f.y, f.z).applyMatrix4(_m);
          fixtures.push({ x: p.x, y: p.y, z: p.z, color: f.color, intensity: f.intensity, dist: f.dist });
        }
        for (const g of res.glows || []) {
          const p = _v1.set(g.x, g.y, g.z).applyMatrix4(_m);
          glow.add(p.x, p.y, p.z, g.size, g.color);
        }
      }
      return { px, pz, y: a.y, tb: a.tb };
    };

    // --- street lights, alternating sides
    const lampGap = district.lamp;
    for (let s = R.range(0, lampGap); s < arcLen; s += lampGap) {
      const side = Math.floor((index * 3 + s / lampGap) % 2) === 0 ? -1 : 1;
      const a = at(s);
      if (a.tb > 0.5) continue;
      place(s, side, 0.6, 0, PROPS.streetLight, { h: R.range(8.5, 11), dir: 1, arm: R.range(2.2, 3.4) });
    }

    // --- utility poles + catenaries on one side
    if (district.name !== 'downtown') {
      const gap = R.range(34, 46);
      let prev = null;
      const side = index % 2 ? 1 : -1;
      for (let s = 4; s < arcLen + gap; s += gap) {
        if (s > arcLen) break;
        const a = at(s);
        if (a.tb > 0.5) {
          prev = null;
          continue;
        }
        const p = place(s, side, 2.4, 0, utilityPole, {});
        const top = { x: p.px, y: p.y + 10.0, z: p.pz };
        if (prev) catenary(surf, prev, top, Math.hypot(top.x - prev.x, top.z - prev.z) * 0.055, 3);
        prev = top;
      }
    }

    // --- traffic lights / signs / small kit
    for (let s = R.range(6, 20); s < arcLen; s += R.range(16, 34)) {
      const a = at(s);
      if (a.tb > 0.45) continue;
      const side = R.chance(0.5) ? -1 : 1;
      const roll = R();
      if (roll < 0.12) place(s, side, 0.4, 0, PROPS.trafficLight, {});
      else if (roll < 0.34) place(s, side, 0.5, R.range(-0.2, 0.2), PROPS.roadSign, {});
      else if (roll < 0.46) place(s, side, 2.6, 0, PROPS.bin, {});
      else if (roll < 0.56) place(s, side, 3.0, Math.PI, PROPS.bench, {});
      else if (roll < 0.64) place(s, side, 1.1, 0, PROPS.hydrant, {});
      else if (roll < 0.72) place(s, side, 3.4, 0, PROPS.junctionBox, {});
      else if (roll < 0.8) place(s, side, 3.2, 0, PROPS.busShelter, {});
      else if (roll < 0.88) place(s, side, 2.8, 0, PROPS.vendingRow, {});
      else place(s, side, 0.9, 0, PROPS.drainCover, {});
    }

    // --- bollard / barrier runs
    for (let k = 0; k < 3; k++) {
      if (!R.chance(0.6)) continue;
      const side = R.chance(0.5) ? -1 : 1;
      const s0 = R.range(0, Math.max(1, arcLen - 24));
      const kind = R();
      if (kind < 0.4) {
        for (let i = 0; i < R.int(4, 9); i++) {
          const s = s0 + i * 2.4;
          if (s > arcLen) break;
          if (at(s).tb > 0.4) continue;
          place(s, side, 0.75, 0, PROPS.bollard, {});
        }
      } else if (kind < 0.75) {
        for (let i = 0; i < R.int(3, 7); i++) {
          const s = s0 + i * 2.4;
          if (s > arcLen) break;
          if (at(s).tb > 0.4) continue;
          place(s, side, 0.9, Math.PI / 2, PROPS.pedBarrier, {});
        }
      } else {
        const lat = R.range(3.5, 9);
        for (let i = 0; i < R.int(1, 3); i++) {
          const s = s0 + i * 8.4;
          if (s > arcLen) break;
          if (at(s).tb > 0.4) continue;
          place(s, side, lat, Math.PI / 2, PROPS.hoarding, { len: 8 });
          if (R.chance(0.5)) place(s + 2, side, 1.4, 0, PROPS.trafficCone, {});
          if (R.chance(0.4)) place(s + 5, side, 1.6, Math.PI / 2, PROPS.jerseyBarrier, {});
        }
      }
    }

    // --- roadside billboards
    if (R.chance(0.5 * district.signs)) {
      const s = R.range(4, Math.max(6, arcLen - 6));
      const a = at(s);
      if (a.tb < 0.3) {
        const side = R.chance(0.5) ? -1 : 1;
        const latOff = R.range(12, 26);
        const lat = a.lat + latOff;
        const px = a.f.position.x + a.f.binormal.x * side * lat;
        const pz = a.f.position.z + a.f.binormal.z * side * lat;
        if (!this._occupied(px, pz, 8)) {
          this._occupy(px, pz, 7);
          const yaw = Math.atan2(-side * a.f.binormal.x, -side * a.f.binormal.z) + R.range(-0.3, 0.3);
          billboard(sign, surf, px, propY(a, latOff, px, pz) - 0.2, pz, yaw, R, out);
        }
      }
    }

    // --- vegetation
    if (veg > 0.02) {
      const treeGap = 15 / Math.max(0.35, veg * district.trees);
      for (let s = R.range(0, treeGap); s < arcLen; s += treeGap * R.range(0.7, 1.4)) {
        const a = at(s);
        if (a.tb > 0.4) continue;
        for (const side of [-1, 1]) {
          if (!R.chance(0.62)) continue;
          const lat = a.lat + R.range(2.2, 4.2);
          const px = a.f.position.x + a.f.binormal.x * side * lat;
          const pz = a.f.position.z + a.f.binormal.z * side * lat;
          const v = R.chance(0.58) ? 0 : 1;
          // Per-instance scale is deliberately anisotropic: a crown that is 15% wider than it
          // is deep stops two neighbouring instances of the same card reading as copies.
          const sc = R.range(0.7, 1.55);
          const m = new THREE.Matrix4()
            .makeRotationY(R() * Math.PI * 2)
            .scale(_scale.set(sc * R.range(0.88, 1.14), sc * R.range(0.85, 1.3), sc * R.range(0.88, 1.14)));
          m.setPosition(px, a.y, pz);
          // hue jitter along the yellow-green axis — young growth through to dusty summer
          const g = R.range(0.7, 1.2);
          trees[v].push({
            m,
            c: new THREE.Color(g * R.range(0.84, 1.14), g, g * R.range(0.7, 1.0)),
          });
          if (R.chance(0.5)) place(s, side, lat - a.lat, 0, PROPS.planter, {});
        }
      }
      // grass and hedges on the verge
      const n = Math.round(arcLen * 0.4 * Math.min(2, veg));
      for (let i = 0; i < n; i++) {
        const s = R() * arcLen;
        const a = at(s);
        if (a.tb > 0.35) continue;
        const side = R.chance(0.5) ? -1 : 1;
        const latOff = R.range(5.5, 13);
        const lat = a.lat + latOff;
        const px = a.f.position.x + a.f.binormal.x * side * lat;
        const pz = a.f.position.z + a.f.binormal.z * side * lat;
        cover.tuft(px, propY(a, latOff, px, pz), pz, R.range(0.5, 1.3), R);
      }
      for (let i = 0; i < Math.round(2 * veg); i++) {
        const s = R() * arcLen;
        const a = at(s);
        if (a.tb > 0.35) continue;
        const side = R.chance(0.5) ? -1 : 1;
        const latOff = R.range(6, 11);
        const lat = a.lat + latOff;
        const px = a.f.position.x + a.f.binormal.x * side * lat;
        const pz = a.f.position.z + a.f.binormal.z * side * lat;
        const dx = a.f.tangent.x;
        const dz = a.f.tangent.z;
        cover.hedge(px, propY(a, latOff, px, pz), pz, R.range(5, 13), dx, dz, R.range(0.8, 1.5), R);
      }
    }

    // --- pavement detail: kerb ramps and painted crossings at sector ends
    for (const s of [1.5, arcLen - 1.5]) {
      if (s < 0 || s > arcLen) continue;
      const a = at(s);
      if (a.tb > 0.3) continue;
      for (const side of [-1, 1]) place(s, side, 0.2, 0, PROPS.kerbRamp, {});
      // zebra bars
      _m.makeRotationY(Math.atan2(a.f.tangent.x, a.f.tangent.z));
      _m.setPosition(a.f.position.x, a.f.position.y + 0.015, a.f.position.z);
      surf.push(_m);
      const wr = track.widthAt(a.t) * 1.05;
      for (let i = -6; i <= 6; i++)
        surf.box((i * wr) / 7, 0, 0, wr / 12, 0.02, 3.2, {
          color: tint(0xd8d6cf, 1),
          kind: KIND.ROAD,
          seed: 0.4,
        });
      surf.pop();
    }
  }
}

// ---------------------------------------------------------------------- glue

class GlowBuilder {
  constructor() {
    this.b = new GeoBuilder();
  }
  add(x, y, z, size, hex) {
    const c = col(hex);
    const base = this.b.vertexCount;
    const uv = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (let i = 0; i < 4; i++) this.b.vert(x, y, z, 0, 0, 1, uv[i][0], uv[i][1], c, 0, size);
    this.b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  get isEmpty() {
    return this.b.isEmpty;
  }
  geometry() {
    return this.b.geometry('glow');
  }
}

function districtFor(i) {
  // four contiguous districts around the loop, with the industrial belt on the tunnel side
  const t = i / SECTORS;
  if (t < 0.22) return 0; // downtown
  if (t < 0.45) return 1; // strip
  if (t < 0.7) return 2; // industrial (contains the tunnel)
  return 3; // residential
}

function shortest(a, b) {
  let d = a - b;
  while (d > 0.5) d -= 1;
  while (d < -0.5) d += 1;
  return d;
}
function lerpN(a, b, t) {
  return a + (b - a) * t;
}

const _tmp = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _mp = new THREE.Matrix4();
const _scale = new THREE.Vector3();

export { SECTORS, GlowBuilder };
