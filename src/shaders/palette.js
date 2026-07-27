/**
 * Shared colour helpers for the procedural texture library.
 * Colours are authored in sRGB 0..1 (i.e. "what the hex code looks like"), because
 * bakeAlbedo() tags its output SRGBColorSpace. Data channels stay linear.
 */

/** '#rrggbb' or 0xrrggbb -> [r,g,b] in sRGB 0..1 */
export function hex(c) {
  const n = typeof c === 'string' ? parseInt(c.replace('#', ''), 16) : c;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function mixc(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Write an RGB triple into three parallel fields at index i. */
export function setRGB(R, G, B, i, c) {
  R[i] = c[0];
  G[i] = c[1];
  B[i] = c[2];
}

/** Allocate the three albedo planes at once. */
export function rgbFields(size) {
  const n = size * size;
  return [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
}

/** Fill R/G/B planes with a flat colour. */
export function fillRGB(R, G, B, c) {
  R.fill(c[0]);
  G.fill(c[1]);
  B.fill(c[2]);
}

/** Multiply all three planes by a per-texel scalar field. */
export function shadeRGB(R, G, B, f, k = 1) {
  for (let i = 0; i < R.length; i++) {
    const v = 1 + (f[i] - 1) * k;
    R[i] *= v;
    G[i] *= v;
    B[i] *= v;
  }
}

/** Lerp all three planes toward a colour by a per-texel mask. */
export function tintRGB(R, G, B, mask, c, k = 1) {
  for (let i = 0; i < R.length; i++) {
    const t = mask[i] * k;
    if (t <= 0) continue;
    const tt = t > 1 ? 1 : t;
    R[i] += (c[0] - R[i]) * tt;
    G[i] += (c[1] - G[i]) * tt;
    B[i] += (c[2] - B[i]) * tt;
  }
}

/** Add a per-texel scalar to all three planes (brightening grit / sparkle). */
export function addRGB(R, G, B, f, k = 1) {
  for (let i = 0; i < R.length; i++) {
    const v = f[i] * k;
    R[i] += v;
    G[i] += v;
    B[i] += v;
  }
}

/**
 * Perceptual colour jitter driven by a [0,1] field: shifts hue slightly warm/cool as well as
 * brightness. Flat brightness-only variation is what makes procedural surfaces look like
 * greyscale noise tinted once; real surfaces drift in hue too.
 */
export function chromaDrift(R, G, B, f, amount = 0.05) {
  for (let i = 0; i < R.length; i++) {
    const d = (f[i] - 0.5) * 2 * amount;
    R[i] *= 1 + d;
    G[i] *= 1 + d * 0.25;
    B[i] *= 1 - d * 0.7;
  }
}
