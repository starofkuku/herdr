/*
 * The shared Markdown renderer, with the affordances ZCode's chat carries:
 * code blocks with a language label and a copy control, tables that can be
 * copied as TSV, links that open in a tab, and a copy button reusable by the
 * message header and tool cards.
 *
 * Every view that renders agent Markdown goes through here, so a block styled
 * in the conversation is styled the same in an interaction preview.
 */

import { isValidElement, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

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

/** Reads a rendered table back as TSV, cells separated by tabs. */
function tableTsv(table: HTMLTableElement | null): string {
  if (!table) return "";
  return Array.from(table.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th, td"))
        .map((cell) => (cell.textContent ?? "").replace(/\t|\n/g, " ").trim())
        .join("\t"),
    )
    .join("\n");
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

/** A table in a scroll shell, with a copy control that copies it as TSV. */
function TableShell({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLTableElement | null>(null);
  return (
    <div className="table-shell">
      <div className="table-shell-head">
        <CopyButton text={() => tableTsv(ref.current)} title="Copy table" />
      </div>
      <table ref={ref}>{children}</table>
    </div>
  );
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
