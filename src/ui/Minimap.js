/**
 * Circuit minimap.
 *
 * The centreline is sampled once from `world.track` (CONTRACTS.md §7), projected to XZ, fitted
 * into the map box and emitted as a single SVG path. Cars are a fixed pool of markers created up
 * front; per frame we only write `style.transform` on them, so the map costs nothing.
 *
 * North-up and static rather than heading-up: this is a closed circuit and a stable shape is
 * something the driver can learn, which is the entire point of a minimap.
 */

const VW = 132; // viewBox units
const VH = 104;
const PAD = 12;

export class Minimap {
  constructor() {
    this.ok = false;
    this.scale = 1;
    this.ox = 0;
    this.oz = 0;
    this.cx = VW / 2;
    this.cy = VH / 2;
    this.samples = 256;
  }

  /** @returns {string} SVG markup, or a placeholder if the track isn't available. */
  build(track, poolSize = 12) {
    let d = '';
    let ticks = '';
    if (track?.pointAt) {
      const N = this.samples;
      const xs = new Float32Array(N);
      const zs = new Float32Array(N);
      const p = { x: 0, y: 0, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } };
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < N; i++) {
        track.pointAt(i / N, p);
        xs[i] = p.x;
        zs[i] = p.z;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
      const w = Math.max(maxX - minX, 1);
      const h = Math.max(maxZ - minZ, 1);
      const s = Math.min((VW - PAD * 2) / w, (VH - PAD * 2) / h);
      this.scale = s;
      this.ox = (minX + maxX) / 2;
      this.oz = (minZ + maxZ) / 2;
      this.ok = true;

      for (let i = 0; i < N; i++) {
        const x = (xs[i] - this.ox) * s + this.cx;
        const y = (zs[i] - this.oz) * s + this.cy;
        d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      d += 'Z';

      // start / finish gate — a tick perpendicular to the centreline at t = 0
      const dx = xs[1] - xs[0];
      const dz = zs[1] - zs[0];
      const len = Math.hypot(dx, dz) || 1;
      const nx = (-dz / len) * 5.2;
      const nz = (dx / len) * 5.2;
      const gx = (xs[0] - this.ox) * s + this.cx;
      const gy = (zs[0] - this.oz) * s + this.cy;
      ticks =
        `<line class="mm-start" x1="${(gx - nx).toFixed(1)}" y1="${(gy - nz).toFixed(1)}" ` +
        `x2="${(gx + nx).toFixed(1)}" y2="${(gy + nz).toFixed(1)}"/>`;
    } else {
      d = `M${PAD} ${VH - PAD}L${VW - PAD} ${PAD}`;
    }

    let pool = '';
    for (let i = 0; i < poolSize; i++) {
      pool +=
        `<g class="mm-car" data-i="${i}">` +
        `<circle class="mm-car-ring" r="3.6"/><circle class="mm-car-dot" r="2.0"/></g>`;
    }

    return `<svg class="mm" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMid meet">
  <path class="mm-case"  d="${d}"/>
  <path class="mm-road"  d="${d}"/>
  <path class="mm-prog"  id="mm-prog" d="${d}"/>
  ${ticks}
  <g class="mm-cars">${pool}</g>
  <g class="mm-me" id="mm-me"><path class="mm-me-halo" d="M0 -7.6L5.4 5.2L0 2.2L-5.4 5.2Z"/><path class="mm-me-arrow" d="M0 -6.4L4.4 4.4L0 1.9L-4.4 4.4Z"/></g>
</svg>`;
  }

  /** World XZ -> map user units. Writes into `out`; allocates nothing. */
  project(x, z, out) {
    out.x = (x - this.ox) * this.scale + this.cx;
    out.y = (z - this.oz) * this.scale + this.cy;
    return out;
  }
}
