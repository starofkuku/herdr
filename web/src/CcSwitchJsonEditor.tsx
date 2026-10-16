/*
 * The JSON editor for a provider's settings: CodeMirror with the JSON language
 * and its parse linter, so a broken document is underlined where it breaks
 * instead of waiting for the save button to say "not valid JSON".
 *
 * The theme follows the page's own choice by watching `data-theme` on the root —
 * the app applies themes imperatively, so there is no store to subscribe to.
 */

import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";

export function CcSwitchJsonEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== "light");

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.dataset.theme !== "light"));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={dark ? "dark" : "light"}
      extensions={[json(), linter(jsonParseLinter()), lintGutter()]}
      height="100%"
      style={{ height: "100%" }}
      basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: true }}
    />
  );
}
