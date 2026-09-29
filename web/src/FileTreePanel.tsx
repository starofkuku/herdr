import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FolderOpen, RefreshCw, X } from "lucide-react";
import { FilePreview } from "./FilePreview";
import { fileIconDataUri } from "./fileIcons";
import {
  aggregateDirectoryStatus,
  GIT_POLL_MS,
  gitStatusMark,
  loadDirectory,
  loadGitStatus,
  type DirectoryListing,
  type FileEntry,
  type GitFileStatus,
  type GitStatus,
} from "./files";

/** The shape the panel needs from a gateway client. */
interface FilesClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/** How the panel's open state is remembered between visits. */
const OPEN_KEY = "herdr-web-file-tree-open";

function readStoredOpen(): boolean | null {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    return raw === null ? null : raw === "1";
  } catch {
    return null;
  }
}

function storeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // A browser that refuses storage still gets a working panel.
  }
}

/**
 * The project's files, in a panel beside the conversation.
 *
 * Read-only and lazy: a directory is read the first time it is opened, so a
 * large repository costs nothing until it is walked. Git status is polled while
 * the panel is open and marks both files and the directories above them, which
 * is what says where the work is without expanding anything.
 *
 * Wide windows get the panel docked in the slack beside the reading column;
 * narrower ones keep it collapsed behind a button, because there is no room to
 * show it without covering the text.
 */
export function FileTreePanel({
  client,
  paneId,
  cwd,
  hidden,
}: {
  client: FilesClient;
  paneId: string;
  /** The pane's project directory, shown as the tree's root. */
  cwd: string;
  /** True while the conversation is not the visible screen. */
  hidden?: boolean;
}) {
  const [open, setOpen] = useState(() => readStoredOpen() ?? false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [git, setGit] = useState<GitStatus>({ available: false, byPath: new Map() });
  /** Open directories, keyed by path, each holding its own listing. */
  const [expanded, setExpanded] = useState<Map<string, DirectoryListing>>(new Map());
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const gitSignature = useRef("");
  const inFlight = useRef(false);

  const toggleOpen = useCallback((next: boolean) => {
    setOpen(next);
    storeOpen(next);
  }, []);

  /** Loads the root and refreshes every directory that is currently open. */
  const refresh = useCallback(async () => {
    if (!paneId || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const rootListing = await loadDirectory(client, paneId, "");
      setListing(rootListing);
      const openPaths = [...expanded.keys()];
      if (openPaths.length > 0) {
        const revalidated = await Promise.all(
          openPaths.map(async (path) => [path, await loadDirectory(client, paneId, path)] as const),
        );
        setExpanded((current) => {
          const next = new Map(current);
          for (const [path, result] of revalidated) {
            if (result) next.set(path, result);
          }
          return next;
        });
      }
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [client, paneId, expanded]);

  // The tree is read when it is first shown, and re-read when the pane changes.
  useEffect(() => {
    if (!open || hidden || !paneId) return;
    setListing(null);
    setExpanded(new Map());
    void refresh();
    // `refresh` reads `expanded`, which is reset just above; re-running on its
    // identity would loop, so the dependency is the pane alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hidden, paneId]);

  // Git status is polled while the panel is up: it is the cheapest signal that
  // the project changed, and it is what marks the tree.
  useEffect(() => {
    if (!open || hidden || !paneId) return;
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      const next = await loadGitStatus(client, paneId);
      if (cancelled) return;
      // A change in the changed-file set means files may have appeared or gone:
      // re-read the open directories so the tree keeps up.
      const signature = [...next.byPath.entries()]
        .map(([path, status]) => `${path}:${status}`)
        .sort()
        .join("\n");
      const changed = signature !== gitSignature.current;
      gitSignature.current = signature;
      setGit(next);
      if (changed) void refresh();
    };
    void tick();
    const timer = window.setInterval(() => void tick(), GIT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, hidden, paneId, client, refresh]);

  const toggleDirectory = useCallback(
    async (path: string) => {
      if (expanded.has(path)) {
        setExpanded((current) => {
          const next = new Map(current);
          next.delete(path);
          return next;
        });
        return;
      }
      const result = await loadDirectory(client, paneId, path);
      if (result) {
        setExpanded((current) => new Map(current).set(path, result));
      }
    },
    [client, paneId, expanded],
  );

  const statusOf = useCallback(
    (entry: FileEntry): GitFileStatus | null =>
      entry.kind === "dir"
        ? aggregateDirectoryStatus(entry.path, git.byPath)
        : (git.byPath.get(entry.path) ?? null),
    [git.byPath],
  );

  const rootName = useMemo(() => {
    const parts = cwd.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? cwd;
  }, [cwd]);

  if (!paneId) return null;

  if (!open) {
    return (
      <button
        type="button"
        className="file-tree-launcher"
        aria-label="打开项目文件"
        title="项目文件"
        onClick={() => toggleOpen(true)}
      >
        <FolderOpen size={15} aria-hidden="true" />
      </button>
    );
  }

  /** One row: an arrow for a directory, a type icon for a file, and the mark. */
  const renderRow = (entry: FileEntry, depth: number, key: string) => {
    const status = statusOf(entry);
    const isDirectory = entry.kind === "dir";
    const isExpanded = isDirectory && expanded.has(entry.path);
    return (
      <div key={key} className="file-tree__row" style={{ paddingLeft: `${0.4 + depth * 0.85}rem` }}>
        <button
          type="button"
          className="file-tree__entry"
          title={entry.path}
          onClick={() => (isDirectory ? void toggleDirectory(entry.path) : setPreview(entry.path))}
        >
          {isDirectory ? (
            <ChevronRight
              size={13}
              className={`file-tree__caret${isExpanded ? " open" : ""}`}
              aria-hidden="true"
            />
          ) : (
            <span className="file-tree__caret" aria-hidden="true" />
          )}
          {isDirectory ? (
            <span className="file-tree__folder" aria-hidden="true" />
          ) : (
            (() => {
              const icon = fileIconDataUri(entry.path);
              return icon ? <img className="file-tree__icon" src={icon} alt="" aria-hidden="true" /> : null;
            })()
          )}
          <span className="file-tree__name">{entry.name}</span>
          {status ? (
            <span className={`file-tree__mark ${status}`} title={status}>
              {gitStatusMark(status)}
            </span>
          ) : null}
        </button>
        {isExpanded
          ? (expanded.get(entry.path)?.entries ?? []).map((child) =>
              renderRow(child, depth + 1, `${entry.path}/${child.name}`),
            )
          : null}
      </div>
    );
  };

  return (
    <div className="file-tree" role="complementary" aria-label="项目文件">
      <header className="file-tree__head">
        <span className="file-tree__root" title={cwd}>
          {rootName}
        </span>
        {git.available && git.branch ? (
          <span className="file-tree__branch" title={`git · ${git.branch}`}>
            {git.branch}
          </span>
        ) : null}
        <button
          type="button"
          className="file-tree__action"
          aria-label="刷新"
          title="刷新"
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} className={loading ? "spinning" : undefined} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="file-tree__action"
          aria-label="收起文件面板"
          title="收起"
          onClick={() => toggleOpen(false)}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </header>

      <div className="file-tree__body" role="tree">
        {listing === null ? (
          <p className="file-tree__note">读取中…</p>
        ) : listing.entries.length === 0 ? (
          <p className="file-tree__note">空目录</p>
        ) : (
          listing.entries.map((entry) => renderRow(entry, 0, entry.path))
        )}
      </div>

      {preview ? (
        <FilePreview
          client={client}
          paneId={paneId}
          path={preview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}
