# NEED FOR TOKENS

A third-person arcade racing game built in Three.js, targeting the visual quality of a modern
Need for Speed title.

**[▶ Play it in your browser](https://baptistefalvet.github.io/NeedForTokens/)** — no install, no
download. Needs a WebGL2 browser and a discrete or Apple-silicon GPU for the higher quality tiers.

**Everything is generated procedurally at runtime.** No `.glb`, no `.hdr`, no textures, no audio
files, no fonts — nothing is downloaded and nothing is loaded from disk. Every road surface,
building facade, car body, engine note and letterform in this repository is produced by code.
That constraint is deliberate and absolute; see `CONTRACTS.md` §0.

```bash
npm install
npm run dev          # http://127.0.0.1:5273
```

**Controls** — `W`/`S` throttle & brake, `A`/`D` steer, `Space` handbrake, `Shift` NOS,
`V` camera, `C` look back, `R` respawn, `Esc` pause, `T` telemetry. Gamepad and touch supported.

---

## The prompt

FYI for readers: this repository was produced by Claude Code from the single prompt below.
Everything else here — the architecture, the QA harness, the blind A/B test, the scores — followed
from it.

> I want you to build a third-person racing game at the level of the most recent Need for Speed
> games.
>
> It should be utterly perfect, visually beautiful, with every single thing done at AAA quality -
> from textures to physics to anything you could think of.
>
> Fan out sub-agents and have sub-agents tackle each one individually so that the game is utterly
> perfect. You should /loop on each item and have a separate sub-agent check it visually to ensure
> it looks triple A. That separate sub-agent should be a really harsh critic, and if it doesn't
> look triple A, it should keep going.
>
> Don't stop until each sub-agent is utterly wowed with the quality when compared with the actual
> Need for Speed game. It should literally compare them side by side blind and say which one looks
> better. Do this in ThreeJS. /loop until it's utterly perfect. Fan out sub-agents and ultracode.
>
> The game will be called “Need for Tokens”

The "blind side-by-side" instruction is the one that shaped the project most, because it is the
only part that could return a verdict the build did not control. It became `tools/blindpair.mjs`,
and it did not say what the prompt hoped it would say — see
[Independent assessment](#independent-assessment) and [Known gaps](#known-gaps), which report the
result rather than the ambition.

---

## What's in it

| | |
|---|---|
| **Circuit** | "Vermilion Bay Circuit" — 3.86 km, 12 named corners, 60 m of elevation, a 26 m-radius hairpin, a 12° banked carousel, a blind crest and a 290 m tunnel |
| **Cars** | 6 hand-authored parametric bodies (lofted cross-sections, not primitives), 47k–60k tris each, with clearcoat + metal-flake paint, wheel wells, panel gaps and modelled lamp internals |
| **World** | ~290 seated buildings across 23 archetypes, urban ground with parking bays and crosswalks, street furniture, instanced vegetation, a 3.5 km backdrop skyline |
| **Lighting** | Physical Rayleigh/Mie sky with real optical depths, star field, phased moon, 3–4 cascade shadows with stable texel snapping, PMREM IBL refreshed on change |
| **Post** | Hand-rolled chain: GTAO, SSR, god rays, per-object velocity motion blur, DOF, bloom with Karis average, GPU auto-exposure, SMAA |
| **Physics** | Raycast suspension at a fixed 120 Hz, combined-slip tyre model, differentials, ABS/TC |
| **AI** | 7 opponents with braking-point planning, overtaking, defending and per-driver personality |
| **Audio** | Fully synthesised — engine built from firing order via `PeriodicWave`, so a cross-plane V8 burbles and a flat-plane V8 screams |
| **UI** | Custom 9-glyph stencil logotype, SVG tachometer, live minimap, garage, results |

---

## Architecture

`CONTRACTS.md` is the integration spec and is **load-bearing**. This game was built by many
authors working in parallel on disjoint file lanes; that document defines the `ctx` object, the
event vocabulary, and the exact shape of `VehicleState`, `Track` and `CarInstance`. Read it before
changing anything that crosses a lane boundary.

```
src/core/      engine bootstrap, input, settings, procedural texture factory
src/env/       sky, IBL, cascaded shadows, fog, weather
src/world/     track spline, road mesh, terrain   │  src/world/city/  buildings, props, tunnel
src/vehicle/   car lofting, materials, wheels     │  src/physics/     tyres, drivetrain, collision
src/camera/    chase/hood/cinematic rigs          │  src/render/      post-processing chain
src/vfx/       particles, skids, rain             │  src/audio/       synthesis
src/game/      race rules, AI drivers             │  src/ui/          HUD and screens
```

---

## Visual QA harness

The game exposes `window.__NFT` so it can be driven headlessly. `tools/screenshot.mjs` boots it in
Chromium with real GPU rasterisation and captures a deterministic shot list.

```bash
node tools/screenshot.mjs                          # full shot list → shots/latest/
node tools/screenshot.mjs --only 01,04 --nohud     # subset, no UI overlay
node tools/screenshot.mjs --smoke                  # boot gate; non-zero exit on any error
node tools/screenshot.mjs --quality ultra
```

Shots hold the car on the racing line via a QA autopilot (`nft.autoDrive`), so action frames are
reproducible rather than depending on where the car happened to end up.

### Blind A/B comparison

`tools/blindpair.mjs` pairs each frame against the closest-matching official Need for Speed press
screenshot, normalises both sides to identical resolution and format, randomises which is A and
which is B, and writes the answer key to a file the judge never sees.

```bash
node tools/screenshot.mjs --out shots/blind-src --nohud
node tools/blindpair.mjs --shots shots/blind-src --out shots/blind --seed 12345
```

Two things make this test honest, both learned the hard way:
- Our frames **must** have no HUD, or a judge identifies them instantly and every score is noise.
  The harness now verifies the overlay is actually hidden and refuses to capture otherwise.
- Both sides are normalised to **PNG**. Re-encoding our clean render to JPEG introduced 8×8 block
  artefacts in smooth gradients that a judge correctly read as a rendering bug — while the
  reference press shots, already JPEGs, had long since absorbed theirs.

`reference/` holds third-party press screenshots used solely as an internal quality yardstick.
They are gitignored, are never game assets, and are never redistributed.

---

## Performance

Measured at 1920×1080, `high` tier, on an Apple M4 Pro via ANGLE/Metal, machine otherwise idle:

| shot | fps | draws | tris |
|---|---|---|---|
| golden-hour chase | 177 | 1271 | 1.89 M |
| night neon wet | 57 | 1122 | 1.70 M |
| drift | 76 | 872 | 1.74 M |
| HUD race | 56 | 814 | 1.46 M |
| pack racing | 53 | 600 | 1.18 M |
| aerial vista | 43 | 1085 | 1.81 M |

Quality tiers (`low`/`medium`/`high`/`ultra`) gate shadow cascades, SSAO, SSR, motion blur, DOF,
god rays, particle budget, city density and draw distance. The renderer auto-drops a tier if it
sustains under ~34 fps.

---

## Independent assessment

The game was scored by a blind expert critique against official Need for Speed press
screenshots, normalised to identical resolution and format with the order randomised.

| build | set mean | notes |
|---|---|---|
| first scored build | 20.3 / 100 | *"a competent template project with a good post stack bolted on"* |
| current | **24.7 / 100** | excluding two invalid frames; 23.2 including them |

Category means on the current build: lighting 29.2, atmosphere 28.4, materials 24.0,
**geometry 18.0, texture detail 16.6**.

The judge's own summary of that movement is worth repeating verbatim, because it is the most
useful sentence anyone produced about this project: *"You have bought mood, not rendering
capability."* Lighting and atmosphere improved; geometry and texture density did not move at
all. Every daylight frame sits at or below the original baseline — the night and tunnel frames
carry the average.

**A caveat on the test itself.** Of 21 obtainable reference images, only 2 are genuine gameplay
frames; the rest are press/marketing renders with hand-composed framing, cinematic DOF and
characters that do not exist in the gameplay renderer. A truly like-for-like blind comparison
against real NFS *gameplay* is not achievable with publicly available assets. The exercise is
therefore reliable as expert defect-finding and unreliable as a "which looks better" verdict.

## Known gaps

Honest list. Nothing here is hidden behind a flattering screenshot. Ranked by the judge's
impact-per-unit-work, most valuable first.

- **Asphalt is one tiling albedo at uniform roughness.** No aggregate sparkle, no polished tyre
  lanes, no repair patches, no puddle mask. Roads are ~40% of every frame, so this is the largest
  uncovered surface in the game. Cheap-to-medium, enormous coverage.
- **Car bodies are painted rather than built.** Panel gaps, vents and grilles are largely shader
  lines; tyres are smooth cylinders with no sidewall lettering, no tread blocks and no deflection
  under load. Expensive (asset-side), but it is essentially the whole of the geometry score.
- **Shadow penumbra is close to constant with range.** Contact hardening was added but is still
  weak at distance, so mid-range shadows read flat.
- **Emissive surfaces don't light anything.** Neon signs and lit windows bloom but deposit no
  light or bounce onto adjacent geometry. Medium cost (baking emissive proxies as local lights).
- **Foliage** is alpha-tested cards; translucency and a soft alpha ramp were added, but leaf
  silhouettes still read as cutouts at close range.
- `sampleGround` and the terrain mesh disagree by up to 7.9 m at t≈0.80, where the circuit passes
  close to itself. Pre-existing; not yet fixed.
- Garage car *selection* is cosmetic (`ctx.cars` has no swap API); paint does apply.
- The drift scenario tends to end in a pile-up rather than a sustained slide, so shot 03 is not a
  good showcase of the (now working) drift physics.
- The QA autopilot cannot hold the racing line everywhere; a few track sections still run wide,
  which the capture validator now catches rather than silently shipping.
