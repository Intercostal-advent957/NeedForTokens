import * as THREE from 'three';
import { SOFT_DEPTH_GLSL } from './DepthPass.js';
import { rainStreak } from './vfxTextures.js';

/**
 * Camera-locked instanced rain volume.
 *
 * A fixed box of drops that follows the camera and wraps modulo the box height, so it can never
 * run out no matter how fast or how far the car travels. Positions are evaluated analytically in
 * the vertex shader from a per-instance seed — the CPU does nothing but move the box origin and
 * push a handful of uniforms.
 *
 * The streak direction is `fallVelocity - cameraVelocity`, which is why at 200 km/h the rain
 * appears to fly *at* the lens instead of falling: that relative-motion cue is most of what sells
 * a wet race.
 */
export class Rain {
  constructor(ctx, depth, parent, capacity = 3000) {
    this.ctx = ctx;
    this.depth = depth;
    this.parent = parent;
    this._wantCapacity = capacity;
    this.capacity = 0;
    this.intensity = 0;
    this._origin = new THREE.Vector3();
    this._camVel = new THREE.Vector3();
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

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    base.dispose();

    const seed = new Float32Array(capacity * 4);
    for (let i = 0; i < capacity; i++) {
      const o = i * 4;
      seed[o] = Math.random();
      seed[o + 1] = Math.random();
      seed[o + 2] = Math.random();
      seed[o + 3] = Math.random();
    }
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 4));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = makeRainMaterial(this.depth);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 22;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.geo = geo;
    scene.add(this.mesh);
  }

  setCapacity(n) {
    if (n === this.capacity) return;
    this._build(n);
  }

  update(dt) {
    void dt;
    const ctx = this.ctx;
    const env = ctx.env;
    const intensity = Math.min(env?.rainIntensity ?? 0, 1);
    this.intensity = intensity;
    if (intensity <= 0.001) {
      this.mesh.visible = false;
      this.geo.instanceCount = 0;
      return;
    }
    this.mesh.visible = true;
    // Thin the volume out at low intensity rather than just fading it — drizzle should have
    // fewer drops, not the same drops at low alpha.
    this.geo.instanceCount = Math.max(32, Math.floor(this.capacity * (0.30 + 0.70 * intensity)));

    const cam = ctx.camera;
    const u = this.material.uniforms;
    // Snap the box origin so the drops do not visibly shear when the camera jitters.
    this._origin.copy(cam.position);
    u.uOrigin.value.copy(this._origin);
    u.uTime.value = ctx.time.elapsed;
    u.uIntensity.value = intensity;

    const cv = ctx.cameras?.velocity;
    if (cv) this._camVel.copy(cv);
    else this._camVel.set(0, 0, 0);
    if (this._camVel.lengthSq() > 90000) this._camVel.setLength(300);
    u.uCamVel.value.copy(this._camVel);

    const sun = env?.sunLight;
    const hemi = env?.hemi;
    let lum = 0.16;
    if (sun) lum += Math.max(sun.intensity, 0) * 0.09;
    if (hemi) lum += Math.max(hemi.intensity, 0) * 0.22;
    u.uLum.value = Math.min(lum, 0.62);
    if (hemi) u.uTint.value.copy(hemi.color).lerp(WHITE, 0.55);

    const fog = ctx.scene.fog;
    u.uFogDensity.value = fog?.density ?? 0;
    if (fog) u.uFogColor.value.copy(fog.color);
  }

  dispose() {
    this.parent.remove(this.mesh);
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}

const WHITE = new THREE.Color(1, 1, 1);

function makeRainMaterial(depth) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uMap: { value: rainStreak() },
      uTime: { value: 0 },
      uOrigin: { value: new THREE.Vector3() },
      uCamVel: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(24, 15, 24) },
      uIntensity: { value: 0 },
      uLum: { value: 0.35 },
      uTint: { value: new THREE.Color(0.72, 0.79, 0.9) },
      uFogColor: { value: new THREE.Color(0.6, 0.7, 0.8) },
      uFogDensity: { value: 0.0004 },
      ...depth.uniforms,
    },
    vertexShader: /* glsl */ `
      attribute vec4 iSeed;
      uniform float uTime, uIntensity;
      uniform vec3 uOrigin, uBox, uCamVel;

      varying vec2 vUv;
      varying float vAlpha, vViewZ, vNearBoost;

      void main(){
        vec3 box = uBox;
        float span = box.y * 2.0;
        float speed = mix(16.0, 30.0, iSeed.w) * (0.75 + 0.45 * uIntensity);

        float prog = fract(iSeed.y + uTime * speed / span);
        vec3 p;
        p.x = (iSeed.x * 2.0 - 1.0) * box.x;
        p.z = (iSeed.z * 2.0 - 1.0) * box.z;
        p.y = box.y - prog * span;

        // Wind shear grows with the fall so the column leans.
        vec2 wind = vec2(2.6, -1.4) * uIntensity;
        p.xz += wind * (1.0 - prog) * 0.9;
        p += uOrigin;

        // Apparent velocity = fall - camera motion. This is what makes rain streak toward the
        // lens at speed instead of dropping straight down.
        vec3 apparent = vec3(wind.x, -speed, wind.y) - uCamVel;
        float aLen = length(apparent);
        vec3 dirW = aLen > 1e-4 ? apparent / aLen : vec3(0.0, -1.0, 0.0);

        vec4 mv = viewMatrix * vec4(p, 1.0);
        vec3 dirV = (viewMatrix * vec4(dirW, 0.0)).xyz;
        vec2 onScreen = dirV.xy;
        float m = length(onScreen);
        vec3 dir = m < 0.10 ? vec3(0.0, 1.0, 0.0) : normalize(vec3(onScreen, dirV.z * 0.25));
        vec3 right = normalize(cross(dir, vec3(0.0, 0.0, 1.0)));

        float w = mix(0.012, 0.030, iSeed.w);
        float len = clamp(aLen * 0.018, w * 3.0, 1.05);

        vec3 offset = right * (position.x * w) + dir * (position.y * len);
        vec3 viewPos = mv.xyz + offset;

        vViewZ = -viewPos.z;
        // Kill drops that are basically on the lens; they read as smears otherwise.
        vNearBoost = smoothstep(0.45, 1.6, vViewZ);
        float far = 1.0 - smoothstep(box.x * 0.65, box.x * 1.25, vViewZ);
        vAlpha = uIntensity * vNearBoost * mix(0.35, 1.0, far);
        vUv = uv;

        gl_Position = projectionMatrix * vec4(viewPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uMap;
      uniform float uLum, uFogDensity;
      uniform vec3 uTint, uFogColor;
      varying vec2 vUv;
      varying float vAlpha, vViewZ, vNearBoost;

      ${SOFT_DEPTH_GLSL}

      void main(){
        float a = texture2D(uMap, vUv).a * vAlpha * 0.44;
        if (a < 0.004) discard;
        vec2 suv = gl_FragCoord.xy * uDepthParams.zw;
        a *= vfxSoftFade(suv, vViewZ, 0.25);
        if (a < 0.004) discard;

        // A drop is a lens: mostly it transmits, with a bright refracted core.
        vec3 col = uTint * uLum * (0.85 + 0.9 * pow(texture2D(uMap, vUv).a, 3.0));
        float fogAmt = 1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ);
        col = mix(col, uFogColor, clamp(fogAmt, 0.0, 1.0) * 0.8);
        gl_FragColor = vec4(col * a * 1.10, a);
      }
    `,
  });
}
