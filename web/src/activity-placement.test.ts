import { describe, expect, test } from "bun:test";
import { placementForDrop, positionOf, panelOpensTo, snapZonesFor, SNAP_DISTANCE } from "./activity-placement";

const VIEWPORT = { width: 1200, height: 800 };
const PANEL = { width: 32, height: 58 };

describe("placementForDrop", () => {
  test("靠近左边（≤100px）吸附到左边缘", () => {
    expect(placementForDrop({ x: 50, y: 300 }, VIEWPORT, PANEL)).toEqual({ side: "left", top: false, x: 0, y: 300 });
  });

  test("靠近右边（距边≤100px）吸附到右边缘", () => {
    // 面板右边缘距视口右边 = 1200 - (1040+32) = 128 > 100，改近一点
    expect(placementForDrop({ x: 1100, y: 300 }, VIEWPORT, PANEL)).toEqual({ side: "right", top: false, x: 0, y: 300 });
  });

  test("正好 100px 处仍吸附（含边界）", () => {
    expect(placementForDrop({ x: SNAP_DISTANCE, y: 10 }, VIEWPORT, PANEL).side).toBe("left");
  });

  test("超过 100px 就自由停靠，位置即落点", () => {
    expect(placementForDrop({ x: 400, y: 250 }, VIEWPORT, PANEL)).toEqual({ side: null, top: false, x: 400, y: 250 });
  });

  test("自由停靠会被夹在视口内", () => {
    // 800 处距右边 368px，超出吸附范围 → 自由停靠；y 超出底边被夹回。
    expect(placementForDrop({ x: 800, y: 790 }, VIEWPORT, PANEL)).toEqual({
      side: null,
      top: false,
      x: 800,
      y: 800 - PANEL.height,
    });
    expect(placementForDrop({ x: -50, y: -50 }, VIEWPORT, PANEL)).toEqual({ side: "left", top: true, x: 0, y: 0 });
  });

  test("窄屏两边都够近时取更近的一边", () => {
    const narrow = { width: 150, height: 400 };
    // 距左 10px，距右 150-(10+32)=108px → 左边更近
    expect(placementForDrop({ x: 10, y: 10 }, narrow, PANEL).side).toBe("left");
    // 距左 100px，距右 150-(100+32)=18px → 右边更近
    expect(placementForDrop({ x: 100, y: 10 }, narrow, PANEL).side).toBe("right");
  });
});

describe("positionOf", () => {
  test("左吸附贴左边，右吸附贴右边", () => {
    expect(positionOf({ side: "left", top: false, x: 0, y: 100 }, VIEWPORT, PANEL)).toEqual({ x: 0, y: 100 });
    expect(positionOf({ side: "right", top: false, x: 0, y: 100 }, VIEWPORT, PANEL)).toEqual({
      x: VIEWPORT.width - PANEL.width,
      y: 100,
    });
  });

  test("自由停靠按存储坐标，且夹在视口内", () => {
    expect(positionOf({ side: null, top: false, x: 300, y: 200 }, VIEWPORT, PANEL)).toEqual({ x: 300, y: 200 });
    expect(positionOf({ side: null, top: false, x: 5000, y: 5000 }, VIEWPORT, PANEL)).toEqual({
      x: VIEWPORT.width - PANEL.width,
      y: VIEWPORT.height - PANEL.height,
    });
  });

  test("吸附位置随视口宽度重算（窗口缩放后仍贴边）", () => {
    const wide = positionOf({ side: "right", top: false, x: 0, y: 0 }, { width: 2000, height: 800 }, PANEL);
    expect(wide.x).toBe(2000 - PANEL.width);
  });
});

describe("panelOpensTo", () => {
  test("面板在左半边就往右开，在右半边就往左开", () => {
    expect(panelOpensTo(0, 32, 1200)).toBe("right");
    expect(panelOpensTo(1168, 32, 1200)).toBe("left");
  });
});

describe("snapZonesFor", () => {
  test("靠近左/右边缘时报告对应区域", () => {
    expect(snapZonesFor(40, 400, 32, 1200)).toEqual(["left"]);
    expect(snapZonesFor(1150, 400, 32, 1200)).toEqual(["right"]);
  });

  test("靠近顶部时报 top", () => {
    expect(snapZonesFor(600, 40, 32, 1200)).toEqual(["top"]);
  });

  test("左上角同时报 left 和 top（两个轴都吸）", () => {
    expect(snapZonesFor(20, 20, 32, 1200)).toEqual(["left", "top"]);
  });

  test("右上角同时报 right 和 top", () => {
    expect(snapZonesFor(1150, 20, 32, 1200)).toEqual(["right", "top"]);
  });

  test("在中间时不报告任何区域（不显示吸附提示）", () => {
    expect(snapZonesFor(600, 400, 32, 1200)).toEqual([]);
  });
});

describe("顶部吸附", () => {
  test("靠近顶部松手后 y=0 且记 top", () => {
    expect(placementForDrop({ x: 600, y: 30 }, VIEWPORT, PANEL)).toEqual({
      side: null,
      top: true,
      x: 600,
      y: 0,
    });
  });

  test("左上角两轴同时吸住", () => {
    expect(placementForDrop({ x: 20, y: 20 }, VIEWPORT, PANEL)).toEqual({
      side: "left",
      top: true,
      x: 0,
      y: 0,
    });
  });

  test("中间落点不会吸附", () => {
    expect(placementForDrop({ x: 600, y: 400 }, VIEWPORT, PANEL)).toEqual({
      side: null,
      top: false,
      x: 600,
      y: 400,
    });
  });

  test("top 吸附时 positionOf 返回 y=0", () => {
    expect(positionOf({ side: null, top: true, x: 300, y: 999 }, VIEWPORT, PANEL)).toEqual({
      x: 300,
      y: 0,
    });
  });

  test("顶部+右边缘：x 贴右边，y=0", () => {
    expect(positionOf({ side: "right", top: true, x: 0, y: 500 }, VIEWPORT, PANEL)).toEqual({
      x: VIEWPORT.width - PANEL.width,
      y: 0,
    });
  });
});
