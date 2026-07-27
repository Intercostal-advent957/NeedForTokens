import * as THREE from 'three';
import { GeoBuilder, KIND, col, tint } from './Geo.js';

/**
 * Far-field backdrop. Everything past the playable blocks is stacked boxes with the procedural
 * window grid (KIND.FARFACADE) — a few thousand triangles for the entire horizon, merged into a
 * handful of meshes so the whole skyline costs 4-5 draw calls. Scene fog does the atmospheric
 * fade for free because these use the same standard-material pipeline.
 */
export function buildSkyline(rng, centre, innerRadius = 640, outerRadius = 2900) {
  const rings = [
    { r0: innerRadius, r1: innerRadius + 320, count: 190, h: [22, 60], w: [26, 60] },
    { r0: innerRadius + 300, r1: innerRadius + 780, count: 210, h: [30, 105], w: [30, 78] },
    { r0: innerRadius + 740, r1: innerRadius + 1500, count: 190, h: [24, 78], w: [42, 110] },
    { r0: innerRadius + 1400, r1: outerRadius, count: 150, h: [18, 52], w: [70, 190] },
  ];
  // two downtown clusters so the horizon isn't a uniform hedge
  const hubs = [rng() * Math.PI * 2, rng() * Math.PI * 2 + 2.1];

  const groups = [[], [], [], []];
  const geoms = [];

  for (let gi = 0; gi < rings.length; gi++) {
    const ring = rings[gi];
    const b = new GeoBuilder();
    for (let i = 0; i < ring.count; i++) {
      const a = rng() * Math.PI * 2;
      const r = rng.range(ring.r0, ring.r1);
      const x = centre.x + Math.cos(a) * r;
      const z = centre.z + Math.sin(a) * r;

      // hub bonus: buildings near a cluster angle get much taller
      let boost = 1;
      for (const hub of hubs) {
        let d = Math.abs(((a - hub + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        boost = Math.max(boost, 1 + Math.max(0, 1 - d / 0.55) * rng.range(1.4, 3.4));
      }
      const falloff = 1 - (r - ring.r0) / (outerRadius - innerRadius);
      const h = rng.range(ring.h[0], ring.h[1]) * boost * (0.55 + falloff * 0.7);
      const w = rng.range(ring.w[0], ring.w[1]);
      const d2 = rng.range(ring.w[0], ring.w[1]);
      const yaw = rng() * Math.PI;
      const shade = rng.range(0.55, 1.0);
      const base = tint(rng.pick([0x4c5058, 0x545a62, 0x3f444b, 0x5c5f64, 0x484d55]), shade);

      const m = new THREE.Matrix4().makeRotationY(yaw);
      m.setPosition(x, 0, z);
      b.push(m);
      const stacks = h > 90 ? 3 : h > 45 ? 2 : 1;
      let y0 = -4;
      let cw = w;
      let cd = d2;
      for (let s = 0; s < stacks; s++) {
        const sh = (h - y0) * (s === stacks - 1 ? 1 : rng.range(0.45, 0.7));
        b.box(0, y0 + sh * 0.5, 0, cw, sh, cd, {
          color: base,
          kind: KIND.FARFACADE,
          seed: rng(),
          faces: 63 & ~8,
        });
        y0 += sh;
        cw *= rng.range(0.62, 0.84);
        cd *= rng.range(0.62, 0.84);
      }
      // crown light on the tall ones
      if (h > 95) {
        b.box(0, h + 1.2, 0, 2.2, 2.4, 2.2, { color: tint(0xff3020, 1), kind: KIND.NEON, seed: 0.9 });
      }
      b.pop();
      groups[gi].push(1);
    }
    geoms.push(b.geometry(`skyline-${gi}`));
  }
  return geoms;
}

/**
 * A ground haze ring: a big low-poly disc under the skyline so the horizon doesn't show the
 * void between the city apron and the backdrop.
 */
export function buildGroundHaze(centre, radius = 3400, inner = 900) {
  const b = new GeoBuilder();
  const seg = 48;
  const c0 = col(0x3a3f47);
  const c1 = col(0x42474f);
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const p = (a, r) => [centre.x + Math.cos(a) * r, -1.2, centre.z + Math.sin(a) * r];
    b.quad(p(a1, inner), p(a0, inner), p(a0, radius), p(a1, radius), {
      color: i % 2 ? c0 : c1,
      kind: KIND.ROAD,
      seed: (i * 0.137) % 1,
      w: 60,
      h: 60,
    });
  }
  return b.geometry('city-haze');
}
