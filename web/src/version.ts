// The version of the page that is running.
//
// `web/vite.config.ts` stamps this in at build time from the crate version, or
// from `HERDR_WEB_UI_VERSION` for a frontend-only publish. It is the same marker
// `herdr update web` compares against the published file, so showing it tells
// the reader which build they are actually looking at — the page is served from
// disk and can be replaced independently of the binary, so "which binary am I
// running" and "which page am I looking at" are genuinely different questions.
//
// Declared rather than imported because vite substitutes the identifier during
// bundling. A guard keeps the module usable outside a vite build, where nothing
// defines it: tests import this file, and an unguarded reference would throw.

declare const __WEB_UI_VERSION__: string | undefined;

/** Version stamped into this build, or `unknown` when not bundled by vite. */
export const WEB_UI_VERSION: string =
  typeof __WEB_UI_VERSION__ === "undefined" ? "unknown" : __WEB_UI_VERSION__;
