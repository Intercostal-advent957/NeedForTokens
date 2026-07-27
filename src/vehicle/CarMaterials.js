import * as THREE from 'three';

/**
 * Car materials. The headline act is `makePaint()` — a multi-layer automotive finish:
 *
 *   1. metallic BASE COAT       (MeshPhysicalMaterial metalness/roughness)
 *   2. METAL FLAKE              (per-cell random normal perturbation in object space, so the
 *                                sparkle is view-dependent and sticks to the panel — plus an
 *                                explicit specular glint term for the sub-pixel twinkle)
 *   3. CLEAR COAT               (three's clearcoat layer, own fresnel + roughness)
 *   4. optional IRIDESCENCE     (pearl/candy finishes)
 *
 * Damage rides on the same shader: seven dent centres displace geometry in the vertex stage and
 * dull / scratch the finish in the fragment stage, so `setDamage()` costs a uniform write.
 *
 * Owned by the car-art lane. Textures are *consumed* from ProceduralAssets, never generated here
 * (CONTRACTS.md §5).
 */

const FLAKE_PARS = /* glsl */ `
  uniform float uFlakeCellPx;
  uniform float uFlakeStrength;
  uniform float uFlakeSparkle;
  uniform vec3  uFlakeColor;
  uniform float uDirt;
  uniform float uWear;
  uniform float uPeel;
  uniform float uPeelPx;
  uniform float uCavity;
  uniform float uEdgeWear;
  varying vec3 vObjPos;
  varying vec3 vObjNrm;
  varying float vDentAmt;
  float vFlakeFade;
  vec3  nftFlakeN;
  float nftFlakeId;
  vec3  nftPeel;      // clearcoat waviness, computed once in the normal stage
  float nftCurv;      // signed curvature, 1/metres: + convex, - concave

  vec3 nftHash33(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
  }
  float nftHash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  // One octave of peel: three decorrelated sine sheets at cyc cycles per metre. The axis
  // couplings are deliberately irrational and asymmetric so the field never lines up into a
  // stripe or a chevron the way a single low-frequency sin(z)+sin(y) pair does.
  vec3 nftPeelOctave(vec3 p, float cyc) {
    vec3 q = p * (cyc * 6.2831853);
    return vec3(
      sin(q.z * 1.00 + q.y * 0.61 + 1.7) * 0.62 + sin(q.x * 0.43 - q.z * 0.77) * 0.38,
      sin(q.x * 1.00 + q.z * 0.53 + 4.1) * 0.62 + sin(q.y * 0.47 - q.x * 0.71) * 0.38,
      sin(q.y * 1.00 + q.x * 0.67 + 2.3) * 0.62 + sin(q.z * 0.41 - q.y * 0.83) * 0.38
    );
  }

  /**
   * Signed mean curvature of the shaded surface, in 1/metres, from screen-space derivatives:
   * for a sphere of radius R, dN = dP / R, so dot(dN,dP)/|dP|^2 == 1/R. Convex is positive,
   * concave negative, and a flat panel is zero at any distance — which is what makes it usable
   * as a cavity/edge-wear term without a baked map.
   */
  float nftCurvature(vec3 P, vec3 N) {
    vec3 dpx = dFdx(P), dpy = dFdy(P);
    vec3 dnx = dFdx(N), dny = dFdy(N);
    float d = dot(dpx, dpx) + dot(dpy, dpy);
    if (d < 1e-12) return 0.0;
    return (dot(dnx, dpx) + dot(dny, dpy)) / d;
  }
`;

// Perturb the shading normal with flake microfacets. Because the envMap is sampled with this
// normal, the flakes physically scatter the reflection — that IS the sparkle.
const FLAKE_NORMAL = /* glsl */ `
  {
    // ------------------------------------------------------------------ flake LOD
    // A fixed object-space cell size cannot work. Too coarse and the flake resolves as discrete
    // coloured dots several pixels across (glitter, not metallic paint); too fine and it is
    // sub-pixel noise that can only alias, so it has to be faded out and the paint goes flat.
    // Both failures shipped.
    //
    // Instead the cell size is chosen per pixel so that ONE CELL IS ALWAYS ~uFlakeCellPx PIXELS
    // ACROSS, whatever the distance. The scale is quantised to powers of two and cross-faded
    // between neighbouring octaves, exactly like a mip chain, so the pattern stays locked to the
    // panel (no swimming when the camera moves) while its on-screen density stays constant.
    vec3 dpos = fwidth(vObjPos);
    float px = max(max(dpos.x, max(dpos.y, dpos.z)), 1e-6);   // object-space size of one pixel
    float want = log2(1.0 / (px * uFlakeCellPx));             // desired log2(cells per metre)
    float lo = clamp(floor(want), 6.0, 12.0);                 // 1.6 cm .. 0.24 mm cells
    float blend = clamp(want - lo, 0.0, 1.0);
    float s0 = exp2(lo);
    // When the clamp bites (very distant car) a cell drops below a pixel and can only alias, so
    // dissolve the layer back to the smooth basecoat.
    float fade = smoothstep(0.35, 0.95, 1.0 / (px * s0));

    vec3 c0 = floor(vObjPos * s0);
    vec3 c1 = floor(vObjPos * s0 * 2.0);
    vec3 a0 = nftHash33(c0) * step(0.55, nftHash13(c0 + 7.3));
    vec3 a1 = nftHash33(c1 + 3.1) * step(0.55, nftHash13(c1 + 11.7));
    nftFlakeN = mix(a0, a1, blend);
    nftFlakeId = mix(nftHash13(c0 + 2.7), nftHash13(c1 + 5.3), blend);

    // ------------------------------------------------------------------ orange peel
    // Orange peel is the residual waviness a sprayed lacquer keeps as it flows out. It is a
    // SURFACE MICRO-texture: you read it as a slight softening and sparkle of the reflection,
    // never as a shape. The previous frequency (vObjPos * 7.3) had a ~0.5 m wavelength, so on a
    // 4.6 m car it stamped three sine bands across the rear deck that read as a chevron decal.
    //
    // Wavelength is picked per pixel, exactly like the flake above: one period is held at about
    // uPeelPx pixels, quantised to powers of two so the field stays welded to the panel, and
    // cross-faded between octaves. The octave clamp bounds it to 3.9 mm .. 3.1 cm — one to two
    // orders of magnitude finer than before, and short enough that no macro shape can emerge
    // from it at any distance. Below the sampling limit it dissolves rather than aliasing.
    float wantP = log2(1.0 / (px * uPeelPx));
    float loP = clamp(floor(wantP), 5.0, 8.0);           // 2^5..2^8 cycles/m
    float blP = clamp(wantP - loP, 0.0, 1.0);
    float cyc0 = exp2(loP);
    float peelFade = smoothstep(0.30, 0.9, 1.0 / (px * cyc0 * 3.0));
    nftPeel = mix(nftPeelOctave(vObjPos, cyc0), nftPeelOctave(vObjPos, cyc0 * 2.0), blP) * peelFade;

    // Amplitude is deliberately tiny: peel only ever perturbs the reflection. The basecoat gets
    // a third of what the lacquer gets, because most of the waviness lives in the clear.
    vec3 flakeN = normalize(normal + nftFlakeN * uFlakeStrength * fade + nftPeel * uPeel * 0.34);
    normal = normalize(mix(normal, flakeN, 1.0 - vDentAmt * 0.35));
    vFlakeFade = fade;
  }
`;

// The clearcoat gets the orange peel but never the flake — flake sits UNDER the lacquer.
const CLEARCOAT_PEEL = /* glsl */ `
  {
    // nftPeel was solved in the flake block above (normal_fragment_maps runs first), already
    // LOD-faded, so the lacquer costs no extra trigonometry.
    clearcoatNormal = normalize(clearcoatNormal + nftPeel * uPeel);
  }
`;

const FLAKE_SPARKLE = /* glsl */ `
  {
    vec3 V = normalize(vViewPosition);
    // Only a few per cent of flakes are ever oriented to catch the eye, and a flake buried in a
    // shadowed panel catches nothing at all — gating on the radiance already leaving the pixel
    // is what stops the unlit rear panel looking like it was rolled in orange glitter.
    float align = max(dot(normalize(normal + nftFlakeN * 0.55), V), 0.0);
    float glint = pow(align, 96.0) * smoothstep(0.90, 0.985, nftFlakeId);
    float lit = smoothstep(0.02, 0.30, dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722)));
    gl_FragColor.rgb +=
      uFlakeColor * glint * uFlakeSparkle * vFlakeFade * lit * (1.0 - vDentAmt * 0.8);
    // grime settles in the shut lines and low panels
    gl_FragColor.rgb *= 1.0 - uDirt * 0.22 * (1.0 - smoothstep(0.0, 0.55, vObjPos.y));
  }
`;

const DENT_PARS_VERT = /* glsl */ `
  uniform vec4 uDent[7];
  varying vec3 vObjPos;
  varying vec3 vObjNrm;
  varying float vDentAmt;
`;

const DENT_VERT = /* glsl */ `
  vDentAmt = 0.0;
  for (int i = 0; i < 7; i++) {
    float amt = uDent[i].w;
    if (amt <= 0.001) continue;
    vec3 d = transformed - uDent[i].xyz;
    float dist = length(d);
    float fall = 1.0 - smoothstep(0.05, 1.05, dist);
    fall *= fall;
    float dent = fall * amt;
    transformed -= normalize(d + vec3(1e-4)) * dent * 0.19;
    // crumple ripples so it reads as folded metal, not a soft blob
    float rip = sin(transformed.x * 21.0) * sin(transformed.z * 17.0) * sin(transformed.y * 13.0);
    transformed += objectNormal * rip * dent * 0.032;
    vDentAmt = max(vDentAmt, dent);
  }
  vObjPos = transformed;
  vObjNrm = objectNormal;
`;

const DENT_FRAG = /* glsl */ `
  {
    // ---------------------------------------------------------- curvature shading
    // A shell with one albedo over every panel is the flattest a car can look: real bodywork is
    // darker where the surface turns in on itself (the roll into a shut line, the corner of a
    // haunch, the tuck under a sill) and lighter along the crease that a polishing mop and a
    // decade of door handles have thinned. Both fall straight out of the signed curvature, so
    // this costs four derivatives and no texture.
    nftCurv = nftCurvature(vObjPos, normalize(vObjNrm));
    float cavity = smoothstep(0.0, 26.0, -nftCurv);           // concave: 4 cm radius -> full
    float edge   = smoothstep(9.0, 48.0, nftCurv);            // convex crease -> highlight wear
    diffuseColor.rgb *= 1.0 - cavity * uCavity;
    roughnessFactor = min(1.0, roughnessFactor + cavity * uCavity * 0.5);
    // Thinned lacquer on a hard edge: a touch lighter, a touch duller, a touch less metallic.
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.72 + vec3(0.11), edge * uEdgeWear);
    roughnessFactor = mix(roughnessFactor, 0.44, edge * uEdgeWear * 0.7);

    // scratched, dulled paint where the panel is deformed
    float scr = nftHash13(floor(vObjPos * 240.0)) ;
    float wear = clamp(vDentAmt * 3.4 + uWear, 0.0, 1.0);
    roughnessFactor = mix(roughnessFactor, 0.72, wear * 0.85);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.42 + vec3(0.05), wear * 0.6);
    diffuseColor.rgb *= 1.0 - wear * 0.35 * step(0.72, scr);
    metalnessFactor = mix(metalnessFactor, 0.25, wear * 0.7);
  }
`;

/** Object-space dent centres for each damage region, scaled by the car's bounding box. */
export const DENT_REGIONS = ['frontL', 'frontR', 'rearL', 'rearR', 'left', 'right', 'roof'];

export function dentCentres(L, W, H) {
  return {
    frontL: new THREE.Vector3(-W * 0.34, H * 0.42, -L * 0.44),
    frontR: new THREE.Vector3(W * 0.34, H * 0.42, -L * 0.44),
    rearL: new THREE.Vector3(-W * 0.34, H * 0.46, L * 0.44),
    rearR: new THREE.Vector3(W * 0.34, H * 0.46, L * 0.44),
    left: new THREE.Vector3(-W * 0.5, H * 0.44, 0),
    right: new THREE.Vector3(W * 0.5, H * 0.44, 0),
    roof: new THREE.Vector3(0, H * 0.95, L * 0.02),
  };
}

/**
 * Multi-layer car paint.
 * @param {object} o { color, flake, clearcoat, metalness, roughness, iridescence, envMap, wear }
 */
export function makePaint(o = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    // A real basecoat is only mildly metallic — the mirror is the CLEAR COAT on top. Push
    // metalness too high and the pigment disappears into a grey reflection.
    color: o.color ?? 0xcc2222,
    metalness: o.metalness ?? 0.62,
    roughness: o.roughness ?? 0.28,
    clearcoat: o.clearcoat ?? 1.0,
    // A showroom lacquer is a mirror. 0.09 already blurs the horizon line into a smear; the
    // sharp reflected edge is most of what tells a viewer "this is painted metal".
    clearcoatRoughness: o.clearcoatRoughness ?? 0.035,
    envMapIntensity: o.envMapIntensity ?? 2.1,
    sheen: 0.0,
    reflectivity: 0.62,
    specularIntensity: 1.0,
  });
  // NOTE: three's iridescence layer is deliberately NOT used. Combined with a high-frequency
  // flake normal it fringes every specular highlight into rainbow noise. Pearl finishes are
  // done with the flake colour instead.
  void 0;
  mat.name = 'carPaint';

  const dent = [];
  for (let i = 0; i < 7; i++) dent.push(new THREE.Vector4(0, 0, 0, 0));

  const uniforms = {
    // Target on-screen flake cell size, in pixels. ~1.6 px is the sweet spot: fine enough to
    // read as a shimmer rather than dots, coarse enough to survive the resolve.
    uFlakeCellPx: { value: o.flakeCellPx ?? 1.6 },
    uFlakeStrength: { value: o.flakeStrength ?? 0.055 },
    uFlakeSparkle: { value: o.flakeSparkle ?? 0.55 },
    uFlakeColor: { value: new THREE.Color(o.flake ?? 0xffd9a0) },
    uDirt: { value: o.dirt ?? 0.12 },
    uWear: { value: o.wear ?? 0.0 },
    // Peel amplitude, as a normal offset. Calibrated by eye against a mirror clearcoat: 0.03
    // tilts the lacquer by ~2 degrees and that is already enough to break the reflection into
    // visible fish-scale. 0.006 is about a third of a degree — you see it as a faint sheen in
    // the reflected highlight and nothing else, which is exactly what peel is.
    uPeel: { value: o.peel ?? 0.006 },
    // Target on-screen period of one peel cycle, in pixels. Below ~3 px it stops being texture
    // and starts being noise, so this is the floor the LOD clamp defends.
    uPeelPx: { value: o.peelPx ?? 4.0 },
    uCavity: { value: o.cavity ?? 0.3 },
    uEdgeWear: { value: o.edgeWear ?? 0.16 },
    uDent: { value: dent },
  };
  mat.userData.u = uniforms;
  mat.userData.isPaint = true;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${DENT_PARS_VERT}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${DENT_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FLAKE_PARS}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${DENT_FRAG}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FLAKE_NORMAL}`)
      .replace(
        '#include <clearcoat_normal_fragment_begin>',
        `#include <clearcoat_normal_fragment_begin>\n${CLEARCOAT_PEEL}`
      )
      .replace('#include <tonemapping_fragment>', `${FLAKE_SPARKLE}\n#include <tonemapping_fragment>`);
    mat.userData.shader = shader;
  };
  // Programs are shared across paint instances (identical source); uniforms stay per-material.
  mat.customProgramCacheKey = () => 'nft-paint' + (o.iridescence ? '-irid' : '');
  return mat;
}

/** Automotive glass: green-tinted edges, real fresnel, dark but see-through. */
export function makeGlass(o = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    color: o.color ?? 0x080d0b,
    metalness: 0,
    roughness: o.roughness ?? 0.028,
    // Privacy glass, not a swimming pool. At envMapIntensity 2.6 the whole greenhouse blew out
    // to a flat cyan panel and you could not tell there was a cabin behind it.
    transmission: o.transmission ?? 0.22,
    thickness: o.thickness ?? 0.02,
    ior: 1.52,
    transparent: true,
    opacity: 1,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    envMapIntensity: o.envMapIntensity ?? 1.5,
    attenuationColor: new THREE.Color(0x2f6b52),
    attenuationDistance: o.attenuation ?? 0.55,
    side: THREE.FrontSide,
    depthWrite: false,
    specularIntensity: 1.0,
  });
  m.name = 'carGlass';
  // Edge tint + a windscreen that isn't a mirror at grazing angles: fade the clearcoat
  // reflection into the tint instead of blowing out.
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vGlassN;`
      )
      .replace(
        '#include <tonemapping_fragment>',
        `{
           vec3 V = normalize(vViewPosition);
           float f = pow(1.0 - clamp(dot(normalize(vGlassN), V), 0.0, 1.0), 4.0);
           gl_FragColor.rgb += vec3(0.05, 0.13, 0.10) * f * 0.9;
           gl_FragColor.rgb *= mix(1.0, 0.72, f * 0.4);
         }\n#include <tonemapping_fragment>`
      );
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vGlassN;`)
      .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>\nvGlassN = transformedNormal;`);
  };
  m.customProgramCacheKey = () => 'nft-glass';
  return m;
}

/** Light lens: clear, faceted, refracts the reflector behind it. */
export function makeLens(tint = 0xffffff, o = {}) {
  return new THREE.MeshPhysicalMaterial({
    color: tint,
    metalness: 0,
    roughness: o.roughness ?? 0.02,
    transmission: 0.94,
    thickness: 0.03,
    ior: 1.49,
    transparent: true,
    clearcoat: 1,
    clearcoatRoughness: 0.01,
    envMapIntensity: 2.2,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Chrome-ish reflector bowl inside a headlight. */
export function makeReflector() {
  return new THREE.MeshStandardMaterial({
    color: 0xf2f5f8,
    metalness: 1,
    roughness: 0.07,
    envMapIntensity: 2.6,
    side: THREE.DoubleSide,
  });
}

export function makeEmissive(color, intensity = 3) {
  const m = new THREE.MeshStandardMaterial({
    color: 0x0a0a0a,
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
    metalness: 0.1,
    roughness: 0.35,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
  m.name = 'carLamp';
  return m;
}

export function makeChrome(o = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: o.color ?? 0xd8dde3,
    metalness: 1,
    roughness: o.roughness ?? 0.12,
    envMapIntensity: 2.4,
    map: o.map ?? null,
    normalMap: o.normalMap ?? null,
  });
  if (m.normalMap) m.normalScale = new THREE.Vector2(0.25, 0.25);
  return m;
}

export function makeAlu(o = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: o.color ?? 0xa9b0b8,
    metalness: 1,
    roughness: o.roughness ?? 0.3,
    envMapIntensity: 1.9,
    map: o.map ?? null,
    normalMap: o.normalMap ?? null,
  });
  if (m.normalMap) m.normalScale = new THREE.Vector2(0.4, 0.4);
  return m;
}

/**
 * Machined alloy rim.
 *
 * A rim is not one uniform metal, and treating it as one is why the wheels read as dark voids at
 * chase distance: a fully metallic surface with a dark albedo, sitting inside a shadowed arch,
 * has nothing to reflect and no albedo of its own to fall back on. Three things fix it, all in
 * one material:
 *
 *  - a BRIGHTNESS FLOOR. `rimColor` is a styling tint, not a reflectance — an anodised grey
 *    alloy still returns ~55% at normal incidence. The tint is preserved as hue and pushed up.
 *  - a POLISHED OUTER LIP. Every cast wheel has a diamond-cut flange. It is a mirror ring right
 *    at the silhouette of the wheel, so it catches the sky even when the spokes are in shade,
 *    and it is the single feature that makes a wheel read as machined at 60 px.
 *  - EDGE CATCH on the spoke arrises, from screen-space curvature. Spokes are only a few pixels
 *    wide at race distance; without a highlight running along them they merge into the tyre.
 */
export function makeRim(o = {}) {
  const tint = new THREE.Color(o.color ?? 0x9aa0a8);
  // Preserve the hue, lift the value: this is the difference between "dark grey wheel" and
  // "wheel-shaped hole in the car".
  const hsl = { h: 0, s: 0, l: 0 };
  tint.getHSL(hsl);
  tint.setHSL(hsl.h, hsl.s * 0.88, Math.max(hsl.l, 0.42));

  const m = new THREE.MeshStandardMaterial({
    color: tint,
    metalness: 1,
    roughness: o.roughness ?? 0.26,
    envMapIntensity: o.envMapIntensity ?? 2.7,
    map: o.map ?? null,
    normalMap: o.normalMap ?? null,
  });
  if (m.normalMap) m.normalScale = new THREE.Vector2(0.3, 0.3);
  m.name = 'carRim';

  const uniforms = { uRimR: { value: o.radius ?? 0.26 } };
  m.userData.u = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRimP;\nvarying vec3 vRimN;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvRimP = transformed;\nvRimN = objectNormal;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uRimR;
         varying vec3 vRimP;
         varying vec3 vRimN;`
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
         {
           // The wheel axis is +X (see CarWheels), so the radius is in the YZ plane.
           float rr = length(vRimP.yz) / max(uRimR, 1e-4);
           float lip = smoothstep(0.90, 0.995, rr);
           roughnessFactor = mix(roughnessFactor, 0.045, lip * 0.9);
           diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.5 + vec3(0.4), lip * 0.8);

           vec3 dpx = dFdx(vRimP), dpy = dFdy(vRimP);
           vec3 nn = normalize(vRimN);
           vec3 dnx = dFdx(nn), dny = dFdy(nn);
           float dd = dot(dpx, dpx) + dot(dpy, dpy);
           float curv = dd > 1e-12 ? (dot(dnx, dpx) + dot(dny, dpy)) / dd : 0.0;
           float arris = smoothstep(14.0, 70.0, curv);
           diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.5 + vec3(0.42), arris * 0.5);
           roughnessFactor = mix(roughnessFactor, 0.07, arris * 0.6);
           // ...and the reverse: the shadowed inside corners of the spokes go dark, which is
           // what gives the wheel depth instead of a flat disc of metal.
           diffuseColor.rgb *= 1.0 - smoothstep(0.0, 45.0, -curv) * 0.4;
         }`
      );
  };
  m.customProgramCacheKey = () => 'nft-rim';
  return m;
}

export function makeCarbon(map = null, normalMap = null, roughnessMap = null) {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0x14161b,
    metalness: 0.3,
    roughness: 0.4,
    clearcoat: 0.85,
    clearcoatRoughness: 0.12,
    envMapIntensity: 1.15,
    map,
    normalMap,
    roughnessMap,
  });
  if (normalMap) m.normalScale = new THREE.Vector2(0.85, 0.85);
  return m;
}

export function makeSatinBlack(rough = 0.55, normalMap = null) {
  const m = new THREE.MeshStandardMaterial({
    color: 0x15171b,
    metalness: 0.35,
    roughness: rough,
    envMapIntensity: 0.9,
    normalMap,
  });
  if (normalMap) m.normalScale = new THREE.Vector2(0.5, 0.5);
  return m;
}

/**
 * Wheel-well liner. NOT the same thing as `makeCavity()` — a pure black cavity behind an arch is
 * indistinguishable from a hole in the model, which is precisely how the arches used to read.
 * A liner is moulded, slightly rough plastic: dark, but it takes a bounce and shows form.
 */
export function makeArchLiner(normalMap = null) {
  // Deliberately NO albedo map: the only greyscale detail texture available here is a bright
  // scratched-metal albedo, and hanging it on the liner turned every wheel well into a pale
  // panel. Form comes from the normal map; the colour stays moulded-plastic dark.
  const m = new THREE.MeshStandardMaterial({
    color: 0x25272c,
    metalness: 0.06,
    roughness: 0.9,
    envMapIntensity: 0.55,
    normalMap,
    side: THREE.DoubleSide,
  });
  if (normalMap) m.normalScale = new THREE.Vector2(1.1, 1.1);
  return m;
}

/** The dark cavity behind grilles and intakes. Almost no reflection = reads as depth. */
/** Panel-gap / shut-line groove. Polygon-offset so it can ride 1 mm off the panel safely. */
export function makeShutLine() {
  const m = new THREE.MeshStandardMaterial({
    color: 0x0a0b0d,
    metalness: 0.2,
    roughness: 0.85,
    envMapIntensity: 0.25,
  });
  // Thin strips: winding is ambiguous, so draw both faces.
  m.side = THREE.DoubleSide;
  // A SLOPE-SCALED offset (factor != 0) is what made the rocker crease erupt through the paint
  // as a comb of dark spikes: at a grazing angle the slope term is enormous. The band is now
  // geometrically proud of the panel (see CarBody.groove), so all it needs is a constant nudge.
  m.polygonOffset = true;
  m.polygonOffsetFactor = 0;
  m.polygonOffsetUnits = -2;
  return m;
}

/** Inner skin: the dark cabin/underbody surface you see through the glass and the arches. */
export function makeInnerSkin() {
  const m = new THREE.MeshStandardMaterial({
    color: 0x0c0d10,
    metalness: 0.05,
    roughness: 0.95,
    envMapIntensity: 0.2,
    side: THREE.BackSide,
  });
  // An inward offset surface self-intersects wherever the body curvature radius is smaller than
  // the offset. Biasing depth AWAY from the camera makes those pops lose to the painted panel
  // instead of punching black holes through it.
  m.polygonOffset = true;
  m.polygonOffsetFactor = 6;
  m.polygonOffsetUnits = 12;
  return m;
}

export function makeCavity() {
  return new THREE.MeshStandardMaterial({
    color: 0x050607,
    metalness: 0,
    roughness: 1,
    envMapIntensity: 0.06,
    side: THREE.DoubleSide,
  });
}

/** Tyre rubber — deep, slightly sheened, never plastic-shiny. */
export function makeRubber(map = null, normalMap = null) {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0x0e0e10,
    metalness: 0,
    roughness: 0.86,
    sheen: 0.35,
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color(0x2a2a30),
    envMapIntensity: 0.55,
    map,
    normalMap,
  });
  if (normalMap) m.normalScale = new THREE.Vector2(0.7, 0.7);
  return m;
}

/** Brake disc: iron, with a heat-glow emissive driven by setBrakeGlow(). */
export function makeDisc() {
  // Seen through the spokes at chase distance the disc is the wheel's interior: if it is as dark
  // as the arch behind it the wheel has no depth. Machined iron is a mid grey that takes a broad
  // sheen, not near-black.
  const m = new THREE.MeshStandardMaterial({
    color: 0x71757d,
    metalness: 1,
    roughness: 0.36,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0,
    envMapIntensity: 1.9,
  });
  m.name = 'brakeDisc';
  return m;
}

export function makeCaliper(color = 0xcc2418) {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.35,
    roughness: 0.34,
    clearcoat: 0.7,
    clearcoatRoughness: 0.18,
    envMapIntensity: 1.3,
  });
}

/** Interior: alcantara-ish, matte, absorbs light so the cabin reads as a real space. */
export function makeInterior(color = 0x1a1a1e) {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0,
    roughness: 0.94,
    sheen: 0.5,
    sheenRoughness: 0.85,
    sheenColor: new THREE.Color(0x3a3a44),
    envMapIntensity: 0.35,
  });
}

/** Apply the scene env map to every material in a subtree (cheap, once at build). */
export function applyEnv(root, envMap) {
  if (!envMap) return;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) if (m && 'envMap' in m) m.envMap = envMap;
  });
}
