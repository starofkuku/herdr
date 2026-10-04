import { useEffect, useMemo, useState } from "react";
import { loadDirectory, searchFiles, type DirectoryListing, type FileSearchHit } from "./files";
import { mentionDirectory, mentionEntries, rankMentionEntries, type MentionClient } from "./fileMentions";

interface MentionIndex {
  client: MentionClient;
  paneId: string;
  hits: FileSearchHit[];
  root: DirectoryListing | null;
  truncated: boolean;
}

/** Fetch once per opened picker, then filter locally as the query changes. */
function useMentionIndex(client: MentionClient, paneId: string, active: boolean) {
  const [index, setIndex] = useState<MentionIndex | null>(null);
  useEffect(() => {
    setIndex(null);
    if (!active || !paneId) return;
    let cancelled = false;
    void Promise.all([searchFiles(client, paneId), loadDirectory(client, paneId, "")])
      .then(([search, root]) => {
        if (!cancelled) setIndex({ client, paneId, ...search, root });
      });
    return () => { cancelled = true; };
  }, [client, paneId, active]);
  return index?.client === client && index.paneId === paneId ? index : null;
}

function useMentionDirectory(client: MentionClient, paneId: string, path: string, active: boolean) {
  const [result, setResult] = useState<{
    client: MentionClient; paneId: string; path: string; listing: DirectoryListing | null;
  } | null>(null);
  useEffect(() => {
    setResult(null);
    if (!active || !paneId || !path) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadDirectory(client, paneId, path).then((listing) => {
        if (!cancelled) setResult({ client, paneId, path, listing });
      });
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [client, paneId, path, active]);
  return result?.client === client && result.paneId === paneId && result.path === path
    ? result : null;
}

export function useFileMentionSearch(client: MentionClient, paneId: string, query: string, active: boolean) {
  const index = useMentionIndex(client, paneId, active);
  const directory = mentionDirectory(query);
  const current = useMentionDirectory(client, paneId, directory, active);
  const entries = useMemo(() => mentionEntries(index?.hits ?? [], [
    ...index?.root?.entries ?? [], ...current?.listing?.entries ?? [],
  ]), [index, current]);
  const matches = useMemo(() => rankMentionEntries(entries, query), [entries, query]);
  return {
    matches,
    loading: index === null || (!!directory && current === null),
    unavailable: index !== null && index.root === null && index.hits.length === 0,
    truncated: index?.truncated ?? false,
  };
}
