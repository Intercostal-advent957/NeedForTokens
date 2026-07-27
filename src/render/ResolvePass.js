import * as THREE from 'three';
import { FsPass } from './Fullscreen.js';
import { DEPTH_GLSL, LUMA_GLSL } from './ShaderLib.js';

/**
 * One full-res pass that folds every half-res buffer back into the frame: AO, SSR and god rays.
 *
 * Doing them in a single pass instead of three chained ShaderPasses saves two full-res
 * read-modify-writes at 1080p — about 0.5 ms of pure bandwidth on an M-series GPU, for free.
 *
 * The AO upsample is depth-aware (joint bilateral against the linear depth stored in the AO
 * buffer's G channel). A plain bilinear upsample of AO is what produces the classic half-res
 * "occlusion leaking one pixel past the silhouette" halo.
 *
 * AO is applied with a luminance guard: multiplying the composited beauty buffer is a forward-
 * renderer compromise, and without the guard it dims emissives — neon signs and tail lights would
 * get contact shadows, which is nonsense.
 *
 * AO is also floored. A visibility term that is allowed to reach 0 turns every depth-buffer
 * imperfection into a black hole in the beauty frame, and in a forward renderer the depth buffer
 * is *never* a perfect match for what is on screen (anything drawn with depthWrite off is simply
 * missing from it). Clamping the darkest occlusion to a physically sane floor costs nothing and
 * removes a whole class of "the car has holes in it" artefacts.
 */
export class ResolvePass extends FsPass {
  constructor() {
    super(SHADER);
  }
}

const SHADER = {
  name: 'resolve',
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    tAo: { value: null },
    tSsr: { value: null },
    tGod: { value: null },
    uAoTexel: { value: new THREE.Vector2() },
    uNearFar: { value: new THREE.Vector2(0.15, 6000) },
    // strength, emissive-guard slope, darkest permitted occlusion
    uAo: { value: new THREE.Vector3(1.0, 0.5, 0.1) },
    uSsr: { value: 1.0 },
    uGod: { value: 1.0 },
    uGodColor: { value: new THREE.Color(1, 0.85, 0.65) },
  },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tAo;
    uniform sampler2D tSsr;
    uniform sampler2D tGod;
    uniform vec2 uAoTexel, uNearFar;
    uniform vec3 uAo;
    uniform float uSsr, uGod;
    uniform vec3 uGodColor;

    ${DEPTH_GLSL}
    ${LUMA_GLSL}

    #ifdef USE_AO
    float upsampleAo(float z) {
      // 4 nearest half-res texels, joint-bilateral against the linear depth stored in .g.
      //
      // The depth weight MUST be bounded. This used to be '1 / (eps + |dz| * 2.2)', which is
      // unbounded: on a flat surface the taps agree to within a millimetre, so their weights land
      // in the thousands and differ by orders of magnitude for no meaningful reason. Whichever tap
      // happens to be nearest in depth wins outright, the bilinear term is annihilated, and the
      // "bilateral upsample" silently degenerates into NEAREST-NEIGHBOUR. That is what reprinted
      // the half-res AO buffer's staircase onto the frame as hard 8-16 px macroblocks — most
      // visibly across the car's glass, which (being drawn without depth writes) inherits the
      // cabin interior's occlusion.
      //
      // An exponential is bounded to (0,1]: identical depths => all four weights 1 => exact
      // bilinear; a real silhouette still drives the far taps to zero. 'tol' grows with distance
      // because both depth-buffer precision and the half-res sample offset do.
      //
      // IMPORTANT, for whoever chases the car's "blocky glass" next: this bound was necessary but
      // it was NOT the cause. The hard rectangles on the greenhouse came from the AO buffer being
      // CORRECT for the wrong surface — the glass is depthWrite:false, so the depth under it is the
      // boxy cabin interior, and this upsample was faithfully reproducing that geometry's
      // occlusion. It is fixed in AoPass by stamping those surfaces out of the AO buffer entirely
      // (see the transparent-exclusion mask). Widening or narrowing anything here does nothing to
      // that class of artefact.
      vec2 uv = vUv / uAoTexel - 0.5;
      vec2 base = floor(uv);
      vec2 f = uv - base;
      float tol = 0.045 * z + 0.06;
      float sum = 0.0, wsum = 0.0;
      for (int y = 0; y < 2; y++) {
        for (int x = 0; x < 2; x++) {
          vec2 o = base + vec2(float(x), float(y)) + 0.5;
          vec2 t = texture2D(tAo, o * uAoTexel).rg;
          float bw = (x == 0 ? 1.0 - f.x : f.x) * (y == 0 ? 1.0 - f.y : f.y);
          float dw = exp(-abs(t.g - z) / tol);
          // The +0.04 floor keeps a rejected tap contributing a few per cent, so the transition
          // across a silhouette is a gradient rather than a step, and wsum can never underflow.
          sum += t.r * bw * (dw + 0.04);
          wsum += bw * (dw + 0.04);
        }
      }
      return sum / max(wsum, 1e-4);
    }
    #endif

    void main() {
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      float d = texture2D(tDepth, vUv).x;
      float z = linearDepth(d, uNearFar.x, uNearFar.y);
      float isSky = step(0.9999, d);

      #ifdef USE_SSR
        vec4 ssr = texture2D(tSsr, vUv);
        col = mix(col, ssr.rgb, clamp(ssr.a * uSsr, 0.0, 1.0) * (1.0 - isSky));
      #endif

      #ifdef USE_AO
        // Floor the occlusion: nothing on an exterior surface has literally zero sky visibility,
        // and letting AO reach 0 lets any depth/beauty mismatch punch a black hole in the frame.
        float ao = clamp(upsampleAo(z), uAo.z, 1.0);
        // Do not occlude what is producing its own light. The threshold is in LINEAR HDR radiance,
        // and it has to sit well above "brightly lit": a white kerb in direct golden-hour sun runs
        // past 1.0 here, so the old 0.9 knee was quietly cancelling the contact shadow on exactly
        // the sunlit ground the car is supposed to be sitting on. Neon and tail lights are authored
        // several stops above this, so they stay protected.
        float guard = 1.0 - clamp((luma(col) - 2.4) * uAo.y, 0.0, 1.0);
        float k = mix(1.0, ao, uAo.x * guard * (1.0 - isSky));
        col *= k;
      #endif

      #ifdef USE_GOD
        col += texture2D(tGod, vUv).rgb * uGodColor * uGod;
      #endif

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
