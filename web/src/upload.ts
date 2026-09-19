// Choosing and preparing files to send to an agent.
//
// Three entry points feed this module — paste, drag and drop, and the upload
// button — and all three end in the same place: a `StagedUpload` waiting beside
// the composer until the user sends it. Nothing here talks to the server; the
// detail view collects the results and calls the API, so a failure to prepare
// one file does not abandon the others.
//
// The clipboard is read through the `paste` event rather than
// `navigator.clipboard.read()`. The latter needs a secure context, and this UI
// is normally served over plain HTTP on a LAN address, where the browser
// refuses it outright. The event is delivered by a user gesture and needs no
// permission, so it works in both cases.

/** Largest file the server will accept, matching the upload request limit. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Longest edge of a generated thumbnail.
 *
 * Big enough to read in the pending list, small enough that a full-size
 * screenshot is not decoded to paint a 60px box.
 */
const THUMBNAIL_MAX_EDGE = 320;

/** Local id prefix, kept in the same shape as the gateway's request ids. */
function uploadId(): string {
  return `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** One file chosen by the user, waiting to be sent. */
export interface StagedUpload {
  /** Local id, used as a React key and to remove the entry. */
  id: string;
  file: File;
  /** Thumbnail data URL for the pending list. Images only. */
  thumbnail?: string;
  /** Object URL of the original, for the enlarged view. Images only. */
  previewUrl?: string;
}

/**
 * Whether a file is an image the UI can preview.
 *
 * Decided from the MIME type the browser reports, which is what also chooses
 * the preview path on the server. A file the browser cannot type is treated as
 * a non-image and simply sent.
 */
export function isImage(file: File): boolean {
  return file.type.startsWith("image/");
}

/**
 * Why a file cannot be sent, or null when it can.
 *
 * The check is here rather than at send time so the user is told as soon as
 * they add the file, instead of after a long upload that cannot succeed. The
 * server enforces the same limit; this only makes the refusal legible.
 */
export function uploadError(file: File): string | null {
  if (file.size === 0) {
    return `${file.name || "file"} is empty`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name || "file"} is ${formatBytes(file.size)}, over the ${formatBytes(
      MAX_UPLOAD_BYTES,
    )} limit`;
  }
  return null;
}

/** A size a person can read, for the pending list and size errors. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10 keeps "1.4 MB" informative without a long tail on
  // values like 12, where the fraction carries no meaning.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Reads a file as base64, without the `data:` prefix the API does not want.
 *
 * `readAsDataURL` is used rather than assembling the encoding by hand: it is
 * asynchronous, so a large file does not block the main thread, and it avoids
 * the argument-length limit that makes chunked `String.fromCharCode` fragile on
 * exactly the sizes this exists to support.
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("could not read the file"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.readAsDataURL(file);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("could not decode the image"));
    image.src = url;
  });
}

/**
 * Renders a small copy of an image for the pending list.
 *
 * Returns undefined for anything that is not an image, and for an image the
 * browser cannot decode — a corrupt file or a format it does not support. The
 * thumbnail is a convenience, so failing to build one must not stop the file
 * from being sent.
 */
export async function makeThumbnail(file: File): Promise<string | undefined> {
  if (!isImage(file)) return undefined;
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    // Never scale up: a small image is already its own thumbnail, and enlarging
    // it would only add bytes.
    const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/png");
    const comma = dataUrl.indexOf(",");
    return comma === -1 ? undefined : dataUrl.slice(comma + 1);
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Prepares one file for the pending list.
 *
 * The thumbnail is best effort; `previewUrl` is only created for images, so a
 * non-image never holds a blob alive. Callers own the returned entry and must
 * release it with `releaseUpload` when it is sent or removed.
 */
export async function stageUpload(file: File): Promise<StagedUpload> {
  const thumbnail = await makeThumbnail(file);
  return {
    id: uploadId(),
    file,
    thumbnail,
    previewUrl: isImage(file) ? URL.createObjectURL(file) : undefined,
  };
}

/**
 * Drops the object URLs a staged upload holds.
 *
 * Without this the blob stays alive for the life of the document, which for a
 * handful of screenshots is megabytes that are never reclaimed.
 */
export function releaseUpload(upload: StagedUpload): void {
  if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
}
