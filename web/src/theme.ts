// Theme selection for the whole page.
//
// The palette lives in CSS custom properties, so switching themes is a matter
// of setting `data-theme` on the root element and letting the stylesheet pick a
// different variable set. Nothing here touches component code.

export type Theme = "dark" | "light";

const STORAGE_KEY = "herdr-web-theme";

/** Reads the stored theme, falling back to the OS preference. */
export function loadTheme(): Theme {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  // No explicit choice yet: follow the system.
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Applies a theme to the document and remembers it. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem(STORAGE_KEY, theme);
  // Lets the browser tint form controls and scrollbars to match.
  document.documentElement.style.colorScheme = theme;
}

export function toggleTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}
