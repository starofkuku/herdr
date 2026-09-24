import { describe, expect, test } from "bun:test";
import type { AgentView } from "./api";
import { matchAgents } from "./command-search";

const agent = (over: Partial<AgentView>): AgentView =>
  ({
    paneId: "wN:p1",
    workspaceId: "w1",
    label: "pi",
    agent: "pi",
    status: "idle",
    project: "herdr",
    cwd: "/home/administrator/githubwork/herdr",
    ...over,
  }) as AgentView;

const agents = [
  agent({ paneId: "wN:p1", label: "pi", cwd: "/home/administrator/githubwork/herdr" }),
  agent({ paneId: "wP:p1", label: "pi", cwd: "/home/administrator/githubwork/codex-trace" }),
  agent({ paneId: "w11:p3", label: "pi", cwd: "/var/ftp/pub/tmp" }),
  agent({ paneId: "w14:p1", label: "codex", agent: "codex", cwd: "/home/administrator/githubwork/pi-web" }),
];

describe("matchAgents", () => {
  test("空查询返回全部，顺序不变", () => {
    expect(matchAgents(agents, "").map((a) => a.paneId)).toEqual([
      "wN:p1",
      "wP:p1",
      "w11:p3",
      "w14:p1",
    ]);
    expect(matchAgents(agents, "   ").length).toBe(4);
  });

  test("子序列匹配：hrdr 能命中 herdr", () => {
    const hit = matchAgents(agents, "hrdr");
    expect(hit[0]?.cwd).toContain("herdr");
  });

  test("按名称匹配", () => {
    const hit = matchAgents(agents, "codex");
    expect(hit[0]?.paneId).toBe("w14:p1");
  });

  test("名称匹配优先于路径匹配", () => {
    // `pi` 是三个 pane 的 label；pi-web 的路径里也有 "pi"，但它是 codex 的目录。
    const hit = matchAgents(agents, "pi");
    expect(hit[0]?.label).toBe("pi");
    // codex 那个只能靠 cwd 命中，排在有名称匹配的后面。
    expect(hit[hit.length - 1]?.paneId).toBe("w14:p1");
  });

  test("匹配不到返回空", () => {
    expect(matchAgents(agents, "zzzzz")).toEqual([]);
  });

  test("大小写与分隔符不影响匹配", () => {
    expect(matchAgents(agents, "GITHUBWORK").length).toBe(3);
    expect(matchAgents(agents, "ftp/pub/tmp")[0]?.paneId).toBe("w11:p3");
    expect(matchAgents(agents, "ftp pub tmp")[0]?.paneId).toBe("w11:p3");
  });

  test("紧凑的匹配排在分散的匹配前面", () => {
    const tight = agent({ paneId: "a", label: "abcd", cwd: "/x" });
    const loose = agent({ paneId: "b", label: "a-b-c-d", cwd: "/x" });
    const hit = matchAgents([loose, tight], "abcd");
    expect(hit[0]?.paneId).toBe("a");
  });

  test("pane id 也可以搜", () => {
    expect(matchAgents(agents, "w14")[0]?.paneId).toBe("w14:p1");
  });

  test("不改动输入数组", () => {
    const before = agents.map((a) => a.paneId);
    matchAgents(agents, "pi");
    expect(agents.map((a) => a.paneId)).toEqual(before);
  });
});