import * as THREE from 'three';
import { FsPass } from './Fullscreen.js';
import { ACES_GLSL, HASH_GLSL, LUMA_GLSL, SRGB_GLSL } from './ShaderLib.js';
import { LUT_GLSL, LUT_SIZE } from './Lut.js';

/**
 * The one place the frame leaves HDR.
 *
 * order (this order matters and is the standard film chain):
 *   chromatic aberration -> bloom + flare + dirt composite -> exposure (env base x eye adaptation)
 *   -> ACES filmic -> sRGB encode -> creative LUT -> vignette -> grain
 *
 * Notes:
 *  - We tone map here rather than with OutputPass because the creative grade has to sit on the
 *    display-referred side of the curve. Applying a LUT to unbounded HDR is meaningless.
 *  - The ACES implementation is byte-identical to three's so the image does not shift when post
 *    is toggled; `renderer.toneMapping` is left alone for anything else that renders to screen.
 *  - CA is attenuated in blown highlights. Radial channel offset across a 5000-nit sun edge is
 *    exactly how you get the rainbow ring in the old build — you cannot fix it by lowering the
 *    global amount, you have to make it luminance-aware.
 */
export class GradePass extends FsPass {
  constructor() {
    super(SHADER, { LUT_SIZE: LUT_SIZE.toFixed(1) });
  }
}

const SHADER = {
  name: 'grade',
  uniforms: {
    tDiffuse: { value: null },
    tBloom: { value: null },
    tExposure: { value: null },
    tLut: { value: null },
    tDirt: { value: null },
    tDof: { value: null },
    uDof: { value: 1.0 },

    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uTime: { value: 0 },
    uSpeed: { value: 0 },
    uNos: { value: 0 },

    uExposure: { value: 1.0 },
    uAuto: { value: new THREE.Vector4(0.13, 0.55, 0.4, 2.2) }, // target, strength, minGain, maxGain
    uAutoEnabled: { value: 1 },

    uBloom: { value: 0.055 },
    uBloomTint: { value: new THREE.Color(1, 1, 1) },

    uFlare: { value: new THREE.Vector4(0, 0, 0, 0) }, // sunUv.xy, intensity, streak
    uFlareColor: { value: new THREE.Color(1, 0.86, 0.68) },
    uDirt: { value: 0.0 },

    uLutAmount: { value: 1.0 },
    uCA: { value: 1.0 },
    uVignette: { value: new THREE.Vector2(0.55, 1.0) },
    uGrain: { value: 1.0 },
  },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    uniform sampler2D tExposure;
    uniform sampler2D tLut;
    uniform sampler2D tDirt;
    uniform sampler2D tDof;
    uniform float uDof;

    uniform vec2 uResolution;
    uniform float uTime, uSpeed, uNos;
    uniform float uExposure;
    uniform vec4 uAuto;
    uniform float uAutoEnabled;
    uniform float uBloom;
    uniform vec3 uBloomTint;
    uniform vec4 uFlare;
    uniform vec3 uFlareColor;
    uniform float uDirt;
    uniform float uLutAmount, uCA, uGrain;
    uniform vec2 uVignette;

    ${LUMA_GLSL}
    ${HASH_GLSL}
    ${ACES_GLSL}
    ${SRGB_GLSL}
    ${LUT_GLSL}

    vec3 bloomAt(vec2 uv) { return texture2D(tBloom, uv).rgb; }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);

      // ---------------------------------------------------------------- chromatic aberration
      vec3 col;
      #ifdef USE_CA
        // Zero in the middle third, ramping outward — a real lens is sharp on axis.
        float caRamp = smoothstep(0.02, 0.24, r2);
        float amount = (0.00055 + uSpeed * 0.0022 + uNos * 0.0012) * uCA * caRamp;
        vec3 mid = texture2D(tDiffuse, uv).rgb;
        // Blown highlights fringe as rainbows. Fade the split out as luminance climbs.
        amount *= 1.0 - smoothstep(1.6, 9.0, luma(mid));
        col.r = texture2D(tDiffuse, uv + c * amount).r;
        col.g = mid.g;
        col.b = texture2D(tDiffuse, uv - c * amount).b;
      #else
        col = texture2D(tDiffuse, uv).rgb;
      #endif
      col = max(col, vec3(0.0));

      // ---------------------------------------------------------------- depth of field
      #ifdef USE_DOF
        vec4 dofS = texture2D(tDof, uv);
        col = mix(col, dofS.rgb, clamp(dofS.a * uDof, 0.0, 1.0));
      #endif

      // ---------------------------------------------------------------- bloom + lens
      vec3 bloom = bloomAt(uv);
      vec3 lens = vec3(0.0);

      #ifdef USE_FLARE
        if (uFlare.z > 0.001) {
          vec2 sunUv = uFlare.xy;
          vec2 toC = 0.5 - sunUv;
          // Ghosts: sample the thresholded bloom buffer along the sun->centre axis. Free, and
          // automatically occlusion-aware because an occluded sun is not in the bloom buffer.
          const int GHOSTS = 5;
          for (int i = 1; i <= GHOSTS; i++) {
            float fi = float(i);
            vec2 g = sunUv + toC * (fi * 0.42);
            float fall = 1.0 - clamp(length(g - 0.5) * 1.7, 0.0, 1.0);
            // Slight per-ghost dispersion reads as anamorphic without a rainbow.
            vec3 s = vec3(
              bloomAt(g + toC * 0.006).r,
              bloomAt(g).g,
              bloomAt(g - toC * 0.006).b
            );
            lens += s * fall * fall * (0.16 / fi);
          }
          // Halo ring around the optical axis.
          vec2 haloDir = normalize(toC + 1e-5) * 0.31;
          float haloW = 1.0 - clamp(abs(length(uv - 0.5) - 0.28) * 5.5, 0.0, 1.0);
          lens += bloomAt(uv + haloDir) * haloW * haloW * 0.14;

          // Anamorphic streak straight off the sun.
          float dy = abs(uv.y - sunUv.y);
          float dx = abs(uv.x - sunUv.x);
          float streak = exp(-dy * dy * 6000.0) * exp(-dx * dx * 5.5);
          lens += uFlareColor * streak * uFlare.w;

          lens *= uFlare.z;
          lens *= uFlareColor;
        }
      #endif

      #ifdef USE_DIRT
        if (uDirt > 0.001) {
          vec3 dirt = texture2D(tDirt, uv).rgb;
          lens += bloom * dirt * uDirt * 2.4;
        }
      #endif

      col += bloom * uBloom * uBloomTint;
      col += lens;

      // ---------------------------------------------------------------- exposure
      float exposure = uExposure;
      if (uAutoEnabled > 0.5) {
        float adapted = texture2D(tExposure, vec2(0.5)).r;
        float measured = max(adapted * uExposure, 1e-5);
        float gain = pow(clamp(uAuto.x / measured, 0.02, 50.0), uAuto.y);
        exposure *= clamp(gain, uAuto.z, uAuto.w);
      }

      // ---------------------------------------------------------------- tone map + look
      vec3 disp = linearToSRGB(acesFilmic(col, exposure));

      #ifdef USE_LUT
        disp = mix(disp, sampleLut(tLut, disp, LUT_SIZE), uLutAmount);
      #endif

      // NOS cools and lifts the whole frame a touch — it is a mood shift, not a filter.
      disp = mix(disp, disp * vec3(0.84, 0.95, 1.28) + vec3(0.0, 0.01, 0.035), uNos * 0.3);

      // ---------------------------------------------------------------- vignette
      // Natural (cos^4-ish) falloff rather than a smoothstep disc, so it never shows a ring.
      float v = 1.0 - uVignette.x * pow(clamp(r2 * 1.9 * uVignette.y, 0.0, 1.0), 1.35);
      disp *= v;

      // ---------------------------------------------------------------- grain
      #ifdef USE_GRAIN
        float g = hash12(gl_FragCoord.xy + fract(uTime) * 613.0) - 0.5;
        // Grain lives in the mid-tones on real film: none in the blacks, none in the specular.
        float gw = 1.0 - abs(luma(disp) * 2.0 - 1.0);
        disp += g * gw * (0.016 + uSpeed * 0.006) * uGrain;
      #endif

      gl_FragColor = vec4(max(disp, 0.0), 1.0);
    }
  `,
};
