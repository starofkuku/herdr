// Layout maths for the turn navigator — the quick-jump ticks beside the
// transcript.
//
// Ported from codex-trace's `minimap.ts` so the two views behave the same. The
// rail is a compact block of evenly spaced ticks (one per user message) rather
// than ticks spread across the full viewport height: centring a handful of ticks
// over a tall panel used to fan three questions out across the whole screen.
//
// The pitch is the tick's centre-to-centre spacing, and it doubles as the tick's
// touch target height, so the two input styles need different ranges:
// - A pointer can hit a 6px spacing comfortably, which keeps a short session a
//   tight block.
// - A finger cannot. Touch uses a spacing at least as tall as a comfortable tap
//   target, which means fewer ticks fit and the rail samples sooner.
//
// When a session has more ticks than fit at the minimum pitch, the rail samples
// evenly spaced ones rather than rendering an unreadable smear.

export interface PitchRange {
  /** Smallest gap at which two ticks stay visually distinct and tappable. */
  min: number;
  /** Largest gap, so a short session does not fan out over the whole rail. */
  max: number;
}

/** Mouse/trackpad: ticks may sit close together. */
export const POINTER_PITCH: PitchRange = { min: 6, max: 12 };

/** Narrowest pointer tick spacing, exported for tests and callers. */
export const MIN_TICK_PITCH_POINTER = POINTER_PITCH.min;

/** Widest pointer tick spacing, exported for tests and callers. */
export const MAX_TICK_PITCH_POINTER = POINTER_PITCH.max;

/**
 * Touch: a tick must be big enough to hit reliably.
 *
 * 24px is the smallest size a fingertip targets dependably, and it is also the
 * rail's vertical padding, so the block never touches the rail's edges.
 */
export const TOUCH_PITCH: PitchRange = { min: 24, max: 34 };

/** Fallback rail height used before layout is measured. */
export const DEFAULT_NAVIGATOR_HEIGHT_PX = 320;

/** Vertical padding of the rail, excluded from the usable tick space. */
export const NAVIGATOR_PADDING_PX = 24;

export interface NavigatorLayout {
  /** Centre-to-centre spacing between adjacent ticks, in CSS px. */
  pitch: number;
  /**
   * Indices into the message list to render, ascending. This is every entry
   * unless the session is long enough to require sampling.
   */
  indices: number[];
}

/**
 * Chooses the tick pitch and which entries to render.
 *
 * `availableHeight` is the height the rail may occupy. Every entry is rendered
 * while the ticks fit at the minimum pitch; beyond that the rail keeps each tick
 * individually clickable by sampling evenly spaced entries.
 *
 * `activeIndex` (when given) is always included in the sampled result so the
 * selected entry stays highlighted even when it would have been skipped;
 * otherwise the active marker would silently disappear on long sessions.
 */
export function navigatorLayout(
  count: number,
  availableHeight = DEFAULT_NAVIGATOR_HEIGHT_PX,
  activeIndex?: number,
  pitchRange: PitchRange = POINTER_PITCH,
): NavigatorLayout {
  if (count <= 0) return { pitch: pitchRange.max, indices: [] };
  if (count === 1) return { pitch: pitchRange.max, indices: [0] };

  const usable = Math.max(0, availableHeight - NAVIGATOR_PADDING_PX);
  const capacity = Math.max(1, Math.floor(usable / pitchRange.min));

  if (count <= capacity) {
    const fitted = Math.floor(usable / count);
    const pitch = Math.max(pitchRange.min, Math.min(pitchRange.max, fitted));
    return { pitch, indices: range(count) };
  }

  // Too many entries to show individually: sample evenly, always including the
  // first and last so the rail still spans the whole conversation.
  const indices: number[] = [];
  let previous = -1;
  for (let i = 0; i < capacity; i += 1) {
    const index = Math.round((i * (count - 1)) / (capacity - 1));
    if (index !== previous) {
      indices.push(index);
      previous = index;
    }
  }

  const active = clampIndex(activeIndex, count);
  if (active !== undefined && !indices.includes(active)) {
    indices.push(active);
    indices.sort((a, b) => a - b);
  }

  return { pitch: pitchRange.min, indices };
}

function clampIndex(index: number | undefined, count: number): number | undefined {
  if (index === undefined || index < 0 || index >= count) return undefined;
  return index;
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}
