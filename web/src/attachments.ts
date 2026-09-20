// Uploaded files referenced inside a stored message.
//
// An upload is stored at `<uploads_dir>/<id>.<ext>` on the host and served from
// `/uploads/<id>.<ext>`, where the id is 32 hex characters. The id is the only
// stable link between the two: the uploads directory is configurable (it is
// `[web] uploads_dir`, or `<static_dir>/uploads` when that is unset), so the
// stored path itself says nothing about the URL. Keying on the id rather than
// on a path prefix keeps a preview working wherever the directory points, and
// keeps a message that merely mentions some other `.png` from being rewritten.
//
// Everything here is presentation only: it turns stored text into parts, and
// never asks the server for anything.

/** One uploaded file a message refers to. */
export interface MessageAttachment {
  /** The reference as it appears in the message, without a leading `@`. */
  path: string;
  /** What the browser loads the file from, relative to the gateway. */
  url: string;
  /** Filename, used for the label. */
  name: string;
}

/** A message split into prose and the uploaded images it refers to. */
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "image"; attachment: MessageAttachment };

/** Extensions worth an inline preview. Anything else stays as written. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);

/** `<32 hex>.<ext>`, which is how the server names every uploaded file. */
const UPLOADED_FILE = /([0-9a-f]{32})\.([A-Za-z0-9]+)/g;

/**
 * Splits a message into prose and previewable uploads.
 *
 * The `@` the server's `paste_text` emits is recognised, but so is a bare path:
 * an agent quoting an earlier message, or a transcript written before mentions
 * existed, drops it. Once a message has no previewable upload the original
 * string is returned untouched, so a normal message renders exactly as before.
 */
export function splitMessage(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let cursor = 0;

  UPLOADED_FILE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UPLOADED_FILE.exec(text)) !== null) {
    const [, id, extension] = match;
    if (!IMAGE_EXTENSIONS.has(extension.toLowerCase())) continue;

    // The regex finds the id; the reference begins at the start of the
    // whitespace-delimited token introducing it. That token's `@`, if any, is
    // part of the reference but not part of the path. Prose stops at the token
    // boundary rather than after the `@`, or every mention would leave a stray
    // `@` behind in the rendered text.
    let tokenStart = match.index;
    while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1])) tokenStart -= 1;
    const pathStart = text[tokenStart] === "@" ? tokenStart + 1 : tokenStart;

    const end = match.index + match[0].length;
    const path = text.slice(pathStart, end);
    const name = path.slice(path.lastIndexOf("/") + 1);

    if (tokenStart > cursor) {
      parts.push({ kind: "text", text: text.slice(cursor, tokenStart) });
    }
    parts.push({ kind: "image", attachment: { path, url: `/uploads/${id}.${extension}`, name } });
    cursor = end;
  }

  if (parts.length === 0) return [{ kind: "text", text }];
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts;
}

/** Whether a message holds anything {@link splitMessage} would preview. */
export function hasPreviewableImage(text: string): boolean {
  return splitMessage(text).some((part) => part.kind === "image");
}
