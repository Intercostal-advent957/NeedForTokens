import * as THREE from 'three';

/**
 * Half-resolution scene-depth pre-pass, used exclusively by the VFX lane for soft particles
 * and for the screen-space distortion masks.
 *
 * PostFxSystem owns the *frame* (CONTRACTS §15) — this never touches the default framebuffer
 * or the composer. It renders the opaque scene into a private render target with a depth
 * attachment, using an override material so there is zero shading cost, and it clamps the far
 * plane to `SOFT_RANGE` metres so distant city geometry is frustum-culled out of the pass.
 *
 * Runs only on frames where a soft-edged effect is actually alive (see VfxSystem.lateUpdate).
 */
// Metres. Soft intersections only matter for smoke/spray/rain around the car, so clamping the
// pre-pass far plane hard lets frustum culling throw away almost the entire city — this single
// number is the difference between a ~3.5 ms pre-pass and a ~0.8 ms one at 1080p.
const SOFT_RANGE = 110;

export class DepthPass {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = true;
    this.scale = 0.5;
    // The pass is dominated by scene traversal + culling, not by rasterisation, so the cheapest
    // lever is to run it less often. Smoke fades over a ~1.4 m band; a one-frame-stale depth
    // buffer moves that boundary by well under a metre even at 250 km/h, which is invisible.
    this.interval = 2;
    this._phase = 0;
    this.rt = null;
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.15, SOFT_RANGE);
    this.overrideMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    this.overrideMat.name = 'vfx-depth-only';
    this.hidden = [];
    this._failed = false;
    // Uniform block shared by every consumer so they all stay in sync.
    this.uniforms = {
      tDepth: { value: null },
      // near, far, 1/drawingBufferW, 1/drawingBufferH  (full-res, so gl_FragCoord -> [0,1] uv
      // works no matter what scale the depth RT itself is running at)
      uDepthParams: { value: new THREE.Vector4(0.15, SOFT_RANGE, 1 / 1920, 1 / 1080) },
      uSoftEnabled: { value: 0 },
    };
  }

  init() {
    this._alloc();
    return this;
  }

  _alloc() {
    const { renderer } = this.ctx;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(64, Math.floor(size.x * this.scale));
    const h = Math.max(64, Math.floor(size.y * this.scale));
    if (this.rt && this.rt.width === w && this.rt.height === h) return;
    this.rt?.dispose();
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      depthTexture: depth,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    this.uniforms.tDepth.value = depth;
    this.uniforms.uDepthParams.value.set(
      this.camera.near,
      this.camera.far,
      1 / Math.max(size.x, 1),
      1 / Math.max(size.y, 1)
    );
  }

  onResize() {
    this._alloc();
  }

  setEnabled(v) {
    this.enabled = !!v && !this._failed;
    this.uniforms.uSoftEnabled.value = this.enabled ? 1 : 0;
  }

  setScale(s) {
    if (this.scale === s) return;
    this.scale = s;
    this._alloc();
  }

  /**
   * Render the pass. `excludeRoots` are Object3Ds temporarily hidden (our own transparent VFX —
   * they must never occlude themselves).
   */
  render(excludeRoots) {
    if (!this.enabled || this._failed || !this.rt) return;
    if (this.interval > 1) {
      // Re-project on the frames we skip by simply keeping the previous buffer; the fade band is
      // wide enough to absorb it.
      if (++this._phase % this.interval !== 0) return;
      this._phase = 0;
    }
    const { renderer, scene, camera } = this.ctx;

    const cam = this.camera;
    cam.fov = camera.fov;
    cam.aspect = camera.aspect;
    cam.near = camera.near;
    cam.far = SOFT_RANGE;
    cam.position.copy(camera.position);
    cam.quaternion.copy(camera.quaternion);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    this.uniforms.uDepthParams.value.x = cam.near;
    this.uniforms.uDepthParams.value.y = cam.far;

    // Hide our own translucent effects — plus anything already flagged non-occluding.
    const hidden = this.hidden;
    hidden.length = 0;
    for (let i = 0; i < excludeRoots.length; i++) {
      const o = excludeRoots[i];
      if (o && o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    }

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevBg = scene.background;
    const prevXR = renderer.xr?.enabled;

    try {
      renderer.shadowMap.autoUpdate = false;
      scene.overrideMaterial = this.overrideMat;
      scene.background = null;
      renderer.setRenderTarget(this.rt);
      renderer.clear(true, true, false);
      renderer.render(scene, cam);
    } catch (e) {
      console.warn('[vfx] depth pre-pass disabled:', e?.message || e);
      this._failed = true;
      this.enabled = false;
      this.uniforms.uSoftEnabled.value = 0;
    } finally {
      renderer.setRenderTarget(prevTarget);
      scene.overrideMaterial = prevOverride;
      scene.background = prevBg;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      if (prevXR !== undefined && renderer.xr) renderer.xr.enabled = prevXR;
      for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
      hidden.length = 0;
    }
  }

  dispose() {
    this.rt?.dispose();
    this.overrideMat.dispose();
  }
}

/** GLSL every soft-particle shader includes. Keep in sync with `uniforms` above. */
export const SOFT_DEPTH_GLSL = /* glsl */ `
  uniform sampler2D tDepth;
  uniform vec4 uDepthParams;   // near, far, 1/rtW, 1/rtH
  uniform float uSoftEnabled;

  float vfxLinearDepth(vec2 uv){
    float d = texture2D(tDepth, uv).x;
    float n = uDepthParams.x, f = uDepthParams.y;
    // perspective depth -> view-space distance along -Z
    return (2.0 * n * f) / (f + n - (2.0 * d - 1.0) * (f - n));
  }

  // 1.0 where the particle is far in front of the surface, ~0 where it intersects it.
  float vfxSoftFade(vec2 screenUv, float particleViewZ, float fadeDist){
    if (uSoftEnabled < 0.5) return 1.0;
    float sceneZ = vfxLinearDepth(screenUv);
    if (sceneZ >= uDepthParams.y * 0.995) return 1.0;   // nothing there / beyond the pass
    return clamp((sceneZ - particleViewZ) / max(fadeDist, 0.001), 0.0, 1.0);
  }
`;
