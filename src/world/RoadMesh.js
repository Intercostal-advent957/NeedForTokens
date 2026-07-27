import * as THREE from 'three';
import { clamp } from '../core/MathX.js';
import { makeRoadMaterial } from './RoadMaterial.js';
import { BAND_LAYOUT, M, CENTRE_STATION, crossSection, makeProfile, profileAt } from './RoadProfile.js';

/**
 * Road surface geometry.
 *
 * The cross-section is the thing that sells a circuit, so it is modelled properly rather than
 * extruded as a flat ribbon: a 2.2% crown so water would run to the gutters, a painted edge, a
 * real 3D kerb with a ~20 deg sloped inner face you can actually ride, an asphalt shoulder that
 * steps down 130 mm, then gravel or grass run-off rising away to the barrier line, then the
 * embankment behind it. Every one of those bands is a different `surface` and `grip` in
 * sampleGround, and the physics can feel all of them. See RoadProfile.js for the section itself.
 *
 * Longitudinal tessellation is adaptive (1.15 m through kerbed corners, 4 m down straights) and
 * the result is split into ~92 m chunks so frustum culling actually does something — the road is
 * otherwise a single 3.9 km mesh that is never entirely off-screen.
 */

export class RoadMesh {
  constructor(track, ctx) {
    this.track = track;
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'Road';
    this.chunks = [];
  }

  build() {
    const track = this.track;
    const L = track.length;
    const f = track.features;
    const N = track.samples;

    // ---- adaptive ring positions along the lap
    const rings = [];
    {
      let s = 0;
      while (s < L) {
        rings.push(s);
        const i = Math.min(N - 1, Math.round(s / track.ds));
        const k = Math.abs(track._curv[i]);
        const kerbing = f.kerbL[i] + f.kerbR[i] > 0.005;
        const step = kerbing ? 1.15 : clamp(1.4 + (1 - clamp(k * 260, 0, 1)) * 2.6, 1.4, 4.0);
        s += step;
      }
      rings.push(L); // duplicate of ring 0's position, with s = L so the seam is watertight
    }

    const CHUNK = 92;
    const nChunks = Math.max(1, Math.round(L / CHUNK));
    const chunkOf = (s) => Math.min(nChunks - 1, Math.floor((s / L) * nChunks));

    this.material = makeRoadMaterial(this.ctx, L);

    // Group rings by chunk; each chunk repeats its boundary rings so the mesh is watertight.
    const buckets = Array.from({ length: nChunks }, () => []);
    for (let r = 0; r < rings.length - 1; r++) buckets[chunkOf(rings[r])].push(r);

    const off = new Float64Array(M);
    const dy = new Float64Array(M);
    const prof = makeProfile();
    const p = new THREE.Vector3();
    const rt = new THREE.Vector3();
    const up = new THREE.Vector3();
    let totalVerts = 0;
    let totalTris = 0;

    for (let c = 0; c < nChunks; c++) {
      const list = buckets[c];
      if (!list.length) continue;
      const r0 = list[0];
      const r1 = list[list.length - 1] + 1; // inclusive end ring, shared with the next chunk
      const nRings = r1 - r0 + 1;

      const position = new Float32Array(nRings * M * 3);
      const normal = new Float32Array(nRings * M * 3);
      const aTrk = new Float32Array(nRings * M * 4);
      const aMisc = new Float32Array(nRings * M * 4);
      const uv = new Float32Array(nRings * M * 2);

      for (let r = 0; r < nRings; r++) {
        const s = rings[r0 + r];
        const t = (s / L) % 1;
        const i = Math.min(N - 1, Math.round(((s % L) / L) * N)) % N;
        track.pointAt(t, p);
        track.rightAt(t, rt);
        track.upAt(t, up);
        profileAt(track, i, prof);
        const W = prof.W;
        crossSection(off, dy, prof);
        const curv = Math.abs(track._curv[i]);

        for (let m = 0; m < M; m++) {
          const b = r * M + m;
          const o = off[m];
          const d = dy[m];
          position[b * 3] = p.x + rt.x * o + up.x * d;
          position[b * 3 + 1] = p.y + rt.y * o + up.y * d;
          position[b * 3 + 2] = p.z + rt.z * o + up.z * d;
          aTrk[b * 4] = s;
          aTrk[b * 4 + 1] = o;
          aTrk[b * 4 + 2] = W;
          aTrk[b * 4 + 3] = prof.tunnel;
          // A kerb station with no kerb height is just shoulder: the geometry degenerates but
          // the band must too, or the whole lap gets painted red and white.
          let bandId = BAND_LAYOUT[m];
          if (bandId === 2 && (m > CENTRE_STATION ? prof.kR : prof.kL) < 0.012) bandId = 1;
          aMisc[b * 4] = bandId;
          aMisc[b * 4 + 1] = m > CENTRE_STATION ? prof.typeR : prof.typeL;
          aMisc[b * 4 + 2] = prof.style;
          aMisc[b * 4 + 3] = curv;
          // 2.4 m per texture tile — dense enough that the grain reads from the cockpit, and
          // the two-tap anti-tiling blend in RoadMaterial hides the repeat at distance.
          uv[b * 2] = o * (1 / 2.4);
          uv[b * 2 + 1] = s * (1 / 2.4);
        }
      }

      // ---- indices. Winding matters: stations run left -> right (+lateral) and rings run
      //      forward (+s), so (a, b=+lateral, c=+s) gives right x tangent = the road up vector.
      //      Get it the other way round and the whole circuit is back-face culled.
      const idx = [];
      for (let r = 0; r < nRings - 1; r++) {
        for (let m = 0; m < M - 1; m++) {
          const a = r * M + m;
          const bb = a + 1;
          const cc = a + M;
          const dd = cc + 1;
          idx.push(a, bb, cc, bb, dd, cc);
        }
      }

      // ---- smooth normals from the geometry itself: gets the kerb faces, the shoulder step
      //      and the run-off slope right without hand-authoring any of them
      computeNormals(position, idx, normal);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('aTrk', new THREE.BufferAttribute(aTrk, 4));
      geo.setAttribute('aMisc', new THREE.BufferAttribute(aMisc, 4));
      geo.setIndex(idx.length > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();

      const mesh = new THREE.Mesh(geo, this.material);
      mesh.name = `RoadChunk${c}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.chunks.push(mesh);
      totalVerts += nRings * M;
      totalTris += idx.length / 3;
    }

    this.stats = { chunks: this.chunks.length, verts: totalVerts, tris: totalTris, rings: rings.length };
    return this;
  }

  /**
   * Fallback wetness. Normally the assets lane mirrors `env.wetness` onto its shared uniform
   * and the whole world dresses together; this only does anything when that link is absent.
   */
  setWetness(w) {
    const ud = this.material?.userData;
    if (ud?.uniforms && !ud.sharedWetness) ud.uniforms.uWetLocal.value = w;
  }

  dispose() {
    for (const m of this.chunks) m.geometry.dispose();
    this.material?.dispose();
  }
}

/** Area-weighted vertex normals over an indexed triangle soup, straight into `out`. */
export function computeNormals(pos, idx, out) {
  out.fill(0);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    const e1x = pos[b] - pos[a];
    const e1y = pos[b + 1] - pos[a + 1];
    const e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a];
    const e2y = pos[c + 1] - pos[a + 1];
    const e2z = pos[c + 2] - pos[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]);
    if (l > 1e-9) {
      out[i] /= l;
      out[i + 1] /= l;
      out[i + 2] /= l;
    } else {
      out[i] = 0;
      out[i + 1] = 1;
      out[i + 2] = 0;
    }
  }
  return out;
}

