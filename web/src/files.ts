// The project's files, as the left panel reads them.
//
// Read-only: the agent writes, this only looks. Each loader follows the same
// contract as `todos.ts` and `subagents.ts` — a narrow structural client, a
// defensive parser, and a failure that resolves to "nothing" rather than
// rejecting, because a panel that cannot load is not an error the reader can
// act on.

/** The slice of the gateway client these loaders need. */
interface FilesClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/** One entry in a directory listing. */
export interface FileEntry {
  name: string;
  /** Path relative to the project root, with `/` separators. */
  path: string;
  kind: "file" | "dir";
}

/** A directory's contents, plus the root they are relative to. */
export interface DirectoryListing {
  root: string;
  path: string;
  entries: FileEntry[];
}

/** A file's text, or why it has none. */
export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
  tooLarge: boolean;
  size: number;
}

/** How a file differs from HEAD. */
export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked";

export interface GitStatus {
  available: boolean;
  repoRoot?: string;
  branch?: string;
  /** Changed files, keyed by path relative to the project root. */
  byPath: Map<string, GitFileStatus>;
}

/** How often the git status is re-read while the panel is open. */
export const GIT_POLL_MS = 3000;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads one listing entry, dropping anything unusable. */
function parseEntry(raw: unknown): FileEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = asString(record.name);
  const path = asString(record.path);
  if (!name || !path) return null;
  return { name, path, kind: record.kind === "dir" ? "dir" : "file" };
}

/** Loads one directory of the project. Resolves to null when it cannot be read. */
export async function loadDirectory(
  client: FilesClient,
  paneId: string,
  path: string,
): Promise<DirectoryListing | null> {
  try {
    const response = await client.call<{ files?: unknown }>("files.list", {
      pane_id: paneId,
      ...(path ? { path } : {}),
    });
    const files = response?.files as Record<string, unknown> | undefined;
    if (!files) return null;
    const rawEntries = Array.isArray(files.entries) ? files.entries : [];
    const entries: FileEntry[] = [];
    for (const raw of rawEntries) {
      const entry = parseEntry(raw);
      if (entry) entries.push(entry);
    }
    return {
      root: asString(files.root) ?? "",
      path: typeof files.path === "string" ? files.path : path,
      entries,
    };
  } catch {
    return null;
  }
}

/** Loads one file for preview. Resolves to null when it cannot be read. */
export async function loadFileContent(
  client: FilesClient,
  paneId: string,
  path: string,
): Promise<FileContent | null> {
  try {
    const response = await client.call<{ file?: unknown }>("files.read", {
      pane_id: paneId,
      path,
    });
    const file = response?.file as Record<string, unknown> | undefined;
    if (!file) return null;
    return {
      path: asString(file.path) ?? path,
      content: typeof file.content === "string" ? file.content : "",
      truncated: file.truncated === true,
      binary: file.binary === true,
      tooLarge: file.too_large === true,
      size: typeof file.size === "number" ? file.size : 0,
    };
  } catch {
    return null;
  }
}

/** The status codes the tree marks, and nothing else. */
const GIT_STATUSES: readonly GitFileStatus[] = [
  "modified",
  "added",
  "deleted",
  "renamed",
  "untracked",
];

function isGitStatus(value: unknown): value is GitFileStatus {
  return typeof value === "string" && (GIT_STATUSES as readonly string[]).includes(value);
}

/**
 * Loads the project's git status. A directory that is not a repository answers
 * with `available: false` — that is a fact about the project, not a failure.
 */
export async function loadGitStatus(
  client: FilesClient,
  paneId: string,
): Promise<GitStatus> {
  const empty: GitStatus = { available: false, byPath: new Map() };
  try {
    const response = await client.call<{ status?: unknown }>("git.status", {
      pane_id: paneId,
    });
    const status = response?.status as Record<string, unknown> | undefined;
    if (!status) return empty;
    const byPath = new Map<string, GitFileStatus>();
    if (Array.isArray(status.files)) {
      for (const raw of status.files) {
        if (!raw || typeof raw !== "object") continue;
        const record = raw as Record<string, unknown>;
        const path = asString(record.path);
        if (!path || !isGitStatus(record.status)) continue;
        byPath.set(path, record.status);
      }
    }
    return {
      available: status.available === true,
      repoRoot: asString(status.repo_root),
      branch: asString(status.branch),
      byPath,
    };
  } catch {
    return empty;
  }
}

/** The single-letter mark a status shows, following ZCode's own mapping. */
export function gitStatusMark(status: GitFileStatus): string {
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
  }
}

/**
 * The status to mark a directory with.
 *
 * A directory owns no state of its own in git, so it borrows the most
 * significant status among the files under it: a change anywhere inside is a
 * change to the directory, which is what makes a collapsed tree still say
 * where the work is.
 */
export function aggregateDirectoryStatus(
  directoryPath: string,
  byPath: Map<string, GitFileStatus>,
): GitFileStatus | null {
  const prefix = directoryPath.endsWith("/") ? directoryPath : `${directoryPath}/`;
  let found: GitFileStatus | null = null;
  for (const [path, status] of byPath) {
    if (!path.startsWith(prefix)) continue;
    if (found === null || statusRank(status) < statusRank(found)) found = status;
  }
  return found;
}

/** Which status wins when a directory holds several. Modified reads loudest. */
function statusRank(status: GitFileStatus): number {
  switch (status) {
    case "modified":
      return 0;
    case "added":
      return 1;
    case "renamed":
      return 2;
    case "deleted":
      return 3;
    case "untracked":
      return 4;
  }
}

/**
 * The paths a listing's parent chain needs, so a file can be revealed.
 *
 * Used to reload every directory that is currently open when the status
 * changes shape (a file appearing or disappearing), without walking the tree.
 */
export function parentPaths(path: string): string[] {
  const parts = path.split("/").filter((part) => part.length > 0);
  const out: string[] = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    out.push(parts.slice(0, index + 1).join("/"));
  }
  return out;
}
