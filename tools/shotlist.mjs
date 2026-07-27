/**
 * The canonical shot list for automated visual QA.
 *
 * Each shot drives the live game through `window.__NFT` (see src/main.js `_installTestHooks`)
 * and then grabs a frame. Keep these deterministic — the critic diffs iterations against each
 * other, so a shot that wanders is a shot that can't be judged.
 *
 * IMPORTANT: shots 01–06, 08, 09, 11 and 12 are condition-matched to a specific official Need
 * for Speed press screenshot (see `reference/catalog.json` → `pairing`) so the blind A/B test
 * compares *rendering quality* and not subject matter. If you change a shot's camera framing,
 * time of day or weather, re-check its pairing or the comparison stops being fair.
 *
 * `setup` MUST be an arrow function — it is stringified and re-evaluated inside the browser,
 * and method shorthand does not survive that round trip.
 */

export const SHOTS = [
  {
    name: '01-hero-golden-chase',
    ref: 'Heat — chase cam, daylight, dry',
    brief:
      'The money shot. Third-person chase, low sun, hero car at speed on a sweeping bend. This is the frame that gets compared to a NFS screenshot.',
    setup: async (nft) => {
      nft.setPreset('goldenHour');
      nft.setCamera('chase');
      nft.teleport(0.12, 0, 190);
      nft.autoDrive(true, { pace: 1.0 });
      await nft.settle(2.2);
    },
  },
  {
    name: '02-night-neon-wet',
    ref: 'Heat — chase cam, night, wet neon street',
    brief:
      'Night city, wet asphalt. Neon signage, street lights and tail lights must smear into the road as real reflections — not a flat dark plane.',
    setup: async (nft) => {
      nft.setPreset('night');
      nft.setWeather({ wetness: 0.85, rain: 0.25 });
      nft.setCamera('chase');
      nft.teleport(0.42, 1.5, 150);
      nft.autoDrive(true, { pace: 0.95 });
      await nft.settle(2.2);
    },
  },
  {
    name: '03-drift-smoke',
    ref: 'Unbound — chase cam, daylight, drift smoke, two cars',
    brief:
      'Big-angle drift with tyre smoke in daylight, skid marks laid down behind, brake discs glowing. Smoke must be lit and volumetric-feeling — not grey billboards. Daylight is the harder test: smoke has nowhere to hide.',
    setup: async (nft) => {
      nft.setPreset('noon');
      nft.setCamera('chase');
      nft.teleport(0.62, 0, 140);
      nft.drive({ throttle: 1, steer: 0.95, handbrake: 1 });
      await nft.settle(1.3);
      nft.drive({ throttle: 1, steer: 0.8, handbrake: 0 });
      await nft.settle(1.1);
    },
  },
  {
    name: '04-garage-showcase',
    ref: 'Unbound — showcase, rear 3/4, daylight garage',
    brief:
      'Rear 3/4 presentation of the hero car in daylight. Judge the car model alone: panel gaps, proportions, paint flake, clearcoat, glass, wheels, brake calipers, badge. Must look modelled, not boxy.',
    setup: async (nft) => {
      nft.setPreset('noon');
      nft.screen('garage');
      // Showcase shots MUST reposition the car: they run after action scenarios that can leave
      // it far off the circuit, which previously produced buried-camera null frames.
      nft.teleport(0.02, 0, 0);
      nft.setCamera('photo');
      nft.photo({ position: [4.6, 1.35, 5.2], lookAt: [0, 0.72, 0], fov: 38 });
      await nft.settle(1.6);
    },
  },
  {
    name: '05-front-three-quarter',
    ref: 'Unbound — showcase, front 3/4, night, rain',
    brief:
      'Front 3/4 hero of the car at night in the rain, headlights on. Judge headlight internals, grille depth, bumper intakes, bonnet vents, wing mirrors, tyre sidewall lettering, and how wet paint reads under artificial light.',
    setup: async (nft) => {
      nft.setPreset('night');
      nft.setWeather({ wetness: 1, rain: 0.6 });
      nft.screen('garage');
      nft.teleport(0.02, 0, 0);
      nft.setCamera('photo');
      nft.photo({ position: [-4.2, 1.1, -5.4], lookAt: [0, 0.66, -0.2], fov: 42 });
      await nft.settle(1.6);
    },
  },
  {
    name: '06-scenic-dusk',
    ref: 'NFS 2015 — showcase, rear 3/4 on open road, dusk, wet',
    brief:
      'Rear 3/4 of the car parked on the road at dusk with the landscape behind it. Judge atmospheric perspective, how the environment falls away into haze, sky quality, and wet-road specular response.',
    setup: async (nft) => {
      nft.setPreset('dusk');
      nft.setWeather({ wetness: 0.7, rain: 0 });
      nft.setCamera('photo');
      nft.teleport(0.34, 0, 0);
      nft.photo({ position: [5.4, 1.6, 7.6], lookAt: [0, 0.8, 0.4], fov: 40 });
      await nft.settle(1.6);
    },
  },
  {
    name: '07-hud-race',
    ref: 'internal only — no blind pairing',
    brief:
      'In-race HUD over gameplay. Judge typography, hierarchy, speedo/tach design, minimap, position/lap readouts. Must feel like a shipped AAA UI, not a debug overlay.',
    setup: async (nft) => {
      nft.setPreset('dusk');
      nft.screen('race');
      nft.setCamera('chase');
      nft.teleport(0.3, 0, 210);
      nft.autoDrive(true, { nos: 1, pace: 1.0 });
      await nft.settle(1.8);
    },
  },
  {
    name: '08-rain-chase',
    ref: 'Heat — front/hood cam, dusk, wet road',
    brief:
      'Heavy rain at dusk from a low front camera. Road spray off the tyres, raindrops in air, headlight cones cutting the murk, wet specular highlights, lens beading.',
    setup: async (nft) => {
      nft.setPreset('stormy');
      nft.setWeather({ wetness: 1, rain: 1 });
      nft.setCamera('bumper');
      nft.teleport(0.86, 0, 150);
      nft.autoDrive(true, { pace: 0.8 });
      await nft.settle(1.6);
    },
  },
  {
    name: '09-cockpit',
    ref: 'Unbound — hood cam, night, wet, motion blur',
    brief:
      'Hood camera at speed at night on a wet road. Judge sense of velocity: motion blur, FOV, road texture streaming under the car, horizon stability, reflected light on the bonnet.',
    setup: async (nft) => {
      nft.setPreset('night');
      nft.setWeather({ wetness: 0.9, rain: 0.2 });
      nft.setCamera('hood');
      nft.teleport(0.05, 0, 240);
      nft.autoDrive(true, { nos: 1, pace: 1.0 });
      await nft.settle(2.0);
    },
  },
  {
    name: '10-menu',
    noValidate: true,
    ref: 'internal only — no blind pairing',
    brief:
      'Main menu / car select. Judge it as a shipped title screen: layout, type, motion-implied composition, brand identity of "NEED FOR TOKENS".',
    setup: async (nft) => {
      nft.screen('menu');
      await nft.settle(1.6);
    },
  },
  {
    name: '11-pack-racing',
    ref: 'Unbound — chase cam, daylight, wheel-to-wheel',
    brief:
      'Wheel-to-wheel with AI opponents in daylight. Judge opponent car variety, paint, lighting consistency between cars, and the sense of a real race.',
    setup: async (nft) => {
      nft.setPreset('noon');
      nft.setCamera('chaseFar');
      nft.teleport(0.2, -2.5, 180);
      nft.autoDrive(true, { pace: 1.0 });
      await nft.settle(2.6);
    },
  },
  {
    name: '12-tunnel-nos',
    ref: 'Heat — cinematic, night, wet, heavy neon',
    brief:
      'NOS active at night in a tunnel or under an overpass. Judge bloom discipline, exhaust flame, speed lines, chromatic aberration, and light bounce in an enclosed space.',
    // The tunnel spans t≈0.519–0.628 and sits on a banked LEFT corner (T7, R72). Driving in with
    // zero steering just puts the car into the outside wall, which made this shot's framing a
    // lottery. Enter early, hold a matching left steer, and keep the settle short.
    setup: async (nft) => {
      nft.setPreset('night');
      nft.setWeather({ wetness: 0.8, rain: 0 });
      nft.setCamera('chase');
      nft.teleport(0.53, 0, 180);
      nft.autoDrive(true, { nos: 1, pace: 0.92 });
      await nft.settle(1.4);
    },
  },
  {
    name: '13-aerial-vista',
    noValidate: true,
    ref: 'internal only — no blind pairing',
    brief:
      'Wide aerial establishing shot. Judge world density, skyline silhouette, atmospheric perspective, road furniture, and whether the circuit reads as a real place rather than a ribbon in a void.',
    setup: async (nft) => {
      nft.setPreset('goldenHour');
      nft.setCamera('photo');
      nft.teleport(0.2, 0, 0);
      nft.photo({ position: [70, 44, 90], lookAt: [0, 2, 0], fov: 46, worldUp: true });
      await nft.settle(1.4);
    },
  },
];

export const SHOT_NAMES = SHOTS.map((s) => s.name);
