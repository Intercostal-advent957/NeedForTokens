import * as THREE from 'three';
import { CAR_DEFS } from './carDefs.js';
import { clamp, clamp01, damp, lerp } from '../core/MathX.js';
import {
  buildShell,
  innerShell,
  shoulderAt,
  staticHubY,
  surfaceProbe,
  widthAt,
} from './CarBody.js';
import { buildTyre, buildRim, buildDisc, buildCaliper } from './CarWheels.js';
import {
  Bag,
  badge,
  diffuser,
  doorHandle,
  exhaustTip,
  grilleBars,
  headlight,
  interior,
  mirror,
  pocket,
  rearWing,
  scoop,
  sideSkirt,
  splitter,
  steeringWheel,
  taillight,
} from './CarDetails.js';
import { mergeGeos, smoothNormals, sweepProfile, roundedRect, triCount } from './CarLoft.js';
import {
  DENT_REGIONS,
  dentCentres,
  makeArchLiner,
  makeCarbon,
  makeCaliper,
  makeCavity,
  makeChrome,
  makeDisc,
  makeEmissive,
  makeGlass,
  makeInterior,
  makeLens,
  makePaint,
  makeReflector,
  makeRim,
  makeRubber,
  makeInnerSkin,
  makeSatinBlack,
  makeShutLine,
  applyEnv,
} from './CarMaterials.js';

/** Keep two-per-side lamp elements as separate meshes only where VFX needs an anchor. */
function mergeLamp(list) {
  return Array.isArray(list) && list.length > 1 ? mergeGeos(list) : list[0] ?? list;
}

/** Append `extra` to a grouped geometry as another run of material 0. */
function mergeWithGroups(base, extra) {
  const b = base.attributes.position.count;
  const merged = mergeGeos([base, extra]);
  for (const g of base.groups) merged.addGroup(g.start, g.count, g.materialIndex);
  merged.addGroup(b, extra.attributes.position.count, 0);
  return merged;
}

/**
 * Car meshes, materials and per-car visual state. See CONTRACTS.md §8.
 *
 * Bodies are lofted parametric surfaces (see CarBody/CarLoft) — no boxes. Everything a given
 * CarDef needs is built ONCE into a blueprint of shared geometries + shared materials; spawning
 * clones only the scene graph and the paint material (per-car colour), so eight cars on track
 * cost eight paint materials and zero extra geometry.
 */
export class CarSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.defs = CAR_DEFS;
    this.instances = [];
    this.player = null;
    this._blueprints = new Map();
    this._quality = 1;
    this._probeTex = null;
  }

  /**
   * REFLECTION PROBE WIRING — called by PostFxSystem (CONTRACTS §15) once its car probe has a
   * complete cube.
   *
   * `scene.environment` is a PMREM of the sky dome and nothing else, so a clearcoat sampling it
   * reflects a bare luminance ramp: no buildings, no road, no horizon. Setting `material.envMap`
   * overrides `scene.environment` for that material only, which is exactly the scope we want —
   * the world keeps the sky IBL, the cars get the local cube.
   *
   * Blueprint materials are shared between instances by design, so this is idempotent and costs
   * one traversal on the frame the probe first lands (and again whenever a car spawns).
   */
  setReflectionProbe(texture) {
    if (!texture || this._probeTex === texture) return;
    this._probeTex = texture;
    for (const c of this.instances) applyEnv(c.root, texture);
  }

  async init() {
    const tier = this.ctx.settings?.tier ?? 'high';
    this._quality = tier === 'low' || tier === 'medium' ? 0.4 : 1;
    return this;
  }

  onQuality(tier) {
    this._quality = tier === 'low' || tier === 'medium' ? 0.4 : 1;
  }

  spawn(defId, opts = {}) {
    const def = this.defs.find((d) => d.id === defId) || this.defs[0];
    // `hero` forces the full-detail blueprint without claiming the player slot (garage/photo).
    const hero = !!opts.isPlayer || !!opts.hero;
    const bp = this._blueprint(def, hero ? this._quality : this._quality * 0.72);
    const inst = this._assemble(def, bp, opts);
    inst.isPlayer = hero;
    this.instances.push(inst);
    if (hero) {
      this.player = inst;
      this.ctx.player = inst;
      this._addHeadlightBeams(inst);
    }
    if (opts.position) inst.root.position.copy(opts.position);
    if (opts.quaternion) inst.root.quaternion.copy(opts.quaternion);
    // A car spawned after the probe landed still needs the cube (its paint material is per-car,
    // so it did not inherit it from the blueprint).
    if (this._probeTex) applyEnv(inst.root, this._probeTex);
    this.ctx.scene.add(inst.root);
    return inst;
  }

  // ------------------------------------------------------------------ blueprint

  _blueprint(def, quality) {
    const key = `${def.id}|${Math.round(quality * 20)}`;
    const cached = this._blueprints.get(key);
    if (cached) return cached;
    const bp = this._build(def, quality);
    this._blueprints.set(key, bp);
    return bp;
  }

  _build(def, quality) {
    const L = def.length;
    const W = def.width;
    const H = def.height;
    const st = def.style ?? {};
    const shell = buildShell(def, quality);
    const { grid, rings, ringLen, zs, cabin } = shell;

    // ---------- shared materials ----------
    const tex = (n) => this.ctx.assets?.texture?.(n) ?? null;
    const mats = {
      glass: makeGlass(),
      trim: makeSatinBlack(0.5, tex('metalScratchNormal')),
      carbon: makeCarbon(tex('carbonFibre'), tex('carbonFibreNormal'), tex('carbonFibreRough')),
      chrome: makeChrome({ map: tex('brushedAlu'), normalMap: tex('brushedAluNormal') }),
      cavity: makeCavity(),
      archLiner: makeArchLiner(tex('metalScratchNormal')),
      lensClear: makeLens(0xffffff),
      lensRed: makeLens(0xff2a20, { roughness: 0.06 }),
      lensAmber: makeLens(0xff9a22),
      reflector: makeReflector(),
      ledWhite: makeEmissive(0xdce9ff, 4.5),
      ledRed: makeEmissive(0xff1810, 2.2),
      ledAmber: makeEmissive(0xff7a10, 2.0),
      ledReverse: makeEmissive(0xf2f6ff, 0.02),
      disc: makeDisc(),
      caliper: makeCaliper(st.caliper ?? 0xcc2418),
      rim: makeRim({
        color: st.rimColor ?? 0x9aa0a8,
        roughness: 0.24,
        // Outer flange radius — see buildRim: the barrel tops out at rimR * 1.014.
        radius: def.wheelRadius * 0.735 * 1.014,
        map: tex('brushedAlu'),
        normalMap: tex('brushedAluNormal'),
      }),
      rubber: makeRubber(tex('tireTread'), tex('tireNormal')),
      shutLine: makeShutLine(),
      innerSkin: makeInnerSkin(),
      interior: makeInterior(0x17181c),
      interiorDark: makeInterior(0x0a0b0d),
    };

    // ---------- detail bag ----------
    const bag = new Bag();
    const probe = surfaceProbe(grid, rings, ringLen, zs);
    const noseZ = -L / 2;
    const tailZ = L / 2;

    // Reference stations that actually have bodywork: just ahead of the front axle and just
    // behind the rear axle. Everything on the nose/tail is anchored off the real surface there.
    const zNose = noseZ + L * 0.1;
    const zTail = tailZ - L * 0.1;
    // The nose and tail domes carry the real surface this far past the last grid station, and
    // every anchor below comes from probing that grid. Without this bias the headlights, badges,
    // exhausts and the whole tail-light cluster end up INSIDE the bodywork.
    const outF = (shell.domeF ?? 0) * 0.75;
    const outR = (shell.domeR ?? 0) * 0.75;
    const noseTop = probe.topAt(zNose);
    const tailTop = probe.topAt(zTail);
    const noseHalf = probe.halfWidthAt(zNose).x;
    const tailHalf = probe.halfWidthAt(zTail).x;

    // ---- front: splitter + intakes + grille ----
    const noseTipZ = probe.faceZ(0, H * 0.24, true, 0.16) ?? noseZ;
    if ((st.splitterVanes ?? 1) >= 0) {
      // Hang the blade off the REAL underside of the bumper and start it 18 cm inside the body,
      // so it is always intersecting bodywork no matter what shape the nose ended up.
      const zBack = noseTipZ + 0.24;
      // Width must be sampled AT THE SPLITTER'S OWN HEIGHT. `halfWidthAt` returns the widest
      // point of the station, which is up at the beltline — using it made the blade stick out
      // 20 cm past the bumper on each side, reading as a slab lying on the road beside the car.
      const spSpan = probe.halfWidthAt(zBack).x * 0.82;
      // ...and the height comes from the underside AT that span, not from the floor centreline.
      const spY = probe.underEdgeY(zBack, spSpan) + 0.004;
      // Ahead of the last station the body is the nose DOME, whose cross-section shrinks fast.
      // `widthAtHeight` clamps to the last station and keeps reporting the full nose width, so
      // without this taper the blade tip is twice as wide as the bodywork it is bolted to.
      const spHalf = (z) => {
        const base = Math.min(
          spSpan,
          Math.max(probe.widthAtHeight(z, spY + 0.07) * 0.98, spSpan * 0.3)
        );
        if (z >= noseTipZ) return base;
        const t = clamp01((noseTipZ - z) / Math.max(outF + 0.02, 1e-4));
        return base * lerp(1, 0.4, t);
      };
      bag.add('carbon', splitter(spHalf, zBack, noseTipZ - outF - 0.02, spY, st.splitterVanes ?? 2));
    }

    const grilleStyle = st.grille ?? 'mesh';
    if (grilleStyle !== 'closed') {
      const gy = H * 0.3;
      const gAnchor = probe.anchor(0, gy, true);
      const gw = Math.min(
        grilleStyle === 'wide' ? W * 0.58 : W * 0.42,
        probe.widthAtHeight(gAnchor.z + 0.05, gy) * 1.7 || W * 0.4
      );
      const gh = grilleStyle === 'slot' ? H * 0.085 : H * 0.14;
      const p = pocket(gw, gh, 0.13, gh * 0.28);
      p.translate(0, gy, gAnchor.z - outF + 0.004);
      bag.add('cavity', p);
      const bars = grilleBars(
        gw * 0.88,
        gh * 0.8,
        0,
        grilleStyle === 'mesh' ? 13 : 3,
        grilleStyle === 'mesh' ? 4 : 2
      );
      bars.translate(0, gy, gAnchor.z - outF + 0.035);
      bag.add('trim', bars);
    }
    // side intakes: pulled inboard until they sit on real bodywork
    for (const s of [-1, 1]) {
      const iy = H * 0.24;
      const a = probe.anchor(s * noseHalf * 0.66, iy, true);
      const p = pocket(W * 0.2, H * 0.11, 0.12, 0.022);
      p.translate(a.x, a.y, a.z - outF + 0.004);
      bag.add('cavity', p);
      const v = grilleBars(W * 0.17, H * 0.08, 0, 2, 3);
      v.translate(a.x, a.y, a.z - outF + 0.032);
      bag.add('trim', v);
    }

    // ---- headlights ----
    const hlW = W * 0.29;
    const hlH = H * 0.105;
    // Sit the lamp just under the top of the front wing, where a real headlight lives.
    const hlY = noseTop * 0.8;
    const lampGeo = { headHousing: [], headRefl: [], headLed: [], headDrl: [], headLens: [] };
    for (const s of [-1, 1]) {
      const a = probe.anchor(s * noseHalf * 0.6, hlY, true);
      const hl = headlight(hlW, hlH, 0.09, st.headlight ?? 'quad');
      const mm = new THREE.Matrix4()
        .makeTranslation(a.x, a.y, a.z - outF + 0.006)
        .multiply(new THREE.Matrix4().makeRotationY(-s * 0.2))
        .multiply(new THREE.Matrix4().makeRotationZ(s * -0.08));
      lampGeo.headHousing.push(hl.housing.applyMatrix4(mm));
      lampGeo.headRefl.push(hl.reflector.applyMatrix4(mm));
      lampGeo.headLed.push(hl.led.applyMatrix4(mm));
      lampGeo.headDrl.push(hl.drl.applyMatrix4(mm));
      lampGeo.headLens.push(hl.lens.applyMatrix4(mm));
    }

    // ---- tail lights ----
    const tlW = W * 0.32;
    const tlH = H * 0.085;
    // Two thirds of the way up the actual rear FACE. Scaling the whole-body top by 0.86 put the
    // cluster above the tail panel entirely once the tail was tucked, so `anchor` slid it onto
    // the deck and the rear of the car had no visible lamps at all.
    const tlY = lerp(probe.bottomAt(tailZ - 0.05), probe.topAt(tailZ - 0.05), 0.66);
    const tailGeo = { housing: [], fins: [], core: [], lens: [] };
    for (const s of [-1, 1]) {
      const a = probe.anchor(s * tailHalf * 0.58, tlY, false);
      const tl = taillight(tlW, tlH, 0.07, st.taillight ?? 'bar');
      const mm = new THREE.Matrix4()
        .makeTranslation(a.x, a.y, a.z + outR - 0.006)
        .multiply(new THREE.Matrix4().makeRotationY(Math.PI + s * 0.16));
      tailGeo.housing.push(tl.housing.applyMatrix4(mm));
      tailGeo.fins.push(tl.fins.applyMatrix4(mm));
      tailGeo.core.push(tl.core.applyMatrix4(mm));
      tailGeo.lens.push(tl.lens.applyMatrix4(mm));
    }
    // Full-width LED signature bar joining the two clusters. At chase distance the individual
    // lamps are a few pixels each and read as nothing; the continuous bar is what actually
    // identifies the car in the mirror, and it is the single strongest rear-end cue modern
    // performance cars have. Swept through anchors probed on the real tail surface so it hugs
    // whatever curve the loft ended up with.
    {
      const barPath = [];
      const N = 9;
      for (let i = 0; i < N; i++) {
        const x = lerp(-tailHalf * 0.74, tailHalf * 0.74, i / (N - 1));
        const a = probe.anchor(x, tlY, false);
        barPath.push({ o: [a.x, a.y, a.z + outR - 0.008], x: [0, 0, 1], y: [0, 1, 0] });
      }
      tailGeo.core.push(sweepProfile(roundedRect(0.028, H * 0.032, 0.01, 3), barPath, { cap: true }));
      const trough = sweepProfile(roundedRect(0.05, H * 0.055, 0.016, 3), barPath, { cap: true });
      trough.translate(0, 0, 0.014);
      bag.add('cavity', trough);
    }
    // reverse + fog cluster low in the diffuser
    const revGeo = [];
    for (const s of [-1, 1]) {
      const a = probe.anchor(s * tailHalf * 0.42, H * 0.26, false);
      const r = new THREE.BoxGeometry(0.075, 0.032, 0.006);
      r.translate(a.x, a.y, a.z + outR - 0.004);
      revGeo.push(r);
    }

    // ---- rear aero ----
    if (st.wing) {
      bag.add(
        'carbon',
        rearWing(W * st.wing.span, st.wing.chord, st.wing.height, tailZ * st.wing.z, probe.topAt(tailZ * st.wing.z) - 0.02, {
          struts: st.wing.struts ?? 2,
        })
      );
    }
    if (st.ducktail) {
      const d = st.ducktail;
      const path = [];
      for (let i = 0; i < 7; i++) {
        const t = i / 6;
        const x = lerp(-W * d.span * 0.5, W * d.span * 0.5, t);
        const drop = Math.sin(t * Math.PI) * 0.012;
        path.push({ o: [x, H * d.y + drop, tailZ * d.z], x: [0, 0, 1], y: [0, 1, 0] });
      }
      const lip = sweepProfile(
        [
          [-0.1, -0.012],
          [0.06, -0.02],
          [0.09, d.rise],
          [0.05, d.rise + 0.012],
          [-0.1, 0.012],
        ],
        path,
        { cap: true }
      );
      bag.add('paint', lip);
    }
    if (st.roofSpoiler) {
      const r = st.roofSpoiler;
      const path = [];
      for (let i = 0; i < 6; i++) {
        const t = i / 5;
        path.push({
          o: [lerp(-W * r.span * 0.5, W * r.span * 0.5, t), H * r.y, tailZ * r.z],
          x: [0, 0, 1],
          y: [0, 1, 0],
        });
      }
      bag.add('paint', sweepProfile(roundedRect(r.len, 0.05, 0.02, 3), path, { cap: true }));
    }
    if (st.diffuser) {
      const d = st.diffuser;
      bag.add('carbon', diffuser(tailHalf * 1.75, d.len, d.drop, tailZ - 0.05, H * 0.14, d.fins));
    }

    // ---- exhausts ----
    const exhaustAnchors = [];
    const nEx = st.exhaust?.count ?? 2;
    for (let i = 0; i < nEx; i++) {
      const sp = st.exhaust.spread;
      const x =
        nEx === 1 ? 0 : lerp(-W * sp, W * sp, nEx === 1 ? 0.5 : i / (nEx - 1));
      const a = probe.anchor(x, H * st.exhaust.y, false);
      const e = exhaustTip(st.exhaust.r, 0.16, a.x, a.y, a.z + outR + 0.01);
      bag.add('chrome', e.tip);
      bag.add('cavity', e.bore);
      exhaustAnchors.push(new THREE.Vector3(a.x, a.y, a.z + 0.05));
    }
    if (nEx === 0) {
      // EV: a pair of aero vents where the pipes would be
      for (const s of [-1, 1]) {
        const a = probe.anchor(s * tailHalf * 0.62, H * 0.26, false);
        const p = pocket(0.11, 0.05, 0.06, 0.018);
        p.rotateY(Math.PI);
        p.translate(a.x, a.y, a.z + outR - 0.004);
        bag.add('cavity', p);
        exhaustAnchors.push(new THREE.Vector3(a.x, a.y, a.z + 0.04));
      }
    }

    // ---- side skirts, mirrors, handles, badges ----
    const sillZ0 = -def.wheelbase / 2 + shell.arches[0].r * 1.14;
    const sillZ1 = def.wheelbase / 2 - shell.arches[1].r * 1.14;
    const sillMid = (sillZ0 + sillZ1) * 0.5;
    const sillY = probe.bottomAt(sillMid) + 0.055;
    const sillHalf = (z) => Math.max(probe.widthAtHeight(z, sillY), probe.halfWidthAt(z).x * 0.72);
    for (const s of [-1, 1]) bag.add('carbon', sideSkirt(s, sillHalf, sillY, sillZ0, sillZ1, 0.05));
    // ---- wing mirrors ----
    // Every def gets these — they were never conditional — but they were anchored to the WIDEST
    // point of the station, which is the hip, so they came out level with the top of the front
    // tyre and half the size of a door handle. Anchoring to the shoulder puts them at the base
    // of the A-pillar, and the size is now tied to the car's width rather than half of it.
    const mirrorZ = cabin.z0 + (cabin.z1 - cabin.z0) * 0.1;
    const mw = shoulderAt(grid, rings, ringLen, zs, mirrorZ, 0.88);
    for (const s of [-1, 1]) {
      const mi = mirror(s, s * (mw.x - 0.015), mw.y + 0.015, mirrorZ, W * 0.62);
      bag.add('carbon', mi.stalk);
      bag.add('paint', mi.cap);
      bag.add('chrome', mi.glass);
    }
    const handleZ = cabin.z0 + (cabin.z1 - cabin.z0) * 0.45;
    const hwd = widthAt(grid, rings, ringLen, zs, handleZ);
    for (const s of [-1, 1]) {
      const dh = doorHandle(s * (hwd.x + 0.002), hwd.y - 0.03, handleZ, 0.14, s);
      bag.add('cavity', dh.pocket);
      bag.add('chrome', dh.bar);
    }
    const bF = probe.anchor(0, noseTop * 0.62, true);
    const bR = probe.anchor(0, tailTop * 0.74, false);
    bag.add('chrome', badge(0.05, 0, bF.y, bF.z - outF + 0.012, -1));
    bag.add('chrome', badge(0.046, 0, bR.y, bR.z + outR - 0.012, 1));

    // ---- scoops / vents ----
    if (st.scoop) {
      const sc = st.scoop;
      const s2 = scoop(
        W * sc.w,
        H * sc.h,
        L * sc.len * 0.22,
        0,
        H * sc.y,
        (L / 2) * sc.z,
        sc.where === 'deck'
      );
      bag.add('paint', s2.shell);
      bag.add('cavity', s2.mouth);
    }
    if (st.vents) {
      for (const s of [-1, 1]) {
        const v = pocket(0.16, 0.045, 0.05, 0.014);
        v.rotateX(Math.PI / 2);
        v.translate(s * W * 0.24, H * 0.66, -L * 0.2);
        bag.add('cavity', v);
        const b2 = grilleBars(0.14, 0.035, 0, 1, 3);
        b2.rotateX(Math.PI / 2);
        b2.translate(s * W * 0.24, H * 0.665, -L * 0.2);
        bag.add('trim', b2);
      }
    }

    // ---- interior ----
    const inr = interior(def, cabin, { cage: st.cage, seatSpread: st.seatSpread });

    // ---------- wheels ----------
    const R = def.wheelRadius;
    const Wd = def.wheelWidth;
    const rimR = R * 0.735;
    const wq = quality >= 0.9 ? 1 : 0.4;
    const wheelGeo = {
      tyre: buildTyre(R, Wd, rimR, wq),
      rim: buildRim(R, Wd, st.rim ?? 'y', wq),
      disc: buildDisc(R, Wd, wq),
      caliper: buildCaliper(R, Wd),
    };

    const details = bag.build(
      {
        paint: null, // paint pieces are merged into the per-instance paint mesh below
        trim: mats.trim,
        carbon: mats.carbon,
        chrome: mats.chrome,
        cavity: mats.cavity,
      },
      44,
      { carbon: 2.4, trim: 1.8, chrome: 1.4 }
    );
    const paintExtras = bag.map.get('paint');

    // One body geometry with groups [paint, glass, paint] — the nose/tail caps and the
    // paint-coloured details ride along instead of costing their own draw calls.
    // The arch lips are body-coloured, so they ride in the paint group rather than costing a
    // draw call and a second material that would never quite match.
    const extras = [shell.lips];
    if (paintExtras) extras.push(smoothNormals(mergeGeos(paintExtras), 44));
    const bodyGeo = mergeWithGroups(shell.shell, mergeGeos(extras));
    // Dark inner skin drawn BackSide: through the glass you see a cabin, not the far window.
    const innerGeo = innerShell(shell.shell, 0.02);

    // Passive halves collapse to one draw; the emissive elements stay split so VFX can hang a
    // light cone off each side.
    for (const k of ['headHousing', 'headRefl', 'headDrl', 'headLens']) lampGeo[k] = mergeLamp(lampGeo[k]);
    for (const k of ['housing', 'fins', 'lens']) tailGeo[k] = mergeLamp(tailGeo[k]);

    return {
      def,
      quality,
      shell,
      bodyGeo,
      innerGeo,
      mats,
      details,
      lampGeo,
      tailGeo,
      revGeo: mergeGeos(revGeo),
      interiorGeo: { trim: smoothNormals(inr.trim, 40), dark: smoothNormals(inr.dark, 40) },
      wheelGeo,
      steerGeo: steeringWheel(W * 0.09),
      exhaustAnchors,
      dents: dentCentres(L, W, H),
      hubY: shell.hubY ?? staticHubY(def),
      archTop: shell.archTop ?? def.wheelRadius * 2.2,
      cabin,
    };
  }

  // ------------------------------------------------------------------ assembly

  _assemble(def, bp, opts) {
    const L = def.length;
    const W = def.width;
    const H = def.height;
    const st = def.style ?? {};
    const paintHex = opts.paint ?? def.paint.base;

    const root = new THREE.Group();
    root.name = `Car_${def.id}`;
    const body = new THREE.Group(); // everything that leans with weight transfer
    root.add(body);

    // ---- paint (fresh material per car: colour + damage uniforms are per-instance) ----
    const paintMat = makePaint({
      color: paintHex,
      flake: def.paint.flake,
    });

    const shellMesh = new THREE.Mesh(bp.bodyGeo, [paintMat, bp.mats.glass]);
    shellMesh.castShadow = true;
    shellMesh.receiveShadow = true;
    body.add(shellMesh);

    if (bp.shell.grooves) {
      const gr = new THREE.Mesh(bp.shell.grooves, bp.mats.shutLine);
      body.add(gr);
    }
    const liners = new THREE.Mesh(bp.shell.liners, bp.mats.archLiner);
    liners.castShadow = false;
    liners.receiveShadow = true;
    body.add(liners);
    const inner = new THREE.Mesh(bp.innerGeo, bp.mats.innerSkin);
    inner.castShadow = false;
    inner.receiveShadow = false;
    body.add(inner);

    for (const d of bp.details) {
      const m = new THREE.Mesh(d.mesh.geometry, d.mesh.material);
      m.castShadow = false;
      m.receiveShadow = d.key === 'carbon';
      body.add(m);
    }

    // ---- interior ----
    const inTrim = new THREE.Mesh(bp.interiorGeo.trim, bp.mats.interior);
    const inDark = new THREE.Mesh(bp.interiorGeo.dark, bp.mats.interiorDark);
    body.add(inTrim, inDark);

    const steeringWheelMesh = new THREE.Mesh(bp.steerGeo, bp.mats.interior);
    steeringWheelMesh.position.set(-W * 0.19, H * 0.52, bp.cabin.z0 + 0.3);
    steeringWheelMesh.rotation.x = -0.42;
    body.add(steeringWheelMesh);

    // ---- lamps: separate meshes so VFX can hang light cones off each side ----
    const mkLamp = (geos, mat, cast = false) =>
      geos.map((g) => {
        const m = new THREE.Mesh(g, mat);
        m.castShadow = cast;
        body.add(m);
        return m;
      });

    // shared lamp materials must be per-instance so brake/head state is per-car
    const lampMats = {
      ledWhite: makeEmissive(0xdce9ff, 0.05),
      drl: makeEmissive(0xa8c8ff, 0.9),
      ledRed: makeEmissive(0xff2214, 0.6),
      reverse: makeEmissive(0xf2f6ff, 0.02),
    };

    mkLamp([bp.lampGeo.headHousing], bp.mats.cavity);
    mkLamp([bp.lampGeo.headRefl], bp.mats.reflector);
    const head = mkLamp(bp.lampGeo.headLed, lampMats.ledWhite);
    const drl = mkLamp([bp.lampGeo.headDrl], lampMats.drl);
    mkLamp([bp.lampGeo.headLens], bp.mats.lensClear);

    mkLamp([bp.tailGeo.housing], bp.mats.cavity);
    mkLamp([bp.tailGeo.fins], bp.mats.chrome);
    const tail = mkLamp(bp.tailGeo.core, lampMats.ledRed);
    mkLamp([bp.tailGeo.lens], bp.mats.lensRed);
    const reverse = [new THREE.Mesh(bp.revGeo, lampMats.reverse)];
    body.add(reverse[0]);

    // ---- wheels ----
    const wheels = [];
    const R = def.wheelRadius;
    const wb = def.wheelbase;
    const tw = def.track;
    const layout = [
      [-tw / 2, -wb / 2, true, true],
      [tw / 2, -wb / 2, true, false],
      [-tw / 2, wb / 2, false, true],
      [tw / 2, wb / 2, false, false],
    ];
    const discMats = [];
    for (const [x, z, isFront, isLeft] of layout) {
      const pivot = new THREE.Group();
      pivot.position.set(x, bp.hubY, z);
      root.add(pivot);
      const spin = new THREE.Group();
      pivot.add(spin);

      const tyre = new THREE.Mesh(bp.wheelGeo.tyre, bp.mats.rubber);
      tyre.castShadow = true;
      const rim = new THREE.Mesh(bp.wheelGeo.rim, bp.mats.rim);
      rim.castShadow = false;
      // outboard face points away from the car centre
      const flip = isLeft ? -1 : 1;
      tyre.scale.x = flip;
      rim.scale.x = flip;
      spin.add(tyre, rim);

      const discMat = makeDisc();
      discMats.push(discMat);
      const disc = new THREE.Mesh(bp.wheelGeo.disc, discMat);
      disc.scale.x = flip;
      spin.add(disc);

      const caliper = new THREE.Mesh(bp.wheelGeo.caliper, bp.mats.caliper);
      caliper.scale.x = flip;
      caliper.rotation.x = isFront ? 0.55 : Math.PI - 0.55;
      pivot.add(caliper);

      wheels.push({
        pivot,
        mesh: spin,
        brakeDisc: disc,
        caliper,
        radius: R,
        isFront,
        isLeft,
        // RIDE HEIGHT CONTRACT — see the header of src/physics/Vehicle.js.
        //   suspensionOffset = pen - pen0   (deviation from static rest, + = compressed)
        //   pivot.position.y = staticHubY(def) + suspensionOffset
        // staticHubY lives in CarBody.js and must stay in lockstep with that file.
        hubY: bp.hubY,
        maxY: bp.archTop - R - 0.012,
        minY: bp.hubY - def.suspension.travel,
      });
      pivot.position.y = bp.hubY;
    }

    // ---- emitters ----
    const exhausts = bp.exhaustAnchors.map((p) => {
      const o = new THREE.Object3D();
      o.position.copy(p);
      body.add(o);
      return o;
    });
    const nosPorts = exhausts.length
      ? exhausts
      : [
          (() => {
            const o = new THREE.Object3D();
            o.position.set(0, H * 0.3, L / 2);
            body.add(o);
            return o;
          })(),
        ];

    let underglow = null;
    if (st.underglow) {
      underglow = new THREE.PointLight(st.underglow, 0, 4.5, 2);
      underglow.position.set(0, 0.12, 0);
      root.add(underglow);
    }

    // ---------------------------------------------------------------- instance
    const dentVec = paintMat.userData.u.uDent.value;
    const dentIdx = Object.fromEntries(DENT_REGIONS.map((r, i) => [r, i]));
    const damage = Object.fromEntries(DENT_REGIONS.map((r) => [r, 0]));

    const inst = {
      def,
      id: def.id,
      isPlayer: false,
      root,
      body,
      wheels,
      lights: { head, tail, brake: tail, reverse, indicator: drl, drl, underglow, beams: [] },
      exhausts,
      nosPorts,
      steeringWheel: steeringWheelMesh,
      driver: null,
      state: null,

      _paint: paintMat,
      _lampMats: lampMats,
      _discMats: discMats,
      _brakeGlow: 0,
      _lean: { roll: 0, pitch: 0, heave: 0 },
      _headOn: false,

      setPaint(colorHex, flakeHex) {
        paintMat.color.setHex(colorHex);
        if (flakeHex !== undefined) paintMat.userData.u.uFlakeColor.value.setHex(flakeHex);
      },

      setBrakeGlow(t) {
        const v = clamp01(t);
        inst._brakeGlow = v;
        // Iron goes dull-red -> orange -> straw. Front discs run hotter than the rears.
        for (let i = 0; i < discMats.length; i++) {
          const bias = i < 2 ? 1 : 0.72;
          const g = clamp01(v * bias);
          const m = discMats[i];
          m.emissive.setRGB(g, g * g * 0.22, g * g * g * g * 0.03);
          m.emissiveIntensity = g * g * 1.15;
          // Cold iron has to stay light enough to read THROUGH the spokes at chase distance —
          // this write happens every frame, so it, not makeDisc's constructor colour, is what
          // actually sets the disc's brightness.
          m.color.setRGB(lerp(0.4, 0.36, g), lerp(0.41, 0.24, g), lerp(0.44, 0.2, g));
        }
      },

      _tailOn: false,
      setLights({ head: h, brake: b, reverse: rv, drl: dr, tail: tl } = {}) {
        if (h !== undefined) {
          inst._headOn = !!h;
          lampMats.ledWhite.emissiveIntensity = h ? 1.6 : 0.05;
          for (const L2 of inst.lights.beams) L2.intensity = h ? L2.userData.base : 0;
        }
        if (dr !== undefined) lampMats.drl.emissiveIntensity = dr ? 1.1 : 0.3;
        if (tl !== undefined) inst._tailOn = !!tl;
        if (b !== undefined || tl !== undefined) {
          // Running tails have to be bright enough to survive tone mapping at chase distance,
          // and braking must still be an unmistakable jump above that.
          lampMats.ledRed.emissiveIntensity = b ? 6.5 : inst._tailOn ? 2.4 : 0.6;
        }
        if (rv !== undefined) lampMats.reverse.emissiveIntensity = rv ? 2.6 : 0.02;
      },

      setDamage(region, t) {
        const i = dentIdx[region];
        if (i === undefined) return;
        const v = clamp01(t);
        damage[region] = v;
        const c = bp.dents[region];
        dentVec[i].set(c.x, c.y, c.z, v);
        let worst = 0;
        for (const r of DENT_REGIONS) worst = Math.max(worst, damage[r]);
        paintMat.userData.u.uWear.value = worst * 0.55;
      },

      applyPhysics(s) {
        if (!s) return;
        root.position.copy(s.position);
        root.quaternion.copy(s.quaternion);
        for (let i = 0; i < 4; i++) {
          const w = wheels[i];
          const ws = s.wheels[i];
          if (!ws) continue;
          // Hub rides from the chassis hardpoint, and is clamped so the tyre can never punch
          // through the top of the arch on a big compression.
          const off = Number.isFinite(ws.suspensionOffset) ? ws.suspensionOffset : 0;
          w.pivot.position.y = clamp(w.hubY + off, w.minY, w.maxY);
          // SIGN CONVENTION — both of these are negated, and both negations are load-bearing.
          //
          // Steering: a Three.js rotation of +psi about +Y sends the car's forward axis (0,0,-1)
          // to x = -sin(psi). Physics publishes `steerAngle` with the opposite handedness
          // (heading_x = +sin(steerAngle)), so passing it through unnegated pointed the front
          // wheels OUT of every corner. Measured: steerAngle +14 deg gave a physics heading of
          // x = +0.243 and a rendered heading of x = -0.243.
          //
          // Rolling: a rotation of +theta about +X carries the TOP of the wheel toward +Z, and
          // forward is -Z, so a forward-rolling wheel must have a DECREASING rotation.x.
          // Measured: spin +61.5 rad/s (forward) drove rotation.x at +10.7 rad over 0.15 s.
          //
          // `state.steerAngle` / `state.angle` are read by other lanes (§9 says treat as
          // read-only), so the correction belongs here and not in the published state.
          w.pivot.rotation.y = -(ws.steerAngle ?? 0);
          w.mesh.rotation.x = -(ws.angle ?? 0);
          w.caliper.rotation.y = 0;
        }
        if (steeringWheelMesh) steeringWheelMesh.rotation.z = -(s.steer ?? 0) * 2.4;
      },
    };
    return inst;
  }

  /** Two spot lights for the hero car so night shots have real throw. Player only, no shadows. */
  _addHeadlightBeams(inst) {
    if (!this.ctx.settings) return;
    const def = inst.def;
    for (const s of [-1, 1]) {
      const l = new THREE.SpotLight(0xdfe9ff, 0, 62, 0.42, 0.55, 1.4);
      l.userData.base = 46;
      l.position.set(s * def.width * 0.3, def.height * 0.55, -def.length / 2 + 0.05);
      l.target.position.set(s * def.width * 0.34, def.height * 0.1, -def.length / 2 - 26);
      l.castShadow = false;
      inst.body.add(l, l.target);
      inst.lights.beams.push(l);
    }
  }

  // ------------------------------------------------------------------ update

  update(dt, ctx) {
    const env = ctx.env;
    const dark =
      (env?.timeOfDay !== undefined && (env.timeOfDay < 6.7 || env.timeOfDay > 18.4)) ||
      env?.preset === 'night' ||
      env?.preset === 'stormy' ||
      (env?.rainIntensity ?? 0) > 0.4;

    for (const c of this.instances) {
      c.applyPhysics(c.state);
      const s = c.state;
      if (!s) continue;

      // ---- brake heat: build under load, decay slowly, glow through the spokes ----
      const load = clamp01(s.brake) * clamp01(Math.abs(s.speedKmh) / 90);
      const target = clamp01((s.brakeHeat ?? load) * 1.15);
      c._brakeGlow = damp(c._brakeGlow, target, target > c._brakeGlow ? 2.6 : 0.55, dt);
      c.setBrakeGlow(c._brakeGlow);

      // ---- lamps ----
      const braking = s.brake > 0.06 || (s.handbrake ?? 0) > 0.2;
      c.setLights({
        head: dark,
        tail: dark,
        drl: true,
        brake: braking,
        reverse: s.gear === -1 || s.speed < -0.6,
      });
      if (c.lights.underglow) {
        c.lights.underglow.intensity = damp(
          c.lights.underglow.intensity,
          s.nosActive ? 6 : 1.6,
          6,
          dt
        );
      }

      // ---- visual-only weight transfer: the shell leans on the springs ----
      const g = s.gForce ?? { x: 0, z: 0 };
      const rollT = clamp(-g.x * 0.016, -0.055, 0.055) + clamp(-(s.driftAngle ?? 0) * 0.05, -0.04, 0.04);
      const pitchT = clamp(g.z * 0.012, -0.05, 0.05) + (s.brake > 0.1 ? -0.014 * clamp01(s.speedKmh / 120) : 0);
      c._lean.roll = damp(c._lean.roll, rollT, 7, dt);
      c._lean.pitch = damp(c._lean.pitch, pitchT, 7, dt);
      c.body.rotation.z = c._lean.roll;
      c.body.rotation.x = c._lean.pitch;

      // ---- damage from the physics damage model ----
      if (s.damage) {
        c.setDamage('frontL', s.damage.front * 0.9);
        c.setDamage('frontR', s.damage.front * 0.75);
        c.setDamage('rearL', s.damage.rear * 0.8);
        c.setDamage('rearR', s.damage.rear * 0.9);
        c.setDamage('left', s.damage.left);
        c.setDamage('right', s.damage.right);
      }
    }
    void ctx;
  }

  /** Diagnostics for the QA harness. */
  stats() {
    return this.instances.map((c) => ({ id: c.id, tris: triCount(c.root) }));
  }

  dispose() {
    for (const bp of this._blueprints.values()) {
      bp.bodyGeo.dispose();
      for (const m of Object.values(bp.mats)) m.dispose?.();
    }
    this._blueprints.clear();
  }
}
