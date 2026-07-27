/**
 * TIME-OF-DAY PRESETS + SOLAR MODEL — Need for Tokens / env lane
 *
 * Each preset is an art direction, not a colour swap: hour on the real solar arc, aerosol
 * load, a fog profile with its own height falloff, an exposure that matches how a camera
 * would actually be stopped for that light, and an ambient balance.
 *
 * Sun and moon colours are NOT stored here — they fall out of the atmospheric transmittance
 * at that sun elevation (see `transmittance()`), which is why dusk is red and noon is not.
 */
import * as THREE from 'three';

const D2R = Math.PI / 180;

export const PRESETS = {
  /** Hard, high, neutral. Short shadows, deep blue zenith, minimal haze. Unflattering on purpose. */
  noon: {
    hour: 12.55,
    turbidity: 2.6,
    exposure: 0.92,
    sunI: 4.6,
    // fog
    fogDensity: 0.00135,
    fogHeightFalloff: 0.010,
    fogHeightRef: 0.0,
    aerial: 0.92,
    aerialDesat: 0.45,
    sunInscatter: 0.10,
    mieG: 0.62,
    // ambient
    hemiSky: 0x9ec6ff,
    hemiGround: 0x6b6355,
    hemiI: 0.85,
    envIntensity: 2.1,
    cloud: 0.0,
    stars: 0.0,
  },

  /** THE money shot. Sun ~13° up: long warm shadows, strong rim light, hazy depth. */
  goldenHour: {
    hour: 17.85,
    turbidity: 4.3,
    exposure: 1.16,
    sunI: 5.0,
    fogDensity: 0.0024,
    fogHeightFalloff: 0.020,
    fogHeightRef: 0.0,
    aerial: 1.0,
    aerialDesat: 0.55,
    sunInscatter: 1.35,
    mieG: 0.80,
    hemiSky: 0x86a9e0,
    hemiGround: 0x6a4b30,
    hemiI: 0.72,
    envIntensity: 2.35,
    cloud: 0.0,
    stars: 0.0,
  },

  /** Sun just under the horizon. Sky does all the lighting; deep magenta-to-cobalt gradient. */
  dusk: {
    hour: 19.25,
    turbidity: 4.0,
    exposure: 1.75,
    sunI: 2.3,
    fogDensity: 0.0026,
    fogHeightFalloff: 0.026,
    fogHeightRef: 0.0,
    aerial: 1.0,
    aerialDesat: 0.62,
    sunInscatter: 1.05,
    mieG: 0.78,
    hemiSky: 0x4b6bb0,
    hemiGround: 0x2e2434,
    hemiI: 0.95,
    envIntensity: 3.1,
    cloud: 0.0,
    stars: 0.35,
  },

  /**
   * Deep blue ambient, moonlight as the only natural key, high exposure so the artificial
   * sources (headlights, street lights, neon) blow out into real pools of light.
   */
  night: {
    hour: 23.1,
    turbidity: 2.1,
    exposure: 2.70,
    sunI: 0.0,
    moonI: 0.60,
    fogDensity: 0.0026,
    fogHeightFalloff: 0.030,
    fogHeightRef: 0.0,
    aerial: 0.85,
    aerialDesat: 0.7,
    sunInscatter: 0.35,
    mieG: 0.70,
    hemiSky: 0x2b4a86,
    hemiGround: 0x0d1020,
    hemiI: 0.42,
    envIntensity: 3.4,
    cloud: 0.0,
    stars: 1.0,
  },

  /** Flat, shadowless, cool. The sun is a soft area source behind a full deck. */
  overcast: {
    hour: 13.2,
    turbidity: 8.5,
    exposure: 1.10,
    sunI: 1.15,
    fogDensity: 0.0038,
    fogHeightFalloff: 0.014,
    fogHeightRef: 0.0,
    aerial: 1.0,
    aerialDesat: 0.66,
    sunInscatter: 0.25,
    mieG: 0.55,
    hemiSky: 0xb8c4d2,
    hemiGround: 0x585c60,
    hemiI: 1.75,
    envIntensity: 2.0,
    cloud: 0.88,
    cloudColor: 0x8e99a6,
    stars: 0.0,
    desaturate: 0.18,
  },

  /** Low, bruised, dense. Almost no sun, heavy haze, cold desaturated grade. */
  stormy: {
    hour: 16.3,
    turbidity: 12.0,
    exposure: 1.34,
    sunI: 0.55,
    fogDensity: 0.006,
    fogHeightFalloff: 0.018,
    fogHeightRef: 0.0,
    aerial: 1.0,
    aerialDesat: 0.78,
    sunInscatter: 0.30,
    mieG: 0.52,
    hemiSky: 0x6a7686,
    hemiGround: 0x2b2f36,
    hemiI: 1.55,
    envIntensity: 1.95,
    cloud: 1.0,
    cloudColor: 0x515a66,
    stars: 0.0,
    desaturate: 0.3,
  },
};

// ---------------------------------------------------------------------------- solar model
const LAT = 34.05 * D2R; // Los Angeles-ish, for a proper NFS sun arc
const DECL = 13.0 * D2R; // late spring declination — long golden hour, sun sets NW
const SOLAR_NOON = 12.15;

/**
 * Real solar position for an hour of the day.
 * @returns {{ altitude:number, azimuth:number, toSun:THREE.Vector3 }} radians / unit vector
 *          pointing FROM the scene TOWARD the sun. World convention: -Z is north, +X is east.
 */
export function solarPosition(hour, out = new THREE.Vector3(), declination = DECL) {
  const H = (hour - SOLAR_NOON) * 15 * D2R;
  const sinAlt = Math.sin(LAT) * Math.sin(declination) + Math.cos(LAT) * Math.cos(declination) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAlt = Math.max(Math.cos(alt), 1e-4);
  const sinA = (-Math.cos(declination) * Math.sin(H)) / cosAlt;
  const cosA = (Math.sin(declination) - Math.sin(LAT) * sinAlt) / (cosAlt * Math.cos(LAT));
  const az = Math.atan2(sinA, cosA); // from north, +east
  out.set(Math.sin(az) * cosAlt, Math.sin(alt), -Math.cos(az) * cosAlt).normalize();
  return { altitude: alt, azimuth: az, toSun: out };
}

/** Moon: same maths, half a day out of phase and on a different declination. */
export function lunarPosition(hour, out = new THREE.Vector3()) {
  return solarPosition((hour + 12.8) % 24, out, 19.0 * D2R);
}

// ---------------------------------------------------------------------- atmospheric colour
const TAU_R = [0.044, 0.105, 0.266];
const TAU_M = [0.009, 0.0086, 0.0082];

/** Preetham-family airmass — matches the GLSL in SkyShader.js exactly. */
export function airMass(cosZenith) {
  const c = Math.max(cosZenith, -0.12);
  const deg = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  return 1 / (c + 0.15 * Math.pow(Math.max(93.885 - deg, 0), -1.253));
}

/**
 * Direct-beam transmittance through the atmosphere for a sun at `sinAltitude`.
 * This is what turns the key light orange at golden hour and blood red at dusk — the
 * DirectionalLight colour is never authored, it is always this.
 */
export function transmittance(sinAltitude, turbidity, out = new THREE.Color()) {
  const am = airMass(Math.max(sinAltitude, -0.06));
  const mie = 1 + 2.05 * Math.max(turbidity - 1, 0);
  out.setRGB(
    Math.exp(-(TAU_R[0] + TAU_M[0] * mie) * am),
    Math.exp(-(TAU_R[1] + TAU_M[1] * mie) * am),
    Math.exp(-(TAU_R[2] + TAU_M[2] * mie) * am),
    THREE.LinearSRGBColorSpace
  );
  return out;
}
