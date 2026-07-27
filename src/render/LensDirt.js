import * as THREE from 'three';

/**
 * Procedural lens-dirt mask. CONTRACTS §0: no image files, everything is generated.
 *
 * The texture modulates bloom, not the frame — dirt is only visible when something bright is
 * behind it, which is why a static overlay always looks like a decal and this does not.
 *
 * Composition is deliberately sparse: a few large greasy smears, a scatter of specks, and two
 * faint horizontal wipe streaks. Heavy dirt reads as a dirty monitor, not a camera.
 */
export function makeLensDirtTexture(size = 512, seed = 0x51ce) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = Math.round(size * 0.5625);
  const g = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const rr = (a, b) => a + (b - a) * rnd();

  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'lighter';

  // --- greasy smears -------------------------------------------------------------------------
  for (let i = 0; i < 26; i++) {
    const x = rr(0, w);
    const y = rr(0, h);
    const r = rr(w * 0.03, w * 0.16);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const a = rr(0.05, 0.2);
    grd.addColorStop(0, `rgba(255,250,240,${a})`);
    grd.addColorStop(0.45, `rgba(210,225,255,${a * 0.4})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.save();
    g.translate(x, y);
    g.rotate(rr(0, Math.PI));
    g.scale(1, rr(0.25, 0.8));
    g.translate(-x, -y);
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // --- specks ---------------------------------------------------------------------------------
  for (let i = 0; i < 900; i++) {
    const x = rr(0, w);
    const y = rr(0, h);
    const r = rr(0.4, 2.6);
    const a = rr(0.06, 0.5);
    const grd = g.createRadialGradient(x, y, 0, x, y, r * 3);
    grd.addColorStop(0, `rgba(255,255,255,${a})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r * 3, 0, Math.PI * 2);
    g.fill();
  }

  // --- wipe streaks ---------------------------------------------------------------------------
  for (let i = 0; i < 5; i++) {
    const y = rr(0, h);
    const grd = g.createLinearGradient(0, y, w, y + rr(-h * 0.1, h * 0.1));
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(rr(0.25, 0.45), `rgba(230,240,255,${rr(0.04, 0.11)})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.save();
    g.translate(0, y);
    g.rotate(rr(-0.06, 0.06));
    g.fillRect(-w, -rr(1.5, 6), w * 3, rr(3, 12));
    g.restore();
  }

  // --- vignette the dirt: the edges of a lens collect more of it ------------------------------
  g.globalCompositeOperation = 'multiply';
  const vg = g.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, w * 0.62);
  vg.addColorStop(0, 'rgba(150,150,150,1)');
  vg.addColorStop(0.6, 'rgba(210,210,210,1)');
  vg.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'lens-dirt';
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
