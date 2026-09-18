import { useEffect, useState } from "react";
import { applyTheme, loadTheme, toggleTheme, type Theme } from "./theme";

/**
 * Global theme switch, pinned to the top-right of the viewport.
 *
 * It is fixed rather than placed inside each screen's header so every screen
 * gets it without threading state through the app, and so it stays put while a
 * screen scrolls.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme());

  // Apply on mount and whenever the choice changes.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      // The glyph shows the theme it switches *to*, which is what a tap does.
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme((current) => toggleTheme(current))}
    >
      <span aria-hidden="true">{isDark ? "☀" : "☾"}</span>
    </button>
  );
}
