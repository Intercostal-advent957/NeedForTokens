import * as THREE from 'three';

/**
 * The road surface shader.
 *
 * Markings are NOT a texture. Every vertex carries `aTrk = (s, lateral, halfWidth)` — true arc
 * length in metres and true signed distance from the centreline in metres — so the fragment
 * shader draws lines, dashes, arrows and the grid box analytically in world units. A 3 m dash
 * with a 6 m gap is exactly that everywhere on the lap, whether it is on the 650 m straight or
 * wrapped around a 26 m hairpin, and it stays razor sharp at any distance because it is
 * antialiased with fwidth rather than resolved by a texel.
 *
 * Bands (aMisc.x): 0 road · 1 kerb · 2 shoulder · 3 run-off · 4 verge.
 */

const COMMON = /* glsl */ `
varying vec4 vTrk;      // s (m), lateral (m), halfWidth (m), inside-tunnel 0..1
varying vec4 vMisc;     // band, runoffType, kerbStyle, |curvature|
varying vec3 vWorld;
`;

const VERT = /* glsl */ `
attribute vec4 aTrk;
attribute vec4 aMisc;
${COMMON}
`;

const FRAG_HELPERS = /* glsl */ `
${COMMON}
uniform sampler2D uGround;
uniform float uWetness;   // shared with assets.wetness — the whole world dresses together
uniform float uRain;
uniform float uTime;
uniform float uWetLocal;  // fallback when the assets lane is not driving the shared uniform

float h21(vec2 p){ p = fract(p*vec2(127.1,311.7)); p += dot(p, p+34.23); return fract(p.x*p.y*4093.7); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  float a = h21(i), b = h21(i+vec2(1,0)), c = h21(i+vec2(0,1)), d = h21(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
float fbm(vec2 p){ return vnoise(p)*0.55 + vnoise(p*2.13)*0.28 + vnoise(p*4.7)*0.17; }

/* Antialiased: is x inside a band of half-width w centred on c */
float stripe(float x, float c, float w){
  float d = abs(x - c) - w;
  return 1.0 - smoothstep(-fwidth(x), fwidth(x), d);
}
/* Antialiased dash gate along arc length: on metres painted out of every period metres */
float dash(float s, float period, float on, float phase){
  float f = fract(s/period + phase) * period;
  float aa = fwidth(s) + 1e-4;
  return smoothstep(-aa, aa, f) * (1.0 - smoothstep(on - aa, on + aa, f));
}
/* Antialiased transverse band: painted between s0 and s1 */
float across(float s, float s0, float s1){
  float aa = fwidth(s) + 1e-4;
  return smoothstep(s0 - aa, s0 + aa, s) * (1.0 - smoothstep(s1 - aa, s1 + aa, s));
}
/* Filled triangle pointing along +s: an arrow head */
float arrowHead(vec2 p, float halfW, float len){
  float side = abs(p.x)/max(halfW,1e-3) + p.y/max(len,1e-3);
  float aa = fwidth(side)*1.2 + 1e-4;
  float inTri = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, side);
  return inTri * (1.0 - smoothstep(-aa, aa, -p.y));
}
`;

/**
 * Fragment body. Writes:
 *   roadAlbedo, roadRough  — before it is folded into diffuseColor / roughnessFactor
 */
const FRAG_ALBEDO = /* glsl */ `
  float band   = vMisc.x;
  float roType = vMisc.y;
  float kStyle = vMisc.z;
  float curv   = vMisc.w;

  float s   = vTrk.x;
  float lat = vTrk.y;
  float W   = max(vTrk.z, 1.0);
  float bore = vTrk.w;

  vec3  albedo = vec3(0.5);
  float rough  = 1.0;
  float spec   = 0.5;

  // ------------------------------------------------------------------ ASPHALT / SHOULDER
  // nftOrm / nftAlb come from the two-tap anti-tiling sample done just above; R = AO,
  // G = roughness, B = metalness in the packed ORM the materials lane hands us.
  if (band < 1.5) {
    vec3 tex = nftAlb;
    // The placeholder texture is flat grey; the macro detail below is what actually sells it,
    // and it keeps working when the materials lane drops a real asphalt map in.
    float grain = fbm(vec2(lat, s) * 0.9) - 0.5;
    float macro = fbm(vec2(lat * 0.10, s * 0.022)) * 0.7 + fbm(vec2(lat * 0.03, s * 0.006)) * 0.3;

    // Linear albedo, held at real asphalt values (0.07-0.13). Push it higher and the road
    // reads as concrete the moment the environment lane turns the sky up.
    vec3 base = mix(vec3(0.062, 0.061, 0.067), vec3(0.124, 0.121, 0.130), macro);
    base *= (0.80 + tex.r * 0.46) * (0.72 + nftOrm.r * 0.36);
    base += grain * 0.026;

    // --- worn wheel tracks: two polished ribbons per lane where the rubber has gone down
    float laneW  = W / max(1.0, floor(W / 5.0 + 0.5));
    float inLane = mod(abs(lat), laneW) - laneW * 0.5;      // -halfLane .. +halfLane
    float wheel  = exp(-pow((abs(inLane) - 0.78) / 0.34, 2.0));
    wheel *= smoothstep(W + 0.6, W - 0.4, abs(lat));         // only on the running surface
    // --- rubber laid down on the racing line itself: heaviest through the corners, and it is
    //     what makes a circuit look driven rather than freshly paved
    float lineOff = clamp(curv * 900.0, -1.0, 1.0) * W * 0.55;
    float rubber = exp(-pow((lat - lineOff) / (W * 0.42), 2.0)) * smoothstep(0.0008, 0.004, curv);
    base *= 1.0 - wheel * 0.26 - rubber * 0.26;
    rough = 0.96 - wheel * 0.32 - rubber * 0.20;

    // --- longitudinal tar seams where the paving machine overlapped
    float seam = stripe(mod(abs(lat) + laneW * 0.5, laneW), 0.0, 0.035);
    // --- transverse construction joints every 11 m
    float joint = across(mod(s, 11.0), 0.0, 0.05);
    float tar = max(seam, joint) * smoothstep(W + 2.0, W + 1.4, abs(lat));
    base = mix(base, vec3(0.038, 0.037, 0.040), tar * 0.85);
    rough = mix(rough, 0.72, tar * 0.6);

    // --- patch repairs: darker, smoother rectangles of newer bitumen
    vec2 pc = vec2(floor(lat / 5.5), floor(s / 22.0));
    float rep = step(0.80, h21(pc + 3.1));   // 'patch' is a reserved word in GLSL ES 3.0
    vec2 pf = vec2(fract(lat / 5.5), fract(s / 22.0));
    float pw = 0.18 + h21(pc + 7.7) * 0.30;
    float ph = 0.10 + h21(pc + 11.3) * 0.34;
    float inPatch = rep
      * (1.0 - smoothstep(pw, pw + 0.02, abs(pf.x - 0.5)))
      * (1.0 - smoothstep(ph, ph + 0.02, abs(pf.y - 0.5)));
    base = mix(base, vec3(0.050, 0.049, 0.054) * (0.8 + macro * 0.5), inPatch * 0.9);
    rough = mix(rough, 0.80, inPatch * 0.7);

    // --- manhole covers and drain grates, only out toward the gutter
    vec2 mc = vec2(floor(lat / 6.0), floor(s / 47.0));
    if (h21(mc + 21.7) > 0.62 && abs(lat) > W * 0.45) {
      vec2 mCentre = vec2((floor(lat / 6.0) + 0.30 + h21(mc + 5.0) * 0.4) * 6.0,
                          (floor(s / 47.0) + 0.25 + h21(mc + 9.0) * 0.5) * 47.0);
      float md = length(vec2(lat, s) - mCentre);
      float lid  = 1.0 - smoothstep(0.34, 0.36, md);
      float ring = stripe(md, 0.35, 0.030);
      base = mix(base, vec3(0.076, 0.070, 0.062), lid * 0.9);
      base = mix(base, vec3(0.034, 0.031, 0.028), ring);
      rough = mix(rough, 0.62, lid);
      spec  = mix(spec, 0.75, lid);
    }

    // shoulder is coarser, dirtier and a shade lighter than the racing surface
    if (band > 0.5) {
      base = mix(base, vec3(0.098, 0.093, 0.084), 0.55);
      base *= 0.84 + fbm(vec2(lat, s) * 1.7) * 0.38;
      rough = 1.0;
    }

    // ------------------------------------------------------------ ROAD MARKINGS
    float paint = 0.0;
    if (band < 0.5) {
      float edgeAt = W - 0.34;

      // continuous white edge line both sides
      paint += stripe(abs(lat), edgeAt, 0.075);

      // centre line: double solid through the corners, dashed down the straights
      float solid = smoothstep(0.0030, 0.0075, curv);
      float dashPhase = dash(s, 9.0, 3.0, 0.0);
      paint += stripe(lat, -0.16, 0.06) * solid;
      paint += stripe(lat,  0.16, 0.06) * solid;
      paint += stripe(lat,  0.00, 0.07) * (1.0 - solid) * dashPhase;

      // lane dividers, dashed, skipped where the centre pair already sits
      float laneN = floor(W / 5.0 + 0.5);
      float lw = W / max(laneN, 1.0);
      for (int k = 1; k < 4; k++) {
        float fk = float(k);
        if (fk >= laneN) break;
        float pos = fk * lw;
        if (pos > edgeAt - 0.5) break;
        paint += stripe(abs(lat), pos, 0.06) * dash(s, 12.0, 3.5, 0.35);
      }

      // direction arrows in the middle of every lane, every 60 m
      float arrowS = mod(s + 45.0, 90.0) - 45.0;
      float laneIdx = floor(abs(lat) / lw);
      float laneCtr = (laneIdx + 0.5) * lw * sign(lat);
      vec2 ap = vec2(lat - laneCtr, arrowS);
      if (abs(lat) < edgeAt - 0.2) {
        float head = arrowHead(vec2(ap.x, ap.y - 0.6), 0.55, 1.5);
        float stem = stripe(ap.x, 0.0, 0.13) * across(ap.y, -1.8, 0.6);
        paint += clamp(head + stem, 0.0, 1.0);
      }

      // start/finish: solid bar, chequered strip, and the staggered grid boxes behind it
      float sl = mod(s + 60.0, LAP_LENGTH) - 60.0;   // -60 .. +(LAP-60), continuous over the line
      float onRoad = 1.0 - smoothstep(W - 0.36, W - 0.30, abs(lat));
      paint += across(sl, 0.0, 0.55) * onRoad;
      paint += across(sl, 0.75, 1.65) * onRoad
        * step(0.5, mod(floor((sl - 0.75) * 4.44) + floor((lat + W) / 0.45), 2.0));
      // eight 2.6 x 6 m boxes, alternating sides, 8.5 m apart — the real grid spacing
      if (sl < -3.0 && sl > -42.0) {
        float row = floor((-sl - 3.0) / 8.5);
        float gy = mod(-sl - 3.0, 8.5);
        float cx = (mod(row, 2.0) < 0.5 ? -1.0 : 1.0) * W * 0.44;
        float dx = abs(lat - cx);
        float outer = (1.0 - smoothstep(1.28, 1.33, dx)) * across(gy, 0.5, 6.5);
        float inner = (1.0 - smoothstep(1.16, 1.21, dx)) * across(gy, 0.62, 6.38);
        paint += clamp(outer - inner, 0.0, 1.0) * onRoad;
      }

      paint = clamp(paint, 0.0, 1.0);
      // paint is scuffed where the cars run, and never quite white
      float wear = (0.62 + 0.38 * (1.0 - wheel)) * (0.78 + 0.30 * fbm(vec2(lat * 0.4, s * 0.09)));
      base = mix(base, vec3(0.62, 0.62, 0.605) * wear, paint);
      rough = mix(rough, 0.58, paint);
    }
    albedo = base;
  }

  // ------------------------------------------------------------------ KERB
  else if (band < 2.5) {
    float blk = mod(floor(s / 1.0), 2.0);
    vec3 hot = mix(vec3(0.46, 0.052, 0.042), vec3(0.052, 0.115, 0.40), kStyle);
    vec3 col = mix(hot, vec3(0.68, 0.68, 0.665), blk);
    // rubber laid down by everyone who has clipped it, plus general grime
    float scuff = fbm(vec2(lat * 3.0, s * 1.4));
    col *= 0.78 + scuff * 0.42;
    col = mix(col, vec3(0.070, 0.067, 0.067), smoothstep(0.55, 0.95, scuff) * 0.55);
    albedo = col;
    rough = 0.62 + scuff * 0.2;
    spec = 0.6;
  }

  // ------------------------------------------------------------------ RUN-OFF / VERGE
  else {
    vec3 g = texture2D(uGround, vec2(lat, s) * 0.34).rgb;
    float n = fbm(vec2(lat, s) * 0.55);
    float n2 = fbm(vec2(lat, s) * 3.1);
    // These have to sit in the same range as the terrain shader in WorldSystem or the seam
    // between the verge and the world outside it lights up like a stripe.
    vec3 gravel = mix(vec3(0.205, 0.186, 0.155), vec3(0.290, 0.264, 0.222), n);
    gravel *= 0.82 + n2 * 0.36;
    vec3 grass = mix(vec3(0.116, 0.152, 0.076), vec3(0.184, 0.216, 0.104), n);
    grass *= 0.80 + n2 * 0.38;
    float isGravel = band > 3.5 ? 0.0 : roType;   // the verge behind the barrier is always green
    albedo = mix(grass, gravel, isGravel) * (0.86 + g.r * 0.28);
    // A tunnel has a poured concrete margin, not a grass verge, and nothing grows in there.
    vec3 walkway = vec3(0.175, 0.170, 0.163) * (0.82 + n2 * 0.34);
    walkway = mix(walkway, vec3(0.055, 0.053, 0.052), smoothstep(0.05, 0.0, abs(fract(s / 3.0) - 0.5) - 0.47));
    rough = 1.0;
    spec = 0.25;
    albedo = mix(albedo, walkway, bore);
    rough = mix(rough, 0.86, bore);
    // dirt kicked out of the gravel onto the first metre of grass
    albedo = mix(albedo, gravel * 0.8, smoothstep(W + 3.5, W + 2.4, abs(lat)) * (1.0 - isGravel) * 0.5);
  }

  // ------------------------------------------------------------------ WET
  float wetAmt = max(uWetness, uWetLocal);
  float wetMix = 0.0;
  if (wetAmt > 0.001) {
    // Water goes where the road drains it: the crown sheds toward the gutters, and the polished
    // wheel ruts hold a film long after the crown is dry. That is why a wet circuit reads as
    // bright ribbons under the racing line rather than a uniformly shiny slab.
    float puddle = smoothstep(0.48, 0.80, fbm(vec2(lat * 0.7, s * 0.22)));
    puddle = max(puddle * mix(0.30, 1.0, smoothstep(0.15, 1.0, abs(lat) / W)), 0.0);
    wetMix = wetAmt * (0.50 + 0.50 * puddle) * step(band, 2.5) * (1.0 - bore * 0.85);
    albedo *= 1.0 - wetMix * 0.46;
    rough = mix(rough, 0.045, wetMix);
    spec = mix(spec, 1.0, wetMix);
  }
`;

/**
 * Two-tap anti-tiling sample of the materials lane's asphalt set.
 *
 * A 2.4 m tile repeats about forty times down the pit straight and the eye picks that up
 * instantly. Sampling twice — once straight, once rotated and offset — and cross-fading with a
 * low-frequency world-space mask breaks the grid without doubling the apparent detail. Albedo
 * and ORM are blended with the same weight so they never disagree about where a stone is.
 */
const FRAG_SAMPLE = /* glsl */ `
  vec2 nftUvA = vMapUv;
  vec2 nftUvB = vec2(nftUvA.y * 0.87 - nftUvA.x * 0.49, nftUvA.x * 0.87 + nftUvA.y * 0.49) * 0.73
              + vec2(37.1, 11.7);
  float nftBw = smoothstep(0.35, 0.65, fbm(vec2(vTrk.y, vTrk.x) * 0.055)) * 0.5;
  vec3 nftAlb = mix(texture2D(map, nftUvA).rgb, texture2D(map, nftUvB).rgb, nftBw);
  vec3 nftOrm = mix(texture2D(roughnessMap, nftUvA).rgb, texture2D(roughnessMap, nftUvB).rgb, nftBw);
`;

/**
 * Build the single material every road chunk shares.
 *
 * This is a full PBR set — albedo, tangent-space normal and the packed ORM from
 * `assets.texture('asphalt*')` — with the band/marking logic layered over it, rather than the
 * materials lane's `assets.material('road')` factory. That factory keys everything off `vMapUv`
 * and world position, which cannot express arc-length markings, kerbs or the gravel/grass bands.
 * We take its maps and its shared `wetness` / `rain` / `time` uniforms so the road still dresses
 * with the rest of the world when the weather changes.
 */
export function makeRoadMaterial(ctx, lapLength) {
  const { assets } = ctx;
  const tex = (n) => assets?.texture?.(n) ?? null;
  const asphalt = tex('asphalt');
  const asphaltN = tex('asphaltNormal');
  const asphaltR = tex('asphaltRough');
  const ground = tex('dirtAlbedo') ?? asphalt;
  for (const t of [asphalt, asphaltN, asphaltR, ground]) {
    if (t) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  }

  const uniforms = {
    uGround: { value: ground },
    // Shared with the assets lane so weather is one source of truth (see Assets §5).
    uWetness: assets?.wetness ?? { value: 0 },
    uRain: assets?.rain ?? { value: 0 },
    uTime: assets?.time ?? { value: 0 },
    uWetLocal: { value: 0 },
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: asphalt,
    normalMap: asphaltN,
    roughnessMap: asphaltR,
    normalScale: new THREE.Vector2(1.0, 1.0),
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.85,
    dithering: true,
  });
  mat.name = 'NFT_RoadSurface';
  mat.userData.uniforms = uniforms;
  mat.userData.sharedWetness = !!assets?.wetness;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vTrk = aTrk;
         vMisc = aMisc;
         vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n#define LAP_LENGTH ${lapLength.toFixed(2)}\n${FRAG_HELPERS}`
      )
      .replace(
        '#include <map_fragment>',
        `${FRAG_SAMPLE}\n${FRAG_ALBEDO}\n  diffuseColor.rgb *= albedo;`
      )
      // Roughness: our band value carries the shape (paint, kerb, rubber, water), the ORM green
      // channel carries the grain. Multiplying keeps both.
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = clamp(rough * (0.72 + nftOrm.g * 0.56), 0.035, 1.0);`
      )
      // `spec` is folded into metalness rather than a specular slot: wet asphalt and a steel
      // manhole lid both want a tighter, brighter environment reflection, and metalness is the
      // one knob MeshStandardMaterial gives you for that.
      .replace(
        '#include <metalnessmap_fragment>',
        `float metalnessFactor = clamp((spec - 0.5) * 0.44, 0.0, 0.30);`
      )
      // Normal mapping belongs to the asphalt only — the grass and gravel bands would inherit
      // tarmac grain — and standing water flattens it out, which is most of why a wet road
      // mirrors the neon instead of scattering it.
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         float nftNrmAmt = (1.0 - step(2.5, band)) * (1.0 - wetMix * 0.85);
         normal = normalize(mix(nonPerturbedNormal, normal, nftNrmAmt));`
      );
    mat.userData.shader = shader;
  };
  // Distinct cache key so this program never gets shared with a plain MeshStandardMaterial.
  mat.customProgramCacheKey = () => 'nft-road-v2';
  return mat;
}
