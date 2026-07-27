import * as THREE from 'three';

/**
 * Low-level geometry accumulator for the CITY lane.
 *
 * Everything the city draws goes through one of a handful of shared materials, so surface
 * variety has to travel *inside* the vertex stream rather than in a material switch. Every
 * vertex therefore carries:
 *
 *   position / normal / uv   — standard
 *   color                    — linear-space albedo tint (vertexColors)
 *   aKind                    — surface archetype, see KIND below. Drives the procedural
 *                              pattern, roughness/metalness and emissive branch in the shader.
 *   aSeed                    — 0..1 per-surface random. Randomises which windows are lit,
 *                              neon flicker phase, grime, etc.
 *   aFeat                    — the SMALLEST world-space extent of the face this vertex belongs
 *                              to, in metres. The facade kit is built from real proud geometry:
 *                              50 mm barrier rails, 70 mm handrails, 110 mm sill lips, 180 mm
 *                              mullions. There is no MSAA and no TAA in this pipeline
 *                              (Settings: msaa 0), so once one of those is thinner than a pixel
 *                              a point-sampled specular lobe spikes to full white and the
 *                              facade grows crawling bright horizontal bands. Screen-space
 *                              derivatives cannot see across a primitive edge, so normal-variance
 *                              specular AA alone cannot fix it — the shader needs to be told how
 *                              big the feature actually is. CityMaterials compares aFeat against
 *                              the pixel footprint and widens the specular lobe toward diffuse
 *                              once the face stops being resolvable. 0 means "unknown", which
 *                              the shader reads as "fully resolved" so a missing attribute is
 *                              harmless.
 *
 * That combination lets a whole building — concrete, brick, glass, neon strip, steel rail —
 * live in a single draw call.
 */

export const KIND = {
  SURFACE: 0, // plain painted / rendered surface
  GLASS: 1, // window glass. Lit at night, randomised per aSeed
  NEON: 2, // always emissive (signage tubes, brake-light-red channel letters)
  LAMP: 3, // emissive only at night (street lamp lens, shop strip lights)
  METAL: 4, // steel, aluminium — low roughness, metallic
  BRICK: 5, // procedural brick coursing from uv
  CORRUGATED: 6, // procedural vertical corrugation
  PANEL: 7, // procedural precast panel seams
  FARFACADE: 8, // procedural window grid — LOD/backdrop buildings, emissive at night
  TILE: 9, // procedural square tiling (tunnel walls)
  ROAD: 10, // tarmac / pavement — reacts to env.wetness
  DARKGLASS: 11, // glass that never lights (shopfront at night is handled by LAMP strips)
  CONCRETE: 12, // rough poured concrete with subtle streaking
  FOLIAGE: 13, // used by the vegetation material only
  TUNNEL: 14, // tunnel structure — concrete that receives the enclosed-bounce fill
  // --- urban ground family. uv is in METRES, so every pattern below is at real-world scale.
  PAVEMENT: 15, // flagged sidewalk — slab joints, grime toward the kerb
  LOT: 16, // parking lot: cracked asphalt with painted bays and aisles
  DIRT: 17, // unmade ground — dirt/gravel yard, tyre tracks
  TURF: 18, // deliberate green space — mown grass with mower stripes
  KERB: 19, // kerb top/face — pale precast, occasionally painted
  SERVICE: 20, // service road / alley — asphalt with a dashed centre line
  SLAB: 21, // poured concrete hardstanding — big 4.5 x 6 m bays, not sidewalk flags
  REVEAL: 22, // window reveal: sill top, soffit and jamb faces. Plain wall by day; at night it
  //             catches the spill from the lit room behind it, which is the cue that says the
  //             glow is a light source in a volume rather than a sticker on a wall.
};

const _m4 = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _nrm = new THREE.Vector3();

const _colCache = new Map();
/** hex (sRGB) -> linear [r,g,b]; cached because we call this tens of thousands of times. */
export function col(hex) {
  let c = _colCache.get(hex);
  if (!c) {
    const t = new THREE.Color(hex);
    c = [t.r, t.g, t.b];
    _colCache.set(hex, c);
  }
  return c;
}

/** Multiply a cached colour by a scalar without allocating a THREE.Color. */
export function tint(hex, mul) {
  const c = col(hex);
  return [c[0] * mul, c[1] * mul, c[2] * mul];
}

export class GeoBuilder {
  constructor() {
    this.p = [];
    this.n = [];
    this.u = [];
    this.c = [];
    this.k = [];
    this.s = [];
    this.f = [];
    this.idx = [];
    this._stack = [];
    this._m = new THREE.Matrix4();
    this._n3 = new THREE.Matrix3().identity();
    this._hasM = false;
  }

  get vertexCount() {
    return this.p.length / 3;
  }
  get triangleCount() {
    return this.idx.length / 3;
  }
  get isEmpty() {
    return this.idx.length === 0;
  }

  push(matrix) {
    this._stack.push(this._m.clone());
    this._m.multiply(matrix);
    this._n3.getNormalMatrix(this._m);
    this._hasM = true;
    return this;
  }
  pop() {
    this._m.copy(this._stack.pop() || _m4.identity());
    this._n3.getNormalMatrix(this._m);
    this._hasM = this._stack.length > 0 || !isIdentity(this._m);
    return this;
  }
  /** Convenience: push a TRS frame. */
  pushTRS(pos, quat, scale) {
    return this.push(
      _m4.compose(
        pos || _va.set(0, 0, 0),
        quat || _idq,
        scale || _one
      )
    );
  }

  vert(x, y, z, nx, ny, nz, u, v, c, kind, seed, feat = 0) {
    if (this._hasM) {
      _va.set(x, y, z).applyMatrix4(this._m);
      _vb.set(nx, ny, nz).applyMatrix3(this._n3).normalize();
      x = _va.x;
      y = _va.y;
      z = _va.z;
      nx = _vb.x;
      ny = _vb.y;
      nz = _vb.z;
    }
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.u.push(u, v);
    this.c.push(c[0], c[1], c[2]);
    this.k.push(kind);
    this.s.push(seed);
    this.f.push(feat);
    return this.vertexCount - 1;
  }

  /**
   * Quad from four corners, CCW seen from the front. `uv` is [u0,v0,u1,v1] in *metres*;
   * the shader divides by the material's tiling scale.
   */
  quad(a, b, c, d, o = {}) {
    const color = o.color || WHITE;
    const kind = o.kind ?? KIND.SURFACE;
    const seed = o.seed ?? 0;
    _e1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    _e2.set(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    _nrm.crossVectors(_e1, _e2).normalize();
    if (!Number.isFinite(_nrm.x) || _nrm.lengthSq() < 0.5) _nrm.set(0, 1, 0);
    const w = o.w ?? _e1.length();
    const h = o.h ?? _e2.length();
    const u0 = o.u0 ?? 0;
    const v0 = o.v0 ?? 0;
    const nx = _nrm.x,
      ny = _nrm.y,
      nz = _nrm.z;
    // Feature size = the narrow dimension of the face. For a box side this is the box's
    // thinnest axis, which is exactly what has to survive being rasterised at 200 m.
    const feat = o.feat ?? Math.min(Math.abs(w), Math.abs(h));
    const base = this.vertexCount;
    this.vert(a[0], a[1], a[2], nx, ny, nz, u0, v0, color, kind, seed, feat);
    this.vert(b[0], b[1], b[2], nx, ny, nz, u0 + w, v0, color, kind, seed, feat);
    this.vert(c[0], c[1], c[2], nx, ny, nz, u0 + w, v0 + h, color, kind, seed, feat);
    this.vert(d[0], d[1], d[2], nx, ny, nz, u0, v0 + h, color, kind, seed, feat);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return this;
  }

  /**
   * Axis-aligned box centred at (cx,cy,cz). `faces` is a bitmask:
   * 1 +X, 2 -X, 4 +Y, 8 -Y, 16 +Z, 32 -Z. Default 63 = all.
   * Dropping hidden faces is the single cheapest triangle saving in the whole city.
   *
   * `kindX` / `kindY` override `kind` on the side and the top/bottom faces respectively. The
   * facade kit uses this to tag *only* the faces that form a window reveal (the underside of a
   * spandrel band, the top of the one below it, the flanks of the piers) without splitting the
   * band into separate primitives — same triangle count, one extra shader branch.
   */
  box(cx, cy, cz, sx, sy, sz, o = {}) {
    const faces = o.faces ?? 63;
    const kX = o.kindX ?? o.kind;
    const kY = o.kindY ?? o.kind;
    const hx = sx * 0.5,
      hy = sy * 0.5,
      hz = sz * 0.5;
    const x0 = cx - hx,
      x1 = cx + hx,
      y0 = cy - hy,
      y1 = cy + hy,
      z0 = cz - hz,
      z1 = cz + hz;
    const uo = o.uOff ?? 0;
    const vo = o.vOff ?? 0;
    if (faces & 1)
      this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], {
        ...o,
        kind: kX,
        w: sz,
        h: sy,
        u0: uo,
        v0: vo,
      });
    if (faces & 2)
      this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], {
        ...o,
        kind: kX,
        w: sz,
        h: sy,
        u0: uo,
        v0: vo,
      });
    if (faces & 4)
      this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], {
        ...o,
        kind: kY,
        w: sx,
        h: sz,
        u0: uo,
        v0: vo,
      });
    if (faces & 8)
      this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], {
        ...o,
        kind: kY,
        w: sx,
        h: sz,
        u0: uo,
        v0: vo,
      });
    if (faces & 16)
      this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], {
        ...o,
        w: sx,
        h: sy,
        u0: uo,
        v0: vo,
      });
    if (faces & 32)
      this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], {
        ...o,
        w: sx,
        h: sy,
        u0: uo,
        v0: vo,
      });
    return this;
  }

  /** Vertical cylinder / tapered post. `seg` radial segments, flat-shaded when `flat`. */
  cylinder(cx, cy, cz, rBottom, rTop, height, seg = 8, o = {}) {
    const color = o.color || WHITE;
    const kind = o.kind ?? KIND.SURFACE;
    const seed = o.seed ?? 0;
    const y0 = cy;
    const y1 = cy + height;
    const circ = Math.PI * 2 * Math.max(rBottom, rTop);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0),
        s0 = Math.sin(a0);
      const c1 = Math.cos(a1),
        s1 = Math.sin(a1);
      const u0 = (i / seg) * circ;
      const u1 = ((i + 1) / seg) * circ;
      const ft = o.feat ?? Math.min(u1 - u0, Math.abs(height));
      const b0 = this.vertexCount;
      this.vert(cx + c0 * rBottom, y0, cz + s0 * rBottom, c0, 0, s0, u0, 0, color, kind, seed, ft);
      this.vert(cx + c1 * rBottom, y0, cz + s1 * rBottom, c1, 0, s1, u1, 0, color, kind, seed, ft);
      this.vert(cx + c1 * rTop, y1, cz + s1 * rTop, c1, 0, s1, u1, height, color, kind, seed, ft);
      this.vert(cx + c0 * rTop, y1, cz + s0 * rTop, c0, 0, s0, u0, height, color, kind, seed, ft);
      this.idx.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
    }
    if (o.capTop !== false && rTop > 0.001) this.disc(cx, y1, cz, rTop, seg, 1, o);
    if (o.capBottom && rBottom > 0.001) this.disc(cx, y0, cz, rBottom, seg, -1, o);
    return this;
  }

  disc(cx, cy, cz, r, seg, dir, o = {}) {
    const color = o.color || WHITE;
    const kind = o.kind ?? KIND.SURFACE;
    const seed = o.seed ?? 0;
    const ft = o.feat ?? r;
    const centre = this.vert(cx, cy, cz, 0, dir, 0, 0, 0, color, kind, seed, ft);
    const start = this.vertexCount;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      this.vert(
        cx + Math.cos(a) * r,
        cy,
        cz + Math.sin(a) * r,
        0,
        dir,
        0,
        Math.cos(a) * r,
        Math.sin(a) * r,
        color,
        kind,
        seed,
        ft
      );
    }
    for (let i = 0; i < seg; i++) {
      if (dir > 0) this.idx.push(centre, start + i, start + i + 1);
      else this.idx.push(centre, start + i + 1, start + i);
    }
    return this;
  }

  /** Ribbon strip: array of {a:[x,y,z], b:[x,y,z]} rails, stitched into quads. */
  strip(rails, o = {}) {
    const color = o.color || WHITE;
    const kind = o.kind ?? KIND.SURFACE;
    const seed = o.seed ?? 0;
    const uScale = o.uScale ?? 1;
    let prev = null;
    let run = 0;
    for (let i = 0; i < rails.length; i++) {
      const r = rails[i];
      if (prev) {
        run += Math.hypot(r.a[0] - prev.a[0], r.a[1] - prev.a[1], r.a[2] - prev.a[2]);
      }
      const wid = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1], r.b[2] - r.a[2]);
      const base = this.vertexCount;
      _e1.set(r.b[0] - r.a[0], r.b[1] - r.a[1], r.b[2] - r.a[2]);
      const nx = o.nx ?? 0,
        ny = o.ny ?? 1,
        nz = o.nz ?? 0;
      const ft = o.feat ?? wid;
      this.vert(r.a[0], r.a[1], r.a[2], nx, ny, nz, 0, run * uScale, color, kind, seed, ft);
      this.vert(r.b[0], r.b[1], r.b[2], nx, ny, nz, wid, run * uScale, color, kind, seed, ft);
      if (prev) {
        this.idx.push(base - 2, base - 1, base + 1, base - 2, base + 1, base);
      }
      prev = r;
    }
    return this;
  }

  /** Append another builder's contents, optionally transformed. */
  append(other, matrix) {
    const n = this.vertexCount;
    const hasM = !!matrix;
    if (hasM) _nm.getNormalMatrix(matrix);
    for (let i = 0; i < other.p.length; i += 3) {
      let x = other.p[i],
        y = other.p[i + 1],
        z = other.p[i + 2];
      let nx = other.n[i],
        ny = other.n[i + 1],
        nz = other.n[i + 2];
      if (hasM) {
        _vc.set(x, y, z).applyMatrix4(matrix);
        x = _vc.x;
        y = _vc.y;
        z = _vc.z;
        _vc.set(nx, ny, nz).applyMatrix3(_nm).normalize();
        nx = _vc.x;
        ny = _vc.y;
        nz = _vc.z;
      }
      this.p.push(x, y, z);
      this.n.push(nx, ny, nz);
    }
    for (let i = 0; i < other.u.length; i++) this.u.push(other.u[i]);
    for (let i = 0; i < other.c.length; i++) this.c.push(other.c[i]);
    for (let i = 0; i < other.k.length; i++) this.k.push(other.k[i]);
    for (let i = 0; i < other.s.length; i++) this.s.push(other.s[i]);
    for (let i = 0; i < other.f.length; i++) this.f.push(other.f[i]);
    for (let i = 0; i < other.idx.length; i++) this.idx.push(other.idx[i] + n);
    return this;
  }

  geometry(name = 'city') {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(this.k, 1));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(this.s, 1));
    g.setAttribute('aFeat', new THREE.Float32BufferAttribute(this.f, 1));
    g.setIndex(this.p.length / 3 > 65000 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const WHITE = [1, 1, 1];
const _idq = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
function isIdentity(m) {
  const e = m.elements;
  return e[0] === 1 && e[5] === 1 && e[10] === 1 && e[12] === 0 && e[13] === 0 && e[14] === 0;
}

/** Deterministic 0..1 hash from an integer — used to keep content stable across reloads. */
export function hash1(n) {
  let t = (n + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
