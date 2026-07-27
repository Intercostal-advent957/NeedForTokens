/**
 * Opponent personalities and the rubber-band tuning.
 *
 * Every field is 0..1 and every field is *read by AiDriver*, so changing a number here changes
 * how that driver races and nothing else. The grid should never feel like eight copies of one
 * driver, so the profiles deliberately differ on more than raw pace:
 *
 *   skill        overall pace: corner speed, how close to the grip limit they run, how quickly
 *                they correct a slide.
 *   bravery      how late they brake. 1.0 = uses the full computed braking capacity, 0.0 = brakes
 *                ~25% early. Brave + low skill = the driver who out-brakes himself into the wall.
 *   aggression   willingness to start a move: smaller gaps, less lift when someone is alongside,
 *                more use of NOS to force a pass.
 *   consistency  inverse mistake rate and inverse steering noise. Low consistency = lock-ups,
 *                overshoots and a wandering line.
 *   defend       how much they move across to cover the inside when attacked from behind.
 *   patience     how long they will sit behind a car before committing to a move.
 */

/** @typedef {{name:string,skill:number,bravery:number,aggression:number,consistency:number,defend:number,patience:number}} DriverProfile */

/** @type {DriverProfile[]} — index 0 is the strongest driver on the grid. */
export const DRIVER_PROFILES = [
  { name: 'KESTREL', skill: 0.97, bravery: 0.93, aggression: 0.72, consistency: 0.95, defend: 0.7, patience: 0.75 },
  { name: 'RONIN', skill: 0.93, bravery: 0.99, aggression: 0.95, consistency: 0.74, defend: 0.9, patience: 0.3 },
  { name: 'HALCYON', skill: 0.89, bravery: 0.8, aggression: 0.45, consistency: 0.93, defend: 0.45, patience: 0.9 },
  { name: 'VESPER', skill: 0.85, bravery: 0.88, aggression: 0.8, consistency: 0.78, defend: 0.75, patience: 0.5 },
  { name: 'CINDER', skill: 0.8, bravery: 0.72, aggression: 0.62, consistency: 0.84, defend: 0.5, patience: 0.7 },
  { name: 'MAGPIE', skill: 0.75, bravery: 0.95, aggression: 0.9, consistency: 0.58, defend: 0.85, patience: 0.25 },
  { name: 'DUSTOFF', skill: 0.7, bravery: 0.62, aggression: 0.35, consistency: 0.66, defend: 0.3, patience: 0.95 },
  { name: 'TALLY', skill: 0.64, bravery: 0.55, aggression: 0.5, consistency: 0.55, defend: 0.35, patience: 0.6 },
];

/**
 * RUBBER BANDING — subtle and honest.
 *
 * The AI's *target speed* (and only the target speed) is scaled by `1 + band`, where `band` is
 * derived from how far that car is from the player along the track. Nothing else is touched: no
 * extra power, no extra grip, no teleporting. Because the target speed is grip-feasible to begin
 * with, a few percent on top is a driver driving a bit harder — not a car breaking physics.
 *
 *   band = clamp((gap - DEAD_GAP) / (FULL_GAP - DEAD_GAP), 0, 1) * MAX_GAIN * bias
 *
 * `gap` is signed: positive when the AI is BEHIND the player (it gets CATCH_UP bias), negative
 * when it is ahead (HOLD_BACK bias, deliberately weaker so leading the race still feels earned).
 * The term is rate-limited so it can never snap, and it is hard-clamped to +/-MAX_GAIN. At the
 * default 6% a leader half a lap up loses about 4 s over a 90 s lap — noticeable as "the race
 * stays alive", never as "that car is cheating".
 *
 * Rubber banding is disabled entirely in time-trial and drift events.
 */
export const RUBBER_BAND = {
  /** Hard cap on the target-speed multiplier, either direction. THE headline tunable. */
  MAX_GAIN: 0.06,
  /** Metres of gap below which there is no effect at all. */
  DEAD_GAP: 35,
  /** Metres of gap at which the effect saturates at MAX_GAIN. */
  FULL_GAP: 320,
  /** Multiplier applied when the AI is behind the player. */
  CATCH_UP: 1.0,
  /** Multiplier applied when the AI is ahead of the player (weaker on purpose). */
  HOLD_BACK: 0.6,
  /** Per-second slew limit on the band value, so it eases in and out. */
  RATE: 0.35,
};

/**
 * Rank the roster by a crude performance index so the strongest profile lines up with the
 * strongest car. Real grids are seeded this way, and it means "did the faster driver finish
 * ahead?" is a question about the AI rather than about who got the hot hatch.
 */
export function perfIndex(def) {
  return (def.power / def.mass) * def.tyreGrip * (1 + def.downforce * 0.04);
}
