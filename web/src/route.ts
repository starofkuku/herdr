// Addressable views for the web UI.
//
// Everything used to live in component state, so a refresh dropped the reader
// back on the connect screen and a conversation could not be linked to. The
// route is now the source of truth for which session and pane are open.
//
// Hash-based rather than path-based: the page is a single self-contained file
// served by the gateway, so there is no server to rewrite `/main/wN:p1` onto it,
// and a path route would 404 on reload. A hash keeps the whole route on the
// client and needs no gateway change.
//
// Shapes:
//   #                      connect / pick a session
//   #/<session>            that session's agent list
//   #/<session>/<paneId>   one agent's conversation

/** One parsed route. */
export type Route =
  | { view: "root" }
  | { view: "agents"; session: string }
  | { view: "detail"; session: string; paneId: string };

/**
 * Parses a hash into a route.
 *
 * Anything unrecognised resolves to the root rather than erroring, so a
 * hand-edited or truncated URL lands somewhere usable instead of a blank page.
 */
export function parseRoute(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const segments = raw.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 0) return { view: "root" };
  const [session] = segments;
  if (!session) return { view: "root" };
  if (segments.length === 1) return { view: "agents", session };
  const paneId = segments[1];
  if (!paneId) return { view: "agents", session };
  // Extra segments are ignored: only the first two are meaningful, and a URL
  // with trailing junk should still open the conversation it names.
  return { view: "detail", session, paneId };
}

/** Builds the hash for a route, always with a leading `#`. */
export function routeHash(route: Route): string {
  switch (route.view) {
    case "root":
      return "#";
    case "agents":
      return `#/${encodeURIComponent(route.session)}`;
    case "detail":
      return `#/${encodeURIComponent(route.session)}/${encodeURIComponent(route.paneId)}`;
  }
}

/**
 * Writes a route to the address bar.
 *
 * `pushState` is used for the in-app steps a reader would expect Back to undo
 * (opening a conversation, going back to the list), so the browser Back button
 * moves through the app instead of leaving it.
 */
export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const next = routeHash(route);
  if (window.location.hash === next) return;
  if (options.replace) {
    window.history.replaceState(null, "", next);
  } else {
    window.history.pushState(null, "", next);
  }
}

/** The route currently in the address bar. */
export function currentRoute(): Route {
  if (typeof window === "undefined") return { view: "root" };
  return parseRoute(window.location.hash);
}
