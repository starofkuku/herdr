import { describe, expect, test } from "bun:test";
import { isOpen, parseTodos, shouldShowPanel, todoProgress } from "./todos";

describe("parseTodos", () => {
  test("keeps well-formed tasks", () => {
    expect(
      parseTodos([
        { id: 1, subject: "do a thing", status: "pending" },
        { id: 2, subject: "done already", status: "completed" },
      ]),
    ).toEqual([
      { id: 1, subject: "do a thing", status: "pending" },
      { id: 2, subject: "done already", status: "completed" },
    ]);
  });

  test("drops entries missing an id, subject, or status", () => {
    expect(
      parseTodos([
        { subject: "no id", status: "pending" },
        { id: 2, status: "pending" },
        { id: 3, subject: "no status" },
        { id: 4, subject: "kept", status: "pending" },
      ]),
    ).toEqual([{ id: 4, subject: "kept", status: "pending" }]);
  });

  test("returns nothing for anything that is not a list", () => {
    for (const value of [undefined, null, "todos", {}, 7]) {
      expect(parseTodos(value)).toEqual([]);
    }
  });

  test("keeps a status the panel does not recognise", () => {
    // The agent owns the vocabulary; an unknown status is still a task.
    expect(parseTodos([{ id: 1, subject: "odd", status: "blocked" }])).toEqual([
      { id: 1, subject: "odd", status: "blocked" },
    ]);
  });
});

describe("todoProgress", () => {
  test("counts completed and in-flight separately", () => {
    const progress = todoProgress([
      { id: 1, subject: "a", status: "completed" },
      { id: 2, subject: "b", status: "in_progress" },
      { id: 3, subject: "c", status: "pending" },
    ]);
    expect(progress).toEqual({ total: 3, completed: 1, inProgress: 1 });
  });

  test("is all zeroes for an empty list", () => {
    expect(todoProgress([])).toEqual({ total: 0, completed: 0, inProgress: 0 });
  });

  test("treats an unknown status as open", () => {
    expect(todoProgress([{ id: 1, subject: "a", status: "blocked" }])).toEqual({
      total: 1,
      completed: 0,
      inProgress: 0,
    });
  });
});

describe("isOpen", () => {
  test("only completed is closed", () => {
    expect(isOpen({ id: 1, subject: "a", status: "completed" })).toBe(false);
    expect(isOpen({ id: 1, subject: "a", status: "pending" })).toBe(true);
    expect(isOpen({ id: 1, subject: "a", status: "in_progress" })).toBe(true);
  });
});

describe("shouldShowPanel", () => {
  const task = (status: string, id = 1) => ({ id, subject: "x", status }) as never;

  test("空列表不显示", () => {
    expect(shouldShowPanel([])).toBe(false);
  });

  test("全部完成就隐藏", () => {
    expect(shouldShowPanel([task("completed", 1), task("completed", 2)])).toBe(false);
  });

  test("还有未完成就显示", () => {
    expect(shouldShowPanel([task("completed", 1), task("pending", 2)])).toBe(true);
    expect(shouldShowPanel([task("in_progress", 1)])).toBe(true);
  });
});
