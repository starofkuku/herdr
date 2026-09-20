import { describe, expect, test } from "bun:test";
import { hasPreviewableImage, splitMessage } from "./attachments";

// A real staged filename: 32 hex characters plus an extension.
const ID = "1d8842b25663c42e413c6715ef261ae9";
const PATH = `/home/administrator/herdr-web/uploads/${ID}.png`;

function textOf(parts: ReturnType<typeof splitMessage>): string {
  return parts
    .filter((part) => part.kind === "text")
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("");
}

describe("splitMessage", () => {
  test("splits an @ mention into prose and an image", () => {
    const parts = splitMessage(`测试图片上传\n@${PATH}`);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ kind: "text", text: "测试图片上传\n" });
    expect(parts[1]).toEqual({
      kind: "image",
      attachment: {
        path: PATH,
        url: `/uploads/${ID}.png`,
        name: `${ID}.png`,
      },
    });
  });

  test("accepts a bare path, because an agent quoting drops the @", () => {
    const parts = splitMessage(`see ${PATH}`);
    expect(parts[1]).toEqual({
      kind: "image",
      attachment: { path: PATH, url: `/uploads/${ID}.png`, name: `${ID}.png` },
    });
  });

  test("maps the stored path to the served route, not the directory", () => {
    // The uploads directory is configurable, so the URL must not be derived
    // from the path prefix — only the id carries across.
    const parts = splitMessage(`@/srv/config/uploads/${ID}.jpg`);
    expect(parts).toEqual([
      {
        kind: "image",
        attachment: {
          path: `/srv/config/uploads/${ID}.jpg`,
          url: `/uploads/${ID}.jpg`,
          name: `${ID}.jpg`,
        },
      },
    ]);
  });

  test("keeps a message with no upload byte-for-byte", () => {
    const message = "just words, nothing attached";
    expect(splitMessage(message)).toEqual([{ kind: "text", text: message }]);
  });

  test("does not rewrite some other image path", () => {
    // Not an upload: the stem is not 32 hex characters, so there is no route
    // that could serve it and touching it would only corrupt the text.
    const message = "look at /tmp/screenshot.png";
    expect(splitMessage(message)).toEqual([{ kind: "text", text: message }]);
  });

  test("leaves a non-image upload as written", () => {
    const message = `@/home/u/herdr-web/uploads/${ID}.pdf`;
    expect(splitMessage(message)).toEqual([{ kind: "text", text: message }]);
  });

  test("finds several uploads in one message", () => {
    const other = "b3749711f8520d10a2046ccc984f41a7";
    const parts = splitMessage(`@${PATH}\nand\n@/home/u/uploads/${other}.jpeg`);
    expect(parts.filter((part) => part.kind === "image")).toHaveLength(2);
    expect(parts.map((part) => (part.kind === "image" ? part.attachment.url : null)).filter(Boolean))
      .toEqual([`/uploads/${ID}.png`, `/uploads/${other}.jpeg`]);
  });

  test("keeps the prose between two uploads", () => {
    const other = "b3749711f8520d10a2046ccc984f41a7";
    const parts = splitMessage(`@${PATH} middle @/u/${other}.png`);
    expect(textOf(parts)).toBe(" middle ");
  });

  test("treats an uppercase extension as the same image", () => {
    // No leading prose, so the image is the first and only part.
    const parts = splitMessage(`@/u/${ID}.PNG`);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.kind).toBe("image");
  });
});

describe("hasPreviewableImage", () => {
  test("is true only when something would preview", () => {
    expect(hasPreviewableImage(`@${PATH}`)).toBe(true);
    expect(hasPreviewableImage("plain text")).toBe(false);
    expect(hasPreviewableImage(`@/home/u/uploads/${ID}.pdf`)).toBe(false);
  });
});
