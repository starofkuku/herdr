import { describe, expect, test } from "bun:test";
import { parseInteractionRequest } from "./interaction";

const valid = {
  source: "codex:permission-hook",
  request_id: "req-1",
  kind: "question",
  title: "Which approach?",
  questions: [
    {
      id: "q1",
      header: "Approach",
      question: "Which one?",
      options: [
        { id: "a", label: "Refactor", description: "Cleaner" },
        { id: "b", label: "Patch" },
      ],
    },
  ],
};

describe("parseInteractionRequest", () => {
  test("parses a well-formed request", () => {
    const parsed = parseInteractionRequest(valid);
    expect(parsed?.requestId).toBe("req-1");
    expect(parsed?.kind).toBe("question");
    expect(parsed?.questions).toHaveLength(1);
    expect(parsed?.questions[0].options.map((o) => o.id)).toEqual(["a", "b"]);
  });

  test("returns null when the request is absent", () => {
    expect(parseInteractionRequest(undefined)).toBeNull();
    expect(parseInteractionRequest(null)).toBeNull();
  });

  test("returns null without a source or request id", () => {
    // Both are needed: the source routes the answer, the id matches it. A
    // request missing either cannot be answered, so offering it would be worse
    // than falling back to the terminal.
    expect(parseInteractionRequest({ ...valid, source: undefined })).toBeNull();
    expect(parseInteractionRequest({ ...valid, request_id: "" })).toBeNull();
  });

  test("drops options missing an id or label", () => {
    const parsed = parseInteractionRequest({
      ...valid,
      questions: [
        {
          ...valid.questions[0],
          options: [
            { id: "a", label: "Good" },
            { label: "no id" },
            { id: "c" },
          ],
        },
      ],
    });
    expect(parsed?.questions[0].options.map((o) => o.id)).toEqual(["a"]);
  });

  test("drops a question whose options are all unusable", () => {
    // A choice with nothing to choose is not answerable through the UI.
    const parsed = parseInteractionRequest({
      ...valid,
      questions: [{ id: "q1", question: "?", options: [{ label: "no id" }] }],
    });
    expect(parsed).toBeNull();
  });

  test("keeps usable questions when a sibling is malformed", () => {
    const parsed = parseInteractionRequest({
      ...valid,
      questions: [
        { id: "q1", question: "keep me", options: [{ id: "a", label: "A" }] },
        { id: "q2", options: [{ id: "b", label: "B" }] },
      ],
    });
    expect(parsed?.questions.map((q) => q.id)).toEqual(["q1"]);
  });

  test("normalises kind and boolean flags", () => {
    const parsed = parseInteractionRequest({
      ...valid,
      kind: "approval",
      questions: [
        { ...valid.questions[0], multi_select: true, allow_custom: true },
      ],
    });
    expect(parsed?.kind).toBe("approval");
    expect(parsed?.questions[0].multiSelect).toBe(true);
    expect(parsed?.questions[0].allowCustom).toBe(true);
  });

  test("an unknown kind falls back to question rather than failing", () => {
    const parsed = parseInteractionRequest({ ...valid, kind: "something-new" });
    expect(parsed?.kind).toBe("question");
  });

  test("omits absent optional text instead of emitting empty strings", () => {
    const parsed = parseInteractionRequest({
      source: "s",
      request_id: "r",
      questions: [{ id: "q", question: "?", options: [{ id: "a", label: "A" }] }],
    });
    expect(parsed?.title).toBeUndefined();
    expect(parsed?.summary).toBeUndefined();
    expect(parsed?.questions[0].header).toBeUndefined();
    expect(parsed?.questions[0].options[0].description).toBeUndefined();
  });
});
