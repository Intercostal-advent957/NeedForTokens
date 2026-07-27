/**
 * GLSL noise + surface-detail chunks, as JS template strings.
 * Owned by the MATERIALS lane (CONTRACTS.md §16).
 *
 * These are injected into MeshStandardMaterial via onBeforeCompile. They do the work that a
 * baked texture cannot: world-space macro variation (kills tiling), view-distance-aware detail
 * normals, and wetness/puddle response driven by a single shared uniform.
 */

/** Hashes + value/gradient noise + fbm + worley. Include once per shader. */
export const GLSL_NOISE = /* glsl */ `
#ifndef NFT_NOISE_INCLUDED
#define NFT_NOISE_INCLUDED

float nftHash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float nftHash21(vec2 p){
  vec3 p3 = fract(vec3(p.xyx)*0.1031);
  p3 += dot(p3, p3.yzx+33.33);
  return fract((p3.x+p3.y)*p3.z);
}
vec2 nftHash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
  p3 += dot(p3, p3.yzx+33.33);
  return fract((p3.xx+p3.yz)*p3.zy);
}
float nftHash31(vec3 p){
  p = fract(p*0.1031);
  p += dot(p, p.zyx+31.32);
  return fract((p.x+p.y)*p.z);
}

// Gradient noise, [-1,1].
float nftNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 g00 = nftHash22(i+vec2(0.0,0.0))*2.0-1.0;
  vec2 g10 = nftHash22(i+vec2(1.0,0.0))*2.0-1.0;
  vec2 g01 = nftHash22(i+vec2(0.0,1.0))*2.0-1.0;
  vec2 g11 = nftHash22(i+vec2(1.0,1.0))*2.0-1.0;
  float a = dot(g00, f-vec2(0.0,0.0));
  float b = dot(g10, f-vec2(1.0,0.0));
  float c = dot(g01, f-vec2(0.0,1.0));
  float d = dot(g11, f-vec2(1.0,1.0));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y)*1.4142;
}

float nftNoise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  float n000 = nftHash31(i+vec3(0,0,0));
  float n100 = nftHash31(i+vec3(1,0,0));
  float n010 = nftHash31(i+vec3(0,1,0));
  float n110 = nftHash31(i+vec3(1,1,0));
  float n001 = nftHash31(i+vec3(0,0,1));
  float n101 = nftHash31(i+vec3(1,0,1));
  float n011 = nftHash31(i+vec3(0,1,1));
  float n111 = nftHash31(i+vec3(1,1,1));
  return mix(mix(mix(n000,n100,f.x),mix(n010,n110,f.x),f.y),
             mix(mix(n001,n101,f.x),mix(n011,n111,f.x),f.y), f.z)*2.0-1.0;
}

float nftFbm(vec2 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for(int i=0;i<6;i++){
    if(i>=oct) break;
    s += a*nftNoise(p); n += a; p *= 2.03; a *= 0.5;
  }
  return s/max(n,1e-4);
}

float nftFbm3(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for(int i=0;i<5;i++){
    if(i>=oct) break;
    s += a*nftNoise3(p); n += a; p *= 2.03; a *= 0.5;
  }
  return s/max(n,1e-4);
}

// Worley F1 in x, F2-F1 in y.
vec2 nftWorley(vec2 p, float jitter){
  vec2 i = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
    vec2 o = vec2(float(x), float(y));
    vec2 c = (nftHash22(i+o)-0.5)*jitter+0.5;
    float d = length(o+c-f);
    if(d<f1){ f2=f1; f1=d; } else if(d<f2){ f2=d; }
  }
  return vec2(f1, f2-f1);
}

#endif
`;

/**
 * Macro / anti-tiling helpers.
 *
 * `nftMacro` returns a slow world-space variation in [-1,1]; multiply albedo and bias roughness
 * with it and a 200×-repeated tile stops reading as a repeat. `nftBlendUv` produces the second,
 * rotated, differently-scaled UV set used for the two-tap decorrelation blend.
 */
export const GLSL_MACRO = /* glsl */ `
#ifndef NFT_MACRO_INCLUDED
#define NFT_MACRO_INCLUDED

// Three octaves of world-space noise, weighted hard toward the *very* low frequencies.
// Mid-frequency macro variation is the trap: at 20-40 m wavelength it stops reading as
// "this stretch of road is older" and starts reading as "the ground is lumpy".
float nftMacro(vec3 wp, float scale){
  float a = nftNoise(wp.xz * (0.0090*scale) + 31.7);   // ~110 m
  float b = nftNoise(wp.xz * (0.0320*scale) + 71.3);   // ~30 m
  float c = nftNoise(wp.xz * (0.0022*scale) + 91.3);   // ~450 m
  return c*0.60 + a*0.29 + b*0.11;
}

// 2nd UV set: different scale + ~57 degree rotation + offset. Decorrelates the tile rhythm.
vec2 nftBlendUv(vec2 uv){
  const mat2 R = mat2(0.5446, -0.8387, 0.8387, 0.5446);
  return R * uv * 0.3717 + vec2(0.371, 0.719);
}

// Weight for the 2nd tap, from a slow world-space noise. Never a hard edge.
float nftBlendW(vec3 wp){
  return smoothstep(-0.35, 0.35, nftNoise(wp.xz*0.031 + 7.7)) * 0.5;
}

// Reoriented normal blend (Barré-Brisebois/Whittle). Correct way to layer a detail normal.
vec3 nftBlendNormals(vec3 base, vec3 detail){
  vec3 t = base + vec3(0.0, 0.0, 1.0);
  vec3 u = detail * vec3(-1.0, -1.0, 1.0);
  return normalize(t*dot(t,u) - u*t.z);
}

#endif
`;

/**
 * Wetness response. Shared by road, concrete, curb, ground.
 * Uniforms expected: `uWetness` (float 0..1, the shared assets.wetness hook), `uPuddleTex`,
 * `uTime`, and `uRain` (0..1).
 *
 * Physically: water fills the microfacet valleys, so roughness collapses and albedo darkens
 * (light that used to scatter out now refracts into the film and is absorbed). Puddles go
 * further — near-mirror, and they flatten the normal completely.
 */
export const GLSL_WETNESS = /* glsl */ `
#ifndef NFT_WET_INCLUDED
#define NFT_WET_INCLUDED

// Returns: x = wet factor 0..1, y = puddle factor 0..1
vec2 nftWetFactors(vec3 wp, float wetness, float cavity){
  if(wetness <= 0.001) return vec2(0.0);
  // Puddles pool in low spots: use a warped low-frequency field as a fake height.
  vec2 q = wp.xz*0.055;
  float h = nftFbm(q + vec2(nftFbm(q*0.5,2)*1.4, nftFbm(q*0.5+13.1,2)*1.4), 4);
  // Cavity from the material's own AO/height biases where water collects.
  h -= (1.0-cavity)*0.35;
  float thresh = mix(0.62, -0.30, wetness);
  float pud = smoothstep(thresh, thresh+0.16, h);
  return vec2(wetness, pud*wetness);
}

// Split in two because the albedo/roughness half must run in <roughnessmap_fragment> (which
// always exists) while the normal half must run in <normal_fragment_maps> (which only exists
// when the material has a normal map). Keeping them together silently disabled wetness on
// every surface without one.
void nftApplyWetSurface(inout vec3 albedo, inout float rough, vec2 wf, float sheen){
  float w = wf.x, p = wf.y;
  // Damp film: water fills the microfacet valleys, so light that used to scatter back out is
  // refracted into the film and absorbed — darker *and* smoother, not just darker.
  albedo *= mix(1.0, 0.44, w*0.85);
  rough = mix(rough, rough*0.34 + 0.035, w*0.9);
  // Standing water: near-mirror.
  albedo = mix(albedo, albedo*0.30, p);
  rough = mix(rough, 0.022 + sheen*0.05, p);
}

void nftApplyWetNormal(inout vec3 nrm, vec2 wf){
  nrm = normalize(mix(nrm, vec3(0.0,0.0,1.0), wf.y*0.94));
}

// Back-compat single-call form.
void nftApplyWet(inout vec3 albedo, inout float rough, inout vec3 nrm, vec2 wf, float sheen){
  nftApplyWetSurface(albedo, rough, wf, sheen);
  nftApplyWetNormal(nrm, wf);
}
#endif
`;

/** Triplanar sampling — for cliffs/terrain and anything with unreliable UVs. */
export const GLSL_TRIPLANAR = /* glsl */ `
#ifndef NFT_TRIPLANAR_INCLUDED
#define NFT_TRIPLANAR_INCLUDED
vec4 nftTriplanar(sampler2D t, vec3 wp, vec3 n, float scale){
  vec3 b = pow(abs(n), vec3(4.0));
  b /= max(b.x+b.y+b.z, 1e-4);
  vec4 x = texture2D(t, wp.zy*scale);
  vec4 y = texture2D(t, wp.xz*scale);
  vec4 z = texture2D(t, wp.xy*scale);
  return x*b.x + y*b.y + z*b.z;
}
#endif
`;

/** Everything, for shaders that want the lot. */
export const GLSL_ALL = GLSL_NOISE + GLSL_MACRO + GLSL_WETNESS + GLSL_TRIPLANAR;
