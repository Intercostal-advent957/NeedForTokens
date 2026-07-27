import * as THREE from 'three';

/**
 * Full-screen camera effects that belong to the VFX lane rather than to the grade:
 * speed lines, NOS tunnel-vision surge, and rain on the lens / windscreen.
 *
 * PostFxSystem owns the composer, so instead of adding a pass this is a clip-space quad living
 * in the scene at a very high renderOrder with depth test off. It therefore lands *inside* the
 * RenderPass, which is what we want — the streaks pick up bloom and the grade for free.
 */
export class Overlay {
  constructor(ctx, grab, parent) {
    this.ctx = ctx;
    this.grab = grab;
    this.parent = parent;
    this.speed = 0;
    this.nos = 0;
    this.droplets = 0;
    this._speedTarget = 0;
    this._nosTarget = 0;
    this._dropTarget = 0;
  }

  init() {
    const geo = new THREE.PlaneGeometry(2, 2);
    this.material = makeOverlayMaterial();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9000;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.mesh.onBeforeRender = () => {
      if (this.droplets > 0.01) {
        const tex = this.grab.grab();
        this.material.uniforms.tGrab.value = tex;
        this.material.uniforms.uHasGrab.value = tex ? 1 : 0;
      } else {
        this.material.uniforms.uHasGrab.value = 0;
      }
    };
    this.parent.add(this.mesh);
    this.onResize(window.innerWidth, window.innerHeight);
    return this;
  }

  setSpeedLines(t) {
    this._speedTarget = Math.max(0, Math.min(1, t || 0));
  }

  setNos(t) {
    this._nosTarget = Math.max(0, Math.min(1, t || 0));
  }

  setDroplets(t) {
    this._dropTarget = Math.max(0, Math.min(1, t || 0));
  }

  update(dt) {
    const k = 1 - Math.exp(-8 * dt);
    const kd = 1 - Math.exp(-2.2 * dt);
    this.speed += (this._speedTarget - this.speed) * k;
    this.nos += (this._nosTarget - this.nos) * k;
    this.droplets += (this._dropTarget - this.droplets) * kd;

    const u = this.material.uniforms;
    u.uTime.value = this.ctx.time.elapsed;
    u.uSpeed.value = this.speed;
    u.uNos.value = this.nos;
    u.uDroplets.value = this.droplets;
    this.mesh.visible = this.speed > 0.004 || this.nos > 0.004 || this.droplets > 0.008;
  }

  onResize(w, h) {
    this.material.uniforms.uAspect.value = Math.max(w, 1) / Math.max(h, 1);
  }

  dispose() {
    this.parent.remove(this.mesh);
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}

function makeOverlayMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, // premultiplied
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uTime: { value: 0 },
      uSpeed: { value: 0 },
      uNos: { value: 0 },
      uDroplets: { value: 0 },
      uAspect: { value: 1.777 },
      tGrab: { value: null },
      uHasGrab: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);   // straight to clip space
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform float uTime, uSpeed, uNos, uDroplets, uAspect, uHasGrab;
      uniform sampler2D tGrab;

      float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
      vec2 hash22(vec2 p){
        vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.xx + p3.yz) * p3.zy);
      }

      // ---- radial speed streaks -------------------------------------------------------------
      vec3 speedLines(vec2 c, float r, float amount, vec3 tint){
        if (amount < 0.002) return vec3(0.0);
        float ang = atan(c.y, c.x);
        const float BINS = 220.0;
        float f = (ang / 6.28318530718 + 0.5) * BINS;
        float bi = floor(f);
        float sub = fract(f);
        float rnd = hash11(bi * 1.7 + 3.1);
        // Only a sparse minority of angular bins ever carry a streak — a dense ring reads as
        // hyperspace, not as speed.
        float use = step(0.80, rnd);
        float sp = 0.7 + rnd * 1.4;
        float t = fract(rnd * 7.13 + uTime * sp * (0.5 + amount * 1.6));
        float lineR = mix(0.42, 1.30, t);
        float w = 0.016 + 0.075 * t;
        float d = abs(r - lineR);
        float line = smoothstep(w, 0.0, d);
        line *= pow(clamp(1.0 - abs(sub - 0.5) * 2.0, 0.0, 1.0), 3.5);
        line *= smoothstep(0.42, 0.95, r);          // stay out at the frame edge
        line *= use * (0.30 + 0.70 * rnd);
        return tint * line * amount * 0.55;
      }

      // ---- rain on the lens ------------------------------------------------------------------
      // Droplets sit on the glass, refract what is behind them, and creep downward, leaving a
      // thinning trail. Two scales so it never reads as a regular grid.
      vec4 dropletLayer(vec2 uv, float scale, float seed, float amount){
        vec2 g = uv * vec2(scale * uAspect, scale);
        vec2 id = floor(g);
        vec2 f = fract(g);
        vec2 h = hash22(id + seed);
        float alive = step(0.70, hash11(dot(id, vec2(12.9898, 78.233)) + seed));
        if (alive < 0.5) return vec4(0.0);

        float speed = 0.10 + h.x * 0.34;
        float slide = fract(h.y + uTime * speed * (0.25 + amount));
        vec2 c = vec2(h.x * 0.72 + 0.14, 1.0 - slide);
        vec2 dvec = f - c;
        float rad = 0.055 + h.y * 0.085;
        float dist = length(dvec * vec2(1.0, 1.0));
        float body = smoothstep(rad, rad * 0.35, dist);

        // trail above the drop
        float trailW = rad * 0.36;
        float tw = smoothstep(trailW, 0.0, abs(dvec.x));
        float th = smoothstep(0.0, 0.45, dvec.y) * smoothstep(0.8, 0.15, dvec.y);
        float trail = tw * th * 0.35;

        float m = clamp(body + trail, 0.0, 1.0);
        // surface normal of the bead -> refraction offset
        vec2 n = -dvec / max(rad, 1e-4) * body;
        return vec4(n, m, body);
      }

      void main(){
        vec2 uv = vUv;
        vec2 c = (uv - 0.5) * vec2(uAspect, 1.0);
        float r = length(c) * 1.25;

        vec3 col = vec3(0.0);
        float alpha = 0.0;

        // ---------------- lens droplets -------------------------------------------------------
        if (uDroplets > 0.008) {
          vec4 d1 = dropletLayer(uv, 11.0, 0.0, uDroplets);
          vec4 d2 = dropletLayer(uv, 21.0, 5.3, uDroplets);
          vec2 nrm = d1.xy * 0.7 + d2.xy * 0.45;
          float mask = clamp(d1.z * 0.80 + d2.z * 0.62, 0.0, 1.0) * uDroplets;
          float bead = clamp(d1.w + d2.w, 0.0, 1.0) * uDroplets;
          if (mask > 0.002) {
            // A bead is a tiny lens: it inverts and compresses what is behind it. Keep the
            // offset small — a large offset samples somewhere unrelated and reads as dirt.
            float glint = pow(clamp(dot(normalize(vec3(nrm, 0.8)), normalize(vec3(-0.5, 0.7, 0.6))), 0.0, 1.0), 10.0);
            if (uHasGrab > 0.5) {
              vec3 refr = texture2D(tGrab, clamp(uv + nrm * 0.014, vec2(0.002), vec2(0.998))).rgb;
              refr = mix(refr, refr * 1.12, bead);
              refr += vec3(0.9, 0.95, 1.0) * glint * bead * 0.30;
              col += refr * mask;
              alpha += mask;
            } else {
              // No grab: never paint opaque blobs — just the rim highlight of each bead.
              float rimA = mask * 0.16 + glint * bead * 0.35;
              col += vec3(0.72, 0.80, 0.92) * rimA;
              alpha += rimA * 0.55;
            }
          }
        }

        // ---------------- speed lines + NOS ---------------------------------------------------
        float amount = clamp(uSpeed + uNos * 0.55, 0.0, 1.15);
        vec3 tint = mix(vec3(1.0, 0.94, 0.86), vec3(0.62, 0.82, 1.0), clamp(uNos * 1.2, 0.0, 1.0));
        vec3 lines = speedLines(c, r, amount, tint);
        col += lines * 0.8;
        alpha += clamp(dot(lines, vec3(0.30)), 0.0, 1.0);

        // Tunnel vision: only the extreme corners lift, and only under boost.
        float tunnel = smoothstep(0.86, 1.45, r) * amount;
        vec3 edge = mix(vec3(1.0, 0.86, 0.6), vec3(0.42, 0.68, 1.0), clamp(uNos * 1.3, 0.0, 1.0));
        col += edge * tunnel * (0.020 + 0.075 * uNos);
        alpha += tunnel * (0.010 + 0.045 * uNos);

        alpha = clamp(alpha, 0.0, 1.0);
        if (alpha < 0.003) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}
