/**
 * PHYSICAL SKY — Need for Tokens / env lane
 * =========================================
 * A hand-tuned single-scattering Rayleigh + Mie atmosphere (Preetham-family optical depth
 * approximation, Cornette–Shanks Mie phase) with a real sun disc (0.53° angular diameter,
 * limb darkening), plus a full night hemisphere: star field, Milky Way dust band, and a
 * phased moon with its own glow.
 *
 * Everything is driven by `uSunDir` / `uTurbidity` / `uMoonDir` — there is no lerp between
 * two hard-coded colours anywhere in here. Golden hour is orange because 550nm light has
 * been scattered out of a 12-airmass path, not because someone typed 0xffb46a.
 *
 * OUTPUT IS LINEAR HDR. After the (deliberately gentle) highlight knee below: zenith ~0.1..0.9,
 * horizon ~0.9..2.3, sun disc 70 (golden) .. 240 (noon) — the disc is never knee'd or clamped.
 * The dome mesh applies tonemapping+colorspace itself; the cube capture used for IBL does not
 * (uHdrOut = 1), so the PMREM gets true radiance.
 */
import * as THREE from 'three';

export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // pin to far plane
}`;

export const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform vec3  uSunDir;        // world-space direction TOWARD the sun
uniform vec3  uMoonDir;       // world-space direction TOWARD the moon
uniform float uTurbidity;     // 1 (arctic) .. 14 (storm haze)
uniform float uRayleigh;      // scattering scale, drops at night
uniform float uMieCoeff;      // aerosol density
uniform float uMieG;          // forward-scattering anisotropy 0.75..0.92
uniform float uSunIntensity;  // radiance multiplier of the solar disc + inscatter
uniform float uNight;         // 0 = day, 1 = full night (drives stars/moon/airglow)
uniform float uStars;         // star brightness (killed by overcast)
uniform float uCloud;         // 0..1 overcast blanket
uniform vec3  uCloudColor;
uniform vec3  uGroundColor;   // what the dome shows below the horizon
uniform float uTime;
uniform float uHdrOut;        // global radiance gain (1.0 normally; the IBL capture can boost)

const float PI = 3.141592653589793;

// ---------------------------------------------------------------- atmosphere constants
// ZENITH optical depths, not raw cross-sections — tau_R(lambda) = 0.0088 * lambda^-4.15
// evaluated at 680 / 550 / 440 nm. These are the real numbers; they are why the sun goes
// orange at 3 airmasses and blood red at 12, with no colour ramp anywhere.
const vec3 TAU_R = vec3(0.0440, 0.1050, 0.2660);
// Mie is near-grey and scales with aerosol load (turbidity).
const vec3 TAU_M_BASE = vec3(0.0090, 0.0086, 0.0082);
const float SKY_GAIN = 13.0;
// HIGHLIGHT BUDGET — recalibrated against the rebuilt bloom (src/render/BloomPass.js).
//
// The old chain was UnrealBloom thresholding at a tone-mapped-looking level: it caught the
// entire sky, smeared it with a wide Gaussian and tinted each mip, so the only way to get a
// clean frame was to crush the whole atmosphere to an asymptote of 0.85. That cost the sky its
// entire top octave and left golden hour looking like a flat gradient.
//
// The current bloom is an energy-conserving COD-style chain: soft-knee threshold in LINEAR HDR
// (threshold 1.35, knee 0.5 -> starts at 0.85, full above 1.85) with a Karis average on the
// first downsample, so no single blazing texel can own a mip. Measured budget from that lane:
// the sky may run to ~0.85 with zero bloom contribution and ~2.0 with a gentle one, and the
// solar disc is to be left unclamped.
//
// So the knee now starts ABOVE where the old asymptote sat and rolls very gently:
//   raw 1.0 -> 0.95   raw 1.6 -> 1.28   raw 2.5 -> 1.55   raw 6 -> 1.94   asymptote 2.31
// Everything below 0.70 — the whole zenith, the entire night sky — passes through untouched,
// so this recovers the top of the range without lifting the floor. The knee is still applied to
// the BROAD atmosphere only; the solar/lunar discs are composited after it at true radiance.
const float SKY_KNEE = 0.70;
const float SKY_ROLL = 0.62; // asymptote = KNEE + 1/ROLL = 2.31
vec3 skyKnee(vec3 c) {
  vec3 e = max(c - SKY_KNEE, vec3(0.0));
  return min(c, vec3(SKY_KNEE)) + e / (1.0 + e * SKY_ROLL);
}

// Preetham/Hosek style analytic airmass: robust below the horizon, no infinities.
float airMass(float cosZenith) {
  float c = max(cosZenith, -0.12);
  return 1.0 / (c + 0.15 * pow(max(93.885 - degrees(acos(clamp(c, -1.0, 1.0))), 0.0), -1.253));
}

// ---------------------------------------------------------------- hashes / noise
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0,0,0)), n100 = hash13(i + vec3(1,0,0));
  float n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1));
  float n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm(vec3 p) {
  // 3 octaves. The sky dome covers the whole screen; every extra octave here is 8 more
  // hash13() calls on 2M fragments.
  float s = 0.5 * vnoise(p);
  s += 0.25 * vnoise(p * 2.03);
  s += 0.125 * vnoise(p * 4.11);
  return s * 1.143;
}

// ---------------------------------------------------------------- star field
// Cellular point sampling: one candidate star per cell, jittered inside it, with a random
// magnitude. Only the OWN cell is tested — a 3x3x3 neighbourhood is 27x the cost for a
// difference nobody can see, because stars are far smaller than a cell. Two frequency bands
// give the magnitude distribution: dense faint field + sparse bright named stars.
float starLayer(vec3 dir, float density, float sizePow, float cut) {
  vec3 cell = floor(dir * density);
  vec3 r = hash33(cell);
  if (r.z < cut) return 0.0;
  vec3 sp = (cell + 0.15 + r * 0.7) / density;
  float d = length(normalize(sp) - dir);
  float mag = pow((r.z - cut) / max(1.0 - cut, 1e-3), 2.0);
  float tw = 0.72 + 0.28 * sin(uTime * (1.2 + r.x * 3.4) + r.y * 31.4);
  return mag * tw * exp(-d * d * sizePow);
}

vec3 nightSky(vec3 dir) {
  // --- Milky Way: a dusty band around a tilted galactic plane -------------------------
  vec3 galN = normalize(vec3(0.42, 0.63, -0.65));
  float band = 1.0 - abs(dot(dir, galN));
  float mw = smoothstep(0.72, 1.0, band);
  float dust = 0.0, dust2 = 0.0;
  float mwMask = 0.0;
  vec3 mwCol = vec3(0.0);
  if (mw > 0.002) {                       // ~15% of the dome; the rest skips 2 fbm chains
    dust = fbm(dir * 7.5 + 11.0);
    dust2 = fbm(dir * 19.0 - 4.0);
    mwMask = mw * mw * (0.35 + 0.85 * dust) * (0.45 + 0.75 * dust2);
    mwMask *= 0.35 + 0.9 * smoothstep(0.30, 0.70, dust2); // dark nebula lanes
    mwCol = mix(vec3(0.30, 0.36, 0.62), vec3(0.72, 0.66, 0.56), dust) * mwMask * 0.040;
  }

  // --- stars --------------------------------------------------------------------------
  // Sizes are in the sub-pixel range on purpose: a star that is 3px wide before the composer's
  // bloom gets there is a snowflake once the bloom has finished with it.
  float s1 = starLayer(dir, 260.0, 2.6e6, 0.972);   // dense faint field
  float s2 = starLayer(dir, 64.0,  1.7e5, 0.944);   // the bright named ones
  float galBoost = 1.0 + 2.6 * smoothstep(0.55, 1.0, band);
  vec3 warm = vec3(1.0, 0.82, 0.66), cold = vec3(0.74, 0.84, 1.0);
  vec3 stars = mix(cold, warm, hash13(floor(dir * 64.0))) * (s2 * 0.62)
             + mix(cold, vec3(1.0), 0.5) * s1 * 0.24 * galBoost;

  // --- airglow: the sky is never truly black, but it IS ~1/300 of a sunlit surface -----
  float h = max(dir.y, 0.0);
  vec3 glow = mix(vec3(0.0032, 0.0050, 0.0112), vec3(0.0009, 0.0016, 0.0044), smoothstep(0.0, 0.55, h));

  return glow + mwCol + stars * uStars;
}

vec3 moon(vec3 dir, out float moonMask) {
  float d = length(dir - uMoonDir);
  // Moon subtends ~0.52°, i.e. 0.0091 rad diameter.
  float r = 0.0091;
  moonMask = 0.0;
  // Halo is wide, the lit surface is not: only ~0.001% of the dome pays for the fbm craters.
  float halo = exp(-d * 42.0) * 0.30 + exp(-d * 7.0) * 0.045;
  if (d > r * 1.2) return vec3(0.62, 0.70, 0.95) * halo;
  float disc = 1.0 - smoothstep(r * 0.92, r * 1.06, d);
  moonMask = disc;
  // Surface: maria + craters from fbm in a tangent frame.
  vec3 t = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
  vec3 b = cross(uMoonDir, t);
  vec2 uv = vec2(dot(dir - uMoonDir, t), dot(dir - uMoonDir, b)) / r;
  float rad = min(length(uv), 1.0);
  vec3 nrm = normalize(vec3(uv, sqrt(max(1.0 - rad * rad, 0.0))));
  float maria = smoothstep(0.42, 0.62, fbm(nrm * 2.1 + 3.0));
  float craters = fbm(nrm * 9.0) * 0.35 + fbm(nrm * 26.0) * 0.18;
  vec3 surf = mix(vec3(0.86, 0.85, 0.80), vec3(0.42, 0.44, 0.50), maria) * (0.78 + craters);
  // Phase: light comes from the sun, so terminator = dot(surface normal, sun).
  vec3 sunLocal = normalize(vec3(dot(uSunDir, t), dot(uSunDir, b), dot(uSunDir, uMoonDir)));
  float phase = smoothstep(-0.09, 0.16, dot(nrm, sunLocal));
  float limb = 0.55 + 0.45 * pow(max(1.0 - rad * rad, 0.0), 0.28);
  vec3 lit = surf * limb * (phase + 0.035);
  // The lunar disc is an emitter too (composited past the knee), but it is ~1e-5 of the sun and
  // the night sky around it sits at 1e-3, so it only needs to clear the bloom's soft start.
  return lit * disc * 24.0 + vec3(0.62, 0.70, 0.95) * halo;
}

// ---------------------------------------------------------------- main
void main() {
  vec3 dir = normalize(vDir);
  vec3 sun = normalize(uSunDir);
  float cosTheta = dot(dir, sun);

  // Fake a soft "virtual horizon" so we never sample airmass straight down.
  float upness = dir.y;
  vec3 sdir = vec3(dir.x, max(upness, -0.06), dir.z);
  sdir = normalize(sdir);

  // ---- optical depth ------------------------------------------------------------------
  float T = uTurbidity;
  vec3 betaR = TAU_R * uRayleigh;
  vec3 betaM = TAU_M_BASE * uMieCoeff * (1.0 + 2.05 * max(T - 1.0, 0.0));

  float viewAM = airMass(sdir.y);
  float sunAM  = airMass(max(sun.y, -0.06));

  vec3 tauView = (betaR + betaM) * viewAM;
  vec3 tauSun  = (betaR + betaM) * sunAM;
  vec3 sunTransmit = exp(-tauSun);
  vec3 viewTransmit = exp(-tauView);

  // ---- phase functions ----------------------------------------------------------------
  float phaseR = (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
  float g = uMieG;
  float g2 = g * g;
  // Cornette–Shanks
  float phaseM = (3.0 / (8.0 * PI)) * ((1.0 - g2) * (1.0 + cosTheta * cosTheta)) /
                 ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));

  // Single-scatter inscatter, energy-conserving-ish: (1 - exp(-tau)) * beta*phase/beta_total
  vec3 betaTot = betaR + betaM;
  vec3 scatter = (betaR * phaseR + betaM * phaseM) / max(betaTot, vec3(1e-6));
  vec3 inscatter = scatter * (vec3(1.0) - viewTransmit) * sunTransmit;

  // Multiple scattering. Single scattering alone gives a sky that is far too dark and far
  // too saturated; the higher-order bounces are what make a real sky pale near the horizon.
  vec3 multi = (vec3(1.0) - viewTransmit) * sunTransmit *
               (0.050 + 0.105 * smoothstep(-0.05, 0.4, sun.y)) *
               mix(vec3(1.0), normalize(betaR + 1e-6) * 1.75, 0.80);

  float sunUp = smoothstep(-0.18, 0.05, sun.y);
  vec3 sky = (inscatter + multi) * uSunIntensity * SKY_GAIN * sunUp;

  // Horizon haze thickening — aerosols pool low, and it's what sells depth. Capped, because
  // at turbidity 12 an uncapped term draws a blown white band right across the frame.
  float hz = pow(1.0 - clamp(sdir.y, 0.0, 1.0), 4.0);
  sky += sunTransmit * uSunIntensity * sunUp * hz * (0.09 + 0.040 * min(T, 8.0)) *
         (1.0 - uCloud * 0.80) * vec3(1.0, 0.90, 0.78);

  // ---- solar disc ----------------------------------------------------------------------
  // 0.53° diameter => 0.00465 rad radius. Chord length is a stable stand-in for the angle.
  float ang = length(dir - sun);
  float rSun = 0.00465;
  float discEdge = 1.0 - smoothstep(rSun * 0.985, rSun * 1.035, ang);
  // Limb darkening (Eddington, u=0.6): I(mu)/I(0) = 1 - u + u*mu
  float rn = clamp(ang / rSun, 0.0, 1.0);
  float mu = sqrt(max(1.0 - rn * rn, 0.0));
  float limbD = (1.0 - 0.62 + 0.62 * mu);
  // TRUE RADIANCE. The disc is the one thing in the frame that is allowed to be genuinely hot:
  // ~70 linear through 4 airmasses of golden-hour haze, ~230 at noon. It is never knee'd and
  // never clamped. The bloom's Karis average is what turns that into a tight aureole instead of
  // one texel owning a whole mip, which is exactly the blob this used to produce.
  vec3 discCol = sunTransmit * uSunIntensity * 265.0 * limbD * discEdge * sunUp;
  // Mie forward-scattering aureole. Split by angular extent, because the two halves are
  // different phenomena and want different treatment:
  //  - the WIDE skirt (5-40 degrees) is ordinary inscatter. It belongs to the atmosphere, so it
  //    joins the broad sky and goes through the knee with everything else. Leaving it hot and
  //    post-knee is what smeared a soft-box across a third of the frame.
  //    (No backticks anywhere in this comment - it lives inside a JS template literal.)
  //  - the TIGHT core (under ~2 degrees) is the glare right off the limb. That stays an emitter.
  float aurWide = exp(-ang * 5.2) * 0.115 + exp(-ang * 1.5) * 0.042;
  sky += sunTransmit * uSunIntensity * aurWide * (1.5 + 0.22 * T) * sunUp;
  float aurTight = exp(-ang * 30.0);
  discCol += sunTransmit * uSunIntensity * aurTight * (2.4 + 0.42 * T) * sunUp;

  // ---- night ---------------------------------------------------------------------------
  vec3 emitters = discCol;   // things that are allowed to stay HDR-hot
  if (uNight > 0.001) {
    float mm;
    vec3 moonCol = moon(dir, mm);
    float horizonFade = mix(0.25, 1.0, smoothstep(-0.02, 0.24, dir.y));
    emitters += moonCol * mm * uNight * horizonFade;      // lunar disc stays hot
    vec3 nightCol = nightSky(dir) + moonCol * (1.0 - mm); // halo goes through the knee
    // Stars fade out into the horizon murk.
    nightCol *= horizonFade;
    // Light pollution: a city throws a sodium-orange dome up off the horizon. Without this a
    // night sky reads as "renderer with the lights off" instead of "night in a city".
    float lp = pow(1.0 - clamp(dir.y, 0.0, 1.0), 4.5);
    nightCol += mix(vec3(0.0042, 0.0062, 0.0125), vec3(0.0245, 0.0135, 0.0060), 0.66) * lp * 1.6;
    sky = mix(sky, sky * 0.10 + nightCol, uNight);
  }

  // ---- overcast blanket ------------------------------------------------------------------
  if (uCloud > 0.001) {
    float cf = fbm(dir * vec3(2.4, 6.0, 2.4) + vec3(uTime * 0.006, 0.0, uTime * 0.004));
    float cf2 = fbm(dir * vec3(9.0, 20.0, 9.0) - vec3(uTime * 0.011, 0.0, 0.0));
    float lum = 0.55 + 0.55 * cf + 0.22 * cf2;
    // Brighter directly opposite/around the sun so the cloud deck still has a hot spot.
    lum *= 1.0 + 0.85 * pow(max(cosTheta, 0.0), 6.0);
    vec3 deck = uCloudColor * lum;
    deck = mix(deck * 0.62, deck, smoothstep(-0.05, 0.4, dir.y));
    // A cloud deck is lit BY the sun. At night it is only lit from below, by the city — which
    // is why an overcast night sky is a dull orange-brown and not a bright grey lid.
    deck *= mix(0.022, 1.0, sunUp);
    deck += vec3(0.026, 0.015, 0.007) * uNight * (0.35 + 0.65 * hz) * uCloud;
    float cover = uCloud * smoothstep(-0.03, 0.16, dir.y);
    sky = mix(sky, deck, cover);
    // The horizon under a deck goes flat and pale.
    sky = mix(sky, deck * 0.72, uCloud * hz * 0.55);
  }

  // ---- below the horizon: the dome must not show a hole ---------------------------------
  float below = smoothstep(0.0, -0.055, upness);
  vec3 groundLit = uGroundColor * (0.35 + 0.65 * max(sun.y, 0.0)) * uSunIntensity;
  groundLit = mix(groundLit, uGroundColor * 0.06, uNight);
  // Blend toward the horizon colour so there is no hard seam.
  sky = mix(sky, mix(sky, groundLit, 0.86), below);

  // ACES is a strong desaturator in the upper mids — a physically correct sky comes out of it
  // noticeably greyer than the eye expects. Pre-compensating here is standard practice and is
  // the difference between "blue gradient" and "sky".
  sky = max(sky, vec3(0.0));
  float lumS = dot(sky, vec3(0.2126, 0.7152, 0.0722));
  sky = max(mix(vec3(lumS), sky, 1.28), vec3(0.0));

  sky = (skyKnee(sky) + emitters * (1.0 - below)) * uHdrOut;

  gl_FragColor = vec4(sky, 1.0);
  // NOTE: three r171 compiles tone mapping OUT when rendering into a render target
  // (WebGLPrograms: currentRenderTarget === null). So the same material yields raw linear
  // HDR for the IBL cube capture and tonemapped sRGB when drawn straight to the canvas.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Dither — an 80%-of-screen sky gradient banding in 8 bits is an instant amateur tell.
  vec2 fc = gl_FragCoord.xy;
  float dth = fract(sin(dot(fc, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor.rgb += (dth - 0.5) / 255.0;
}`;

export function makeSkyMaterial() {
  return new THREE.ShaderMaterial({
    name: 'NFT_PhysicalSky',
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: true,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 0.3, -1).normalize() },
      uMoonDir: { value: new THREE.Vector3(0, 0.4, 1).normalize() },
      uTurbidity: { value: 3.2 },
      uRayleigh: { value: 1.0 },
      uMieCoeff: { value: 1.0 },
      uMieG: { value: 0.80 },
      uSunIntensity: { value: 1.0 },
      uNight: { value: 0.0 },
      uStars: { value: 1.0 },
      uCloud: { value: 0.0 },
      uCloudColor: { value: new THREE.Color(0.55, 0.58, 0.63) },
      uGroundColor: { value: new THREE.Color(0.09, 0.095, 0.085) },
      uTime: { value: 0 },
      uHdrOut: { value: 1 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
  });
}
