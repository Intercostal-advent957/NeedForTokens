/**
 * CASCADED SHADOW MAPS — Need for Tokens / env lane
 * =================================================
 * A single 90 m orthographic shadow camera cannot cover a racing game: either the texels are
 * big enough to cover the track and the car has no contact shadow, or the car looks right and
 * everything past the next corner is unshadowed.
 *
 * APPROACH
 * --------
 * N (2–4, from `settings.get('shadowCascades')`) `THREE.DirectionalLight`s all pointing the
 * same way, all with the same colour/intensity, each owning one shadow map fitted to one slice
 * of the view frustum. A patched `lights_fragment_begin` multiplies each light's contribution
 * by a cascade weight derived from the fragment's view depth. The weights are built so they
 * **sum to exactly 1** everywhere — inside a cascade only that cascade contributes, and across a
 * boundary the two overlapping cascades cross-fade — so the total direct light is unchanged and
 * the cascade seam is invisible.
 *
 * STABILITY
 * ---------
 * Each cascade is fitted to the **bounding sphere** of its frustum slice, not the slice's AABB.
 * A sphere's radius is invariant under camera rotation, so the ortho extents never change as
 * the car turns. The sphere centre is then snapped to whole shadow texels in light space, so
 * the projection only ever moves in texel-sized steps and shadow edges stop crawling.
 *
 * COST
 * ----
 * Shadow map resolution comes from `settings.get('shadowMapSize')`. Distant cascades are
 * re-fitted and re-rendered on a stagger (`UPDATE_INTERVAL`) — the fit and the render are always
 * skipped together, so a stale cascade is still self-consistent, just a few frames behind.
 * Bias and normalBias are scaled by each cascade's world-space texel size, which is the only way
 * to get contact shadows on cascade 0 without acne on cascade 3.
 */
import * as THREE from 'three';

const MAX_CASCADES = 4;

/** Shared live uniforms — see AtmosphereFog.js for why Float32Array survives cloneUniforms(). */
export const CSM_UNIFORMS = {
  csmSplits: { value: new Float32Array(MAX_CASCADES) },
  // [ cascadeCount (0 = disabled), fadeWidth (m), shadowFar (m), unused ]
  csmParams: { value: new Float32Array([0, 12, 400, 0]) },
};

const CSM_PARS = /* glsl */ `
uniform float csmSplits[ ${MAX_CASCADES} ];
uniform vec4  csmParams;
float nftCsmWeight( const in int idx, const in float viewDepth ) {
	int n = int( csmParams.x + 0.5 );
	if ( n <= 0 ) return 1.0;          // CSM off — behave exactly like a normal light
	if ( idx >= n ) return 0.0;        // stray extra directional lights get nothing
	float fade = max( csmParams.y, 0.01 );
	float w = 1.0;
	if ( idx > 0 ) {
		float lo = csmSplits[ idx - 1 ];
		w *= clamp( ( viewDepth - ( lo - fade * 0.5 ) ) / fade, 0.0, 1.0 );
	}
	if ( idx < n - 1 ) {
		float hi = csmSplits[ idx ];
		w *= clamp( ( ( hi + fade * 0.5 ) - viewDepth ) / fade, 0.0, 1.0 );
	}
	return w;
}
`;

let patched = false;

/** Patches the shared light chunks. Idempotent, and a no-op if three's source ever moves. */
export function installCsmShaderPatch() {
  if (patched) return true;
  patched = true;

  if (!/nftCsmWeight/.test(THREE.ShaderChunk.lights_pars_begin)) {
    THREE.ShaderChunk.lights_pars_begin += CSM_PARS;
  }

  const src = THREE.ShaderChunk.lights_fragment_begin;
  const MARK = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
  const CALL =
    'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const at = src.indexOf(MARK);
  if (at < 0 || src.indexOf(CALL, at) < 0) {
    console.warn('[env/CSM] lights_fragment_begin layout changed — cascade blending disabled.');
    return false;
  }
  const head = src.slice(0, at);
  const tail = src
    .slice(at)
    .replace(
      CALL,
      'directLight.color *= nftCsmWeight( UNROLLED_LOOP_INDEX, - geometryPosition.z );\n\t\t' + CALL
    );
  THREE.ShaderChunk.lights_fragment_begin = head + tail;

  for (const key of Object.keys(THREE.ShaderLib)) {
    const lib = THREE.ShaderLib[key];
    if (lib?.uniforms?.directionalLights) Object.assign(lib.uniforms, CSM_UNIFORMS);
  }
  return true;
}

// Cascade i is refitted + re-rendered every UPDATE_INTERVAL[i] frames. Cascade 0 holds the
// car's contact shadow so it is never stale; cascade 3 covers 150-400 m of city and nobody can
// see a 4-frame lag on it. Averaged over time this is ~1.9 shadow passes per frame, not 4.
const UPDATE_INTERVAL = [1, 3, 5, 8];
// Per-cascade resolution scale. Cascade 3 covers ~13x the area of cascade 0; giving it the same
// map is paying full price for texels that land tens of metres apart on screen anyway.
const MAP_SCALE = [1, 1, 0.5, 0.375];

export class CascadedShadows {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts { cascades, mapSize, maxDistance, lambda, fade, color, intensity }
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    // Split weighting between the logarithmic and uniform schemes. High on purpose: the whole
    // point of cascade 0 in a chase-cam racing game is the hero car's contact shadow, and the car
    // sits 8-10 m from the camera. At lambda 0.72 cascade 0 stretched to ~40 m and its texels were
    // 4 cm, which is far too coarse to resolve where a tyre meets tarmac whatever the bias is. At
    // 0.85 it covers ~17-23 m — the car, its shadow and the road around it — at ~2 cm.
    this.lambda = opts.lambda ?? 0.85;
    this.fade = opts.fade ?? 12;
    this.maxDistance = opts.maxDistance ?? 400;
    this.mapSize = opts.mapSize ?? 2048;
    this.count = 0;
    this.enabled = true;
    this._mapSizeApplied = 0;
    this.direction = new THREE.Vector3(0, -1, 0.0001).normalize();
    this.frame = 0;

    this.lights = [];
    this.group = new THREE.Group();
    this.group.name = 'CSM';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    for (let i = 0; i < MAX_CASCADES; i++) {
      const l = new THREE.DirectionalLight(0xffffff, 0);
      l.name = `Sun.cascade${i}`;
      l.castShadow = true;
      l.matrixAutoUpdate = true;
      l.shadow.camera.near = 0.5;
      l.shadow.camera.far = 1200;
      l.shadow.bias = -0.0005;
      l.shadow.normalBias = 0.02;
      l.shadow.autoUpdate = true;
      l.target.matrixAutoUpdate = true;
      this.group.add(l, l.target);
      this.lights.push(l);
    }

    this._splits = new Float32Array(MAX_CASCADES + 1);
    this._corners = [];
    for (let i = 0; i < 8; i++) this._corners.push(new THREE.Vector3());
    this._center = new THREE.Vector3();
    this._lightView = new THREE.Matrix4();
    this._tmp = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);

    this.setCascadeCount(opts.cascades ?? 3);
    this.setMapSize(this.mapSize); // must actually reach light.shadow.mapSize — default is 512
    this.setColorIntensity(opts.color ?? new THREE.Color(0xffffff), opts.intensity ?? 0);
  }

  /**
   * Changing this toggles light *visibility*, which changes NUM_DIR_LIGHTS and forces every
   * material in the scene to recompile. Only ever call it from onQuality — never per frame,
   * and never in response to sunset. (Doing it on sunset killed the GPU process outright.)
   */
  setCascadeCount(n) {
    n = Math.max(1, Math.min(MAX_CASCADES, n | 0));
    if (n === this.count) return;
    this.count = n;
    for (let i = 0; i < MAX_CASCADES; i++) {
      const on = i < n;
      this.lights[i].visible = on;
      this.lights[i].castShadow = on;
      if (on) this.lights[i].shadow.needsUpdate = true;
    }
    CSM_UNIFORMS.csmParams.value[0] = n;
    this._recomputeSplits = true;
  }

  setMapSize(size) {
    if (size === this._mapSizeApplied) return;
    this.mapSize = size;
    this._mapSizeApplied = size;
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const s = Math.max(512, Math.round((size * MAP_SCALE[i]) / 256) * 256);
      l.shadow.mapSize.set(s, s);
      l.shadow.map?.dispose();
      l.shadow.map = null;
      l.shadow.needsUpdate = true;
    }
  }

  /** World-space extent of one shadow texel — bias and snapping both key off this. */
  _texelSize(i, radius) {
    return (radius * 2) / this.lights[i].shadow.mapSize.x;
  }

  /**
   * "Off" means intensity 0 and no shadow-map re-renders — NOT hidden lights. The light count
   * has to stay constant or the whole scene relinks its shaders every sunset.
   */
  setEnabled(v) {
    const on = !!v;
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      for (let i = 0; i < MAX_CASCADES; i++) {
        this.lights[i].shadow.autoUpdate = false;
        this.lights[i].shadow.needsUpdate = false;
      }
    }
  }

  /** @param {THREE.Vector3} dir direction the light TRAVELS (from sun toward the scene) */
  setDirection(dir) {
    this.direction.copy(dir).normalize();
  }

  setColorIntensity(color, intensity) {
    for (let i = 0; i < MAX_CASCADES; i++) {
      this.lights[i].color.copy(color);
      this.lights[i].intensity = intensity;
    }
  }

  setShadowDistance(d) {
    if (Math.abs(d - this.maxDistance) < 1) return;
    this.maxDistance = d;
    this._recomputeSplits = true;
  }

  /** Practical split scheme: blend of logarithmic and uniform distribution. */
  _computeSplits(near, far) {
    const n = this.count;
    const lam = this.lambda;
    this._splits[0] = near;
    for (let i = 1; i < n; i++) {
      const si = i / n;
      const logSplit = near * Math.pow(far / near, si);
      const uniSplit = near + (far - near) * si;
      this._splits[i] = lam * logSplit + (1 - lam) * uniSplit;
    }
    this._splits[n] = far;
    for (let i = 0; i < MAX_CASCADES; i++) {
      CSM_UNIFORMS.csmSplits.value[i] = this._splits[Math.min(i + 1, n)];
    }
    CSM_UNIFORMS.csmParams.value[1] = this.fade;
    CSM_UNIFORMS.csmParams.value[2] = far;
  }

  /**
   * Fits every cascade to the current view frustum. Call once per frame AFTER the camera
   * system has written the final camera transform.
   */
  update(camera) {
    if (!this.enabled || !camera?.isPerspectiveCamera) return;
    this.frame++;

    const near = Math.max(camera.near, 0.3);
    const far = Math.min(camera.far, this.maxDistance);
    this._computeSplits(near, far);

    camera.updateMatrixWorld();
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanW = tanH * camera.aspect;

    for (let i = 0; i < this.count; i++) {
      if (this.frame % UPDATE_INTERVAL[i] !== 0) {
        this.lights[i].shadow.autoUpdate = false;
        this.lights[i].shadow.needsUpdate = false;
        continue;
      }
      this.lights[i].shadow.autoUpdate = false;
      this.lights[i].shadow.needsUpdate = true;
      this._fitCascade(camera, i, this._splits[i], this._splits[i + 1], tanW, tanH);
    }
  }

  _fitCascade(camera, i, n, f, tanW, tanH) {
    // Frustum-slice corners in camera space, then to world.
    const c = this._corners;
    let k = 0;
    for (const d of [n, f]) {
      const x = tanW * d;
      const y = tanH * d;
      c[k++].set(-x, -y, -d);
      c[k++].set(x, -y, -d);
      c[k++].set(-x, y, -d);
      c[k++].set(x, y, -d);
    }
    // Bounding sphere of the slice. The centre lies on the view axis at cz, where the near and
    // far corners are equidistant:  a2*n² + (n-cz)² = a2*f² + (f-cz)²  =>  cz = (n+f)(1+a2)/2.
    // Using a sphere (not an AABB) is what makes the ortho extents rotation-invariant.
    const a2 = tanW * tanW + tanH * tanH;
    let cz = 0.5 * (f + n) * (1 + a2);
    if (cz > f) cz = f; // centre would sit past the far plane: sphere is capped by it
    let radius = Math.sqrt(a2 * f * f + (f - cz) * (f - cz));
    // Robustness: make sure the sphere really contains every corner.
    this._center.set(0, 0, -cz).applyMatrix4(camera.matrixWorld);
    for (let j = 0; j < 8; j++) {
      c[j].applyMatrix4(camera.matrixWorld);
      radius = Math.max(radius, c[j].distanceTo(this._center));
    }
    radius = Math.ceil(radius * 8) / 8; // quantise so it doesn't breathe frame to frame

    const light = this.lights[i];
    const dir = this.direction;
    const dist = radius + 60;

    // --- texel snapping -----------------------------------------------------------------
    // Build the light view basis, express the centre in it, floor to whole texels, go back.
    const eye = this._tmp.copy(this._center).addScaledVector(dir, -dist);
    const up = Math.abs(dir.y) > 0.985 ? UP_ALT : this._up;
    this._lightView.lookAt(eye, this._center, up);
    const m = this._lightView.elements;
    const rx = m[0], ry = m[1], rz = m[2];
    const ux = m[4], uy = m[5], uz = m[6];
    const texel = this._texelSize(i, radius);
    const px = this._center.x * rx + this._center.y * ry + this._center.z * rz;
    const py = this._center.x * ux + this._center.y * uy + this._center.z * uz;
    const dx = (Math.round(px / texel) * texel - px);
    const dy = (Math.round(py / texel) * texel - py);
    this._center.x += rx * dx + ux * dy;
    this._center.y += ry * dx + uy * dy;
    this._center.z += rz * dx + uz * dy;

    light.position.copy(this._center).addScaledVector(dir, -dist);
    light.target.position.copy(this._center);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();

    const cam = light.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 1;
    cam.far = dist + radius + 40;
    cam.updateProjectionMatrix();

    // --- bias tuned to this cascade's world-space texel size ------------------------------
    // Too little and you get acne; too much and the car floats (peter-panning). Both are instant
    // quality tells, and the right value is PROPORTIONAL TO TEXEL SIZE — it must have no constant
    // term at all.
    //
    // This used to be `0.35 + texel * 1.5`, i.e. a 39 cm normal offset on cascade 0. three applies
    // normalBias in WORLD units: it moves the shadow lookup 39 cm along the surface normal before
    // sampling. A supercar's floorpan is 12 cm off the tarmac, so the entire under-body was lifted
    // clean out of its own shadow and every car in the game sat on the road with nothing beneath
    // it. At a 10-degree golden-hour sun the same offset detaches the shadow by 0.39/tan(10deg) =
    // 2.2 METRES along the ground. That single constant was the "cars hover above a decal" tell.
    //
    // `bias` is in normalised shadow depth, so its world-space size is bias * (far - near); the
    // ortho depth range here is ~200 m, which is why the numbers look so small.
    const t = texel;
    light.shadow.bias = -(0.00006 + t * 0.0012);
    light.shadow.normalBias = Math.max(0.008, Math.min(0.45, t * 1.35));
    light.shadow.radius = i === 0 ? 1.4 : 1.6;
  }

  dispose() {
    for (const l of this.lights) {
      l.shadow.map?.dispose();
      this.group.remove(l, l.target);
    }
    this.scene.remove(this.group);
  }
}

const UP_ALT = new THREE.Vector3(0, 0, 1);
