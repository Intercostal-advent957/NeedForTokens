import * as THREE from 'three';
import { makeProfile, profileAt, surfaceDy } from './RoadProfile.js';
import { computeNormals } from './RoadMesh.js';

/**
 * Everything bolted to the circuit that is not road and not barrier: the tunnel bore, the
 * start/finish gantry, braking-distance boards, corner-name boards and marshal posts.
 *
 * Furniture is what makes a road read as a *circuit* rather than a strip of tarmac — the eye
 * uses the repeating scale cues (post heights, board spacing, gantry span) to judge speed.
 */
export class TrackFurniture {
  constructor(track, ctx) {
    this.track = track;
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'Furniture';
    this.lights = [];
  }

  build() {
    this._buildTunnel();
    this._buildGantry();
    this._buildBoards();
    return this;
  }

  // ------------------------------------------------------------------ tunnel

  _buildTunnel() {
    const track = this.track;
    const spans = track.featureSpec.tunnels || [];
    if (!spans.length) return;
    const prof = makeProfile();
    const pos = [];
    const idx = [];
    let base = 0;

    // arch section: (halfWidth factor, height) from the springing line up over the crown
    const ARCH = [];
    {
      const wallH = 3.2;
      const crown = 6.9;
      ARCH.push([1.0, -0.9], [1.0, wallH]);
      for (let a = 1; a <= 7; a++) {
        const th = (a / 7) * (Math.PI / 2);
        ARCH.push([Math.cos(th), wallH + (crown - wallH) * Math.sin(th)]);
      }
    }

    for (const span of spans) {
      const L = ((span.s1 - span.s0) % track.length + track.length) % track.length;
      const n = Math.max(6, Math.round(L / 4));
      const start = base;
      const rings = [];
      for (let i = 0; i <= n; i++) {
        const s = span.s0 + (L * i) / n;
        const t = ((s / track.length) % 1 + 1) % 1;
        profileAt(track, track.indexAt(t), prof);
        track.pointAt(t, _p);
        track.rightAt(t, _r);
        track.upAt(t, _u);
        // The bore hugs the barrier line: a tunnel you could park a stadium in has no drama.
        const halfW = Math.max(prof.barL, prof.barR) + 0.8;
        const floorDy = prof.edge - 0.5;
        // right wall (+) down over the crown to the left wall (-): one continuous strip
        const ring = [];
        for (let k = ARCH.length - 1; k >= 0; k--) ring.push([ARCH[k][0] * halfW, ARCH[k][1]]);
        for (let k = 1; k < ARCH.length; k++) ring.push([-ARCH[k][0] * halfW, ARCH[k][1]]);
        for (const [x, y] of ring) {
          pos.push(
            _p.x + _r.x * x + _u.x * (floorDy + y),
            _p.y + _r.y * x + _u.y * (floorDy + y),
            _p.z + _r.z * x + _u.z * (floorDy + y)
          );
        }
        rings.push(ring.length);
        base += ring.length;
      }
      const R = rings[0];
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < R - 1; k++) {
          const v0 = start + i * R + k;
          const v1 = v0 + 1;
          const v2 = v0 + R;
          const v3 = v2 + 1;
          // wound so the visible face is the INSIDE of the bore
          idx.push(v0, v1, v2, v1, v3, v2);
        }
      }

      // ---- lighting: sodium strips down the crown, plus a few real point lights so the car
      //      and the barriers actually get lit inside
      const nLights = Math.max(6, Math.round(L / 22));
      for (let i = 0; i < nLights; i++) {
        const s = span.s0 + (L * (i + 0.5)) / nLights;
        const t = ((s / track.length) % 1 + 1) % 1;
        profileAt(track, track.indexAt(t), prof);
        track.pointAt(t, _p);
        track.upAt(t, _u);
        // Sodium luminaires. Bright: an unlit bore is just a black hole with a car in it.
        const light = new THREE.PointLight(0xffc98c, 95, 46, 2);
        light.position.set(
          _p.x + _u.x * (prof.edge + 5.1),
          _p.y + _u.y * (prof.edge + 5.1),
          _p.z + _u.z * (prof.edge + 5.1)
        );
        light.castShadow = false;
        this.group.add(light);
        this.lights.push(light);
      }

      // emissive light strips along the crown (cheap, and they read in the mirror)
      // Luminaires: discrete 2.4 m panels every 7 m down the crown, each its own quad. Sweeping
      // one continuous ribbon and modulating its width just gives you tapered slivers.
      const stripGeo = [];
      const stripIdx = [];
      let sb = 0;
      const pitch = 7.0;
      const lampLen = 3.0;
      const nLamp = Math.max(2, Math.floor(L / pitch));
      for (let i = 0; i < nLamp; i++) {
        const sMid = span.s0 + pitch * (i + 0.5);
        for (const end of [-lampLen / 2, lampLen / 2]) {
          const t = (((sMid + end) / track.length) % 1 + 1) % 1;
          profileAt(track, track.indexAt(t), prof);
          track.pointAt(t, _p);
          track.rightAt(t, _r);
          track.upAt(t, _u);
          const h = prof.edge - 0.5 + 5.0;
          for (const side of [-1, 1]) {
            stripGeo.push(
              _p.x + _r.x * side * 0.5 + _u.x * h,
              _p.y + _r.y * side * 0.5 + _u.y * h,
              _p.z + _r.z * side * 0.5 + _u.z * h
            );
          }
        }
        const v = i * 4;
        stripIdx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        sb += 4;
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(stripGeo, 3));
      sg.setIndex(stripIdx);
      sg.computeVertexNormals();
      const strip = new THREE.Mesh(
        sg,
        new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: THREE.DoubleSide })
      );
      strip.name = 'TunnelLightStrip';
      strip.matrixAutoUpdate = false;
      this.group.add(strip);
      void sb;
    }

    if (!idx.length) return;
    const position = new Float32Array(pos);
    const normal = new Float32Array(pos.length);
    computeNormals(position, idx, normal);
    // flip: computeNormals gives outward-facing normals for this winding, we want inward
    for (let i = 0; i < normal.length; i++) normal[i] = -normal[i];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
    geo.computeBoundingSphere();

    const concrete = this.ctx.assets?.texture?.('concrete') ?? null;
    if (concrete) concrete.wrapS = concrete.wrapT = THREE.RepeatWrapping;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x5c5a55,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.25,
    });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vWP = (modelMatrix*vec4(transformed,1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWP;
          float th21(vec2 p){ p=fract(p*vec2(127.1,311.7)); p+=dot(p,p+34.2); return fract(p.x*p.y*4093.7); }
          float tn(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
            return mix(mix(th21(i),th21(i+vec2(1,0)),f.x), mix(th21(i+vec2(0,1)),th21(i+vec2(1,1)),f.x), f.y); }`)
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           // segment joints every 6 m and the white tiled lower wall you get in road tunnels
           float seg = smoothstep(0.03, 0.0, abs(fract(vWP.y*0.02 + (vWP.x+vWP.z)*0.1666) - 0.5) - 0.47);
           float grime = tn(vec2(vWP.x + vWP.z, vWP.y) * 0.35);
           float tile = step(vWP.y, 2.4);
           vec3 wall = mix(vec3(0.070,0.068,0.064), vec3(0.31,0.30,0.285), tile);
           wall *= 0.7 + grime * 0.6;
           wall = mix(wall, vec3(0.03), seg * 0.7);
           diffuseColor.rgb *= wall * 3.0;`
        );
    };
    mat.customProgramCacheKey = () => 'nft-tunnel-v1';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'TunnelBore';
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.tunnel = mesh;
  }

  // ------------------------------------------------------------------ start gantry

  _buildGantry() {
    const track = this.track;
    const prof = makeProfile();
    profileAt(track, 0, prof);
    track.pointAt(0, _p);
    track.rightAt(0, _r);
    track.upAt(0, _u);
    track.tangentAt(0, _t);

    const g = new THREE.Group();
    g.name = 'StartGantry';
    const span = prof.W * 2 + 2.6;
    const legH = 7.2;

    const steel = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.5, metalness: 0.75 });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 1.15, 0.62), steel);
    beam.position.y = legH;
    beam.castShadow = true;
    g.add(beam);
    const trussTop = new THREE.Mesh(new THREE.BoxGeometry(span, 0.16, 0.9), steel);
    trussTop.position.y = legH + 0.72;
    g.add(trussTop);

    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.58, legH, 0.58), steel);
      leg.position.set(side * (span / 2 - 0.3), legH / 2, 0);
      leg.castShadow = true;
      g.add(leg);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.35, 1.5), steel);
      foot.position.set(side * (span / 2 - 0.3), 0.17, 0);
      g.add(foot);
    }
    // start lights: five pairs of red lamps
    const lampGeo = new THREE.SphereGeometry(0.19, 10, 8);
    const lampMat = new THREE.MeshBasicMaterial({ color: 0x2a0605 });
    for (let i = 0; i < 5; i++) {
      for (const row of [0, 1]) {
        const l = new THREE.Mesh(lampGeo, lampMat);
        l.position.set((i - 2) * 1.5, legH - 0.05 - row * 0.42, -0.34);
        g.add(l);
      }
    }
    // banner face
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(span * 0.86, 0.92),
      new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.75, metalness: 0.1 })
    );
    banner.position.set(0, legH + 0.05, -0.33);
    g.add(banner);

    _m.makeBasis(_r, _u, _v.copy(_t).negate());
    g.quaternion.setFromRotationMatrix(_m);
    g.position.copy(_p).addScaledVector(_u, prof.edge);
    this.group.add(g);
    this.gantry = g;
  }

  // ------------------------------------------------------------------ braking boards

  _buildBoards() {
    const track = this.track;
    const boards = track.featureSpec.boards || [];
    if (!boards.length) return;
    const prof = makeProfile();

    const plate = new THREE.BoxGeometry(1.9, 1.45, 0.1);
    const post = new THREE.BoxGeometry(0.13, 1.9, 0.13);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.7, metalness: 0.3 });
    const plateMats = {
      200: new THREE.MeshStandardMaterial({ color: 0x1c60c8, roughness: 0.45 }),
      150: new THREE.MeshStandardMaterial({ color: 0x1c60c8, roughness: 0.45 }),
      100: new THREE.MeshStandardMaterial({ color: 0xd8a020, roughness: 0.45 }),
      50: new THREE.MeshStandardMaterial({ color: 0xc2302a, roughness: 0.45 }),
    };
    const buckets = new Map();
    const postM = [];

    for (const b of boards) {
      const t = ((b.s / track.length) % 1 + 1) % 1;
      profileAt(track, track.indexAt(t), prof);
      track.pointAt(t, _p);
      track.rightAt(t, _r);
      track.upAt(t, _u);
      track.tangentAt(t, _t);
      const off = b.side < 0 ? -(prof.soL + 1.1) : prof.soR + 1.1;
      const dy = surfaceDy(prof, off);
      _v.set(_p.x + _r.x * off + _u.x * dy, _p.y + _r.y * off + _u.y * dy, _p.z + _r.z * off + _u.z * dy);
      _m.makeBasis(_r, _u, _w.copy(_t).negate());
      _q.setFromRotationMatrix(_m);
      const mm = new THREE.Matrix4().compose(_v.clone().setY(_v.y + 2.05), _q, _one);
      (buckets.get(b.distance) || buckets.set(b.distance, []).get(b.distance)).push(mm);
      postM.push(new THREE.Matrix4().compose(_v.clone().setY(_v.y + 0.95), _q, _one));
    }

    for (const [dist, mats] of buckets) {
      const inst = new THREE.InstancedMesh(plate, plateMats[dist] ?? plateMats[100], mats.length);
      mats.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      inst.name = `BrakingBoard${dist}`;
      this.group.add(inst);
    }
    if (postM.length) {
      const inst = new THREE.InstancedMesh(post, postMat, postM.length);
      postM.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.name = 'BoardPosts';
      this.group.add(inst);
    }
  }
}

const _p = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _t = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
