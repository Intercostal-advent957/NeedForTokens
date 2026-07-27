/**
 * ATMOSPHERIC DEPTH — height fog + aerial perspective + sun inscatter.
 * Need for Tokens / env lane.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `THREE.FogExp2` gives one flat colour at one flat density. Real distance haze is:
 *   - exponentially denser near the ground (height fog),
 *   - tinted by the part of the *sky* you're looking through (aerial perspective),
 *   - much brighter when you look toward the sun (Mie forward inscatter).
 * Those three together are the single biggest "is this AAA?" lever in an outdoor renderer.
 *
 * HOW IT'S WIRED WITHOUT TOUCHING ANOTHER LANE'S FILES
 * ---------------------------------------------------
 * We replace the four stock `fog_*` ShaderChunks, so every material in the engine
 * (MeshStandardMaterial, MeshPhysicalMaterial, anything with `fog: true`) picks it up for
 * free — no `onBeforeCompile` bookkeeping and no per-material registry.
 *
 * The extra uniforms are appended to every `ShaderLib` entry that already has `fogColor`.
 * They are backed by **Float32Array**, and `UniformsUtils.cloneUniforms()` copies anything
 * that is not a Color/Vector/Matrix/Texture/Quaternion/Array **by reference** — so all
 * materials in the scene share one live buffer we can rewrite once per frame for free.
 * (`WebGLUniforms.setValueV3f/V4f` accept array-likes, so no wrapper types are needed.)
 *
 * SPACE: three includes `<fog_fragment>` *after* `<tonemapping_fragment>`/`<colorspace_fragment>`.
 * When PostFX renders into a HalfFloat target those two are compiled out, so fog runs in linear
 * HDR; when rendering straight to the canvas they are not. We detect it with `#ifdef TONE_MAPPING`
 * and encode the inscatter colour to match, so fog is correct on both paths.
 */
import * as THREE from 'three';

/** Shared, live uniform buffers. Written by EnvironmentSystem.update(), read by every shader. */
export const FOG_UNIFORMS = {
  // [ heightFalloff (1/m), heightRef (m), aerialStrength, sunInscatterStrength ]
  fogParamsA: { value: new Float32Array([0.020, 0.0, 1.0, 1.0]) },
  // [ cameraY, mieG, maxOpacity, aerialDesaturation ]
  fogParamsB: { value: new Float32Array([2.0, 0.76, 1.0, 0.0]) },
  fogHorizonCol: { value: new Float32Array([0.55, 0.62, 0.74]) }, // linear HDR sky @ horizon
  fogZenithCol: { value: new Float32Array([0.22, 0.34, 0.62]) }, // linear HDR sky @ zenith
  fogSunCol: { value: new Float32Array([1.0, 0.72, 0.42]) }, // linear HDR inscatter tint
  fogSunVec: { value: new Float32Array([0.0, 0.4, -0.9]) }, // world dir TOWARD the sun
};

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3  vFogWorld;
#endif`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	// World position without touching the "transformed" local — sprites/points never define it.
	// viewMatrix is rigid, so inverse(V) * p == transpose(R) * (p - t), and in GLSL
	// in GLSL, v * mat3(M) is exactly transpose(M) * v. Safe for instancing/batching/skinning.
	vFogWorld = ( mvPosition.xyz - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
#endif`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3  vFogWorld;
	uniform vec4 fogParamsA;
	uniform vec4 fogParamsB;
	uniform vec3 fogHorizonCol;
	uniform vec3 fogZenithCol;
	uniform vec3 fogSunCol;
	uniform vec3 fogSunVec;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
{
	float nftHF   = fogParamsA.x;   // height falloff, 1/m
	float nftHRef = fogParamsA.y;   // altitude where density == fogDensity
	float nftAP   = fogParamsA.z;   // aerial-perspective blend toward sky colour
	float nftSunS = fogParamsA.w;   // sun inscatter strength
	float nftCamY = fogParamsB.x;
	float nftG    = fogParamsB.y;
	// A ShaderMaterial from another lane won't carry these uniforms; GL reports them as 0.
	// Falling back to 1 / 0 degrades gracefully to stock FogExp2 instead of exploding.
	float nftMaxO = fogParamsB.z > 0.0 ? fogParamsB.z : 1.0;

	// ---- height-integrated optical depth -------------------------------------------------
	// Integrating exp(-k*y) along the eye ray has a closed form; guard the k->0 case.
	float dist = max( vFogDepth, 0.0 );
	float heightIntegral = 1.0;
	if ( nftHF > 1e-6 ) {
		float y0 = nftCamY - nftHRef;
		float y1 = vFogWorld.y - nftHRef;
		float dy = y1 - y0;
		if ( abs( dy ) < 0.05 ) {
			heightIntegral = exp( - nftHF * y0 );
		} else {
			heightIntegral = ( exp( - nftHF * y0 ) - exp( - nftHF * y1 ) ) / ( nftHF * dy );
		}
		heightIntegral = clamp( heightIntegral, 0.0, 6.0 );
	}

	#ifdef FOG_EXP2
		float nftTau = fogDensity * dist * heightIntegral;
		float fogFactor = 1.0 - exp( - nftTau * nftTau * 1.4 - nftTau * 0.55 );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, dist * heightIntegral );
	#endif
	fogFactor = clamp( fogFactor, 0.0, 1.0 ) * nftMaxO;

	if ( fogFactor > 0.0005 ) {
		// ---- aerial perspective: tint toward the sky you are looking THROUGH ----------------
		vec3 vdir = normalize( vFogWorld - vec3( 0.0, nftCamY, 0.0 ) + vec3( 0.0, 1e-4, 0.0 ) );
		float up = clamp( vdir.y * 0.5 + 0.32, 0.0, 1.0 );
		vec3 skyTint = mix( fogHorizonCol, fogZenithCol, up * up );
		vec3 nftFog = mix( fogColor, skyTint, clamp( nftAP, 0.0, 1.0 ) );

		// ---- Mie forward inscatter: haze lights up around the sun ---------------------------
		float cosT = dot( vdir, fogSunVec );
		float g2 = nftG * nftG;
		float phase = ( 1.0 - g2 ) / ( 4.0 * 3.14159265 * pow( 1.0 + g2 - 2.0 * nftG * cosT, 1.5 ) );
		nftFog += fogSunCol * phase * nftSunS * fogFactor;

		#if defined( TONE_MAPPING )
			// Straight-to-canvas path: gl_FragColor is already display-encoded, so match it.
			nftFog = toneMapping( nftFog );
			nftFog = linearToOutputTexel( vec4( nftFog, 1.0 ) ).rgb;
		#endif

		// ---- extinction: chroma dies faster than luminance -----------------------------------
		// Haze does two separable things and only one of them is a lerp toward the fog colour: it
		// ADDS inscattered sky light (below), and it scatters the surface's own reflected light
		// OUT of the eye ray. The second is wavelength-dependent and is what makes a distant
		// building read as distant even when the veil itself is faint. Without it you can push
		// density until the far skyline is milk and the mid-ground STILL reads at foreground
		// saturation — which is exactly the "distant geometry is the same hue and saturation as
		// the foreground" flatness this is here to fix. The strength is per-preset (fogParamsB.w):
		// warm and mild at golden hour, cold and heavy at night and in a storm.
		// NOTE: no backticks in this file. It is one big template literal.
		float nftDesat = clamp( fogParamsB.w * fogFactor, 0.0, 1.0 );
		float nftLum = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
		vec3 nftSurf = mix( gl_FragColor.rgb, vec3( nftLum ), nftDesat );

		gl_FragColor.rgb = mix( nftSurf, nftFog, fogFactor );
	}
}
#endif`;

let installed = false;

/**
 * Swaps the stock fog chunks for the atmospheric ones and injects the extra uniforms into
 * every built-in shader. Idempotent. Must run before the first frame is rendered — the
 * EnvironmentSystem constructor is early enough (programs are compiled lazily at first draw).
 */
export function installAtmosphericFog() {
  if (installed) return FOG_UNIFORMS;
  installed = true;

  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;

  // ShaderLib entries were built by merging UniformsLib at module-eval time, so extending
  // UniformsLib alone is not enough — patch the already-merged tables too.
  Object.assign(THREE.UniformsLib.fog, FOG_UNIFORMS);
  for (const key of Object.keys(THREE.ShaderLib)) {
    const lib = THREE.ShaderLib[key];
    if (lib?.uniforms?.fogColor) Object.assign(lib.uniforms, FOG_UNIFORMS);
  }
  return FOG_UNIFORMS;
}

/** Convenience writers so EnvironmentSystem stays readable. */
export function writeVec3(target, c, scale = 1) {
  target[0] = c.r * scale;
  target[1] = c.g * scale;
  target[2] = c.b * scale;
}
