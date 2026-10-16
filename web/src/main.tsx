import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, loadTheme } from "./theme";
import "./styles.css";
import "./tailwind.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("missing #root container");
}

// The saved theme is applied before the first render: every screen carries its
// own switch, but a fresh tab that lands on a screen without one — a link to a
// tool page, say — would otherwise start on the dark default instead of the
// reader's choice.
applyTheme(loadTheme());

createRoot(container).render(<App />);
