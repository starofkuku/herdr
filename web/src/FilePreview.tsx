import { useEffect, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { CopyButton, Markdown } from "./Markdown";
import { loadFileContent, type FileContent } from "./files";

interface FilesClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/**
 * Extension to highlight.js language, for the languages worth colouring.
 *
 * Only the names highlight.js actually knows are listed; anything else falls
 * back to an unlabelled block, which renders as plain text rather than as a
 * mislabelled one.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  svelte: "xml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  dart: "dart",
  lua: "lua",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  sql: "sql",
  dockerfile: "dockerfile",
  makefile: "makefile",
  gradle: "groovy",
  diff: "diff",
  patch: "diff",
};

/** Whether a path should be rendered as Markdown rather than as source. */
export function isMarkdownPath(path: string): boolean {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  return name.endsWith(".md") || name.endsWith(".markdown") || name.endsWith(".mdx");
}

/** The highlight.js language for a path, when one is known. */
export function languageForPath(path: string): string | undefined {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (LANGUAGE_BY_EXTENSION[name]) return LANGUAGE_BY_EXTENSION[name];
  const dot = name.lastIndexOf(".");
  if (dot === -1) return LANGUAGE_BY_EXTENSION[name] ?? undefined;
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1)];
}

/**
 * Fences a file so the conversation's own renderer can display it.
 *
 * The fence is longer than any run of backticks in the file, which is what
 * keeps a file that itself contains ``` from ending the block early.
 */
export function fenceFor(content: string, language?: string): string {
  let longest = 0;
  for (const match of content.matchAll(/`{3,}/g)) {
    longest = Math.max(longest, match[0].length);
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  // A language with no newline after the fence is not a language; the trailing
  // newline is what makes an empty file render as an empty block.
  const info = language ?? "";
  return `${fence}${info}\n${content}\n${fence}`;
}

/** Bytes, in the units a reader thinks in. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One file's text, rendered for reading.
 *
 * Shared by the docked panel and the full-screen view: two copies would be two
 * things to keep in step, and this branch carries a decision — which language,
 * which renderer — that should not be made twice.
 */
function FileBody({ path, file }: { path: string; file: FileContent }) {
  if (file.binary) return <p className="file-tree__note">二进制文件，无法预览</p>;
  if (file.tooLarge) {
    return <p className="file-tree__note">文件过大（{formatSize(file.size)}），无法预览</p>;
  }
  return (
    <>
      {/*
        Both branches go through the conversation's renderer: Markdown as
        Markdown, anything else fenced so it picks up the highlighter, the
        language label, and the block's own copy control.
      */}
      {isMarkdownPath(path) ? (
        <div className="file-preview__markdown">
          <Markdown text={file.content} />
        </div>
      ) : (
        <div className="file-preview__code">
          <Markdown text={fenceFor(file.content, languageForPath(path))} />
        </div>
      )}
      {file.truncated ? <p className="file-tree__note">内容已截断</p> : null}
    </>
  );
}

/** The header a file shows in either size: identity, then the controls. */
function FileHead({
  path,
  file,
  showText,
  fullscreen,
  onToggleFullscreen,
  onClose,
}: {
  path: string;
  file: FileContent | null;
  showText: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onClose: () => void;
}) {
  const name = path.split("/").pop() ?? path;
  return (
    <header className="file-preview__head">
      <span className="file-preview__name" title={path}>
        {name}
      </span>
      <span className="file-preview__path">{path}</span>
      {file ? <span className="file-preview__size">{formatSize(file.size)}</span> : null}
      {showText && file ? <CopyButton text={file.content} title="复制内容" /> : null}
      {/*
        Reading a file the panel is too narrow for, without losing the place in
        the conversation behind it.
      */}
      <button
        type="button"
        className="file-preview__expand"
        aria-label={fullscreen ? "退出全屏" : "全屏查看"}
        title={fullscreen ? "退出全屏 (Esc)" : "全屏查看"}
        onClick={onToggleFullscreen}
      >
        {fullscreen ? (
          <Minimize2 size={14} aria-hidden="true" />
        ) : (
          <Maximize2 size={14} aria-hidden="true" />
        )}
      </button>
      <button type="button" className="file-preview__close" onClick={onClose} aria-label="关闭">
        ×
      </button>
    </header>
  );
}

/** The file's contents, or why there are none to show. */
function FilePane({ path, file, loading }: { path: string; file: FileContent | null; loading: boolean }) {
  return (
    <div className="file-preview__body">
      {loading ? (
        <p className="file-tree__note">读取中…</p>
      ) : file === null ? (
        <p className="file-tree__note">无法读取这个文件</p>
      ) : (
        <FileBody path={path} file={file} />
      )}
    </div>
  );
}

/**
 * One file's contents, read-only, docked to the right of the conversation.
 *
 * Markdown is rendered as Markdown and source is rendered as a highlighted
 * code block — both through the same renderer the conversation uses, so a file
 * reads exactly like the same content would inside a message. The panel takes
 * half the width, which is ZCode's own split for a side-by-side editor.
 *
 * It can also fill the window, for a file that needs more room than half of a
 * narrow one. The full-screen view is a sibling of the panel rather than a
 * replacement, so stepping back out restores the panel exactly as it was —
 * including how far down the reader had scrolled.
 *
 * Binary and oversized files say so instead of showing garbage: the API refuses
 * to send their bytes, and pretending otherwise would be worse than the note.
 */
export function FilePreview({
  client,
  paneId,
  path,
  onClose,
}: {
  client: FilesClient;
  paneId: string;
  path: string;
  onClose: () => void;
}) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(true);
  /** Whether the file is filling the window rather than the docked panel. */
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadFileContent(client, paneId, path).then((result) => {
      if (!cancelled) {
        setFile(result);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, paneId, path]);

  /*
   * Esc leaves the full-screen view first, and only closes the preview when
   * there is nothing left to step out of — the order every other layered
   * overlay here uses, so one key never does two things at once.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (fullscreen) setFullscreen(false);
      else onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, fullscreen]);

  const showText = file !== null && !file.binary && !file.tooLarge;
  const head = {
    path,
    file,
    showText,
    onClose,
  };

  return (
    <>
      <aside className="file-preview" role="dialog" aria-label={`文件 ${path}`}>
        <FileHead
          {...head}
          fullscreen={false}
          onToggleFullscreen={() => setFullscreen(true)}
        />
        <FilePane path={path} file={file} loading={loading} />
      </aside>

      {fullscreen ? (
        <div
          className="file-fullscreen"
          role="dialog"
          aria-modal="true"
          aria-label={`文件 ${path}`}
        >
          {/* A press anywhere outside steps back to the panel, as every other
              overlay here dismisses. */}
          <button
            type="button"
            className="file-fullscreen__scrim"
            onClick={() => setFullscreen(false)}
            aria-label="退出全屏"
          />
          <div className="file-fullscreen__panel">
            <FileHead
              {...head}
              fullscreen
              onToggleFullscreen={() => setFullscreen(false)}
            />
            <FilePane path={path} file={file} loading={loading} />
          </div>
        </div>
      ) : null}
    </>
  );
}
