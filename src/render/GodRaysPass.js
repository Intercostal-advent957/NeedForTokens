import * as THREE from 'three';
import { FsPass, makeHdrTarget } from './Fullscreen.js';
import { HASH_GLSL, LUMA_GLSL } from './ShaderLib.js';

/**
 * Screen-space volumetric light shafts (Mitchell, GPU Gems 3) at quarter resolution.
 *
 * Occlusion buffer: keep the frame's bright pixels where the depth buffer says "sky", zero
 * everywhere else. That single rule is the whole trick — the silhouette of the city IS the
 * occluder, so shafts break correctly around buildings and the car with no extra geometry.
 *
 * Two radial-blur iterations with decaying density reach an effective 12x12 = 144 sample kernel
 * for the cost of 24 taps.
 *
 * Anchored to `env.sunScreenPosition` / `env.sunVisibility` (CONTRACTS §6 additions) so the shafts
 * inherit the env lane's occlusion raycast and eased visibility for free.
 */
export class GodRaysPass {
  constructor(renderer) {
    this.renderer = renderer;
    this.scale = 0.25;
    this.failed = false;
    this.density = 0.72;
    this.decay = 0.955;
    this.weight = 0.42;
    this.rtA = null;
    this.rtB = null;
    this.occl = new FsPass(OCCLUSION_SHADER);
    this.blur = new FsPass(RADIAL_SHADER, { GR_SAMPLES: '12' });
  }

  setSize(w, h) {
    const bw = Math.max(4, Math.round(w * this.scale));
    const bh = Math.max(4, Math.round(h * this.scale));
    if (this.rtA && this.rtA.width === bw && this.rtA.height === bh) return;
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtA = makeHdrTarget(bw, bh);
    this.rtB = makeHdrTarget(bw, bh);
    this.rtA.texture.name = 'godrays';
  }

  /**
   * @param {THREE.Vector2Like} sunUv sun position in [0,1] screen uv
   * @returns {THREE.Texture|null}
   */
  render(colorTexture, depthTexture, sunUv, visibility) {
    if (this.failed || !this.rtA || visibility <= 0.01) return null;
    try {
      const o = this.occl.u;
      o.tColor.value = colorTexture;
      o.tDepth.value = depthTexture;
      o.uSun.value.set(sunUv.x, sunUv.y);
      this.occl.render(this.renderer, this.rtA);

      const b = this.blur.u;
      b.uSun.value.set(sunUv.x, sunUv.y);
      // pass 1: wide
      b.tSrc.value = this.rtA.texture;
      b.uParams.value.set(this.density, this.decay, 1.0, 1.0);
      this.blur.render(this.renderer, this.rtB);
      // pass 2: tighter, picks up where the first left off
      b.tSrc.value = this.rtB.texture;
      b.uParams.value.set(this.density * (1 / 12), this.decay, 1.0, this.weight * visibility);
      this.blur.render(this.renderer, this.rtA);
      return this.rtA.texture;
    } catch (e) {
      console.warn('[postfx] god rays disabled:', e?.message || e);
      this.failed = true;
      return null;
    }
  }

  dispose() {
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.occl.dispose();
    this.blur.dispose();
  }
}

const OCCLUSION_SHADER = {
  name: 'godrays-occlusion',
  uniforms: {
    tColor: { value: null },
    tDepth: { value: null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
  },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    uniform vec2 uSun;
    ${LUMA_GLSL}
    void main() {
      float d = texture2D(tDepth, vUv).x;
      vec3 c = texture2D(tColor, vUv).rgb;
      // Only unoccluded sky contributes; everything else is an occluder by definition.
      float sky = step(0.9995, d);
      float l = luma(c);
      // Threshold well into HDR so a pale overcast sky does not turn into a light shaft.
      float bright = smoothstep(1.1, 4.0, l);
      // Confine to a disc around the sun so a bright horizon on the far side of the frame does
      // not radiate.
      float r = distance(vUv, uSun);
      float near = 1.0 - smoothstep(0.16, 0.62, r);
      gl_FragColor = vec4(c * sky * bright * near, 1.0);
    }
  `,
};

const RADIAL_SHADER = {
  name: 'godrays-radial',
  uniforms: {
    tSrc: { value: null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uParams: { value: new THREE.Vector4(0.7, 0.95, 1.0, 1.0) }, // density, decay, exposure, weight
  },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tSrc;
    uniform vec2 uSun;
    uniform vec4 uParams;
    ${HASH_GLSL}
    void main() {
      vec2 delta = (vUv - uSun) * (uParams.x / float(GR_SAMPLES));
      vec2 uv = vUv;
      float illum = 1.0;
      vec3 sum = vec3(0.0);
      // Half-texel dither breaks the concentric banding a fixed-step radial blur produces.
      uv -= delta * bayer4(gl_FragCoord.xy);
      for (int i = 0; i < GR_SAMPLES; i++) {
        uv -= delta;
        sum += texture2D(tSrc, clamp(uv, 0.0, 1.0)).rgb * illum;
        illum *= uParams.y;
      }
      gl_FragColor = vec4(sum * (uParams.w / float(GR_SAMPLES)), 1.0);
    }
  `,
};
