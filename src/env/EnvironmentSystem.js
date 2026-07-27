import * as THREE from 'three';
import { clamp01, lerp } from '../core/MathX.js';
import { makeSkyMaterial } from './SkyShader.js';
import { installAtmosphericFog, FOG_UNIFORMS, writeVec3 } from './AtmosphereFog.js';
import { CascadedShadows, installCsmShaderPatch } from './CascadedShadows.js';
import { ENV_UNIFORMS } from './EnvUniforms.js';
import { PRESETS, solarPosition, lunarPosition, transmittance } from './EnvPresets.js';

/**
 * ENVIRONMENT — sky, IBL, sun/moon, cascaded shadows, atmosphere, weather.
 * CONTRACTS.md §6. Owned by the env lane; everything here lives under `src/env/`.
 *
 * ============================== PUBLIC API (contract §6) ==============================
 *   env.timeOfDay / setTimeOfDay(h)     env.preset / setPreset(name)
 *   env.sunDirection                    THREE.Vector3, points FROM the sun TO the scene
 *   env.sunLight                        THREE.DirectionalLight (cascade 0 of the CSM rig)
 *   env.hemi                            THREE.HemisphereLight
 *   env.envMap                          PMREM texture; also scene.environment + assets.envMap
 *   env.fogDensity  env.wetness  env.rainIntensity
 *   env.setWeather({ wetness, rain })
 *
 * ============================== ADDITIONS (never renames) =============================
 *   env.sunScreenPosition   THREE.Vector3 — sun in NDC. x,y in [-1,1]; z<1 means on-screen.
 *                           POST-FX LANE: this is your lens-flare / god-ray anchor. Convert
 *                           to pixels with ((x*0.5+0.5)*w, (0.5-y*0.5)*h). Valid every frame.
 *   env.sunVisibility       0..1, temporally smoothed. Combines: sun above horizon, sun in
 *                           front of the camera, on-screen margin, and an occlusion raycast
 *                           through physics when available. Multiply your flare/godray
 *                           intensity by this — it is already eased, do not re-smooth it.
 *   env.sunScreenValid      bool — false when the sun is behind the camera or set.
 *   env.moonLight           THREE.DirectionalLight — the night key.
 *   env.moonDirection       THREE.Vector3, FROM the moon TO the scene.
 *   env.sunAltitude         radians above the horizon.
 *   env.skyHorizonColor / env.skyZenithColor   linear HDR sky samples, updated on change.
 *   env.turbidity / setTurbidity(t)
 *   env.csm                 CascadedShadows rig (env.csm.lights[] are the 4 cascade lights)
 *   env.wetnessUniform      { value:number } shared uniform — see setWeather() docs below.
 *   env.uniforms            ENV_UNIFORMS from ./EnvUniforms.js (importable by any lane)
 */
export class EnvironmentSystem {
  constructor(ctx) {
    this.ctx = ctx;

    // These two global shader patches must land before the first program is compiled.
    // EnvironmentSystem is constructed in main.js before any system renders, so this is safe.
    installAtmosphericFog();
    installCsmShaderPatch();

    this.timeOfDay = 17.55;
    this.preset = 'goldenHour';
    this.turbidity = 4.3;
    this.sunDirection = new THREE.Vector3(0.4, -0.35, 0.85).normalize();
    this.moonDirection = new THREE.Vector3(0, -1, 0);
    this.sunAltitude = 0.3;
    this.fogDensity = 0.0005;
    this.wetness = 0;
    this.rainIntensity = 0;
    this.envMap = null;
    this.uniforms = ENV_UNIFORMS;
    this.wetnessUniform = ENV_UNIFORMS.wetness;

    this.sunScreenPosition = new THREE.Vector3(0, 0, 1);
    this.sunVisibility = 0;
    this.sunScreenValid = false;
    this.skyHorizonColor = new THREE.Color(0.5, 0.55, 0.62);
    this.skyZenithColor = new THREE.Color(0.15, 0.28, 0.6);
    this.fogColor = new THREE.Color(0.5, 0.55, 0.62);

    this._toSun = new THREE.Vector3(0, 0.5, -1);
    this._toMoon = new THREE.Vector3(0, 0.5, 1);
    this._sunTint = new THREE.Color();
    this._tmpV = new THREE.Vector3();
    this._tmpC = new THREE.Color();

    this._envDirty = true;
    this._envTimer = 0;
    this._envCooldown = 0;
    this._sunVisRaw = 0;
    this._matCache = new WeakMap();
  }

  async init() {
    const { scene, renderer, settings } = this.ctx;

    // ---------------------------------------------------------------- sky dome
    // Radius is comfortably inside camera.far (6000) and the vertex shader pins it to the far
    // plane anyway, so it never clips and never z-fights.
    this.skyMat = makeSkyMaterial();
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2000, 64, 40), this.skyMat);
    this.sky.frustumCulled = false;
    // Drawn LAST in the opaque pass, not first. The vertex shader pins the dome to the far
    // plane and the material never writes depth, so with LEQUAL depth testing every pixel the
    // city already covered is rejected before the (expensive) sky fragment shader ever runs.
    // In a dense street this is the difference between shading 2M sky fragments and ~200k —
    // measured at roughly half the total frame time on the hero shot.
    this.sky.renderOrder = 900;
    this.sky.name = 'Sky';
    scene.add(this.sky);

    // A private scene holding a second dome, used only to bake the IBL cube. Keeping it out
    // of the main scene means the capture is never contaminated by the world or the car.
    this._captureScene = new THREE.Scene();
    this._captureSky = new THREE.Mesh(this.sky.geometry, this.skyMat);
    this._captureSky.frustumCulled = false;
    this._captureScene.add(this._captureSky);

    // ---------------------------------------------------------------- lights
    this.csm = new CascadedShadows(scene, {
      cascades: settings.get('shadowCascades') ?? 3,
      mapSize: settings.get('shadowMapSize') ?? 2048,
      maxDistance: settings.get('shadowDistance') ?? 400,
      fade: 14,
    });
    this.csm.setMapSize(settings.get('shadowMapSize') ?? 2048);
    // Contract §6: env.sunLight is a DirectionalLight with cascaded shadows. Cascade 0 is the
    // canonical handle — colour/intensity are mirrored across every cascade by the rig.
    this.sunLight = this.csm.lights[0];

    this.moonLight = new THREE.DirectionalLight(0xa8c0ff, 0);
    this.moonLight.name = 'Moon';
    this.moonLight.castShadow = false;
    scene.add(this.moonLight, this.moonLight.target);

    this.hemi = new THREE.HemisphereLight(0x88a8dc, 0x53483a, 0.5);
    this.hemi.name = 'SkyFill';
    scene.add(this.hemi);

    // A dim, shadowless "bounce" light from the opposite side keeps unlit faces from going to
    // pure black without flattening the key. Standard practice, cheap, huge readability win.
    this.bounce = new THREE.DirectionalLight(0xffffff, 0);
    this.bounce.name = 'Bounce';
    scene.add(this.bounce, this.bounce.target);

    // ---------------------------------------------------------------- IBL plumbing
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileCubemapShader();
    this._makeCubeTarget(settings.get('envMapSize') ?? 256);

    scene.fog = new THREE.FogExp2(0x8fa6bd, this.fogDensity);

    this.setPreset(this.preset);
    this._refreshEnvMap(true);
    return this;
  }

  _makeCubeTarget(size) {
    const s = Math.max(64, Math.min(512, size));
    if (this._cubeSize === s) return;
    this._cubeSize = s;
    this.cubeRT?.dispose();
    this.cubeRT = new THREE.WebGLCubeRenderTarget(s, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.cubeCam?.dispose?.();
    this.cubeCam = new THREE.CubeCamera(1, 20000, this.cubeRT);
    this._envDirty = true;
  }

  // ==================================================================== time of day
  setTimeOfDay(h) {
    this.timeOfDay = ((h % 24) + 24) % 24;
    const sol = solarPosition(this.timeOfDay, this._toSun);
    this.sunAltitude = sol.altitude;
    this.sunDirection.copy(this._toSun).negate();
    lunarPosition(this.timeOfDay, this._toMoon);
    this.moonDirection.copy(this._toMoon).negate();
    this._applyLighting();
    this._envDirty = true;
  }

  setPreset(name) {
    const p = PRESETS[name] ? name : 'goldenHour';
    this.preset = p;
    this._p = PRESETS[p];
    this.turbidity = this._p.turbidity;
    this.setTimeOfDay(this._p.hour);
    this._envDirty = true;
  }

  setTurbidity(t) {
    this.turbidity = Math.max(1, Math.min(16, t));
    this._applyLighting();
    this._envDirty = true;
  }

  /**
   * WEATHER. `wetness` 0..1 darkens + smooths + desaturates surfaces and raises reflectivity;
   * `rain` 0..1 overcasts the sky, kills the sun and raises the fog.
   *
   * MATERIALS LANE: the authoritative value lives in a shared uniform object so you can bind
   * it directly and animate puddles/roughness in your own shaders:
   *
   *     import { ENV_UNIFORMS } from '../env/EnvUniforms.js';
   *     shader.uniforms.uWetness = ENV_UNIFORMS.wetness;   // { value: 0..1 }
   *
   * It is also mirrored onto `assets.wetness` (created by us if you have not defined it) and
   * onto `env.wetnessUniform`. While `assets.wetness` is absent we additionally apply a
   * conservative runtime fallback to WorldSystem's materials (roughness / envMapIntensity /
   * albedo only, originals cached and restored) so wetness is visible today. Define
   * `assets.wetness` and the fallback switches itself off.
   */
  setWeather({ wetness = this.wetness, rain = this.rainIntensity } = {}) {
    this.wetness = clamp01(wetness);
    this.rainIntensity = clamp01(rain);
    ENV_UNIFORMS.wetness.value = this.wetness;
    ENV_UNIFORMS.rainIntensity.value = this.rainIntensity;
    const assets = this.ctx.assets;
    if (assets) {
      if (typeof assets.wetness === 'object' && assets.wetness) assets.wetness.value = this.wetness;
      else if (assets.wetness === undefined) assets.wetness = this.wetness;
      else assets.wetness = this.wetness;
    }
    this._applyWetMaterials();
    this._applyLighting();
    this._envDirty = true;
  }

  // ==================================================================== lighting solve
  _applyLighting() {
    const p = this._p || PRESETS.goldenHour;
    const { renderer, settings } = this.ctx;
    if (!this.sunLight) return;

    const rain = this.rainIntensity;
    const wet = this.wetness;
    // Rain pushes the sky toward a storm regardless of preset.
    const turb = lerp(this.turbidity, 13.0, rain * 0.85);
    const cloud = Math.min(1, (p.cloud ?? 0) + rain * 0.95);
    const sunY = this._toSun.y;
    const above = clamp01((sunY + 0.075) / 0.16); // 1 when clearly up, 0 once set

    // ---- key light: colour is atmospheric transmittance, never authored ----------------
    transmittance(sunY, turb, this._sunTint);
    const lum = 0.2126 * this._sunTint.r + 0.7152 * this._sunTint.g + 0.0722 * this._sunTint.b;
    // Renormalise hue so low sun stays saturated but doesn't just vanish; the *intensity*
    // curve below is what actually dims it.
    const norm = Math.max(this._sunTint.r, this._sunTint.g, this._sunTint.b, 1e-3);
    this._tmpC.copy(this._sunTint).multiplyScalar(1 / norm);
    const cloudKill = 1 - cloud * 0.88;
    const sunI = (p.sunI ?? 4) * above * Math.pow(Math.max(lum, 0), 0.42) * cloudKill;
    this.csm.setColorIntensity(this._tmpC, sunI);
    this.csm.setEnabled(sunI > 0.05);

    // ---- moon: the night key -------------------------------------------------------------
    const moonUp = clamp01((this._toMoon.y + 0.03) / 0.2);
    const nightAmt = 1 - above;
    const moonI = (p.moonI ?? 0.32) * moonUp * nightAmt * (1 - cloud * 0.9);
    this.moonLight.intensity = moonI;
    this.moonLight.color.setHex(0x9fb6ef);
    this.moonLight.position.copy(this._toMoon).multiplyScalar(400);
    this.moonLight.target.position.set(0, 0, 0);
    this.moonLight.target.updateMatrixWorld();

    // ---- sky sample colours (drive fog, hemi and aerial perspective) ---------------------
    this._sampleSky();

    // ---- hemisphere fill ------------------------------------------------------------------
    const hemiBoost = 1 + cloud * 0.55;
    this.hemi.color.copy(this.skyZenithColor).lerp(this.skyHorizonColor, 0.45);
    this.hemi.color.multiplyScalar(1 / Math.max(this.hemi.color.b, this.hemi.color.g, this.hemi.color.r, 0.05));
    this.hemi.color.lerp(this._tmpC.setHex(p.hemiSky), 0.5);
    this.hemi.groundColor.setHex(p.hemiGround);
    this.hemi.intensity = (p.hemiI ?? 0.5) * hemiBoost;

    // ---- bounce ---------------------------------------------------------------------------
    this.bounce.color.setHex(p.hemiGround).lerp(this._tmpC.setHex(0xffffff), 0.35);
    this.bounce.intensity = 0.10 + sunI * 0.055 + cloud * 0.12;
    this.bounce.position.set(-this.sunDirection.x, 0.55, -this.sunDirection.z).multiplyScalar(300);
    this.bounce.target.position.set(0, 0, 0);
    this.bounce.target.updateMatrixWorld();

    // ---- exposure --------------------------------------------------------------------------
    // Wet roads are mirrors, so pull back a touch; rain kills contrast so lift it.
    const exposure = (p.exposure ?? 1) * (1 - wet * 0.10) * (1 + rain * 0.10);
    renderer.toneMappingExposure = exposure;
    this.exposure = exposure;

    // ---- IBL level ---------------------------------------------------------------------------
    // The greybox world ships very dark albedos; a real sky IBL at the right level is the only
    // thing that keeps them off pure black. scene.environmentIntensity is a scene-wide multiplier
    // and belongs to this lane (we own scene.environment).
    this.ctx.scene.environmentIntensity = (p.envIntensity ?? 1.3) * (1 + wet * 0.35);

    // ---- fog ----------------------------------------------------------------------------------
    this.fogDensity = (p.fogDensity ?? 0.0005) * (1 + rain * 1.9) * (1 + wet * 0.25);
    this._writeFogUniforms(p, cloud, rain);

    // ---- sky shader ------------------------------------------------------------------------------
    const u = this.skyMat.uniforms;
    u.uSunDir.value.copy(this._toSun);
    u.uMoonDir.value.copy(this._toMoon);
    u.uTurbidity.value = turb;
    u.uMieCoeff.value = 1 + cloud * 0.4;
    u.uMieG.value = p.mieG ?? 0.78;
    u.uSunIntensity.value = 1.0;
    u.uNight.value = clamp01(1 - clamp01((sunY + 0.16) / 0.20));
    u.uStars.value = (p.stars ?? 1) * (1 - cloud);
    u.uCloud.value = cloud;
    u.uCloudColor.value.setHex(p.cloudColor ?? 0x8e99a6);
    u.uGroundColor.value.setHex(0x2a2b26);

    void settings;
  }

  /** Evaluates the sky model on the CPU for the zenith and for the horizon behind the sun. */
  _sampleSky() {
    const turb = lerp(this.turbidity, 13.0, this.rainIntensity * 0.85);
    const p = this._p || PRESETS.goldenHour;
    const cloud = Math.min(1, (p.cloud ?? 0) + this.rainIntensity * 0.95);
    const sunY = this._toSun.y;
    const above = clamp01((sunY + 0.18) / 0.23);

    // Zenith: 90° from a mid-height sun, mostly Rayleigh.
    const tz = transmittance(1.0, turb, this._tmpC);
    const ts = transmittance(sunY, turb, this._sunTint);
    const zr = (1 - tz.r) * 0.35 + 0.02, zg = (1 - tz.g) * 0.85 + 0.02, zb = (1 - tz.b) * 1.55 + 0.03;
    this.skyZenithColor.setRGB(
      zr * ts.r * 3.4 * above,
      zg * ts.g * 3.4 * above,
      zb * ts.b * 3.4 * above,
      THREE.LinearSRGBColorSpace
    );
    // Horizon: long path, so it takes the sun's own colour and goes pale.
    const th = transmittance(0.06, turb, this._tmpC);
    this.skyHorizonColor.setRGB(
      (1 - th.r * 0.55) * ts.r * 1.65 * above,
      (1 - th.g * 0.55) * ts.g * 1.55 * above,
      (1 - th.b * 0.55) * ts.b * 1.5 * above,
      THREE.LinearSRGBColorSpace
    );
    if (cloud > 0) {
      const cc = this._tmpC.setHex(p.cloudColor ?? 0x8e99a6);
      const deck = 0.55 + 0.9 * (1 - cloud * 0.4);
      this.skyZenithColor.lerp(cc.clone().multiplyScalar(deck), cloud * 0.92);
      this.skyHorizonColor.lerp(cc.clone().multiplyScalar(deck * 0.85), cloud * 0.92);
    }
    // Night floor — deep blue, plus the sodium dome the sky shader draws at the horizon.
    const night = 1 - above;
    if (night > 0) {
      this.skyZenithColor.r = Math.max(this.skyZenithColor.r, 0.0075 * night);
      this.skyZenithColor.g = Math.max(this.skyZenithColor.g, 0.0115 * night);
      this.skyZenithColor.b = Math.max(this.skyZenithColor.b, 0.0260 * night);
      this.skyHorizonColor.r = Math.max(this.skyHorizonColor.r, 0.0450 * night);
      this.skyHorizonColor.g = Math.max(this.skyHorizonColor.g, 0.0330 * night);
      this.skyHorizonColor.b = Math.max(this.skyHorizonColor.b, 0.0330 * night);
    }
  }

  _writeFogUniforms(p, cloud, rain) {
    const A = FOG_UNIFORMS.fogParamsA.value;
    const B = FOG_UNIFORMS.fogParamsB.value;
    A[0] = (p.fogHeightFalloff ?? 0.02) * (1 - rain * 0.55); // rain fills the whole column
    A[1] = p.fogHeightRef ?? 0;
    A[2] = p.aerial ?? 1;
    A[3] = (p.sunInscatter ?? 0.5) * (1 - cloud * 0.85);
    B[1] = p.mieG ?? 0.78;
    // Never let fog reach 100%: leaving 5-8% of the surface visible at infinity keeps a
    // silhouette on the far skyline instead of dissolving it into a flat card.
    B[2] = 0.94 - Math.min(0.06, rain * 0.06);
    // How hard the haze scatters the surface's own chroma out of the eye ray. See the extinction
    // block in AtmosphereFog.js — this is the term that stops distant towers reading at exactly
    // the foreground's saturation. Rain and cloud thicken it.
    B[3] = clamp01((p.aerialDesat ?? 0.5) * (1 + rain * 0.35 + cloud * 0.2));

    // Aerial perspective is dimmer than the sky it borrows its hue from: the haze column is
    // partly self-shadowed, and matching sky luminance exactly veils the skyline to flat white.
    const veil = 0.58 + 0.16 * (1 - clamp01(this.turbidity / 12));
    writeVec3(FOG_UNIFORMS.fogHorizonCol.value, this.skyHorizonColor, veil);
    writeVec3(FOG_UNIFORMS.fogZenithCol.value, this.skyZenithColor, veil * 1.15);
    // Inscatter tint: the sun's own colour, softened by haze.
    writeVec3(FOG_UNIFORMS.fogSunCol.value, this._sunTint, 0.85 + this.turbidity * 0.04);
    const sv = FOG_UNIFORMS.fogSunVec.value;
    sv[0] = this._toSun.x;
    sv[1] = this._toSun.y;
    sv[2] = this._toSun.z;

    // scene.fog keeps a sane base colour for anything that ignores the aerial term.
    this.fogColor.copy(this.skyHorizonColor);
    const fog = this.ctx.scene.fog;
    if (fog) {
      fog.color.copy(this.fogColor);
      fog.density = this.fogDensity;
    }
  }

  // ==================================================================== IBL
  /**
   * Re-bakes the sky into a cube, then PMREMs it. NEVER per frame — this is ~6 dome draws plus
   * the PMREM mip chain. It runs only when time-of-day / preset / weather actually changed, is
   * rate-limited to ENV_MIN_INTERVAL, and the very first bake happens during init() so the
   * boot screen absorbs it.
   */
  _refreshEnvMap(force = false) {
    const { scene, renderer } = this.ctx;
    if (!this.cubeCam || !this.skyMat) return;
    this._envDirty = false;
    this._envCooldown = force ? 0 : ENV_MIN_INTERVAL;

    // Bake at the world origin — the sky is at infinity, so position is irrelevant.
    this.cubeCam.position.set(0, 0, 0);
    this._captureSky.position.set(0, 0, 0);
    this._captureSky.updateMatrixWorld();
    this.cubeCam.update(renderer, this._captureScene);

    const rt = this.pmrem.fromCubemap(this.cubeRT.texture, this._pmremRT || undefined);
    this._pmremRT = rt;
    this.envMap = rt.texture;
    scene.environment = this.envMap;
    scene.background = this.cubeRT.texture; // crisp cube; the dome mesh draws over it anyway
    scene.backgroundBlurriness = 0;
    scene.backgroundIntensity = 1;
    if (this.ctx.assets) this.ctx.assets.envMap = this.envMap;
  }

  // ==================================================================== weather materials
  /**
   * Fallback wetness for WorldSystem geometry only, active until the materials lane publishes
   * `assets.wetness`. Originals are cached per-material so repeated calls never compound and
   * dry() is exact. Cars/VFX are deliberately untouched — those lanes own their own response.
   */
  _applyWetMaterials() {
    if (this.ctx.assets && typeof this.ctx.assets.wetness === 'object') return; // lane took over
    const root = this.ctx.world?.root;
    if (!root) return;
    const w = this.wetness;
    root.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : null;
      if (!mats) return;
      for (const m of mats) {
        if (!m || m.isShaderMaterial || m.roughness === undefined) continue;
        let base = this._matCache.get(m);
        if (!base) {
          base = {
            roughness: m.roughness,
            metalness: m.metalness ?? 0,
            envMapIntensity: m.envMapIntensity ?? 1,
            color: m.color ? m.color.clone() : null,
          };
          this._matCache.set(m, base);
        }
        // Water fills surface pores: smoother, darker, more specular, less saturated.
        m.roughness = lerp(base.roughness, Math.min(base.roughness, 0.085), w);
        m.metalness = lerp(base.metalness, Math.min(1, base.metalness + 0.12), w);
        m.envMapIntensity = lerp(base.envMapIntensity, base.envMapIntensity * 2.6 + 0.5, w);
        if (base.color) {
          const s = lerp(1, 0.55, w);
          m.color.copy(base.color).multiplyScalar(s);
          const g = m.color.r * 0.299 + m.color.g * 0.587 + m.color.b * 0.114;
          m.color.lerp(this._tmpC.setRGB(g, g, g, THREE.LinearSRGBColorSpace), w * 0.28);
        }
        m.needsUpdate = false;
      }
    });
  }

  // ==================================================================== per frame
  update(dt, ctx) {
    const cam = ctx.camera;
    if (!cam) return;

    if (this.sky) this.sky.position.copy(cam.position);
    if (this.skyMat) this.skyMat.uniforms.uTime.value = ctx.time.elapsed;

    // Height fog needs the camera altitude to integrate against.
    FOG_UNIFORMS.fogParamsB.value[0] = cam.position.y;

    // Keep the materials lane's mirror in lockstep even if they rebuild their uniform table.
    const aw = ctx.assets?.wetness;
    if (aw && typeof aw === 'object') {
      aw.value = this.wetness;
      if (ctx.assets.rainIntensity && typeof ctx.assets.rainIntensity === 'object') {
        ctx.assets.rainIntensity.value = this.rainIntensity;
      }
    } else if (ctx.assets && typeof aw === 'number') {
      ctx.assets.wetness = this.wetness;
    }

    // ---- cascaded shadows ---------------------------------------------------------------
    this.csm.setDirection(this.sunDirection);
    this.csm.update(cam);
    if (this.moonLight.intensity > 0.001) {
      this.moonLight.position.copy(cam.position).addScaledVector(this._toMoon, 400);
      this.moonLight.target.position.copy(cam.position);
      this.moonLight.target.updateMatrixWorld();
    }
    this.bounce.position.copy(cam.position).addScaledVector(this.sunDirection, 200).setY(cam.position.y + 120);
    this.bounce.target.position.copy(cam.position);
    this.bounce.target.updateMatrixWorld();

    // ---- sun screen position + occlusion (consumed by the POST-FX lane) ------------------
    this._updateSunScreen(dt, ctx);

    // ---- amortised IBL ------------------------------------------------------------------
    this._envCooldown -= dt;
    if (this._envDirty && this._envCooldown <= 0) this._refreshEnvMap();
  }

  _updateSunScreen(dt, ctx) {
    const cam = ctx.camera;
    const p = this.sunScreenPosition.copy(cam.position).addScaledVector(this._toSun, 3000);
    p.project(cam); // p IS sunScreenPosition — keep the NDC out of the scratch vector
    const fwd = this._tmpV.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const front = this._toSun.dot(fwd);
    const onScreen = front > 0 && Math.abs(p.x) < 1.25 && Math.abs(p.y) < 1.25;
    this.sunScreenValid = onScreen;

    let target = 0;
    if (onScreen && this.csm.lights[0].intensity > 0.05) {
      const edge =
        (1 - clamp01((Math.abs(p.x) - 0.75) / 0.5)) * (1 - clamp01((Math.abs(p.y) - 0.75) / 0.5));
      target = edge;
      // Occlusion: one ray toward the sun. PhysicsSystem may not exist yet — guard it.
      const hit = ctx.physics?.raycast?.(cam.position, this._toSun, 260);
      if (hit?.hit) target = 0;
    }
    // Ease so a flare doesn't pop when the car passes a barrier.
    const k = 1 - Math.exp(-dt * (target > this._sunVisRaw ? 9 : 14));
    this._sunVisRaw += (target - this._sunVisRaw) * k;
    this.sunVisibility = clamp01(this._sunVisRaw);
  }

  // ==================================================================== quality
  onQuality() {
    const s = this.ctx.settings;
    this.csm.setMapSize(s.get('shadowMapSize') ?? 2048);
    this.csm.setCascadeCount(s.get('shadowCascades') ?? 3);
    this.csm.setShadowDistance(s.get('shadowDistance') ?? 400);
    this._makeCubeTarget(s.get('envMapSize') ?? 256);
    this._applyLighting();
    this._refreshEnvMap(true);
  }

  dispose() {
    this.pmrem?.dispose();
    this.cubeRT?.dispose();
    this._pmremRT?.dispose();
    this.csm?.dispose();
    this.skyMat?.dispose();
    this.sky?.geometry?.dispose();
  }
}

const ENV_MIN_INTERVAL = 0.22; // seconds between PMREM rebuilds when TOD is being scrubbed
