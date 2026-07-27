import * as THREE from 'three';
import { SOFT_DEPTH_GLSL } from './DepthPass.js';
import { sparkStreak } from './vfxTextures.js';

/**
 * Velocity-stretched instanced billboards.
 *
 * Two instances of this class exist:
 *   • `hot`  — additive, hot→cool colour ramp: sparks, backfire flame, NOS jet, ember debris.
 *   • `cool` — alpha-blended and sun-lit: gravel, grass clippings, body panel debris.
 *
 * These bounce and tumble, so unlike the smoke they are integrated on the CPU — but only a few
 * hundred at a time, in flat typed arrays, with zero allocation per frame. The ground height is
 * sampled once at spawn and cached per particle (the road under a 0.6 s spark does not move).
 */
export class StreakField {
  constructor(ctx, depth, parent, { capacity = 512, mode = 'hot' } = {}) {
    this.ctx = ctx;
    this.depth = depth;
    this.parent = parent;
    this.mode = mode;
    this._wantCapacity = capacity;
    this.count = 0;
    this.capacity = 0;
  }

  init() {
    this._build(this._wantCapacity);
    return this;
  }

  _build(capacity) {
    const scene = this.parent;
    capacity = Math.max(32, capacity | 0);
    if (this.mesh) {
      scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.capacity = capacity;
    this.count = 0;

    // ---- simulation pool (structure-of-arrays) ----
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    // life, maxLife, width, lengthScale
    this.data = new Float32Array(capacity * 4);
    // groundY, drag, gravity, restitution
    this.phys = new Float32Array(capacity * 4);
    // heat, flickerSeed, spin, glow
    this.extra = new Float32Array(capacity * 4);
    // how much of the camera's own motion to subtract when orienting the streak
    this.rel = new Float32Array(capacity);

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    base.dispose();

    this.aPos = this._attr(geo, 'iPos', 3, capacity);
    this.aVel = this._attr(geo, 'iVel', 3, capacity);
    this.aColor = this._attr(geo, 'iColor', 3, capacity);
    this.aData = this._attr(geo, 'iData', 4, capacity); // width, len, lifeU, heat
    this.aExtra = this._attr(geo, 'iExtra', 4, capacity); // flicker, spin, glow, spare
    this._attrs = [this.aPos, this.aVel, this.aColor, this.aData, this.aExtra];

    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = makeStreakMaterial(this.depth, this.mode);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = this.mode === 'hot' ? 24 : 18;
    this.mesh.matrixAutoUpdate = false;
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

  /** All-number signature — never allocates. Returns false if the pool is saturated. */
  spawn(
    px, py, pz,
    vx, vy, vz,
    life, width, lengthScale,
    r, g, b,
    heat, groundY, drag, gravity, restitution, spin, glow, camRel = 0.35
  ) {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    const o3 = i * 3;
    this.pos[o3] = px;
    this.pos[o3 + 1] = py;
    this.pos[o3 + 2] = pz;
    this.vel[o3] = vx;
    this.vel[o3 + 1] = vy;
    this.vel[o3 + 2] = vz;
    this.col[o3] = r;
    this.col[o3 + 1] = g;
    this.col[o3 + 2] = b;
    const o4 = i * 4;
    this.data[o4] = life;
    this.data[o4 + 1] = life;
    this.data[o4 + 2] = width;
    this.data[o4 + 3] = lengthScale;
    this.phys[o4] = groundY;
    this.phys[o4 + 1] = drag;
    this.phys[o4 + 2] = gravity;
    this.phys[o4 + 3] = restitution;
    this.extra[o4] = heat;
    this.extra[o4 + 1] = Math.random() * 100;
    this.extra[o4 + 2] = spin;
    this.extra[o4 + 3] = glow;
    this.rel[i] = camRel;
    return true;
  }

  update(dt) {
    const pos = this.pos;
    const vel = this.vel;
    const data = this.data;
    const phys = this.phys;
    const extra = this.extra;
    const col = this.col;

    let n = this.count;
    for (let i = 0; i < n; ) {
      const o4 = i * 4;
      data[o4] -= dt;
      if (data[o4] <= 0) {
        const last = --n;
        if (last !== i) this._swap(i, last);
        continue;
      }
      const o3 = i * 3;
      const drag = phys[o4 + 1];
      const damp = 1 - Math.min(drag * dt, 0.95);
      vel[o3] *= damp;
      vel[o3 + 1] *= damp;
      vel[o3 + 2] *= damp;
      vel[o3 + 1] -= phys[o4 + 2] * dt;

      pos[o3] += vel[o3] * dt;
      pos[o3 + 1] += vel[o3 + 1] * dt;
      pos[o3 + 2] += vel[o3 + 2] * dt;

      // ---- ground bounce ----
      const gy = phys[o4];
      const rest = phys[o4 + 3];
      if (rest > 0 && pos[o3 + 1] < gy + 0.02) {
        pos[o3 + 1] = gy + 0.02;
        if (vel[o3 + 1] < 0) {
          vel[o3 + 1] = -vel[o3 + 1] * rest;
          vel[o3] *= 0.62;
          vel[o3 + 2] *= 0.62;
          // Sparks lose their heat fast when they smack the tarmac.
          extra[o4] *= 0.72;
          phys[o4 + 3] = rest * 0.62;
          if (phys[o4 + 3] < 0.08) phys[o4 + 3] = 0;
        }
      }
      i++;
    }
    this.count = n;

    // ---- publish to the GPU ----
    const ap = this.aPos.array;
    const av = this.aVel.array;
    const ac = this.aColor.array;
    const ad = this.aData.array;
    const ae = this.aExtra.array;
    for (let i = 0; i < n; i++) {
      const o3 = i * 3;
      const o4 = i * 4;
      ap[o3] = pos[o3];
      ap[o3 + 1] = pos[o3 + 1];
      ap[o3 + 2] = pos[o3 + 2];
      av[o3] = vel[o3];
      av[o3 + 1] = vel[o3 + 1];
      av[o3 + 2] = vel[o3 + 2];
      ac[o3] = col[o3];
      ac[o3 + 1] = col[o3 + 1];
      ac[o3 + 2] = col[o3 + 2];
      ad[o4] = data[o4 + 2]; // width
      ad[o4 + 1] = data[o4 + 3]; // length scale
      ad[o4 + 2] = 1 - data[o4] / Math.max(data[o4 + 1], 1e-4); // lifeU 0..1
      ad[o4 + 3] = extra[o4]; // heat
      ae[o4] = extra[o4 + 1];
      ae[o4 + 1] = extra[o4 + 2];
      ae[o4 + 2] = extra[o4 + 3];
      ae[o4 + 3] = this.rel[i];
    }
    if (n > 0) {
      for (const a of this._attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
    }
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;

    const u = this.material.uniforms;
    u.uTime.value = this.ctx.time.elapsed;
    const cv = this.ctx.cameras?.velocity;
    if (cv) u.uCamVel.value.copy(cv);
    else u.uCamVel.value.set(0, 0, 0);
    const env = this.ctx.env;
    if (this.mode === 'cool') {
      if (env?.sunDirection) u.uSunDir.value.copy(env.sunDirection);
      const sun = env?.sunLight;
      if (sun) u.uSunColor.value.copy(sun.color).multiplyScalar(Math.max(sun.intensity, 0) * 0.4);
      const hemi = env?.hemi;
      if (hemi) u.uAmbient.value.copy(hemi.color).multiplyScalar(Math.max(hemi.intensity, 0) * 0.5);
    }
    const fog = this.ctx.scene.fog;
    if (fog) {
      u.uFogColor.value.copy(fog.color);
      u.uFogDensity.value = fog.density ?? 0;
    } else u.uFogDensity.value = 0;
  }

  _swap(i, j) {
    const a3 = i * 3;
    const b3 = j * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[a3 + k] = this.pos[b3 + k];
      this.vel[a3 + k] = this.vel[b3 + k];
      this.col[a3 + k] = this.col[b3 + k];
    }
    const a4 = i * 4;
    const b4 = j * 4;
    for (let k = 0; k < 4; k++) {
      this.data[a4 + k] = this.data[b4 + k];
      this.phys[a4 + k] = this.phys[b4 + k];
      this.extra[a4 + k] = this.extra[b4 + k];
    }
    this.rel[i] = this.rel[j];
  }

  dispose() {
    this.parent.remove(this.mesh);
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}

function makeStreakMaterial(depth, mode) {
  const hot = mode === 'hot';
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: hot ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uMap: { value: sparkStreak() },
      uTime: { value: 0 },
      uCamVel: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0.4, -0.6, 0.7) },
      uSunColor: { value: new THREE.Color(1, 0.8, 0.6) },
      uAmbient: { value: new THREE.Color(0.3, 0.35, 0.45) },
      uFogColor: { value: new THREE.Color(0.6, 0.7, 0.8) },
      uFogDensity: { value: 0.0004 },
      ...depth.uniforms,
    },
    vertexShader: /* glsl */ `
      attribute vec3 iPos;
      attribute vec3 iVel;    // world-space velocity — drives the stretch, framerate-independent
      attribute vec3 iColor;
      attribute vec4 iData;   // width, lengthScale, lifeU, heat
      attribute vec4 iExtra;  // flickerSeed, spin, glow, spare

      uniform float uTime;
      uniform vec3 uCamVel;

      varying vec2 vUv;
      varying vec3 vColor;
      varying float vLifeU, vHeat, vViewZ, vFlicker, vGlow;

      void main(){
        vec4 mv = viewMatrix * vec4(iPos, 1.0);
        // Orient against the *apparent* velocity. A flame trailing a car doing 230 km/h shares
        // almost all of that motion with the chase camera; without subtracting the camera's own
        // velocity the jet points forwards down the lens instead of streaming out the back.
        vec3 relVel = iVel - uCamVel * iExtra.w;
        vec3 velView = (viewMatrix * vec4(relVel, 0.0)).xyz;
        float speed = length(velView);

        // Streak axis in view space. When the particle flies straight down the lens axis its
        // screen projection degenerates, so bias toward screen-space and fall back to "up".
        vec3 dir;
        if (speed < 1e-4) {
          dir = vec3(0.0, 1.0, 0.0);
        } else {
          vec3 d = velView / speed;
          vec2 onScreen = d.xy;
          float m = length(onScreen);
          dir = m < 0.10 ? vec3(0.0, 1.0, 0.0) : normalize(vec3(onScreen, d.z * 0.30));
        }
        vec3 right = normalize(cross(dir, vec3(0.0, 0.0, 1.0)));

        float w = iData.x;
        // Tumbling debris foreshortens as it spins.
        float spin = iExtra.y;
        w *= (spin != 0.0) ? (0.32 + 0.68 * abs(cos(spin * uTime + iExtra.x))) : 1.0;

        float stretch = clamp(speed * iData.y, w * 1.1, w * 44.0);

        float along = uv.y;                       // 0 = tail, 1 = head
        vec3 offset = right * (position.x * w) - dir * ((1.0 - along) * stretch);
        vec3 viewPos = mv.xyz + offset;

        vUv = uv;
        vColor = iColor;
        vLifeU = iData.z;
        vHeat = iData.w;
        vFlicker = iExtra.x;
        vGlow = iExtra.z;
        vViewZ = -viewPos.z;

        gl_Position = projectionMatrix * vec4(viewPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uMap;
      uniform float uTime, uFogDensity;
      uniform vec3 uFogColor, uSunDir, uSunColor, uAmbient;

      varying vec2 vUv;
      varying vec3 vColor;
      varying float vLifeU, vHeat, vViewZ, vFlicker, vGlow;

      ${SOFT_DEPTH_GLSL}

      // Blackbody-ish ramp: white-hot -> yellow -> orange -> ember red -> dead.
      vec3 heatRamp(float h){
        vec3 c = mix(vec3(0.55, 0.03, 0.0), vec3(1.0, 0.28, 0.02), smoothstep(0.0, 0.35, h));
        c = mix(c, vec3(1.0, 0.62, 0.14), smoothstep(0.30, 0.66, h));
        c = mix(c, vec3(1.0, 0.92, 0.65), smoothstep(0.62, 0.88, h));
        c = mix(c, vec3(1.0, 1.0, 1.0), smoothstep(0.88, 1.0, h));
        return c;
      }

      void main(){
        vec4 tex = texture2D(uMap, vUv);
        float a = tex.a;
        if (a < 0.01) discard;

        float fade = pow(1.0 - vLifeU, 0.85);
        // Sparks sputter — a per-particle flicker keeps them from looking like tracer fire.
        float flick = 0.72 + 0.28 * sin(uTime * (38.0 + vFlicker) + vFlicker * 6.3);

        vec3 col;
        float alpha;
        #ifdef HOT
          float h = clamp(vHeat * fade, 0.0, 1.0);
          col = heatRamp(h) * vColor;
          col *= (0.55 + 3.4 * h) * flick;
          col += vColor * tex.g * h * 2.6;             // incandescent head
          alpha = a * fade * clamp(vHeat * 1.4, 0.0, 1.0);
        #else
          vec3 N = normalize(vec3((vUv - 0.5) * 2.0, 0.9));
          float ndl = clamp(dot(N, normalize(-uSunDir)) * 0.5 + 0.5, 0.0, 1.0);
          col = vColor * (uAmbient + uSunColor * ndl);
          alpha = a * fade;
        #endif

        vec2 suv = gl_FragCoord.xy * uDepthParams.zw;
        alpha *= vfxSoftFade(suv, vViewZ, 0.35);
        alpha *= smoothstep(0.25, 0.7, vViewZ);
        if (alpha < 0.004) discard;

        float fogAmt = 1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ);
        #ifdef HOT
          col *= (1.0 - clamp(fogAmt, 0.0, 1.0) * 0.75);
        #else
          col = mix(col, uFogColor, clamp(fogAmt, 0.0, 1.0));
        #endif

        gl_FragColor = vec4(col * alpha * (1.0 + vGlow), alpha);
      }
    `,
    defines: hot ? { HOT: '' } : {},
  });
}
