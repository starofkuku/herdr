/**
 * Where the pane rail sits.
 *
 * Two kinds of position: held against an edge, or floating where it was dropped.
 * Held is not "very close to an edge" — a rail half a pixel from the edge reads as
 * a mistake rather than a position — so releasing near one attaches it, and
 * anywhere else the reader's placement is left alone.
 *
 * The horizontal and vertical axes are independent: a rail can be held to the top
 * and still sit at whatever `x` it was dropped at, which is what makes the top
 * edge useful for a rail parked out of the way along the top of the page.
 */
export type Side = "left" | "right";
export type SnapZone = Side | "top";

export interface Placement {
  /** The docked side, or null when the horizontal position is free. */
  side: Side | null;
  /** Whether the rail is held against the top edge. */
  top: boolean;
  /** Top offset in CSS pixels. Ignored while `top` is set. */
  y: number;
  /** Left offset in CSS pixels. Ignored while `side` is set. */
  x: number;
}

export interface Box {
  width: number;
  height: number;
}

/** How near an edge a drop has to land to be held there. */
export const SNAP_DISTANCE = 100;

const STORAGE_KEY = "herdr-web-activity-placement";

/** Default: held against the right edge, a third of the way down. */
const FALLBACK: Placement = { side: "right", top: false, x: 0, y: 96 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Keeps a box fully on screen, which matters after a window shrink or a drag out. */
export function clampToViewport(x: number, y: number, viewport: Box, panel: Box) {
  return {
    x: clamp(x, 0, Math.max(0, viewport.width - panel.width)),
    y: clamp(y, 0, Math.max(0, viewport.height - panel.height)),
  };
}

/**
 * Where a drop lands: held against whichever edges it was released near,
 * otherwise exactly where it was let go.
 *
 * Both sides can be in range at once on a viewport narrower than twice the snap
 * distance. The nearer one wins there, so the choice stays predictable instead of
 * jittering by a pixel.
 *
 * Pure, so the snap rule is testable without a pointer.
 */
export function placementForDrop(
  drop: { x: number; y: number },
  viewport: Box,
  panel: Box,
  snapDistance: number = SNAP_DISTANCE,
): Placement {
  const rightGap = viewport.width - (drop.x + panel.width);
  const nearLeft = drop.x <= snapDistance;
  const nearRight = rightGap <= snapDistance;
  const top = drop.y <= snapDistance;

  let side: Side | null = null;
  if (nearLeft || nearRight) {
    side = nearRight && rightGap < drop.x ? "right" : "left";
  }

  const free = clampToViewport(drop.x, drop.y, viewport, panel);
  return {
    side,
    top,
    // A held axis is stored as a flag, not as the pixel value it resolves to, so
    // resizing the window keeps the rail on its edge.
    x: side ? 0 : free.x,
    y: top ? 0 : free.y,
  };
}

/**
 * The on-screen top-left for a placement.
 *
 * Held axes are resolved against the current viewport rather than read back from
 * storage, so a resize moves the rail with the edge instead of leaving it where
 * the edge used to be.
 */
export function positionOf(
  placement: Placement,
  viewport: Box,
  panel: Box,
): { x: number; y: number } {
  const free = clampToViewport(placement.x, placement.y, viewport, panel);
  const y = placement.top ? 0 : free.y;

  if (placement.side === "left") return { x: 0, y };
  if (placement.side === "right") return { x: Math.max(0, viewport.width - panel.width), y };
  return { x: free.x, y };
}

/**
 * Which side the list slides out to, given where the handle is.
 *
 * Towards the middle of the screen, so the list opens into open space instead of
 * off the edge the handle is already against.
 */
export function panelOpensTo(x: number, width: number, viewportWidth: number): Side {
  return x + width / 2 > viewportWidth / 2 ? "left" : "right";
}

/**
 * The edges a dragged rail is currently near, for the drop-zone highlights.
 *
 * Empty when it is nowhere near an edge, so the highlight only appears when
 * releasing would actually attach the rail. Both a side and the top can be
 * reported at once, because a corner holds on both axes.
 */
export function snapZonesFor(
  x: number,
  y: number,
  width: number,
  viewportWidth: number,
  snapDistance: number = SNAP_DISTANCE,
): SnapZone[] {
  const zones: SnapZone[] = [];
  if (x <= snapDistance) zones.push("left");
  if (viewportWidth - (x + width) <= snapDistance) zones.push("right");
  if (y <= snapDistance) zones.push("top");
  return zones;
}

export function loadPlacement(): Placement {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return FALLBACK;
    const parsed = JSON.parse(raw) as Partial<Placement>;
    return {
      side: parsed.side === "left" || parsed.side === "right" ? parsed.side : null,
      // Absent on entries written before the top edge was snap-able.
      top: parsed.top === true,
      x: typeof parsed.x === "number" ? parsed.x : FALLBACK.x,
      y: typeof parsed.y === "number" ? parsed.y : FALLBACK.y,
    };
  } catch {
    // Corrupt or unavailable storage is not fatal; the default is as good as any.
    return FALLBACK;
  }
}

export function savePlacement(placement: Placement): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(placement));
  } catch {
    // Ignore storage failures (private mode, quota). The move still applies.
  }
}
