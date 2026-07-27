import * as THREE from 'three';
import { SOFT_DEPTH_GLSL } from './DepthPass.js';
import { noiseTile } from './vfxTextures.js';

/**
 * Screen-space refraction for exhaust heat shimmer and NOS shockwaves.
 *
 * PostFxSystem owns the composer, so the VFX lane cannot add a distortion *pass*. Instead we do
 * a classic grab-pass: the first distortion quad of the frame copies the colour attachment that
 * is currently bound (the composer's HDR buffer, already containing the opaque scene) into a
 * private FramebufferTexture, and the quads then sample that texture with a noise-driven offset.
 *
 * Every GL touchpoint is guarded — if `copyFramebufferToTexture` is unavailable or errors on a
 * given driver we permanently fall back to a non-refractive shimmer, which still reads as heat.
 */
export class ScreenGrab {
  constructor(ctx) {
    this.ctx = ctx;
    this.texture = null;
    this.available = true;
    this.enabled = true;
    this._frame = -1;
    this._checked = false;
    this._size = new THREE.Vector2();
  }

  _ensure() {
    const { renderer } = this.ctx;
    renderer.getDrawingBufferSize(this._size);
    const w = Math.max(8, this._size.x | 0);
    const h = Math.max(8, this._size.y | 0);
    if (this.texture && this.texture.image.width === w && this.texture.image.height === h) return;
    this.texture?.dispose();
    const t = new THREE.FramebufferTexture(w, h);
    t.type = THREE.HalfFloatType;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.colorSpace = THREE.NoColorSpace;
    t.generateMipmaps = false;
    this.texture = t;
  }

  /** Grab at most once per frame. Safe to call from several onBeforeRender hooks. */
  grab() {
    if (!this.available || !this.enabled) return null;
    const frame = this.ctx.time.frame;
    if (frame === this._frame) return this.texture;
    this._frame = frame;
    const { renderer } = this.ctx;
    try {
      this._ensure();
      renderer.copyFramebufferToTexture(this.texture);
      if (!this._checked) {
        this._checked = true;
        const gl = renderer.getContext();
        const err = gl.getError();
        if (err !== gl.NO_ERROR) throw new Error(`copyFramebufferToTexture gl error 0x${err.toString(16)}`);
      }
    } catch (e) {
      console.warn('[vfx] screen-grab refraction unavailable, using shimmer fallback:', e?.message || e);
      this.available = false;
      this.texture?.dispose();
      this.texture = null;
      return null;
    }
    return this.texture;
  }

  onResize() {
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
      this._frame = -1;
    }
  }

  dispose() {
    this.texture?.dispose();
    this.texture = null;
  }
}

/**
 * Pool of world-space refraction billboards: exhaust heat haze, NOS shockwave, hot brake air.
 * CPU-simulated (tiny pool, ~64) and drawn in one instanced call.
 */
export class HeatHaze {
  constructor(ctx, depth, grab, parent, capacity = 64) {
    this.ctx = ctx;
    this.depth = depth;
    this.grab = grab;
    this.parent = parent;
    this._wantCapacity = capacity;
    this.count = 0;
    this.capacity = 0;
    this.enabled = true;
  }

  init() {
    this._build(this._wantCapacity);
    return this;
  }

  _build(capacity) {
    const scene = this.parent;
    capacity = Math.max(8, capacity | 0);
    if (this.mesh) {
      scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.capacity = capacity;
    this.count = 0;

    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.data = new Float32Array(capacity * 4); // life, maxLife, size0, size1
    this.extra = new Float32Array(capacity * 4); // strength, seed, spare, spare

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    base.dispose();

    this.aPos = this._attr(geo, 'iPos', 3, capacity);
    this.aData = this._attr(geo, 'iData', 4, capacity); // lifeU, size, strength, seed
    this._attrs = [this.aPos, this.aData];
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = makeHazeMaterial(this.depth);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 26; // after opaque + smoke, before the fullscreen overlay
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.mesh.onBeforeRender = () => {
      const tex = this.grab.grab();
      this.material.uniforms.tGrab.value = tex;
      this.material.uniforms.uHasGrab.value = tex ? 1 : 0;
    };
    this.geo = geo;
    scene.add(this.mesh);
  }

  _attr(geo, name, items, capacity) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(items * capacity), items);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    return a;
  }

  setCapacity(n) {
    if (n === this.capacity) return;
    this._build(n);
  }

  spawn(px, py, pz, vx, vy, vz, life, size0, size1, strength) {
    if (!this.enabled || this.count >= this.capacity) return false;
    const i = this.count++;
    const o3 = i * 3;
    this.pos[o3] = px;
    this.pos[o3 + 1] = py;
    this.pos[o3 + 2] = pz;
    this.vel[o3] = vx;
    this.vel[o3 + 1] = vy;
    this.vel[o3 + 2] = vz;
    const o4 = i * 4;
    this.data[o4] = life;
    this.data[o4 + 1] = life;
    this.data[o4 + 2] = size0;
    this.data[o4 + 3] = size1;
    this.extra[o4] = strength;
    this.extra[o4 + 1] = Math.random() * 40;
    return true;
  }

  update(dt) {
    let n = this.count;
    const pos = this.pos;
    const vel = this.vel;
    const data = this.data;
    const extra = this.extra;
    for (let i = 0; i < n; ) {
      const o4 = i * 4;
      data[o4] -= dt;
      if (data[o4] <= 0) {
        const last = --n;
        if (last !== i) {
          const a3 = i * 3;
          const b3 = last * 3;
          for (let k = 0; k < 3; k++) {
            pos[a3 + k] = pos[b3 + k];
            vel[a3 + k] = vel[b3 + k];
          }
          const a4 = i * 4;
          const b4 = last * 4;
          for (let k = 0; k < 4; k++) {
            data[a4 + k] = data[b4 + k];
            extra[a4 + k] = extra[b4 + k];
          }
        }
        continue;
      }
      const o3 = i * 3;
      vel[o3] *= 1 - Math.min(1.6 * dt, 0.9);
      vel[o3 + 2] *= 1 - Math.min(1.6 * dt, 0.9);
      vel[o3 + 1] += 1.9 * dt; // hot air rises
      pos[o3] += vel[o3] * dt;
      pos[o3 + 1] += vel[o3 + 1] * dt;
      pos[o3 + 2] += vel[o3 + 2] * dt;
      i++;
    }
    this.count = n;

    const ap = this.aPos.array;
    const ad = this.aData.array;
    for (let i = 0; i < n; i++) {
      const o3 = i * 3;
      const o4 = i * 4;
      ap[o3] = pos[o3];
      ap[o3 + 1] = pos[o3 + 1];
      ap[o3 + 2] = pos[o3 + 2];
      const u = 1 - data[o4] / Math.max(data[o4 + 1], 1e-4);
      ad[o4] = u;
      ad[o4 + 1] = data[o4 + 2] + (data[o4 + 3] - data[o4 + 2]) * u;
      ad[o4 + 2] = extra[o4] * (1 - u) * (1 - u);
      ad[o4 + 3] = extra[o4 + 1];
    }
    if (n > 0) {
      for (const a of this._attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
    }
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0 && this.enabled;
    this.material.uniforms.uTime.value = this.ctx.time.elapsed;
  }

  dispose() {
    this.parent.remove(this.mesh);
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}

function makeHazeMaterial(depth) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    uniforms: {
      tGrab: { value: null },
      uHasGrab: { value: 0 },
      uNoise: { value: noiseTile() },
      uTime: { value: 0 },
      ...depth.uniforms,
    },
    vertexShader: /* glsl */ `
      attribute vec3 iPos;
      attribute vec4 iData;  // lifeU, size, strength, seed
      varying vec2 vUv;
      varying float vStrength, vSeed, vViewZ;
      void main(){
        vec4 mv = viewMatrix * vec4(iPos, 1.0);
        vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        float s = iData.y;
        vec3 world = iPos + camRight * (position.x * s) + camUp * (position.y * s);
        vec4 mv2 = viewMatrix * vec4(world, 1.0);
        vUv = uv;
        vStrength = iData.z;
        vSeed = iData.w;
        vViewZ = -mv2.z;
        gl_Position = projectionMatrix * mv2;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tGrab, uNoise;
      uniform float uTime, uHasGrab;
      varying vec2 vUv;
      varying float vStrength, vSeed, vViewZ;

      ${SOFT_DEPTH_GLSL}

      void main(){
        vec2 d = (vUv - 0.5) * 2.0;
        float mask = clamp(1.0 - dot(d, d), 0.0, 1.0);
        mask = pow(mask, 1.4) * vStrength;
        if (mask < 0.004) discard;

        vec2 suv = gl_FragCoord.xy * uDepthParams.zw;
        mask *= vfxSoftFade(suv, vViewZ, 0.6);
        if (mask < 0.004) discard;

        vec2 nuv = vUv * 1.7 + vec2(vSeed * 0.13, -uTime * 0.85 + vSeed * 0.07);
        vec3 nz = texture2D(uNoise, nuv).rgb;
        vec2 wob = (nz.rg - 0.5) * 2.0;

        // Distortion shrinks with distance so a plume looks the same physical size.
        float scale = 0.030 * mask / max(vViewZ, 0.8);

        if (uHasGrab > 0.5) {
          vec3 col = texture2D(tGrab, clamp(suv + wob * scale, vec2(0.001), vec2(0.999))).rgb;
          gl_FragColor = vec4(col, mask);
        } else {
          // Fallback: no grab available — shimmer the luminance instead of refracting it.
          float sh = (nz.b - 0.5) * 2.0;
          gl_FragColor = vec4(vec3(0.5 + sh * 0.5), mask * 0.05);
        }
      }
    `,
  });
}
