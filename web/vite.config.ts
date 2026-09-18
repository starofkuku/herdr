import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Version stamped into the built page.
 *
 * Read from the crate manifest so the UI and the binary always agree. The
 * marker matters because the page is published on its own rolling release and
 * can be updated independently of the binary: `herdr update web --check`
 * compares the marker against the published file to tell whether an update is
 * available.
 */
function uiVersion(): string {
  const manifest = readFileSync(resolve(here, "../Cargo.toml"), "utf8");
  const match = manifest.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : "0.0.0";
}

// The UI is intentionally built as one self-contained HTML file. It is served
// from disk by `herdr web` ([web] static_dir) and is never embedded in the
// herdr binary, so it can be updated or replaced independently.
export default defineConfig({
  plugins: [
    react(),
    {
      name: "herdr-ui-version-marker",
      transformIndexHtml(html) {
        // A comment rather than a meta tag: it survives minification and is
        // readable without parsing the DOM, which is all the updater needs.
        return html.replace(
          "<head>",
          `<head>\n    <!-- herdr-web-ui version: ${uiVersion()} -->`,
        );
      },
    },
    viteSingleFile(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Inline everything so the output is a single portable file.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    target: "es2020",
  },
});
