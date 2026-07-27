import * as THREE from 'three';
import { makeRng } from '../../core/MathX.js';

/**
 * The city's own texture set. Everything is drawn into an offscreen canvas at boot — no files,
 * no fetches (CONTRACTS.md §0). We route through `assets.canvas()` when it exists so the cache
 * and anisotropy policy stay centralised (§5), with a local fallback so a signature change in
 * the materials lane can't take the city down.
 *
 * Deliberately small: four textures total. Surface variety comes from the vertex stream and
 * from procedural patterns in the shader, not from a pile of 2048² canvases.
 */

/** Invented brands only — no real-world trademarks anywhere in this file. */
const SIGN_COPY = [
  { t: 'NOX RAMEN', c: '#ff2d6f', bg: '#140409', style: 'neon' },
  { t: 'HYPERCELL', c: '#4fd8ff', bg: '#04101a', style: 'neon' },
  { t: 'VYNL BAR', c: '#ff8a2b', bg: '#160b03', style: 'box' },
  { t: 'ZEN—9', c: '#8affc1', bg: '#03120a', style: 'neon' },
  { t: 'ORBIT MOTORS', c: '#ffd24a', bg: '#181203', style: 'box' },
  { t: 'GRID CAFE', c: '#ff4d4d', bg: '#150404', style: 'neon' },
  { t: 'TURBO WASH', c: '#5ea8ff', bg: '#05091a', style: 'box' },
  { t: 'APEX TYRES', c: '#ffffff', bg: '#0a0a0c', style: 'box' },
  { t: 'MIDNIGHT OIL', c: '#c77dff', bg: '#0d0518', style: 'neon' },
  { t: 'RAMEN 88', c: '#ff3b3b', bg: '#170303', style: 'vert' },
  { t: 'KODA MART', c: '#7dffb0', bg: '#04140b', style: 'box' },
  { t: 'HEX FUEL', c: '#ffb03a', bg: '#150d02', style: 'box' },
  { t: 'NOVA LOUNGE', c: '#ff6ad5', bg: '#150418', style: 'neon' },
  { t: 'BYTE BURGER', c: '#ffe06a', bg: '#161001', style: 'box' },
  { t: 'SYNTH CITY', c: '#37f2ff', bg: '#021015', style: 'neon' },
  { t: 'OCTANE', c: '#ff5722', bg: '#140602', style: 'box' },
  { t: 'CHROME ALLEY', c: '#d8e6ff', bg: '#070a10', style: 'neon' },
  { t: 'AURA SPA', c: '#a0ffe8', bg: '#031412', style: 'vert' },
  { t: 'VERTEX', c: '#9fb6ff', bg: '#05070f', style: 'box' },
  { t: 'NIGHTSHIFT', c: '#ff2f5e', bg: '#12030a', style: 'neon' },
  { t: 'K-9 NOODLE', c: '#ffcc33', bg: '#150f02', style: 'vert' },
  { t: 'PIXEL PAWN', c: '#66ff8c', bg: '#03130a', style: 'neon' },
  { t: 'VOLT DINER', c: '#ff9c3d', bg: '#150a02', style: 'box' },
  { t: 'ARCADIA', c: '#e0aaff', bg: '#0c0416', style: 'neon' },
];

const BILLBOARD_COPY = [
  { head: 'TOKEN', sub: 'DRIVE THE CHAIN', a: '#ff3d6e', b: '#2b0b18' },
  { head: 'NEO—SAKE', sub: 'BREWED AFTER DARK', a: '#5ce1ff', b: '#04202b' },
  { head: 'APEX 9', sub: 'TYRES THAT BITE', a: '#ffd12e', b: '#241a02' },
  { head: 'GLITCH', sub: 'CLUB · LEVEL 4', a: '#c86bff', b: '#1a0a2b' },
];

export class CityTextures {
  constructor(ctx) {
    this.ctx = ctx;
    this.rng = makeRng(0x51713d);
    this.map = new Map();
  }

  _canvas(w, h, draw, opts = {}) {
    const assets = this.ctx.assets;
    if (assets?.canvas) {
      try {
        return assets.canvas(w, h, draw, opts);
      } catch {
        /* fall through to the local path */
      }
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = opts.wrap ?? THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t;
  }

  build() {
    const S = Math.min(1024, Math.max(512, this.ctx.settings?.get('textureSize') ?? 1024));
    this.grain = this._grain(S);
    this.grainNormal = this._grainNormal(512);
    this.signs = this._signAtlas();
    this.foliage = this._foliage(S);
    this.glow = this._glow(128);
    return this;
  }

  // ------------------------------------------------------------------ surfaces
  /**
   * Near-white detail albedo. Kept high-key on purpose: vertex colour is the real albedo,
   * this only supplies grain, streaking and edge dirt so big flat walls don't band.
   */
  _grain(S) {
    const rng = this.rng;
    return this._canvas(S, S, (g, w, h) => {
      g.fillStyle = '#c9c9c9';
      g.fillRect(0, 0, w, h);
      // fine speckle
      const img = g.getImageData(0, 0, w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const n = (rng() - 0.5) * 26;
        d[i] += n;
        d[i + 1] += n;
        d[i + 2] += n * 1.04;
      }
      g.putImageData(img, 0, 0);
      // blotchy weathering
      for (let i = 0; i < 220; i++) {
        const r = 8 + rng() * S * 0.16;
        const x = rng() * w;
        const y = rng() * h;
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        const v = rng() < 0.5 ? 0 : 255;
        grd.addColorStop(0, `rgba(${v},${v},${v},${0.03 + rng() * 0.07})`);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.beginPath();
        g.arc(x, y, r, 0, 7);
        g.fill();
      }
      // vertical rain streaking — the thing that makes concrete read as "outdoors"
      g.globalAlpha = 1;
      for (let i = 0; i < S * 0.9; i++) {
        const x = rng() * w;
        const y = rng() * h;
        const len = 12 + rng() * S * 0.42;
        const a = 0.02 + rng() * 0.06;
        const grd = g.createLinearGradient(x, y, x, y + len);
        grd.addColorStop(0, `rgba(70,68,66,${a})`);
        grd.addColorStop(1, 'rgba(70,68,66,0)');
        g.fillStyle = grd;
        g.fillRect(x, y, 1 + rng() * 2.2, len);
      }
    });
  }

  _grainNormal(S) {
    const rng = makeRng(0x2f7c11);
    const out = new Uint8Array(S * S * 4);
    const height = new Float32Array(S * S);
    for (let i = 0; i < height.length; i++) height[i] = rng();
    // two octaves of blur -> soft bumps
    const blur = (src, r) => {
      const dst = new Float32Array(src.length);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          let s = 0;
          let n = 0;
          for (let dy = -r; dy <= r; dy += 1)
            for (let dx = -r; dx <= r; dx += 1) {
              s += src[((y + dy + S) % S) * S + ((x + dx + S) % S)];
              n++;
            }
          dst[y * S + x] = s / n;
        }
      }
      return dst;
    };
    const a = blur(height, 1);
    const b = blur(a, 3);
    for (let i = 0; i < height.length; i++) height[i] = a[i] * 0.6 + b[i] * 0.4;
    const at = (x, y) => height[((y + S) % S) * S + ((x + S) % S)];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * 2.4;
        const dy = (at(x, y + 1) - at(x, y - 1)) * 2.4;
        let nx = -dx,
          ny = -dy,
          nz = 1;
        const l = Math.hypot(nx, ny, nz);
        const i = (y * S + x) * 4;
        out[i] = ((nx / l) * 0.5 + 0.5) * 255;
        out[i + 1] = ((ny / l) * 0.5 + 0.5) * 255;
        out[i + 2] = ((nz / l) * 0.5 + 0.5) * 255;
        out[i + 3] = 255;
      }
    }
    const t = new THREE.DataTexture(out, S, S, THREE.RGBAFormat);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  // ------------------------------------------------------------------ signage
  /**
   * 2048×1024. Rows 0-2: 24 shop signs at 256². Row 3: 4 billboards at 512×256.
   * Rects are exposed through `signRect(i)` / `billboardRect(i)`.
   */
  _signAtlas() {
    const W = 2048;
    const H = 1024;
    const rng = makeRng(0x9a17e2);
    return this._canvas(
      W,
      H,
      (g) => {
        g.fillStyle = '#000000';
        g.fillRect(0, 0, W, H);
        for (let i = 0; i < SIGN_COPY.length; i++) {
          const cx = (i % 8) * 256;
          const cy = Math.floor(i / 8) * 256;
          drawSign(g, cx, cy, 256, 256, SIGN_COPY[i], rng);
        }
        for (let i = 0; i < BILLBOARD_COPY.length; i++) {
          drawBillboard(g, i * 512, 768, 512, 256, BILLBOARD_COPY[i], rng);
        }
      },
      { wrap: THREE.ClampToEdgeWrapping }
    );
  }

  static get signCount() {
    return SIGN_COPY.length;
  }
  static get billboardCount() {
    return BILLBOARD_COPY.length;
  }
  /** UV rect for shop sign `i`. Slight inset avoids bleeding from the neighbouring cell. */
  static signRect(i) {
    const n = i % SIGN_COPY.length;
    const cx = (n % 8) * 256;
    const cy = Math.floor(n / 8) * 256;
    const p = 3;
    return {
      u0: (cx + p) / 2048,
      v0: 1 - (cy + 256 - p) / 1024,
      u1: (cx + 256 - p) / 2048,
      v1: 1 - (cy + p) / 1024,
      aspect: 1,
    };
  }
  static billboardRect(i) {
    const n = i % BILLBOARD_COPY.length;
    const cx = n * 512;
    const cy = 768;
    const p = 3;
    return {
      u0: (cx + p) / 2048,
      v0: 1 - (cy + 256 - p) / 1024,
      u1: (cx + 512 - p) / 2048,
      v1: 1 - (cy + p) / 1024,
      aspect: 2,
    };
  }
  /** Signs whose copy reads top-to-bottom — used for blade signs hung off a facade. */
  static isVertical(i) {
    return SIGN_COPY[i % SIGN_COPY.length].style === 'vert';
  }

  // ------------------------------------------------------------------ vegetation
  /**
   * 4×4 atlas of foliage clusters, alpha-tested.
   *
   *   0-7   canopy variants — density, leaf size, hue and silhouette all differ
   *   8-11  shrubs / hedges
   *   12-15 grass and ground scrub
   *
   * Two things matter here beyond "more cells". First, EIGHT canopies rather than two: a street
   * planted from a library of two assets is read as repetition within about three trees, and no
   * amount of per-instance tinting hides it. Second, every clump is drawn twice — once as a
   * blurred shadow of itself, once solid — so the cluster silhouette carries a soft ALPHA RAMP
   * a few pixels wide instead of a binary edge. The foliage shader dithers its alpha threshold
   * across that ramp (see CityMaterials), and a ramp is the thing it needs to dither across;
   * against a hard cutout there is nothing to soften and leaves stay cardboard.
   */
  _foliage(S) {
    const rng = makeRng(0x3c9911);
    return this._canvas(
      S,
      S,
      (g, w, h) => {
        g.clearRect(0, 0, w, h);
        const C = S / 4; // cell size
        const soft = Math.max(2, C * 0.022);

        /** One leaf clump: ragged polygon, never a circle — circles read as cotton wool. */
        const clump = (x, y, rr, squash, hue, sat, l, pts) => {
          g.beginPath();
          for (let k = 0; k <= pts; k++) {
            const ka = (k / pts) * Math.PI * 2;
            const kr = rr * (0.55 + rng() * 0.8);
            const px = x + Math.cos(ka) * kr;
            const py = y + Math.sin(ka) * kr * squash;
            if (k === 0) g.moveTo(px, py);
            else g.lineTo(px, py);
          }
          g.closePath();
          g.fillStyle = `hsl(${hue},${sat}%,${l}%)`;
          g.fill();
        };

        /**
         * @param cell  atlas index
         * @param o     hue/sat/count/spread/rad/squash/droop/pts — the shape DNA of one variant
         */
        const canopy = (cell, o) => {
          const ox = (cell % 4) * C;
          const oy = Math.floor(cell / 4) * C;
          g.save();
          g.beginPath();
          g.rect(ox, oy, C, C);
          g.clip();
          for (let i = 0; i < o.count; i++) {
            const a = rng() * Math.PI * 2;
            const r = Math.pow(rng(), o.pack ?? 0.6) * o.spread * C;
            const x = ox + C * 0.5 + Math.cos(a) * r;
            const y = oy + C * (0.52 + (o.droop ?? 0) * (Math.sin(a) * 0.5 + 0.5)) + Math.sin(a) * r * 0.85;
            const rr = o.rad * C * (0.5 + rng() * 0.9);
            // darker toward the middle of the crown: fake self-occlusion baked into the card
            const shade = (r / (o.spread * C)) * 7;
            const l = o.l - 10 + rng() * 15 + shade;
            clump(x, y, rr, o.squash ?? 0.8, o.hue + rng() * 20 - 10, o.sat, l, o.pts ?? 7);
          }
          g.restore();
        };

        const grass = (cell, o) => {
          const ox = (cell % 4) * C;
          const oy = Math.floor(cell / 4) * C;
          g.save();
          g.beginPath();
          g.rect(ox, oy, C, C);
          g.clip();
          g.lineCap = 'round';
          for (let i = 0; i < o.count; i++) {
            const x = ox + C * 0.5 + (rng() - 0.5) * C * o.spread;
            const hgt = C * (o.h0 + rng() * o.h1);
            const lean = (rng() - 0.5) * C * o.lean;
            g.strokeStyle = `hsl(${o.hue + rng() * 26},${o.sat + rng() * 22}%,${o.l + rng() * 22}%)`;
            g.lineWidth = o.wid * (0.6 + rng() * 1.6);
            g.beginPath();
            g.moveTo(x, oy + C * 0.97);
            g.quadraticCurveTo(x + lean * 0.4, oy + C * 0.97 - hgt * 0.6, x + lean, oy + C * 0.97 - hgt);
            g.stroke();
          }
          g.restore();
        };

        // ---- canopies 0-7
        canopy(0, { hue: 96, sat: 42, count: 300, spread: 0.42, rad: 0.045, l: 20 }); // dense broadleaf
        canopy(1, { hue: 78, sat: 34, count: 190, spread: 0.44, rad: 0.058, l: 24, pack: 0.5 }); // loose olive
        canopy(2, { hue: 104, sat: 30, count: 160, spread: 0.36, rad: 0.037, l: 19, pts: 9 }); // ornamental
        canopy(3, { hue: 128, sat: 26, count: 240, spread: 0.40, rad: 0.034, l: 14, squash: 1.1 }); // dark conifer
        canopy(4, { hue: 68, sat: 48, count: 150, spread: 0.45, rad: 0.070, l: 26, pts: 6 }); // broad maple
        canopy(5, { hue: 88, sat: 36, count: 210, spread: 0.46, rad: 0.030, l: 23, droop: 0.16, squash: 1.25 }); // willow
        canopy(6, { hue: 48, sat: 52, count: 190, spread: 0.41, rad: 0.048, l: 26 }); // autumn / dusty gold
        canopy(7, { hue: 148, sat: 22, count: 230, spread: 0.39, rad: 0.041, l: 18, pack: 0.75 }); // blue-green
        // ---- shrubs 8-11
        canopy(8, { hue: 92, sat: 34, count: 190, spread: 0.44, rad: 0.044, l: 18, squash: 0.62 });
        canopy(9, { hue: 84, sat: 42, count: 130, spread: 0.46, rad: 0.056, l: 22, squash: 0.58, pack: 0.5 });
        canopy(10, { hue: 100, sat: 30, count: 260, spread: 0.47, rad: 0.032, l: 15, squash: 0.55 }); // clipped hedge
        canopy(11, { hue: 112, sat: 38, count: 120, spread: 0.43, rad: 0.062, l: 20, squash: 0.7, pts: 5 }); // fern
        // ---- grass 12-15
        grass(12, { hue: 74, sat: 26, l: 16, count: 150, spread: 0.86, h0: 0.3, h1: 0.62, lean: 0.22, wid: C * 0.012 });
        grass(13, { hue: 84, sat: 30, l: 18, count: 120, spread: 0.7, h0: 0.42, h1: 0.5, lean: 0.3, wid: C * 0.009 });
        grass(14, { hue: 46, sat: 30, l: 26, count: 110, spread: 0.9, h0: 0.24, h1: 0.42, lean: 0.34, wid: C * 0.014 }); // dry
        grass(15, { hue: 104, sat: 24, l: 14, count: 170, spread: 0.95, h0: 0.16, h1: 0.3, lean: 0.18, wid: C * 0.016 }); // scrub

        softenAlpha(g, S, Math.max(1, Math.round(soft)));
      },
      { wrap: THREE.ClampToEdgeWrapping }
    );
  }

  static get canopyCount() {
    return 8;
  }
  static get shrubCount() {
    return 4;
  }
  static get grassCount() {
    return 4;
  }
  /** UV rect for atlas cell `i` of the 4×4 foliage sheet. */
  static foliageRect(i) {
    const n = ((i % 16) + 16) % 16;
    const cx = (n % 4) * 0.25;
    const cy = Math.floor(n / 4) * 0.25;
    const p = 0.002;
    return { u0: cx + p, v0: 1 - (cy + 0.25) + p, u1: cx + 0.25 - p, v1: 1 - cy - p };
  }
  static canopyRect(i) {
    return CityTextures.foliageRect(((i % 8) + 8) % 8);
  }
  static shrubRect(i) {
    return CityTextures.foliageRect(8 + (((i % 4) + 4) % 4));
  }
  static grassRect(i) {
    return CityTextures.foliageRect(12 + (((i % 4) + 4) % 4));
  }

  // ------------------------------------------------------------------ glow
  _glow(S) {
    return this._canvas(
      S,
      S,
      (g, w, h) => {
        g.clearRect(0, 0, w, h);
        const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
        grd.addColorStop(0, 'rgba(255,255,255,1)');
        grd.addColorStop(0.12, 'rgba(255,255,255,0.72)');
        grd.addColorStop(0.34, 'rgba(255,255,255,0.22)');
        grd.addColorStop(0.66, 'rgba(255,255,255,0.05)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, w, h);
      },
      { wrap: THREE.ClampToEdgeWrapping }
    );
  }

  dispose() {
    for (const t of [this.grain, this.grainNormal, this.signs, this.foliage, this.glow]) t?.dispose?.();
  }
}

// ---------------------------------------------------------------------- drawing helpers

/**
 * Give a hard-edged cutout a soft alpha ramp, in one pass over the finished atlas.
 *
 * Why not `ctx.shadowBlur` per clump: it is a full-canvas filter each time it is used, so a few
 * thousand leaf clumps at 1024² is tens of seconds of boot. This is two separable box blurs over
 * the buffer — a handful of milliseconds — and it is also more correct, because it blurs the
 * PREMULTIPLIED colour and divides back out. Blurring straight RGBA instead would drag the
 * transparent black outside the silhouette inward and fringe every leaf with a dark halo.
 *
 * The result is an alpha ramp `r` pixels wide around every cluster. That ramp is what the
 * foliage shader's dithered alpha threshold works across; without it there is nothing to
 * dither and the cutout stays a cardboard edge.
 */
function softenAlpha(g, S, r) {
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  const n = S * S;
  const src = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255;
    src[i * 4] = (d[i * 4] / 255) * a;
    src[i * 4 + 1] = (d[i * 4 + 1] / 255) * a;
    src[i * 4 + 2] = (d[i * 4 + 2] / 255) * a;
    src[i * 4 + 3] = a;
  }
  const tmp = new Float32Array(n * 4);
  const win = r * 2 + 1;
  // horizontal
  for (let y = 0; y < S; y++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[(y * S + clampI(k, S)) * 4 + c];
      for (let x = 0; x < S; x++) {
        tmp[(y * S + x) * 4 + c] = sum / win;
        sum += src[(y * S + clampI(x + r + 1, S)) * 4 + c] - src[(y * S + clampI(x - r, S)) * 4 + c];
      }
    }
  }
  // vertical
  const out = src; // reuse
  for (let x = 0; x < S; x++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[(clampI(k, S) * S + x) * 4 + c];
      for (let y = 0; y < S; y++) {
        out[(y * S + x) * 4 + c] = sum / win;
        sum += tmp[(clampI(y + r + 1, S) * S + x) * 4 + c] - tmp[(clampI(y - r, S) * S + x) * 4 + c];
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const aS = d[i * 4 + 3] / 255;
    const aB = out[i * 4 + 3];
    if (aB < 0.002) continue;
    const inv = 1 / aB;
    // un-premultiply the blurred colour, then keep the crisp interior and only let the blur
    // supply the rim
    for (let c = 0; c < 3; c++) {
      const bc = Math.min(1, out[i * 4 + c] * inv) * 255;
      d[i * 4 + c] = aS * d[i * 4 + c] + (1 - aS) * bc;
    }
    // Take the blurred alpha OUTRIGHT rather than max()-ing it with the source. A box blur of a
    // binary mask is 0.5 exactly on the original boundary, so the ramp straddles the silhouette
    // instead of growing outward from it — max() would inflate every canopy by the blur radius
    // and turn the dither into a fuzzy halo.
    d[i * 4 + 3] = Math.min(255, aB * 255);
  }
  g.putImageData(img, 0, 0);
}
function clampI(v, S) {
  return v < 0 ? 0 : v >= S ? S - 1 : v;
}

const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

function drawSign(g, x, y, w, h, def, rng) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.translate(x, y);

  // panel
  g.fillStyle = def.bg;
  g.fillRect(0, 0, w, h);
  // subtle panel noise so the sign face isn't a flat swatch
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(255,255,255,${rng() * 0.03})`;
    g.fillRect(rng() * w, rng() * h, 1 + rng() * 3, 1 + rng() * 3);
  }

  if (def.style === 'neon') {
    // tube border
    g.strokeStyle = def.c;
    g.shadowColor = def.c;
    g.shadowBlur = 26;
    g.lineWidth = 4;
    g.strokeRect(11, 11, w - 22, h - 22);
    g.shadowBlur = 0;
    g.lineWidth = 1.6;
    g.strokeStyle = '#ffffff';
    g.strokeRect(11, 11, w - 22, h - 22);
  } else if (def.style === 'box') {
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(8, 8, w - 16, h - 16);
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 2;
    g.strokeRect(8, 8, w - 16, h - 16);
  }

  const vertical = def.style === 'vert';
  const words = vertical ? def.t.split('') : def.t.split(' ');
  const lines = vertical ? words : chunkWords(words);

  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const usable = h - (vertical ? 26 : 54);
  const lh = usable / lines.length;
  const size = Math.min(vertical ? lh * 0.82 : lh * 0.9, w * (vertical ? 0.5 : 0.86 / maxLen(lines)) * 1.85);
  g.font = `700 ${Math.max(14, size).toFixed(0)}px ${FONT}`;

  for (let i = 0; i < lines.length; i++) {
    const cy = (vertical ? 13 : 27) + lh * (i + 0.5);
    // glow pass
    g.shadowColor = def.c;
    g.shadowBlur = 30;
    g.fillStyle = def.c;
    g.fillText(lines[i], w / 2, cy);
    g.shadowBlur = 14;
    g.fillText(lines[i], w / 2, cy);
    // hot core
    g.shadowBlur = 0;
    g.fillStyle = mixHex(def.c, '#ffffff', 0.68);
    g.fillText(lines[i], w / 2, cy);
  }
  g.shadowBlur = 0;

  // grime along the bottom edge
  const grd = g.createLinearGradient(0, h * 0.72, 0, h);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = grd;
  g.fillRect(0, h * 0.72, w, h * 0.28);
  g.restore();
}

function drawBillboard(g, x, y, w, h, def, rng) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.translate(x, y);

  const grd = g.createLinearGradient(0, 0, w, h);
  grd.addColorStop(0, def.b);
  grd.addColorStop(1, '#05060a');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);

  // abstract graphic — swooping speed arcs, no borrowed imagery
  g.globalAlpha = 0.85;
  for (let i = 0; i < 7; i++) {
    g.strokeStyle = i % 2 ? def.a : '#ffffff';
    g.globalAlpha = 0.1 + rng() * 0.28;
    g.lineWidth = 2 + rng() * 16;
    g.beginPath();
    const yy = h * (0.15 + rng() * 0.8);
    g.moveTo(-20, yy);
    g.bezierCurveTo(w * 0.3, yy - h * 0.4, w * 0.7, yy + h * 0.35, w + 20, yy - h * 0.1);
    g.stroke();
  }
  g.globalAlpha = 1;

  // vignette so the type reads
  const vg = g.createLinearGradient(0, 0, 0, h);
  vg.addColorStop(0, 'rgba(0,0,0,0.15)');
  vg.addColorStop(0.55, 'rgba(0,0,0,0.55)');
  vg.addColorStop(1, 'rgba(0,0,0,0.2)');
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);

  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.font = `800 ${Math.round(h * 0.36)}px ${FONT}`;
  g.shadowColor = def.a;
  g.shadowBlur = 34;
  g.fillStyle = def.a;
  g.fillText(def.head, w * 0.07, h * 0.55);
  g.shadowBlur = 0;
  g.fillStyle = '#ffffff';
  g.fillText(def.head, w * 0.07, h * 0.55);

  g.font = `600 ${Math.round(h * 0.115)}px ${FONT}`;
  g.fillStyle = 'rgba(255,255,255,0.86)';
  g.letterSpacing = '3px';
  g.fillText(def.sub, w * 0.075, h * 0.72);

  g.strokeStyle = 'rgba(255,255,255,0.3)';
  g.lineWidth = 3;
  g.strokeRect(5, 5, w - 10, h - 10);
  g.restore();
}

function chunkWords(words) {
  if (words.length <= 1) return words;
  if (words.length === 2) return words;
  return [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')];
}
function maxLen(lines) {
  return Math.max(3, ...lines.map((l) => l.length));
}
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const m = (sh) => {
    const x = (pa >> sh) & 255;
    const y = (pb >> sh) & 255;
    return Math.round(x + (y - x) * t);
  };
  return `rgb(${m(16)},${m(8)},${m(0)})`;
}
