import { describe, expect, test } from "bun:test";
import {
  activity,
  childRuns,
  isRunning,
  parseRuns,
  rootRuns,
  shortPath,
  type SubagentRun,
  runsByTurn,
} from "./subagents";

function run(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    run_id: "r1",
    mode: "single",
    state: "running",
    agent: "scout",
    ...overrides,
  };
}

describe("parseRuns", () => {
  test("keeps a run with the required fields", () => {
    const runs = parseRuns([{ run_id: "a", mode: "single", state: "running", agent: "scout" }]);
    expect(runs).toHaveLength(1);
    expect(runs[0].run_id).toBe("a");
  });

  test("drops entries missing a run id or agent", () => {
    const runs = parseRuns([
      { mode: "single", state: "running", agent: "scout" },
      { run_id: "b", mode: "single", state: "running" },
      { run_id: "c", mode: "single", state: "running", agent: "scout" },
    ]);
    expect(runs.map((entry) => entry.run_id)).toEqual(["c"]);
  });

  test("leaves out optional fields the extension omits", () => {
    // A finished run has no current tool, and the extension removes the keys.
    const runs = parseRuns([{ run_id: "a", state: "complete", agent: "scout" }]);
    expect(runs[0].current_tool).toBeUndefined();
    expect(runs[0].current_tool_args).toBeUndefined();
    expect(runs[0].mode).toBe("single");
  });

  test("keeps the run's tools, output, and artifacts", () => {
    const runs = parseRuns([
      {
        run_id: "a",
        state: "running",
        agent: "scout",
        tools: [{ tool: "bash", args: "find ." }],
        output: ["line one"],
        artifacts: ["a_scout_output.md"],
      },
    ]);
    expect(runs[0].tools).toEqual([{ tool: "bash", args: "find ." }]);
    expect(runs[0].output).toEqual(["line one"]);
    expect(runs[0].artifacts).toEqual(["a_scout_output.md"]);
  });

  test("drops malformed tool entries", () => {
    const runs = parseRuns([
      { run_id: "a", state: "running", agent: "scout", tools: [{ args: "no tool" }, { tool: "bash" }] },
    ]);
    expect(runs[0].tools).toEqual([{ tool: "bash", args: "" }]);
  });

  test("keeps an unknown state rather than discarding the run", () => {
    const runs = parseRuns([{ run_id: "a", state: "weird", agent: "scout" }]);
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("weird");
  });

  test("returns nothing for anything that is not a list", () => {
    for (const value of [undefined, null, "runs", {}, 7]) {
      expect(parseRuns(value)).toEqual([]);
    }
  });
});

describe("isRunning", () => {
  test("only running is running", () => {
    expect(isRunning(run({ state: "running" }))).toBe(true);
    expect(isRunning(run({ state: "complete" }))).toBe(false);
    expect(isRunning(run({ state: "stopped" }))).toBe(false);
  });
});

describe("activity", () => {
  test("shows the tool and its arguments while live", () => {
    expect(
      activity(run({ current_tool: "bash", current_tool_args: "sleep 70" })),
    ).toBe("bash sleep 70");
  });

  test("falls back to the tool alone when there are no arguments", () => {
    expect(activity(run({ current_tool: "bash" }))).toBe("bash");
  });

  test("shows the state for a finished run", () => {
    // The extension drops the tool fields once a run settles, so the state is
    // the only thing left to say.
    expect(activity(run({ state: "complete" }))).toBe("complete");
    expect(activity(run({ state: "stopped" }))).toBe("stopped");
  });
});

describe("rootRuns and childRuns", () => {
  const parent = run({ run_id: "wf", mode: "workflow" });
  const childA = run({ run_id: "a", parent_workflow_run_id: "wf" });
  const childB = run({ run_id: "b", parent_workflow_run_id: "wf" });
  const solo = run({ run_id: "solo" });

  test("children are grouped under their workflow", () => {
    const runs = [parent, childA, childB, solo];
    expect(childRuns(runs, "wf").map((entry) => entry.run_id)).toEqual(["a", "b"]);
  });

  test("a run whose parent is not present is still top level", () => {
    // The parent may have been pruned while the child is still listed, and the
    // child must not vanish from the drawer when that happens.
    const runs = [childA, solo];
    expect(rootRuns(runs).map((entry) => entry.run_id)).toEqual(["a", "solo"]);
  });

  test("a run with a parent in the list is not top level", () => {
    const runs = [parent, childA, childB, solo];
    expect(rootRuns(runs).map((entry) => entry.run_id)).toEqual(["wf", "solo"]);
  });
});

describe("shortPath", () => {
  test("keeps short paths as they are", () => {
    expect(shortPath("/tmp/a.md")).toBe("/tmp/a.md");
  });

  test("trims a long path to its tail", () => {
    expect(shortPath("/home/u/proj/sub/probe/a.md", 2)).toBe("…/probe/a.md");
  });
});

describe("runsByTurn", () => {
  const run = (id: string, startedAtMs?: number) =>
    ({
      run_id: id,
      mode: "single",
      state: "complete",
      agent: "scout",
      started_at: startedAtMs,
    }) as never;

  // Seconds, matching what the API reports for turns.
  const T1 = 1_700_000_000;
  const T2 = T1 + 600;
  const turns = [
    { turn_id: "a", started_at: T1, completed_at: T2 - 1 },
    { turn_id: "b", started_at: T2 },
  ];
  const ms = (seconds: number) => seconds * 1000;

  test("毫秒与秒的单位差异被正确处理", () => {
    const { byTurn } = runsByTurn([run("r1", ms(T1 + 10))], turns);
    expect(byTurn.get("a")?.map((r) => r.run_id)).toEqual(["r1"]);
  });

  test("落在第二轮的开始之后归到第二轮", () => {
    const { byTurn } = runsByTurn([run("r2", ms(T2 + 5))], turns);
    expect(byTurn.get("b")?.map((r) => r.run_id)).toEqual(["r2"]);
  });

  test("进行中的轮次没有结束时间，仍然收下之后的 run", () => {
    const open = [{ turn_id: "open", started_at: T2 }];
    const { byTurn } = runsByTurn([run("r3", ms(T2 + 9999))], open);
    expect(byTurn.get("open")?.length).toBe(1);
  });

  test("早于最早一轮的 run 归入 unplaced 而不是丢弃", () => {
    const { byTurn, unplaced } = runsByTurn([run("old", ms(T1 - 5000))], turns);
    expect(byTurn.size).toBe(0);
    expect(unplaced.map((r) => r.run_id)).toEqual(["old"]);
  });

  test("没有时间戳的 run 归入 unplaced", () => {
    const { unplaced } = runsByTurn([run("notime", undefined)], turns);
    expect(unplaced.map((r) => r.run_id)).toEqual(["notime"]);
  });

  test("同一轮的多个 run 全部保留且顺序不变", () => {
    const { byTurn } = runsByTurn([run("x", ms(T1 + 1)), run("y", ms(T1 + 2))], turns);
    expect(byTurn.get("a")?.map((r) => r.run_id)).toEqual(["x", "y"]);
  });

  test("没有 turn 时全部 unplaced", () => {
    const { byTurn, unplaced } = runsByTurn([run("z", ms(T1))], []);
    expect(byTurn.size).toBe(0);
    expect(unplaced.length).toBe(1);
  });
});
