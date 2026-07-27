/**
 * Circuit geometry authoring — "Vermilion Bay Circuit".
 *
 * The layout is surveyed the way a real circuit is: a closed control polygon whose vertices are
 * filleted with exact-radius arcs, leaving exact-length straights between them. This closes by
 * construction (no spline drift, no closure residual) and — crucially — every corner has a real
 * radius, so the racing line, kerb placement and the AI's braking points have something concrete
 * to reason about. A Catmull-Rom through hand-placed points gives you none of that.
 *
 * Coordinates are XZ with +Y up. Heading phi runs so that forward = (cos phi, sin phi) in (x, z);
 * left = (sin phi, -cos phi), matching Track's `+ curvature = left` convention.
 */

const D2R = Math.PI / 180;

/* ------------------------------------------------------------------ the circuit
 * Control polygon in metres. Each vertex carries the radius its corner is filleted with, so
 * `radius` IS the corner radius — 26 m is a hairpin, 220 m is a flat-out kink.
 */
export const NODES = [
  { x: -600, z: 420, r: 95, name: 'Turn 11 — Onto The Straight' },
  { x: 250, z: 440, r: 400, name: 'Turn 1 — Vermilion Sweep' },
  { x: 560, z: 250, r: 105, name: 'Turn 2 — Harbour Right' },
  { x: 700, z: -30, r: 165, name: 'Turn 3 — Downhill Sweeper' },
  { x: 545, z: -260, r: 230, name: 'Turn 4 — The Kink' },
  { x: 235, z: -365, r: 90, name: 'Turn 5 — Basin Entry' },
  { x: -10, z: -262, r: 26, name: 'Turn 6 — Basin Hairpin' },
  { x: 96, z: -108, r: 72, name: 'Turn 7 — Banked Left' },
  { x: -330, z: 15, r: 130, name: 'Turn 8 — Tunnel Entry' },
  { x: -680, z: -110, r: 55, name: 'Turn 9 — Quarry Left' },
  { x: -800, z: 60, r: 80, name: 'Turn 10 — Banked Carousel' },
  { x: -620, z: 190, r: 120, name: 'Turn 10b — Crest Right' },
];

/** Straights long enough to matter get a name so features can find them. */
const NAMED_STRAIGHTS = {
  0: 'Start/Finish Straight', // the straight LEAVING node 0
  7: 'Tunnel Straight',
  10: 'Crest Straight',
};

/**
 * Where the start/finish line sits, in metres along the raw walk. Everything downstream works
 * in `s` measured from the line, so this is the one knob that decides which part of the circuit
 * each normalised `t` lands on — the QA shot list teleports to fixed `t` values and expects a
 * tunnel at 0.55, a corner at 0.62 and open road at 0.05.
 */
const START_OFFSET = 245;

/**
 * Elevation in metres, keyed by lap fraction. The shape of the lap in section:
 * flat pit straight -> climb to the harbour right -> a long 4% descent into the basin ->
 * hairpin at the bottom -> climb through the tunnel -> quarry -> blind crest at 30 m -> drop
 * back to the line at 6%.
 */
const ELEVATION = [
  [0.0, 0], [0.104, 3], [0.164, 8], [0.22, 10], [0.283, 6],
  [0.328, -6], [0.394, -18], [0.45, -26], [0.519, -32], [0.545, -30],
  [0.58, -22], [0.658, -2], [0.754, 12], [0.795, 20], [0.827, 30],
  [0.85, 24], [0.877, 14], [0.936, 4], [1.0, 0],
];

/** Half-width in metres, keyed by lap fraction. 4-lane street circuit that pinches in corners. */
const HALF_WIDTH = [
  [0.0, 11.0], [0.09, 10.6], [0.11, 9.8], [0.17, 9.6], [0.22, 8.8],
  [0.28, 9.6], [0.36, 9.8], [0.45, 8.6], [0.5, 8.0], [0.52, 7.2],
  [0.545, 7.2], [0.58, 6.8], [0.60, 6.8], [0.63, 8.4], [0.66, 9.2], [0.75, 8.4], [0.795, 9.0],
  [0.83, 9.4], [0.88, 9.0], [0.9, 8.8], [0.94, 10.4], [1.0, 11.0],
];

/** Extra banking (radians) layered on top of the curvature-derived bank, by lap fraction. */
const BANK_BOOST = [
  [0.0, 0], [0.535, 0], [0.552, 0.10], [0.575, 0.10], [0.592, 0],
  [0.788, 0], [0.802, 0.135], [0.822, 0.135], [0.836, 0],
  [1.0, 0],
];

/* ------------------------------------------------------------------ helpers */

function keyAt(keys, x) {
  if (x <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (x >= last[0]) return last[1];
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid][0] <= x) lo = mid;
    else hi = mid;
  }
  const [x0, y0] = keys[lo];
  const [x1, y1] = keys[hi];
  const u = (x - x0) / (x1 - x0 || 1);
  return y0 + (y1 - y0) * (u * u * (3 - 2 * u)); // smoothstep between keys — C1, no kinks
}

/** Circular box blur over a Float32Array. */
export function smoothWrap(src, r) {
  const n = src.length;
  if (r <= 0) return src.slice();
  const out = new Float32Array(n);
  let acc = 0;
  for (let d = -r; d <= r; d++) acc += src[(d + n * 2) % n];
  const inv = 1 / (r * 2 + 1);
  for (let i = 0; i < n; i++) {
    out[i] = acc * inv;
    acc += src[(i + r + 1) % n] - src[(i - r + n * 2) % n];
  }
  return out;
}

/* ------------------------------------------------------------------ fillet the polygon */

/**
 * Round every polygon vertex with an arc tangent to both adjacent edges. Radii are clamped so
 * neighbouring fillets can never eat into each other (two corners sharing a short edge get
 * their tangent lengths scaled down together, which is exactly what a track designer does when
 * a chicane is too tight for the radius they wanted).
 */
function fillet() {
  const n = NODES.length;
  const V = NODES.map((v) => [v.x, v.z]);
  const dir = [];
  const edgeLen = [];
  for (let i = 0; i < n; i++) {
    const a = V[i];
    const b = V[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const L = Math.hypot(dx, dz);
    edgeLen.push(L);
    dir.push([dx / L, dz / L]);
  }

  // turn angle and nominal tangent length at each vertex
  const turn = new Array(n);
  const tan = new Array(n);
  const radius = NODES.map((v) => v.r);
  for (let i = 0; i < n; i++) {
    const u1 = dir[(i - 1 + n) % n];
    const u2 = dir[i];
    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    const dot = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
    turn[i] = Math.atan2(cross, dot); // + = right in this (x,z) frame, see note below
    tan[i] = radius[i] * Math.tan(Math.min(Math.abs(turn[i]), Math.PI - 0.06) / 2);
  }
  // shrink radii until every edge fits both its fillets with 6 m of straight to spare
  for (let pass = 0; pass < 24; pass++) {
    let worst = 1;
    for (let i = 0; i < n; i++) {
      const need = tan[i] + tan[(i + 1) % n] + 6;
      if (need > edgeLen[i]) worst = Math.min(worst, (edgeLen[i] - 6) / (need - 6));
    }
    if (worst >= 0.999) break;
    for (let i = 0; i < n; i++) {
      const need0 = tan[(i - 1 + n) % n] + tan[i] + 6;
      const need1 = tan[i] + tan[(i + 1) % n] + 6;
      if (need0 > edgeLen[(i - 1 + n) % n] || need1 > edgeLen[i]) {
        radius[i] *= Math.max(0.35, worst);
        tan[i] = radius[i] * Math.tan(Math.min(Math.abs(turn[i]), Math.PI - 0.06) / 2);
      }
    }
  }

  return { V, dir, edgeLen, turn, tan, radius, n };
}

/** Emit the centreline polyline plus per-segment bookkeeping at roughly `step` metre spacing. */
function walk(step) {
  const { V, dir, edgeLen, turn, tan, radius, n } = fillet();
  const xs = [];
  const zs = [];
  const segs = [];
  let s = 0;

  for (let i = 0; i < n; i++) {
    // ---- straight along edge i, from the end of fillet i to the start of fillet i+1
    const a = V[i];
    const u = dir[i];
    const L = edgeLen[i] - tan[i] - tan[(i + 1) % n];
    const sx = a[0] + u[0] * tan[i];
    const sz = a[1] + u[1] * tan[i];
    const ns = Math.max(1, Math.round(L / step));
    for (let k = 0; k < ns; k++) {
      xs.push(sx + u[0] * (L * k) / ns);
      zs.push(sz + u[1] * (L * k) / ns);
    }
    segs.push({
      type: 's',
      s0: s,
      s1: s + L,
      len: L,
      curvature: 0,
      heading: Math.atan2(u[1], u[0]),
      name: NAMED_STRAIGHTS[i],
    });
    s += L;

    // ---- fillet at vertex i+1
    const j = (i + 1) % n;
    const th = Math.abs(turn[j]);
    if (th < 1e-4) continue;
    // `turn` positive means the heading angle phi increases => a RIGHT turn in our convention,
    // so track curvature (+ = left) is the opposite sign.
    const sgn = Math.sign(turn[j]);
    const R = radius[j];
    const u1 = dir[i];
    const u2 = dir[j];
    const px = V[j][0] - u1[0] * tan[j];
    const pz = V[j][1] - u1[1] * tan[j];
    // centre sits on the side we are turning toward: normal (-u1z, u1x) rotated by sgn
    const cx = px + sgn * -u1[1] * R;
    const cz = pz + sgn * u1[0] * R;
    const rx = px - cx;
    const rz = pz - cz;
    const arcLen = R * th;
    const na = Math.max(2, Math.round(arcLen / step));
    for (let k = 0; k < na; k++) {
      const b = sgn * (th * k) / na;
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      xs.push(cx + rx * cb - rz * sb);
      zs.push(cz + rx * sb + rz * cb);
    }
    segs.push({
      type: 'c',
      s0: s,
      s1: s + arcLen,
      len: arcLen,
      radius: R,
      angle: (-sgn * th) / D2R,
      curvature: -sgn / R,
      name: NODES[j].name,
    });
    s += arcLen;
    void u2;
  }
  return { xs, zs, segs, length: s };
}

/* ------------------------------------------------------------------ public build */

/**
 * @returns {{
 *   pos: Float32Array,      // xyz, uniform ~`step` arc spacing, closed (no duplicate end point)
 *   count: number,
 *   length: number,
 *   widthOf: (s:number)=>number,
 *   bankBoostOf: (s:number)=>number,
 *   segments: object[],
 *   corners: object[],
 *   features: object,
 * }}
 */
export function buildCircuit(step = 1.0) {
  const w = walk(step);
  const n = w.xs.length;
  const L = w.length;

  // Resample to exactly uniform arc length so `t` === s / length everywhere. The turtle already
  // emits near-uniform spacing, but arcs round their subdivision count, so tidy it up.
  const cum = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const a = (i - 1) % n;
    const b = i % n;
    cum[i] = cum[i - 1] + Math.hypot(w.xs[b] - w.xs[a], w.zs[b] - w.zs[a]);
  }
  const total = cum[n];
  const N = Math.max(512, Math.round(total / step));
  const pos = new Float32Array(N * 3);
  let cursor = 0;
  for (let i = 0; i < N; i++) {
    // START_OFFSET rotates the arc-length origin onto the start/finish line.
    const target = (((i / N) * total + START_OFFSET) % total + total) % total;
    while (cursor > 0 && cum[cursor] > target) cursor--;
    while (cursor < n - 1 && cum[cursor + 1] < target) cursor++;
    const a = cursor % n;
    const b = (cursor + 1) % n;
    const seg = cum[cursor + 1] - cum[cursor] || 1;
    const u = (target - cum[cursor]) / seg;
    pos[i * 3] = w.xs[a] + (w.xs[b] - w.xs[a]) * u;
    pos[i * 3 + 2] = w.zs[a] + (w.zs[b] - w.zs[a]) * u;
  }

  // Elevation — keyed on lap fraction, then smoothed so gradients are C1 and the crest is a
  // crest rather than a corner.
  const yRaw = new Float32Array(N);
  for (let i = 0; i < N; i++) yRaw[i] = keyAt(ELEVATION, i / N);
  const ySm = smoothWrap(smoothWrap(yRaw, Math.round(N * 0.012)), Math.round(N * 0.008));
  for (let i = 0; i < N; i++) pos[i * 3 + 1] = ySm[i];

  // Recentre so the circuit straddles the origin (the city lane and shot 06 both assume it).
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < N; i++) {
    cx += pos[i * 3];
    cz += pos[i * 3 + 2];
  }
  cx /= N;
  cz /= N;
  for (let i = 0; i < N; i++) {
    pos[i * 3] -= cx;
    pos[i * 3 + 2] -= cz;
  }

  // Re-key segment bookkeeping to the start/finish line, then rotate the list so it reads in
  // driving order from the grid.
  const shift = (v) => ((v - START_OFFSET) % L + L) % L;
  const segments = w.segs
    .map((sg) => {
      const s0 = shift(sg.s0);
      return { ...sg, s0, s1: s0 + sg.len, f0: s0 / L, f1: (s0 + sg.len) / L };
    })
    .sort((a, b) => a.s0 - b.s0);
  const corners = segments.filter((sg) => sg.type === 'c');

  const features = buildFeatures(segments, L);

  return {
    pos,
    count: N,
    length: total,
    step: total / N,
    widthOf: (s) => keyAt(HALF_WIDTH, ((s / L) % 1 + 1) % 1),
    bankBoostOf: (s) => keyAt(BANK_BOOST, ((s / L) % 1 + 1) % 1),
    segments,
    corners,
    features,
    lapLength: L,
  };
}

/**
 * Where kerbs, run-off, tunnels and signage go. Kerbs are placed the way they are on a real
 * circuit: inside from turn-in to apex, outside from apex to track-out, and NOT on straights.
 */
function buildFeatures(segments, L) {
  const kerbs = [];
  const runoff = [];
  const tunnels = [];
  const boards = [];
  const gridBox = { s0: -14, s1: 6 };

  // The tunnel bores through the hillside from halfway round the banked left, so you enter it
  // still leaned over and the exit opens onto a climbing straight — Monaco, not a shoebox.
  const banked = segments.find((s) => s.name === 'Turn 7 — Banked Left');
  const tunnelSeg = segments.find((s) => s.name === 'Tunnel Straight');
  if (banked && tunnelSeg) tunnels.push({ s0: banked.s0 - 12, s1: tunnelSeg.s0 + 142 });

  // Concrete instead of armco where the circuit runs through the built-up part of town: the
  // pit straight and the tunnel approach. Everywhere else gets steel, as at a real venue.
  const walls = [];
  const pit = segments.find((s) => s.name === 'Start/Finish Straight');
  if (pit) walls.push({ s0: pit.s0 - 40, s1: pit.s1 + 60 });
  for (const t of tunnels) walls.push({ s0: t.s0 - 45, s1: t.s1 + 45 });

  for (const c of segments) {
    if (c.type !== 'c') continue;
    const inside = c.angle > 0 ? -1 : 1; // -1 = left side of the road
    const tight = c.radius < 90;
    const len = c.len;

    // Inner kerb: a little before turn-in through past the apex.
    kerbs.push({
      s0: c.s0 + len * 0.1,
      s1: c.s0 + len * (tight ? 0.95 : 0.8),
      side: inside,
      height: tight ? 0.075 : 0.055,
      width: tight ? 1.15 : 0.9,
      style: tight ? 'redwhite' : 'bluewhite',
    });
    // Exit kerb on the outside, running out onto the following straight.
    kerbs.push({
      s0: c.s0 + len * 0.62,
      s1: c.s1 + Math.min(48, len * 0.55),
      side: -inside,
      height: 0.05,
      width: 0.8,
      style: 'redwhite',
    });

    // Run-off: gravel on the outside of anything quick, grass elsewhere.
    const fast = c.radius >= 100;
    runoff.push({
      s0: c.s0 - 30,
      s1: c.s1 + 60,
      side: -inside,
      type: fast ? 'gravel' : 'grass',
      width: fast ? 22 : 12,
    });

    // Braking boards on the approach to anything you actually have to brake for.
    if (c.radius < 130) {
      for (const d of [200, 150, 100, 50]) {
        const s = (c.s0 - d + L) % L;
        boards.push({ s, side: -inside, distance: d });
      }
    }
  }

  return { kerbs, runoff, tunnels, boards, gridBox, walls };
}

/** Rasterise the feature lists into per-sample arrays the mesh builder and sampleGround share. */
export function rasteriseFeatures(features, N, L) {
  const kerbL = new Float32Array(N); // 0 = none, else kerb height in metres
  const kerbR = new Float32Array(N);
  const kerbWL = new Float32Array(N);
  const kerbWR = new Float32Array(N);
  const kerbStyle = new Float32Array(N); // 0 red/white, 1 blue/white
  const runoffW = new Float32Array(N * 2); // [left, right] metres
  const runoffType = new Float32Array(N * 2); // 0 grass, 1 gravel
  const tunnel = new Float32Array(N);
  const wall = new Float32Array(N);

  const idx = (s) => {
    let i = Math.round((s / L) * N);
    i %= N;
    if (i < 0) i += N;
    return i;
  };
  const span = (s0, s1, fn) => {
    const i0 = idx(s0);
    let steps = Math.round(((s1 - s0 + L * 2) % L) / (L / N));
    steps = Math.max(1, Math.min(N - 1, steps));
    for (let k = 0; k <= steps; k++) {
      const i = (i0 + k) % N;
      // fade the ends so kerbs ramp in/out rather than popping
      const e = Math.min(k, steps - k) / Math.max(1, Math.min(8, steps * 0.5));
      fn(i, Math.min(1, e));
    }
  };

  runoffW.fill(6.5);
  for (const k of features.kerbs) {
    const H = k.side < 0 ? kerbL : kerbR;
    const W = k.side < 0 ? kerbWL : kerbWR;
    span(k.s0, k.s1, (i, e) => {
      const h = k.height * e;
      if (h > H[i]) {
        H[i] = h;
        W[i] = k.width;
        kerbStyle[i] = k.style === 'bluewhite' ? 1 : 0;
      }
    });
  }
  for (const r of features.runoff) {
    const o = r.side < 0 ? 0 : 1;
    span(r.s0, r.s1, (i, e) => {
      const v = 9 + (r.width - 9) * e;
      if (v > runoffW[i * 2 + o]) {
        runoffW[i * 2 + o] = v;
        runoffType[i * 2 + o] = r.type === 'gravel' ? 1 : 0;
      }
    });
  }
  for (const w of features.walls || []) span(w.s0, w.s1, (i) => (wall[i] = 1));
  for (const t of features.tunnels) {
    // Inside the bore there is no run-off: the wall is right there, which is the whole point.
    span(t.s0 - 26, t.s1 + 26, (i, e) => {
      const squeeze = 6.5 - 5.7 * e;
      runoffW[i * 2] = Math.min(runoffW[i * 2], squeeze);
      runoffW[i * 2 + 1] = Math.min(runoffW[i * 2 + 1], squeeze);
    });
    span(t.s0, t.s1, (i, e) => (tunnel[i] = Math.max(tunnel[i], e)));
  }

  return {
    kerbL: smoothWrap(kerbL, 2),
    kerbR: smoothWrap(kerbR, 2),
    kerbWL: smoothWrap(kerbWL, 2),
    kerbWR: smoothWrap(kerbWR, 2),
    kerbStyle,
    runoffW,
    runoffType,
    tunnel,
    wall,
  };
}
