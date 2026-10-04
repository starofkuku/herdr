import { fuzzyScore, parentPaths, type FileEntry, type FileSearchHit } from "./files";

export interface MentionClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

export interface FileMention {
  start: number;
  end: number;
  query: string;
}

/** Only the @ word at the caret is replaced; email addresses are left alone. */
export function fileMentionAt(text: string, start: number, end: number): FileMention | null {
  if (start !== end) return null;
  const match = /(?:^|[\s（(【\[])@("[^"\r\n]*|[^\s@"]*)$/u.exec(text.slice(0, start));
  if (!match) return null;
  const word = match[1];
  const quoted = word.startsWith('"');
  const suffix = text.slice(start);
  const remaining = quoted ? /^[^"\r\n]*"?/.exec(suffix) : /^[^\s@"]*/.exec(suffix);
  return {
    start: start - word.length - 1,
    end: start + (remaining?.[0].length ?? 0),
    query: (quoted ? word.slice(1) : word).replace(/^\.\//, ""),
  };
}

export function insertFileMention(text: string, mention: FileMention, entry: FileEntry) {
  const path = entry.path + (entry.kind === "dir" ? "/" : "");
  const reference = /[\s"\\]/.test(path) ? JSON.stringify(path) : path;
  const replacement = `@${reference} `;
  return {
    text: text.slice(0, mention.start) + replacement + text.slice(mention.end),
    caret: mention.start + replacement.length,
  };
}

/** Search returns files; their ancestors plus directory listings supply folders. */
export function mentionEntries(hits: FileSearchHit[], listings: FileEntry[]): FileEntry[] {
  const entries = new Map<string, FileEntry>();
  for (const hit of hits) {
    entries.set(hit.path, { ...hit, kind: "file" });
    for (const path of parentPaths(hit.path)) {
      if (!entries.has(path)) {
        entries.set(path, { path, name: path.slice(path.lastIndexOf("/") + 1), kind: "dir" });
      }
    }
  }
  for (const entry of listings) entries.set(entry.path, entry);
  return [...entries.values()].filter((entry) => !/[\r\n]/.test(entry.path));
}

/** A typed directory prefix also finds empty folders absent from files.search. */
export function mentionDirectory(query: string): string {
  const path = query.slice(0, Math.max(0, query.lastIndexOf("/")));
  if (path.startsWith("/") || path.split("/").some((part) => part === "..")) return "";
  return path;
}

export function rankMentionEntries(entries: FileEntry[], query: string): FileEntry[] {
  const scored: { entry: FileEntry; score: number }[] = [];
  for (const entry of entries) {
    const path = entry.path + (entry.kind === "dir" && query.endsWith("/") ? "/" : "");
    const score = fuzzyScore(path, query);
    if (score !== null) scored.push({ entry, score });
  }
  scored.sort((a, b) => a.score - b.score
    || Number(a.entry.kind === "file") - Number(b.entry.kind === "file")
    || a.entry.path.localeCompare(b.entry.path));
  return scored.slice(0, 50).map(({ entry }) => entry);
}
