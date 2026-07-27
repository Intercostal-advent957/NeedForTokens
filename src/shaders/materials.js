/**
 * Material factories. Owned by the MATERIALS lane.
 *
 * Everything here is a MeshStandardMaterial/MeshPhysicalMaterial with a surgical
 * `onBeforeCompile` patch, so it keeps three.js lighting, shadows, IBL, fog and tone mapping
 * intact and only overrides the three chunks that matter: map, roughness, normal.
 *
 * The three problems these patches exist to solve:
 *  1. TILING. A 12 m tile repeated 150× down a road has an obvious rhythm. Fixed with a
 *     world-space macro multiplier (which mips can never average away, so it also keeps the
 *     surface alive at 300 m) plus a low-weight second tap at a rotated, rescaled UV.
 *  2. FLAT MICRO-DETAIL UP CLOSE. Texture detail is gone by ~2 m from the camera. Fixed with a
 *     procedural world-space detail normal that fades in as you approach.
 *  3. WETNESS. A dry road and a wet road are different materials, not a darker colour. Water
 *     collapses roughness, darkens albedo, and flattens normals inside puddles.
 */

import * as THREE from 'three';
import { GLSL_NOISE, GLSL_MACRO, GLSL_WETNESS } from './noise.glsl.js';

const PREAMBLE = GLSL_NOISE + GLSL_MACRO + GLSL_WETNESS;

/** Vertex-side varyings every patched material shares. */
const VERT_PARS = /* glsl */ `
varying vec3 vNftW;
varying vec2 vNftUv;
varying float vNftDist;
`;
const VERT_BODY = /* glsl */ `
vec4 nftWp = modelMatrix * vec4( transformed, 1.0 );
vNftW = nftWp.xyz;
vNftUv = uv;
vNftDist = length( cameraPosition - nftWp.xyz );
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vNftW;
varying vec2 vNftUv;
varying float vNftDist;
uniform float uWetness;
uniform float uRain;
uniform float uTime;
uniform float uMacroAmt;
uniform float uMacroScale;
uniform float uBlendAmt;
uniform float uDetailAmt;
uniform float uDetailScale;
uniform float uDetailFade;
` + PREAMBLE;

/** Attach the shared varyings to a shader object produced by onBeforeCompile. */
function patchVertex(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + VERT_PARS)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_BODY);
}

function addUniforms(shader, u) {
  Object.assign(shader.uniforms, u);
}

/**
 * Shared uniform block. `wetness` is the object handed out as `assets.wetness` so a single
 * `assets.wetness.value = 0.8` re-dresses every surface in the world at once.
 */
export function makeSharedUniforms() {
  return {
    wetness: new THREE.Uniform(0),
    rain: new THREE.Uniform(0),
    time: new THREE.Uniform(0),
  };
}

// ============================================================================ ROAD
/**
 * The hero surface. Asphalt with macro variation, wheel-track polish, close-range detail
 * normal, and full wetness response.
 *
 * `laneMap` maps the raw uv.x of the road mesh onto a lateral coordinate in [-1, 1] across the
 * full carriageway, so the shader can put the polished wheel tracks where the wheels actually
 * are. Default matches the world lane's current cross-section (uv.x spans 0..3.2).
 */
export function makeRoadMaterial(assets, opts = {}) {
  const {
    macroAmt = 0.14,
    macroScale = 1.0,
    blendAmt = 0.28,
    detailAmt = 0.055,
    detailScale = 26.0,
    detailFade = 16.0,
    wheelPolish = 0.85,
    laneMap = new THREE.Vector2(1 / 1.6, -1.0),
    normalScale = 1.0,
    envMapIntensity = 0.75,
    ...rest
  } = opts;

  const mat = new THREE.MeshStandardMaterial({
    map: assets.texture('asphalt'),
    normalMap: assets.texture('asphaltNormal'),
    roughnessMap: assets.texture('asphaltRough'),
    aoMap: assets.texture('asphaltRough'),
    aoMapIntensity: 0.85,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity,
    normalScale: new THREE.Vector2(normalScale, normalScale),
    dithering: true,
    ...rest,
  });
  mat.name = 'NFT_Road';

  const uni = {
    uWetness: assets.wetness,
    uRain: assets.rain,
    uTime: assets.time,
    uMacroAmt: { value: macroAmt },
    uMacroScale: { value: macroScale },
    uBlendAmt: { value: blendAmt },
    uDetailAmt: { value: detailAmt },
    uDetailScale: { value: detailScale },
    uDetailFade: { value: detailFade },
    uWheelPolish: { value: wheelPolish },
    uLaneMap: { value: laneMap },
  };

  mat.onBeforeCompile = (shader) => {
    patchVertex(shader);
    addUniforms(shader, uni);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n' + FRAG_PARS + '\nuniform float uWheelPolish;\nuniform vec2 uLaneMap;\n' +
          /* glsl */ `
        // Lateral position across the carriageway, -1..1. Wheel tracks live at |lat| ~0.30 and ~0.68.
        float nftWheelTrack(){
          float lat = vNftUv.x * uLaneMap.x + uLaneMap.y;
          float a = exp( -pow( (abs(lat) - 0.30) / 0.135, 2.0 ) );
          float b = exp( -pow( (abs(lat) - 0.68) / 0.115, 2.0 ) );
          // Break the perfect gaussian up so it never reads as an airbrushed stripe.
          float wob = nftFbm( vec2( vNftW.x, vNftW.z ) * 0.035, 3 ) * 0.35 + 0.85;
          return clamp( max(a,b) * wob, 0.0, 1.0 ) * uWheelPolish;
        }
        `
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        float nftMac = nftMacro( vNftW, uMacroScale );
        float nftTrk = nftWheelTrack();
        vec2 nftUvB = nftBlendUv( vMapUv );
        float nftBw = nftBlendW( vNftW ) * uBlendAmt * 2.0;

        // --- close-range procedural grain -------------------------------------------------
        // Texel density from a 12 m tile runs out around 2 m from the camera. Below that the
        // surface is carried entirely by this: world-space aggregate noise for both the
        // albedo speckle and the normal, faded in as the camera approaches.
        // The epsilon must be small relative to the noise wavelength or the finite difference
        // returns a wildly overestimated gradient — that is what turns "asphalt grain" into
        // "corrugated mud". Divide the difference by e and gate the slope with uDetailAmt.
        float nftFade = 1.0 - smoothstep( uDetailFade * 0.4, uDetailFade, vNftDist );
        vec3 nftDetN = vec3( 0.0, 0.0, 1.0 );
        float nftGrain = 0.0;
        if( nftFade > 0.002 ){
          vec2 dp = vNftW.xz * uDetailScale;
          const float e = 0.12;
          float n0 = nftFbm( dp, 2 );
          float nx = nftFbm( dp + vec2(e,0.0), 2 );
          float ny = nftFbm( dp + vec2(0.0,e), 2 );
          vec2 grad = vec2( nx - n0, ny - n0 ) / e;
          nftDetN = normalize( vec3( -grad * uDetailAmt, 1.0 ) );
          nftGrain = n0;
        }

        vec4 nftA = texture2D( map, vMapUv );
        vec4 nftB = texture2D( map, nftUvB );
        vec4 sampledDiffuseColor = mix( nftA, nftB, nftBw );
        // Restore the contrast the blend just averaged away.
        sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb,
          (sampledDiffuseColor.rgb - 0.5) * (1.0 + nftBw * 0.55) + 0.5, 0.85 );

        // Macro tonal drift — survives mipping, so the road still lives at 300 m.
        sampledDiffuseColor.rgb *= 1.0 + nftMac * uMacroAmt;
        // Traffic-polished wheel tracks: darker, because the aggregate is worn smooth and
        // filled with rubber and oil.
        sampledDiffuseColor.rgb *= mix( 1.0, 0.74, nftTrk );
        // The unswept centre and edges collect pale dust.
        sampledDiffuseColor.rgb *= 1.0 + (1.0 - nftTrk) * max(nftMac, 0.0) * 0.12;
        // Up close, sprinkle the aggregate back in (albedo speckle is independent of the
        // normal slope — it can be far stronger without producing specular sparkle).
        sampledDiffuseColor.rgb *= 1.0 + nftGrain * nftFade * 0.30;

        diffuseColor *= sampledDiffuseColor;
        `
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        float roughnessFactor = roughness;
        {
          float rA = texture2D( roughnessMap, vMapUv ).g;
          float rB = texture2D( roughnessMap, nftUvB ).g;
          float r = mix( rA, rB, nftBw );
          r *= 1.0 + nftMac * 0.16;
          r = mix( r, r * 0.66, nftTrk );          // polished tracks are markedly glossier
          roughnessFactor *= clamp( r, 0.02, 1.0 );
        }
        // Water. Puddles pool in the ruts, so bias the pooling field with the wheel tracks.
        vec2 nftWf = nftWetFactors( vNftW, uWetness, 1.0 - nftTrk * 0.55 );
        nftApplyWetSurface( diffuseColor.rgb, roughnessFactor, nftWf, 0.0 );
        `
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
          vec3 mapNB = texture2D( normalMap, nftUvB ).xyz * 2.0 - 1.0;
          mapN = normalize( mix( mapN, mapNB, nftBw ) );

          // Close-range procedural grain so the surface doesn't go smooth under the bumper.
          if( nftFade > 0.002 ){
            mapN = nftBlendNormals( mapN, mix( vec3(0.0,0.0,1.0), nftDetN, nftFade ) );
          }
          // Wheel tracks are worn flatter than the shoulder.
          mapN = normalize( mix( mapN, vec3(0.0,0.0,1.0), nftTrk * 0.30 ) );

          nftApplyWetNormal( mapN, nftWf );
          // Rain ripples on standing water. Two counter-scrolling noise fields differenced —
          // cheaper than a heightfield sim and reads correctly at speed.
          if( nftWf.y > 0.01 && uRain > 0.01 ){
            vec2 rp = vNftW.xz * 3.1;
            float rip = nftFbm( rp + vec2( uTime * 0.9, uTime * 1.37 ), 2 )
                      - nftFbm( rp - vec2( uTime * 1.11, uTime * 0.83 ), 2 );
            mapN = normalize( mapN + vec3( rip * 0.35, rip * 0.35, 0.0 ) * nftWf.y * uRain );
          }

          mapN.xy *= normalScale;
          normal = normalize( tbn * mapN );
        #endif
        `
      );
  };
  // Any change to the injected source needs a new program.
  mat.customProgramCacheKey = () => 'nft_road_v4';
  mat.userData.nft = uni;
  return mat;
}

// ============================================================================ GENERIC WET SURFACE
/**
 * Any surface + the global wetness response, without the road's lane logic.
 * Use for pavements, concrete aprons, kerbs, the ground plane, tunnel floors.
 */
export function makeWetSurfaceMaterial(assets, opts = {}) {
  const {
    map = null,
    normalMap = null,
    ormMap = null,
    macroAmt = 0.12,
    macroScale = 1.0,
    blendAmt = 0.22,
    detailAmt = 0.04,
    detailScale = 24.0,
    detailFade = 14.0,
    puddles = true,
    ...rest
  } = opts;

  const mat = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    roughnessMap: ormMap,
    aoMap: ormMap,
    metalnessMap: ormMap,
    aoMapIntensity: 0.8,
    roughness: 1.0,
    metalness: ormMap ? 1.0 : 0.0,
    envMapIntensity: 0.7,
    ...rest,
  });
  mat.name = 'NFT_WetSurface';

  const uni = {
    uWetness: assets.wetness,
    uRain: assets.rain,
    uTime: assets.time,
    uMacroAmt: { value: macroAmt },
    uMacroScale: { value: macroScale },
    uBlendAmt: { value: blendAmt },
    uDetailAmt: { value: detailAmt },
    uDetailScale: { value: detailScale },
    uDetailFade: { value: detailFade },
    uPuddles: { value: puddles ? 1 : 0 },
  };

  mat.onBeforeCompile = (shader) => {
    patchVertex(shader);
    addUniforms(shader, uni);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS + '\nuniform float uPuddles;\n')
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        float nftMac = nftMacro( vNftW, uMacroScale );
        #ifdef USE_MAP
          vec2 nftUvB = nftBlendUv( vMapUv );
          float nftBw = nftBlendW( vNftW ) * uBlendAmt * 2.0;
          vec4 sampledDiffuseColor = mix( texture2D( map, vMapUv ), texture2D( map, nftUvB ), nftBw );
          sampledDiffuseColor.rgb *= 1.0 + nftMac * uMacroAmt;
          diffuseColor *= sampledDiffuseColor;
        #else
          vec2 nftUvB = vec2(0.0);
          float nftBw = 0.0;
          diffuseColor.rgb *= 1.0 + nftMac * uMacroAmt;
        #endif
        `
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
          float r = mix( texture2D( roughnessMap, vRoughnessMapUv ).g, texture2D( roughnessMap, nftUvB ).g, nftBw );
          roughnessFactor *= clamp( r * (1.0 + nftMac * 0.14), 0.02, 1.0 );
        #endif
        vec2 nftWf = nftWetFactors( vNftW, uWetness, 1.0 );
        nftWf.y *= uPuddles;
        nftApplyWetSurface( diffuseColor.rgb, roughnessFactor, nftWf, 0.0 );
        `
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = normalize( mix(
            texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0,
            texture2D( normalMap, nftUvB ).xyz * 2.0 - 1.0, nftBw ) );
          float dFade = 1.0 - smoothstep( uDetailFade * 0.4, uDetailFade, vNftDist );
          if( dFade > 0.001 && uDetailAmt > 0.001 ){
            vec2 dp = vNftW.xz * uDetailScale;
            const float e = 0.12;
            float n0 = nftFbm( dp, 2 );
            float nx = nftFbm( dp + vec2(e,0.0), 2 );
            float ny = nftFbm( dp + vec2(0.0,e), 2 );
            vec3 dN = normalize( vec3( -vec2( nx - n0, ny - n0 ) / e * uDetailAmt, 1.0 ) );
            mapN = nftBlendNormals( mapN, mix( vec3(0.0,0.0,1.0), dN, dFade ) );
          }
          nftApplyWetNormal( mapN, nftWf );
          mapN.xy *= normalScale;
          normal = normalize( tbn * mapN );
        #endif
        `
      );
  };
  mat.customProgramCacheKey = () => 'nft_wet_v4';
  mat.userData.nft = uni;
  return mat;
}

// ============================================================================ GLASS
/**
 * Automotive / architectural glass. Physically it is a thin dielectric: near-zero roughness,
 * strong Fresnel, a dark interior, and — crucially — *grime*, because perfectly clean glass
 * reads as a hole in the mesh.
 */
export function makeGlassMaterial(assets, opts = {}) {
  const {
    tint = 0x0b1016,
    opacity = 0.62,
    transmission = 0,
    grime = 0.55,
    roughness = 0.045,
    envMapIntensity = 2.4,
    ...rest
  } = opts;

  const mat = new THREE.MeshPhysicalMaterial({
    color: tint,
    metalness: 0.0,
    roughness,
    transmission,
    thickness: transmission > 0 ? 0.35 : 0,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    normalMap: assets.texture('glassDirtNormal'),
    normalScale: new THREE.Vector2(0.25, 0.25),
    ...rest,
  });
  mat.name = 'NFT_Glass';

  const uni = {
    uWetness: assets.wetness,
    uRain: assets.rain,
    uTime: assets.time,
    uGrime: { value: grime },
    uDirt: { value: assets.texture('glassDirt') },
  };

  mat.onBeforeCompile = (shader) => {
    patchVertex(shader);
    addUniforms(shader, uni);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n' + VERT_PARS.replace(/varying/g, 'varying') +
          '\nuniform float uWetness;\nuniform float uRain;\nuniform float uTime;\nuniform float uGrime;\nuniform sampler2D uDirt;\n' + PREAMBLE
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        float roughnessFactor = roughness;
        {
          vec4 d = texture2D( uDirt, vNftUv * 2.0 );
          float g = d.a * uGrime;
          diffuseColor.rgb = mix( diffuseColor.rgb, d.rgb * 0.55, g * 0.7 );
          diffuseColor.a = clamp( diffuseColor.a + g * 0.45, 0.0, 1.0 );
          roughnessFactor = clamp( roughnessFactor + g * 0.35, 0.01, 1.0 );
          // Rain beading raises roughness variance and lifts opacity.
          roughnessFactor = mix( roughnessFactor, 0.02, uWetness * 0.5 );
        }
        `
      );
  };
  mat.customProgramCacheKey = () => 'nft_glass_v3';
  mat.userData.nft = uni;
  return mat;
}

// ============================================================================ SIGNAGE
/**
 * Emissive neon / LED signage. Bloom does the halo, so what this needs to get right is the
 * *body*: a saturated emissive core that does not blow to white, a faint unlit substrate so the
 * sign still exists in daylight, and a slow flicker/hum on some units.
 */
export function makeSignageMaterial(assets, opts = {}) {
  const {
    // ACES rolls saturated emissives toward white fast. A neon sign stays *coloured* by keeping
    // the emissive modest and letting bloom supply the apparent brightness; push intensity past
    // ~2.5 and every sign in the city turns into the same pale blob.
    color = 0xff2e63,
    intensity = 1.15,
    flicker = 0.0,
    substrate = 0x0a0a0c,
    map = null,
    ...rest
  } = opts;

  const mat = new THREE.MeshStandardMaterial({
    color: substrate,
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
    emissiveMap: map,
    map,
    roughness: 0.35,
    metalness: 0.0,
    toneMapped: true,
    ...rest,
  });
  mat.name = 'NFT_Signage';

  const uni = {
    uTime: assets.time,
    uFlicker: { value: flicker },
    uSeed: { value: Math.random() * 100 },
  };

  mat.onBeforeCompile = (shader) => {
    addUniforms(shader, uni);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uFlicker;\nuniform float uSeed;\n' + GLSL_NOISE)
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `
        #include <emissivemap_fragment>
        if( uFlicker > 0.001 ){
          float t = uTime * 7.0 + uSeed;
          float f = nftNoise( vec2( t, uSeed ) ) * 0.5 + 0.5;
          float spike = step( 0.93, nftHash11( floor( t * 3.0 ) + uSeed ) );
          totalEmissiveRadiance *= mix( 1.0, mix( 0.55 + f * 0.45, 0.15, spike ), uFlicker );
        }
        `
      );
  };
  mat.customProgramCacheKey = () => 'nft_sign_v3';
  mat.userData.nft = uni;
  return mat;
}

// ============================================================================ FOLIAGE
/**
 * Cards-and-alpha foliage with wind. Two-sided, alpha-tested (cheap and shadow-correct),
 * with translucency faked by lifting the backside diffuse toward the leaf colour — without it,
 * a tree read from the shadow side is a black blob.
 */
export function makeFoliageMaterial(assets, opts = {}) {
  const {
    map = null,
    color = 0x6f8a3a,
    wind = 1.0,
    alphaTest = 0.42,
    translucency = 0.45,
    ...rest
  } = opts;

  const mat = new THREE.MeshStandardMaterial({
    map,
    color,
    roughness: 0.85,
    metalness: 0.0,
    side: THREE.DoubleSide,
    alphaTest,
    transparent: false,
    envMapIntensity: 0.9,
    ...rest,
  });
  mat.name = 'NFT_Foliage';

  const uni = {
    uTime: assets.time,
    uWind: { value: wind },
    uTranslucency: { value: translucency },
  };

  mat.onBeforeCompile = (shader) => {
    addUniforms(shader, uni);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;\n' + GLSL_NOISE)
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        {
          vec3 wp = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
          // Gusts travel across the world, so a whole treeline moves together rather than
          // every card wobbling on its own clock.
          float gust = nftFbm( wp.xz * 0.03 - vec2( uTime * 0.55, uTime * 0.21 ), 3 ) * 0.5 + 0.5;
          float sway = sin( uTime * 1.7 + wp.x * 0.6 + wp.z * 0.4 );
          float amp = uWind * ( 0.06 + gust * 0.22 ) * max( transformed.y, 0.0 );
          transformed.x += sway * amp;
          transformed.z += cos( uTime * 1.3 + wp.z * 0.5 ) * amp * 0.6;
        }
        `
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTranslucency;\n')
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        // Cheap wrap-around translucency: leaves are lit from behind too.
        reflectedLight.indirectDiffuse += diffuseColor.rgb * uTranslucency * 0.35;
        `
      );
  };
  mat.customProgramCacheKey = () => 'nft_foliage_v3';
  mat.userData.nft = uni;
  return mat;
}

// ============================================================================ CAR PAINT
/**
 * Metallic car paint: pigment base + aluminium flake + clearcoat, with the orange-peel
 * waviness a real spray booth leaves behind. The flake normal is deliberately sampled at a huge
 * repeat and low amplitude — flake should *sparkle* under a moving light, not look like sand.
 */
export function makeCarPaintMaterial(assets, opts = {}) {
  const {
    color = 0xb4142a,
    flake = 0xffd0a0,
    flakeAmount = 0.55,
    metalness = 0.85,
    roughness = 0.28,
    clearcoat = 1.0,
    clearcoatRoughness = 0.045,
    flakeRepeat = 90,
    ...rest
  } = opts;

  const flakeTex = assets.texture('carPaintFlake');
  const mat = new THREE.MeshPhysicalMaterial({
    color,
    metalness,
    roughness,
    clearcoat,
    clearcoatRoughness,
    clearcoatNormalMap: assets.texture('clearcoatPeel'),
    clearcoatNormalScale: new THREE.Vector2(0.35, 0.35),
    normalMap: flakeTex,
    normalScale: new THREE.Vector2(0.12, 0.12),
    envMapIntensity: 1.9,
    ...rest,
  });
  mat.name = 'NFT_CarPaint';

  const uni = {
    uTime: assets.time,
    uFlakeCol: { value: new THREE.Color(flake) },
    uFlakeAmt: { value: flakeAmount },
    uFlakeRepeat: { value: flakeRepeat },
    uFlakeTex: { value: flakeTex },
  };

  mat.onBeforeCompile = (shader) => {
    patchVertex(shader);
    addUniforms(shader, uni);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n' + VERT_PARS +
          '\nuniform vec3 uFlakeCol;\nuniform float uFlakeAmt;\nuniform float uFlakeRepeat;\nuniform sampler2D uFlakeTex;\nuniform float uTime;\n' + GLSL_NOISE
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        {
          // Flake facets that catch the view/light at a grazing angle.
          vec3 fn = texture2D( uFlakeTex, vNftUv * uFlakeRepeat ).xyz * 2.0 - 1.0;
          vec3 V = normalize( vViewPosition );
          float sparkle = pow( clamp( dot( normalize( fn ), normalize( V + vec3(0.0,0.0,1.0) ) ), 0.0, 1.0 ), 22.0 );
          // Fade the sparkle out with distance or it aliases into static.
          float k = uFlakeAmt * ( 1.0 - smoothstep( 6.0, 26.0, vNftDist ) );
          diffuseColor.rgb += uFlakeCol * sparkle * k * 0.9;
          roughnessFactor = clamp( roughnessFactor * ( 1.0 - sparkle * k * 0.5 ), 0.02, 1.0 );
        }
        `
      );
  };
  mat.customProgramCacheKey = () => 'nft_paint_v3';
  mat.userData.nft = uni;
  return mat;
}
