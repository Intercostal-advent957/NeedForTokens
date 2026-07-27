/**
 * Static screen markup. Every one of these runs on `setScreen()` / roster change — never in
 * `update()`. Building a string here is fine; building one at 60 Hz is not.
 */
import { wordmarkSvg, markSvg } from './Logotype.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const PAINTS = [
  ['#D8232A', 'INFERNO'],
  ['#F0630D', 'EMBER'],
  ['#F5C451', 'BULLION'],
  ['#B7F03C', 'ACID'],
  ['#2FCB74', 'VIPER'],
  ['#25E0D0', 'CYAN'],
  ['#2C7BE5', 'AZURE'],
  ['#6C4CE0', 'VIOLET'],
  ['#EDF1F6', 'ALABASTER'],
  ['#14171D', 'MIDNIGHT'],
];

// ---------------------------------------------------------------- menu
export function menuMarkup(defs = []) {
  const items = [
    ['race', 'QUICK RACE', 'GRID START · 3 LAPS · DUSK'],
    ['garage', 'GARAGE', 'CHOOSE MACHINE AND LIVERY'],
    ['settings', 'SETTINGS', 'RENDER TIER · CAMERA · TELEMETRY'],
  ];
  let nav = '';
  items.forEach(([k, label, sub], i) => {
    nav +=
      `<button class="nav-row" data-act="${k}" style="--i:${i}">` +
      `<span class="nav-idx">${String(i + 1).padStart(2, '0')}</span>` +
      `<span class="nav-body"><b>${label}</b><i>${sub}</i></span>` +
      `<span class="nav-arrow"></span></button>`;
  });

  const d = defs[0];
  const card = d
    ? `<div class="menu-car">
        <div class="menu-car-head"><i>YOUR MACHINE</i><span class="rule"></span><span class="chip chip--${esc(
          d.class || 'B'
        )}">CLASS ${esc(d.class || 'B')}</span></div>
        <div class="menu-car-name"><i>${esc(d.brand)}</i><b>${esc(d.name)}</b></div>
        <div class="menu-car-stats">
          <span><i>POWER</i><b>${d.power}<u>HP</u></b></span>
          <span><i>MASS</i><b>${d.mass}<u>KG</u></b></span>
          <span><i>DRIVE</i><b>${esc((d.drivetrain || '').toUpperCase())}</b></span>
          <span><i>REDLINE</i><b>${d.redline}</b></span>
        </div>
      </div>`
    : '';

  return `
  <div class="menu-scrim"></div>
  <div class="menu-grid" aria-hidden="true"></div>
  <div class="menu-inner">
    <div class="menu-col">
      <header class="menu-head">
        <div class="menu-eyebrow"><span class="tag tag--sig">CIRCUIT SERIES</span><span class="rule"></span><span class="mono">v1.0 · BUILD 0x5EED</span></div>
        <div class="menu-logo">${wordmarkSvg('menu')}</div>
        <p class="menu-strap">Eight cars. Three laps. One line that matters.</p>
      </header>
      <nav class="menu-nav">${nav}</nav>
      ${card}
    </div>
    <footer class="menu-foot">
      <div class="menu-facts">
        <div class="fact"><i>CIRCUIT</i><b id="menu-circuit">HARBOUR MILE</b></div>
        <div class="fact"><i>LAPS</i><b id="menu-laps">3</b></div>
        <div class="fact"><i>GRID</i><b id="menu-grid">8</b></div>
        <div class="fact"><i>CONDITIONS</i><b id="menu-cond">DUSK · DRY</b></div>
      </div>
      <div class="menu-prompt"><kbd>ENTER</kbd> START <span class="dot"></span> <kbd>↑↓</kbd> SELECT</div>
    </footer>
  </div>`;
}

// ---------------------------------------------------------------- garage
function statBar(label, v, best, unit, val) {
  const p = Math.max(0.06, Math.min(1, v / best));
  return `<div class="stat"><i>${label}</i><span class="stat-track"><b style="transform:scaleX(${p.toFixed(
    3
  )})"></b></span><em>${val}<u>${unit}</u></em></div>`;
}

export function garageMarkup(defs = []) {
  if (!defs.length) return `<div class="garage-empty">NO ROSTER</div>`;
  const maxPower = Math.max(...defs.map((d) => d.power || 1));
  const maxGrip = Math.max(...defs.map((d) => d.tyreGrip || 1));
  const minMass = Math.min(...defs.map((d) => d.mass || 1));
  const maxMass = Math.max(...defs.map((d) => d.mass || 1));
  const maxNos = Math.max(...defs.map((d) => d.nos?.boost || 0.1));

  let list = '';
  defs.forEach((d, i) => {
    list +=
      `<button class="car-row${i === 0 ? ' is-sel' : ''}" data-car="${esc(d.id)}" style="--i:${i}">` +
      `<span class="car-cls car-cls--${esc(d.class || 'B')}">${esc(d.class || 'B')}</span>` +
      `<span class="car-name"><i>${esc(d.brand)}</i><b>${esc(d.name)}</b></span>` +
      `<span class="car-pw">${d.power}<u>HP</u></span></button>`;
  });

  let panels = '';
  defs.forEach((d, i) => {
    const pw = d.power || 0;
    const kg = d.mass || 0;
    const ratio = kg ? (pw / (kg / 1000)).toFixed(0) : '—';
    // lighter is better, so invert mass onto the bar
    const light = maxMass === minMass ? 1 : (maxMass - kg) / (maxMass - minMass);
    panels +=
      `<div class="spec" data-car="${esc(d.id)}"${i === 0 ? '' : ' hidden'}>` +
      `<div class="spec-head"><i>${esc(d.brand)}</i><b>${esc(d.name)}</b>` +
      `<span class="chip chip--${esc(d.class || 'B')}">CLASS ${esc(d.class || 'B')}</span></div>` +
      `<div class="spec-key">` +
      `<div><i>POWER</i><b>${pw}<u>HP</u></b></div>` +
      `<div><i>MASS</i><b>${kg}<u>KG</u></b></div>` +
      `<div><i>DRIVE</i><b>${esc((d.drivetrain || '').toUpperCase())}</b></div>` +
      `<div><i>PWR/T</i><b>${ratio}<u>HP/T</u></b></div>` +
      `</div>` +
      `<div class="spec-bars">` +
      statBar('POWER', pw, maxPower, 'HP', pw) +
      statBar('GRIP', d.tyreGrip || 0, maxGrip, 'µ', (d.tyreGrip || 0).toFixed(2)) +
      statBar('LIGHTNESS', 0.1 + light * 0.9, 1, 'KG', kg) +
      statBar('NOS', d.nos?.boost || 0, maxNos, '×', `+${Math.round((d.nos?.boost || 0) * 100)}%`) +
      `</div>` +
      `<div class="spec-meta">` +
      `<span>REDLINE <b>${d.redline ?? '—'}</b></span>` +
      `<span>GEARS <b>${d.gearRatios?.length ?? '—'}</b></span>` +
      `<span>LOCK <b>${d.steerLockDeg ?? '—'}°</b></span>` +
      `</div></div>`;
  });

  let swatches = '';
  PAINTS.forEach(([hex, name], i) => {
    swatches += `<button class="sw${i === 0 ? ' is-sel' : ''}" data-paint="${hex}" title="${name}" style="--c:${hex}"><span></span></button>`;
  });

  return `
  <div class="gar-vig"></div>
  <div class="gar-rail">
    <div class="panel-head">
      <span class="tag tag--sig">GARAGE</span><span class="rule"></span>
      <span class="mono panel-count">${String(defs.length).padStart(2, '0')} CARS</span>
    </div>
    <h3 class="rail-title">SELECT<br>VEHICLE</h3>
    <div class="car-list">${list}</div>
  </div>
  <div class="gar-spec">${panels}</div>
  <div class="gar-paint">
    <div class="paint-head"><i>LIVERY</i><span class="rule"></span><b id="paint-name">INFERNO</b></div>
    <div class="paint-row">${swatches}</div>
  </div>
  <div class="gar-foot"><kbd>ENTER</kbd> CONFIRM <span class="dot"></span> <kbd>ESC</kbd> BACK</div>`;
}

// ---------------------------------------------------------------- results
export function resultsMarkup(standings = [], playerCar = null, totalLaps = 3) {
  const rows = standings.length
    ? standings
    : [{ car: playerCar, position: 1, lap: totalLaps, bestLap: 0, totalTime: 0 }];
  const leader = rows[0]?.totalTime ?? 0;
  let body = '';
  rows.forEach((s, i) => {
    const me = s.car && playerCar && s.car === playerCar;
    const def = s.car?.def;
    const gap = i === 0 ? 'LEADER' : `+${fmt(Math.max(0, (s.totalTime ?? 0) - leader), 2)}`;
    body +=
      `<tr class="${me ? 'is-me' : ''}" style="--i:${i}">` +
      `<td class="r-pos">${s.position ?? i + 1}</td>` +
      `<td class="r-car"><i>${esc(def?.brand || '')}</i><b>${esc(def?.name || 'DRIVER')}</b></td>` +
      `<td class="r-cls"><span class="chip chip--${esc(def?.class || 'B')}">${esc(def?.class || 'B')}</span></td>` +
      `<td class="r-best mono">${s.bestLap ? fmt(s.bestLap) : '—'}</td>` +
      `<td class="r-total mono">${fmt(s.totalTime ?? 0)}</td>` +
      `<td class="r-gap mono">${gap}</td></tr>`;
  });

  const mine = rows.find((s) => s.car && playerCar && s.car === playerCar) || rows[0];
  const pos = mine?.position ?? 1;

  return `
  <div class="res-scrim"></div>
  <div class="res-inner">
    <header class="res-head">
      <div class="res-badge"><i>FINISHED</i><b>${ordinal(pos)}</b></div>
      <div class="res-title"><span class="tag tag--sig">RACE COMPLETE</span><h2>HARBOUR MILE</h2>
        <p class="mono">${totalLaps} LAPS · BEST ${mine?.bestLap ? fmt(mine.bestLap) : '—'} · TOTAL ${fmt(
    mine?.totalTime ?? 0
  )}</p></div>
      <div class="res-mark">${markSvg('NFT')}</div>
    </header>
    <table class="res-table">
      <thead><tr><th>POS</th><th>DRIVER</th><th>CLS</th><th>BEST LAP</th><th>TOTAL</th><th>GAP</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <footer class="res-foot">
      <button class="btn btn--primary" data-act="restart">RESTART</button>
      <button class="btn" data-act="menu">MAIN MENU</button>
    </footer>
  </div>`;
}

// ---------------------------------------------------------------- paused
export function pausedMarkup(tier = 'high', mode = 'chase') {
  const tiers = ['low', 'medium', 'high', 'ultra'];
  const cams = ['chase', 'chaseFar', 'hood', 'bumper'];
  const seg = (name, opts, cur, act) =>
    `<div class="seg" data-group="${act}"><i>${name}</i><div class="seg-row">` +
    opts
      .map(
        (o) =>
          `<button class="seg-btn${o === cur ? ' is-on' : ''}" data-act="${act}" data-v="${o}">${o
            .toUpperCase()
            .slice(0, 8)}</button>`
      )
      .join('') +
    `</div></div>`;

  return `
  <div class="pause-scrim"></div>
  <div class="pause-card">
    <span class="pause-accent"></span>
    <div class="pause-head">
      <span class="pause-mark">${markSvg('NFT')}</span>
      <span class="tag tag--sig">PAUSED</span><span class="rule"></span>
      <span class="mono" id="pause-clock">0:00.00</span>
    </div>
    <div class="pause-actions">
      <button class="btn btn--primary" data-act="resume">RESUME</button>
      <button class="btn" data-act="restart">RESTART RACE</button>
      <button class="btn" data-act="menu">QUIT TO MENU</button>
    </div>
    <div class="pause-settings">
      ${seg('RENDER QUALITY', tiers, tier, 'tier')}
      ${seg('CAMERA', cams, mode, 'camera')}
      <div class="seg"><i>OVERLAYS</i><div class="seg-row">
        <button class="seg-btn" data-act="telemetry">TELEMETRY</button>
        <button class="seg-btn" data-act="minimap">MINIMAP</button>
      </div></div>
    </div>
    <div class="pause-keys mono">
      <span><kbd>W A S D</kbd> DRIVE</span><span><kbd>SPACE</kbd> HANDBRAKE</span>
      <span><kbd>SHIFT</kbd> NOS</span><span><kbd>V</kbd> CAMERA</span>
      <span><kbd>R</kbd> RESET</span><span><kbd>T</kbd> TELEMETRY</span>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- helpers
export function fmt(t, dp = 2) {
  if (!Number.isFinite(t)) return '—';
  const neg = t < 0;
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${neg ? '-' : ''}${m}:${s < 10 ? '0' : ''}${s.toFixed(dp)}`;
}

export function ordinal(n) {
  const s = ['TH', 'ST', 'ND', 'RD'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
