import { describe, expect, test } from "bun:test";
import {
  expandQuotedPlaceholders,
  newQuote,
  quotePlaceholder,
  splitQuotePlaceholders,
  stripAllQuotePlaceholders,
  stripQuotePlaceholder,
  type QuoteSource,
} from "./quotes";

function quote(seq: number, text: string, source: QuoteSource = "agent") {
  return newQuote(text, source, seq);
}

describe("quotePlaceholder", () => {
  test("wraps the number the reader can type back", () => {
    expect(quotePlaceholder(1)).toBe("[引用1]");
    expect(quotePlaceholder(12)).toBe("[引用12]");
  });
});

describe("expandQuotedPlaceholders", () => {
  test("expands a placeholder into its block where it stands", () => {
    const out = expandQuotedPlaceholders("看 [引用1]", [quote(1, "第一段")]);
    expect(out).toBe("看\n\n> 引用agent 的回答：\n> 第一段");
  });

  test("two placeholders in one line break into word / block paragraphs", () => {
    const out = expandQuotedPlaceholders("看 [引用1] 和 [引用3] 的矛盾", [
      quote(1, "第一段"),
      quote(3, "第三段"),
    ]);
    expect(out).toBe(
      [
        "看",
        "> 引用agent 的回答：\n> 第一段",
        "和",
        "> 引用agent 的回答：\n> 第三段",
        "的矛盾",
      ].join("\n\n"),
    );
  });

  test("a placeholder alone on its line becomes the block alone", () => {
    const out = expandQuotedPlaceholders("[引用1]", [quote(1, "原文", "reasoning")]);
    expect(out).toBe("> 引用推理内容：\n> 原文");
  });

  test("a number naming no quote stays as written", () => {
    const out = expandQuotedPlaceholders("foo [引用9] bar", [quote(1, "第一段")]);
    expect(out).toBe("foo [引用9] bar");
  });

  test("text without placeholders is untouched, line by line", () => {
    const text = "第一行\n[引用x] 不是占位符\n普通 [引用]";
    expect(expandQuotedPlaceholders(text, [quote(1, "第一段")])).toBe(text);
  });

  test("the same quote marked twice is expanded twice", () => {
    const out = expandQuotedPlaceholders("[引用1] 再看 [引用1]", [quote(1, "原文")]);
    expect(out.match(/> 原文/g)).toHaveLength(2);
  });
});

describe("splitQuotePlaceholders", () => {
  test("cuts a draft at its tokens, text and badges alternating", () => {
    expect(splitQuotePlaceholders("看 [引用1] 和 [引用2] 了")).toEqual([
      { text: "看 " },
      { seq: 1 },
      { text: " 和 " },
      { seq: 2 },
      { text: " 了" },
    ]);
  });

  test("a token alone is the whole list", () => {
    expect(splitQuotePlaceholders("[引用3]")).toEqual([{ seq: 3 }]);
  });

  test("joins back to exactly the draft, tokens included", () => {
    const draft = "a[引用1]b\n[引用2]";
    expect(
      splitQuotePlaceholders(draft)
        .map((s) => ("seq" in s ? `[引用${s.seq}]` : s.text))
        .join(""),
    ).toBe(draft);
  });

  test("leaves malformed brackets as plain text", () => {
    expect(splitQuotePlaceholders("[引用x] [引用]")).toEqual([
      { text: "[引用x] [引用]" },
    ]);
  });
});

describe("stripQuotePlaceholder", () => {
  test("pulls the token and the space it leaves behind", () => {
    expect(stripQuotePlaceholder("看 [引用1] 这个", 1)).toBe("看 这个");
  });

  test("leaves lines without the token exactly as they are", () => {
    const text = "看 [引用1]\n别的行  保持  原样";
    expect(stripQuotePlaceholder(text, 1)).toBe("看\n别的行  保持  原样");
  });

  test("removes every occurrence of the one token", () => {
    expect(stripQuotePlaceholder("[引用2] 和 [引用2]", 2)).toBe("和");
  });
});

describe("stripAllQuotePlaceholders", () => {
  test("pulls every listed quote's tokens", () => {
    const out = stripAllQuotePlaceholders("看 [引用1] 与 [引用2] 结尾", [
      quote(1, "一"),
      quote(2, "二"),
    ]);
    expect(out).toBe("看 与 结尾");
  });
});
