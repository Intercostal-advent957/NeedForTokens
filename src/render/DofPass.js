import * as THREE from 'three';
import { FsPass, makeHdrTarget } from './Fullscreen.js';
import { DEPTH_GLSL, HASH_GLSL } from './ShaderLib.js';

/**
 * Depth of field. Half-res gather bokeh; GradePass does the final mix so DOF costs one buffer and
 * two extra taps in a pass that already exists rather than its own full-res read-modify-write.
 *
 * Focus is driven from the subject, not from screen centre: in chase cam the plane sits on the
 * player's car, which is the only framing that survives a camera that swings through corners. The
 * aperture is deliberately small in gameplay (a couple of pixels of circle of confusion on the far
 * skyline) and opens up in photo/showcase mode. A racing game with phone-portrait bokeh reads as
 * a toy — the effect should be felt, not seen.
 *
 * The gather weights each tap by its OWN circle of confusion, so a blurred background cannot
 * bleed across a sharp foreground silhouette (the classic "halo around the car" artefact).
 */
export class DofPass {
  constructor(renderer) {
    this.renderer = renderer;
    this.scale = 0.5;
    this.failed = false;
    this.rt = null;
    this.pass = new FsPass(SHADER, { DOF_SAMPLES: '22' });
    /** metres */
    this.focus = 8;
    /** pixels of CoC at infinity, at 1080p */
    this.maxRadius = 5.0;
    this.nearStrength = 0.55;
    this.farStrength = 1.0;
  }

  setSize(w, h) {
    const bw = Math.max(4, Math.round(w * this.scale));
    const bh = Math.max(4, Math.round(h * this.scale));
    if (this.rt && this.rt.width === bw && this.rt.height === bh) return;
    this.rt?.dispose();
    this.rt = makeHdrTarget(bw, bh);
    this.rt.texture.name = 'dof';
  }

  /** @returns {THREE.Texture|null} */
  render(colorTexture, depthTexture, camera, heightPx) {
    if (this.failed || !this.rt) return null;
    try {
      const u = this.pass.u;
      u.tColor.value = colorTexture;
      u.tDepth.value = depthTexture;
      u.uTexel.value.set(1 / this.rt.width, 1 / this.rt.height);
      u.uNearFar.value.set(camera.near, camera.far);
      // Radius is authored at 1080p and scales with the actual buffer so the look is resolution
      // independent.
      const r = this.maxRadius * (heightPx / 1080) * this.scale;
      u.uFocus.value.set(this.focus, this.nearStrength, this.farStrength, Math.max(r, 0.6));
      this.pass.render(this.renderer, this.rt);
      return this.rt.texture;
    } catch (e) {
      console.warn('[postfx] DOF disabled:', e?.message || e);
      this.failed = true;
      return null;
    }
  }

  dispose() {
    this.rt?.dispose();
    this.pass.dispose();
  }
}

const SHADER = {
  name: 'dof-bokeh',
  uniforms: {
    tColor: { value: null },
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uNearFar: { value: new THREE.Vector2(0.15, 6000) },
    uFocus: { value: new THREE.Vector4(8, 0.55, 1, 3) }, // focus m, near k, far k, radius px
  },
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    uniform vec2 uTexel, uNearFar;
    uniform vec4 uFocus;

    ${DEPTH_GLSL}
    ${HASH_GLSL}

    float cocAt(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      float z = linearDepth(d, uNearFar.x, uNearFar.y);
      float f = uFocus.x;
      float c = (z - f) / max(z, 0.05);          // -1 .. 1, sign = near/far
      c *= (c < 0.0) ? uFocus.y : uFocus.z;
      return clamp(c, -1.0, 1.0);
    }

    void main() {
      float coc = cocAt(vUv);
      float amount = abs(coc);
      float radius = uFocus.w * amount;

      vec3 sum = texture2D(tColor, vUv).rgb;
      float wsum = 1.0;

      // Golden-angle spiral: near-uniform disc coverage with no visible sampling pattern.
      float ang = bayer4(gl_FragCoord.xy) * 6.2831853;
      for (int i = 1; i <= DOF_SAMPLES; i++) {
        float fi = float(i);
        float r = sqrt(fi / float(DOF_SAMPLES)) * radius;
        float a = fi * 2.39996323 + ang;
        vec2 off = vec2(cos(a), sin(a)) * r * uTexel;
        vec2 suv = vUv + off;
        float sc = abs(cocAt(suv));
        // Accept the tap only if its own blur circle reaches us.
        float w = clamp(sc * uFocus.w - r + 0.6, 0.0, 1.0);
        sum += texture2D(tColor, suv).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4(sum / max(wsum, 1e-4), smoothstep(0.02, 0.35, amount));
    }
  `,
};
