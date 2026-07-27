/**
 * Material review harness for the MATERIALS lane.
 *
 * The game's greybox road does not (yet) use `assets.material('road')`, and a material can only
 * honestly be judged on a surface that shows it — so this page renders the library the way a
 * studio reviews materials: a lit ground plane at driver eye height and at distance, plus a row
 * of material balls under a raking key light.
 *
 * Served by vite at /src/shaders/preview.html?view=…  It is a dev tool: nothing in the game
 * imports it, and it ships as dead weight of exactly one HTML file.
 *
 *   ?view=road      driver-height look down the road (judges near + far in one frame)
 *   ?view=closeup   1.2 m from the surface, raking sun (judges grain + normal response)
 *   ?view=far       200-400 m of road (judges tiling and macro variation)
 *   ?view=balls     every material on a sphere
 *   ?view=sheets    every texture as a flat lit tile, unlit-ish, for channel inspection
 *   &wet=0..1  &sun=degrees  &tier=low|medium|high|ultra
 */

import * as THREE from 'three';
import { ProceduralAssets } from '../core/Assets.js';
import { Settings } from '../core/Settings.js';

const q = new URLSearchParams(location.search);
const VIEW = q.get('view') || 'road';
const WET = parseFloat(q.get('wet') ?? '0');
const RAIN = parseFloat(q.get('rain') ?? '0');
const SUN_EL = parseFloat(q.get('sun') ?? '9'); // degrees above horizon
const TIER = q.get('tier') || 'high';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 4000);

const settings = new Settings(null, TIER);
const assets = new ProceduralAssets(renderer, settings);

// --------------------------------------------------------------------- sky + IBL
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    uSun: { value: new THREE.Vector3(0, 0.2, -1) },
    uTop: { value: new THREE.Color(0x2f6ea8) },
    uMid: { value: new THREE.Color(0xf3b477) },
    uBot: { value: new THREE.Color(0x3a2a20) },
  },
  vertexShader: `varying vec3 vW; void main(){ vW=(modelMatrix*vec4(position,1.)).xyz; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `varying vec3 vW; uniform vec3 uSun,uTop,uMid,uBot;
    void main(){
      vec3 d=normalize(vW); float h=d.y;
      vec3 c=mix(uBot,uMid,smoothstep(-0.22,0.05,h));
      c=mix(c,uTop,smoothstep(0.02,0.6,h));
      float s=max(dot(d,normalize(uSun)),0.0);
      c+=vec3(1.0,0.72,0.42)*pow(s,180.0)*16.0;
      c+=vec3(1.0,0.66,0.38)*pow(s,5.0)*0.5;
      gl_FragColor=vec4(c,1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(2000, 32, 20), skyMat);
sky.frustumCulled = false;
scene.add(sky);

const sunDir = new THREE.Vector3(
  Math.cos(SUN_EL * Math.PI / 180) * 0.55,
  Math.sin(SUN_EL * Math.PI / 180),
  -Math.cos(SUN_EL * Math.PI / 180) * 0.83
).normalize();
skyMat.uniforms.uSun.value.copy(sunDir);

const sun = new THREE.DirectionalLight(0xffc48a, 4.2);
sun.position.copy(sunDir).multiplyScalar(120);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 300;
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0x9dc4ff, 0x3a3128, 0.7));

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const tmpScene = new THREE.Scene();
tmpScene.add(new THREE.Mesh(sky.geometry, skyMat));
const envRT = pmrem.fromScene(tmpScene, 0.02, 1, 1800);
scene.environment = envRT.texture;
scene.background = envRT.texture;
assets.envMap = envRT.texture;

await assets.init();
assets.setWetness(WET, RAIN);

const label = document.getElementById('label');
const info = [];

// --------------------------------------------------------------------- content
function buildRoad() {
  // 24 m wide, 900 m long, UVs matching the world lane's convention (u spans 0..3.2).
  const L = 900;
  const W = 24.8;
  const geo = new THREE.PlaneGeometry(W, L, 8, 240);
  geo.rotateX(-Math.PI / 2);
  // `tile` = metres of road per texture repeat. The world lane's road samples asphalt at
  // ~3.6 m/tile; the greybox cross-section works out at ~7.8 m. Check both.
  const tile = parseFloat(q.get('tile') ?? '7.75');
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (W / tile), uv.getY(i) * (L / tile));
  }
  uv.needsUpdate = true;
  // Per-term overrides so each contribution can be isolated when something looks wrong:
  //   &macro=0 &blend=0 &polish=0 &detail=0
  const ov = {};
  for (const [k, p] of [['macro', 'macroAmt'], ['blend', 'blendAmt'], ['polish', 'wheelPolish'], ['detail', 'detailAmt']]) {
    if (q.has(k)) ov[p] = parseFloat(q.get(k));
  }
  // The lane-map converts uv.x back into a -1..1 lateral coordinate, so it follows the tiling.
  ov.laneMap = new THREE.Vector2(2 / (W / tile), -1.0);
  const mat = assets.material('road', ov);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = q.get('shadow') !== '0';
  scene.add(mesh);

  // A kerb + pavement strip each side so the road has an edge to read against.
  const curbMat = assets.material('curb');
  const concMat = assets.material('concrete');
  for (const s of [-1, 1]) {
    const kerb = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, L), curbMat);
    kerb.position.set(s * (W / 2 + 0.2), 0.08, 0);
    kerb.receiveShadow = true;
    kerb.castShadow = true;
    scene.add(kerb);
    const pave = new THREE.Mesh(new THREE.BoxGeometry(4, 0.16, L), concMat);
    pave.position.set(s * (W / 2 + 2.4), 0.08, 0);
    pave.receiveShadow = true;
    scene.add(pave);
  }

  // Something to cast a shadow and give scale.
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.2, 4.4), assets.material('carPaint', { color: 0xc9302c }));
  box.position.set(-3, 0.62, -14);
  box.castShadow = true;
  scene.add(box);
  return mesh;
}

const BALL_MATS = [
  ['road', {}], ['concrete', {}], ['curb', {}], ['brick', {}], ['facade', {}],
  ['metal', {}], ['grass', {}], ['dirt', {}], ['carbon', {}], ['alu', {}],
  ['tire', {}], ['carPaint', { color: 0x1a4fd0 }], ['glass', {}],
  ['signage', { color: 0xff2e63, intensity: 3 }], ['foliage', {}],
];

function buildBalls() {
  const geo = new THREE.SphereGeometry(0.55, 64, 48);
  const cols = 5;
  BALL_MATS.forEach(([name, o], i) => {
    const m = assets.material(name, o);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set((i % cols) * 1.35 - (cols - 1) * 0.675, 0.6, Math.floor(i / cols) * 1.35 - 1.35);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    info.push(name);
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), assets.material('concrete'));
  floor.rotateX(-Math.PI / 2);
  floor.receiveShadow = true;
  scene.add(floor);
}

const SHEET_TEX = [
  'asphalt', 'asphaltNormal', 'asphaltRough', 'concrete', 'concreteNormal',
  'curb', 'brickWall', 'buildingFacade', 'buildingWindows', 'metalScratch',
  'grassAlbedo', 'dirtAlbedo', 'carbonFibre', 'brushedAlu', 'tireTread',
  'tireNormal', 'carPaintFlake', 'glassDirt', 'manhole', 'roadLineMask',
  'puddleMask', 'caustics', 'graffiti', 'paintChip', 'rubberScuff',
  'smokeSprite', 'sparkSprite', 'flareSprite', 'raindrop', 'skidSprite',
  'lightCookie', 'lightCookieHead',
];

function buildSheets() {
  const cols = 8;
  const geo = new THREE.PlaneGeometry(1, 1);
  SHEET_TEX.forEach((n, i) => {
    const t = assets.texture(n);
    const m = new THREE.MeshBasicMaterial({ map: t, transparent: true, toneMapped: t.colorSpace === THREE.SRGBColorSpace });
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set((i % cols) * 1.08 - (cols - 1) * 0.54, -Math.floor(i / cols) * 1.08 + 1.6, 0);
    scene.add(mesh);
    info.push(n);
  });
  scene.background = new THREE.Color(0x202226);
  scene.environment = null;
}

let road = null;
if (VIEW === 'balls') {
  buildBalls();
  camera.position.set(0, 2.1, 5.4);
  camera.lookAt(0, 0.6, -0.8);
} else if (VIEW === 'sheets') {
  buildSheets();
  camera.position.set(0, 0, 8.2);
  camera.lookAt(0, 0, 0);
  camera.fov = 60;
} else {
  road = buildRoad();
  if (VIEW === 'closeup') {
    camera.position.set(-2.4, 1.05, 3.0);
    camera.lookAt(-2.0, 0, -3.5);
    camera.fov = 40;
  } else if (VIEW === 'far') {
    camera.position.set(0, 3.4, 120);
    camera.lookAt(0, 0.4, -320);
    camera.fov = 34;
  } else {
    camera.position.set(-1.6, 1.35, 6.0);
    camera.lookAt(-0.6, 0.1, -60);
    camera.fov = 55;
  }
}
camera.updateProjectionMatrix();
sun.target.position.set(0, 0, -20);
sun.position.copy(sunDir).multiplyScalar(140).add(new THREE.Vector3(0, 0, -20));

label.textContent =
  `view=${VIEW} wet=${WET} rain=${RAIN} sun=${SUN_EL}deg tier=${TIER}\n` +
  (info.length ? info.join('  ') : '') +
  `\n${assets.stats.textures} tex  ~${(assets.stats.bytes / 1048576).toFixed(0)}MB`;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
});

let frames = 0;
function tick() {
  requestAnimationFrame(tick);
  renderer.render(scene, camera);
  if (++frames === 4) window.__PREVIEW_READY = true;
}
tick();

window.__PREVIEW = { assets, scene, camera, renderer, road, settings };
