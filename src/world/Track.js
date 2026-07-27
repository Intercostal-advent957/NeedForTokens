import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/MathX.js';
import { buildCircuit, rasteriseFeatures, smoothWrap } from './TrackLayout.js';

/**
 * Closed-loop circuit: centreline, banking, variable width, cross-section features, an ideal
 * racing line and checkpoints. See CONTRACTS.md §7.
 *
 * Everything downstream (physics ground query, AI, camera look-ahead, minimap, race progress)
 * reads from here at up to ~8000 queries/second, so the curve is baked once into flat typed
 * arrays at 1 m spacing and queried by index — no per-frame spline evaluation, no allocation.
 *
 * Because the centreline is resampled to *uniform arc length*, `t` is exactly `s / length`.
 * That is relied on all over the place (dash spacing, feature lookup, AI look-ahead in metres).
 */
export class Track {
  /** @param {object} opts { laps, bankScale, halfWidthScale, step } */
  constructor(opts = {}) {
    this.opts = { laps: 3, bankScale: 1, step: 1.0, ...opts };
    this.laps = this.opts.laps;

    const circuit = buildCircuit(this.opts.step);
    this.circuit = circuit;
    this.length = circuit.length;
    this.segments = circuit.segments;
    this.corners = circuit.corners;
    this.name = 'Vermilion Bay Circuit';

    const N = (this.samples = circuit.count);
    this._pos = circuit.pos; // xyz, uniform arc spacing
    this._tan = new Float32Array(N * 3);
    this._up = new Float32Array(N * 3);
    this._nrm = new Float32Array(N * 3); // lateral (right) vector, banked
    this._flat = new Float32Array(N * 3); // lateral (right) vector, horizontal — for projection
    this._curv = new Float32Array(N);
    this._bank = new Float32Array(N);
    this._width = new Float32Array(N);
    this._grade = new Float32Array(N); // dy/ds
    this.ds = this.length / N;
    this._proj = Track.makeProjection();

    this._bake();
    this.features = rasteriseFeatures(circuit.features, N, this.length);
    this.featureSpec = circuit.features;
    this._buildRacingLine();
    this._buildCheckpoints();
    this._buildSpatialGrid();
  }

  // ------------------------------------------------------------------ baking

  _bake() {
    const N = this.samples;
    const P = this._pos;
    const ds = this.ds;

    // --- tangents from central differences on the (already uniform) polyline
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N;
      const b = (i + 1) % N;
      let tx = P[b * 3] - P[a * 3];
      let ty = P[b * 3 + 1] - P[a * 3 + 1];
      let tz = P[b * 3 + 2] - P[a * 3 + 2];
      const l = Math.hypot(tx, ty, tz) || 1;
      tx /= l;
      ty /= l;
      tz /= l;
      this._tan[i * 3] = tx;
      this._tan[i * 3 + 1] = ty;
      this._tan[i * 3 + 2] = tz;
      this._grade[i] = ty;
    }

    // --- signed plan-view curvature (+ = left), from heading change per metre
    const raw = new Float32Array(N);
    const span = Math.max(2, Math.round(3 / ds));
    for (let i = 0; i < N; i++) {
      const i0 = (i - span + N) % N;
      const i1 = (i + span) % N;
      const ax = this._tan[i0 * 3];
      const az = this._tan[i0 * 3 + 2];
      const bx = this._tan[i1 * 3];
      const bz = this._tan[i1 * 3 + 2];
      const cross = ax * bz - az * bx;
      const dot = clamp(ax * bx + az * bz, -1, 1);
      raw[i] = -Math.atan2(cross, dot) / (2 * span * ds);
    }
    this._curv = smoothWrap(raw, Math.max(1, Math.round(6 / ds)));

    // --- banking: curvature-derived, plus the authored boost, then smoothed hard so the road
    //     surface never creases (a bank discontinuity is instantly visible and unphysical).
    const bank = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const s = i * ds;
      const k = this._curv[i];
      bank[i] =
        (clamp(k * 42, -0.075, 0.075) + this.circuit.bankBoostOf(s) * Math.sign(k || 1)) *
        this.opts.bankScale;
    }
    this._bank = smoothWrap(smoothWrap(bank, Math.round(14 / ds)), Math.round(9 / ds));

    // --- half width
    const wScale = this.opts.halfWidthScale ?? 1;
    for (let i = 0; i < N; i++) this._width[i] = this.circuit.widthOf(i * ds) * wScale;
    this._width = smoothWrap(this._width, Math.round(8 / ds));

    // --- frames: right/up rotated about the tangent by the bank angle
    for (let i = 0; i < N; i++) {
      const tx = this._tan[i * 3];
      const ty = this._tan[i * 3 + 1];
      const tz = this._tan[i * 3 + 2];
      // right = tangent x worldUp  (normalised, horizontal)
      let rx = -tz;
      let rz = tx;
      const rl = Math.hypot(rx, rz) || 1;
      rx /= rl;
      rz /= rl;
      this._flat[i * 3] = rx;
      this._flat[i * 3 + 2] = rz;
      // roadUp = right x tangent, with right = (rx, 0, rz)
      let Ux = -rz * ty;
      let Uy = rz * tx - rx * tz;
      let Uz = rx * ty;
      const ul = Math.hypot(Ux, Uy, Uz) || 1;
      Ux /= ul;
      Uy /= ul;
      Uz /= ul;

      // rotate (right, up) about the tangent by the bank angle
      const b = this._bank[i];
      const cs = Math.cos(b);
      const sn = Math.sin(b);
      this._nrm[i * 3] = rx * cs + Ux * sn;
      this._nrm[i * 3 + 1] = Uy * sn;
      this._nrm[i * 3 + 2] = rz * cs + Uz * sn;
      this._up[i * 3] = Ux * cs - rx * sn;
      this._up[i * 3 + 1] = Uy * cs;
      this._up[i * 3 + 2] = Uz * cs - rz * sn;
    }
  }

  // ------------------------------------------------------------------ sampling

  _idx(t) {
    let x = t % 1;
    if (x < 0) x += 1;
    return x * this.samples;
  }

  _v3(arr, t, out) {
    const N = this.samples;
    const f = this._idx(t);
    const i0 = Math.floor(f) % N;
    const i1 = (i0 + 1) % N;
    const a = f - Math.floor(f);
    return out.set(
      lerp(arr[i0 * 3], arr[i1 * 3], a),
      lerp(arr[i0 * 3 + 1], arr[i1 * 3 + 1], a),
      lerp(arr[i0 * 3 + 2], arr[i1 * 3 + 2], a)
    );
  }

  _s1(arr, t) {
    const N = this.samples;
    const f = this._idx(t);
    const i0 = Math.floor(f) % N;
    return lerp(arr[i0], arr[(i0 + 1) % N], f - Math.floor(f));
  }

  pointAt(t, out = new THREE.Vector3()) {
    return this._v3(this._pos, t, out);
  }
  tangentAt(t, out = new THREE.Vector3()) {
    return this._v3(this._tan, t, out).normalize();
  }
  upAt(t, out = new THREE.Vector3()) {
    return this._v3(this._up, t, out).normalize();
  }
  rightAt(t, out = new THREE.Vector3()) {
    return this._v3(this._nrm, t, out).normalize();
  }
  /** Horizontal right vector — ignores banking. Used for projection and for the minimap. */
  flatRightAt(t, out = new THREE.Vector3()) {
    return this._v3(this._flat, t, out).normalize();
  }
  widthAt(t) {
    return this._s1(this._width, t);
  }
  bankAt(t) {
    return this._s1(this._bank, t);
  }
  curvatureAt(t) {
    return this._s1(this._curv, t);
  }
  gradeAt(t) {
    return this._s1(this._grade, t);
  }
  /** Index of the baked sample nearest `t` — for callers that want the raw feature arrays. */
  indexAt(t) {
    return Math.floor(this._idx(t)) % this.samples;
  }

  frameAt(t, out = null) {
    const o = out || { position: new THREE.Vector3(), tangent: new THREE.Vector3(), normal: new THREE.Vector3(), binormal: new THREE.Vector3() };
    this.pointAt(t, o.position);
    this.tangentAt(t, o.tangent);
    this.upAt(t, o.normal);
    this.rightAt(t, o.binormal);
    return o;
  }

  // ------------------------------------------------------------------ projection

  /**
   * Uniform XZ grid over the centreline. Every sample registers itself in the 3x3 block of
   * cells around it, so any query inside the track corridor resolves in one bucket lookup.
   */
  _buildSpatialGrid() {
    const N = this.samples;
    const cell = 18;
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < N; i++) {
      min.x = Math.min(min.x, this._pos[i * 3]);
      max.x = Math.max(max.x, this._pos[i * 3]);
      min.y = Math.min(min.y, this._pos[i * 3 + 1]);
      max.y = Math.max(max.y, this._pos[i * 3 + 1]);
      min.z = Math.min(min.z, this._pos[i * 3 + 2]);
      max.z = Math.max(max.z, this._pos[i * 3 + 2]);
    }
    const pad = 200;
    const g = {
      cell,
      minX: min.x - pad,
      minZ: min.z - pad,
      nx: Math.ceil((max.x - min.x + pad * 2) / cell),
      nz: Math.ceil((max.z - min.z + pad * 2) / cell),
    };
    // Two-pass CSR build: counts then fill. Keeps it as two flat typed arrays instead of
    // thousands of little JS arrays, which matters because project() runs ~8000x/second.
    const cells = g.nx * g.nz;
    const counts = new Int32Array(cells + 1);
    const cellOf = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const cx = Math.floor((this._pos[i * 3] - g.minX) / cell);
      const cz = Math.floor((this._pos[i * 3 + 2] - g.minZ) / cell);
      cellOf[i] = cz * g.nx + cx;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const z = cz + dz;
          if (x < 0 || z < 0 || x >= g.nx || z >= g.nz) continue;
          counts[z * g.nx + x + 1]++;
        }
      }
    }
    for (let i = 0; i < cells; i++) counts[i + 1] += counts[i];
    const items = new Int32Array(counts[cells]);
    const cursor = counts.slice(0, cells);
    for (let i = 0; i < N; i++) {
      const cx = cellOf[i] % g.nx;
      const cz = (cellOf[i] / g.nx) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const z = cz + dz;
          if (x < 0 || z < 0 || x >= g.nx || z >= g.nz) continue;
          items[cursor[z * g.nx + x]++] = i;
        }
      }
    }
    g.start = counts;
    g.items = items;
    this._grid = g;
    this.bounds = { min, max };
  }

  /**
   * Nearest point on the centreline, in track-space coordinates.
   *
   * ALLOCATION-FREE: the result is written into `out`, defaulting to a single shared scratch
   * object owned by this Track. Callers that need to hold a projection across another
   * `project()` call MUST pass their own object (see `Track.makeProjection()`).
   */
  project(pos, hint = -1, out = null) {
    const o = out || this._proj;
    const N = this.samples;
    const g = this._grid;
    const P = this._pos;
    let best = -1;
    let bestD = Infinity;

    const cx = Math.floor((pos.x - g.minX) / g.cell);
    const cz = Math.floor((pos.z - g.minZ) / g.cell);
    if (cx >= 0 && cz >= 0 && cx < g.nx && cz < g.nz) {
      const k = cz * g.nx + cx;
      const e = g.start[k + 1];
      for (let q = g.start[k]; q < e; q++) {
        const i = g.items[q];
        const dx = pos.x - P[i * 3];
        const dz = pos.z - P[i * 3 + 2];
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best < 0) {
      // Miles off the circuit. Search around the caller's hint, else a coarse sweep + refine.
      if (hint >= 0) {
        const h = Math.floor(hint * N);
        for (let d = -96; d <= 96; d += 2) {
          const i = (h + d + N * 2) % N;
          const dx = pos.x - P[i * 3];
          const dz = pos.z - P[i * 3 + 2];
          const dd = dx * dx + dz * dz;
          if (dd < bestD) {
            bestD = dd;
            best = i;
          }
        }
      } else {
        const stride = Math.max(1, Math.round(12 / this.ds));
        for (let i = 0; i < N; i += stride) {
          const dx = pos.x - P[i * 3];
          const dz = pos.z - P[i * 3 + 2];
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      const b = best < 0 ? 0 : best;
      const w = Math.max(2, Math.round(14 / this.ds));
      for (let d = -w; d <= w; d++) {
        const i = (b + d + N * 2) % N;
        const dx = pos.x - P[i * 3];
        const dz = pos.z - P[i * 3 + 2];
        const dd = dx * dx + dz * dz;
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      }
    }

    // Sub-sample refinement against the two neighbouring segments — gives a continuous t and a
    // continuous height, which matters enormously: a stepped ground height makes the car buzz.
    const i0 = best;
    const im = (i0 - 1 + N) % N;
    const ip = (i0 + 1) % N;
    let bu = 0;
    let bi = i0;
    let bd = Infinity;
    let px = 0;
    let py = 0;
    let pz = 0;
    for (let pass = 0; pass < 2; pass++) {
      const ia = pass === 0 ? im : i0;
      const ib = pass === 0 ? i0 : ip;
      const ax = P[ia * 3];
      const ay = P[ia * 3 + 1];
      const az = P[ia * 3 + 2];
      const ex = P[ib * 3] - ax;
      const ey = P[ib * 3 + 1] - ay;
      const ez = P[ib * 3 + 2] - az;
      const len2 = ex * ex + ez * ez || 1e-6;
      const u = clamp01(((pos.x - ax) * ex + (pos.z - az) * ez) / len2);
      const qx = ax + ex * u;
      const qz = az + ez * u;
      const dx = pos.x - qx;
      const dz = pos.z - qz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) {
        bd = d2;
        bu = u;
        bi = ia;
        px = qx;
        py = ay + ey * u;
        pz = qz;
      }
    }

    const t = ((bi + bu) % N) / N;
    // signed lateral offset, measured on the HORIZONTAL right vector so it is a true plan-view
    // distance (using the banked one would shrink the corridor on banked corners)
    const j = (bi + 1) % N;
    const rx = lerp(this._flat[bi * 3], this._flat[j * 3], bu);
    const rz = lerp(this._flat[bi * 3 + 2], this._flat[j * 3 + 2], bu);
    const lateral = (pos.x - px) * rx + (pos.z - pz) * rz;
    const width = this._s1(this._width, t);

    o.t = t;
    o.s = t * this.length;
    o.index = bi;
    o.u = bu;
    o.lateral = lateral;
    o.width = width;
    o.onTrack = Math.abs(lateral) <= width;
    o.height = py;
    o.distance = Math.sqrt(bd);
    return o;
  }

  /** A projection record callers can own, so nested project() calls never clobber each other. */
  static makeProjection() {
    return {
      t: 0, s: 0, index: 0, u: 0, lateral: 0, width: 0,
      onTrack: false, height: 0, distance: 0,
    };
  }

  // ------------------------------------------------------------------ racing line

  /**
   * Minimum-curvature line inside the drivable corridor.
   *
   * Each sample can slide laterally within +/- (halfWidth - margin). Repeatedly moving every
   * point toward the midpoint of two neighbours minimises discrete curvature, and doing it at
   * decreasing stencil widths (multigrid style: 96 -> 3 samples) converges in a handful of
   * sweeps instead of thousands. The result is a real turn-in / apex / track-out line: it runs
   * to the outside on corner entry, kisses the inside kerb at the apex, and unwinds to the
   * outside on exit, for free, because that IS the minimum-curvature path through a corridor.
   */
  _buildRacingLine() {
    const N = this.samples;
    const ds = this.ds;
    const P = this._pos;
    const R = this._flat;
    const off = new Float32Array(N);
    const next = new Float32Array(N);

    // usable corridor: keep the car body and a little kerb-riding allowance inside the track
    const margin = 1.15;
    const lim = new Float32Array(N);
    for (let i = 0; i < N; i++) lim[i] = Math.max(0.5, this._width[i] - margin);

    const stencils = [];
    for (let k = Math.round(96 / ds); k >= 3; k = Math.round(k * 0.62)) stencils.push(k);
    stencils.push(2, 2);

    for (const k of stencils) {
      for (let iter = 0; iter < 26; iter++) {
        for (let i = 0; i < N; i++) {
          const a = (i - k + N * 2) % N;
          const b = (i + k) % N;
          // midpoint of the two neighbours, in world XZ
          const mx = (P[a * 3] + R[a * 3] * off[a] + P[b * 3] + R[b * 3] * off[b]) * 0.5;
          const mz = (P[a * 3 + 2] + R[a * 3 + 2] * off[a] + P[b * 3 + 2] + R[b * 3 + 2] * off[b]) * 0.5;
          // project it back onto this sample's lateral axis
          const target = (mx - P[i * 3]) * R[i * 3] + (mz - P[i * 3 + 2]) * R[i * 3 + 2];
          next[i] = clamp(lerp(off[i], target, 0.62), -lim[i], lim[i]);
        }
        off.set(next);
      }
    }
    this._lineOff = smoothWrap(off, Math.max(1, Math.round(4 / ds)));

    // --- line geometry: world position, curvature and grade along the ideal line
    const lx = new Float32Array(N);
    const lz = new Float32Array(N);
    const ly = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      lx[i] = P[i * 3] + R[i * 3] * this._lineOff[i];
      lz[i] = P[i * 3 + 2] + R[i * 3 + 2] * this._lineOff[i];
      // height follows the banked road surface at that offset
      ly[i] = P[i * 3 + 1] + this._nrm[i * 3 + 1] * this._lineOff[i];
    }
    this._lineX = lx;
    this._lineY = ly;
    this._lineZ = lz;

    const lineDs = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      lineDs[i] = Math.hypot(lx[j] - lx[i], lz[j] - lz[i]) || ds;
    }
    const lineK = new Float32Array(N);
    const sp = Math.max(2, Math.round(9 / ds));
    for (let i = 0; i < N; i++) {
      const a = (i - sp + N * 2) % N;
      const b = (i + sp) % N;
      // Menger curvature of the triangle (a, i, b) — robust and cheap
      const ax = lx[a] - lx[i];
      const az = lz[a] - lz[i];
      const bx = lx[b] - lx[i];
      const bz = lz[b] - lz[i];
      const cross = Math.abs(ax * bz - az * bx);
      const la = Math.hypot(ax, az);
      const lb = Math.hypot(bx, bz);
      const lc = Math.hypot(lx[b] - lx[a], lz[b] - lz[a]);
      lineK[i] = cross > 1e-9 ? (2 * cross) / (la * lb * lc) : 0;
    }
    this._lineCurv = smoothWrap(lineK, Math.max(1, Math.round(7 / ds)));

    this._buildSpeedProfile(lineDs);

    const track = this;
    this.racingLine = {
      /** lateral offset from the centreline, in METRES (+ = right) */
      offsetAt(t) {
        return track._s1(track._lineOff, t);
      },
      pointAt(t, out = new THREE.Vector3()) {
        const f = track._idx(t);
        const i0 = Math.floor(f) % N;
        const i1 = (i0 + 1) % N;
        const a = f - Math.floor(f);
        return out.set(
          lerp(track._lineX[i0], track._lineX[i1], a),
          lerp(track._lineY[i0], track._lineY[i1], a),
          lerp(track._lineZ[i0], track._lineZ[i1], a)
        );
      },
      tangentAt(t, out = new THREE.Vector3()) {
        const d = 4 / track.length;
        this.pointAt(t - d, _v2);
        this.pointAt(t + d, _v3);
        return out.subVectors(_v3, _v2).normalize();
      },
      /** grip-limited, brake- and power-feasible target speed in m/s */
      speedAt(t) {
        return track._s1(track._lineSpeed, t);
      },
      curvatureAt(t) {
        return track._s1(track._lineCurv, t);
      },
    };
  }

  /**
   * Forward/backward speed profile.
   *
   * 1. Cornering limit from the racing-line radius, including the help banking gives you:
   *      v^2 = g r (mu cos b + sin b) / (cos b - mu sin b)
   * 2. Backward pass so every apex is reachable under braking (mu*g + drag + gradient).
   * 3. Forward pass so every exit is reachable under power (min of traction and P/(m v)).
   * Iterated because braking and acceleration limits interact around short straights.
   */
  _buildSpeedProfile(lineDs) {
    const N = this.samples;
    const g = 9.81;
    const mu = this.opts.mu ?? 1.42; // effective lateral tyre coefficient for a mid-pack car
    const mass = 1420;
    const power = 640 * 745.7 * 0.86;
    const dragK = 0.5 * 1.225 * 0.32 * 2.0;
    const vTop = 96; // m/s ≈ 346 km/h
    const v = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      const k = this._lineCurv[i];
      const r = k > 1e-6 ? 1 / k : 1e6;
      const b = Math.abs(this._bank[i]);
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      const denom = Math.max(0.15, cb - mu * sb);
      const aLat = g * ((mu * cb + sb) / denom);
      v[i] = Math.min(Math.sqrt(aLat * r), vTop);
    }

    for (let pass = 0; pass < 4; pass++) {
      // backward — braking
      for (let n = 0; n < N; n++) {
        const i = N - 1 - n;
        const j = (i + 1) % N;
        const ds = lineDs[i];
        const lat = clamp01((v[j] * v[j] * this._lineCurv[j]) / (mu * g)); // grip already used cornering
        const aBrake = mu * g * Math.sqrt(Math.max(0.04, 1 - lat * lat)) + (dragK * v[j] * v[j]) / mass
          + g * this._grade[j]; // + grade: uphill helps you slow down
        const vmax = Math.sqrt(Math.max(0, v[j] * v[j] + 2 * Math.max(1, aBrake) * ds));
        if (vmax < v[i]) v[i] = vmax;
      }
      // forward — traction and power
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const ds = lineDs[i];
        const vi = Math.max(v[i], 3);
        const lat = clamp01((vi * vi * this._lineCurv[i]) / (mu * g));
        const aGrip = mu * g * 0.55 * Math.sqrt(Math.max(0.04, 1 - lat * lat)); // rear-drive traction
        const aPower = power / (mass * vi);
        const aDrag = (dragK * vi * vi) / mass;
        const acc = Math.min(aGrip, aPower) - aDrag - g * this._grade[i];
        const vmax = Math.sqrt(Math.max(0, vi * vi + 2 * Math.max(0.2, acc) * ds));
        if (vmax < v[j]) v[j] = vmax;
      }
    }
    this._lineSpeed = smoothWrap(v, 2);
  }

  // ------------------------------------------------------------------ race furniture

  _buildCheckpoints() {
    const n = Math.max(8, Math.round(this.length / 240));
    this.checkpoints = [];
    for (let i = 0; i < n; i++) {
      const t = i / n;
      this.checkpoints.push({
        t,
        position: this.pointAt(t),
        quaternion: this.orientationAt(t),
        width: this.widthAt(t),
      });
    }
    this.startLine = this.checkpoints[0];
  }

  /** Quaternion whose -Z is the direction of travel and whose +Y is the road normal. */
  orientationAt(t, out = new THREE.Quaternion()) {
    const tan = this.tangentAt(t, _v1);
    const up = this.upAt(t, _v2);
    const right = _v3.crossVectors(tan, up).normalize();
    _m1.makeBasis(right, up, _v4.copy(tan).negate());
    return out.setFromRotationMatrix(_m1);
  }

  /** Grid slots behind the start line, staggered like a real racing grid. */
  spawnPoints(count = 8) {
    const out = [];
    const gap = 8.5;
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      const dist = 14 + row * gap;
      const t = ((1 - dist / this.length) % 1 + 1) % 1;
      const p = this.pointAt(t);
      const right = this.rightAt(t, new THREE.Vector3());
      const up = this.upAt(t, new THREE.Vector3());
      p.addScaledVector(right, side * this.widthAt(t) * 0.36).addScaledVector(up, 0.06);
      out.push({ position: p, quaternion: this.orientationAt(t) });
    }
    return out;
  }

  /** World transform for a (t, lateral) pair — used by teleport/reset. */
  placeAt(t, lateral = 0, yOffset = 0.6) {
    const p = this.pointAt(t);
    const tan = this.tangentAt(t, new THREE.Vector3());
    const right = this.rightAt(t, new THREE.Vector3());
    const up = this.upAt(t, new THREE.Vector3());
    p.addScaledVector(right, lateral).addScaledVector(up, yOffset);
    return { position: p, quaternion: this.orientationAt(t), tangent: tan };
  }

  /** Is this arc position inside a tunnel? 0..1 (fades at the mouths). */
  tunnelAt(t) {
    return this._s1(this.features.tunnel, t);
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
