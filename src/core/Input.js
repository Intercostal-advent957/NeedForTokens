import { clamp, clamp01, damp, moveTowards } from './MathX.js';

/**
 * Keyboard + gamepad + touch, normalised into a single state object.
 * See CONTRACTS.md §3. Speed-sensitive steering smoothing lives here so every consumer
 * (player physics, replay, AI-vs-player parity) sees the same shaped signal.
 */
export class Input {
  constructor(bus, canvas) {
    this.bus = bus;
    this.canvas = canvas;
    this.keys = new Set();
    this.gamepadConnected = false;
    this.gamepadIndex = -1;
    this.lastDevice = 'keyboard';

    this.state = {
      throttle: 0,
      brake: 0,
      steer: 0,
      steerRaw: 0,
      handbrake: 0,
      nos: 0,
      lookBack: 0,
      shiftUp: false,
      shiftDown: false,
      camera: false,
      reset: false,
      pause: false,
      anyKey: false,
    };

    this._edge = { camera: false, reset: false, pause: false, shiftUp: false, shiftDown: false };
    this._steerVel = 0;
    this._speedRef = 0;
    this._touch = null;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadConnected = true;
      this.gamepadIndex = e.gamepad.index;
      this.bus?.emit('input:gamepad', { connected: true, id: e.gamepad.id });
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadConnected = false;
      this.gamepadIndex = -1;
      this.bus?.emit('input:gamepad', { connected: false });
    });
    this._initTouch();
  }

  _onKeyDown(e) {
    const c = e.code;
    if (
      [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Space',
        'Tab',
        'KeyW',
        'KeyA',
        'KeyS',
        'KeyD',
      ].includes(c)
    )
      e.preventDefault();
    if (!this.keys.has(c)) {
      // rising edge
      if (c === 'KeyV') this._edge.camera = true;
      if (c === 'KeyR') this._edge.reset = true;
      if (c === 'Escape' || c === 'KeyP') this._edge.pause = true;
      if (c === 'ShiftLeft' || c === 'KeyE' || c === 'ArrowRight2') this._edge.shiftUp = false;
      if (c === 'KeyQ') this._edge.shiftDown = true;
      if (c === 'KeyE') this._edge.shiftUp = true;
    }
    this.keys.add(c);
    this.lastDevice = 'keyboard';
    this.state.anyKey = true;
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
  }

  _initTouch() {
    if (!('ontouchstart' in window)) return;
    const t = { steer: 0, throttle: 0, brake: 0, handbrake: 0, nos: 0, active: false };
    this._touch = t;
    const el = this.canvas;
    const onMove = (ev) => {
      ev.preventDefault();
      t.steer = 0;
      t.throttle = 0;
      t.brake = 0;
      for (const touch of ev.touches) {
        const x = touch.clientX / window.innerWidth;
        const y = touch.clientY / window.innerHeight;
        if (x < 0.45) t.steer = clamp((x - 0.22) / 0.18, -1, 1);
        else if (y > 0.55) t.throttle = 1;
        else t.brake = 1;
      }
      t.active = ev.touches.length > 0;
    };
    el.addEventListener('touchstart', onMove, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onMove, { passive: false });
  }

  _key(...codes) {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  update(dt, speedKmh = 0) {
    const s = this.state;
    let throttle = 0;
    let brake = 0;
    let steerTarget = 0;
    let handbrake = 0;
    let nos = 0;
    let lookBack = 0;

    // ---- keyboard ----
    if (this._key('KeyW', 'ArrowUp')) throttle = 1;
    if (this._key('KeyS', 'ArrowDown')) brake = 1;
    if (this._key('KeyA', 'ArrowLeft')) steerTarget -= 1;
    if (this._key('KeyD', 'ArrowRight')) steerTarget += 1;
    if (this._key('Space')) handbrake = 1;
    if (this._key('ShiftLeft', 'ShiftRight')) nos = 1;
    if (this._key('KeyC')) lookBack = 1;

    // ---- gamepad ----
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = this.gamepadIndex >= 0 ? pads[this.gamepadIndex] : pads[0];
    if (pad && pad.connected) {
      this.gamepadConnected = true;
      const dz = (v, d = 0.12) => (Math.abs(v) < d ? 0 : (Math.sign(v) * (Math.abs(v) - d)) / (1 - d));
      const ax = dz(pad.axes[0] ?? 0);
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      if (Math.abs(ax) > 0.001 || rt > 0.02 || lt > 0.02) this.lastDevice = 'gamepad';
      if (Math.abs(ax) > Math.abs(steerTarget)) steerTarget = ax;
      throttle = Math.max(throttle, rt);
      brake = Math.max(brake, lt);
      if (pad.buttons[0]?.pressed) handbrake = 1;
      if (pad.buttons[1]?.pressed) nos = 1;
      if (pad.buttons[2]?.pressed) lookBack = 1;
      const up = pad.buttons[5]?.pressed;
      const dn = pad.buttons[4]?.pressed;
      if (up && !this._padUp) this._edge.shiftUp = true;
      if (dn && !this._padDn) this._edge.shiftDown = true;
      this._padUp = up;
      this._padDn = dn;
      const camBtn = pad.buttons[3]?.pressed;
      if (camBtn && !this._padCam) this._edge.camera = true;
      this._padCam = camBtn;
      const rst = pad.buttons[9]?.pressed;
      if (rst && !this._padRst) this._edge.reset = true;
      this._padRst = rst;
    }

    // ---- touch ----
    if (this._touch?.active) {
      throttle = Math.max(throttle, this._touch.throttle);
      brake = Math.max(brake, this._touch.brake);
      if (Math.abs(this._touch.steer) > Math.abs(steerTarget)) steerTarget = this._touch.steer;
      this.lastDevice = 'touch';
    }

    steerTarget = clamp(steerTarget, -1, 1);
    s.steerRaw = steerTarget;

    // Speed-sensitive steering: full lock when parking, progressively less at speed, and a
    // slower return-to-centre than turn-in so the car settles instead of snapping.
    this._speedRef = damp(this._speedRef, speedKmh, 6, dt);
    const speedFactor = 1 - 0.62 * clamp01((this._speedRef - 30) / 210);
    const target = steerTarget * speedFactor;
    const turningIn = Math.sign(target) === Math.sign(s.steer) || Math.abs(s.steer) < 0.02;
    const rate = turningIn ? 4.2 : 6.4; // units/sec
    s.steer = moveTowards(s.steer, target, rate * dt);
    // Small centring spring when there is no input at all, scaled with speed.
    if (steerTarget === 0) s.steer = damp(s.steer, 0, 9 + this._speedRef * 0.02, dt);

    s.throttle = clamp01(throttle);
    s.brake = clamp01(brake);
    s.handbrake = clamp01(handbrake);
    s.nos = nos;
    s.lookBack = lookBack;
    s.camera = this._edge.camera;
    s.reset = this._edge.reset;
    s.pause = this._edge.pause;
    s.shiftUp = this._edge.shiftUp;
    s.shiftDown = this._edge.shiftDown;
    this._edge.camera = this._edge.reset = this._edge.pause = false;
    this._edge.shiftUp = this._edge.shiftDown = false;

    // Automated-QA override hook (see CONTRACTS.md §3).
    const ov = window.__NFT_INPUT_OVERRIDE;
    if (ov) {
      for (const k in ov) if (k in s) s[k] = ov[k];
      if (ov.steer !== undefined) s.steerRaw = ov.steer;
    }
    return s;
  }
}
