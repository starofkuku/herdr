import { useEffect, useMemo, useRef, useState } from "react";
import { FileSearch, Search } from "lucide-react";
import { fileIconDataUri } from "./fileIcons";
import { rankSearchHits, searchFiles, type FileSearchHit } from "./files";

interface FilesClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/** How many matches the palette lists; past this the query is not specific enough. */
const MAX_SHOWN = 50;

/**
 * Jump to a file anywhere in the project.
 *
 * The tree is lazy, so it cannot answer "where is this file" — the palette asks
 * the server for the full list once and ranks it locally, which is what keeps
 * typing a keystroke-per-request away. Matches show their whole path, because
 * two files named `mod.rs` are a normal thing in a Rust repository.
 */
export function FileSearchPalette({
  client,
  paneId,
  onOpen,
  onClose,
}: {
  client: FilesClient;
  paneId: string;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FileSearchHit[] | null>(null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // The whole list is fetched once, when the palette opens.
  useEffect(() => {
    let cancelled = false;
    void searchFiles(client, paneId).then((result) => {
      if (!cancelled) setHits(result.hits);
    });
    return () => {
      cancelled = true;
    };
  }, [client, paneId]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const matches = useMemo(() => {
    if (!hits) return [];
    return rankSearchHits(hits, query.trim()).slice(0, MAX_SHOWN);
  }, [hits, query]);

  // A new query re-ranks, so the selection returns to the best match.
  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Keep the selected row visible while the list is walked with the arrows.
  useEffect(() => {
    const element = listRef.current?.children[selected];
    if (element instanceof HTMLElement) {
      element.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  const choose = (hit: FileSearchHit) => {
    onOpen(hit.path);
    onClose();
  };

  return (
    <div className="palette-scrim" role="dialog" aria-label="搜索文件" onClick={onClose}>
      <div className="file-search" onClick={(event) => event.stopPropagation()}>
        <div className="file-search__field">
          <Search size={15} className="file-search__icon" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            className="file-search__input"
            placeholder="搜索项目文件…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
              }
              // An IME's Enter commits the candidate, not the selection.
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((value) => Math.min(value + 1, matches.length - 1));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((value) => Math.max(value - 1, 0));
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const hit = matches[selected];
                if (hit) choose(hit);
              }
            }}
            aria-label="搜索项目文件"
          />
          <kbd className="file-search__hint">Esc</kbd>
        </div>

        {hits === null ? (
          <p className="file-search__note">读取文件列表…</p>
        ) : matches.length === 0 ? (
          <p className="file-search__note">
            {query.trim() ? "没有匹配的文件" : "项目里没有文件"}
          </p>
        ) : (
          <ul className="file-search__list" ref={listRef} role="listbox">
            {matches.map((hit, index) => {
              const icon = fileIconDataUri(hit.path);
              const directory = hit.path.slice(0, Math.max(0, hit.path.length - hit.name.length));
              return (
                <li key={hit.path} role="option" aria-selected={index === selected}>
                  <button
                    type="button"
                    className={`file-search__row${index === selected ? " selected" : ""}`}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => choose(hit)}
                    title={hit.path}
                  >
                    {icon ? (
                      <img className="file-tree__icon" src={icon} alt="" aria-hidden="true" />
                    ) : (
                      <FileSearch size={14} aria-hidden="true" />
                    )}
                    {/* The leaf is what was searched for; the directory is the
                        part that tells two same-named files apart. */}
                    <span className="file-search__name">{hit.name}</span>
                    {directory ? (
                      <span className="file-search__dir">{directory}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
