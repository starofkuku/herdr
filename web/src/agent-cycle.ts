/*
 * The order a Shift+Tab cycle walks, how it advances, and where each card sits
 * on the ring.
 *
 * Pure, so the geometry can be checked without a browser and the rule that
 * decides what the reader sees can be checked without a socket.
 */

import { compareAgents, type AgentView } from "./api";

/**
 * The agents in the order the cycle visits them: the ones that need the reader
 * first.
 *
 * `compareAgents` already sorts by status — blocked, then working, then done and
 * idle — and the cycle starts at the head of that order. So the first press
 * reaches whoever is waiting on the reader, whatever backend they are on, which
 * is the thing the reader is looking for. The alternative, starting from the
 * agent already on screen, spends the first press walking to an idle neighbour.
 *
 * The order is stable for a given set: the same agents sort the same way, so a
 * second visit finds each one where it was.
 */
export function cycleOrder(agents: AgentView[]): AgentView[] {
  return [...agents].sort(compareAgents);
}

/**
 * The agent after `index`, wrapping at the end.
 *
 * Wrapping is what makes one direction enough: every agent is reachable, so
 * there is no need for a second chord to go back.
 */
export function nextIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index + 1) % length + length) % length;
}

/**
 * Degrees between neighbouring cards on the ring.
 *
 * This is the number that decides how many cards are legible at once, and it
 * works against the radius: the radius is what keeps neighbours from overlapping,
 * so a smaller step needs a larger ring — but a smaller step also packs more of
 * the ring into the arc that faces the reader. Sixteen is the width that buys
 * seven legible cards, where a flat row of the same width showed six, and the
 * neighbours either side of the choice stay readable rather than becoming edges.
 */
export const RING_STEP_DEG = 16;

/**
 * How far the ring's surface is from its axis, in rem.
 *
 * Set so the arc between neighbouring cards is about one card wide, which is
 * what keeps them touching instead of overlapping — an overlapped card cannot be
 * read, and a ring where the near cards hide the far ones is a worse list than a
 * flat one. This is the radius that just touches at every angle, not only at the
 * front, for a card the width the stylesheet draws.
 */
const RING_RADIUS_REM = 34;

/*
 * The fade band, in degrees from the front.
 *
 * A card up to forty-eight degrees is foreshortened but still legible, and stays
 * fully opaque. Past that it is projecting to a sliver — turned this far and set
 * this far back, its two upright edges fall almost onto the same line, and what
 * reaches the reader is a stray vertical line rather than a card. So it is gone
 * by sixty-two, and the cue at the edge is the ring's own curve instead.
 */
const FADE_FROM_DEG = 48;
const FADE_TO_DEG = 62;

/**
 * How far the ring tips away from the reader, as the sine of the angle.
 *
 * This is what turns a row of cards that happen to be skewed into something
 * read as a circle. Cards standing upright around a horizontal ring, seen from
 * level with them, occupy one line no matter how far round they are; seen from
 * above — which is what tipping the ring amounts to — the ones that have gone
 * round rise, and the arrangement traces an ellipse. Without it the whole effect
 * is a row that narrows at the ends.
 *
 * The cards themselves stay upright, as the panels of a real carousel do; only
 * where they sit follows the tipped circle. 0.208 is about twelve degrees.
 */
const RING_TILT = 0.208;

/**
 * How far the ring sits below the middle of its box, in rem.
 *
 * Tipping the ring lifts everything that goes round it, so without this the
 * ring's mass would sit in the upper half of its box and crowd the heading. Half
 * the lift at the sides puts the front card below the middle by the same amount
 * the far cards rise above it, which centres the curve.
 */
const RING_DROP_REM = (RING_RADIUS_REM * RING_TILT) / 2;

/** Where one card sits on the ring. */
export interface RingPlacement {
  /** Rotation about the ring's axis; 0 faces the reader flat on. */
  angle: number;
  /** Horizontal offset from the front of the ring, in rem. */
  x: number;
  /** Vertical offset, in rem; negative is higher up the screen. */
  y: number;
  /** Depth: negative is away from the reader, in rem. */
  z: number;
  /** How visible the card is, from 1 down to 0. */
  opacity: number;
  /** Whether it can be pointed at or clicked. */
  interactive: boolean;
}

/**
 * Places one card on the ring.
 *
 * The ring turns so the highlighted card is always the one at the front, facing
 * the reader flat on: the choice stays the easiest thing on screen to read, and
 * its neighbours are the ones either side of it in the walk. Turning to the card
 * rather than moving the card is also what keeps the whole circle in view — the
 * alternatives are all still there, just further round.
 */
export function ringPlacement(index: number, selected: number): RingPlacement {
  const angle = (index - selected) * RING_STEP_DEG;
  const radians = (angle * Math.PI) / 180;
  const x = RING_RADIUS_REM * Math.sin(radians);
  // The front of the ring is the perspective plane, so the card facing the
  // reader is at its full size and everything else recedes.
  const z = RING_RADIUS_REM * (Math.cos(radians) - 1);
  const y = z * RING_TILT + RING_DROP_REM;
  const from = Math.abs(angle);
  const opacity =
    from <= FADE_FROM_DEG
      ? 1
      : from >= FADE_TO_DEG
        ? 0
        : (FADE_TO_DEG - from) / (FADE_TO_DEG - FADE_FROM_DEG);
  return { angle, x, y, z, opacity, interactive: opacity > 0.05 };
}
