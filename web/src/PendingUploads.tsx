import { File } from "lucide-react";
import { formatBytes, type StagedUpload } from "./upload";

/**
 * The files chosen but not yet sent, shown above the composer.
 *
 * Images show the thumbnail the browser generated, because that is what tells
 * the user *which* screenshot they picked; everything else shows a name and a
 * size, which is all there is to show. Each entry can be removed before
 * sending, and images can be opened full size.
 *
 * This is presentation only: it never talks to the server, so removing an entry
 * is always harmless and never races an upload.
 */
export function PendingUploads({
  uploads,
  busy,
  onRemove,
  onPreview,
}: {
  uploads: StagedUpload[];
  busy: boolean;
  onRemove: (id: string) => void;
  /** Opens an image full size. Only called for images. */
  onPreview: (url: string) => void;
}) {
  if (uploads.length === 0) return null;

  return (
    <ul className="pending-uploads">
      {uploads.map((upload) => {
        // The preview URL only exists for a decodable image, so it doubles as
        // the check: a non-image, or one the browser could not read, falls
        // through to the filename row.
        const previewUrl = upload.previewUrl;
        return (
          <li className="pending-upload" key={upload.id}>
            {previewUrl ? (
              <button
                type="button"
                className="pending-thumb"
                // The label, not the thumbnail, is what a screen reader should
                // announce: the image is a decorative copy of the file.
                aria-label={`Preview ${upload.file.name}`}
                title="Tap to enlarge"
                onClick={() => onPreview(previewUrl)}
              >
                {upload.thumbnail ? (
                  <img src={`data:image/png;base64,${upload.thumbnail}`} alt="" />
                ) : (
                  // The thumbnail is best effort and may be missing for a
                  // format the browser cannot decode; the entry still sends.
                  <span className="pending-thumb-fallback" aria-hidden="true" />
                )}
              </button>
            ) : (
              <span className="pending-file" aria-hidden="true">
                <File size={20} />
              </span>
            )}
            <span className="pending-meta">
              <span className="pending-name" title={upload.file.name}>
                {upload.file.name || "file"}
              </span>
              <span className="pending-size">{formatBytes(upload.file.size)}</span>
            </span>
            <button
              type="button"
              className="pending-remove"
              disabled={busy}
              aria-label={`Remove ${upload.file.name}`}
              title="Remove"
              onClick={() => onRemove(upload.id)}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}
