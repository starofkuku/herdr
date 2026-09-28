/*
 * The shared Markdown renderer, with the affordances ZCode's chat carries:
 * code blocks with a language label and a copy control, tables that can be
 * copied as TSV, links that open in a tab, and a copy button reusable by the
 * message header and tool cards.
 *
 * Every view that renders agent Markdown goes through here, so a block styled
 * in the conversation is styled the same in an interaction preview.
 */

import { isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { Check, Copy, Download, Maximize2 } from "lucide-react";

/**
 * Copies text, falling back to a hidden-field copy when the clipboard API is
 * unavailable.
 *
 * The page is served over plain HTTP on LAN addresses, where `navigator
 * .clipboard` is withheld as an insecure context. The fallback keeps copy
 * working there; it is deprecated but universal.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the field path; the API can also reject on permission.
    }
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(field);
  }
}

/** The label a copy control shows while its copy is confirmed. */
const COPIED_MS = 1500;

/**
 * A copy affordance in the ZCode style: a quiet icon that confirms with a
 * check, rather than a labelled button competing with the content it copies.
 */
export function CopyButton({
  text,
  title = "Copy",
}: {
  /** Either the text itself, or a reader called at click time. */
  text: string | (() => string);
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  const onCopy = async () => {
    try {
      await copyText(typeof text === "function" ? text() : text);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // A copy that fails leaves the button as it was; the reader can retry.
    }
  };

  return (
    <button
      type="button"
      className={`copy-btn${copied ? " copied" : ""}`}
      title={copied ? "Copied" : title}
      aria-label={copied ? "Copied" : title}
      onClick={() => void onCopy()}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

/** Collects the text of an element tree, the way a copy of the block reads. */
function textFromChildren(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromChildren).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return textFromChildren(props.children);
  }
  return "";
}

/** Reads a rendered table back as rows of trimmed cell text. */
function tableRows(table: HTMLTableElement | null): string[][] {
  if (!table) return [];
  return Array.from(table.querySelectorAll("tr")).map((row) =>
    Array.from(row.querySelectorAll("th, td")).map((cell) => (cell.textContent ?? "").trim()),
  );
}

/** The table as a Markdown table, header row and separator included. */
function tableMarkdown(table: HTMLTableElement | null): string {
  const rows = tableRows(table);
  if (rows.length === 0) return "";
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const separator = `| ${rows[0].map(() => "---").join(" | ")} |`;
  return [line(rows[0]), separator, ...rows.slice(1).map(line)].join("\n");
}

/** One CSV field: quoted when it carries a comma, quote, or newline. */
function csvField(value: string): string {
  return /[",\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

/** The table as CSV, one line per row. */
function tableCsv(table: HTMLTableElement | null): string {
  return tableRows(table)
    .map((cells) => cells.map(csvField).join(","))
    .join("\n");
}

/** Hands a text file to the browser's downloader. */
function downloadText(name: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * A table with the controls ZCode gives one: a toolbar above the frame —
 * copy as Markdown, download as CSV, and a preview that lifts the table out of
 * the flow — with the body scrolling sideways inside its own shell.
 */
function TableShell({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLTableElement | null>(null);
  const [preview, setPreview] = useState(false);
  // Esc closes the preview, the way every other overlay here does.
  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [preview]);
  return (
    <>
      <div className="table-tools">
        <CopyButton text={() => tableMarkdown(ref.current)} title="复制为 Markdown" />
        <button
          type="button"
          className="copy-btn"
          title="下载 CSV"
          aria-label="下载 CSV"
          onClick={() => downloadText("table.csv", tableCsv(ref.current), "text/csv")}
        >
          <Download size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="copy-btn"
          title="放大预览"
          aria-label="放大预览"
          onClick={() => setPreview(true)}
        >
          <Maximize2 size={13} aria-hidden="true" />
        </button>
      </div>
      <div className="table-shell">
        <table ref={ref}>{children}</table>
      </div>
      {preview ? (
        <div
          className="table-overlay"
          role="dialog"
          aria-label="表格预览"
          onClick={() => setPreview(false)}
        >
          <div className="table-overlay-panel">
            <table>{children}</table>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * A fenced code block: a header carrying the language and the copy control,
 * then the code itself.
 *
 * `rehype-highlight` has already replaced the code's text with token spans,
 * so the original element is rendered rather than rebuilt — only its chrome is
 * added around it.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const code =
    isValidElement(children) ? (children as ReactElementWithCode) : null;
  const className: unknown = code?.props?.className;
  const language =
    typeof className === "string" ? (/language-([\w+-]+)/.exec(className)?.[1] ?? "") : "";
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-lang">{language || "text"}</span>
        <CopyButton text={() => textFromChildren(children).replace(/\n$/, "")} title="Copy code" />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/** Anything `isValidElement` returns that we read `props.className` off. */
interface ReactElementWithCode {
  props?: { className?: unknown; children?: ReactNode };
}

/** Renders Markdown with the shared blocks and affordances. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: CodeBlock,
          table: TableShell,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
