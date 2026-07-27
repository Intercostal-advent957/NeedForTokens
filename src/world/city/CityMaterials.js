import * as THREE from 'three';

/**
 * The city's four materials. Everything the lane renders uses one of these, which is what keeps
 * a few hundred buildings inside the draw-call budget (CONTRACTS.md §0).
 *
 *  surface   — buildings, tunnel, props, ground. Patched MeshStandardMaterial that reads
 *              `aKind`/`aSeed` per vertex to pick a procedural pattern (brick coursing, precast
 *              seams, corrugation, wall tiling, LOD window grids) plus an emissive branch for
 *              lit windows / neon / lamps. One draw call can contain concrete, glass and neon.
 *  signage   — the sign atlas as both albedo and emissive map. emissiveIntensity is driven from
 *              time-of-day so shop fronts come on at dusk.
 *  foliage   — alpha-tested cards with wind sway in the vertex shader.
 *  glow      — additive camera-facing halos around light sources. Cheap night atmosphere.
 *
 * Shared uniform objects are held on the instance and written once per frame by CitySystem.
 */

const COMMON_FN = /* glsl */ `
float cHash(float n){ return fract(sin(n*127.1)*43758.5453123); }
float cHash2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453123); }
float cNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cHash2(i), cHash2(i + vec2(1,0)), f.x),
             mix(cHash2(i + vec2(0,1)), cHash2(i + vec2(1,1)), f.x), f.y);
}
/**
 * Paint stripe of half-width 'hw' metres centred on 'd' = 0, antialiased against the local
 * derivative. Ground markings are the first thing to alias into crawling noise at a distance,
 * so 'px' widens the falloff and the caller fades the whole pattern out once a stripe is
 * thinner than a pixel.
 *
 * NOTE: this comment sits inside a JS template literal — never use backticks in here, they
 * terminate the string and break the whole module.
 */
float cStripe(float d, float hw, float px){
  return 1.0 - smoothstep(hw, hw + px * 1.2 + 0.02, abs(d));
}
`;

export class CityMaterials {
  constructor(ctx, textures) {
    this.ctx = ctx;
    this.tex = textures;

    this.uniforms = {
      uTime: { value: 0 },
      uNight: { value: 0 }, // 0 = daylight, 1 = full night
      uLitFrac: { value: 0.34 }, // fraction of windows that are switched on
      uWet: { value: 0 },
      uEmissive: { value: 1 },
      uWind: { value: 1 },
      uGlow: { value: 1 },
      uTunnelFill: { value: 0.16 },
      uCam: { value: new THREE.Vector3() },
      // Foliage translucency needs the key light itself, not just the shaded result: a leaf lit
      // from behind is a transmission problem, and three's lighting loop has already thrown the
      // per-light vectors away by the time we get a hook. CONTRACTS.md §6 exposes both.
      uSunDir: { value: new THREE.Vector3(0.4, -0.35, 0.85) }, // FROM sun TO scene
      uSunCol: { value: new THREE.Color(1, 1, 1) }, // colour x intensity
      uSkyCol: { value: new THREE.Color(0.25, 0.3, 0.4) }, // hemisphere fill
    };

    this.surface = this._surface();
    this.surfaceNoShadow = this.surface;
    // Draws nothing in the beauty pass but keeps the object `visible`, so three still submits
    // it to the shadow map (which uses its own depth material). See CitySystem._shadowCasters.
    this.shadowOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    this.shadowOnly.name = 'city-shadow-proxy';
    this.signage = this._signage();
    this.foliage = this._foliage();
    this.glow = this._glow();
  }

  // ------------------------------------------------------------------ surface
  _surface() {
    const t = this.tex;
    const grain = t.grain;
    grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
    grain.repeat.set(1 / 2.6, 1 / 2.6);
    const nrm = t.grainNormal;
    nrm.wrapS = nrm.wrapT = THREE.RepeatWrapping;
    nrm.repeat.set(1 / 1.3, 1 / 1.3);
    // Facades are almost always seen at a grazing angle, where an isotropic mip pick has to
    // blur along BOTH axes to satisfy the longer one. Anisotropic filtering keeps the short
    // axis sharp instead of over-blurring it. It is safe to turn up here specifically because
    // the surface shader now folds screen-space normal variance back into the roughness (see
    // the specular-AA block below): sharper normal-map mips raise the variance, which widens
    // the specular lobe by exactly the amount needed, so detail comes back without shimmer.
    // CONTRACTS.md §4 lists `anisotropy` as a key any system may read.
    const aniso = Math.max(1, this.ctx.settings?.get('anisotropy') ?? 4);
    const caps = this.ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 16;
    for (const tx of [grain, nrm]) {
      const want = Math.min(aniso, caps);
      if (tx.anisotropy !== want) {
        tx.anisotropy = want;
        tx.needsUpdate = true;
      }
    }

    const m = new THREE.MeshStandardMaterial({
      map: grain,
      normalMap: nrm,
      normalScale: new THREE.Vector2(0.42, 0.42),
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.02,
      envMapIntensity: 1.0,
      dithering: true,
    });
    m.name = 'city-surface';
    const U = this.uniforms;

    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);

      sh.vertexShader = sh.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aKind;
           attribute float aSeed;
           attribute float aFeat;
           varying float vKind;
           varying float vSeed;
           varying float vFeat;
           varying float vInst;
           varying vec2 vSurfUv;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vKind = aKind;
           vSeed = aSeed;
           vFeat = aFeat;
           vSurfUv = uv;
           #ifdef USE_INSTANCING
             vInst = fract(sin(dot(instanceMatrix[3].xyz, vec3(12.9898,78.233,37.719)))*43758.5453);
           #else
             vInst = 0.0;
           #endif`
        );

      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           ${COMMON_FN}
           uniform float uTime, uNight, uLitFrac, uWet, uEmissive, uTunnelFill;
           varying float vKind;
           varying float vSeed;
           varying float vFeat;
           varying float vInst;
           varying vec2 vSurfUv;`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           float cRough = 0.0;
           float cFarWin = 0.0;
           float cFarSeed = 0.0;
           float cFarHalo = 0.0;  // ring of facade just outside a window — takes the light spill
           float cFarV = 0.0;     // height inside the window cell, 0 = sill, 1 = head
           float cSubPix = 1.0;   // 1 = this face is resolvable, 0 = thinner than a pixel
           {
             float K = vKind;
             vec3 pat = vec3(1.0);
             if (K > 4.5 && K < 5.5) {
               // --- brick coursing
               vec2 bp = vSurfUv / vec2(0.235, 0.076);
               bp.x += mod(floor(bp.y), 2.0) * 0.5;
               vec2 f = fract(bp);
               float det = clamp(1.0 - max(fwidth(bp.x), fwidth(bp.y)) * 0.85, 0.0, 1.0);
               float m = min(min(smoothstep(0.0,0.09,f.x), smoothstep(0.0,0.09,1.0-f.x)),
                             min(smoothstep(0.0,0.19,f.y), smoothstep(0.0,0.19,1.0-f.y)));
               float bv = cHash2(floor(bp));
               pat *= mix(vec3(1.0), mix(vec3(0.55,0.53,0.52), vec3(0.80+0.42*bv), m), det);
             } else if (K > 5.5 && K < 6.5) {
               // --- corrugated metal
               float ph = vSurfUv.x / 0.17;
               float det = clamp(1.0 - fwidth(ph) * 0.9, 0.0, 1.0);
               float w = sin(ph * 6.2831853);
               pat *= mix(vec3(1.0), vec3(0.72 + 0.46 * (w * 0.5 + 0.5)), det);
               cRough = -0.22;
             } else if (K > 6.5 && K < 7.5) {
               // --- precast panel seams
               vec2 pp = vSurfUv / vec2(1.42, 1.08);
               vec2 f = abs(fract(pp) - 0.5);
               float det = clamp(1.0 - max(fwidth(pp.x), fwidth(pp.y)) * 1.1, 0.0, 1.0);
               float seam = smoothstep(0.435, 0.5, max(f.x, f.y));
               float pv = cHash2(floor(pp));
               pat *= mix(vec3(1.0), vec3(0.90 + 0.20 * pv) * (1.0 - seam * 0.55), det);
             } else if (K > 7.5 && K < 8.5) {
               // --- LOD / backdrop facade: procedural window grid.
               // The grid must dissolve into a flat average as soon as a cell approaches a
               // pixel, or the horizon turns into crawling noise.
               vec2 gp = vSurfUv / vec2(3.4, 3.6);
               vec2 f = fract(gp);
               float px = max(fwidth(gp.x), fwidth(gp.y));
               float det = 1.0 - smoothstep(0.14, 0.55, px);
               float aa = clamp(px * 1.6, 0.02, 0.42);
               float win = smoothstep(0.16, 0.16 + aa, f.x) * smoothstep(0.16, 0.16 + aa, 1.0-f.x)
                         * smoothstep(0.22, 0.22 + aa, f.y) * smoothstep(0.18, 0.18 + aa, 1.0-f.y);
               win *= det;
               cFarWin = win;
               cFarV = f.y;
               /* vSeed HAS to be in here. Without it every backdrop box starts its grid at
                * uv 0 with the same cell hashes, so all ~750 skyline blocks and every merged
                * sector LOD lit the SAME window pattern — which is precisely why the horizon
                * read as one stamped texture rather than a city. */
               cFarSeed = cHash2(floor(gp) + vec2(vInst * 37.1 + vSeed * 131.7,
                                                  vInst * 11.7 + vSeed * 57.3));
               // Ring just outside the pane. A lit room throws light onto its own reveal and
               // the wall around it; without this the window is a decal floating on concrete.
               vec2 q = abs(f - vec2(0.5, 0.52)) - vec2(0.34, 0.30);
               cFarHalo = max((1.0 - smoothstep(0.0, 0.15, length(max(q, 0.0)))) - win, 0.0) * det;
               pat *= mix(vec3(1.0), vec3(0.24,0.26,0.31), win);
               cRough = -0.45 * win;
             } else if (K > 21.5 && K < 22.5) {
               // --- window reveal (sill / soffit / jamb). Same family as the wall it belongs
               // to, so it only needs enough grain not to read as clean plastic next to the
               // brick or precast it is cut into. The spill itself is in the emissive block.
               pat *= vec3(0.88 + 0.20 * cHash2(floor(vSurfUv * 2.3)));
               cRough = 0.04;
             } else if (K > 8.5 && K < 9.5) {
               // --- glazed wall tile (tunnel) + rising grime
               vec2 tp = vSurfUv / vec2(0.19, 0.19);
               vec2 f = abs(fract(tp) - 0.5);
               float det = clamp(1.0 - max(fwidth(tp.x), fwidth(tp.y)) * 1.0, 0.0, 1.0);
               float grout = smoothstep(0.40, 0.5, max(f.x, f.y));
               float tv = cHash2(floor(tp));
               pat *= mix(vec3(1.0), mix(vec3(0.86 + 0.16 * tv), vec3(0.52), grout), det);
               float grime = smoothstep(3.1, 0.0, vSurfUv.y) * (0.45 + 0.55 * cHash(floor(vSurfUv.x * 1.3)));
               float streak = smoothstep(0.55, 1.0, cHash(floor(vSurfUv.x * 3.7))) * smoothstep(4.2, 1.0, vSurfUv.y);
               pat *= mix(vec3(1.0), vec3(0.30,0.29,0.27), clamp(grime * 0.8 + streak * 0.5, 0.0, 0.8));
               cRough = -0.42;
             } else if (K > 9.5 && K < 10.5) {
               // --- road / pavement: wetness darkens and polishes
               pat *= mix(vec3(1.0), vec3(0.52,0.54,0.58), uWet * 0.75);
               cRough = -0.62 * uWet;
             } else if (K > 13.5 && K < 14.5) {
               // --- tunnel structure: poured concrete with heavy soot toward the road
               float b = cHash2(floor(vSurfUv * 0.4));
               pat *= vec3(0.86 + 0.20 * b);
               pat *= mix(vec3(0.44,0.43,0.41), vec3(1.0), smoothstep(0.0, 2.4, vSurfUv.y));
               cRough = 0.05;
             } else if (K > 11.5 && K < 12.5) {
               // --- poured concrete: broad blotching
               float b = cHash2(floor(vSurfUv * 0.31));
               pat *= vec3(0.90 + 0.18 * b);
               cRough = 0.08;
             } else if (K > 14.5 && K < 15.5) {
               // --- flagged pavement. 1.5 x 2.0 m slabs; the joint grid is what makes a
               // street read as a street from 40 m up.
               vec2 sp = vSurfUv / vec2(1.5, 2.0);
               vec2 f = abs(fract(sp) - 0.5);
               float px = max(fwidth(sp.x), fwidth(sp.y));
               float det = 1.0 - smoothstep(0.20, 0.62, px);
               float joint = smoothstep(0.40, 0.5, max(f.x, f.y)) * det;
               float sv = cHash2(floor(sp));
               pat *= vec3(0.86 + 0.26 * sv) * (1.0 - joint * 0.36);
               pat *= 0.90 + 0.22 * cNoise(vSurfUv * 0.33);
               pat *= mix(vec3(1.0), vec3(0.66,0.68,0.70), uWet * 0.55);
               cRough = 0.06 - 0.5 * uWet;
             } else if (K > 15.5 && K < 16.5) {
               // --- parking lot: 2.6 m bays either side of a 1.4 m aisle, on a 12 m pitch.
               vec2 lp = vSurfUv + vec2(vSeed * 17.0, vSeed * 29.0);
               float px = max(fwidth(lp.x), fwidth(lp.y));
               float det = 1.0 - smoothstep(0.30, 1.10, px);
               float yy = fract(lp.y / 12.0) * 12.0;
               float inBay = step(0.30, yy) * step(yy, 5.30) + step(6.70, yy) * step(yy, 11.70);
               float bayLine = cStripe(fract(lp.x / 2.6) - 0.5, 0.030, px / 2.6) * inBay;
               float headLine = cStripe(yy - 5.30, 0.055, px) + cStripe(yy - 6.70, 0.055, px);
               float paint = clamp(bayLine + headLine, 0.0, 1.0) * det;
               float crack = smoothstep(0.62, 0.80, cNoise(lp * 0.42)) * det;
               pat *= vec3(0.80 + 0.34 * cNoise(lp * 0.11)) * (1.0 - crack * 0.30);
               pat *= mix(vec3(1.0), vec3(0.52,0.54,0.58), uWet * 0.70);
               pat = mix(pat, pat * vec3(6.4, 6.2, 5.6), paint * 0.85);
               cRough = -0.10 - 0.52 * uWet;
             } else if (K > 16.5 && K < 17.5) {
               // --- unmade ground: dirt with gravel patches and worn tyre tracks
               float d1 = cNoise(vSurfUv * 0.13);
               float d2 = cNoise(vSurfUv * 0.55);
               float d3 = cNoise(vSurfUv * 2.4);
               pat *= vec3(0.66 + 0.62 * d1) * (0.86 + 0.28 * d2);
               pat *= mix(vec3(1.0), vec3(0.80,0.78,0.74), smoothstep(0.48, 0.86, d3));
               float rut = smoothstep(0.70, 0.90, cNoise(vSurfUv * vec2(0.6, 0.06)));
               pat *= mix(vec3(1.0), vec3(0.70,0.66,0.60), rut * 0.8);
               cRough = 0.12;
             } else if (K > 17.5 && K < 18.5) {
               // --- deliberate green space. Mower stripes are the cue that says "kept",
               // which is what separates a park from the countryside.
               float g1 = cNoise(vSurfUv * 0.30);
               float g2 = cNoise(vSurfUv * 1.6);
               float stripe = 0.93 + 0.12 * step(0.5, fract(vSurfUv.y / 7.0));
               pat *= vec3(0.74 + 0.50 * g1) * stripe * (0.90 + 0.20 * g2);
               cRough = 0.06;
             } else if (K > 18.5 && K < 19.5) {
               // --- kerb: pale precast, painted on a fraction of the runs
               float px = fwidth(vSurfUv.y);
               pat *= vec3(0.92 + 0.20 * cHash2(floor(vSurfUv * vec2(0.55, 0.32))));
               float run = cHash(floor(vSurfUv.y / 11.0) + vSeed * 41.0);
               float det = 1.0 - smoothstep(0.25, 0.9, px);
               pat = mix(pat, pat * vec3(3.6, 2.7, 0.8), step(0.84, run) * det * 0.8);
               cRough = 0.04;
             } else if (K > 19.5 && K < 20.5) {
               // --- service road / alley: asphalt, dashed centre line, painted edges
               vec2 rp = vSurfUv + vec2(vSeed * 11.0, vSeed * 23.0);
               float px = max(fwidth(rp.x), fwidth(rp.y));
               float det = 1.0 - smoothstep(0.30, 1.10, px);
               float dash = step(0.42, fract(rp.y / 6.0));
               float centre = cStripe(fract(rp.x / 7.0) - 0.5, 0.055, px) * dash;
               pat *= vec3(0.82 + 0.30 * cNoise(rp * 0.16));
               pat *= mix(vec3(1.0), vec3(0.52,0.54,0.58), uWet * 0.75);
               pat = mix(pat, pat * vec3(5.6, 5.4, 4.8), clamp(centre, 0.0, 1.0) * det * 0.8);
               cRough = -0.08 - 0.58 * uWet;
             } else if (K > 20.5 && K < 21.5) {
               // --- poured hardstanding. Sidewalk flags at this size tile into a plaza when
               // you see a whole block of them from the air; concrete yards are cast in bays.
               vec2 sp = vSurfUv / vec2(4.5, 6.0);
               vec2 f = abs(fract(sp) - 0.5);
               float px = max(fwidth(sp.x), fwidth(sp.y));
               float det = 1.0 - smoothstep(0.16, 0.55, px);
               float joint = smoothstep(0.455, 0.5, max(f.x, f.y)) * det;
               float bv = cHash2(floor(sp));
               pat *= vec3(0.90 + 0.18 * bv) * (1.0 - joint * 0.40);
               // repairs and oil staining break the grid up.
               // NB: 'patch' is a GLSL reserved word — do not name anything that in here.
               float repair = smoothstep(0.66, 0.74, cNoise(vSurfUv * 0.075));
               pat *= mix(vec3(1.0), vec3(0.74,0.73,0.72), repair);
               pat *= 0.88 + 0.24 * cNoise(vSurfUv * 0.26);
               pat *= mix(vec3(1.0), vec3(0.66,0.68,0.70), uWet * 0.55);
               cRough = 0.05 - 0.5 * uWet;
             }
             diffuseColor.rgb *= pat;
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           if (vKind > 0.5 && vKind < 1.5) roughnessFactor = 0.135;
           else if (vKind > 10.5 && vKind < 11.5) roughnessFactor = 0.10;
           else if (vKind > 3.5 && vKind < 4.5) roughnessFactor = 0.33;
           roughnessFactor = clamp(roughnessFactor + cRough, 0.035, 1.0);`
        )
        .replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>
           if (vKind > 0.5 && vKind < 1.5) metalnessFactor = 0.72;
           else if (vKind > 10.5 && vKind < 11.5) metalnessFactor = 0.90;
           else if (vKind > 3.5 && vKind < 4.5) metalnessFactor = 0.88;
           else if (vKind > 9.5 && vKind < 10.5) metalnessFactor = max(metalnessFactor, uWet * 0.35);
           // the paved family wets the same way the carriageway does
           else if ((vKind > 15.5 && vKind < 16.5) || (vKind > 19.5 && vKind < 20.5))
             metalnessFactor = max(metalnessFactor, uWet * 0.32);
           else if (vKind > 14.5 && vKind < 15.5) metalnessFactor = max(metalnessFactor, uWet * 0.18);`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           /* ---------------------------------------------------------------- specular AA
            * This runs here, not in roughnessmap_fragment, because it needs the resolved
            * shading normal - three composes that in normal_fragment_maps, which is the chunk
            * immediately above. roughnessFactor / metalnessFactor are not consumed until
            * lights_physical_fragment below, so editing them now is still in time.
            *
            * The facades were growing bright crawling horizontal bands: sill lips, spandrel
            * ledges, barrier rails and handrails are real proud geometry 50-110 mm thick, the
            * pipeline has no MSAA and no TAA (Settings: msaa 0, and PostFx does not implement
            * taa), so at distance a point-sampled narrow specular lobe on a sub-pixel band
            * spikes to full white on some frames and not others. Two independent causes, two
            * terms:
            */
           {
             /* 1. NORMAL VARIANCE (Kaplanyan/Tokuyoshi geometric specular AA). As the shading
              *    normal wobbles inside a pixel - normal-map minification, curvature, the
              *    cylinder facets - the correct answer is a WIDER lobe, not a sharper one.
              *    Fold the screen-space variance of the normal into the roughness:
              *        alpha' ^2 = alpha^2 + 2 * sigma^2
              *    Costs two derivatives. Fixes shimmer within a face. */
             vec3 dNx = dFdx(normal);
             vec3 dNy = dFdy(normal);
             float varN = 0.25 * (dot(dNx, dNx) + dot(dNy, dNy));
             float a2 = roughnessFactor * roughnessFactor + min(2.0 * varN, 0.30);

             /* 2. SUB-PIXEL GEOMETRY. Derivatives stop at the primitive edge, so (1) does
              *    nothing for a 50 mm rail that is thinner than the pixel it lands in. vFeat
              *    carries the narrow dimension of this face in metres (see Geo.js); compare it
              *    against the pixel footprint - view space is rigid, so the derivative of
              *    vViewPosition is a true length in metres - and drive the lobe toward diffuse
              *    once the face stops being resolvable. An unresolvable sliver of polished
              *    metal has to integrate to its average, not to its peak. Ground planes are
              *    excluded: they are single huge quads whose normal never varies, so they alias
              *    nothing, and rolling their reflectivity off would kill the wet-road mirror. */
             float px = max(length(dFdx(vViewPosition)), length(dFdy(vViewPosition)));
             float feat = vFeat > 0.0 ? vFeat : 1.0e6;   // 0 = attribute absent -> resolvable
             float ground = step(9.5, vKind) * step(vKind, 10.5)      // ROAD
                          + step(14.5, vKind) * step(vKind, 21.5)     // PAVEMENT..SLAB
                          - step(18.5, vKind) * step(vKind, 19.5);    // ...except KERB
             // Ramp: fully diffuse below ~0.65 px of coverage, fully sharp above ~3 px. For a
             // 50 mm rail at 1920x1080 that is matte past ~160 m and untouched inside ~35 m.
             float resolved = mix(smoothstep(0.65, 3.0, feat / max(px, 1.0e-5)), 1.0,
                                  clamp(ground, 0.0, 1.0));
             a2 = mix(1.0, a2, 0.18 + 0.82 * resolved);
             roughnessFactor = clamp(sqrt(min(a2, 1.0)), 0.035, 1.0);
             metalnessFactor *= 0.28 + 0.72 * resolved;
             cFarWin *= resolved;      // the LOD window grid must fade its specular too
             cSubPix = resolved;
           }
           {
             vec3 em = vec3(0.0);
             float K = vKind;
             if (K > 0.5 && K < 1.5) {
               /* ================= lit window with a parallax interior =================
                * A pure emissive quad is a sticker: no interior, no depth, no colour. This
                * marches a room box behind the pane instead. uv on a glass quad is in WINDOW
                * CELLS (see the WINDOW UV CONVENTION in Facade.js), so fract() is the position
                * inside one room and floor() names it.
                */
               vec2 cell = floor(vSurfUv);
               vec2 luv = vSurfUv - cell;
               float id = cHash(vSeed * 613.0 + vInst * 197.3 + dot(cell, vec2(37.7, 11.3)) + 3.11);

               /* --- tangent frame. Walls are vertical and the quads are built +X = u, +Y = v,
                * so the frame is exact from world up and the face normal - no derivatives, no
                * tangent attribute, no extra vertex bandwidth. */
               vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
               vec3 nW = normalize(normal);
               vec3 tanU = cross(upV, nW);
               float tl = length(tanU);
               tanU = tl > 1.0e-3 ? tanU / tl : vec3(1.0, 0.0, 0.0);
               vec3 tanV = cross(nW, tanU);
               vec3 eye = normalize(vViewPosition);            // fragment -> camera
               vec3 tv = vec3(dot(eye, tanU), dot(eye, tanV), max(dot(eye, nW), 0.06));

               /* --- march into the box: u,v in 0..1, z in -RD..0. One min() of three plane
                * distances gives the hit; 'back' says whether we landed on the rear wall or on
                * a side/floor/ceiling, which is the whole depth cue. */
               const float RD = 0.62;
               vec3 rd = -tv;
               vec3 inv = 1.0 / max(abs(rd), vec3(1.0e-4));
               float tU = (rd.x > 0.0 ? 1.0 - luv.x : luv.x) * inv.x;
               float tV = (rd.y > 0.0 ? 1.0 - luv.y : luv.y) * inv.y;
               float tZ = RD * inv.z;
               float tHit = min(min(tU, tV), tZ);
               vec3 hit = vec3(luv, 0.0) + rd * tHit;
               float depth01 = clamp(-hit.z * (1.0 / RD), 0.0, 1.0);
               float back = step(tZ, min(tU, tV));

               float room = 0.62;
               room *= mix(0.34, 1.0, back);                   // grazing side walls are dimmer
               room *= 1.0 - 0.5 * depth01;                    // depth falloff into the room
               // ceiling fitting on the back wall — the actual source in the room
               room += back * smoothstep(0.64, 0.85, hit.y) * (1.0 - smoothstep(0.85, 0.98, hit.y)) * 1.15;
               // furniture / clutter silhouette along the bottom
               room *= 1.0 - smoothstep(0.34, 0.10, hit.y)
                             * (0.35 + 0.55 * cHash2(floor(vec2(hit.x * 5.0, 1.0)) + id * 53.0));
               // a quarter of the rooms have blinds down, half-drawn as often as not
               // blinds hang from the head down, so a half-drawn one covers the UPPER part
               float blindAmt = step(0.76, cHash(id * 13.9 + 5.1))
                              * step(0.62 * cHash(id * 4.7 + 2.9), luv.y);
               room *= mix(1.0, 0.52 + 0.48 * smoothstep(0.38, 0.62, fract(luv.y * 12.0)), blindAmt);
               // dissolve to the room average before the box can alias into crawling noise
               float wpx = max(fwidth(vSurfUv.x), fwidth(vSurfUv.y));
               room = mix(0.62, room, 1.0 - smoothstep(0.12, 0.48, wpx));

               /* Depth is legible by daylight too: the pane stops being a flat blue sticker.
                * Clamped so this can only ever DARKEN. Glass is metalness 0.72, so diffuseColor
                * is also the specular tint here — letting the room brighten it would multiply
                * the reflected sky by the interior pattern and stamp furniture into the
                * reflections. */
               diffuseColor.rgb *= 0.34 + 0.66 * min(room, 1.0);

               /* --- on/off. Staggered by id, and a very slow shuffle so a few rooms change
                * state during a race instead of the whole city switching on at once. */
               float thr = uLitFrac * (0.75 + 0.5 * cHash(id * 91.7 + floor(uTime / 23.0 + id * 7.0)));
               float lit = step(id, thr);

               /* --- colour temperature: domestic tungsten -> warm white -> office
                * fluorescent, with a rare cold monitor-lit room. Identical white at identical
                * intensity is what made the old grid read as a texture. */
               float warm = cHash(id * 77.7 + 1.3);
               vec3 tone = warm < 0.42
                 ? mix(vec3(1.00,0.50,0.19), vec3(1.00,0.76,0.46), warm * 2.381)
                 : (warm < 0.82
                    ? mix(vec3(1.00,0.88,0.70), vec3(0.90,0.94,1.00), (warm - 0.42) * 2.5)
                    : mix(vec3(0.66,0.84,1.00), vec3(0.60,0.98,0.88), (warm - 0.82) * 5.556));
               // squared distribution: mostly dim rooms, a few hot ones. Uniform brightness is
               // the other half of the sticker read.
               float amt = 0.12 + 1.30 * pow(cHash(id * 31.4 + 7.7), 2.0);
               em += tone * lit * amt * room * uNight;
             } else if (K > 21.5 && K < 22.5) {
               /* --- window reveal. The sill, soffit and jambs around an opening; at night they
                * catch the spill from the room behind.
                *
                * The cell id has to be TWO-dimensional. A spandrel band runs horizontally, so
                * its openings vary along u; a pier is one box for the building's whole height,
                * so its jamb faces vary along v. Binning only u lit every pier as a single
                * continuous strip from pavement to parapet — an architectural light feature,
                * not window spill. Binning both means each face picks up whichever axis
                * actually crosses openings, because the other one is only a reveal deep.
                *
                * vFeat is that reveal depth, and the smaller uv axis is the one running across
                * it, so dep fades the bleed off toward the outer wall face.
                * (No backticks in here - they terminate the JS template literal.) */
               vec2 rc = floor(vSurfUv / 3.3 + vSeed * 23.0);
               float id = cHash(dot(rc, vec2(7.3, 19.1)) + vSeed * 611.0 + vInst * 197.3);
               float lit = step(id, uLitFrac * 1.1);
               float warm = cHash(id * 77.7 + 1.3);
               vec3 tone = mix(vec3(1.00,0.62,0.30), vec3(0.78,0.88,1.00), smoothstep(0.40, 0.86, warm));
               float dep = clamp(min(vSurfUv.x, vSurfUv.y) / max(vFeat, 0.05), 0.0, 1.0);
               em += tone * lit * uNight * (0.12 + 0.40 * dep) * (0.25 + 0.75 * cHash(id * 31.4 + 7.7));
             } else if (K > 1.5 && K < 2.5) {
               // --- neon: always burning, faint flicker on a few tubes
               float fl = 1.0 - 0.22 * step(0.94, cHash(floor(uTime * 13.0) + vSeed * 53.0));
               em += vColor.rgb * uEmissive * (1.1 + 2.2 * uNight) * fl;
             } else if (K > 2.5 && K < 3.5) {
               // --- lamps / shop strips: come on at dusk
               em += vColor.rgb * uEmissive * (0.10 + 2.2 * uNight);
             } else if (K > 7.5 && K < 8.5) {
               // Backdrop windows. Same rules as the near ones — varied temperature, squared
               // intensity distribution, a vertical gradient standing in for the room, and a
               // little spill onto the wall — just without the parallax march.
               float id = cHash(cFarSeed * 411.0 + 0.7);
               float lit = step(id, uLitFrac * 0.95);
               float warm = cHash(id * 17.1 + 2.3);
               vec3 tone = warm < 0.45
                 ? mix(vec3(1.00,0.55,0.24), vec3(1.00,0.82,0.56), warm * 2.222)
                 : mix(vec3(0.99,0.94,0.84), vec3(0.68,0.83,1.00), (warm - 0.45) * 1.818);
               float amt = 0.14 + 1.05 * pow(cHash(id * 5.3 + 1.9), 1.8);
               // brighter toward the head of the window, blocked toward the sill by furniture
               float grad = 0.5 + 0.8 * smoothstep(0.12, 0.92, cFarV);
               em += tone * lit * amt * uNight * (cFarWin * grad + cFarHalo * 0.17);
             } else if (K > 8.5 && K < 9.5) {
               // Enclosed bounce: a tunnel lit only by point lights reads as a black pipe.
               // A small self-lit term stands in for the light that ricochets off the tiles.
               em += diffuseColor.rgb * uTunnelFill;
             } else if (K > 13.5 && K < 14.5) {
               em += diffuseColor.rgb * uTunnelFill * 0.72;
             }
             // Emissive needs the same pre-filtering as the specular. A 100 mm strip light or a
             // neon tube covers a fraction of a distant pixel, so it must contribute that
             // fraction of its radiance; point sampling instead paints the whole pixel at full
             // brightness, which is how a light fitting turns into a razor line across a block.
             totalEmissiveRadiance += em * (0.20 + 0.80 * cSubPix);
           }`
        );
      this._surfaceShader = sh;
    };
    // Distinct cache key so three doesn't share a program with an unpatched standard material.
    m.customProgramCacheKey = () => 'city-surface-v3';
    return m;
  }

  // ------------------------------------------------------------------ signage
  _signage() {
    const map = this.tex.signs;
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    const m = new THREE.MeshStandardMaterial({
      map,
      emissiveMap: map,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.6,
      roughness: 0.55,
      metalness: 0.0,
      vertexColors: false,
      side: THREE.DoubleSide,
      envMapIntensity: 0.5,
    });
    m.name = 'city-signage';
    return m;
  }

  // ------------------------------------------------------------------ foliage
  _foliage() {
    const map = this.tex.foliage;
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    const m = new THREE.MeshStandardMaterial({
      map,
      alphaTest: 0.4,
      transparent: false,
      side: THREE.DoubleSide,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.0,
      envMapIntensity: 0.85,
    });
    m.name = 'city-foliage';
    const U = this.uniforms;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aSeed;
           uniform float uTime;
           uniform float uWind;
           varying float vLeafInst;
           varying float vLeafH;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           {
             vec4 wp = vec4(transformed, 1.0);
             #ifdef USE_INSTANCING
               wp = instanceMatrix * wp;
               vLeafInst = fract(sin(dot(instanceMatrix[3].xyz, vec3(12.9898,78.233,37.719)))*43758.5453);
             #else
               // merged ground cover: derive the identity from the clump position instead
               vLeafInst = fract(sin(dot(floor(wp.xz * 0.35), vec2(12.9898,78.233)))*43758.5453);
             #endif
             vLeafH = clamp(aSeed, 0.0, 1.0);
             wp = modelMatrix * wp;
             float ph = wp.x * 0.07 + wp.z * 0.055;
             float g = sin(uTime * 1.15 + ph) * 0.6
                     + sin(uTime * 2.31 + ph * 2.7) * 0.28
                     + sin(uTime * 4.7 + ph * 5.1) * 0.10;
             float stiff = pow(vLeafH, 1.6);
             float amp = uWind * stiff * 0.34;
             transformed.x += g * amp;
             transformed.z += g * amp * 0.62;
             transformed.y -= abs(g) * amp * 0.16;
           }`
        );

      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform vec3 uSunDir;
           uniform vec3 uSunCol;
           uniform vec3 uSkyCol;
           varying float vLeafInst;
           varying float vLeafH;`
        )
        /* ------------------------------------------------------------------ soft alpha edge
         * A binary alpha test cuts every leaf silhouette on a hard pixel boundary, which is
         * exactly the cardboard-cut-out read. Dithering the THRESHOLD instead of the alpha
         * turns that boundary into a stipple a few pixels wide that the bloom and the motion
         * blur resolve into a soft edge — and unlike alpha-to-coverage it does not need MSAA,
         * which this pipeline does not have (Settings: msaa 0). Interleaved gradient noise is
         * three instructions and has no visible tiling. */
        .replace(
          '#include <alphatest_fragment>',
          `#ifdef USE_ALPHATEST
             float aDither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
             if ( diffuseColor.a < alphaTest + (aDither - 0.5) * 0.34 ) discard;
           #endif`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           // Per-instance hue/value jitter. Two tree assets repeated across a whole city is
           // obvious the moment two of them stand side by side; shifting each one along the
           // yellow-green axis breaks the pattern for free.
           {
             float j = vLeafInst;
             diffuseColor.rgb *= vec3(0.90 + 0.22 * j, 0.94 + 0.13 * fract(j * 7.3), 0.84 + 0.26 * fract(j * 3.1));
             // canopy self-shading: the inside of a crown is darker than its lit shell
             diffuseColor.rgb *= 0.72 + 0.36 * vLeafH;
           }`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           /* ------------------------------------------------------- leaf translucency
            * A leaf is a thin scattering slab, not an opaque card. Light that reaches its far
            * side keeps travelling roughly along the incident direction, so a backlit canopy
            * glows yellow-green instead of going black — which is the single strongest cue
            * that foliage is organic. three's lighting loop has already discarded the per-light
            * vectors by this point, so the key light comes in as a uniform (CONTRACTS.md §6).
            */
           {
             vec3 Lv = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);  // travel direction
             vec3 Dv = normalize(-vViewPosition);                        // camera -> fragment
             // back-scatter lobe: peaks when you are looking down the sun's own vector
             float bs = clamp(dot(Dv, Lv), 0.0, 1.0);
             bs = bs * bs * bs;
             // wrap term so a leaf lit edge-on still transmits instead of terminating hard
             float wrap = clamp(dot(normalize(normal), -Lv) * 0.5 + 0.6, 0.0, 1.0);
             // chlorophyll filters the transmitted beam green and drops the blue
             vec3 through = diffuseColor.rgb * vec3(1.15, 1.34, 0.55);
             totalEmissiveRadiance += uSunCol * through * (bs * 1.25 + 0.09) * (0.30 + 0.70 * wrap);
             // sky fill so undersides and interiors read as shade, not as holes
             totalEmissiveRadiance += diffuseColor.rgb * uSkyCol * 0.30;
           }`
        );
    };
    m.customProgramCacheKey = () => 'city-foliage-v2';
    return m;
  }

  // ------------------------------------------------------------------ glow
  _glow() {
    const U = this.uniforms;
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: this.tex.glow },
        uTime: U.uTime,
        uNight: U.uNight,
        uGlow: U.uGlow,
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        attribute vec3 color;
        varying vec2 vUvG;
        varying vec3 vColG;
        varying float vFade;
        void main(){
          vUvG = uv;
          vColG = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float d = -mv.z;
          // Shrink as you close in so a lamp doesn't swallow the screen, grow slightly far away.
          float scale = aSeed * clamp(0.55 + d * 0.010, 0.6, 2.6);
          mv.xy += (uv - 0.5) * scale;
          vFade = smoothstep(2.0, 9.0, d) * (1.0 - smoothstep(340.0, 620.0, d));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uNight, uGlow;
        varying vec2 vUvG;
        varying vec3 vColG;
        varying float vFade;
        void main(){
          float a = texture2D(uMap, vUvG).a;
          float k = a * vFade * uGlow * (0.10 + 1.55 * uNight);
          if (k <= 0.002) discard;
          gl_FragColor = vec4(vColG * k * 2.4, k);
        }`,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      transparent: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    m.name = 'city-glow';
    return m;
  }

  /** Called once per frame from CitySystem.update(). */
  setFrame({ time, night, litFrac, wet, emissive, wind, glow, tunnelFill, sun, sky }) {
    const u = this.uniforms;
    if (sun) {
      u.uSunDir.value.copy(sun.dir);
      u.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
    }
    if (sky) u.uSkyCol.value.copy(sky.color).multiplyScalar(sky.intensity);
    u.uTime.value = time;
    u.uNight.value = night;
    u.uLitFrac.value = litFrac;
    u.uWet.value = wet;
    u.uEmissive.value = emissive;
    u.uWind.value = wind;
    u.uGlow.value = glow;
    u.uTunnelFill.value = tunnelFill ?? 0.16;
    // Shop signage brightens through dusk and stays hot at night.
    this.signage.emissiveIntensity = 0.18 + night * 1.95;
    this.surface.envMapIntensity = 1.0;
  }

  setEnvMap(envMap) {
    for (const m of [this.surface, this.signage, this.foliage]) {
      if (m.envMap !== envMap) {
        m.envMap = envMap;
        m.needsUpdate = true;
      }
    }
  }

  dispose() {
    for (const m of [this.surface, this.signage, this.foliage, this.glow, this.shadowOnly]) m.dispose();
  }
}
