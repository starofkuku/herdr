import { describe, expect, test } from "bun:test";
import { pickBindableSession } from "./backends";
import type { SessionSummary } from "./gateway";

const session = (name: string, running: boolean): SessionSummary => ({
  name,
  running,
  default: false,
});

describe("pickBindableSession", () => {
  test("a session that is not running is never chosen", () => {
    // Binding it would start its server, which a page load must not do.
    expect(pickBindableSession([session("idle-one", false)], undefined)).toBeNull();
  });

  test("nothing running means nothing to bind", () => {
    expect(
      pickBindableSession([session("a", false), session("b", false)], "a"),
    ).toBeNull();
  });

  test("the reader's last session wins when it is running", () => {
    const sessions = [session("first", true), session("mine", true)];
    expect(pickBindableSession(sessions, "mine")).toBe("mine");
  });

  test("a preferred session that is not running falls back to a running one", () => {
    const sessions = [session("mine", false), session("other", true)];
    expect(pickBindableSession(sessions, "other")).toBe("other");
    expect(pickBindableSession(sessions, "mine")).toBe("other");
  });

  test("with no preference, the first running session is used", () => {
    const sessions = [session("stopped", false), session("live", true), session("also", true)];
    expect(pickBindableSession(sessions, undefined)).toBe("live");
  });

  test("an unknown preference does not block the fallback", () => {
    expect(pickBindableSession([session("live", true)], "gone")).toBe("live");
  });
});
