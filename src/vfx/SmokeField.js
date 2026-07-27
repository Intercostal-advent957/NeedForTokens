import * as THREE from 'three';
import { SOFT_DEPTH_GLSL } from './DepthPass.js';
import { smokePuff } from './vfxTextures.js';

/**
 * The workhorse: ONE draw call of GPU-simulated, lit, soft billboards.
 *
 * Every puff in the game — tyre smoke, dirt plumes, grass spray, road mist, exhaust, rain
 * splashes, backfire soot — is an instance in this buffer. The simulation is *analytic*: the
 * vertex shader evaluates position/size/rotation from the spawn parameters and `uTime`, so the
 * CPU cost per frame is exactly zero once a particle exists, and there is no per-frame
 * allocation anywhere.
 *
 * Lighting: each fragment builds a spherical fake normal from the billboard basis, then
 * evaluates wrapped diffuse from the sun, hemispherical ambient, a sun-side silhouette rim, a
 * back-scatter "silver lining" term and a Beer–Lambert style interior occlusion driven by the
 * puff's own optical thickness. Result reads as volume rather than as a decal.
 */

const FLOATS = {
  POS: 3, // spawn position
  VEL: 3, // spawn velocity
  TIME: 4, // spawnTime, life, seed, groundY
  SIZE: 4, // size0, size1, rot0, rotSpeed
  COLOR: 4, // r, g, b, opacity
  PARAM: 4, // turbulence, drag, buoyancy, glow
};

export class SmokeField {
  constructor(ctx, depth, parent, capacity = 2400) {
    this.ctx = ctx;
    this.depth = depth;
    this.parent = parent;
    this.capacity = 0;
    this.head = 0;
    this.live = 0;
    this._dirtyLo = Infinity;
    this._dirtyHi = -1;
    this._wrapped = false;
    this.mesh = null;
    this._wantCapacity = capacity;
    // Latest time at which any live particle expires — lets the owner skip the depth pre-pass
    // entirely on frames where nothing needs a soft edge.
    this.aliveUntil = -1;
    // scratch, reused forever
    this._deathClock = null;
  }

  init() {
    this._build(this._wantCapacity);
    return this;
  }

  _build(capacity) {
    const scene = this.parent;
    capacity = Math.max(64, capacity | 0);
    if (this.mesh) {
      scene.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.capacity = capacity;
    this.head = 0;
    this.live = 0;

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    base.dispose();

    this.aPos = this._attr(geo, 'iPos', FLOATS.POS, capacity);
    this.aVel = this._attr(geo, 'iVel', FLOATS.VEL, capacity);
    this.aTime = this._attr(geo, 'iTime', FLOATS.TIME, capacity);
    this.aSize = this._attr(geo, 'iSize', FLOATS.SIZE, capacity);
    this.aColor = this._attr(geo, 'iColor', FLOATS.COLOR, capacity);
    this.aParam = this._attr(geo, 'iParam', FLOATS.PARAM, capacity);
    this._attrs = [this.aPos, this.aVel, this.aTime, this.aSize, this.aColor, this.aParam];
    this._deathClock = new Float32Array(capacity); // spawnTime + life, CPU-side liveness

    geo.instanceCount = capacity;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    geo.frustumCulled = false;

    this.material = makeSmokeMaterial(this.depth);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
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

  /**
   * Spawn one puff. All arguments are plain numbers so this never allocates.
   * `glow` > 0 pushes the particle toward additive (used for spray, splashes, hot soot).
   */
  spawn(
    px, py, pz,
    vx, vy, vz,
    size0, size1, life,
    r, g, b, opacity,
    turbulence, drag, buoyancy, glow,
    groundY, rotSpeed
  ) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) this._wrapped = true;

    const now = this.ctx.time.elapsed;
    let o = i * 3;
    this.aPos.array[o] = px;
    this.aPos.array[o + 1] = py;
    this.aPos.array[o + 2] = pz;
    this.aVel.array[o] = vx;
    this.aVel.array[o + 1] = vy;
    this.aVel.array[o + 2] = vz;

    o = i * 4;
    const t = this.aTime.array;
    t[o] = now;
    t[o + 1] = life;
    t[o + 2] = (i * 0.6180339887) % 1.0 * 37.0 + Math.random() * 12.0;
    t[o + 3] = groundY;

    const s = this.aSize.array;
    s[o] = size0;
    s[o + 1] = size1;
    s[o + 2] = Math.random() * 6.2831853;
    s[o + 3] = rotSpeed;

    const c = this.aColor.array;
    c[o] = r;
    c[o + 1] = g;
    c[o + 2] = b;
    c[o + 3] = opacity;

    const p = this.aParam.array;
    p[o] = turbulence;
    p[o + 1] = drag;
    p[o + 2] = buoyancy;
    p[o + 3] = glow;

    this._deathClock[i] = now + life;
    if (this._deathClock[i] > this.aliveUntil) this.aliveUntil = this._deathClock[i];
    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
  }

  /** Cheap liveness count for the debug panel / budget bookkeeping. */
  countLive() {
    const now = this.ctx.time.elapsed;
    let n = 0;
    const d = this._deathClock;
    for (let i = 0; i < d.length; i++) if (d[i] > now) n++;
    return n;
  }

  update(dt) {
    void dt;
    const u = this.material.uniforms;
    const ctx = this.ctx;
    u.uTime.value = ctx.time.elapsed;

    const env = ctx.env;
    if (env?.sunDirection) u.uSunDir.value.copy(env.sunDirection);
    const sun = env?.sunLight;
    if (sun) {
      u.uSunColor.value.copy(sun.color).multiplyScalar(Math.max(sun.intensity, 0.0) * 0.42);
    }
    const hemi = env?.hemi;
    if (hemi) {
      const hi = Math.max(hemi.intensity, 0) * 0.55;
      u.uAmbSky.value.copy(hemi.color).multiplyScalar(hi);
      u.uAmbGround.value.copy(hemi.groundColor).multiplyScalar(hi * 0.8);
    }
    const fog = ctx.scene.fog;
    if (fog) {
      u.uFogColor.value.copy(fog.color);
      u.uFogDensity.value = fog.density ?? 0;
    } else {
      u.uFogDensity.value = 0;
    }
    u.uWetness.value = env?.wetness ?? 0;

    // Headlight cone, taken from the player car each frame.
    const player = ctx.player;
    const dark = 1 - Math.min(Math.max((env?.sunLight?.intensity ?? 1) / 1.2, 0), 1);
    const beam = Math.max(dark, Math.min((env?.rainIntensity ?? 0) * 0.8, 0.8));
    if (player?.state && beam > 0.05) {
      const st = player.state;
      _fwd.set(0, 0, -1).applyQuaternion(st.quaternion);
      _up2.set(0, 1, 0).applyQuaternion(st.quaternion);
      u.uHeadPos.value.copy(st.position).addScaledVector(_fwd, 1.9).addScaledVector(_up2, 0.45);
      u.uHeadDir.value.copy(_fwd);
      u.uHeadColor.value.setRGB(1.0, 0.95, 0.86).multiplyScalar(beam * 2.6);
    } else {
      u.uHeadColor.value.setRGB(0, 0, 0);
    }

    // Flush only the slice of the ring we actually touched.
    if (this._dirtyHi >= 0) {
      const full = this._wrapped;
      for (const a of this._attrs) {
        a.clearUpdateRanges();
        if (!full) a.addUpdateRange(this._dirtyLo * a.itemSize, (this._dirtyHi - this._dirtyLo + 1) * a.itemSize);
        a.needsUpdate = true;
      }
      this._dirtyLo = Infinity;
      this._dirtyHi = -1;
      this._wrapped = false;
    }
  }

  onResize() {}

  dispose() {
    this.parent.remove(this.mesh);
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}

function makeSmokeMaterial(depth) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, // premultiplied alpha: lets one pass do both
    blendDst: THREE.OneMinusSrcAlphaFactor, // absorptive smoke and glowing spray
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    side: THREE.DoubleSide,
    uniforms: {
      uMap: { value: smokePuff() },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.4, -0.6, 0.7) },
      uSunColor: { value: new THREE.Color(1.0, 0.78, 0.55) },
      uAmbSky: { value: new THREE.Color(0.32, 0.42, 0.58) },
      uAmbGround: { value: new THREE.Color(0.13, 0.11, 0.09) },
      uFogColor: { value: new THREE.Color(0.6, 0.7, 0.8) },
      uFogDensity: { value: 0.0004 },
      uWetness: { value: 0 },
      uNearFade: { value: 2.1 },
      // Player headlight cone — one analytic spot light so smoke, spray and dust glow inside
      // the beam at night. Worth far more than another 500 particles.
      uHeadPos: { value: new THREE.Vector3() },
      uHeadDir: { value: new THREE.Vector3(0, 0, -1) },
      uHeadColor: { value: new THREE.Color(0, 0, 0) },
      uHeadParams: { value: new THREE.Vector3(0.90, 0.55, 55) }, // cosInner, cosOuter, range
      ...depth.uniforms,
    },
    vertexShader: /* glsl */ `
      attribute vec3 iPos;
      attribute vec3 iVel;
      attribute vec4 iTime;   // spawnTime, life, seed, groundY
      attribute vec4 iSize;   // size0, size1, rot0, rotSpeed
      attribute vec4 iColor;  // rgb, opacity
      attribute vec4 iParam;  // turbulence, drag, buoyancy, glow

      uniform float uTime;

      varying vec2 vUv;
      varying vec4 vColor;
      varying float vGlow;
      varying float vViewZ;
      varying float vThick;
      varying vec3 vRight, vUpW, vFwd;
      varying vec3 vWorld;
      varying vec2 vSeedUv;

      // Cheap divergence-light turbulence field. Three phase-shifted sine lattices give a
      // convincing roil for a fraction of the cost of a real curl-of-noise.
      vec3 turb(vec3 p, float t){
        vec3 a = vec3(sin(p.y * 0.90 + t * 1.10), sin(p.z * 0.80 - t * 0.90), sin(p.x * 1.00 + t * 1.30));
        vec3 b = vec3(sin(p.z * 1.90 - t * 1.70), sin(p.x * 2.10 + t * 1.50), sin(p.y * 1.70 - t * 2.10));
        vec3 c = vec3(sin(p.x * 3.70 + t * 2.60), sin(p.y * 4.10 - t * 3.10), sin(p.z * 3.30 + t * 2.20));
        return a + 0.45 * b + 0.18 * c;
      }

      void main(){
        float age = uTime - iTime.x;
        float life = max(iTime.y, 0.0001);
        if (age < 0.0 || age > life) {
          // Dead: collapse behind the near plane so it is trivially clipped.
          gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
          vUv = vec2(0.0); vColor = vec4(0.0); vGlow = 0.0; vViewZ = 1.0; vThick = 0.0;
          vRight = vec3(1.0,0.0,0.0); vUpW = vec3(0.0,1.0,0.0); vFwd = vec3(0.0,0.0,1.0);
          vWorld = vec3(0.0); vSeedUv = vec2(0.0);
          return;
        }
        float u = age / life;

        // ---- analytic integration of the spawn velocity under linear drag ----
        float k = max(iParam.y, 0.0001);
        vec3 p = iPos + iVel * ((1.0 - exp(-k * age)) / k);
        p.y += iParam.z * age * age;                       // buoyancy / gravity

        // ---- turbulence, growing with age so young puffs stay coherent ----
        float tAmt = iParam.x * pow(age, 0.85);
        p += turb(p * 0.42 + iTime.z, uTime * 0.35 + iTime.z) * tAmt;

        float size = mix(iSize.x, iSize.y, pow(u, 0.62));

        // Puffs must not sink through the road they were kicked off.
        float floorY = iTime.w + size * 0.16;
        p.y = max(p.y, floorY);

        float rot = iSize.z + iSize.w * age;
        float cr = cos(rot), sr = sin(rot);
        vec2 q = vec2(position.x * cr - position.y * sr, position.x * sr + position.y * cr) * size;

        // Billboard basis extracted from the view matrix (world space).
        vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 camFwd   = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);

        vec3 world = p + camRight * q.x + camUp * q.y;
        vec4 mv = viewMatrix * vec4(world, 1.0);

        // Rotate the lighting basis with the sprite so the fake normal follows the texture.
        vRight = camRight * cr + camUp * sr;
        vUpW   = -camRight * sr + camUp * cr;
        vFwd   = camFwd;
        vWorld = world;

        vUv = uv;
        // Per-particle detail offset — without this every puff wears the same silhouette and a
        // plume reads as a row of identical stamps.
        vSeedUv = vec2(fract(iTime.z * 0.317), fract(iTime.z * 0.713));
        vViewZ = -mv.z;

        // Life curve: quick fade-in, long thinning tail. Bigger puffs are optically thinner.
        float fadeIn = smoothstep(0.0, 0.14, u);
        float fadeOut = pow(1.0 - u, 1.35);
        float thin = mix(1.0, 0.55, clamp((size - iSize.x) / max(iSize.y - iSize.x, 0.001), 0.0, 1.0));
        vColor = vec4(iColor.rgb, iColor.a * fadeIn * fadeOut * thin);
        vThick = iColor.a * fadeOut;
        vGlow = iParam.w;

        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uMap;
      uniform vec3 uSunDir, uSunColor, uAmbSky, uAmbGround, uFogColor;
      uniform float uFogDensity, uNearFade, uWetness;
      uniform vec3 uHeadPos, uHeadDir, uHeadColor, uHeadParams;

      varying vec2 vUv;
      varying vec4 vColor;
      varying float vGlow;
      varying float vViewZ;
      varying float vThick;
      varying vec3 vRight, vUpW, vFwd;
      varying vec3 vWorld;
      varying vec2 vSeedUv;

      ${SOFT_DEPTH_GLSL}

      void main(){
        vec4 tex = texture2D(uMap, vUv);
        // Second, decorrelated detail tap breaks the shared silhouette between neighbours.
        float det = texture2D(uMap, vUv * 0.83 + vSeedUv).g;
        float a = tex.a * mix(0.62, 1.42, det) * vColor.a;
        if (a < 0.004) discard;

        // ---- fake volumetric normal ----------------------------------------------------
        vec2 d = (vUv - 0.5) * 2.0;
        float r2 = dot(d, d);
        // Perturb by the coarse lobe channel so lighting picks up cauliflower structure.
        vec2 lob = (vec2(tex.b, tex.g) - 0.5) * 0.85;
        vec2 nxy = clamp(d + lob, vec2(-1.0), vec2(1.0));
        float nz = sqrt(max(1.0 - dot(nxy, nxy), 0.02));
        vec3 N = normalize(vRight * nxy.x + vUpW * nxy.y + vFwd * nz);

        vec3 L = normalize(-uSunDir);          // scene -> sun
        float ndl = dot(N, L);

        // Wrapped diffuse: clouds are not Lambertian, light bleeds around the terminator.
        float diff = pow(clamp((ndl + 0.62) / 1.62, 0.0, 1.0), 1.45);

        // ---- self-shadowing approximation ----------------------------------------------
        // Optical thickness peaks in the middle of the puff; Beer-Lambert it so the interior
        // goes dense and dark while the wispy rim stays bright.
        float thickness = tex.r * mix(0.7, 1.3, det) * vThick;
        float transmit = exp(-thickness * 4.2);
        float occ = mix(0.16, 1.0, transmit);

        // Bright sun-facing silhouette rim.
        float rim = smoothstep(0.22, 1.0, sqrt(r2)) * smoothstep(0.0, 0.75, ndl);

        // Back-scatter: looking down-sun through the puff makes it glow (silver lining).
        vec3 V = normalize(vWorld - cameraPosition);
        float back = pow(clamp(dot(normalize(uSunDir), V), 0.0, 1.0), 5.0);

        vec3 amb = mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5);
        vec3 albedo = vColor.rgb;

        vec3 col = albedo * (amb * mix(0.42, 1.05, transmit) + uSunColor * diff * occ);
        col += uSunColor * albedo * (rim * 0.85 + back * transmit * 1.35);

        // ---- headlight beam ------------------------------------------------------------------
        vec3 hv = uHeadPos - vWorld;
        float hd = length(hv);
        if (hd < uHeadParams.z) {
          hv /= max(hd, 1e-4);
          float cone = smoothstep(uHeadParams.y, uHeadParams.x, dot(-hv, uHeadDir));
          float atten = 1.0 / (1.0 + hd * hd * 0.045);
          float hndl = clamp(dot(N, hv) * 0.55 + 0.45, 0.0, 1.0);
          // Forward scatter: mist in front of a beam glows toward the observer.
          float fwd = pow(clamp(dot(uHeadDir, V), 0.0, 1.0), 3.0);
          col += albedo * uHeadColor * cone * atten * (hndl * occ + fwd * transmit * 0.9);
        }
        col *= mix(1.0, 0.82, uWetness * 0.5);   // wet-air smoke is duller

        // ---- soft particle + near fade --------------------------------------------------
        vec2 suv = gl_FragCoord.xy * uDepthParams.zw;
        float soft = vfxSoftFade(suv, vViewZ, 1.35 + vThick * 1.6);
        a *= soft;
        a *= smoothstep(uNearFade * 0.18, uNearFade, vViewZ);
        if (a < 0.004) discard;

        // ---- fog integration -------------------------------------------------------------
        float fogAmt = 1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ);
        col = mix(col, uFogColor, clamp(fogAmt, 0.0, 1.0));

        // Premultiplied output. vGlow pushes the RGB above the alpha so bright media
        // (spray, splash, hot soot) read as additive without a second draw call.
        gl_FragColor = vec4(col * a * (1.0 + vGlow * 2.2), a);
      }
    `,
  });
}

const _fwd = new THREE.Vector3();
const _up2 = new THREE.Vector3();
