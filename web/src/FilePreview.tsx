import { useEffect, useState } from "react";
import { CopyButton } from "./Markdown";
import { loadFileContent, type FileContent } from "./files";

interface FilesClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/** Bytes, in the units a reader thinks in. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One file's contents, read-only.
 *
 * A drawer over the conversation rather than a screen: the point is to glance
 * at a file while the conversation stays where it is. Binary and oversized
 * files say so instead of showing garbage — the API refuses to send their
 * bytes, and pretending otherwise would be worse than the note.
 */
export function FilePreview({
  client,
  paneId,
  path,
  onClose,
}: {
  client: FilesClient;
  paneId: string;
  path: string;
  onClose: () => void;
}) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadFileContent(client, paneId, path).then((result) => {
      if (!cancelled) {
        setFile(result);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, paneId, path]);

  // Esc closes it, the way every other overlay here does.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const name = path.split("/").pop() ?? path;

  return (
    <div className="file-preview" role="dialog" aria-label={`文件 ${path}`}>
      <button
        type="button"
        className="file-preview__scrim"
        onClick={onClose}
        aria-label="关闭预览"
      />
      <div className="file-preview__panel">
        <header className="file-preview__head">
          <span className="file-preview__name" title={path}>
            {name}
          </span>
          <span className="file-preview__path">{path}</span>
          {file ? <span className="file-preview__size">{formatSize(file.size)}</span> : null}
          {file && !file.binary && !file.tooLarge ? (
            <CopyButton text={file.content} title="复制内容" />
          ) : null}
          <button type="button" className="ghost" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="file-preview__body">
          {loading ? (
            <p className="file-tree__note">读取中…</p>
          ) : file === null ? (
            <p className="file-tree__note">无法读取这个文件</p>
          ) : file.binary ? (
            <p className="file-tree__note">二进制文件，无法预览</p>
          ) : file.tooLarge ? (
            <p className="file-tree__note">
              文件过大（{formatSize(file.size)}），无法预览
            </p>
          ) : (
            <>
              <pre className="file-preview__code">{file.content}</pre>
              {file.truncated ? <p className="file-tree__note">内容已截断</p> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
