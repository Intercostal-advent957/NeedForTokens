import * as THREE from 'three';
import { aerofoil, boxUV, mergeGeos, roundedRect, smoothNormals, sweepProfile } from './CarLoft.js';
import { lerp } from '../core/MathX.js';

/**
 * Everything bolted to the shell: lights with real internals, grilles with depth, aero, mirrors,
 * handles, badges, exhausts, interior.
 *
 * Builders push geometry into a `Bag` keyed by material so the whole car collapses into ~12 draw
 * calls regardless of how much detail we model.
 */
export class Bag {
  constructor() {
    this.map = new Map();
  }
  add(key, geo, matrix) {
    if (!geo) return;
    if (matrix) geo.applyMatrix4(matrix);
    let a = this.map.get(key);
    if (!a) this.map.set(key, (a = []));
    a.push(geo);
    return geo;
  }
  /** Mirror everything added inside fn() across X as well. */
  pair(key, geo, x) {
    const g2 = geo.clone();
    this.add(key, geo, new THREE.Matrix4().makeTranslation(x, 0, 0));
    g2.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
    flipWinding(g2);
    this.add(key, g2, new THREE.Matrix4().makeTranslation(-x, 0, 0));
  }
  build(materials, smooth = 45, uvScale = {}) {
    const out = [];
    for (const [key, list] of this.map) {
      const mat = materials[key];
      if (!mat) continue;
      let g = smoothNormals(mergeGeos(list), smooth);
      // Sweeps and boxes carry no UVs. Project them, or every map on these materials samples a
      // single texel and the derivative tangent frame degenerates.
      if (uvScale[key]) g = boxUV(g, uvScale[key]);
      out.push({ key, mesh: new THREE.Mesh(g, mat) });
    }
    return out;
  }
}

function flipWinding(g) {
  const p = g.attributes.position.array;
  if (g.index) {
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
  } else {
    for (let i = 0; i < p.length; i += 9)
      for (let k = 0; k < 3; k++) {
        const t = p[i + 3 + k];
        p[i + 3 + k] = p[i + 6 + k];
        p[i + 6 + k] = t;
      }
  }
  g.computeVertexNormals();
  return g;
}

const M = (x = 0, y = 0, z = 0) => new THREE.Matrix4().makeTranslation(x, y, z);
const RX = (a) => new THREE.Matrix4().makeRotationX(a);
const RY = (a) => new THREE.Matrix4().makeRotationY(a);
const RZ = (a) => new THREE.Matrix4().makeRotationZ(a);

/** Parabolic reflector bowl facing -Z. */
function bowl(r, depth, seg = 18) {
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new THREE.Vector2(r * t, -depth * (1 - t * t)));
  }
  const g = new THREE.LatheGeometry(pts, seg);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** A recessed rectangular pocket: rim walls + a floor. Used for grilles, vents, handle pockets. */
function pocket(w, h, depth, r = 0.02) {
  const outer = roundedRect(w, h, r, 3);
  const inner = roundedRect(w * 0.88, h * 0.8, r * 0.8, 3);
  const verts = [];
  const idx = [];
  const P = outer.length;
  for (let j = 0; j < P; j++) verts.push(outer[j][0], outer[j][1], 0);
  for (let j = 0; j < P; j++) verts.push(inner[j][0], inner[j][1], depth);
  for (let j = 0; j < P; j++) {
    const j2 = (j + 1) % P;
    idx.push(j, P + j, P + j2, j, P + j2, j2);
  }
  // floor
  const base = verts.length / 3;
  verts.push(0, 0, depth);
  for (let j = 0; j < P; j++) idx.push(base, P + ((j + 1) % P), P + j);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Grille mesh: a lattice of bars sitting in front of the cavity floor. */
function grilleBars(w, h, z, cols, rows, thick = 0.012) {
  const parts = [];
  for (let i = 0; i < cols; i++) {
    const x = lerp(-w / 2, w / 2, cols === 1 ? 0.5 : i / (cols - 1));
    const bar = new THREE.BoxGeometry(thick, h, thick * 1.6);
    bar.translate(x, 0, z);
    parts.push(bar);
  }
  for (let i = 0; i < rows; i++) {
    const y = lerp(-h / 2, h / 2, rows === 1 ? 0.5 : i / (rows - 1));
    const bar = new THREE.BoxGeometry(w, thick * 0.8, thick * 1.2);
    bar.translate(0, y, z + thick);
    parts.push(bar);
  }
  return mergeGeos(parts);
}

// ---------------------------------------------------------------- headlights

/**
 * A headlight is FOUR parts: a dark recessed housing, a chrome reflector bowl (or projector
 * barrels), separate emissive LED elements, and a clear lens over the top. Flat glowing
 * rectangles are the biggest hobby-project tell there is, so we never do that.
 *
 * @returns {{ housing, reflector, led, lens, drl }}
 */
export function headlight(w, h, d, style = 'quad') {
  const housing = pocket(w, h, d, h * 0.28);
  const refl = [];
  const led = [];
  const drl = [];

  if (style === 'quad' || style === 'projector') {
    const n = style === 'quad' ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? 0 : lerp(-w * 0.21, w * 0.21, i);
      const r = Math.min(h * 0.36, w * 0.19);
      const b = bowl(r, d * 0.78, 16);
      b.translate(x, 0, d * 0.12);
      refl.push(b);
      // projector lens element
      const p = new THREE.SphereGeometry(r * 0.55, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
      p.rotateX(-Math.PI / 2);
      p.translate(x, 0, d * 0.42);
      refl.push(p);
      const e = new THREE.CircleGeometry(r * 0.42, 14);
      e.translate(x, 0, d * 0.36);
      led.push(e);
    }
  } else {
    // blade: a single wide reflector trough
    const trough = new THREE.CylinderGeometry(h * 0.34, h * 0.34, w * 0.82, 14, 1, true, 0, Math.PI);
    trough.rotateZ(Math.PI / 2);
    trough.rotateX(Math.PI / 2);
    trough.translate(0, 0, d * 0.55);
    refl.push(trough);
    const e = new THREE.BoxGeometry(w * 0.74, h * 0.13, 0.004);
    e.translate(0, 0, d * 0.42);
    led.push(e);
  }

  // DRL signature: a thin L / blade strip along the top and down the outer edge.
  const top = new THREE.BoxGeometry(w * 0.86, h * 0.07, 0.005);
  top.translate(0, h * 0.31, d * 0.2);
  drl.push(top);
  const edge = new THREE.BoxGeometry(w * 0.06, h * 0.42, 0.005);
  edge.translate(-w * 0.4, h * 0.02, d * 0.2);
  drl.push(edge);

  // lens: slightly domed, covers the whole aperture
  const lens = new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.34);
  lens.rotateX(-Math.PI / 2);
  lens.scale(w * 0.52, h * 0.54, 0.055);
  lens.translate(0, 0, 0.012);

  return {
    housing,
    reflector: mergeGeos(refl),
    led: mergeGeos(led),
    drl: mergeGeos(drl),
    lens,
  };
}

/** Tail light: a light bar with internal fins, an emissive core and a red lens. */
export function taillight(w, h, d, style = 'bar') {
  const housing = pocket(w, h, d, h * 0.3);
  const fins = [];
  const n = style === 'bar' ? 9 : 3;
  for (let i = 0; i < n; i++) {
    const x = lerp(-w * 0.42, w * 0.42, n === 1 ? 0.5 : i / (n - 1));
    const f = new THREE.BoxGeometry(w * 0.035, h * 0.62, d * 0.9);
    f.translate(x, 0, d * 0.5);
    fins.push(f);
  }
  const core = new THREE.BoxGeometry(w * 0.94, h * 0.42, 0.006);
  core.translate(0, 0, d * 0.3);
  const lens = new THREE.SphereGeometry(1, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.3);
  lens.rotateX(-Math.PI / 2);
  lens.scale(w * 0.52, h * 0.55, 0.04);
  lens.translate(0, 0, 0.01);
  return { housing, fins: mergeGeos(fins), core, lens };
}

// ---------------------------------------------------------------- aero

/** Rear wing: aerofoil blade + endplates + two swan-neck struts. */
export function rearWing(span, chord, height, z, y, { endplate = true, struts = 2 } = {}) {
  const parts = { carbon: [], trim: [] };
  const foil = aerofoil(chord, chord * 0.085, 0.1, 10);
  const path = [
    { o: [-span / 2, 0, 0], x: [0, 0, 1], y: [0, 1, 0] },
    { o: [-span / 2 + span * 0.1, 0, -chord * 0.02], x: [0, 0, 1], y: [0, 1, 0] },
    { o: [span / 2 - span * 0.1, 0, -chord * 0.02], x: [0, 0, 1], y: [0, 1, 0] },
    { o: [span / 2, 0, 0], x: [0, 0, 1], y: [0, 1, 0] },
  ];
  const blade = sweepProfile(foil, path, { cap: true });
  blade.rotateX(-0.16);
  blade.translate(0, y + height, z);
  parts.carbon.push(blade);

  if (endplate) {
    for (const s of [-1, 1]) {
      const ep = new THREE.BufferGeometry();
      const shape = [
        [-chord * 0.62, -height * 0.44],
        [chord * 0.54, -height * 0.3],
        [chord * 0.6, height * 0.2],
        [chord * 0.2, height * 0.28],
        [-chord * 0.6, height * 0.14],
      ];
      const g = sweepProfile(shape, [
        { o: [s * span * 0.5, 0, 0], x: [0, 0, 1], y: [0, 1, 0] },
        { o: [s * (span * 0.5 + 0.014), 0, 0], x: [0, 0, 1], y: [0, 1, 0] },
      ]);
      g.translate(0, y + height, z);
      parts.carbon.push(g);
      ep.dispose?.();
    }
  }
  for (let i = 0; i < struts; i++) {
    const x = struts === 1 ? 0 : lerp(-span * 0.3, span * 0.3, i / (struts - 1));
    const st = sweepProfile(roundedRect(0.03, 0.055, 0.012, 3), [
      { o: [x, y - 0.02, z + chord * 0.24], x: [1, 0, 0], y: [0, 1, 0] },
      { o: [x, y + height * 0.55, z + chord * 0.16], x: [1, 0, 0], y: [0, 1, 0] },
      { o: [x, y + height, z + chord * 0.02], x: [1, 0, 0], y: [0, 1, 0] },
    ]);
    parts.carbon.push(st);
  }
  return mergeGeos(parts.carbon);
}

/** Rear diffuser: an upswept floor with vertical strakes. */
export function diffuser(w, len, drop, z, y, fins = 5) {
  const parts = [];
  const floorPts = [];
  const N = 6;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    floorPts.push({
      o: [0, y + drop * t * t, z - len + len * t],
      x: [lerp(w * 0.46, w * 0.5, t), 0, 0],
      y: [0, 0.02, 0],
    });
  }
  parts.push(sweepProfile(roundedRect(2, 0.5, 0.2, 2), floorPts, { cap: true }));
  for (let i = 0; i < fins; i++) {
    const x = lerp(-w * 0.4, w * 0.4, fins === 1 ? 0.5 : i / (fins - 1));
    const fin = [];
    for (let k = 0; k < N; k++) {
      const t = k / (N - 1);
      fin.push({
        o: [x, y + drop * t * t + 0.045, z - len + len * t],
        x: [0.008, 0, 0],
        y: [0, 0.05 + t * 0.03, 0],
      });
    }
    parts.push(sweepProfile(roundedRect(2, 2, 0.4, 2), fin, { cap: true }));
  }
  return mergeGeos(parts);
}

/**
 * Front splitter blade with turning vanes.
 *
 * The blade width is sampled from the bodywork at every node instead of being one constant, and
 * the run starts *inside* the bumper. A constant-width blade in front of a tapering nose is how
 * you end up with a black slab lying on the road beside the car with nothing joining it on.
 *
 * @param {(z:number)=>number} halfAt  body half-width at a given Z
 * @param {number} zBack  rearmost Z of the blade — must be inside the bumper
 * @param {number} zTip   frontmost Z of the blade
 */
export function splitter(halfAt, zBack, zTip, y, vanes = 2) {
  const parts = [];
  const N = 5;
  const path = [];
  let tipHalf = 0;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const z = lerp(zBack, zTip, t);
    // Ahead of the nose the body has no width to sample, so hold the frontmost real section and
    // taper it — a splitter narrows toward its leading edge anyway.
    const hw = halfAt(Math.min(z, zBack)) * lerp(1.0, 0.9, t);
    tipHalf = hw;
    // A 10 mm blade seen almost edge-on is a shimmering fringe of moire, not a splitter.
    path.push({ o: [0, y - 0.014 * t * t, z], x: [hw, 0, 0], y: [0, lerp(0.1, 0.075, t), 0] });
  }
  parts.push(sweepProfile(roundedRect(2, 0.28, 0.1, 2), path, { cap: true }));
  const len = Math.abs(zBack - zTip);
  for (let i = 0; i < vanes; i++)
    for (const s of [-1, 1]) {
      const x = s * lerp(tipHalf * 0.44, tipHalf * 0.82, vanes === 1 ? 0 : i / (vanes - 1));
      const v = new THREE.BoxGeometry(0.009, 0.05, len * 0.6);
      v.translate(x, y - 0.024, lerp(zBack, zTip, 0.5));
      parts.push(v);
    }
  return mergeGeos(parts);
}

/**
 * Side skirt blade riding under the sill. `halfAt(z)` is the body's own half-width at the
 * skirt's height, so the blade follows the rocker instead of hanging in space beside it wherever
 * the flank happens to pinch.
 */
export function sideSkirt(side, halfAt, y, z0, z1, drop = 0.05) {
  const path = [];
  const N = 9;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const z = lerp(z0, z1, t);
    path.push({
      o: [side * (halfAt(z) - 0.026), y - drop * Math.sin(t * Math.PI) * 0.3, z],
      x: [0.024 + Math.sin(t * Math.PI) * 0.018, 0, 0],
      y: [0, drop, 0],
    });
  }
  return sweepProfile(roundedRect(2, 1.4, 0.5, 3), path, { cap: true });
}

// ---------------------------------------------------------------- furniture

/**
 * Wing mirror: a dark stalk, a body-coloured cap, and a glass.
 *
 * Returned in three pieces on purpose. Merging the stalk into the cap and painting the lot body
 * colour gives you a smooth coloured ovoid growing out of the shoulder with no visible arm —
 * which reads as a blister, not a mirror. The dark stalk is what separates the cap from the body
 * and makes the silhouette legible at any distance.
 *
 * `size` is the car's WIDTH-derived scale; at 1.2 the cap is ~13 x 10 x 14 cm, a real mirror.
 */
export function mirror(side, x, y, z, size = 1) {
  const s = size;
  const capX = x + side * 0.105 * s;
  const capY = y + 0.052 * s;
  const capZ = z - 0.016 * s;
  const stalk = sweepProfile(roundedRect(0.03 * s, 0.02 * s, 0.008 * s, 3), [
    { o: [x - side * 0.006 * s, y - 0.006 * s, z + 0.006 * s], x: [1, 0, 0], y: [0, 1, 0] },
    { o: [x + side * 0.05 * s, y + 0.026 * s, z - 0.004 * s], x: [1, 0, 0], y: [0, 1, 0] },
    { o: [capX, capY - 0.012 * s, capZ], x: [1, 0, 0], y: [0, 1, 0] },
  ]);
  // Cap: deeper fore-aft than it is wide, and flattened in Y — the shape every modern door
  // mirror has, and the one that catches a highlight along its top edge.
  const cap = new THREE.SphereGeometry(1, 16, 11);
  cap.scale(0.052 * s, 0.038 * s, 0.062 * s);
  cap.applyMatrix4(RY(-side * 0.24));
  cap.translate(capX, capY, capZ);
  const glass = new THREE.CircleGeometry(0.042 * s, 16);
  glass.scale(1, 0.74, 1);
  glass.rotateY(side * 0.3);
  glass.translate(capX + side * 0.004 * s, capY + 0.002 * s, capZ + 0.05 * s);
  return { stalk, cap, glass };
}

/** Flush door handle: a recessed pocket with a pull bar. */
export function doorHandle(x, y, z, w = 0.14, side = 1) {
  const p = pocket(w, 0.038, 0.022, 0.012);
  p.rotateY(-side * Math.PI / 2);
  p.translate(x, y, z);
  const bar = new THREE.BoxGeometry(0.012, 0.02, w * 0.78);
  bar.translate(x - side * 0.006, y, z);
  return { pocket: p, bar };
}

/** Exhaust tip: a lathed tube with a rolled lip and a dark bore. */
export function exhaustTip(r, len, x, y, z) {
  const pts = [];
  pts.push(new THREE.Vector2(r * 0.78, -len));
  pts.push(new THREE.Vector2(r * 0.9, -len * 0.3));
  pts.push(new THREE.Vector2(r, 0));
  pts.push(new THREE.Vector2(r * 1.06, 0.012));
  pts.push(new THREE.Vector2(r * 0.9, 0.016));
  pts.push(new THREE.Vector2(r * 0.86, -len * 0.5));
  const g = new THREE.LatheGeometry(pts, 16);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  const bore = new THREE.CircleGeometry(r * 0.86, 16);
  bore.translate(x, y, z - len * 0.5);
  return { tip: g, bore };
}

/** Abstract marque badge — a ring with an inscribed chevron. No real-world brand. */
export function badge(r, x, y, z, facing = -1) {
  const parts = [];
  const ring = new THREE.TorusGeometry(r, r * 0.16, 8, 20);
  parts.push(ring);
  const shape = [
    [-r * 0.5, -r * 0.34],
    [0, r * 0.44],
    [r * 0.5, -r * 0.34],
    [r * 0.26, -r * 0.34],
    [0, r * 0.08],
    [-r * 0.26, -r * 0.34],
  ];
  parts.push(sweepProfile(shape, [
    { o: [0, 0, -r * 0.1], x: [1, 0, 0], y: [0, 1, 0] },
    { o: [0, 0, r * 0.1], x: [1, 0, 0], y: [0, 1, 0] },
  ]));
  const g = mergeGeos(parts);
  g.scale(1, 1, facing);
  g.translate(x, y, z);
  return g;
}

/**
 * Roof / engine-lid scoop: a raised intake with a dark throat.
 *
 * The engine-deck case is NOT one big scoop.
 *
 * A single half-width wedge swept down the deck, tapering to a point at its leading edge, is
 * geometrically a scoop and visually a chevron: at chase distance the point plus the dark louvre
 * bank inside it resolve as an arrowhead stamped across the boot lid, indistinguishable from a
 * decal. It was the loudest artefact on the car and it survived every paint-shader change,
 * because it was never the paint. Two narrow constant-width louvre banks flanking the centreline
 * are what a mid-engine car actually carries, they read as vents at every distance, and no
 * silhouette they cast can be mistaken for a graphic.
 */
export function scoop(w, h, len, x, y, z, reversed = false) {
  const N = 5;
  if (reversed) {
    const shells = [];
    const slats = [];
    const bw = w * 0.36; // width of ONE bank
    const off = w * 0.29; // its offset from the centreline
    for (const s of [-1, 1]) {
      const path = [];
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        // Rounded off at BOTH ends so the bank melts into the deck instead of pointing at
        // anything. No taper along its length: a constant-section blister has no arrow in it.
        const cap = Math.sin(Math.PI * (0.14 + 0.72 * t));
        path.push({
          o: [x + s * off, y + h * 0.5 * cap, z + lerp(-len / 2, len / 2, t)],
          x: [bw * 0.5 * (0.74 + 0.26 * cap), 0, 0],
          y: [0, h * 0.46, 0],
        });
      }
      shells.push(sweepProfile(roundedRect(2, 1.2, 0.5, 3), path, { cap: true }));
      // Louvre slats stepping up the bank. Boxes, not a planar pocket, so they cannot land off
      // the curved deck.
      for (let i = 0; i < 4; i++) {
        const t = i / 3;
        const sl = new THREE.BoxGeometry(bw * 0.72, 0.007, len * 0.11);
        sl.translate(x + s * off, y + h * (0.42 + t * 0.34), z + lerp(-len * 0.26, len * 0.3, t));
        slats.push(sl);
      }
    }
    return { shell: mergeGeos(shells), mouth: mergeGeos(slats) };
  }

  const path = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const s = Math.sin(t * Math.PI * 0.5);
    path.push({
      o: [x, y + h * t * 0.8, z + lerp(-len / 2, len / 2, t)],
      x: [w * 0.5 * (0.7 + s * 0.3), 0, 0],
      y: [0, h * 0.5, 0],
    });
  }
  const shell = sweepProfile(roundedRect(2, 1.2, 0.5, 3), path, { cap: true });
  const mouth = pocket(w * 0.56, h * 0.5, 0.06, 0.015);
  mouth.translate(x, y + h * 0.46, z - len * 0.44);
  return { shell, mouth };
}

// ---------------------------------------------------------------- interior

/**
 * Low-poly but real interior. Visible through the glass, this is what stops the cabin reading as
 * a hollow black shell — the single biggest "is this a real car" cue after the wheels.
 */
export function interior(def, cabin, opts = {}) {
  const W = def.width;
  const H = def.height;
  const trim = [];
  const dark = [];
  const seatY = H * 0.3;
  const z0 = cabin.z0;
  const z1 = cabin.z1;
  const midZ = (z0 + z1) * 0.5;

  // floor pan + rear bulkhead + parcel shelf, so you never see daylight through the cabin
  // Everything is kept well inside the shell: the cabin must read as an enclosed space without
  // a single vertex breaking the painted surface.
  const inW = W * 0.33;
  const floor = new THREE.BoxGeometry(inW * 2, 0.03, (z1 - z0) * 0.92);
  floor.translate(0, H * 0.25, midZ);
  dark.push(floor);
  const bulk = new THREE.BoxGeometry(inW * 2, H * 0.34, 0.05);
  bulk.translate(0, H * 0.42, z1 - 0.16);
  dark.push(bulk);
  const cowl = new THREE.BoxGeometry(inW * 2, H * 0.2, 0.06);
  cowl.translate(0, H * 0.4, z0 + 0.1);
  dark.push(cowl);
  for (const s of [-1, 1]) {
    const card = new THREE.BoxGeometry(0.04, H * 0.3, (z1 - z0) * 0.8);
    card.translate(s * inW, H * 0.42, midZ);
    dark.push(card);
  }

  // dashboard: a swept cowl with a binnacle
  const dashPath = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    dashPath.push({
      o: [lerp(-W * 0.3, W * 0.3, t), H * 0.5 - Math.sin(t * Math.PI) * 0.012, z0 + 0.14],
      x: [0, 0, 1],
      y: [0, 1, 0],
    });
  }
  dark.push(sweepProfile(roundedRect(0.34, 0.13, 0.05, 3), dashPath, { cap: true }));
  const binnacle = new THREE.BoxGeometry(W * 0.2, 0.1, 0.16);
  binnacle.translate(-W * 0.16 * (opts.rhd ? -1 : 1), H * 0.52, z0 + 0.24);
  dark.push(binnacle);
  const screen = new THREE.PlaneGeometry(W * 0.17, 0.075);
  screen.rotateX(-0.5);
  screen.translate(-W * 0.16 * (opts.rhd ? -1 : 1), H * 0.55, z0 + 0.28);
  trim.push(screen);

  // centre console
  const console_ = new THREE.BoxGeometry(W * 0.15, H * 0.16, (z1 - z0) * 0.5);
  console_.translate(0, H * 0.32, midZ - 0.05);
  dark.push(console_);

  // seats: base + bolstered back + headrest, ×2
  for (const s of [-1, 1]) {
    const x = s * W * 0.17 * (opts.seatSpread ?? 1);
    const base = new THREE.BoxGeometry(W * 0.24, 0.09, 0.44);
    base.translate(x, seatY + 0.05, midZ + 0.06);
    trim.push(base);
    const back = new THREE.BoxGeometry(W * 0.23, 0.5, 0.11);
    back.applyMatrix4(RX(0.22));
    back.translate(x, seatY + 0.3, midZ + 0.3);
    trim.push(back);
    for (const b of [-1, 1]) {
      const bol = new THREE.BoxGeometry(W * 0.045, 0.42, 0.09);
      bol.applyMatrix4(RX(0.22));
      bol.translate(x + b * W * 0.105, seatY + 0.3, midZ + 0.26);
      trim.push(bol);
    }
    const head = new THREE.BoxGeometry(W * 0.12, 0.14, 0.1);
    head.translate(x, seatY + 0.58, midZ + 0.34);
    trim.push(head);
  }

  // roll cage for the track-focused cars
  if (opts.cage) {
    const tube = (a, b) =>
      sweepProfile(roundedRect(0.032, 0.032, 0.016, 3), [
        { o: a, x: [1, 0, 0], y: [0, 1, 0] },
        { o: b, x: [1, 0, 0], y: [0, 1, 0] },
      ]);
    const cw = W * 0.3;
    for (const s of [-1, 1]) {
      trim.push(tube([s * cw, H * 0.28, z1 - 0.2], [s * cw, H * 0.76, z1 - 0.24]));
      trim.push(tube([s * cw, H * 0.76, z1 - 0.24], [s * cw * 0.9, H * 0.8, midZ + 0.1]));
    }
    trim.push(tube([-cw, H * 0.74, z1 - 0.22], [cw, H * 0.74, z1 - 0.22]));
    trim.push(tube([-cw, H * 0.72, z1 - 0.22], [cw, H * 0.32, z1 - 0.18]));
  }

  return { trim: mergeGeos(trim), dark: mergeGeos(dark) };
}

/** Steering wheel: rim + three spokes + a hub boss. Returned separately so it can be animated. */
export function steeringWheel(r = 0.17) {
  const parts = [];
  const rim = new THREE.TorusGeometry(r, r * 0.11, 8, 24);
  // flat-bottom, like every modern performance car
  const p = rim.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < -r * 0.74) p.setY(i, -r * 0.74 + (y + r * 0.74) * 0.3);
  }
  parts.push(rim);
  for (const a of [Math.PI * 0.5, Math.PI * 1.17, Math.PI * 1.83]) {
    const sp = new THREE.BoxGeometry(r * 0.9, 0.022, 0.016);
    sp.translate(r * 0.45, 0, 0);
    sp.applyMatrix4(RZ(a));
    parts.push(sp);
  }
  const hub = new THREE.CylinderGeometry(r * 0.3, r * 0.32, 0.05, 14);
  hub.rotateX(Math.PI / 2);
  parts.push(hub);
  const g = mergeGeos(parts);
  return smoothNormals(g, 40);
}

export { pocket, grilleBars, bowl, M, RX, RY, RZ, flipWinding };
