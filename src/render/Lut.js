import * as THREE from 'three';

/**
 * Procedural 3D colour LUT, baked to a 32x32x32 volume laid out as a 1024x32 2D strip.
 *
 * Everything in the game is generated at runtime (CONTRACTS §0) so there is no .cube file to load —
 * instead each time-of-day preset owns a small parameter block (white balance, lift/gamma/gain,
 * contrast pivot, film toe/shoulder, saturation, split toning) and we evaluate it over the cube.
 * One texture fetch at runtime replaces a dozen shader ops, and — more importantly — it means the
 * *look* is data, so the env lane's preset changes drive the grade for free.
 *
 * The LUT is authored in sRGB (display) space, which is where 32 steps per axis is plenty; in
 * linear space the same 32 steps would band badly in the shadows.
 */
export const LUT_SIZE = 32;

/** @typedef {ReturnType<typeof neutralLook>} Look */

export function neutralLook() {
  return {
    exposure: 1.0,
    wb: [1, 1, 1], // linear channel gains
    lift: [0, 0, 0],
    gamma: [1, 1, 1],
    gain: [1, 1, 1],
    contrast: 1.0,
    pivot: 0.42,
    toe: 0.0,
    shoulder: 0.0,
    saturation: 1.0,
    shadowTint: [0, 0, 0],
    highTint: [0, 0, 0],
    split: 0.0,
    /** extra saturation applied only to already-saturated pixels — makes neon pop without
     *  turning skin/asphalt into a cartoon */
    vibrance: 0.0,
  };
}

/**
 * Per-preset looks. Deliberately restrained — this sits on top of a physically lit frame, the job
 * is to give each hour a memory colour, not to repaint it.
 */
export const LOOKS = {
  goldenHour: {
    ...neutralLook(),
    wb: [1.045, 1.0, 0.935],
    lift: [0.012, 0.006, -0.004],
    gain: [1.02, 1.0, 0.97],
    gamma: [1.0, 1.0, 1.02],
    contrast: 1.05,
    pivot: 0.44,
    toe: 0.1,
    shoulder: 0.16,
    saturation: 1.06,
    shadowTint: [-0.012, -0.004, 0.028],
    highTint: [0.03, 0.012, -0.018],
    split: 1.0,
    vibrance: 0.12,
  },
  noon: {
    ...neutralLook(),
    wb: [1.005, 1.0, 1.005],
    contrast: 1.1,
    pivot: 0.43,
    toe: 0.14,
    shoulder: 0.1,
    saturation: 1.04,
    shadowTint: [-0.008, -0.002, 0.016],
    highTint: [0.008, 0.006, -0.004],
    split: 1.0,
    vibrance: 0.1,
  },
  dusk: {
    ...neutralLook(),
    wb: [1.02, 0.995, 1.05],
    lift: [0.006, 0.002, 0.016],
    gain: [1.0, 0.985, 1.03],
    contrast: 1.08,
    pivot: 0.4,
    toe: 0.12,
    shoulder: 0.14,
    saturation: 1.1,
    shadowTint: [-0.006, -0.008, 0.03],
    highTint: [0.034, 0.004, 0.014],
    split: 1.0,
    vibrance: 0.16,
  },
  night: {
    ...neutralLook(),
    wb: [0.955, 0.985, 1.08],
    lift: [-0.014, -0.012, -0.002],
    gain: [1.0, 1.0, 1.045],
    gamma: [1.02, 1.01, 0.98],
    contrast: 1.16,
    pivot: 0.33,
    toe: 0.26,
    shoulder: 0.06,
    saturation: 1.1,
    shadowTint: [-0.01, -0.004, 0.026],
    highTint: [0.01, 0.0, 0.014],
    split: 1.0,
    vibrance: 0.3,
  },
  overcast: {
    ...neutralLook(),
    wb: [0.99, 1.0, 1.02],
    contrast: 1.04,
    pivot: 0.45,
    toe: 0.08,
    shoulder: 0.1,
    saturation: 0.94,
    shadowTint: [-0.004, 0.0, 0.012],
    highTint: [0.004, 0.004, 0.006],
    split: 1.0,
    vibrance: 0.06,
  },
  stormy: {
    ...neutralLook(),
    wb: [0.955, 0.995, 1.055],
    lift: [-0.006, -0.002, 0.004],
    contrast: 1.14,
    pivot: 0.38,
    toe: 0.2,
    shoulder: 0.08,
    saturation: 0.86,
    shadowTint: [-0.008, 0.002, 0.02],
    highTint: [0.0, 0.006, 0.014],
    split: 1.0,
    vibrance: 0.08,
  },
};

const KEYS = Object.keys(neutralLook());

export function lerpLook(out, a, b, t) {
  for (const k of KEYS) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (Array.isArray(av)) {
      const o = out[k] || (out[k] = [0, 0, 0]);
      for (let i = 0; i < 3; i++) o[i] = av[i] + (bv[i] - av[i]) * t;
    } else {
      out[k] = av + (bv - av) * t;
    }
  }
  return out;
}

export function lookDistance(a, b) {
  let d = 0;
  for (const k of KEYS) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (Array.isArray(av)) for (let i = 0; i < 3; i++) d += Math.abs(av[i] - bv[i]);
    else d += Math.abs(av - bv);
  }
  return d;
}

const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0, e1, x) => {
  const t = sat((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/**
 * Filmic toe + shoulder on a 0..1 display signal. Both terms are strictly monotone and pinned at
 * 0 and 1, so the LUT can never invert or clip — a non-monotone grade produces posterised bands
 * that are almost impossible to diagnose later.
 */
function filmic(x, toe, shoulder) {
  let v = sat(x);
  if (toe > 0) v = Math.pow(v, 1 + toe * 0.55); // deepen the bottom
  if (shoulder > 0) v = 1 - Math.pow(1 - v, 1 + shoulder * 0.6); // roll the top
  return sat(v);
}

const _rgb = [0, 0, 0];

export function applyLook(r, g, b, P, out = _rgb) {
  // --- linear-light section: white balance + exposure trim ---------------------------------
  let lr = s2l(r) * P.wb[0] * P.exposure;
  let lg = s2l(g) * P.wb[1] * P.exposure;
  let lb = s2l(b) * P.wb[2] * P.exposure;

  // --- display-referred section ------------------------------------------------------------
  let dr = l2s(Math.max(lr, 0));
  let dg = l2s(Math.max(lg, 0));
  let db = l2s(Math.max(lb, 0));

  dr = Math.pow(Math.max(dr * P.gain[0] + P.lift[0], 0), 1 / P.gamma[0]);
  dg = Math.pow(Math.max(dg * P.gain[1] + P.lift[1], 0), 1 / P.gamma[1]);
  db = Math.pow(Math.max(db * P.gain[2] + P.lift[2], 0), 1 / P.gamma[2]);

  dr = P.pivot + (dr - P.pivot) * P.contrast;
  dg = P.pivot + (dg - P.pivot) * P.contrast;
  db = P.pivot + (db - P.pivot) * P.contrast;

  dr = filmic(sat(dr), P.toe, P.shoulder);
  dg = filmic(sat(dg), P.toe, P.shoulder);
  db = filmic(sat(db), P.toe, P.shoulder);

  // --- saturation + vibrance ---------------------------------------------------------------
  const y = 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
  const mx = Math.max(dr, Math.max(dg, db));
  const mn = Math.min(dr, Math.min(dg, db));
  const chroma = mx - mn;
  const s = P.saturation + P.vibrance * smooth(0.04, 0.5, chroma);
  dr = y + (dr - y) * s;
  dg = y + (dg - y) * s;
  db = y + (db - y) * s;

  // --- split toning --------------------------------------------------------------------------
  const y2 = sat(0.2126 * dr + 0.7152 * dg + 0.0722 * db);
  const wS = 1 - smooth(0.0, 0.55, y2);
  const wH = smooth(0.42, 1.0, y2);
  dr += (P.shadowTint[0] * wS + P.highTint[0] * wH) * P.split;
  dg += (P.shadowTint[1] * wS + P.highTint[1] * wH) * P.split;
  db += (P.shadowTint[2] * wS + P.highTint[2] * wH) * P.split;

  out[0] = sat(dr);
  out[1] = sat(dg);
  out[2] = sat(db);
  return out;
}

export function makeLutTexture() {
  const n = LUT_SIZE;
  const data = new Uint8Array(n * n * n * 4);
  const tex = new THREE.DataTexture(data, n * n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'grade-lut';
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Rewrites `tex`'s pixels in place. ~1 ms for 32^3 — only call when the look actually moves. */
export function bakeLut(tex, look) {
  const n = LUT_SIZE;
  const inv = 1 / (n - 1);
  const data = tex.image.data;
  const rowStride = n * n * 4;
  const o = [0, 0, 0];
  for (let bz = 0; bz < n; bz++) {
    const b = bz * inv;
    const xBase = bz * n;
    for (let gy = 0; gy < n; gy++) {
      const g = gy * inv;
      const row = gy * rowStride;
      for (let rx = 0; rx < n; rx++) {
        applyLook(rx * inv, g, b, look, o);
        const i = row + (xBase + rx) * 4;
        data[i] = (o[0] * 255 + 0.5) | 0;
        data[i + 1] = (o[1] * 255 + 0.5) | 0;
        data[i + 2] = (o[2] * 255 + 0.5) | 0;
        data[i + 3] = 255;
      }
    }
  }
  tex.needsUpdate = true;
}

/** GLSL side of the strip layout above. */
export const LUT_GLSL = /* glsl */ `
  vec3 sampleLut(sampler2D lut, vec3 c, float n) {
    c = clamp(c, 0.0, 1.0);
    float sliceSize = 1.0 / n;
    float slicePixel = sliceSize / n;
    float sliceInner = slicePixel * (n - 1.0);
    float z = c.b * n;
    float z0 = min(floor(z), n - 1.0);
    float z1 = min(z0 + 1.0, n - 1.0);
    float xo = slicePixel * 0.5 + c.r * sliceInner;
    float y = 0.5 / n + c.g * ((n - 1.0) / n);
    vec3 s0 = texture2D(lut, vec2(xo + z0 * sliceSize, y)).rgb;
    vec3 s1 = texture2D(lut, vec2(xo + z1 * sliceSize, y)).rgb;
    return mix(s0, s1, fract(z));
  }
`;
