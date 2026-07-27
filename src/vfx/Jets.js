import * as THREE from 'three';
import { noiseTile } from './vfxTextures.js';

/**
 * Combustion cores for NOS jets and backfire flame licks.
 *
 * The particle systems give a jet its spray and its soot, but the *core* of a flame is a solid
 * emissive volume, and billboards cannot fake that from the side. So each active exhaust port
 * gets a real lathe-profile flame body: additive, rim-boosted (more path length at the
 * silhouette = brighter edge, which is how a real jet looks), with travelling shock diamonds and
 * noise flicker.
 *
 * Slots are pooled and driven by key; a slot that stops being driven fades out and is recycled.
 */
const MODE = { nos: 0, backfire: 1 };

export class Jets {
  constructor(ctx, parent, capacity = 6) {
    this.ctx = ctx;
    this.parent = parent;
    this._wantCapacity = capacity;
    this.slots = [];
    this.enabled = true;
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  init() {
    this._build(this._wantCapacity);
    return this;
  }

  _build(capacity) {
    for (const s of this.slots) {
      this.parent.remove(s.mesh);
      s.mesh.geometry.dispose();
    }
    this.slots.length = 0;
    capacity = Math.max(0, capacity | 0);
    if (!this.material) this.material = makeJetMaterial();

    // Teardrop profile: narrow at the pipe, swells, then tapers to a long point.
    const pts = [];
    const N = 12;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const rad = Math.sin(Math.pow(t, 0.55) * Math.PI) * 0.5 + 0.02;
      pts.push(new THREE.Vector2(Math.max(rad * (1 - t * 0.35), 0.006), t));
    }

    for (let i = 0; i < capacity; i++) {
      const geo = new THREE.LatheGeometry(pts, 14);
      geo.rotateX(Math.PI / 2); // +Y -> +Z (the car's rearward axis)
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 25;
      mesh.visible = false;
      mesh.matrixAutoUpdate = true;
      this.parent.add(mesh);
      this.slots.push({
        mesh,
        key: null,
        driven: false,
        fade: 0,
        strength: 0,
        life: 0,
        mode: MODE.nos,
        maxLife: 1,
        target: null,
        seed: Math.random() * 30,
      });
    }
  }

  setCapacity(n) {
    if (n === this.slots.length) return;
    this._build(n);
  }

  _slotFor(key) {
    for (const s of this.slots) if (s.key === key) return s;
    for (const s of this.slots)
      if (!s.key) {
        s.key = key;
        s.fade = 0;
        s.life = 0;
        return s;
      }
    // steal the weakest
    let best = null;
    for (const s of this.slots) if (!best || s.fade * s.strength < best.fade * best.strength) best = s;
    if (best) {
      best.key = key;
      best.fade = 0;
      best.life = 0;
    }
    return best;
  }

  /** Continuous jet — call every frame while it should burn. */
  drive(key, target, strength, mode = 'nos') {
    if (!this.enabled || !target) return;
    const s = this._slotFor(key);
    if (!s) return;
    s.driven = true;
    s.target = target;
    s.strength = strength;
    s.mode = MODE[mode] ?? 0;
    s.life = 0;
  }

  /** One-shot flame lick (backfire). */
  pulse(key, target, strength, life, mode = 'backfire') {
    if (!this.enabled || !target) return;
    const s = this._slotFor(key);
    if (!s) return;
    s.driven = true;
    s.target = target;
    s.strength = strength;
    s.mode = MODE[mode] ?? 1;
    s.life = life;
    s.maxLife = life;
    s.fade = 0.05;
  }

  update(dt) {
    const u = this.material.uniforms;
    u.uTime.value = this.ctx.time.elapsed;

    for (const s of this.slots) {
      if (s.life > 0) {
        s.life -= dt;
        // Backfire envelope: instant attack, quick decay — a lick, not a fade.
        const u = Math.max(s.life, 0) / Math.max(s.maxLife, 1e-4);
        s.fade = u > 0.82 ? (1.0 - u) / 0.18 : Math.pow(u / 0.82, 0.65);
        if (s.life <= 0) s.fade = 0;
      } else {
        const target = s.driven ? 1 : 0;
        const rate = s.driven ? 22 : 12;
        s.fade += (target - s.fade) * (1 - Math.exp(-rate * dt));
      }
      s.driven = false;

      if (s.fade < 0.01 || !s.target) {
        if (s.mesh.visible) s.mesh.visible = false;
        if (s.fade < 0.01) {
          s.key = null;
          s.target = null;
        }
        continue;
      }

      s.target.updateWorldMatrix(true, false);
      s.target.matrixWorld.decompose(this._p, this._q, this._s);
      s.mesh.position.copy(this._p);
      s.mesh.quaternion.copy(this._q);

      const amp = s.fade * s.strength;
      const flick = 0.86 + 0.14 * Math.sin(this.ctx.time.elapsed * 47 + s.seed * 9.1);
      const len = (s.mode === MODE.nos ? 1.55 : 0.85) * amp * flick;
      const rad = (s.mode === MODE.nos ? 0.115 : 0.16) * (0.7 + 0.5 * amp);
      s.mesh.scale.set(rad, rad, Math.max(len, 0.02));
      s.mesh.visible = true;
      s.mesh.userData.mode = s.mode;
      s.mesh.userData.amp = amp;
      s.mesh.userData.seed = s.seed;
      s.mesh.onBeforeRender = onBeforeJet;
    }
  }

  dispose() {
    for (const s of this.slots) {
      this.parent.remove(s.mesh);
      s.mesh.geometry.dispose();
    }
    this.slots.length = 0;
    this.material?.dispose();
  }
}

function onBeforeJet(renderer, scene, camera, geometry, material) {
  const u = material.uniforms;
  u.uMode.value = this.userData.mode ?? 0;
  u.uAmp.value = this.userData.amp ?? 1;
  u.uSeed.value = this.userData.seed ?? 0;
  void renderer;
  void scene;
  void camera;
  void geometry;
}

function makeJetMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uNoise: { value: noiseTile() },
      uTime: { value: 0 },
      uMode: { value: 0 },
      uAmp: { value: 1 },
      uSeed: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vN, vV;
      void main(){
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uNoise;
      uniform float uTime, uMode, uAmp, uSeed;
      varying vec2 vUv;
      varying vec3 vN, vV;

      void main(){
        float along = clamp(vUv.y, 0.0, 1.0);     // 0 = pipe, 1 = tip

        // Turbulent flicker rolling down the jet.
        vec3 n = texture2D(uNoise, vec2(vUv.x * 2.0 + uSeed * 0.11, along * 0.75 - uTime * 1.9)).rgb;
        float turb = 0.65 + 0.7 * n.r;

        // Shock diamonds — the give-away that this is a supersonic jet and not a candle.
        float shock = 0.5 + 0.5 * sin(along * 34.0 - uTime * 26.0 + uSeed);
        shock = pow(shock, 3.0);

        vec3 nos = mix(vec3(0.55, 0.85, 1.0), vec3(0.16, 0.34, 1.0), smoothstep(0.05, 0.75, along));
        nos = mix(vec3(1.0, 1.0, 1.0), nos, smoothstep(0.0, 0.22, along));
        nos = mix(nos, vec3(0.42, 0.22, 0.9), smoothstep(0.62, 1.0, along));

        vec3 fire = mix(vec3(1.0, 0.95, 0.72), vec3(1.0, 0.42, 0.06), smoothstep(0.02, 0.55, along));
        fire = mix(fire, vec3(0.62, 0.10, 0.01), smoothstep(0.55, 1.0, along));

        vec3 col = mix(nos, fire, step(0.5, uMode));
        col *= turb;
        col += vec3(0.9, 0.96, 1.0) * shock * (1.0 - step(0.5, uMode)) * 0.55;
        col += vec3(1.0, 0.75, 0.35) * shock * step(0.5, uMode) * 0.30;

        // Rim boost: more optical path length at the silhouette.
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.15);
        float body = (0.30 + 0.85 * fres);

        float taper = pow(1.0 - along, 0.55) * smoothstep(0.0, 0.06, along);
        float a = taper * body * uAmp * turb;
        a *= mix(1.0, 1.55, step(0.5, 1.0 - uMode));
        if (a < 0.004) discard;

        gl_FragColor = vec4(col * a * 2.2, a);
      }
    `,
  });
}
