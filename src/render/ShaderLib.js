/**
 * GLSL shared by every pass in the post stack. Keep these pure functions — no uniforms declared
 * here, the including shader owns its own uniform block.
 */

/** Depth utilities. All of them expect the raw [0,1] depth-buffer value. */
export const DEPTH_GLSL = /* glsl */ `
  // Perspective depth -> positive view-space distance along -Z.
  float linearDepth(float d, float n, float f) {
    return (2.0 * n * f) / (f + n - (d * 2.0 - 1.0) * (f - n));
  }
  // View-space position from uv + raw depth. invProj = camera.projectionMatrixInverse.
  vec3 viewPosFromDepth(vec2 uv, float d, mat4 invProj) {
    vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 v = invProj * clip;
    return v.xyz / v.w;
  }
`;

/**
 * Normal reconstruction from depth. Naive central differences smear across silhouettes; this
 * picks, per axis, whichever neighbour lies closest to the tangent plane (Turánszki's method).
 * Costs 4 extra depth taps and removes the halo that otherwise ruins AO on car edges.
 */
export const RECON_NORMAL_GLSL = /* glsl */ `
  vec3 reconstructNormal(sampler2D tDepth, vec2 uv, vec2 texel, mat4 invProj, vec3 P, float dc) {
    float l1 = texture2D(tDepth, uv - vec2(texel.x, 0.0)).x;
    float l2 = texture2D(tDepth, uv - vec2(texel.x * 2.0, 0.0)).x;
    float r1 = texture2D(tDepth, uv + vec2(texel.x, 0.0)).x;
    float r2 = texture2D(tDepth, uv + vec2(texel.x * 2.0, 0.0)).x;
    float d1 = texture2D(tDepth, uv - vec2(0.0, texel.y)).x;
    float d2 = texture2D(tDepth, uv - vec2(0.0, texel.y * 2.0)).x;
    float u1 = texture2D(tDepth, uv + vec2(0.0, texel.y)).x;
    float u2 = texture2D(tDepth, uv + vec2(0.0, texel.y * 2.0)).x;

    // Extrapolate each pair back to the centre; the side with the smaller error is the one that
    // does not cross a silhouette.
    float el = abs(2.0 * l1 - l2 - dc);
    float er = abs(2.0 * r1 - r2 - dc);
    float ed = abs(2.0 * d1 - d2 - dc);
    float eu = abs(2.0 * u1 - u2 - dc);

    vec3 hDeriv = (el < er)
      ? (P - viewPosFromDepth(uv - vec2(texel.x, 0.0), l1, invProj))
      : (viewPosFromDepth(uv + vec2(texel.x, 0.0), r1, invProj) - P);
    vec3 vDeriv = (ed < eu)
      ? (P - viewPosFromDepth(uv - vec2(0.0, texel.y), d1, invProj))
      : (viewPosFromDepth(uv + vec2(0.0, texel.y), u1, invProj) - P);
    return normalize(cross(hDeriv, vDeriv));
  }
`;

export const LUMA_GLSL = /* glsl */ `
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/** Cheap, well-distributed hashes. */
export const HASH_GLSL = /* glsl */ `
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }
  // Interleaved gradient noise (Jimenez). Unlike a 4x4 Bayer matrix it has no visible tile, which
  // matters enormously for a motion-blur tap offset: Bayer turns an under-sampled smear into a
  // checkerboard you can read off the car's paint.
  float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }
  // 4x4 ordered dither in [0,1) — deterministic, no texture, no temporal shimmer.
  float bayer4(vec2 p) {
    vec2 f = floor(mod(p, 4.0));
    const vec4 r0 = vec4( 0.0,  8.0,  2.0, 10.0);
    const vec4 r1 = vec4(12.0,  4.0, 14.0,  6.0);
    const vec4 r2 = vec4( 3.0, 11.0,  1.0,  9.0);
    const vec4 r3 = vec4(15.0,  7.0, 13.0,  5.0);
    vec4 row = f.y < 1.0 ? r0 : (f.y < 2.0 ? r1 : (f.y < 3.0 ? r2 : r3));
    float v = f.x < 1.0 ? row.x : (f.x < 2.0 ? row.y : (f.x < 3.0 ? row.z : row.w));
    return v * (1.0 / 16.0);
  }
`;

/**
 * three's ACESFilmicToneMapping, character for character (src/renderers/shaders/ShaderChunk/
 * tonemapping_pars_fragment.glsl.js). We do our own tone map so the creative grade can sit on the
 * display-referred side of the curve; this must match exactly or the frame shifts hue the moment
 * post is toggled.
 */
export const ACES_GLSL = /* glsl */ `
  vec3 RRTAndODTFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  vec3 acesFilmic(vec3 color, float exposure) {
    const mat3 ACESInputMat = mat3(
      vec3(0.59719, 0.07600, 0.02840),
      vec3(0.35458, 0.90834, 0.13383),
      vec3(0.04823, 0.01566, 0.83777)
    );
    const mat3 ACESOutputMat = mat3(
      vec3( 1.60475, -0.10208, -0.00327),
      vec3(-0.53108,  1.10813, -0.07276),
      vec3(-0.07367, -0.00605,  1.07602)
    );
    color *= exposure / 0.6;
    color = ACESInputMat * color;
    color = RRTAndODTFit(color);
    color = ACESOutputMat * color;
    return clamp(color, 0.0, 1.0);
  }
`;

export const SRGB_GLSL = /* glsl */ `
  vec3 linearToSRGB(vec3 c) {
    c = max(c, vec3(0.0));
    return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666667)) - 0.055, step(vec3(0.0031308), c));
  }
`;
