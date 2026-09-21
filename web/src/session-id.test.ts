import { describe, expect, test } from "bun:test";
import { agentsFromSnapshot } from "./api";

// One agent record as the snapshot reports it, so the test exercises the same
// path the UI does rather than a helper in isolation.
function snapshot(agentSession: Record<string, unknown> | undefined) {
  return {
    agents: [
      {
        pane_id: "w1:p1",
        workspace_id: "w1",
        agent: "pi",
        agent_status: "idle",
        cwd: "/home/u/project",
        ...(agentSession ? { agent_session: agentSession } : {}),
      },
    ],
    workspaces: [{ workspace_id: "w1", label: "project" }],
  };
}

function only(session: Record<string, unknown> | undefined) {
  const { agents, workspaces } = snapshot(session);
  return agentsFromSnapshot(agents, workspaces)[0];
}

const PATH =
  "/home/u/.pi/agent/sessions/--home-u-project--/2026-09-20T15-54-43-912Z_01a0bf86-e547-758c-a392-9dc546a748fd.jsonl";

describe("session id", () => {
  test("keeps a session the agent named by id", () => {
    expect(only({ kind: "id", value: "01a0bf86-e547" }).sessionId).toBe("01a0bf86-e547");
  });

  test("derives the id from a transcript path's file name", () => {
    // The file is named after the session, so the stem is the identifier the
    // agent itself would print. The directory says more about this machine's
    // layout than about the session.
    expect(only({ kind: "path", value: PATH }).sessionId).toBe(
      "2026-09-20T15-54-43-912Z_01a0bf86-e547-758c-a392-9dc546a748fd",
    );
  });

  test("leaves the transcript path visible as well", () => {
    // The id is derived, not a replacement: a reader may still want the file.
    expect(only({ kind: "path", value: PATH }).transcriptPath).toBe(PATH);
  });

  test("keeps a path that is not a jsonl transcript", () => {
    // Nothing guarantees the name has the extension, and trimming a suffix that
    // is not there would corrupt the id.
    expect(only({ kind: "path", value: "/tmp/sessions/abc" }).sessionId).toBe("abc");
  });

  test("reports nothing when the agent published no session", () => {
    expect(only(undefined).sessionId).toBeUndefined();
  });

  test("reports nothing for an unrecognised kind", () => {
    expect(only({ kind: "something-else", value: "x" }).sessionId).toBeUndefined();
  });

  test("reports nothing when the value is empty", () => {
    expect(only({ kind: "id", value: "" }).sessionId).toBeUndefined();
    expect(only({ kind: "path", value: "" }).sessionId).toBeUndefined();
  });
});
