import * as THREE from 'three';
import { makeHdrTarget } from './Fullscreen.js';

/**
 * Per-object screen-space velocity for the things that do NOT move with the world: the cars and,
 * critically, their wheels.
 *
 * The static world does not need this — MotionBlurPass reprojects it from the depth buffer for
 * free. What depth reprojection *cannot* do is a rigid body that moves independently of the
 * camera: reprojection assumes every pixel is nailed to the world, so a chase-cam car (which is
 * almost stationary on screen) comes out smeared exactly as hard as the road it is driving on.
 * That single artefact is what makes naive camera-blur look like a screensaver.
 *
 * Implementation notes:
 *  - Each rigid group (car body, each wheel spin group) is drawn with `renderer.render(group,
 *    camera)` with every mesh's material temporarily swapped for the velocity material.
 *  - Wheels are registered on their SPIN group, so the spin appears in the previous transform and
 *    the shader produces genuine ROTATIONAL blur: the top of the tyre streaks, the contact patch
 *    does not.
 *  - The buffer stores (vx, vy, linearDepth, 1). Storing depth lets the blur pass reject a
 *    dynamic sample that is actually hidden behind world geometry, so we do not need to share the
 *    scene depth attachment (which three does not love) to get correct occlusion.
 *
 * ============================= two bugs that made this a no-op =============================
 * 1. `group.overrideMaterial`. `WebGLRenderer.renderObjects()` reads
 *      `const overrideMaterial = scene.isScene === true ? scene.overrideMaterial : null;`
 *    and the thing we hand to `renderer.render()` here is a Group, not a Scene — so the override
 *    was silently ignored and the cars were rasterised into the velocity buffer with their real
 *    PBR materials. `dyn.z` then held a blue channel (0..1) instead of a view depth (metres), the
 *    blur pass's depth check rejected every dynamic sample, and every car fell back to the static
 *    camera-reprojection velocity — i.e. the hero car got smeared exactly as hard as the road it
 *    was driving on, which is the one artefact this whole pass exists to prevent. Materials are
 *    now swapped per mesh, which does not care what kind of object the render root is.
 * 2. `wPrev = uPrevModel * position` used the group's previous matrix against a MESH-LOCAL vertex
 *    position, so every mesh that is not at the group's origin (every wheel, every splitter, every
 *    lamp) reported its own local offset as one frame of motion — hundreds of pixels. The rigid
 *    transform between frames is `prevWorld * inverse(world)`, applied to the WORLD position; that
 *    is exact for every mesh in the group whatever its local transform, and it is one uniform.
 */
export class VelocityPass {
  constructor(ctx) {
    this.ctx = ctx;
    this.failed = false;
    this.scale = 1.0;
    this.rt = null;
    this.groups = [];
    this._prev = new WeakMap();
    this._swapped = [];
    this._inv = new THREE.Matrix4();
    this._delta = new THREE.Matrix4();
    this._mat = new THREE.ShaderMaterial({
      name: 'velocity',
      uniforms: {
        // prevWorld * inverse(world) for the rigid group being drawn — see the header.
        uPrevDelta: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uNearFar: { value: new THREE.Vector2(0.15, 6000) },
      },
      vertexShader: /* glsl */ `
        uniform mat4 uPrevDelta;
        uniform mat4 uPrevViewProj;
        varying vec4 vNow;
        varying vec4 vPrev;
        varying float vViewZ;
        void main() {
          vec4 wNow = modelMatrix * vec4(position, 1.0);
          vec4 wPrev = uPrevDelta * wNow;
          vec4 view = viewMatrix * wNow;
          vViewZ = -view.z;
          vNow = projectionMatrix * view;
          vPrev = uPrevViewProj * wPrev;
          gl_Position = vNow;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec4 vNow;
        varying vec4 vPrev;
        varying float vViewZ;
        void main() {
          vec2 a = vNow.xy / max(vNow.w, 1e-5);
          vec2 b = vPrev.xy / max(vPrev.w, 1e-5);
          // NDC delta -> uv delta
          vec2 vel = (a - b) * 0.5;
          gl_FragColor = vec4(vel, vViewZ, 1.0);
        }
      `,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
      blending: THREE.NoBlending,
      fog: false,
    });
  }

  /**
   * Drop every stored previous-model matrix. Called on a teleport / camera cut: without this the
   * first frame after a discontinuity reports the entire jump as one frame of motion and smears
   * the whole car across the screen.
   */
  resetHistory() {
    this._prev = new WeakMap();
  }

  setSize(w, h) {
    const bw = Math.max(4, Math.round(w * this.scale));
    const bh = Math.max(4, Math.round(h * this.scale));
    if (this.rt && this.rt.width === bw && this.rt.height === bh) return;
    this.rt?.dispose();
    this.rt = makeHdrTarget(bw, bh, { depth: false, filter: THREE.NearestFilter });
    this.rt.depthBuffer = true;
    this.rt.texture.name = 'velocity';
  }

  /**
   * Rebuilds the rigid-group list: `[{ node, sub[] }]` where `sub` are descendant groups drawn
   * separately and therefore hidden while the parent draws. Cheap — only walks car roots.
   *
   * The wheel unit is the SPIN group (`wheel.mesh`), not the steering pivot: the spin is where the
   * rotation lives, and it is the rotation that produces the streaked tyre / static contact patch
   * that reads as speed. The pivot still draws (it owns the caliper, which does not spin).
   */
  _collect() {
    const cars = this.ctx.cars?.instances;
    const groups = this.groups;
    groups.length = 0;
    if (!cars || !cars.length) return groups;
    const player = this.ctx.cars?.player ?? this.ctx.player;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car?.root || car.root.visible === false) continue;
      // Player wheels get their own groups (rotational blur is a hero detail on the hero car);
      // opponents ride on the body transform so a full grid stays cheap.
      const sub = [];
      if (car === player && car.wheels) {
        for (const w of car.wheels) {
          const node = w?.mesh || w?.pivot;
          if (node && node.visible !== false) {
            sub.push(node);
            groups.push({ node, sub: null });
          }
        }
      }
      groups.push({ node: car.root, sub });
    }
    return groups;
  }

  /**
   * Put every drawable mesh under `node` onto the velocity material.
   *
   * Transparent / non-depth-writing meshes are HIDDEN rather than swapped. Two reasons, and the
   * distinction matters: swapping them in would let the glass write an opaque velocity + depth
   * over the body behind it (this material is NoBlending, depthWrite:true), while merely SKIPPING
   * them leaves them drawn with their real PBR material — which writes paint colour into the
   * velocity buffer, and a red channel of 0.14 read as 0.14 uv of motion is a 200-pixel smear.
   * Nothing that does not own the depth buffer at a pixel belongs in this pass.
   */
  _swapIn(node) {
    const list = this._swapped;
    node.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
      if (o.visible === false) return;
      const m = o.material;
      const solid =
        m && !Array.isArray(m) && m.transparent !== true && m.depthWrite !== false && !o.isSprite;
      list.push(o, solid ? m : null);
      if (solid) o.material = this._mat;
      else o.visible = false;
    });
  }

  _swapOut() {
    const list = this._swapped;
    for (let i = 0; i < list.length; i += 2) {
      const saved = list[i + 1];
      if (saved === null) list[i].visible = true;
      else list[i].material = saved;
    }
    list.length = 0;
  }

  /** @returns {THREE.Texture|null} */
  render(prevViewProj) {
    if (this.failed || !this.rt) return null;
    const { renderer, camera } = this.ctx;
    const groups = this._collect();
    if (!groups.length) return null;

    const prevAuto = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    const hidden = [];

    try {
      this._mat.uniforms.uPrevViewProj.value.copy(prevViewProj);
      this._mat.uniforms.uNearFar.value.set(camera.near, camera.far);

      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(this.rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.autoClear = false;

      for (let i = 0; i < groups.length; i++) {
        const { node, sub } = groups[i];
        // prevWorld * inverse(world): the rigid motion of this group between the two frames.
        this._inv.copy(node.matrixWorld).invert();
        this._delta.multiplyMatrices(this._prevFor(node), this._inv);
        this._mat.uniforms.uPrevDelta.value.copy(this._delta);
        // Each group is its own renderer.render() call, and three only re-uploads a
        // ShaderMaterial's uniforms when it thinks they changed. Say so explicitly.
        this._mat.uniformsNeedUpdate = true;
        if (sub) {
          for (const s of sub) {
            s.visible = false;
            hidden.push(s);
          }
        }
        this._swapIn(node);
        renderer.render(node, camera);
        this._swapOut();
        for (const s of hidden) s.visible = true;
        hidden.length = 0;
      }
    } catch (e) {
      console.warn('[postfx] velocity pass disabled:', e?.stack || e?.message || e);
      this.failed = true;
      this._swapOut();
      for (const s of hidden) s.visible = true;
      return null;
    } finally {
      this._swapOut();
      for (const s of hidden) s.visible = true;
      renderer.autoClear = prevAuto;
      renderer.shadowMap.autoUpdate = prevShadow;
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(0x000000, 1);
    }

    // Store this frame's matrices for the next one.
    for (let i = 0; i < groups.length; i++) {
      const node = groups[i].node;
      let m = this._prev.get(node);
      if (!m) {
        m = new THREE.Matrix4();
        this._prev.set(node, m);
      }
      m.copy(node.matrixWorld);
    }
    return this.rt.texture;
  }

  _prevFor(g) {
    let m = this._prev.get(g);
    if (!m) {
      m = new THREE.Matrix4().copy(g.matrixWorld);
      this._prev.set(g, m);
    }
    return m;
  }

  dispose() {
    this.rt?.dispose();
    this._mat.dispose();
  }
}
