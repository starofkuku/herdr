import { describe, expect, test } from "bun:test";
import { fenceFor, isMarkdownPath, languageForPath } from "./FilePreview";

describe("isMarkdownPath", () => {
  test("markdown extensions render as Markdown", () => {
    for (const path of ["README.md", "docs/next/CHANGELOG.markdown", "page.mdx"]) {
      expect(isMarkdownPath(path)).toBe(true);
    }
  });

  test("source files do not", () => {
    for (const path of ["src/main.rs", "a.ts", "b.json", "Makefile", "x.txt"]) {
      expect(isMarkdownPath(path)).toBe(false);
    }
  });

  test("the extension is matched case-insensitively", () => {
    expect(isMarkdownPath("README.MD")).toBe(true);
  });
});

describe("languageForPath", () => {
  test("maps the languages worth colouring", () => {
    expect(languageForPath("src/main.rs")).toBe("rust");
    expect(languageForPath("app.tsx")).toBe("typescript");
    expect(languageForPath("Cargo.toml")).toBe("ini");
    expect(languageForPath("run.sh")).toBe("bash");
  });

  test("an unknown extension has no language, so the block stays unlabelled", () => {
    expect(languageForPath("notes.xyz")).toBeUndefined();
    expect(languageForPath("LICENSE")).toBeUndefined();
  });
});

describe("fenceFor", () => {
  test("wraps content in a fence carrying the language", () => {
    expect(fenceFor("fn main() {}", "rust")).toBe("```rust\nfn main() {}\n```");
  });

  test("no language still produces a valid fence", () => {
    expect(fenceFor("plain", undefined)).toBe("```\nplain\n```");
  });

  test("a file containing a fence is still wrapped in a longer one", () => {
    const content = "```js\nnested\n```";
    const fenced = fenceFor(content, "markdown");
    // The opening fence must be longer than the run inside, or the block ends early.
    expect(fenced.startsWith("````markdown\n")).toBe(true);
    expect(fenced.endsWith("\n````")).toBe(true);
  });

  test("an empty file renders as an empty block, not as a broken one", () => {
    expect(fenceFor("", "txt")).toBe("```txt\n\n```");
  });
});
