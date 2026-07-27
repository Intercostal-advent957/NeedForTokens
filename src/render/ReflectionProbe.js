import * as THREE from 'three';

/**
 * Local reflection probe for the hero car.
 *
 * ============================ why this exists ============================
 * `scene.environment` is a PMREM of the SKY DOME ONLY (EnvironmentSystem bakes a 6-face cube of
 * `_captureScene`, which contains nothing but the sky mesh). A near-mirror clearcoat sampling that
 * map reflects a smooth luminance ramp and literally nothing else: no buildings, no road, no
 * horizon line. The paint therefore has a broad specular lobe and zero recognisable content in it,
 * which is exactly the "plastic toy" read — clearcoat, flake and orange peel were all implemented
 * and all working, they just had nothing to reflect.
 *
 * This bakes a real cube of the WORLD around the car and hands it to the car materials as their
 * `envMap`, which overrides `scene.environment` per material. Cost is controlled by three things:
 *
 *  1. ONE probe, at the player, shared by every car. A per-car probe is pointless here — the cars
 *     are within a few metres of each other and the blueprint system shares materials between
 *     instances anyway, so per-car probes would need per-car material clones for no visible gain.
 *  2. ONE CUBE FACE PER FRAME. A 6-face bake in a single frame is a 6x draw-call spike; at ~1200
 *     draws that is a visible hitch every time it fires. Amortised, the probe costs one extra
 *     128x128 scene render per frame and the full set refreshes in 6 frames (~0.1 s at 60 fps).
 *  3. A short far plane. Reflections past a few hundred metres are a couple of texels wide; the
 *     tight frustum is what keeps each face's draw count far below the main camera's.
 *
 * The cars are hidden for the bake. That is not just a quality choice: their materials sample the
 * very texture being rendered into, and sampling a bound render target is undefined behaviour.
 */
export class ReflectionProbe {
  constructor(renderer) {
    this.renderer = renderer;
    this.failed = false;
    this.enabled = true;
    this.size = 0;

    /** Faces baked per frame. 1 = full refresh every 6 frames. */
    this.facesPerFrame = 1;
    /** Force a re-bake at least this often, even parked (time of day, lights, traffic move). */
    this.maxInterval = 0.75;
    /**
     * …or as soon as the subject has travelled this far, whichever comes first.
     * Deliberately generous: a tighter threshold makes a car at 200 km/h re-sweep every other
     * frame, which turns the probe from "one amortised face per frame" into a permanent second
     * scene render. Parallax error in a blurred clearcoat reflection is invisible next to that.
     */
    this.moveEpsilon = 7.0;
    /** Probe sits above the car's origin, roughly at bonnet/roof height. */
    this.heightOffset = 0.55;

    this.cubeRT = null;
    this.cubeCam = null;
    this.pmrem = null;
    this._pmremRT = null;
    /** @type {THREE.Texture|null} PMREM'd cube, ready to hang on a material's envMap. */
    this.texture = null;

    this._face = 0;
    this._sweeping = false;
    this._hasBaked = false;
    this._sinceBake = 1e9;
    this._pos = new THREE.Vector3();
    this._lastPos = new THREE.Vector3();
    this._hidden = [];
    this._faceCount = 0;
    this._sweeps = 0;
  }

  setSize(n) {
    const s = Math.max(32, Math.min(256, n | 0));
    if (this.cubeRT && this.size === s) return;
    // Resolution is locked once a cube has been prefiltered. Rebuilding it would have to dispose
    // the PMREM target the car materials are currently sampling from, and a mid-session tier
    // switch is not worth a frame of "texture bound to a deleted object" for a cube nobody can
    // tell the resolution of. Tier is applied before the first bake, which is the case that counts.
    if (this._hasBaked) return;
    this.size = s;
    this.cubeRT?.dispose();
    this.cubeRT = new THREE.WebGLCubeRenderTarget(s, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.cubeRT.texture.name = 'car-probe';

    // near 0.6 m clears the car's own bodywork even with the probe at bonnet height.
    // far 260 m is the whole performance story: each face is a 90° frustum over a dense city, so
    // the far plane sets the draw count. Past ~260 m a building is a couple of texels wide in a
    // 128px face and the sky bake behind it is indistinguishable, so the range buys nothing.
    this.cubeCam = new THREE.CubeCamera(0.6, 260, this.cubeRT);
    // CubeCamera orients its six children lazily inside update(); we drive the faces ourselves,
    // so the orientation has to be established up front or every face renders down -Z.
    this.cubeCam.coordinateSystem = this.renderer.coordinateSystem;
    this.cubeCam.updateCoordinateSystem();

    this._face = 0;
    this._sweeping = false;
    this._hasBaked = false;
  }

  /**
   * Bake up to `facesPerFrame` faces. Must be called BEFORE the beauty render — it moves the
   * render target and hides the cars.
   * @returns {THREE.Texture|null} the PMREM texture (stable identity once the first sweep lands)
   */
  update(ctx, dt) {
    if (this.failed || !this.enabled || !this.cubeRT) return this.texture;
    const subject = ctx.cars?.player?.root ?? ctx.player?.root;
    if (!subject) return this.texture;

    subject.getWorldPosition(this._pos);
    this._pos.y += this.heightOffset;

    this._sinceBake += Math.max(dt || 0, 0);
    if (!this._sweeping) {
      const moved = this._hasBaked ? this._lastPos.distanceTo(this._pos) : Infinity;
      if (this._sinceBake < this.maxInterval && moved < this.moveEpsilon) return this.texture;
      this._sweeping = true;
      this._face = 0;
      this._sinceBake = 0;
      this._lastPos.copy(this._pos);
      this.cubeCam.position.copy(this._pos);
      this.cubeCam.updateMatrixWorld(true);
    }

    try {
      this._bakeFaces(ctx, this.facesPerFrame);
    } catch (e) {
      console.warn('[postfx] reflection probe disabled:', e?.message || e);
      this.failed = true;
    }
    return this.texture;
  }

  _bakeFaces(ctx, count) {
    const { renderer, scene } = ctx;
    const cams = this.cubeCam.children;
    const prevTarget = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevXr = renderer.xr ? renderer.xr.enabled : false;
    const hidden = this._hidden;
    hidden.length = 0;

    try {
      if (renderer.xr) renderer.xr.enabled = false;
      // Shadow maps are already correct for this frame's lights; re-deriving them per face is
      // pure waste and would thrash the cascade split for the main camera.
      renderer.shadowMap.autoUpdate = false;

      const cars = ctx.cars?.instances;
      if (cars) {
        for (let i = 0; i < cars.length; i++) {
          const root = cars[i]?.root;
          if (root && root.visible) {
            root.visible = false;
            hidden.push(root);
          }
        }
      }

      for (let i = 0; i < count && this._sweeping; i++) {
        const face = this._face;
        renderer.setRenderTarget(this.cubeRT, face);
        renderer.render(scene, cams[face]);
        this._faceCount++;
        this._face++;
        if (this._face >= 6) {
          this._face = 0;
          this._sweeping = false;
          this._sweeps++;
          this._prefilter();
        }
      }
    } finally {
      for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
      hidden.length = 0;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      if (renderer.xr) renderer.xr.enabled = prevXr;
      renderer.setRenderTarget(prevTarget, prevFace, prevMip);
    }
  }

  /** Cube -> roughness-prefiltered CubeUV. Physical materials only accept the CubeUV form. */
  _prefilter() {
    if (!this.pmrem) {
      this.pmrem = new THREE.PMREMGenerator(this.renderer);
      this.pmrem.compileCubemapShader();
    }
    // fromCubemap reuses the target we hand it, so `this.texture` keeps a stable identity and the
    // materials never need a second program recompile.
    this._pmremRT = this.pmrem.fromCubemap(this.cubeRT.texture, this._pmremRT || undefined);
    this.texture = this._pmremRT.texture;
    this._hasBaked = true;
  }

  stats() {
    return { size: this.size, faces: this._faceCount, sweeps: this._sweeps, ready: !!this.texture };
  }

  dispose() {
    this.cubeRT?.dispose();
    this._pmremRT?.dispose();
    this.pmrem?.dispose();
    this.cubeRT = null;
    this._pmremRT = null;
    this.pmrem = null;
    this.texture = null;
  }
}
