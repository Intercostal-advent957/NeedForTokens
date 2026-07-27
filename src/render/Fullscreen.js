import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Minimal full-screen pass. One triangle, no camera transform, no depth state.
 *
 * The post lane does NOT use EffectComposer: we need a scene render target with a live depth
 * attachment that survives every subsequent pass, and the composer's ping-pong (plus three's
 * default depthWrite on ShaderMaterial) makes that fragile. A hand-rolled chain is ~40 lines and
 * removes a whole class of "why is my depth buffer zero" bugs.
 */
export const FS_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export class FsPass {
  /**
   * @param {{name?:string, uniforms:object, fragmentShader:string, vertexShader?:string}} shader
   * @param {object} [defines]
   */
  constructor(shader, defines) {
    this.material = new THREE.ShaderMaterial({
      name: shader.name || 'fs-pass',
      defines: Object.assign({}, defines),
      uniforms: THREE.UniformsUtils.clone(shader.uniforms),
      vertexShader: shader.vertexShader || FS_VERT,
      fragmentShader: shader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.uniforms = this.material.uniforms;
    this._quad = new FullScreenQuad(this.material);
  }

  get u() {
    return this.uniforms;
  }

  /** @param {THREE.WebGLRenderTarget|null} target */
  render(renderer, target = null, clear = false) {
    renderer.setRenderTarget(target);
    if (clear) renderer.clear(true, false, false);
    this._quad.render(renderer);
  }

  setDefine(k, v) {
    if (this.material.defines[k] === v) return;
    if (v === null || v === undefined) delete this.material.defines[k];
    else this.material.defines[k] = v;
    this.material.needsUpdate = true;
  }

  dispose() {
    this._quad.dispose();
    this.material.dispose();
  }
}

/** HDR colour target. `depth` attaches a DepthTexture we can sample later. */
export function makeHdrTarget(w, h, { depth = false, format = THREE.RGBAFormat, filter } = {}) {
  const f = filter ?? THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: THREE.HalfFloatType,
    format,
    minFilter: f,
    magFilter: f,
    depthBuffer: depth,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
  if (depth) {
    const dt = new THREE.DepthTexture(Math.max(1, w | 0), Math.max(1, h | 0));
    dt.type = THREE.UnsignedIntType;
    dt.format = THREE.DepthFormat;
    dt.minFilter = THREE.NearestFilter;
    dt.magFilter = THREE.NearestFilter;
    rt.depthTexture = dt;
  }
  return rt;
}

export function makeLdrTarget(w, h) {
  return new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
}
