import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import {
  customCommandSummary,
  loadCustomCommands,
  normalizeCustomCommandName,
  saveCustomCommands,
} from "./customCommands";

// The storage layer talks to `window.localStorage`; the test runtime has no
// DOM, so a map stands in for it.
const store = new Map<string, string>();
beforeAll(() => {
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
});

describe("custom command names", () => {
  test("a typed name loses its slash, spaces, and case", () => {
    expect(normalizeCustomCommandName("/Deploy Check")).toBe("deploy-check");
    expect(normalizeCustomCommandName("  git  status ")).toBe("git-status");
    expect(normalizeCustomCommandName("ok")).toBe("ok");
  });

  test("a name made only of slashes and spaces is empty", () => {
    expect(normalizeCustomCommandName("/ / ")).toBe("");
  });
});

describe("custom command summaries", () => {
  test("the first line stands for the whole text", () => {
    expect(customCommandSummary("one\ntwo")).toBe("one");
  });

  test("a long first line is cut with an ellipsis", () => {
    expect(customCommandSummary("x".repeat(80))).toBe(`${"x".repeat(60)}…`);
  });
});

describe("custom command storage", () => {
  afterEach(() => {
    window.localStorage.removeItem("herdr-custom-commands");
  });

  test("saved commands load back", () => {
    saveCustomCommands([{ name: "deploy", content: "ship it" }]);
    expect(loadCustomCommands()).toEqual([{ name: "deploy", content: "ship it" }]);
  });

  test("entries without a name or content are dropped on load", () => {
    window.localStorage.setItem(
      "herdr-custom-commands",
      JSON.stringify([
        { name: "ok", content: "fine" },
        { name: "", content: "no name" },
        { name: "no-content", content: "  " },
        "not an object",
      ]),
    );
    expect(loadCustomCommands()).toEqual([{ name: "ok", content: "fine" }]);
  });

  test("a broken payload loads as an empty list, not an error", () => {
    window.localStorage.setItem("herdr-custom-commands", "{not json");
    expect(loadCustomCommands()).toEqual([]);
  });
});
