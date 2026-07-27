# NEED FOR TOKENS — Integration Contracts

**This file is law.** Every subsystem is built by a different author in parallel. If you change a
signature here, you break someone else's code. Extend, never rename. Never edit files you do not own.

---

## 0. Ground rules

- **Three.js r171**, ESM, imported as `import * as THREE from 'three'` and
  `import { X } from 'three/addons/...'`. Vite resolves both.
- **No external assets.** No network fetches, no `.glb`, no `.hdr`, no image files.
  *Everything* — geometry, textures, environment maps, audio — is generated procedurally at runtime.
  This is a hard constraint: the game must run from a cold `file://`-like context with zero downloads.
- **Units:** metres, seconds, kilograms. +Y is up. The car's local forward is **-Z**
  (matches Three.js camera/object convention). Right is +X.
- **Colour:** renderer uses `THREE.ACESFilmicToneMapping`, `outputColorSpace = SRGBColorSpace`.
  All *colour* textures must be `SRGBColorSpace`; all data textures (normal, roughness, metalness,
  AO, height) must be `NoColorSpace`. Get this wrong and the whole frame looks washed out.
- **Every system** is a class implementing the `System` shape below and is registered in `src/main.js`.
- **Performance target:** 60 fps at 1920×1080 on an M-series Mac at `high` quality.
  Budget: < 900 draw calls, < 2.5M triangles visible.

```js
class MySystem {
  constructor(ctx) {}          // cheap; no async work
  async init() {}              // build meshes/materials; may await
  update(dt, ctx) {}           // fixed order, see main.js
  lateUpdate(dt, ctx) {}       // optional; after physics+camera
  onQuality(tier) {}           // optional; 'low'|'medium'|'high'|'ultra'
  onResize(w, h) {}            // optional
  dispose() {}                 // optional
}
```

---

## 1. The context object (`ctx`)

Passed to every constructor and every `update`. Populated by `src/main.js`.

```js
ctx = {
  THREE,                 // the three namespace
  renderer,              // THREE.WebGLRenderer
  scene,                 // THREE.Scene
  camera,                // THREE.PerspectiveCamera — the ACTIVE render camera. Mutated by CameraSystem.
  canvas,                // HTMLCanvasElement
  bus,                   // EventBus (see §2)
  input,                 // Input (see §3)
  settings,              // Settings (see §4)
  assets,                // ProceduralAssets (see §5)
  time,                  // { dt, elapsed, frame, scale }  — `scale` is slow-mo multiplier
  rng,                   // seeded PRNG: rng() -> [0,1), rng.range(a,b), rng.int(a,b), rng.pick(arr)

  // system references — assigned by main.js after construction, so you may cache them in init()
  env,                   // EnvironmentSystem   §6
  world,                 // WorldSystem         §7
  cars,                  // CarSystem           §8
  physics,               // PhysicsSystem       §9
  cameras,               // CameraSystem        §10
  vfx,                   // VfxSystem           §11
  audio,                 // AudioSystem         §12
  hud,                   // UiSystem            §13
  race,                  // RaceSystem          §14
  post,                  // PostFxSystem        §15

  player,                // shortcut to the player CarInstance (see §8). null before race init.
  debug,                 // { enabled, log(k,v), panel }
}
```

---

## 2. EventBus — `src/core/EventBus.js` (OWNED BY CORE, do not edit)

```js
bus.on(name, fn) -> unsubscribe    bus.off(name, fn)    bus.emit(name, payload)
```

### Canonical events

| event | payload | emitted by |
|---|---|---|
| `game:ready` | — | main |
| `race:countdown` | `{ n }` 3,2,1,0 | race |
| `race:start` | — | race |
| `race:finish` | `{ standings }` | race |
| `lap:complete` | `{ car, lap, time, best }` | race |
| `checkpoint` | `{ car, index, time }` | race |
| `car:collision` | `{ car, impulse, point, normal, tag }` `tag`:`'barrier'\|'car'\|'prop'` | physics |
| `car:shift` | `{ car, gear, up }` | physics |
| `car:backfire` | `{ car, strength }` | physics |
| `car:nos` | `{ car, active }` | physics |
| `car:land` | `{ car, impact }` | physics |
| `car:airborne` | `{ car }` | physics |
| `wheel:surface` | `{ car, wheel, surface, slip }` | physics (only on change) |
| `camera:mode` | `{ mode }` | cameras |
| `quality:change` | `{ tier }` | settings |
| `photo:capture` | `{ name }` | tools |

---

## 3. Input — `src/core/Input.js` (OWNED BY CORE)

```js
input.state = {
  throttle,   // 0..1   (W / Up / RT / touch)
  brake,      // 0..1   (S / Down / LT)
  steer,      // -1..1  (A/D, Left/Right, left stick) — already smoothed & speed-sensitive
  steerRaw,   // -1..1  unsmoothed
  handbrake,  // 0..1   (Space / A button)
  nos,        // 0|1    (Shift / B button)
  lookBack,   // 0|1    (C)
  shiftUp, shiftDown, // edge-triggered booleans, cleared each frame
  camera,     // edge-triggered: cycles camera mode (V)
  reset,      // edge-triggered (R)
  pause,      // edge-triggered (Esc / P)
}
input.gamepadConnected // bool
```

`window.__NFT_INPUT_OVERRIDE` — if set to a partial state object, Input merges it over the real
state every frame. Used by the automated screenshot/QA harness to drive the car deterministically.

---

## 4. Settings — `src/core/Settings.js` (OWNED BY CORE)

```js
settings.tier            // 'low'|'medium'|'high'|'ultra'
settings.get(key)        // resolved value for the active tier
settings.set(key, v)
settings.setTier(t)      // emits quality:change
```

Keys every system may read: `shadowMapSize`, `shadowCascades`, `ssao`, `ssr`, `bloom`,
`motionBlur`, `dof`, `chromatic`, `grain`, `godrays`, `anisotropy`, `pixelRatio`, `msaa`,
`particleBudget`, `trafficCount`, `envMapSize`, `textureSize`, `reflectionProbe`, `taa`.

---

## 5. ProceduralAssets — `src/core/Assets.js` (OWNED BY MATERIALS AUTHOR)

Central cache. **Never generate a texture outside this file** — duplicated 2048² canvas work is the
#1 way to blow the frame budget.

```js
assets.texture(name, opts)      // -> THREE.Texture (cached by name+opts hash)
assets.material(name, opts)     // -> THREE.Material (cached)
assets.noise2D(x, y)            // simplex, deterministic
assets.canvas(w, h, drawFn)     // -> CanvasTexture helper
assets.envMap                   // THREE.Texture (PMREM cube) — set by EnvironmentSystem
```

Guaranteed texture names (other systems depend on these existing):
`asphalt`, `asphaltNormal`, `asphaltRough`, `roadLineMask`, `concrete`, `concreteNormal`,
`curb`, `metalScratch`, `carPaintFlake`, `tireTread`, `tireNormal`, `glassDirt`, `brickWall`,
`buildingFacade`, `buildingWindows`, `grassAlbedo`, `dirtAlbedo`, `smokeSprite`, `sparkSprite`,
`flareSprite`, `raindrop`, `skidSprite`, `lightCookie`, `caustics`, `puddleMask`, `graffiti`,
`manhole`, `paintChip`, `carbonFibre`, `brushedAlu`, `rubberScuff`.

---

## 6. EnvironmentSystem — `src/env/` — sky, IBL, lighting, weather, fog

```js
env.timeOfDay              // 0..24 hours
env.setTimeOfDay(h)
env.preset                 // 'goldenHour'|'night'|'dusk'|'overcast'|'noon'|'stormy'
env.setPreset(name)
env.sunDirection           // THREE.Vector3 (normalised, points FROM sun TO scene)
env.sunLight               // THREE.DirectionalLight (cascaded shadows)
env.hemi                   // THREE.HemisphereLight
env.envMap                 // PMREM THREE.Texture — also assigned to scene.environment & assets.envMap
env.fogDensity
env.wetness                // 0..1 — WorldSystem & VFX read this for puddles/spray
env.rainIntensity          // 0..1
```

Must set `scene.environment`, `scene.background`, `scene.fog`, and `renderer.toneMappingExposure`.

---

## 7. WorldSystem — `src/world/` — track, city, collision geometry

```js
world.track                  // Track (below)
world.sampleGround(x, z)     // -> { height, normal:Vector3, surface, grip }  grip 0..1.4
                             //    surface: 'asphalt'|'curb'|'grass'|'dirt'|'concrete'|'metal'|'water'
world.barriers               // Array<{ a:Vector3, b:Vector3, normal:Vector3, height, restitution, tag }>
                             //    2D wall segments in XZ. Physics does capsule-vs-segment.
world.props                  // Array<{ position, radius, mass, mesh, breakable }> destructibles
world.spawnPoints            // Array<{ position:Vector3, quaternion:Quaternion }> grid slots
world.getStartLine()         // -> { position, quaternion, width }
world.lights                 // Array<THREE.Light> street lighting (env may cull by tier)
```

### Track

```js
track.length                 // metres of centreline
track.pointAt(t)             // t in 0..1 -> Vector3 centreline
track.tangentAt(t)           // Vector3 normalised, direction of travel
track.upAt(t)                // Vector3 road up (accounts for banking)
track.widthAt(t)             // half-width in metres (drivable each side of centre)
track.bankAt(t)              // radians
track.curvatureAt(t)         // 1/radius signed; + = left turn
track.project(pos)           // -> { t, s, lateral, onTrack, height }  s = metres along
track.frameAt(t)             // -> { position, tangent, normal, binormal }
track.racingLine             // { pointAt(t), tangentAt(t), speedAt(t) } — ideal line + target speed
track.checkpoints            // Array<{ t, position, quaternion, width }>
track.laps                   // number of laps for the event
```

---

## 8. CarSystem — `src/vehicle/` — meshes, materials, per-car visual state

```js
cars.defs                    // Array<CarDef> (see below)
cars.spawn(defId, opts)      // -> CarInstance ; opts { isPlayer, paint, position, quaternion }
cars.instances               // Array<CarInstance>
cars.player                  // CarInstance | null
```

### CarDef

```js
{ id, name, brand, mass, wheelbase, track, cog:{x,y,z}, power, torqueCurve, gearRatios, finalDrive,
  redline, idleRpm, drivetrain:'rwd'|'awd'|'fwd', tyreGrip, downforce, dragCoeff, frontalArea,
  brakeTorque, steerLockDeg, suspension:{ travel, stiffness, damping, antiRoll },
  wheelRadius, wheelWidth, nos:{ capacity, boost, drain, refill },
  body:{...shape params...}, paint:{ base, flake, clearcoat }, class:'A'|'B'|'S' }
```

### CarInstance

```js
{
  def, id, isPlayer,
  root,          // THREE.Group added to scene — VISUAL ONLY, driven by physics each frame
  body,          // THREE.Group of the shell (for damage deformation)
  wheels: [ { pivot, mesh, brakeDisc, caliper, radius, isFront, isLeft } ] // order FL,FR,RL,RR
  lights: { head:[], tail:[], brake:[], reverse:[], indicator:[], underglow },
  exhausts: [ THREE.Object3D ],   // world-space emitters for flame/smoke VFX
  nosPorts: [ THREE.Object3D ],
  steeringWheel, driver,
  state,         // -> the physics state object, see §9. Assigned by PhysicsSystem.
  setPaint(colorHex, flakeHex),
  setBrakeGlow(t),       // 0..1
  setLights({ head, brake, reverse }),
  setDamage(region, t),  // region: 'frontL'|'frontR'|'rearL'|'rearR'|'left'|'right'|'roof'
  applyPhysics(state),   // called by main loop; writes transforms from state
}
```

---

## 9. PhysicsSystem — `src/physics/`

```js
physics.attach(carInstance, params)   // -> VehicleState ; also sets carInstance.state
physics.step(dt)                      // integrates all attached vehicles + collisions
physics.raycast(origin, dir, maxDist) // -> { hit, point, normal, surface, distance }
```

### VehicleState (read by camera, vfx, audio, hud, ai — treat as READ-ONLY outside physics)

```js
{
  position: Vector3, quaternion: Quaternion,
  velocity: Vector3,        // world m/s
  localVelocity: Vector3,   // car space; -Z = forward
  angularVelocity: Vector3,
  speed,                    // m/s scalar (signed along forward)
  speedKmh,
  rpm, gear,                // gear: -1 reverse, 0 neutral, 1..n
  engineLoad,               // 0..1
  clutch,                   // 0..1
  throttle, brake, steer, handbrake,
  nosAmount,                // 0..1 remaining
  nosActive,                // bool
  wheels: [ {               // FL,FR,RL,RR
     contact: bool, contactPoint: Vector3, contactNormal: Vector3,
     surface, grip, compression /*0..1*/, suspensionForce,
     slipRatio, slipAngle /*rad*/, slipSpeed /*m/s of contact patch*/,
     steerAngle, spin /*rad/s*/, angle /*accumulated rad for mesh*/, load,
     lockedUp: bool, spinningUp: bool,
  } ],
  gForce: Vector3,          // car-space g's (x lateral, y vertical, z longitudinal)
  drifting: bool, driftAngle /*rad*/, driftScore,
  airborne: bool, airTime,
  damage: { front, rear, left, right, total },  // 0..1
  odometer, distanceTravelled,
  lastCollision,            // { time, impulse, normal }
}
```

---

## 10. CameraSystem — `src/camera/`

```js
cameras.mode          // 'chase'|'chaseFar'|'hood'|'bumper'|'cinematic'|'orbit'|'photo'
cameras.setMode(m)
cameras.setTarget(carInstance)
cameras.shake(strength, duration)
cameras.camera        // the PerspectiveCamera it drives (=== ctx.camera)
cameras.setPhotoPose({ position, lookAt, fov })   // used by the QA harness
```

Must write `ctx.camera.position/quaternion/fov` each frame, then `updateProjectionMatrix()` when
fov changes. Must expose `cameras.velocity` (world m/s of the camera) so PostFX can do motion blur.

---

## 11. VfxSystem — `src/vfx/`

```js
vfx.emitSmoke(pos, dir, amount, opts)
vfx.emitSparks(pos, normal, amount, opts)
vfx.emitDebris(pos, dir, amount)
vfx.addSkid(pos, dir, width, opacity, surface)
vfx.flash(pos, color, intensity, radius, life)
vfx.setSpeedLines(t)   // 0..1
```
Subscribes to bus events itself. Must respect `settings.get('particleBudget')`.

---

## 12. AudioSystem — `src/audio/`

```js
audio.unlock()          // must be called from a user gesture; main.js handles it
audio.setListener(camera)
audio.play(name, opts)  // -> handle { stop(), setVolume(), setRate() }
audio.masterVolume, audio.musicVolume, audio.sfxVolume
audio.enabled
```
All sound is synthesised with WebAudio (no files). Engine sound is per-car and driven from
`state.rpm`, `state.engineLoad`, `state.gear`.

---

## 13. UiSystem — `src/ui/`

Renders into `#ui-root` (DOM overlay, pointer-events managed per element).
```js
hud.setScreen('boot'|'menu'|'garage'|'race'|'results'|'paused')
hud.screen
hud.toast(msg, ms)
```
Reads `ctx.player.state` + `ctx.race` every frame. Must never allocate per frame (no innerHTML in
update — cache element refs and write `.textContent` / `style.transform` only).

---

## 14. RaceSystem — `src/game/`

```js
race.phase          // 'idle'|'countdown'|'racing'|'finished'
race.time           // seconds since start
race.laps, race.totalLaps
race.standings      // Array<{ car, position, lap, progress, lapTime, bestLap, totalTime, finished }>
race.getPosition(car), race.getProgress(car)
race.start(), race.restart()
race.opponents      // Array<CarInstance> AI-driven
```

---

## 15. PostFxSystem — `src/render/`

Owns the `EffectComposer`. **It, and only it, calls `renderer.render` / `composer.render`.**
```js
post.render(dt)
post.setEnabled(name, bool)
post.needsVelocity   // if true main.js keeps prev matrices for motion blur
post.resize(w, h)
```

---

## 16. File ownership map — DO NOT WRITE OUTSIDE YOUR LANE

| lane | owns |
|---|---|
| core | `src/main.js`, `src/core/**` |
| materials | `src/core/Assets.js`, `src/shaders/**` |
| env | `src/env/**` |
| track | `src/world/Track*.js`, `src/world/Road*.js`, `src/world/WorldSystem.js` |
| city | `src/world/city/**` (registered in main.js as `ctx.city`, inits after `world`) |
| car-art | `src/vehicle/**` |
| physics | `src/physics/**` |
| camera | `src/camera/**` |
| postfx | `src/render/**` |
| vfx | `src/vfx/**` |
| audio | `src/audio/**` |
| ui | `src/ui/**` |
| game | `src/game/**` |

If you need something from another lane that doesn't exist yet, code against the contract above and
guard with `?.` — the stub will be replaced.
