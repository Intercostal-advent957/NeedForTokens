/**
 * The in-race HUD skeleton. Built once in `UiSystem.init()`; after that only textContent /
 * transform / opacity are written. See CONTRACTS.md §13.
 */
import { tachSvg } from './Tachometer.js';

export function hudMarkup(minimapSvg, opts = {}) {
  const maxRpm = opts.maxRpm ?? 9000;
  const warn = opts.warn ?? 0.79;
  const red = opts.red ?? 0.925;

  let events = '';
  for (let i = 0; i < 3; i++) {
    events += `<div class="evt" data-slot="${i}"><span class="evt-kick"></span><span class="evt-body"></span></div>`;
  }

  return `
  <div class="hud-vig" aria-hidden="true"></div>

  <section class="hud-standings">
    <div class="pos-block">
      <b id="hud-pos">1</b><i id="hud-pos-suf">ST</i>
      <span class="pos-of">OF <em id="hud-field">8</em></span>
    </div>
    <div class="lap-block"><i>LAP</i><b id="hud-lap">1</b><em>/<span id="hud-laps">3</span></em></div>
  </section>

  <section class="hud-timing">
    <div class="tm-main"><i>THIS LAP</i><b id="hud-laptime">0:00.00</b></div>
    <div class="tm-sub"><i>BEST</i><b id="hud-best">--:--</b></div>
    <div class="tm-delta" id="hud-delta"><span id="hud-delta-val">+0.00</span></div>
  </section>

  <section class="hud-events" id="hud-events">${events}</section>

  <section class="hud-map">
    <div class="map-head"><i id="map-name">HARBOUR MILE</i><b id="map-lap" class="mono">1/3</b></div>
    ${minimapSvg}
  </section>

  <section class="hud-drift" id="hud-drift">
    <i>DRIFT</i><b id="hud-drift-val">0</b><em id="hud-drift-mult">×1.0</em>
    <span class="drift-bar"><u id="hud-drift-bar"></u></span>
  </section>

  <section class="hud-cluster" id="hud-cluster" data-shift="0">
    ${tachSvg({ maxRpm, warn, red })}
    <div class="nos" id="hud-nos">
      <span class="nos-cap"></span>
      <span class="nos-track"><u id="hud-nos-fill"></u><s class="nos-grid"></s></span>
      <span class="nos-label">NOS</span>
    </div>
  </section>

  <div class="cd" id="hud-cd" aria-hidden="true">
    <span class="cd-scrim"></span>
    <span class="cd-ring"></span><span class="cd-ring cd-ring--2"></span>
    <span class="cd-rule cd-rule--l"></span><span class="cd-rule cd-rule--r"></span>
    <svg class="cd-svg" viewBox="0 0 420 300" preserveAspectRatio="xMidYMid meet">
      <text class="cd-num" id="hud-cd-num" x="210" y="228"></text>
    </svg>
  </div>

  <div class="hud-toast" id="hud-toast"><span id="hud-toast-txt"></span></div>

  <aside class="tele" id="hud-tele" hidden><div class="tele-head">TELEMETRY</div><div class="tele-rows" id="hud-tele-rows"></div></aside>`;
}
