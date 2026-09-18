import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Environment variable that overrides the version stamped into the page.
 *
 * Needed because the UI can be published on its own, without a new herdr
 * release. The marker comes from the crate version, so a frontend-only build
 * would otherwise be stamped with the version already installed and
 * `herdr update web` would treat it as up to date. The value must start with a
 * digit and stay within `[A-Za-z0-9.+-]`, which is what the updater's marker
 * parser accepts.
 */
const VERSION_ENV = "HERDR_WEB_UI_VERSION";

/**
 * Version stamped into the built page.
 *
 * Defaults to the crate version so the UI and the binary agree. The marker
 * matters because the page is published on its own rolling release and can be
 * updated independently of the binary: `herdr update web --check` compares the
 * marker against the published file to tell whether an update is available.
 *
 * `HERDR_WEB_UI_VERSION` overrides it for a frontend-only publish. The
 * comparison in `herdr update web` is string inequality rather than ordering,
 * so any distinct value is enough to make the update install.
 */
function uiVersion(): string {
  const override = process.env[VERSION_ENV]?.trim();
  if (override) return override;

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
