import { describe, expect, test } from "bun:test";
import { MAX_UPLOAD_BYTES, formatBytes, isImage, uploadError } from "./upload";

// `File` exists in bun, but `FileReader`, `Image`, and `document` do not, so the
// reading and thumbnail paths are exercised in the browser rather than here.
// What is covered below is the decision logic: which files are images, and
// which are refused before an upload that could not succeed.

function file(name: string, type: string, size = 4): File {
  // The bytes are placeholders; only the reported size and type are read.
  return new File([new Uint8Array(size)], name, { type });
}

describe("isImage", () => {
  test("accepts the image types a browser reports", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isImage(file("a", type))).toBe(true);
    }
  });

  test("rejects anything that is not an image", () => {
    for (const type of ["application/pdf", "text/plain", "application/zip", ""]) {
      expect(isImage(file("a", type))).toBe(false);
    }
  });

  test("judges by mime type, not by extension", () => {
    // A `.png` the browser could not type is treated as a plain file: guessing
    // from the name would offer a preview for content the browser may not
    // render, and the server keys its own behaviour off the same mime type.
    expect(isImage(file("a.png", "application/octet-stream"))).toBe(false);
    expect(isImage(file("a.bin", "image/png"))).toBe(true);
  });
});

describe("uploadError", () => {
  test("accepts a file at the limit", () => {
    expect(uploadError(file("a.png", "image/png", MAX_UPLOAD_BYTES))).toBeNull();
  });

  test("refuses a file over the limit, naming the size and the limit", () => {
    const message = uploadError(file("big.zip", "application/zip", MAX_UPLOAD_BYTES + 1));
    expect(message).toContain("big.zip");
    expect(message).toContain("16 MB");
    expect(message).toContain("over the");
  });

  test("refuses an empty file", () => {
    // An empty file has nothing to send, and saying so is clearer than a
    // successful upload of zero bytes.
    expect(uploadError(file("empty.txt", "text/plain", 0))).toContain("empty");
  });
});

describe("formatBytes", () => {
  test("reports bytes without a unit change", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  test("switches unit at each 1024 boundary", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  test("keeps one decimal below ten and rounds above", () => {
    // The fraction stops carrying information once the number is large, so a
    // long tail would only make the label harder to read.
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(15 * 1024)).toBe("15 KB");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
  });
});
