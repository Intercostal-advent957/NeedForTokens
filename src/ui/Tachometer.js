/**
 * The instrument ring: a 250-degree tachometer that sweeps with engine speed, with a baked
 * warning/redline band, an engraved tick scale, a sequential shift-light strip and the hero speed
 * readout in the middle.
 *
 * There are deliberately no rpm numerals on the dial. At 300 km/h nobody reads "6" off a gauge —
 * the shift strip and the gear plate carry that information, and removing the numbers stops them
 * colliding with the one number that actually matters.
 *
 * All geometry is generated once as markup. Per frame the only writes are
 * `style.strokeDashoffset`, `style.transform`, `style.opacity` and `textContent`.
 */

const CX = 150;
const CY = 172;
const R_TRACK = 116;
const A0 = 145; // degrees, SVG convention (0 = +x, 90 = down)
const A1 = 395;
const SWEEP = A1 - A0;

const rad = (d) => (d * Math.PI) / 180;
const px = (r, a) => CX + r * Math.cos(rad(a));
const py = (r, a) => CY + r * Math.sin(rad(a));
const n = (v) => (Math.round(v * 100) / 100).toString();

function arc(r, f0, f1) {
  const a0 = A0 + SWEEP * f0;
  const a1 = A0 + SWEEP * f1;
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M${n(px(r, a0))} ${n(py(r, a0))}A${n(r)} ${n(r)} 0 ${large} 1 ${n(px(r, a1))} ${n(
    py(r, a1)
  )}`;
}

export function tachSvg(o = {}) {
  const warn = o.warn ?? 0.78;
  const red = o.red ?? 0.925;
  const maxRpm = o.maxRpm ?? 9000;
  const minRpm = o.minRpm ?? 0;
  const span = Math.max(1, maxRpm - minRpm);

  // tick scale, engraved inside the band
  let ticks = '';
  const step = span > 9000 ? 1000 : 500;
  const first = Math.ceil(minRpm / step) * step;
  for (let rpm = first; rpm <= maxRpm + 1; rpm += step) {
    const f = (rpm - minRpm) / span;
    if (f > 1.0001) break;
    const a = A0 + SWEEP * f;
    const major = rpm % (step * 2) === 0;
    const r0 = R_TRACK - 10;
    const r1 = major ? R_TRACK - 26 : R_TRACK - 19;
    ticks += `<line class="tk${major ? ' tk--maj' : ''}${f >= red ? ' tk--red' : ''}" x1="${n(
      px(r0, a)
    )}" y1="${n(py(r0, a))}" x2="${n(px(r1, a))}" y2="${n(py(r1, a))}"/>`;
  }

  // sequential shift strip — a steering-wheel LED bar, read with peripheral vision
  let shift = '';
  const SN = 7;
  const SWD = 22;
  const SGAP = 4;
  const stripW = SN * SWD + (SN - 1) * SGAP;
  const x0 = CX - stripW / 2;
  for (let i = 0; i < SN; i++) {
    const x = x0 + i * (SWD + SGAP);
    shift +=
      `<g class="sl"><path d="M${n(x + 5)} 6L${n(x + SWD)} 6L${n(x + SWD - 5)} 24L${n(x)} 24Z"/></g>`;
  }

  return `<svg class="tach" viewBox="0 0 300 330" preserveAspectRatio="xMidYMid meet">
  <defs>
    <radialGradient id="tach-scrim" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0"    stop-color="#02040a" stop-opacity="0.5"/>
      <stop offset="0.42" stop-color="#02040a" stop-opacity="0.44"/>
      <stop offset="0.68" stop-color="#02040a" stop-opacity="0.26"/>
      <stop offset="0.86" stop-color="#02040a" stop-opacity="0.09"/>
      <stop offset="1"    stop-color="#02040a" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <circle class="tach-scrim" cx="${CX}" cy="${CY}" r="182" fill="url(#tach-scrim)"/>

  <g class="tach-shift">${shift}</g>

  <path class="tach-case"  d="${arc(R_TRACK, 0, 1)}"/>
  <path class="tach-track" d="${arc(R_TRACK, 0, 1)}"/>
  <path class="tach-band tach-band--warn" d="${arc(R_TRACK, warn, red)}"/>
  <path class="tach-band tach-band--red"  d="${arc(R_TRACK, red, 1)}"/>
  <g class="tach-ticks">${ticks}</g>
  <path class="tach-sweep" id="tach-sweep-path" d="${arc(R_TRACK, 0, 1)}"/>
  <g class="tach-head" id="tach-head"><circle r="6"/></g>

  <text class="tach-speed" id="hud-kmh" x="${CX}" y="${CY + 30}">0</text>
  <text class="tach-unit"  x="${CX}" y="${CY + 60}">KM/H</text>

  <g class="tach-gearplate" transform="translate(${CX} ${CY + 116})">
    <path class="gp-bg"   d="M-40 -24L33 -24L40 -7L40 24L-33 24L-40 7Z"/>
    <path class="gp-edge" d="M-40 -24L33 -24L40 -7L40 24L-33 24L-40 7Z"/>
    <text class="tach-gear" id="hud-gear" x="0" y="18">1</text>
  </g>
</svg>`;
}

/** Position of the sweep head at fraction f — written into a caller-owned object. */
export function headAt(f, out) {
  const a = A0 + SWEEP * f;
  out.x = px(R_TRACK, a);
  out.y = py(R_TRACK, a);
  return out;
}
