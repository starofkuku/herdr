import { describe, expect, test } from "bun:test";
import type { AgentStatus } from "./api";
import { detectFinishes, orderActivity } from "./activity-order";

const agents = (...statuses: [string, AgentStatus][]) =>
  statuses.map(([paneId, status]) => ({
    paneId,
    workspaceId: "w1",
    label: "pi",
    agent: "pi",
    status,
    project: "herdr",
    cwd: "/home/administrator/githubwork/herdr",
  })) as never as Parameters<typeof detectFinishes>[0];

describe("detectFinishes", () => {
  test("working → done 被记为完成", () => {
    const previous = new Map<string, AgentStatus>();
    detectFinishes(agents(["w1:p1", "working"]), previous);
    expect(detectFinishes(agents(["w1:p1", "done"]), previous)).toEqual({ "w1:p1": "working" });
  });

  test("首次看到就是 done 不算完成（没看过它工作）", () => {
    const previous = new Map<string, AgentStatus>();
    expect(detectFinishes(agents(["w1:p1", "done"]), previous)).toEqual({});
  });

  test("idle → done 不算完成（idle 是常态）", () => {
    const previous = new Map<string, AgentStatus>();
    detectFinishes(agents(["w1:p1", "idle"]), previous);
    expect(detectFinishes(agents(["w1:p1", "done"]), previous)).toEqual({});
  });

  test("blocked → done 不算完成（只认 working）", () => {
    const previous = new Map<string, AgentStatus>();
    detectFinishes(agents(["w1:p1", "blocked"]), previous);
    expect(detectFinishes(agents(["w1:p1", "done"]), previous)).toEqual({});
  });

  test("done 保持 done 不重复触发", () => {
    const previous = new Map<string, AgentStatus>();
    detectFinishes(agents(["w1:p1", "working"]), previous);
    detectFinishes(agents(["w1:p1", "done"]), previous);
    expect(detectFinishes(agents(["w1:p1", "done"]), previous)).toEqual({});
  });

  test("done → working（同一 pane 又开工）后再 done 会再触发", () => {
    const previous = new Map<string, AgentStatus>();
    detectFinishes(agents(["w1:p1", "working"]), previous);
    detectFinishes(agents(["w1:p1", "done"]), previous);
    detectFinishes(agents(["w1:p1", "working"]), previous);
    expect(detectFinishes(agents(["w1:p1", "done"]), previous)).toEqual({ "w1:p1": "working" });
  });

  test("pane 关闭后 forget，重开的同 id 不会被误判为完成", () => {
    const previous = new Map<string, AgentStatus>();
    detectFinishes(agents(["w1:p1", "working"]), previous);
    // pane 消失
    detectFinishes(agents(["w1:p2", "idle"]), previous);
    expect(previous.has("w1:p1")).toBe(false);
    // 同 id 回来且直接是 done —— 不能因为记着 working 而误报
    expect(detectFinishes(agents(["w1:p1", "done"]), previous)).toEqual({});
  });

  test("多 pane 同时完成都记下", () => {
    const previous = new Map<string, AgentStatus>();
    detectFinishes(
      agents(["w1:p1", "working"], ["w1:p2", "working"], ["w1:p3", "idle"]),
      previous,
    );
    expect(
      detectFinishes(agents(["w1:p1", "done"], ["w1:p2", "done"], ["w1:p3", "done"]), previous),
    ).toEqual({ "w1:p1": "working", "w1:p2": "working" });
  });

  test("没有变化时返回空对象（避免无谓的重渲染）", () => {
    const previous = new Map<string, AgentStatus>();
    detectFinishes(agents(["w1:p1", "working"]), previous);
    expect(detectFinishes(agents(["w1:p1", "working"]), previous)).toEqual({});
  });
});

describe("orderActivity", () => {
  const a = (paneId: string, status: AgentStatus) =>
    ({ paneId, status, label: paneId, cwd: "/x", project: "p", workspaceId: "w1", agent: "pi" }) as never;

  test("working 和 done 排在 idle 之前", () => {
    const sorted = orderActivity([a("p1", "idle"), a("p2", "done"), a("p3", "working")], {});
    expect(sorted.map((x) => x.status)).toEqual(["working", "done", "idle"]);
  });

  test("同状态内按最近活动时间倒序", () => {
    const seen = { p1: 100, p2: 300, p3: 200 };
    const sorted = orderActivity([a("p1", "idle"), a("p2", "idle"), a("p3", "idle")], seen);
    expect(sorted.map((x) => x.paneId)).toEqual(["p2", "p3", "p1"]);
  });

  test("没有记录时间的排在有时间记录的后面，且保持原序", () => {
    const seen = { p2: 500 };
    const sorted = orderActivity([a("p1", "idle"), a("p2", "idle"), a("p3", "idle")], seen);
    expect(sorted.map((x) => x.paneId)).toEqual(["p2", "p1", "p3"]);
  });

  test("状态优先于活动时间", () => {
    const seen = { p1: 9999 };
    const sorted = orderActivity([a("p1", "idle"), a("p2", "done")], seen);
    expect(sorted.map((x) => x.paneId)).toEqual(["p2", "p1"]);
  });

  test("blocked 也排在 idle 之前（需要人）", () => {
    const sorted = orderActivity([a("p1", "idle"), a("p2", "blocked")], {});
    expect(sorted.map((x) => x.paneId)).toEqual(["p2", "p1"]);
  });

  test("不修改输入数组", () => {
    const input = [a("p1", "idle"), a("p2", "working")];
    const before = input.map((x) => x.paneId);
    orderActivity(input, {});
    expect(input.map((x) => x.paneId)).toEqual(before);
  });
});
