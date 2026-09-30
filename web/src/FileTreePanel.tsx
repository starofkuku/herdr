import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  FileDiff,
  FolderOpen,
  PanelLeftClose,
  RefreshCw,
  Search,
} from "lucide-react";
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
  onOpenFile,
}: {
  client: FilesClient;
  paneId: string;
  /** The pane's project directory, shown as the tree's root. */
  cwd: string;
  /** True while the conversation is not the visible screen. */
  hidden?: boolean;
  /**
   * Opens a file's preview. Handled by the screen rather than here: the preview
   * is a column beside the conversation, and the tree is a column of its own.
   */
  onOpenFile: (path: string) => void;
}) {
  // Docked by default: the sidebar is part of the layout, not a panel to find.
  const [open, setOpen] = useState(() => readStoredOpen() ?? true);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [git, setGit] = useState<GitStatus>({ available: false, byPath: new Map() });
  /** Open directories, keyed by path, each holding its own listing. */
  const [expanded, setExpanded] = useState<Map<string, DirectoryListing>>(new Map());
  const [loading, setLoading] = useState(false);
  /**
   * What the tree is filtered to.
   *
   * The filter is applied to the rows already loaded, not sent to the server: it
   * narrows what is on screen, and the tree only holds what has been expanded.
   */
  const [filter, setFilter] = useState("");
  /**
   * Whether only changed files are shown.
   *
   * Git reports paths, not directories, so this switches the whole list over to
   * a flat view of the changed files — the shape that can actually answer "what
   * did the agent touch" without expanding anything.
   */
  const [changedOnly, setChangedOnly] = useState(false);
  /**
   * Rows by path, so the tree can be scrolled to one.
   *
   * Expanding a folder near the bottom would otherwise add its children below
   * the visible area — the reader clicks and sees nothing change. The same ref
   * brings a row back into view when it is only partly visible.
   */
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const setRowRef = useCallback(
    (path: string) => (element: HTMLDivElement | null) => {
      if (element) rowRefs.current.set(path, element);
      else rowRefs.current.delete(path);
    },
    [],
  );
  const revealRow = useCallback((path: string) => {
    // After paint: the row may only exist once React has committed the change.
    window.requestAnimationFrame(() => {
      rowRefs.current
        .get(path)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }, []);
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
        revealRow(path);
        return;
      }
      const result = await loadDirectory(client, paneId, path);
      if (result) {
        setExpanded((current) => new Map(current).set(path, result));
        // The first child, not the folder: the point of expanding is to see
        // what is inside, and that is what may have landed out of view.
        revealRow(result.entries[0]?.path ?? path);
      }
    },
    [client, paneId, expanded, revealRow],
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

  /**
   * The changed files as flat rows, newest statuses first.
   *
   * This view ignores the tree's expansion state on purpose: the point of the
   * toggle is to stop walking directories and just see what moved.
   */
  const changedRows = useMemo(
    () =>
      [...git.byPath.entries()]
        .map(([path, status]) => ({
          path,
          name: path.split("/").pop() ?? path,
          status,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    [git.byPath],
  );

  /** True when a row survives the filter. A directory matches when its own name does. */
  const matchesFilter = useCallback(
    (name: string, path: string) => {
      const query = filter.trim().toLowerCase();
      if (!query) return true;
      return name.toLowerCase().includes(query) || path.toLowerCase().includes(query);
    },
    [filter],
  );

  if (!paneId) return null;

  /*
   * Both states live inside `.file-sidebar`, and that wrapper is what animates.
   *
   * Swapping two elements would give no transition at all — CSS animates a
   * property change on a node that stays put — so the wrapper keeps its
   * identity and only its width changes. The tree inside keeps its full width
   * and is clipped by the wrapper, which is what makes the reveal read as the
   * panel sliding open rather than its contents reflowing.
   */
  if (!open) {
    return (
      <div className="file-sidebar" data-open="false">
        <button
          type="button"
          className="file-tree-launcher"
          aria-label="展开项目文件"
          title="展开项目文件"
          onClick={() => toggleOpen(true)}
        >
          <FolderOpen size={15} aria-hidden="true" />
          <span className="file-tree-launcher__label">项目文件</span>
        </button>
      </div>
    );
  }

  /** One row: an arrow for a directory, a type icon for a file, and the mark. */
  const renderRow = (entry: FileEntry, depth: number, key: string) => {
    const status = statusOf(entry);
    const isDirectory = entry.kind === "dir";
    const isExpanded = isDirectory && expanded.has(entry.path);
    return (
      // A node wraps its own row and its children, so expanded entries stack
      // under their parent. (A single flex row holding both put them side by
      // side, which is what made an expanded folder's children appear to its
      // right.)
      <div key={key} className="file-tree__node" ref={setRowRef(entry.path)}>
        <button
          type="button"
          className="file-tree__entry"
          style={{ paddingLeft: `${0.3 + depth * 0.6}rem` }}
          title={entry.path}
          onClick={() => {
            revealRow(entry.path);
            if (isDirectory) void toggleDirectory(entry.path);
            else onOpenFile(entry.path);
          }}
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
    <div className="file-sidebar" data-open="true">
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
          className={`file-tree__action${changedOnly ? " active" : ""}`}
          aria-pressed={changedOnly}
          disabled={!git.available}
          aria-label="仅显示 git 改动"
          title={
            git.available ? "仅显示有改动的文件" : "这个目录不在 git 仓库里"
          }
          onClick={() => setChangedOnly((value) => !value)}
        >
          <FileDiff size={13} aria-hidden="true" />
        </button>
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
          aria-label="收起项目文件"
          title="收起"
          onClick={() => toggleOpen(false)}
        >
          <PanelLeftClose size={14} aria-hidden="true" />
        </button>
      </header>

      {/* The filter sits under the title row: it narrows the tree rather than
          replacing it, so a reader can type and watch the list shorten. */}
      <div className="file-tree__filter">
        <Search size={12} className="file-tree__filter-icon" aria-hidden="true" />
        <input
          type="text"
          className="file-tree__filter-input"
          placeholder={changedOnly ? "筛选改动文件…" : "筛选文件…"}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && filter) {
              event.stopPropagation();
              setFilter("");
            }
          }}
          aria-label="筛选文件"
        />
        {filter ? (
          <button
            type="button"
            className="file-tree__filter-clear"
            aria-label="清除筛选"
            onClick={() => setFilter("")}
          >
            ×
          </button>
        ) : null}
      </div>

      <div className="file-tree__body" role="tree">
        {changedOnly ? (
          // The changed files, flat: git reports paths rather than directories,
          // and this is the view that answers "what did the agent touch".
          changedRows.length === 0 ? (
            <p className="file-tree__note">没有改动</p>
          ) : (
            changedRows
              .filter((row) => matchesFilter(row.name, row.path))
              .map((row) => (
                <div key={row.path} className="file-tree__node">
                  <button
                    type="button"
                    className="file-tree__entry"
                    style={{ paddingLeft: "0.3rem" }}
                    title={row.path}
                    onClick={() => onOpenFile(row.path)}
                  >
                    <span className="file-tree__caret" aria-hidden="true" />
                    <span className="file-tree__name">{row.path}</span>
                    <span className={`file-tree__mark ${row.status}`} title={row.status}>
                      {gitStatusMark(row.status)}
                    </span>
                  </button>
                </div>
              ))
          )
        ) : listing === null ? (
          <p className="file-tree__note">读取中…</p>
        ) : listing.entries.length === 0 ? (
          <p className="file-tree__note">空目录</p>
        ) : (
          listing.entries
            .filter((entry) => matchesFilter(entry.name, entry.path))
            .map((entry) => renderRow(entry, 0, entry.path))
        )}
      </div>
      </div>
    </div>
  );
}
