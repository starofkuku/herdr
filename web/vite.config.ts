import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// The UI is intentionally built as one self-contained HTML file. It is served
// from disk by `herdr web` ([web] static_dir) and is never embedded in the
// herdr binary, so it can be updated or replaced independently.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Inline everything so the output is a single portable file.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    target: "es2020",
  },
});
