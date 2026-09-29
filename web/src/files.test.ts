import { describe, expect, test } from "bun:test";
import {
  aggregateDirectoryStatus,
  gitStatusMark,
  loadDirectory,
  loadGitStatus,
  loadFileContent,
  parentPaths,
  type GitFileStatus,
} from "./files";

/** A client that answers with the given response, or rejects. */
function clientReturning(response: unknown) {
  return {
    call: <T,>(_method: string, _params?: Record<string, unknown>) =>
      Promise.resolve(response as T),
  };
}

function clientFailing() {
  return {
    call: <T,>(_method: string, _params?: Record<string, unknown>) =>
      Promise.reject(new Error("network")) as Promise<T>,
  };
}

describe("loadDirectory", () => {
  test("parses entries and keeps directories and files alike", async () => {
    const listing = await loadDirectory(
      clientReturning({
        files: {
          root: "/repo",
          path: "src",
          entries: [
            { name: "app", path: "src/app", kind: "dir" },
            { name: "main.rs", path: "src/main.rs", kind: "file" },
          ],
        },
      }),
      "pane-1",
      "src",
    );
    expect(listing?.root).toBe("/repo");
    expect(listing?.entries.map((entry) => entry.kind)).toEqual(["dir", "file"]);
  });

  test("drops entries with no usable name or path", async () => {
    const listing = await loadDirectory(
      clientReturning({
        files: { root: "/repo", path: "", entries: [{ name: "", path: "x" }, { name: "ok", path: "ok" }] },
      }),
      "pane-1",
      "",
    );
    expect(listing?.entries.map((entry) => entry.name)).toEqual(["ok"]);
  });

  test("an unknown kind is treated as a file", async () => {
    const listing = await loadDirectory(
      clientReturning({ files: { root: "/repo", path: "", entries: [{ name: "x", path: "x" }] } }),
      "pane-1",
      "",
    );
    expect(listing?.entries[0].kind).toBe("file");
  });

  test("a failed call resolves to null instead of rejecting", async () => {
    expect(await loadDirectory(clientFailing(), "pane-1", "")).toBeNull();
  });
});

describe("loadFileContent", () => {
  test("carries the text and its flags", async () => {
    const file = await loadFileContent(
      clientReturning({
        file: { path: "a.txt", content: "hi", truncated: false, binary: false, too_large: false, size: 2 },
      }),
      "pane-1",
      "a.txt",
    );
    expect(file).toEqual({
      path: "a.txt",
      content: "hi",
      truncated: false,
      binary: false,
      tooLarge: false,
      size: 2,
    });
  });

  test("a binary file is reported without content", async () => {
    const file = await loadFileContent(
      clientReturning({
        file: { path: "logo.png", content: "", binary: true, too_large: false, truncated: false, size: 900 },
      }),
      "pane-1",
      "logo.png",
    );
    expect(file?.binary).toBe(true);
    expect(file?.content).toBe("");
  });

  test("a failed call resolves to null", async () => {
    expect(await loadFileContent(clientFailing(), "pane-1", "a.txt")).toBeNull();
  });
});

describe("loadGitStatus", () => {
  test("indexes changed files by path", async () => {
    const status = await loadGitStatus(
      clientReturning({
        status: {
          available: true,
          repo_root: "/repo",
          branch: "main",
          files: [
            { path: "src/a.rs", status: "modified" },
            { path: "new.rs", status: "untracked" },
          ],
        },
      }),
      "pane-1",
    );
    expect(status.available).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.byPath.get("src/a.rs")).toBe("modified");
    expect(status.byPath.get("new.rs")).toBe("untracked");
  });

  test("drops files whose status is not one of the known codes", async () => {
    const status = await loadGitStatus(
      clientReturning({
        status: { available: true, files: [{ path: "a", status: "bogus" }, { path: "b", status: "added" }] },
      }),
      "pane-1",
    );
    expect([...status.byPath.keys()]).toEqual(["b"]);
  });

  test("a directory that is not a repository reports unavailable", async () => {
    const status = await loadGitStatus(
      clientReturning({ status: { available: false } }),
      "pane-1",
    );
    expect(status.available).toBe(false);
    expect(status.byPath.size).toBe(0);
  });

  test("a failed call resolves to unavailable rather than rejecting", async () => {
    const status = await loadGitStatus(clientFailing(), "pane-1");
    expect(status.available).toBe(false);
  });
});

describe("gitStatusMark", () => {
  test("maps every status to its letter", () => {
    const marks: [GitFileStatus, string][] = [
      ["modified", "M"],
      ["added", "A"],
      ["deleted", "D"],
      ["renamed", "R"],
      ["untracked", "U"],
    ];
    for (const [status, mark] of marks) expect(gitStatusMark(status)).toBe(mark);
  });
});

describe("aggregateDirectoryStatus", () => {
  test("a directory borrows the loudest status under it", () => {
    const byPath = new Map<string, GitFileStatus>([
      ["src/deep/a.rs", "untracked"],
      ["src/b.rs", "modified"],
      ["other/c.rs", "added"],
    ]);
    expect(aggregateDirectoryStatus("src", byPath)).toBe("modified");
    expect(aggregateDirectoryStatus("src/deep", byPath)).toBe("untracked");
    expect(aggregateDirectoryStatus("other", byPath)).toBe("added");
  });

  test("a directory with nothing changed under it is unmarked", () => {
    const byPath = new Map<string, GitFileStatus>([["src/a.rs", "modified"]]);
    expect(aggregateDirectoryStatus("docs", byPath)).toBeNull();
  });

  test("a sibling with a shared prefix is not counted as inside", () => {
    const byPath = new Map<string, GitFileStatus>([["src-old/a.rs", "modified"]]);
    expect(aggregateDirectoryStatus("src", byPath)).toBeNull();
  });
});

describe("parentPaths", () => {
  test("lists every directory above a file", () => {
    expect(parentPaths("src/app/main.rs")).toEqual(["src", "src/app"]);
  });

  test("a file at the root has none", () => {
    expect(parentPaths("main.rs")).toEqual([]);
  });
});
