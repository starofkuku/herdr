import { describe, expect, test } from "bun:test";
import { parseRoute, routeHash, type Route } from "./route";

describe("parseRoute", () => {
  test("an empty hash is the root", () => {
    expect(parseRoute("")).toEqual({ view: "root" });
    expect(parseRoute("#")).toEqual({ view: "root" });
    expect(parseRoute("#/")).toEqual({ view: "root" });
  });

  test("one segment names a session", () => {
    expect(parseRoute("#/main")).toEqual({ view: "agents", session: "main" });
  });

  test("two segments name a conversation", () => {
    expect(parseRoute("#/main/wN:p1")).toEqual({
      view: "detail",
      session: "main",
      paneId: "wN:p1",
    });
  });

  test("round-trips a pane id containing a colon", () => {
    // Pane ids look like `wN:p1`; the separator in a route is `/`, so a colon
    // survives without special handling, but encoding must not corrupt it.
    const route: Route = { view: "detail", session: "main", paneId: "wN:p1" };
    expect(parseRoute(routeHash(route))).toEqual(route);
  });

  test("round-trips a session name needing encoding", () => {
    const route: Route = { view: "agents", session: "a b/c" };
    expect(parseRoute(routeHash(route))).toEqual(route);
  });

  test("trailing segments are ignored rather than breaking the route", () => {
    expect(parseRoute("#/main/wN:p1/extra")).toEqual({
      view: "detail",
      session: "main",
      paneId: "wN:p1",
    });
  });

  test("builds a leading-hash route for every view", () => {
    expect(routeHash({ view: "root" })).toBe("#");
    expect(routeHash({ view: "agents", session: "main" })).toBe("#/main");
    expect(routeHash({ view: "detail", session: "main", paneId: "p1" })).toBe("#/main/p1");
  });
});
