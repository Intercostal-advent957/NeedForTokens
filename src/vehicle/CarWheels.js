import * as THREE from 'three';
import { cylUV, mergeGeos, roundedRect, smoothNormals, sweepProfile } from './CarLoft.js';
import { lerp } from '../core/MathX.js';

/**
 * Wheels. Players stare at these, so they are real geometry: a lathed tyre carcass with a
 * treaded contact face and embossed sidewall lettering, a parametric multi-spoke rim (design and
 * spoke count per car), a vented + drilled brake disc, and a caliper with a logo plate.
 *
 * The wheel axis is +X. Meshes are built once per (def, corner-size) and shared between cars.
 */

/** Revolve a [radius, axialOffset] profile around the X axis. */
function revolve(profile, segments, { closed = false, uScale = 1 } = {}) {
  const P = profile.length;
  const verts = [];
  const uvs = [];
  const idx = [];
  for (let i = 0; i <= segments; i++) {
    const th = (i / segments) * Math.PI * 2;
    const c = Math.cos(th),
      s = Math.sin(th);
    for (let j = 0; j < P; j++) {
      const [r, a] = profile[j];
      verts.push(a, r * c, r * s);
      uvs.push((i / segments) * uScale, j / (P - 1));
    }
  }
  const rows = P - 1;
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < rows; j++) {
      const a = i * P + j,
        b = (i + 1) * P + j,
        c = (i + 1) * P + j + 1,
        d = i * P + j + 1;
      idx.push(a, b, c, a, c, d);
    }
  }
  if (closed) {
    /* profile already closed by the caller */
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/** Flat annulus in the YZ plane at axial position `a`. */
function annulus(rIn, rOut, a, segments = 48, flip = false) {
  const verts = [];
  const uvs = [];
  const idx = [];
  for (let i = 0; i <= segments; i++) {
    const th = (i / segments) * Math.PI * 2;
    const c = Math.cos(th),
      s = Math.sin(th);
    verts.push(a, rIn * c, rIn * s, a, rOut * c, rOut * s);
    uvs.push(i / segments, 0, i / segments, 1);
  }
  for (let i = 0; i < segments; i++) {
    const a0 = i * 2,
      b0 = i * 2 + 1,
      a1 = (i + 1) * 2,
      b1 = (i + 1) * 2 + 1;
    if (flip) idx.push(a0, a1, b0, b0, a1, b1);
    else idx.push(a0, b0, a1, b0, b1, a1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

// ------------------------------------------------------------------------- tyre

/**
 * Tyre carcass. The profile runs bead -> sidewall -> shoulder -> crown -> shoulder -> bead,
 * so the sidewall has real bulge and the contact patch is crowned, not a cylinder.
 */
function tyreCarcass(R, W, rimR, seg) {
  const hw = W / 2;
  const shoulder = R * 0.985;
  const bulge = rimR + (R - rimR) * 0.62;
  const prof = [
    [rimR, -hw * 0.86],
    [rimR + (R - rimR) * 0.16, -hw * 0.985],
    [bulge, -hw * 1.0],
    [shoulder * 0.985, -hw * 0.93],
    [shoulder, -hw * 0.78],
    [R, -hw * 0.5],
    [R, 0],
    [R, hw * 0.5],
    [shoulder, hw * 0.78],
    [shoulder * 0.985, hw * 0.93],
    [bulge, hw * 1.0],
    [rimR + (R - rimR) * 0.16, hw * 0.985],
    [rimR, hw * 0.86],
  ];
  const g = revolve(prof, seg, { uScale: 8 });

  // Cut circumferential tread grooves into the crown by pulling those rows inward, and add a
  // block pattern by alternating radius per segment on the crown rows.
  const pos = g.attributes.position;
  const P = prof.length;
  const crownRows = [5, 6, 7];
  for (let i = 0; i <= seg; i++) {
    for (const j of crownRows) {
      const vi = i * P + j;
      const groove = j === 6 ? 0.985 : 1.0;
      const block = (i % 6 < 3 ? 1.0 : 0.9915) * (j === 6 ? 1 : 1);
      const k = groove * block;
      pos.setY(vi, pos.getY(vi) * k);
      pos.setZ(vi, pos.getZ(vi) * k);
    }
  }
  pos.needsUpdate = true;
  return g;
}

/** Embossed sidewall lettering: a ring of raised glyph-ish blocks. Reads as text at 1080p. */
function sidewallText(R, W, rimR, side) {
  const parts = [];
  const bandR = rimR + (R - rimR) * 0.5;
  const x = side * (W / 2) * 0.995;
  const glyphW = 0.013;
  const glyphH = 0.026;
  // three word groups around the tyre, roughly where real branding sits
  const words = [5, 4, 7, 3];
  let a = 0;
  for (let w = 0; w < words.length; w++) {
    a = (w / words.length) * Math.PI * 2 + 0.18;
    for (let i = 0; i < words[w]; i++) {
      const th = a + i * 0.036;
      const c = Math.cos(th),
        s = Math.sin(th);
      const box = new THREE.BoxGeometry(0.0018, glyphH * (0.66 + ((i * 7) % 5) * 0.09), glyphW);
      box.translate(0, bandR, 0);
      const m = new THREE.Matrix4().makeRotationX(th);
      box.applyMatrix4(m);
      box.translate(x + side * 0.0009, 0, 0);
      parts.push(box);
      void c;
      void s;
    }
  }
  // raised bead ring + a fine rib band, the classic sidewall silhouette
  const ring = revolve(
    [
      [rimR + (R - rimR) * 0.24, 0],
      [rimR + (R - rimR) * 0.26, 0.0022],
      [rimR + (R - rimR) * 0.3, 0.0022],
      [rimR + (R - rimR) * 0.32, 0],
    ],
    40
  );
  ring.translate(x, 0, 0);
  parts.push(ring);
  return mergeGeos(parts);
}

export function buildTyre(R, W, rimR, quality = 1) {
  const seg = quality >= 0.9 ? 54 : quality >= 0.55 ? 36 : 24;
  const parts = [tyreCarcass(R, W, rimR, seg)];
  if (quality >= 0.9) {
    // The lettering is built from boxes and carries no UVs; without a projection the tread
    // normal map degenerates there (fwidth(uv) == 0 -> NaN tangent frame).
    parts.push(cylUV(sidewallText(R, W, rimR, -1), 8, 2.6));
    parts.push(cylUV(sidewallText(R, W, rimR, 1), 8, 2.6));
  }
  const g = mergeGeos(parts);
  return smoothNormals(g, 38);
}

// ------------------------------------------------------------------------- rim

const SPOKE_STYLES = {
  // [count, style]
  y: { count: 5, kind: 'y' },
  twin5: { count: 5, kind: 'twin' },
  multi10: { count: 10, kind: 'straight' },
  mesh: { count: 12, kind: 'mesh' },
  turbofan: { count: 9, kind: 'fan' },
  split7: { count: 7, kind: 'split' },
};

/**
 * One spoke, swept from the hub out to the rim barrel. Cross-section is a rounded rectangle
 * that tapers and twists, which is what makes a rim look machined rather than extruded.
 */
function spoke(rHub, rOut, width0, width1, thick, twist, axialIn, axialOut, bow = 0) {
  const N = 7;
  const path = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const r = lerp(rHub, rOut, t);
    const ax = lerp(axialIn, axialOut, t * t);
    const tw = twist * t;
    // local frame: x along the tangential direction (rotated by twist), y along radius
    path.push({
      o: [ax, r + Math.sin(t * Math.PI) * bow, 0],
      x: [Math.sin(tw) * 0.9, 0, Math.cos(tw)],
      y: [Math.cos(tw) * 0.4, 1, 0],
    });
  }
  // per-station scale via profile interpolation isn't supported by sweepProfile, so build the
  // sweep manually with a tapering profile.
  const prof0 = roundedRect(width0, thick, thick * 0.42, 3);
  const prof1 = roundedRect(width1, thick * 0.82, thick * 0.36, 3);
  const P = prof0.length;
  const verts = [];
  const idx = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const f = path[i];
    for (let j = 0; j < P; j++) {
      const u = lerp(prof0[j][0], prof1[j][0], t);
      const v = lerp(prof0[j][1], prof1[j][1], t);
      verts.push(
        f.o[0] + f.x[0] * u + f.y[0] * v,
        f.o[1] + f.x[1] * u + f.y[1] * v,
        f.o[2] + f.x[2] * u + f.y[2] * v
      );
    }
  }
  for (let i = 0; i < N - 1; i++)
    for (let j = 0; j < P; j++) {
      const j2 = (j + 1) % P;
      const a = i * P + j,
        b = (i + 1) * P + j,
        c = (i + 1) * P + j2,
        d = i * P + j2;
      idx.push(a, c, b, a, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * @param {number} R    tyre radius
 * @param {number} W    tyre width
 * @param {string} style key of SPOKE_STYLES
 */
export function buildRim(R, W, style = 'y', quality = 1) {
  const rimR = R * 0.735; // ~19-20" inside a 35 cm tyre
  const hw = W / 2;
  const seg = quality >= 0.9 ? 56 : quality >= 0.55 ? 36 : 24;
  const parts = [];

  // --- barrel: outer flange, well, inner flange ---
  const barrel = revolve(
    [
      [rimR, -hw * 0.88],
      [rimR * 1.012, -hw * 0.9],
      [rimR * 0.995, -hw * 0.82],
      [rimR * 0.9, -hw * 0.72],
      [rimR * 0.9, hw * 0.3],
      [rimR * 0.985, hw * 0.62],
      [rimR * 1.014, hw * 0.86],
      [rimR, hw * 0.9],
      [rimR * 0.965, hw * 0.86],
    ],
    seg,
    { uScale: 6 }
  );
  parts.push(barrel);

  // --- outer lip: the polished step that catches highlights ---
  parts.push(annulus(rimR * 0.965, rimR * 1.014, hw * 0.9, seg));

  const cfg = SPOKE_STYLES[style] ?? SPOKE_STYLES.y;
  const n = cfg.count;
  const rHub = rimR * 0.26;
  const spokeGeos = [];

  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rot = new THREE.Matrix4().makeRotationX(a);
    const mk = (g) => {
      g.applyMatrix4(rot);
      spokeGeos.push(g);
    };
    if (cfg.kind === 'y') {
      mk(spoke(rHub, rimR * 0.6, 0.052, 0.03, 0.036, 0, hw * 0.34, hw * 0.66));
      for (const s of [-1, 1]) {
        const g = spoke(rimR * 0.55, rimR * 0.955, 0.03, 0.048, 0.03, s * 0.34, hw * 0.62, hw * 0.82);
        g.applyMatrix4(new THREE.Matrix4().makeRotationX(a + s * 0.06));
        spokeGeos.push(g);
      }
    } else if (cfg.kind === 'twin') {
      for (const s of [-1, 1]) {
        const g = spoke(rHub, rimR * 0.96, 0.028, 0.038, 0.032, 0, hw * 0.3, hw * 0.8);
        g.applyMatrix4(new THREE.Matrix4().makeRotationX(a + s * 0.13));
        spokeGeos.push(g);
      }
    } else if (cfg.kind === 'straight') {
      mk(spoke(rHub, rimR * 0.96, 0.036, 0.026, 0.03, 0.1, hw * 0.3, hw * 0.8));
    } else if (cfg.kind === 'mesh') {
      for (const s of [-1, 1]) {
        const g = spoke(rHub * 1.5, rimR * 0.95, 0.019, 0.024, 0.022, s * 0.5, hw * 0.32, hw * 0.78);
        g.applyMatrix4(new THREE.Matrix4().makeRotationX(a));
        spokeGeos.push(g);
      }
    } else if (cfg.kind === 'fan') {
      mk(spoke(rHub, rimR * 0.955, 0.062, 0.058, 0.026, 0.5, hw * 0.24, hw * 0.72, 0.004));
    } else {
      // split
      mk(spoke(rHub, rimR * 0.55, 0.05, 0.036, 0.034, 0, hw * 0.3, hw * 0.6));
      for (const s of [-1, 1]) {
        const g = spoke(rimR * 0.5, rimR * 0.955, 0.022, 0.03, 0.026, s * 0.42, hw * 0.58, hw * 0.8);
        g.applyMatrix4(new THREE.Matrix4().makeRotationX(a + s * 0.09));
        spokeGeos.push(g);
      }
    }
  }
  parts.push(...spokeGeos);

  // --- hub: centre cap + lug bolts ---
  parts.push(
    revolve(
      [
        [0.001, hw * 0.38],
        [rHub * 0.55, hw * 0.4],
        [rHub * 0.92, hw * 0.46],
        [rHub * 1.05, hw * 0.4],
        [rHub * 1.05, hw * 0.24],
      ],
      quality >= 0.9 ? 28 : 14
    )
  );
  const lugs = 5;
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2 + 0.4;
    const bolt = new THREE.CylinderGeometry(0.011, 0.012, 0.016, 6);
    bolt.rotateZ(Math.PI / 2);
    bolt.translate(hw * 0.44, rHub * 1.5, 0);
    bolt.applyMatrix4(new THREE.Matrix4().makeRotationX(a));
    parts.push(bolt);
  }

  const g = cylUV(mergeGeos(parts), 8, 2.4);
  return smoothNormals(g, 34);
}

// ------------------------------------------------------------------------- brakes

/** Vented, cross-drilled disc with directional slots. */
export function buildDisc(R, W, quality = 1) {
  const rOut = R * 0.53;
  const rIn = R * 0.27;
  const seg = quality >= 0.9 ? 44 : quality >= 0.55 ? 30 : 20;
  const t = 0.016;
  const parts = [];
  // faces + edge
  parts.push(annulus(rIn, rOut, -t, seg, true));
  parts.push(annulus(rIn, rOut, t, seg));
  parts.push(
    revolve(
      [
        [rOut, -t],
        [rOut * 1.004, -t * 0.5],
        [rOut * 1.004, t * 0.5],
        [rOut, t],
      ],
      seg
    )
  );
  // hat
  parts.push(
    revolve(
      [
        [rIn, -t],
        [rIn, -t - 0.03],
        [rIn * 0.55, -t - 0.034],
        [rIn * 0.5, -t - 0.02],
        [rIn * 0.5, t * 0.4],
      ],
      quality >= 0.9 ? 28 : 14
    )
  );

  if (quality >= 0.55) {
    // cross-drilling: recessed dimples on both faces
    const rows = quality >= 0.9 ? 3 : 2;
    for (let r = 0; r < rows; r++) {
      const rr = lerp(rIn * 1.25, rOut * 0.92, r / (rows - 1));
      const count = 12 + r * 4;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + r * 0.22;
        for (const s of [-1, 1]) {
          // A dark disc sitting 0.6 mm proud reads as a drilled hole and — unlike a coplanar
          // inset — cannot z-fight the disc face.
          const hole = new THREE.CircleGeometry(0.0072, 8);
          hole.rotateY(s > 0 ? Math.PI / 2 : -Math.PI / 2);
          hole.translate(s * (t + 0.0006), rr, 0);
          hole.applyMatrix4(new THREE.Matrix4().makeRotationX(a));
          parts.push(hole);
        }
      }
    }
    // directional slots
    const nSlots = quality >= 0.9 ? 8 : 5;
    for (let i = 0; i < nSlots; i++) {
      const a = (i / nSlots) * Math.PI * 2;
      for (const s of [-1, 1]) {
        const slot = new THREE.BoxGeometry(0.0016, rOut - rIn * 1.2, 0.007);
        slot.translate(s * (t + 0.0008), (rOut + rIn * 1.2) / 2, 0);
        slot.applyMatrix4(new THREE.Matrix4().makeRotationZ(0.22).premultiply(new THREE.Matrix4().makeRotationX(a)));
        parts.push(slot);
      }
    }
  }
  const g = mergeGeos(parts);
  return smoothNormals(g, 32);
}

/** Caliper body straddling the disc, with pistons and a raised (brand-free) logo plate. */
export function buildCaliper(R, W) {
  const rOut = R * 0.53;
  const parts = [];
  const span = 0.62; // radians of disc covered
  const N = 9;
  const path = [];
  for (let i = 0; i < N; i++) {
    const a = -span / 2 + (i / (N - 1)) * span;
    const c = Math.cos(a),
      s = Math.sin(a);
    path.push({
      o: [0, rOut * 1.055 * c, rOut * 1.055 * s],
      x: [1, 0, 0],
      y: [0, c, s],
    });
  }
  const prof = roundedRect(0.072, 0.062, 0.016, 3);
  parts.push(sweepProfile(prof, path, { cap: true }));

  // pistons on the inboard side
  for (let i = 0; i < 3; i++) {
    const a = -0.19 + i * 0.19;
    const p = new THREE.CylinderGeometry(0.014, 0.014, 0.03, 8);
    p.rotateZ(Math.PI / 2);
    p.translate(-0.03, rOut * 0.9, 0);
    p.applyMatrix4(new THREE.Matrix4().makeRotationX(a));
    parts.push(p);
  }
  // logo plate — a raised bar-glyph, deliberately abstract (no real marque)
  const plate = new THREE.BoxGeometry(0.052, 0.012, 0.006);
  plate.translate(0.0, rOut * 1.055 + 0.033, 0.0);
  parts.push(plate);
  for (let i = 0; i < 4; i++) {
    const bar = new THREE.BoxGeometry(0.0075, 0.007 + (i % 2) * 0.004, 0.003);
    bar.translate(-0.018 + i * 0.012, rOut * 1.055 + 0.0385, 0.0);
    parts.push(bar);
  }
  void W;
  const g = mergeGeos(parts);
  return smoothNormals(g, 40);
}

export { SPOKE_STYLES };
