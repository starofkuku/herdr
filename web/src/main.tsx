import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("missing #root container");
}

// The theme switch renders inside each screen's header rather than here, so it
// lines up with that screen's own controls.
createRoot(container).render(<App />);
