/**
 * NEED FOR TOKENS — the logotype.
 *
 * No web fonts are permitted (CONTRACTS.md §0: zero downloads), so the wordmark is drawn from a
 * purpose-built modular stencil alphabet: every glyph is a set of polylines on a 7.2 x 10 unit
 * grid, rendered as a heavy monoline stroke with 45-degree chamfered corners. Uniform stroke
 * weight + chamfers = motorsport signage, and because it is SVG it is razor sharp from 720p to 4K
 * and can be animated (stroke-dashoffset draw-on, per-letter stagger) for free.
 *
 * Only the letters the brand needs exist. This is a logotype, not a typeface.
 */

// ---- grid ------------------------------------------------------------------
const SW = 2.1; // stroke weight
const HW = SW / 2; // half — stems sit on the centreline so ink lands on the grid edge
const L = HW; //  left stem centreline           x
const R = 7.2 - HW; //  right stem centreline
const XL = 0; //  bar left extent (butt cap)
const XR = 7.2; //  bar right extent
const T = HW; //  cap line centreline            y
const B = 10 - HW; //  base line centreline
const MY = 4.78; //  optical middle (a touch high)
const MX = 3.6; //  horizontal middle
const C = 1.85; //  chamfer
const ADV = 8.0; //  advance width

/** Each glyph is an array of polylines; each polyline an array of [x, y] on the grid above. */
const GLYPHS = {
  N: [[[L, B], [L, T], [R, B], [R, T]]],
  E: [
    [[L, T], [L, B]],
    [[XL, T], [XR, T]],
    [[XL, MY], [XR - 1.35, MY]],
    [[XL, B], [XR, B]],
  ],
  D: [[[L, T], [R - C, T], [R, T + C], [R, B - C], [R - C, B], [L, B], [L, T]]],
  F: [
    [[L, T], [L, B]],
    [[XL, T], [XR, T]],
    [[XL, MY], [XR - 1.35, MY]],
  ],
  O: [
    [
      [L + C, T], [R - C, T], [R, T + C], [R, B - C],
      [R - C, B], [L + C, B], [L, B - C], [L, T + C], [L + C, T],
    ],
  ],
  R: [
    [[L, B], [L, T], [R - C, T], [R, T + C], [R, MY - C * 0.6], [R - C * 0.6, MY], [L, MY]],
    [[MX - 0.35, MY], [R, B]],
  ],
  T: [
    [[XL, T], [XR, T]],
    [[MX, T], [MX, B]],
  ],
  K: [
    [[L, T], [L, B]],
    [[R, T], [L + 0.5, MY + 0.62]],
    [[L + 1.42, MY - 0.12], [R, B]],
  ],
  S: [
    [
      [R, T + C * 0.85], [R - C * 0.85, T], [L + C * 0.85, T], [L, T + C * 0.85],
      [L, MY - C * 0.55], [L + C * 0.55, MY], [R - C * 0.55, MY], [R, MY + C * 0.55],
      [R, B - C * 0.85], [R - C * 0.85, B], [L + C * 0.85, B], [L, B - C * 0.85],
    ],
  ],
};

const n = (v) => (Math.round(v * 100) / 100).toString();

/** One `d` string per letter, laid out left to right. -> { paths: [{d, x}], width } */
function layout(text, tracking = 0) {
  const paths = [];
  let x = 0;
  for (const ch of text) {
    if (ch === ' ') {
      x += ADV * 0.52 + tracking;
      continue;
    }
    const g = GLYPHS[ch];
    if (!g) {
      x += ADV + tracking;
      continue;
    }
    let d = '';
    for (const line of g) {
      for (let i = 0; i < line.length; i++) {
        d += `${i ? 'L' : 'M'}${n(line[i][0] + x)} ${n(line[i][1])}`;
      }
    }
    paths.push({ d, x });
    x += ADV + tracking;
  }
  return { paths, width: Math.max(0, x - tracking - (ADV - XR)) };
}

/**
 * The full stacked lockup.
 *   NEED FOR   — kicker, tracked wide, flanked by hairlines
 *   TOKENS     — hero
 * `id` namespaces the gradient defs so several instances can coexist.
 */
export function wordmarkSvg(id = 'lg', opts = {}) {
  const { kicker = 'NEED FOR', hero = 'TOKENS', kickerTrack = 5.4, heroTrack = 0.9 } = opts;

  const k = layout(kicker, kickerTrack);
  const h = layout(hero, heroTrack);
  const KS = 0.315; // kicker scale relative to hero cap height
  const kw = k.width * KS;
  const gap = 4.6; // vertical gap between rows (hero units)
  const kh = 10 * KS;

  const W = Math.max(kw, h.width);
  const H = kh + gap + 10;
  const pad = 2.4;

  // kicker is optically centred on the hero row
  const kx = (W - kw) / 2;

  const rule = (x1, x2, y) =>
    `<line class="lg-rule" x1="${n(x1)}" y1="${n(y)}" x2="${n(x2)}" y2="${n(y)}"/>`;

  let out = `<svg class="lg" viewBox="${-pad} ${-pad} ${n(W + pad * 2)} ${n(H + pad * 2)}" `;
  out += `preserveAspectRatio="xMidYMid meet" aria-label="${kicker} ${hero}" role="img">`;
  out += `<defs>
    <linearGradient id="${id}-hero" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0"   stop-color="#ffffff"/>
      <stop offset="0.6" stop-color="#eef3f8"/>
      <stop offset="1"   stop-color="#b6c4d3"/>
    </linearGradient>
    <linearGradient id="${id}-slash" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="var(--sig)" stop-opacity="0"/>
      <stop offset="0.35" stop-color="var(--sig)"/>
      <stop offset="1" stop-color="var(--sig-hot)"/>
    </linearGradient>
  </defs>`;

  // --- kicker row ---------------------------------------------------------
  out += `<g class="lg-kicker" transform="translate(${n(kx)} 0) scale(${KS})">`;
  for (let i = 0; i < k.paths.length; i++) {
    out += `<path class="lg-k" pathLength="100" style="--i:${i}" d="${k.paths[i].d}"/>`;
  }
  out += `</g>`;
  const ky = kh / 2;
  const railGap = 3.2;
  if (kx > railGap * 2) {
    out += `<g class="lg-rails">${rule(0, kx - railGap, ky)}${rule(kx + kw + railGap, W, ky)}</g>`;
  }

  // --- hero row -----------------------------------------------------------
  const hy = kh + gap;
  out += `<g class="lg-hero" transform="translate(${n((W - h.width) / 2)} ${n(hy)})">`;
  // hazard slash sweeping through the baseline
  out += `<path class="lg-slash" pathLength="100" d="M${n(-pad)} ${n(10 + 2.0)}L${n(
    h.width * 0.46
  )} ${n(10 + 2.0)}L${n(h.width * 0.46 + 2.6)} ${n(10 + 0.55)}L${n(h.width + pad)} ${n(
    10 + 0.55
  )}" fill="none"/>`;
  for (let i = 0; i < h.paths.length; i++) {
    out += `<path class="lg-h" pathLength="100" style="--i:${i}" stroke="url(#${id}-hero)" d="${h.paths[i].d}"/>`;
  }
  out += `</g>`;
  out += `</svg>`;
  return out;
}

/** Compact single-row mark for corners / pause header. */
export function markSvg(text = 'NFT', opts = {}) {
  const { tracking = 1.4 } = opts;
  const m = layout(text, tracking);
  const pad = 1.6;
  let out = `<svg class="lg lg--mark" viewBox="${-pad} ${-pad} ${n(m.width + pad * 2)} ${n(
    10 + pad * 2
  )}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${text}">`;
  for (const p of m.paths) out += `<path class="lg-h" d="${p.d}"/>`;
  out += `</svg>`;
  return out;
}

export const LOGO_STROKE = SW;
