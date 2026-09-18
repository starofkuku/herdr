import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NAVIGATOR_HEIGHT_PX,
  MAX_TICK_PITCH_POINTER,
  MIN_TICK_PITCH_POINTER,
  NAVIGATOR_PADDING_PX,
  POINTER_PITCH,
  TOUCH_PITCH,
  navigatorLayout,
  tickPositionAt,
} from "./navigator";

describe("navigatorLayout", () => {
  test("returns no ticks for an empty session", () => {
    expect(navigatorLayout(0).indices).toEqual([]);
  });

  test("renders a single tick at the capped pitch", () => {
    const layout = navigatorLayout(1);
    expect(layout.indices).toEqual([0]);
    expect(layout.pitch).toBe(POINTER_PITCH.max);
  });

  test("renders every tick when they fit", () => {
    const layout = navigatorLayout(5, 320);
    expect(layout.indices).toEqual([0, 1, 2, 3, 4]);
  });

  test("never drops below the minimum pitch", () => {
    // 100 items in a 320px rail cannot be spaced out; they must be sampled.
    const layout = navigatorLayout(100, 320);
    expect(layout.pitch).toBeGreaterThanOrEqual(POINTER_PITCH.min);
    expect(layout.indices.length).toBeLessThan(100);
  });

  test("samples rather than overflowing the rail", () => {
    const height = 320;
    const layout = navigatorLayout(500, height);
    const usable = height - NAVIGATOR_PADDING_PX;
    expect(layout.indices.length * layout.pitch).toBeLessThanOrEqual(usable);
  });

  test("keeps sampled indices ascending and unique", () => {
    const { indices } = navigatorLayout(500, 320);
    expect(indices).toEqual([...new Set(indices)]);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  test("spans the whole session when sampling", () => {
    const { indices } = navigatorLayout(500, 320);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(499);
  });

  test("always keeps the active tick even when it would be skipped", () => {
    // Pick an index that even sampling is unlikely to land on exactly.
    const active = 137;
    const { indices } = navigatorLayout(500, 320, active);
    expect(indices).toContain(active);
  });

  test("ignores an out-of-range active index", () => {
    const { indices } = navigatorLayout(500, 320, 9999);
    expect(indices.every((i) => i >= 0 && i < 500)).toBe(true);
  });

  test("touch pitch is large enough to tap", () => {
    // The tick height equals the pitch, so the minimum is the tap target.
    expect(TOUCH_PITCH.min).toBeGreaterThanOrEqual(24);
  });

  test("touch fits fewer ticks than a pointer in the same rail", () => {
    const height = DEFAULT_NAVIGATOR_HEIGHT_PX;
    const pointer = navigatorLayout(50, height, undefined, POINTER_PITCH);
    const touch = navigatorLayout(50, height, undefined, TOUCH_PITCH);
    expect(touch.indices.length).toBeLessThanOrEqual(pointer.indices.length);
  });

  test("short sessions stay compact instead of spreading out", () => {
    // Three ticks must not fan across a tall rail.
    const { pitch } = navigatorLayout(3, 900);
    expect(pitch).toBeLessThanOrEqual(POINTER_PITCH.max);
  });

  test("exported bounds match the module constants", () => {
    expect(MIN_TICK_PITCH_POINTER).toBe(POINTER_PITCH.min);
    expect(MAX_TICK_PITCH_POINTER).toBe(POINTER_PITCH.max);
  });

  test("a rail with no room still yields a usable layout", () => {
    const layout = navigatorLayout(10, 0);
    expect(layout.pitch).toBeGreaterThan(0);
    expect(layout.indices.length).toBeGreaterThan(0);
  });
});

describe("tickPositionAt", () => {
  const pitch = 24;
  const count = 10;

  test("maps the centre of each tick to its own position", () => {
    for (let i = 0; i < count; i += 1) {
      expect(tickPositionAt(i * pitch + pitch / 2, pitch, count)).toBe(i);
    }
  });

  test("maps a boundary to the tick it belongs to", () => {
    // Exactly on a boundary belongs to the tick that starts there.
    expect(tickPositionAt(pitch, pitch, count)).toBe(1);
    expect(tickPositionAt(pitch - 1, pitch, count)).toBe(0);
  });

  test("clamps above the first tick instead of selecting nothing", () => {
    expect(tickPositionAt(-40, pitch, count)).toBe(0);
  });

  test("clamps below the last tick so a drag past the end keeps a target", () => {
    expect(tickPositionAt(count * pitch + 200, pitch, count)).toBe(count - 1);
  });

  test("returns nothing for an empty or degenerate rail", () => {
    expect(tickPositionAt(10, pitch, 0)).toBeUndefined();
    expect(tickPositionAt(10, 0, count)).toBeUndefined();
  });
});
