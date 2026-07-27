/**
 * Per-surface particle look-up. Values are LINEAR albedo (the smoke shader lights them), not
 * sRGB — pushing sRGB values through would make every plume read washed out under ACES.
 */
export const SURFACE = {
  asphalt: {
    smoke: [0.80, 0.80, 0.83],
    size0: 0.38, size1: 3.1, life: 2.5,
    buoyancy: 0.30, turb: 0.42, drag: 1.55, glow: 0.0,
    rate: 46, skid: 1.0, debris: 0.0,
    debrisColor: [0.18, 0.18, 0.19],
  },
  concrete: {
    smoke: [0.72, 0.70, 0.66],
    size0: 0.36, size1: 2.9, life: 2.3,
    buoyancy: 0.28, turb: 0.42, drag: 1.6, glow: 0.0,
    rate: 40, skid: 0.85, debris: 0.0,
    debrisColor: [0.30, 0.29, 0.27],
  },
  curb: {
    smoke: [0.74, 0.71, 0.67],
    size0: 0.30, size1: 2.2, life: 1.7,
    buoyancy: 0.26, turb: 0.5, drag: 1.8, glow: 0.0,
    rate: 34, skid: 0.7, debris: 0.25,
    debrisColor: [0.42, 0.20, 0.18],
  },
  dirt: {
    smoke: [0.46, 0.33, 0.20],
    size0: 0.45, size1: 4.0, life: 2.9,
    buoyancy: 0.16, turb: 0.55, drag: 1.25, glow: 0.0,
    rate: 62, skid: 0.75, debris: 1.0,
    debrisColor: [0.30, 0.21, 0.13],
  },
  grass: {
    smoke: [0.27, 0.31, 0.15],
    size0: 0.34, size1: 2.6, life: 1.9,
    buoyancy: 0.14, turb: 0.5, drag: 1.5, glow: 0.0,
    rate: 44, skid: 0.55, debris: 1.35,
    debrisColor: [0.13, 0.26, 0.07],
  },
  metal: {
    smoke: [0.70, 0.70, 0.72],
    size0: 0.30, size1: 2.2, life: 1.6,
    buoyancy: 0.30, turb: 0.4, drag: 1.7, glow: 0.0,
    rate: 26, skid: 0.9, debris: 0.0,
    debrisColor: [0.35, 0.35, 0.38],
  },
  water: {
    smoke: [0.88, 0.91, 0.95],
    size0: 0.24, size1: 2.4, life: 1.0,
    buoyancy: -0.35, turb: 0.34, drag: 2.4, glow: 0.55,
    rate: 90, skid: 0.2, debris: 0.0,
    debrisColor: [0.5, 0.55, 0.6],
  },
};

export const DEFAULT_SURFACE = SURFACE.asphalt;

export function surfaceOf(name) {
  return SURFACE[name] || DEFAULT_SURFACE;
}

/** Budget split. Sums to ~0.93 of `particleBudget` so we never exceed the contract. */
export const BUDGET_SPLIT = {
  smoke: 0.50,
  rain: 0.28,
  hot: 0.10,
  cool: 0.05,
};

export const TIER = {
  low: { skid: 1200, flashes: 0, jets: 2, haze: 0, depthScale: 0, depthInterval: 0, soft: false },
  medium: { skid: 2600, flashes: 3, jets: 4, haze: 32, depthScale: 0.35, depthInterval: 4, soft: true },
  high: { skid: 4500, flashes: 5, jets: 6, haze: 64, depthScale: 0.45, depthInterval: 3, soft: true },
  ultra: { skid: 7000, flashes: 6, jets: 8, haze: 96, depthScale: 0.55, depthInterval: 2, soft: true },
};
