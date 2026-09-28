/*
 * File-type icons for rows that name a file.
 *
 * The glyphs are a subset of the Material Icon Theme (MIT,
 * github.com/PKief/vscode-material-icon-theme) vendored under `./file-icons`
 * and inlined into the single-file build as data URIs. The extension and
 * file-name aliases mirror ZCode's resolver, so the same file gets the same
 * icon here as it does there.
 */

const rawIcons = import.meta.glob("./file-icons/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const iconByName = new Map<string, string>();
for (const [path, svg] of Object.entries(rawIcons)) {
  const name = path.slice(path.lastIndexOf("/") + 1, -".svg".length);
  iconByName.set(name, `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

/** Extension → icon, using the material theme's own names. */
const EXTENSION_ICONS: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "react_ts",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "react",
  vue: "vue",
  svelte: "svelte",
  css: "css",
  html: "html",
  htm: "html",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  sh: "console",
  zsh: "console",
  bash: "console",
  sql: "database",
  db: "database",
  lock: "lock",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  pdf: "pdf",
};

/** Whole-file names that beat the extension: lockfiles, dockerfiles, readmes. */
const FILE_NAME_ICONS: Record<string, string> = {
  dockerfile: "docker",
  makefile: "makefile",
  "cargo.lock": "lock",
  "cargo.toml": "rust",
  "bun.lock": "lock",
  "package-lock.json": "lock",
  "pnpm-lock.yaml": "lock",
  "yarn.lock": "lock",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  readme: "document",
  license: "document",
};

/** Splits a path into the leaf name and the directory shown after it. */
export function splitFilePath(path: string): { name: string; dir: string } {
  const normalized = path.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1
    ? { name: normalized, dir: "" }
    : { name: normalized.slice(slash + 1), dir: normalized.slice(0, slash) };
}

/** The data URI for a path's file icon, or null when nothing matches. */
export function fileIconDataUri(path: string): string | null {
  const { name } = splitFilePath(path);
  const lower = name.toLowerCase();
  const byFileName = FILE_NAME_ICONS[lower];
  if (byFileName) return iconByName.get(byFileName) ?? null;
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return iconByName.get("document") ?? null;
  const extension = lower.slice(dot + 1);
  return iconByName.get(EXTENSION_ICONS[extension] ?? "document") ?? null;
}

/**
 * Whether a subject reads as a file path rather than a command or a query.
 *
 * A shell command or a search pattern almost always contains whitespace; a
 * path does not, and the rows that name files are the ones where the icon and
 * the name/directory split are wanted.
 */
export function looksLikeFilePath(subject: string): boolean {
  if (!subject || /\s/u.test(subject)) return false;
  return subject.includes("/") || subject.startsWith(".") || /\.[a-z0-9]+$/iu.test(subject);
}
