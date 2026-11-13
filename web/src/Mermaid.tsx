/**
 * A ```mermaid block, drawn.
 *
 * Diagrams arrive as source, and source is what a reader usually wants to copy
 * — so the picture is offered beside it rather than instead of it: the block
 * opens as the diagram, and one press shows the text it came from.
 *
 * Mermaid renders whatever the model wrote, which is untrusted input. Its
 * `strict` security level is what keeps that input from reaching the page as
 * HTML or a script: labels are escaped and clicks disabled, so a hostile
 * diagram can at worst draw something wrong.
 */
import { useEffect, useRef, useState } from "react";
import { Code2, Image as ImageIcon } from "lucide-react";

/** One id per render call: mermaid keys its output element by id. */
let sequence = 0;

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

let loading: Promise<MermaidApi> | null = null;

/**
 * Where the mermaid build sits beside the page.
 *
 * It is served from this origin rather than from a CDN: a diagram is drawn from
 * a conversation's own text, and sending the reader to a third party to draw it
 * would leak that text to someone else. The path is resolved against the
 * document so a gateway behind a prefix still finds it.
 */
const MERMAID_URL = new URL("mermaid/mermaid.esm.min.mjs", document.baseURI).href;

/**
 * Loads mermaid once, on first use.
 *
 * It is a large dependency — megabytes, none of which a conversation without a
 * diagram needs — so it is fetched only when a diagram appears, and the entry
 * module then pulls just the diagram kinds it is asked to draw. `@vite-ignore`
 * is what keeps the bundler from inlining it back into the page.
 */
function loadMermaid(): Promise<MermaidApi> {
  loading ??= import(/* @vite-ignore */ MERMAID_URL).then((module) => {
    const api = module.default as unknown as MermaidApi;
    api.initialize({
      startOnLoad: false,
      // Untrusted source: no HTML labels, no click handlers, no scripts.
      securityLevel: "strict",
      theme: "dark",
      fontFamily: "inherit",
      flowchart: { htmlLabels: false },
    });
    return api;
  });
  return loading;
}

export function MermaidDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState("");
  const [problem, setProblem] = useState("");
  const [showSource, setShowSource] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const text = source.trim();
    if (!text) return;
    void loadMermaid()
      .then((api) => api.render(`mermaid-${(sequence += 1)}`, text))
      .then(({ svg: drawn }) => {
        if (alive.current) {
          setSvg(drawn);
          setProblem("");
        }
      })
      .catch((error: unknown) => {
        if (!alive.current) return;
        // A diagram the parser cannot read is shown as the code it was, with
        // the reason above it, rather than as an empty box.
        setSvg("");
        setProblem(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive.current = false;
    };
  }, [source]);

  return (
    <div className="mermaid-block">
      <div className="code-block-head">
        <span className="code-lang">mermaid</span>
        <button
          type="button"
          className="copy-btn"
          title={showSource ? "查看图形" : "查看源码"}
          aria-label={showSource ? "查看图形" : "查看源码"}
          onClick={() => setShowSource((value) => !value)}
        >
          {showSource ? <ImageIcon size={13} aria-hidden="true" /> : <Code2 size={13} aria-hidden="true" />}
        </button>
      </div>
      {showSource || problem ? (
        <>
          {problem ? <p className="mermaid-block__problem">无法渲染：{problem}</p> : null}
          <pre className="mermaid-block__source">{source}</pre>
        </>
      ) : svg ? (
        // The SVG comes from mermaid itself under `strict`, which escapes every
        // label and refuses scripts: this is the library's own output, not
        // arbitrary HTML from the message.
        <div className="mermaid-block__diagram" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <p className="mermaid-block__pending">正在渲染图形…</p>
      )}
    </div>
  );
}
