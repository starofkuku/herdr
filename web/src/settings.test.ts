import { describe, expect, test } from "bun:test";
import {
  nameFromUrl,
  newBackendId,
  removeBackend,
  rememberSession,
  reconnectTarget,
  upsertBackend,
  type StoredSettings,
} from "./settings";

describe("nameFromUrl", () => {
  test("keeps host and port, which is what tells two gateways apart", () => {
    expect(nameFromUrl("ws://10.0.0.5:8787/")).toBe("10.0.0.5:8787");
    expect(nameFromUrl("wss://herdr.example.com/")).toBe("herdr.example.com");
  });

  test("drops the scheme and any path", () => {
    expect(nameFromUrl("ws://10.0.0.5:8787/some/path")).toBe("10.0.0.5:8787");
  });

  test("falls back to the whole string when there is nothing to strip", () => {
    expect(nameFromUrl("10.0.0.5:8787")).toBe("10.0.0.5:8787");
  });
});

describe("newBackendId", () => {
  test("ids are unique", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newBackendId()));
    expect(ids.size).toBe(50);
  });

  test("an id is safe to put in a hash route", () => {
    for (let index = 0; index < 20; index += 1) {
      expect(newBackendId()).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });
});

/** Two profiles, the way the screens hold them. */
function twoBackends(): StoredSettings {
  return {
    backends: [
      { id: "b1", name: "本机", url: "ws://a/", remember: true, key: "k1", session: "main" },
      { id: "b2", name: "编译机", url: "ws://b/", remember: false },
    ],
  };
}

describe("upsertBackend", () => {
  test("adds a new profile", () => {
    const next = upsertBackend(twoBackends(), {
      id: "b3",
      name: "测试机",
      url: "ws://c/",
      remember: true,
      key: "k3",
    });
    expect(next.backends.map((backend) => backend.id)).toEqual(["b1", "b2", "b3"]);
  });

  test("replaces one in place, keeping its position", () => {
    const next = upsertBackend(twoBackends(), {
      id: "b1",
      name: "本机（改）",
      url: "ws://a2/",
      remember: true,
      key: "k1",
    });
    expect(next.backends.map((backend) => backend.name)).toEqual(["本机（改）", "编译机"]);
  });
});

describe("removeBackend", () => {
  test("drops only the named one", () => {
    expect(removeBackend(twoBackends(), "b1").backends.map((b) => b.id)).toEqual(["b2"]);
  });
});

describe("rememberSession", () => {
  test("records the session per backend, not globally", () => {
    const next = rememberSession(twoBackends(), "b2", "work");
    expect(next.backends.find((b) => b.id === "b1")?.session).toBe("main");
    expect(next.backends.find((b) => b.id === "b2")?.session).toBe("work");
  });

  test("an unchanged session is not written again", () => {
    const settings = twoBackends();
    expect(rememberSession(settings, "b1", "main")).toBe(settings);
  });
});

describe("reconnectTarget", () => {
  test("only a backend with a kept key can reconnect on its own", () => {
    // b2 is remembered but has no key, so it cannot be the target.
    expect(reconnectTarget(twoBackends())?.id).toBe("b1");
  });

  test("none when nothing is remembered", () => {
    const settings: StoredSettings = {
      backends: [{ id: "b1", name: "x", url: "ws://a/", remember: false, key: "k" }],
    };
    expect(reconnectTarget(settings)).toBeNull();
  });
});
