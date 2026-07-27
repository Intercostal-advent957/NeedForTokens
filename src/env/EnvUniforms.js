/**
 * SHARED ENVIRONMENT UNIFORMS — Need for Tokens / env lane
 *
 * Cross-lane binding surface. These are plain three.js uniform objects; import the module and
 * assign the SAME object into your shader so it stays live with zero per-frame plumbing:
 *
 *     import { ENV_UNIFORMS } from '../env/EnvUniforms.js';
 *     material.onBeforeCompile = (shader) => {
 *       shader.uniforms.uWetness = ENV_UNIFORMS.wetness;   // by reference — do not clone
 *       shader.uniforms.uRain    = ENV_UNIFORMS.rainIntensity;
 *     };
 *
 * EnvironmentSystem.setWeather() is the only writer. `assets.wetness` mirrors `wetness.value`
 * for lanes that prefer a plain number (CONTRACTS.md §6 lists `env.wetness` as the contract
 * value; this is the shader-side twin of it).
 */
export const ENV_UNIFORMS = {
  /** 0..1 — surface water. Darkens albedo, drops roughness, raises reflectivity. */
  wetness: { value: 0 },
  /** 0..1 — falling rain. Drives spray, drop density, and the sky's overcast blend. */
  rainIntensity: { value: 0 },
};
