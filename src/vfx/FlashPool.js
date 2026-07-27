import * as THREE from 'three';
import { glow } from './vfxTextures.js';

/**
 * Pooled short-lived point lights + matching glow sprites.
 *
 * Real dynamic light is dramatically more convincing than an emissive billboard: a backfire that
 * actually lights the tarmac and the rear wing reads as combustion, one that does not reads as a
 * decal. The pool is fixed size (lights are expensive: each one recompiles nothing but does add
 * per-fragment cost to every lit material in range), and acquisition steals the dimmest light
 * when the pool is saturated so the *loudest* event always wins.
 */
export class FlashPool {
  constructor(ctx, parent, capacity = 6) {
    this.ctx = ctx;
    this.parent = parent;
    this._wantCapacity = capacity;
    this.lights = [];
    this.sprites = null;
    this.capacity = 0;
  }

  init() {
    this._build(this._wantCapacity);
    return this;
  }

  _build(capacity) {
    capacity = Math.max(0, capacity | 0);
    for (const l of this.lights) {
      this.parent.remove(l.light);
      l.light.dispose?.();
    }
    this.lights.length = 0;
    this.capacity = capacity;
    for (let i = 0; i < capacity; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 12, 2);
      light.castShadow = false;
      light.visible = false;
      light.matrixAutoUpdate = true;
      this.parent.add(light);
      this.lights.push({ light, life: 0, maxLife: 1, peak: 0, radius: 8 });
    }

    if (!this.sprites) this._buildSprites();
  }

  _buildSprites() {
    const CAP = 24;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    base.dispose();
    this.spriteCap = CAP;
    this.spriteCount = 0;
    this.sPos = new Float32Array(CAP * 3);
    this.sData = new Float32Array(CAP * 4); // life, maxLife, size, spare
    this.sCol = new Float32Array(CAP * 3);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3).setUsage(
      THREE.DynamicDrawUsage
    );
    this.aData = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 2), 2).setUsage(
      THREE.DynamicDrawUsage
    ); // size, intensity
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3).setUsage(
      THREE.DynamicDrawUsage
    );
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iData', this.aData);
    geo.setAttribute('iColor', this.aCol);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.spriteMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uMap: { value: glow() } },
      vertexShader: /* glsl */ `
        attribute vec3 iPos;
        attribute vec2 iData;   // size, intensity
        attribute vec3 iColor;
        varying vec2 vUv; varying vec3 vColor; varying float vI;
        void main(){
          vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 world = iPos + camRight * (position.x * iData.x) + camUp * (position.y * iData.x);
          vUv = uv; vColor = iColor; vI = iData.y;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uMap;
        varying vec2 vUv; varying vec3 vColor; varying float vI;
        void main(){
          float a = texture2D(uMap, vUv).a;
          if (a * vI < 0.002) discard;
          gl_FragColor = vec4(vColor * a * vI, a * vI);
        }
      `,
    });
    this.sprites = new THREE.Mesh(geo, this.spriteMat);
    this.sprites.frustumCulled = false;
    this.sprites.renderOrder = 28;
    this.sprites.matrixAutoUpdate = false;
    this.sprites.visible = false;
    this.spriteGeo = geo;
    this.parent.add(this.sprites);
  }

  setCapacity(n) {
    if (n === this.capacity) return;
    this._build(n);
  }

  /** CONTRACTS §11 — `flash(pos, color, intensity, radius, life)`. */
  flash(pos, color = 0xffffff, intensity = 12, radius = 9, life = 0.16) {
    if (!pos) return;
    // ---- glow sprite (always) ----
    if (this.spriteCount < this.spriteCap) {
      const i = this.spriteCount++;
      const o3 = i * 3;
      this.sPos[o3] = pos.x;
      this.sPos[o3 + 1] = pos.y;
      this.sPos[o3 + 2] = pos.z;
      const o4 = i * 4;
      this.sData[o4] = life;
      this.sData[o4 + 1] = life;
      this.sData[o4 + 2] = radius * 0.42;
      _c.set(color);
      this.sCol[o3] = _c.r * Math.min(intensity * 0.14, 3.2);
      this.sCol[o3 + 1] = _c.g * Math.min(intensity * 0.14, 3.2);
      this.sCol[o3 + 2] = _c.b * Math.min(intensity * 0.14, 3.2);
    }

    if (!this.capacity) return;
    // ---- real point light ----
    let slot = -1;
    let weakest = Infinity;
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      if (l.life <= 0) {
        slot = i;
        break;
      }
      const cur = l.peak * (l.life / l.maxLife);
      if (cur < weakest) {
        weakest = cur;
        slot = i;
      }
    }
    if (slot < 0) return;
    const l = this.lights[slot];
    if (l.life > 0 && weakest > intensity) return; // don't demote a brighter flash
    l.light.position.copy(pos);
    l.light.color.set(color);
    l.light.distance = radius;
    l.light.decay = 2;
    l.peak = intensity;
    l.life = life;
    l.maxLife = life;
    l.light.intensity = intensity;
    l.light.visible = true;
  }

  update(dt) {
    for (const l of this.lights) {
      if (l.life <= 0) continue;
      l.life -= dt;
      if (l.life <= 0) {
        l.light.intensity = 0;
        l.light.visible = false;
        continue;
      }
      const u = l.life / l.maxLife;
      // Sharp attack, exponential decay — an explosion, not a fade.
      l.light.intensity = l.peak * u * u;
    }

    let n = this.spriteCount;
    for (let i = 0; i < n; ) {
      const o4 = i * 4;
      this.sData[o4] -= dt;
      if (this.sData[o4] <= 0) {
        const last = --n;
        if (last !== i) {
          for (let k = 0; k < 3; k++) {
            this.sPos[i * 3 + k] = this.sPos[last * 3 + k];
            this.sCol[i * 3 + k] = this.sCol[last * 3 + k];
          }
          for (let k = 0; k < 4; k++) this.sData[i * 4 + k] = this.sData[last * 4 + k];
        }
        continue;
      }
      i++;
    }
    this.spriteCount = n;

    const ap = this.aPos.array;
    const ad = this.aData.array;
    const ac = this.aCol.array;
    for (let i = 0; i < n; i++) {
      const o3 = i * 3;
      const o4 = i * 4;
      ap[o3] = this.sPos[o3];
      ap[o3 + 1] = this.sPos[o3 + 1];
      ap[o3 + 2] = this.sPos[o3 + 2];
      const u = this.sData[o4] / Math.max(this.sData[o4 + 1], 1e-4);
      ad[i * 2] = this.sData[o4 + 2] * (1.35 - 0.5 * u);
      ad[i * 2 + 1] = u * u;
      ac[o3] = this.sCol[o3];
      ac[o3 + 1] = this.sCol[o3 + 1];
      ac[o3 + 2] = this.sCol[o3 + 2];
    }
    if (n > 0) {
      for (const a of [this.aPos, this.aData, this.aCol]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
    }
    this.spriteGeo.instanceCount = n;
    this.sprites.visible = n > 0;
  }

  dispose() {
    for (const l of this.lights) this.parent.remove(l.light);
    this.lights.length = 0;
    if (this.sprites) {
      this.parent.remove(this.sprites);
      this.sprites.geometry.dispose();
      this.spriteMat.dispose();
    }
  }
}

const _c = new THREE.Color();
