import * as THREE from 'three';
import { makeProfile, profileAt, surfaceDy } from './RoadProfile.js';
import { computeNormals } from './RoadMesh.js';

/**
 * Barriers: armco with real W-profile rail and posts, concrete Jersey blocks through the
 * tunnel and the built-up sections, debris fencing on the outside of the quick stuff, and
 * tyre stacks at the hairpin.
 *
 * These are also the collision geometry. The visual and the `world.barriers` segments are
 * generated from the same polyline in the same loop, so a wall you can see is a wall you hit —
 * the single most common way a track ends up feeling wrong is those two drifting apart.
 */

const SEG = 4.0; // metres per barrier polyline segment
const RAIL_H = 0.60; // rail centre above the barrier base
// Classic W-beam section: (depth toward the track, height about the rail centre)
const W_PROFILE = [
  [0.0, -0.155], [0.070, -0.112], [0.070, -0.040], [0.012, 0.0],
  [0.070, 0.040], [0.070, 0.112], [0.0, 0.155],
];

export class TrackBarriers {
  constructor(track, ctx) {
    this.track = track;
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'Barriers';
    this.segments = [];
  }

  build() {
    const track = this.track;
    const L = track.length;
    const n = Math.max(8, Math.round(L / SEG));
    const prof = makeProfile();

    // ---------------------------------------------------------------- polyline + typing
    // side -1 = left, +1 = right
    const lines = {};
    for (const side of [-1, 1]) {
      const pts = new Float32Array(n * 3);
      const inward = new Float32Array(n * 3);
      const kind = new Uint8Array(n); // 0 armco · 1 jersey · 2 tyres in front of armco
      const fence = new Uint8Array(n);
      const p = _p;
      const r = _r;
      const u = _u;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const si = track.indexAt(t);
        profileAt(track, si, prof);
        track.pointAt(t, p);
        track.rightAt(t, r);
        track.upAt(t, u);
        const off = side < 0 ? -prof.barL : prof.barR;
        const dy = surfaceDy(prof, off);
        pts[i * 3] = p.x + r.x * off + u.x * dy;
        pts[i * 3 + 1] = p.y + r.y * off + u.y * dy;
        pts[i * 3 + 2] = p.z + r.z * off + u.z * dy;
        inward[i * 3] = -side * r.x;
        inward[i * 3 + 1] = -side * r.y;
        inward[i * 3 + 2] = -side * r.z;

        const curv = track._curv[si];
        const runoff = side < 0 ? prof.roL : prof.roR;
        const outside = Math.sign(curv) === side || Math.abs(curv) < 0.0015;
        // Concrete where the circuit runs through town or a bore; steel everywhere else. Which
        // barrier you get is a real, readable cue about where you are on the lap.
        kind[i] = track.features.wall?.[si] > 0.5 || prof.tunnel > 0.2 ? 1 : 0;
        // Debris fencing where cars arrive fast, on the outside, with room to reach it
        fence[i] = kind[i] === 0 && outside && runoff > 14 ? 1 : 0;
      }
      lines[side] = { pts, inward, kind, fence };
    }

    // Tyre stacks at the two tightest corners, on the outside.
    const tyreSpots = [];
    for (const c of track.corners) {
      if (c.radius > 60) continue;
      const side = c.angle > 0 ? 1 : -1; // outside of the corner
      const s0 = c.s0 + c.len * 0.15;
      const s1 = c.s1 + 25;
      for (let s = s0; s < s1; s += 1.05) tyreSpots.push({ s: ((s % L) + L) % L, side });
      const i0 = Math.floor((((s0 % L) + L) % L / L) * n);
      const i1 = Math.floor((((s1 % L) + L) % L / L) * n);
      for (let k = i0; k !== (i1 + 1) % n; k = (k + 1) % n) lines[side].kind[k] = 2;
    }

    this._buildArmco(lines, n);
    this._buildJersey(lines, n);
    this._buildFence(lines, n);
    this._buildTyres(tyreSpots, prof);
    this._buildCollision(lines, n);

    return this;
  }

  // ------------------------------------------------------------------ armco

  _buildArmco(lines, n) {
    const P = W_PROFILE.length;
    const pos = [];
    const idx = [];
    const postM = [];
    let base = 0;

    for (const side of [-1, 1]) {
      const { pts, inward, kind } = lines[side];
      let run = [];
      const flush = () => {
        if (run.length < 2) {
          run = [];
          return;
        }
        const start = base;
        for (const i of run) {
          const px = pts[i * 3];
          const py = pts[i * 3 + 1];
          const pz = pts[i * 3 + 2];
          const ix = inward[i * 3];
          const iz = inward[i * 3 + 2];
          for (let k = 0; k < P; k++) {
            const [d, h] = W_PROFILE[k];
            pos.push(px + ix * d, py + RAIL_H + h, pz + iz * d);
          }
          base += P;
        }
        for (let a = 0; a < run.length - 1; a++) {
          for (let k = 0; k < P - 1; k++) {
            const v0 = start + a * P + k;
            const v1 = v0 + 1;
            const v2 = v0 + P;
            const v3 = v2 + 1;
            if (side < 0) idx.push(v0, v2, v1, v1, v2, v3);
            else idx.push(v0, v1, v2, v1, v3, v2);
          }
        }
        // posts every ~2.4 m, i.e. every other polyline sample at SEG = 4 m... use every 1
        for (let a = 0; a < run.length; a += 1) {
          const i = run[a];
          const m = new THREE.Matrix4();
          _q.setFromUnitVectors(_UP, _UP);
          const ang = Math.atan2(inward[i * 3], inward[i * 3 + 2]);
          _q.setFromAxisAngle(_UP, ang);
          m.compose(
            _v.set(pts[i * 3] + inward[i * 3] * 0.02, pts[i * 3 + 1] + 0.36, pts[i * 3 + 2] + inward[i * 3 + 2] * 0.02),
            _q,
            _s.set(1, 1, 1)
          );
          postM.push(m);
        }
        run = [];
      };
      for (let i = 0; i < n; i++) {
        if (kind[i] === 1) flush();
        else run.push(i);
      }
      // close the loop for this side
      flush();
    }

    if (idx.length) {
      const position = new Float32Array(pos);
      const normal = new Float32Array(pos.length);
      computeNormals(position, idx, normal);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
      geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const mat = new THREE.MeshStandardMaterial({
        color: 0x9aa1a8,
        roughness: 0.44,
        metalness: 0.82,
        envMapIntensity: 1.1,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'ArmcoRail';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.armco = mesh;
    }

    if (postM.length) {
      const g = new THREE.BoxGeometry(0.16, 0.72, 0.11);
      const m = new THREE.MeshStandardMaterial({ color: 0x6a7076, roughness: 0.6, metalness: 0.7 });
      const inst = new THREE.InstancedMesh(g, m, postM.length);
      postM.forEach((mm, i) => inst.setMatrixAt(i, mm));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.name = 'ArmcoPosts';
      this.group.add(inst);
    }
  }

  // ------------------------------------------------------------------ jersey barriers

  _buildJersey(lines, n) {
    const mats = [];
    for (const side of [-1, 1]) {
      const { pts, inward, kind } = lines[side];
      for (let i = 0; i < n; i++) {
        if (kind[i] !== 1) continue;
        const j = (i + 1) % n;
        const dx = pts[j * 3] - pts[i * 3];
        const dz = pts[j * 3 + 2] - pts[i * 3 + 2];
        const ang = Math.atan2(dx, dz);
        _q.setFromAxisAngle(_UP, ang);
        const m = new THREE.Matrix4();
        m.compose(
          _v.set(
            (pts[i * 3] + pts[j * 3]) * 0.5 + inward[i * 3] * 0.16,
            (pts[i * 3 + 1] + pts[j * 3 + 1]) * 0.5,
            (pts[i * 3 + 2] + pts[j * 3 + 2]) * 0.5 + inward[i * 3 + 2] * 0.16
          ),
          _q,
          _s.set(1, 1, Math.hypot(dx, dz) / SEG)
        );
        mats.push(m);
      }
    }
    if (!mats.length) return;
    const geo = jerseyGeometry(SEG);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xb4b0a6,
      roughness: 0.86,
      metalness: 0.0,
      envMapIntensity: 0.7,
    });
    // Tyre scuffs: a shader-side smear of black rubber along the lower kick of the profile,
    // which is exactly where cars actually rub a Jersey barrier.
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLocalPos;\nvarying vec3 vWPos;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n vLocalPos = position;\n vWPos = (modelMatrix * instanceMatrix * vec4(position,1.0)).xyz;'
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vLocalPos; varying vec3 vWPos;
          float jh(vec2 p){ p=fract(p*vec2(127.1,311.7)); p+=dot(p,p+34.2); return fract(p.x*p.y*4093.7); }`)
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           float band = smoothstep(0.62, 0.30, vLocalPos.y) * smoothstep(0.05, 0.24, vLocalPos.y);
           float smear = jh(floor(vec2(vWPos.x + vWPos.z, vWPos.y * 6.0) * 0.7));
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045,0.043,0.042), band * smear * 0.85);
           float grime = smoothstep(0.35, 0.0, vLocalPos.y);
           diffuseColor.rgb *= 1.0 - grime * 0.35;`
        );
    };
    mat.customProgramCacheKey = () => 'nft-jersey-v1';
    const inst = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.name = 'JerseyBarriers';
    this.group.add(inst);
  }

  // ------------------------------------------------------------------ debris fencing

  _buildFence(lines, n) {
    const pos = [];
    const idx = [];
    const postM = [];
    const H = [1.05, 1.75, 2.45]; // cable heights
    let base = 0;
    for (const side of [-1, 1]) {
      const { pts, inward, fence } = lines[side];
      let run = [];
      const flush = () => {
        if (run.length >= 3) {
          for (const h of H) {
            const start = base;
            for (const i of run) {
              const px = pts[i * 3] + inward[i * 3] * 0.05;
              const py = pts[i * 3 + 1];
              const pz = pts[i * 3 + 2] + inward[i * 3 + 2] * 0.05;
              const nx = -inward[i * 3 + 2];
              const nz = inward[i * 3];
              // a 60 mm square cable, 4 verts per ring
              pos.push(px + nx * 0.0, py + h + 0.03, pz + nz * 0.0);
              pos.push(px + inward[i * 3] * 0.03, py + h, pz + inward[i * 3 + 2] * 0.03);
              pos.push(px + nx * 0.0, py + h - 0.03, pz + nz * 0.0);
              pos.push(px - inward[i * 3] * 0.03, py + h, pz - inward[i * 3 + 2] * 0.03);
              base += 4;
            }
            for (let a = 0; a < run.length - 1; a++) {
              for (let k = 0; k < 4; k++) {
                const v0 = start + a * 4 + k;
                const v1 = start + a * 4 + ((k + 1) % 4);
                const v2 = v0 + 4;
                const v3 = v1 + 4;
                idx.push(v0, v2, v1, v1, v2, v3);
              }
            }
          }
          for (let a = 0; a < run.length; a++) {
            const i = run[a];
            const ang = Math.atan2(inward[i * 3], inward[i * 3 + 2]);
            _q.setFromAxisAngle(_UP, ang);
            const m = new THREE.Matrix4();
            m.compose(
              _v.set(pts[i * 3], pts[i * 3 + 1] + 1.35, pts[i * 3 + 2]),
              _q,
              _s.set(1, 1, 1)
            );
            postM.push(m);
          }
        }
        run = [];
      };
      for (let i = 0; i < n; i++) {
        if (!fence[i]) flush();
        else run.push(i);
      }
      flush();
    }
    if (idx.length) {
      const position = new Float32Array(pos);
      const normal = new Float32Array(pos.length);
      computeNormals(position, idx, normal);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
      geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: 0x8d949c, roughness: 0.5, metalness: 0.75 })
      );
      mesh.name = 'FenceCables';
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
    if (postM.length) {
      const g = new THREE.BoxGeometry(0.11, 2.7, 0.09);
      const m = new THREE.MeshStandardMaterial({ color: 0x7d848c, roughness: 0.55, metalness: 0.7 });
      const inst = new THREE.InstancedMesh(g, m, postM.length);
      postM.forEach((mm, i) => inst.setMatrixAt(i, mm));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      inst.name = 'FencePosts';
      this.group.add(inst);
    }
  }

  // ------------------------------------------------------------------ tyre stacks

  _buildTyres(spots, prof) {
    if (!spots.length) return;
    const track = this.track;
    const geo = new THREE.TorusGeometry(0.34, 0.135, 6, 14);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.92, metalness: 0 });
    const rows = 3;
    const inst = new THREE.InstancedMesh(geo, mat, spots.length * rows);
    let k = 0;
    const m = new THREE.Matrix4();
    for (const spot of spots) {
      const t = ((spot.s / track.length) % 1 + 1) % 1;
      const si = track.indexAt(t);
      profileAt(track, si, prof);
      track.pointAt(t, _p);
      track.rightAt(t, _r);
      track.upAt(t, _u);
      const off = spot.side < 0 ? -(prof.barL - 0.75) : prof.barR - 0.75;
      const dy = surfaceDy(prof, off);
      for (let row = 0; row < rows; row++) {
        _q.setFromAxisAngle(_UP, (spot.s * 1.7 + row * 2.1) % Math.PI);
        m.compose(
          _v.set(
            _p.x + _r.x * off + _u.x * dy,
            _p.y + _r.y * off + _u.y * dy + 0.16 + row * 0.30,
            _p.z + _r.z * off + _u.z * dy
          ),
          _q,
          _s.set(1, 1, 1)
        );
        inst.setMatrixAt(k++, m);
      }
    }
    inst.count = k;
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.name = 'TyreStacks';
    this.group.add(inst);
  }

  // ------------------------------------------------------------------ collision

  /** 2D XZ wall segments, exactly on the visual barrier line. See CONTRACTS.md §7. */
  _buildCollision(lines, n) {
    const stride = 2; // one segment per 8 m — plenty for capsule-vs-segment
    for (const side of [-1, 1]) {
      const { pts, inward, kind } = lines[side];
      for (let i = 0; i < n; i += stride) {
        const j = (i + stride) % n;
        const k = kind[i];
        this.segments.push({
          a: new THREE.Vector3(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]),
          b: new THREE.Vector3(pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2]),
          normal: new THREE.Vector3(inward[i * 3], 0, inward[i * 3 + 2]).normalize(),
          height: k === 1 ? 1.05 : k === 2 ? 1.4 : 0.85,
          restitution: k === 1 ? 0.24 : k === 2 ? 0.55 : 0.34,
          tag: 'barrier',
        });
      }
    }
  }
}

/** Jersey barrier cross-section, extruded `len` metres along +Z. */
function jerseyGeometry(len) {
  // (halfWidth, height) up one face of the profile
  const sec = [
    [0.30, 0.0], [0.30, 0.075], [0.165, 0.33], [0.115, 0.80], [0.105, 1.02], [0.0, 1.06],
  ];
  const pos = [];
  const idx = [];
  const half = len / 2;
  const ring = sec.length * 2 - 1;
  const ringPts = [];
  for (let i = 0; i < sec.length; i++) ringPts.push([-sec[i][0], sec[i][1]]);
  for (let i = sec.length - 2; i >= 0; i--) ringPts.push([sec[i][0], sec[i][1]]);
  for (const z of [-half, half]) for (const [x, y] of ringPts) pos.push(x, y, z);
  const R = ringPts.length;
  for (let i = 0; i < R - 1; i++) idx.push(i, i + 1, R + i, i + 1, R + i + 1, R + i);
  // caps
  for (let i = 1; i < R - 1; i++) idx.push(0, i + 1, i, R, R + i, R + i + 1);
  const position = new Float32Array(pos);
  const normal = new Float32Array(pos.length);
  computeNormals(position, idx, normal);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setIndex(idx);
  void ring;
  return g;
}

const _p = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _q = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0);
