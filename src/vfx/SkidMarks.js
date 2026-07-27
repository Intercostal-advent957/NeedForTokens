import * as THREE from 'three';
import { skidTread } from './vfxTextures.js';

/**
 * Persistent rubber / dust ribbons laid into the road.
 *
 * One growing ribbon mesh — a single draw call, one fixed-size vertex ring buffer, no
 * allocation once built. Each wheel owns a stroke; while it is slipping we append quads
 * stitched edge-to-edge from the previous segment, so the ribbon is continuous through corners
 * and correctly oriented to the *travel* direction (not the car's heading, which is what makes
 * a drift mark read as a drift).
 *
 * Flatness: vertices are pushed 15 mm along the measured surface normal AND the material uses
 * polygon offset, so the mark cannot z-fight even on banked/curved road. depthWrite is off and
 * renderOrder puts it after opaque geometry but before every particle system.
 *
 * Memory cap: `capacity` segments; when the ring wraps, the oldest mark is silently reused.
 */
const SURF = { asphalt: 0, concrete: 0, curb: 0, metal: 0, dirt: 1, grass: 2, water: 3 };

export class SkidMarks {
  constructor(ctx, parent, capacity = 4000) {
    this.ctx = ctx;
    this.parent = parent;
    this._wantCapacity = capacity;
    this.capacity = 0;
    this.head = 0;
    this.strokes = new Map(); // key -> stroke state, preallocated per wheel
    this._dirtyLo = Infinity;
    this._dirtyHi = -1;
    this._wrapped = false;
    // Scratch for the public addSkid() entry point; the per-wheel tracer is allocation-free.
    this._tmp = { d: new THREE.Vector3(), n: new THREE.Vector3() };
  }

  init() {
    this._build(this._wantCapacity);
    return this;
  }

  _build(capacity) {
    const scene = this.parent;
    capacity = Math.max(256, capacity | 0);
    if (this.mesh) {
      scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.capacity = capacity;
    this.head = 0;

    const verts = capacity * 4;
    this.posArr = new Float32Array(verts * 3);
    this.uvArr = new Float32Array(verts * 2);
    this.dataArr = new Float32Array(verts * 4); // birth, opacity, fadeSecs, surfaceId
    this.normArr = new Float32Array(verts * 3);
    const idx = new Uint32Array(capacity * 6);
    for (let s = 0; s < capacity; s++) {
      const v = s * 4;
      const o = s * 6;
      idx[o] = v;
      idx[o + 1] = v + 1;
      idx[o + 2] = v + 2;
      idx[o + 3] = v;
      idx[o + 4] = v + 2;
      idx[o + 5] = v + 3;
    }

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage);
    this.aUv = new THREE.BufferAttribute(this.uvArr, 2).setUsage(THREE.DynamicDrawUsage);
    this.aData = new THREE.BufferAttribute(this.dataArr, 4).setUsage(THREE.DynamicDrawUsage);
    this.aNorm = new THREE.BufferAttribute(this.normArr, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('uv', this.aUv);
    geo.setAttribute('aData', this.aData);
    geo.setAttribute('aNorm', this.aNorm);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this._attrs = [this.aPos, this.aUv, this.aData, this.aNorm];

    this.material = makeSkidMaterial();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6; // after opaque road, before every particle system
    this.mesh.matrixAutoUpdate = false;
    this.mesh.receiveShadow = false;
    this.geo = geo;
    scene.add(this.mesh);
  }

  setCapacity(n) {
    if (n === this.capacity) return;
    this._build(n);
    this.strokes.clear();
  }

  /** Per-wheel stroke bookkeeping. Allocated once per wheel, then reused forever. */
  _stroke(key) {
    let s = this.strokes.get(key);
    if (!s) {
      s = {
        active: false,
        px: 0, py: 0, pz: 0,
        rx: 0, ry: 0, rz: 0,
        nx: 0, ny: 1, nz: 0,
        w: 0.2,
        op: 0,
        v: 0,
      };
      this.strokes.set(key, s);
    }
    return s;
  }

  /**
   * Continuous ribbon append for a tyre. `dirX/Z` is the travel direction of the contact patch.
   * Returns true if a segment was actually laid down this call.
   */
  trace(key, px, py, pz, nx, ny, nz, dirX, dirY, dirZ, width, opacity, surface) {
    const st = this._stroke(key);
    if (opacity <= 0.015) {
      st.active = false;
      return false;
    }
    const dl = Math.hypot(dirX, dirY, dirZ);
    if (dl < 1e-4) return false;
    const ux = dirX / dl;
    const uy = dirY / dl;
    const uz = dirZ / dl;

    if (!st.active) {
      st.active = true;
      st.px = px; st.py = py; st.pz = pz;
      st.nx = nx; st.ny = ny; st.nz = nz;
      // right = normal x travel
      st.rx = ny * uz - nz * uy;
      st.ry = nz * ux - nx * uz;
      st.rz = nx * uy - ny * ux;
      const rl = Math.hypot(st.rx, st.ry, st.rz) || 1;
      st.rx /= rl; st.ry /= rl; st.rz /= rl;
      st.w = width;
      st.op = opacity;
      st.v = 0;
      return false;
    }

    const dx = px - st.px;
    const dy = py - st.py;
    const dz = pz - st.pz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.16) return false;
    if (dist > 6.0) {
      // Teleport / respawn — drop the stroke rather than smearing a mark across the map.
      st.active = false;
      return false;
    }

    let rx = ny * uz - nz * uy;
    let ry = nz * ux - nx * uz;
    let rz = nx * uy - ny * ux;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;

    this._pushQuad(
      st.px, st.py, st.pz, st.rx, st.ry, st.rz, st.nx, st.ny, st.nz, st.w * 0.5, st.op, st.v,
      px, py, pz, rx, ry, rz, nx, ny, nz, width * 0.5, opacity, st.v + dist,
      surface
    );

    st.px = px; st.py = py; st.pz = pz;
    st.rx = rx; st.ry = ry; st.rz = rz;
    st.nx = nx; st.ny = ny; st.nz = nz;
    st.w = width;
    st.op = opacity;
    st.v += dist;
    return true;
  }

  /** CONTRACTS §11 — one-shot stamp. `dir` is a THREE.Vector3-ish (x,y,z). */
  addSkid(pos, dir, width = 0.24, opacity = 0.6, surface = 'asphalt') {
    if (!pos) return;
    const t = this._tmp;
    t.d.set(dir?.x ?? 0, 0, dir?.z ?? -1);
    if (t.d.lengthSq() < 1e-8) t.d.set(0, 0, -1);
    t.d.normalize();
    const g = this.ctx.world?.sampleGround?.(pos.x, pos.z);
    const n = g?.normal ?? t.n.set(0, 1, 0);
    const y = g?.height ?? pos.y;
    const len = Math.max(width, 0.35);
    const rx = n.y * t.d.z - n.z * t.d.y;
    const ry = n.z * t.d.x - n.x * t.d.z;
    const rz = n.x * t.d.y - n.y * t.d.x;
    const rl = Math.hypot(rx, ry, rz) || 1;
    const ax = pos.x - t.d.x * len * 0.5;
    const az = pos.z - t.d.z * len * 0.5;
    const bx = pos.x + t.d.x * len * 0.5;
    const bz = pos.z + t.d.z * len * 0.5;
    this._pushQuad(
      ax, y, az, rx / rl, ry / rl, rz / rl, n.x, n.y, n.z, width * 0.5, opacity, 0,
      bx, y, bz, rx / rl, ry / rl, rz / rl, n.x, n.y, n.z, width * 0.5, opacity, len,
      surface
    );
  }

  _pushQuad(
    ax, ay, az, arx, ary, arz, anx, any, anz, ahw, aop, av,
    bx, by, bz, brx, bry, brz, bnx, bny, bnz, bhw, bop, bv,
    surface
  ) {
    const s = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) this._wrapped = true;

    const LIFT = 0.016;
    const p = this.posArr;
    const uvs = this.uvArr;
    const d = this.dataArr;
    const nm = this.normArr;
    const now = this.ctx.time.elapsed;
    const sid = SURF[surface] ?? 0;
    const fade = sid === 0 ? 34.0 : 16.0; // rubber persists; dust blows away

    const v0 = s * 4;
    const write = (k, x, y, z, nx, ny, nz, u, vv, op) => {
      const o3 = (v0 + k) * 3;
      p[o3] = x + nx * LIFT;
      p[o3 + 1] = y + ny * LIFT;
      p[o3 + 2] = z + nz * LIFT;
      nm[o3] = nx;
      nm[o3 + 1] = ny;
      nm[o3 + 2] = nz;
      const o2 = (v0 + k) * 2;
      uvs[o2] = u;
      uvs[o2 + 1] = vv;
      const o4 = (v0 + k) * 4;
      d[o4] = now;
      d[o4 + 1] = op;
      d[o4 + 2] = fade;
      d[o4 + 3] = sid;
    };

    write(0, ax - arx * ahw, ay - ary * ahw, az - arz * ahw, anx, any, anz, 0, av * 1.6, aop);
    write(1, ax + arx * ahw, ay + ary * ahw, az + arz * ahw, anx, any, anz, 1, av * 1.6, aop);
    write(2, bx + brx * bhw, by + bry * bhw, bz + brz * bhw, bnx, bny, bnz, 1, bv * 1.6, bop);
    write(3, bx - brx * bhw, by - bry * bhw, bz - brz * bhw, bnx, bny, bnz, 0, bv * 1.6, bop);

    if (s < this._dirtyLo) this._dirtyLo = s;
    if (s > this._dirtyHi) this._dirtyHi = s;
  }

  clear() {
    this.dataArr.fill(0);
    for (const a of this._attrs) {
      a.clearUpdateRanges();
      a.needsUpdate = true;
    }
    this.strokes.clear();
    this.head = 0;
  }

  update() {
    const u = this.material.uniforms;
    const ctx = this.ctx;
    u.uTime.value = ctx.time.elapsed;
    const env = ctx.env;
    const sun = env?.sunLight;
    const hemi = env?.hemi;
    // The mark should sit in the road's own light, so a night skid is not a glowing decal.
    let lum = 0.25;
    if (sun) lum += Math.max(sun.intensity, 0) * 0.16;
    if (hemi) lum += Math.max(hemi.intensity, 0) * 0.3;
    u.uLight.value = Math.min(lum, 1.15);
    u.uWetness.value = env?.wetness ?? 0;
    const fog = ctx.scene.fog;
    if (fog) {
      u.uFogColor.value.copy(fog.color);
      u.uFogDensity.value = fog.density ?? 0;
    } else u.uFogDensity.value = 0;

    if (this._dirtyHi >= 0) {
      const full = this._wrapped;
      for (const a of this._attrs) {
        a.clearUpdateRanges();
        if (!full) {
          const lo = this._dirtyLo * 4 * a.itemSize;
          const n = (this._dirtyHi - this._dirtyLo + 1) * 4 * a.itemSize;
          a.addUpdateRange(lo, n);
        }
        a.needsUpdate = true;
      }
      this._dirtyLo = Infinity;
      this._dirtyHi = -1;
      this._wrapped = false;
    }
  }

  dispose() {
    this.parent.remove(this.mesh);
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}

function makeSkidMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -14,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, // premultiplied
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uMap: { value: skidTread() },
      uTime: { value: 0 },
      uLight: { value: 0.6 },
      uWetness: { value: 0 },
      uFogColor: { value: new THREE.Color(0.6, 0.7, 0.8) },
      uFogDensity: { value: 0.0004 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aData;   // birth, opacity, fadeSecs, surfaceId
      attribute vec3 aNorm;
      uniform float uTime;
      varying vec2 vUv;
      varying float vOpacity, vSurface, vViewZ;
      varying vec3 vNormal;

      void main(){
        float age = uTime - aData.x;
        float fade = aData.z;
        float o = aData.y * clamp(1.0 - age / max(fade, 0.001), 0.0, 1.0);
        // A mark also "sets" for the first fraction of a second so it does not pop.
        o *= smoothstep(0.0, 0.06, age);
        vOpacity = (age < 0.0) ? 0.0 : o;
        vSurface = aData.w;
        vUv = uv;
        vNormal = aNorm;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewZ = -mv.z;
        if (vOpacity <= 0.002) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uMap;
      uniform float uLight, uWetness, uFogDensity;
      uniform vec3 uFogColor;
      varying vec2 vUv;
      varying float vOpacity, vSurface, vViewZ;
      varying vec3 vNormal;

      void main(){
        vec4 t = texture2D(uMap, vUv);
        float a = t.a * vOpacity;
        if (a < 0.004) discard;

        // Hot rubber is near-black with a faint blue sheen; dirt and grass smear light.
        vec3 rubber = vec3(0.020, 0.019, 0.023);
        vec3 dust   = vec3(0.190, 0.132, 0.082);
        vec3 grass  = vec3(0.085, 0.115, 0.048);
        vec3 water  = vec3(0.055, 0.062, 0.075);
        vec3 col = rubber;
        col = mix(col, dust,  step(0.5, vSurface) * step(vSurface, 1.5));
        col = mix(col, grass, step(1.5, vSurface) * step(vSurface, 2.5));
        col = mix(col, water, step(2.5, vSurface));

        col *= uLight;
        // Wet asphalt makes rubber glossier and slightly darker still.
        col *= mix(1.0, 0.7, uWetness);
        a *= mix(1.0, 0.72, uWetness);

        float fogAmt = 1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ);
        col = mix(col, uFogColor, clamp(fogAmt, 0.0, 1.0));
        a *= 1.0 - clamp(fogAmt, 0.0, 1.0) * 0.9;

        gl_FragColor = vec4(col * a, a);
      }
    `,
  });
}
