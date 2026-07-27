/**
 * Wind + road roar. Two persistent layers that carry the sense of speed when the engine is quiet
 * (off throttle, mid-corner) and duck out of the way when it isn't.
 *
 * Wind is two bands: a low buffet that you feel, and a high rush whose centre frequency and Q both
 * climb with speed — that Q ramp is what makes 250 km/h read differently from 120 km/h rather than
 * just louder.
 */
import { clamp, clamp01, lerp } from '../core/MathX.js';
import { noiseSource, ramp } from './dsp.js';
import { surfaceInfo } from './TyreVoice.js';

export class AmbienceVoice {
  constructor(ac, o = {}) {
    this.ac = ac;
    const t0 = o.startTime ?? ac.currentTime;

    this.out = ac.createGain();
    this.out.gain.value = 1;
    // Sidechain: the whole bed sits under the engine.
    this.duck = ac.createGain();
    this.duck.gain.value = 1;
    this.out.connect(this.duck);
    if (o.dest) this.duck.connect(o.dest);

    /* ---------------- wind: high rush ---------------- */
    this.rushSrc = noiseSource(ac, 'pink');
    this.rushBp = ac.createBiquadFilter();
    this.rushBp.type = 'bandpass';
    this.rushBp.frequency.value = 420;
    this.rushBp.Q.value = 0.55;
    this.rushShelf = ac.createBiquadFilter();
    this.rushShelf.type = 'highshelf';
    this.rushShelf.frequency.value = 3200;
    this.rushShelf.gain.value = -6;
    this.rushG = ac.createGain();
    this.rushG.gain.value = 0;
    this.rushSrc.connect(this.rushBp).connect(this.rushShelf).connect(this.rushG).connect(this.out);
    this.rushSrc.start(t0);

    // Gusting — slow random-ish AM so it never sits perfectly still.
    this.gust = ac.createOscillator();
    this.gust.type = 'sine';
    this.gust.frequency.value = 0.37;
    this.gustAmt = ac.createGain();
    this.gustAmt.gain.value = 0;
    this.gust.connect(this.gustAmt).connect(this.rushG.gain);
    this.gust.start(t0);

    /* ---------------- wind: low buffet ---------------- */
    this.buffSrc = noiseSource(ac, 'brown');
    this.buffLp = ac.createBiquadFilter();
    this.buffLp.type = 'lowpass';
    this.buffLp.frequency.value = 260;
    this.buffLp.Q.value = 0.7;
    this.buffG = ac.createGain();
    this.buffG.gain.value = 0;
    this.buffSrc.connect(this.buffLp).connect(this.buffG).connect(this.out);
    this.buffSrc.start(t0);

    /* ---------------- road roar ---------------- */
    this.roadSrc = noiseSource(ac, 'brown');
    this.roadLp = ac.createBiquadFilter();
    this.roadLp.type = 'lowpass';
    this.roadLp.frequency.value = 700;
    this.roadLp.Q.value = 0.9;
    this.roadPk = ac.createBiquadFilter();
    this.roadPk.type = 'peaking';
    this.roadPk.frequency.value = 118;
    this.roadPk.Q.value = 1.4;
    this.roadPk.gain.value = 7;
    // Tread-block passing frequency: a real tyre hums at (speed / block pitch).
    this.roadTone = ac.createBiquadFilter();
    this.roadTone.type = 'peaking';
    this.roadTone.frequency.value = 320;
    this.roadTone.Q.value = 3.2;
    this.roadTone.gain.value = 5;
    this.roadG = ac.createGain();
    this.roadG.gain.value = 0;
    this.roadSrc
      .connect(this.roadLp)
      .connect(this.roadPk)
      .connect(this.roadTone)
      .connect(this.roadG)
      .connect(this.out);
    this.roadSrc.start(t0);

    this.loudness = 0;
  }

  /**
   * @param {object} s   VehicleState
   * @param {number} t   schedule time
   * @param {object} o   { gain, duck (0..1 amount of engine ducking), wetness }
   */
  update(s, t, o = {}) {
    const gain = o.gain ?? 1;
    const speed = Math.abs(s?.speedKmh ?? 0) / 3.6;
    const sN = clamp01(speed / 92); // ~330 km/h full scale
    const airborne = s?.airborne ? 1 : 0;

    // Wind power grows with roughly v^2.4; the ear reads that as "fast".
    const rush = Math.pow(sN, 1.25) * 0.2;
    ramp(this.rushG.gain, rush * gain, t, 0.12);
    ramp(this.rushBp.frequency, clamp(lerp(300, 1650, Math.pow(sN, 0.85)), 80, 8000), t, 0.14);
    ramp(this.rushBp.Q, lerp(0.5, 2.3, sN), t, 0.16);
    ramp(this.rushShelf.gain, lerp(-9, 4, sN), t, 0.18);
    ramp(this.gustAmt.gain, rush * 0.35 * gain, t, 0.2);
    ramp(this.gust.frequency, 0.25 + sN * 0.7, t, 0.3);

    ramp(this.buffG.gain, Math.pow(sN, 1.5) * 0.14 * gain * (1 + airborne * 0.5), t, 0.14);
    ramp(this.buffLp.frequency, clamp(150 + sN * 260, 40, 900), t, 0.2);

    /* road */
    let surf = 'asphalt';
    let contacts = 0;
    const wheels = s?.wheels;
    if (wheels) {
      for (const w of wheels) {
        if (w?.contact) {
          contacts++;
          surf = w.surface || surf;
        }
      }
    }
    const info = surfaceInfo(surf);
    const grounded = clamp01(contacts / 2);
    const road = Math.pow(sN, 0.9) * 0.26 * info.roar * grounded;
    ramp(this.roadG.gain, road * gain, t, 0.09);
    ramp(this.roadLp.frequency, clamp(info.roarLp * (0.5 + 0.9 * sN), 60, 9000), t, 0.12);
    // block pitch ≈ 3.5 cm → hum frequency rises linearly with road speed
    ramp(this.roadTone.frequency, clamp(28 + speed / 0.035 / 12, 40, 3000), t, 0.1);
    ramp(this.roadTone.gain, lerp(2, 8, sN) * (info.loose > 0.4 ? 0.3 : 1), t, 0.15);

    // sidechain from the engine
    const duckAmt = clamp01(o.duck ?? 0);
    ramp(this.duck.gain, 1 - duckAmt * 0.45, t, 0.08);

    this.loudness = clamp01(rush * 3 + road * 2);
  }

  dispose() {
    try {
      this.rushSrc.stop();
      this.buffSrc.stop();
      this.roadSrc.stop();
      this.gust.stop();
      this.out.disconnect();
      this.duck.disconnect();
    } catch {
      /* ignore */
    }
  }
}
