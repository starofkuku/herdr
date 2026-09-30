import { describe, expect, test } from "bun:test";
import { parseRoute, routeHash, type Route } from "./route";

describe("parseRoute", () => {
  test("an empty hash is the home screen", () => {
    expect(parseRoute("")).toEqual({ view: "home" });
    expect(parseRoute("#")).toEqual({ view: "home" });
    expect(parseRoute("#/")).toEqual({ view: "home" });
  });

  test("one segment names a backend", () => {
    expect(parseRoute("#/b-1")).toEqual({ view: "sessions", backendId: "b-1" });
  });

  test("two segments name a session on that backend", () => {
    expect(parseRoute("#/b-1/main")).toEqual({
      view: "agents",
      backendId: "b-1",
      session: "main",
    });
  });

  test("three segments name a conversation", () => {
    expect(parseRoute("#/b-1/main/wN:p1")).toEqual({
      view: "detail",
      backendId: "b-1",
      session: "main",
      paneId: "wN:p1",
    });
  });

  test("the backend is part of the identity, so it survives a round trip", () => {
    const route: Route = { view: "detail", backendId: "b-1", session: "main", paneId: "wN:p1" };
    expect(parseRoute(routeHash(route))).toEqual(route);
  });

  test("round-trips names and ids needing encoding", () => {
    const route: Route = { view: "agents", backendId: "a b", session: "x/y" };
    expect(parseRoute(routeHash(route))).toEqual(route);
  });

  test("trailing segments are ignored rather than breaking the route", () => {
    expect(parseRoute("#/b-1/main/wN:p1/extra")).toEqual({
      view: "detail",
      backendId: "b-1",
      session: "main",
      paneId: "wN:p1",
    });
  });

  test("builds a leading-hash route for every view", () => {
    expect(routeHash({ view: "home" })).toBe("#");
    expect(routeHash({ view: "sessions", backendId: "b-1" })).toBe("#/b-1");
    expect(routeHash({ view: "agents", backendId: "b-1", session: "main" })).toBe("#/b-1/main");
    expect(routeHash({ view: "detail", backendId: "b-1", session: "main", paneId: "p1" })).toBe(
      "#/b-1/main/p1",
    );
  });
});
