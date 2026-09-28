/*
 * The icon and label a tool call shows, following ZCode's mapping: every
 * category of tool carries its own glyph (terminal for commands, pencil for
 * edits, magnifier for reads and searches, bot for subagents…), so a scan down
 * the conversation reads as a sequence of actions rather than of "tool" rows.
 */

import {
  Bot,
  Brain,
  ListTodo,
  Pencil,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { lineDiff, type DiffRow } from "./textDiff";

/** One tool's presentation: the glyph ZCode gives that category, and its label. */
export interface ToolVisual {
  icon: LucideIcon;
  label: string;
}

/** Whether a tool call counts as an edit, which is what carries change stats. */
export function isEditVisual(visual: ToolVisual): boolean {
  return visual.icon === Pencil;
}

/** Whether a call runs a command, whose payload is its output. */
export function isTerminalVisual(visual: ToolVisual): boolean {
  return visual.icon === SquareTerminal;
}

/** Whether a call reads or searches, whose payload is likewise output. */
export function isReadVisual(visual: ToolVisual): boolean {
  return visual.icon === Search;
}

/** One line of an edit rendered as a diff. */
export interface DiffLine {
  kind: "add" | "remove" | "context" | "meta";
  text: string;
}

/*
 * The key lists ZCode's own fallback reader consults, in its order: a path, a
 * whole file's content (a create/write), and the two sides of an edit. A
 * transcript records its edit in whichever of these its tool chose, and the
 * same file therefore renders the same way wherever it came from.
 */
const PATH_KEYS = ["path", "file_path", "filePath", "file", "filepath", "filename", "target_file"];
const CONTENT_KEYS = [
  "content",
  "newText",
  "new_text",
  "newString",
  "new_string",
  "text",
  "fileContent",
  "file_content",
  "contents",
  "code",
];
const OLD_KEYS = ["oldText", "old_string", "oldString", "before", "old_content", "oldContent"];
const NEW_KEYS = [
  "newText",
  "new_string",
  "newString",
  "after",
  "new_content",
  "newContent",
  "content",
];

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** A whole file being written: content with no previous side to diff against. */
export interface WrittenFile {
  path: string | null;
  content: string;
}

/** The shape an edit call's payload takes, once its keys are read. */
export type EditShape =
  | { kind: "patch"; text: string }
  | { kind: "pairs"; pairs: { old: string; new: string }[] }
  | { kind: "write"; file: WrittenFile };

/** Reads one old/new pair off a record, requiring both sides as ZCode does. */
function pairFrom(record: Record<string, unknown>): { old: string; new: string } | null {
  const oldText = firstString(record, OLD_KEYS);
  const newText = firstString(record, NEW_KEYS);
  if (oldText === undefined || newText === undefined) return null;
  return { old: oldText, new: newText };
}

/**
 * The old/new pairs an edit descends from, in any recorded shape: a single
 * pair, or an `edits` array of them — Claude Code's MultiEdit and ZCode's own
 * Edit tool both record the array, and the inner keys come camelCased from the
 * latter.
 */
function editPairs(args: unknown): { old: string; new: string }[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const pairs: { old: string; new: string }[] = [];
  const direct = pairFrom(record);
  if (direct) pairs.push(direct);
  const edits = record.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === "object") {
        const pair = pairFrom(edit as Record<string, unknown>);
        if (pair) pairs.push(pair);
      }
    }
  }
  return pairs;
}

function patchText(call: { input?: string; arguments?: unknown }): string | null {
  if (call.input && call.input.trim()) return call.input;
  const args = call.arguments;
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    for (const key of ["patch", "input"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}

/**
 * Classifies an edit call's payload, in the order ZCode's fallback reader
 * tries them: patch text first (it is exact), then an old/new pair, then a
 * whole file's content. Null when the transcript carries none of them — the
 * caller then shows the raw payload, which is also all ZCode can do.
 */
export function editShape(call: { input?: string; arguments?: unknown }): EditShape | null {
  const patch = patchText(call);
  if (patch) {
    const lines = splitPatch(patch);
    if (lines.some((line) => line.kind === "add" || line.kind === "remove")) {
      return { kind: "patch", text: patch };
    }
  }
  const pairs = editPairs(call.arguments);
  if (pairs.length > 0) {
    return { kind: "pairs", pairs };
  }
  const args = call.arguments;
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    const content = firstString(record, CONTENT_KEYS);
    if (content !== undefined && content.length > 0) {
      return { kind: "write", file: { path: firstString(record, PATH_KEYS) ?? null, content } };
    }
  }
  return null;
}

/** A whole file being written is all additions, and reads as its own label. */
export function toolOperationLabel(call: { input?: string; arguments?: unknown }): string | null {
  const shape = editShape(call);
  return shape?.kind === "write" ? "写入" : null;
}

function splitPatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("*** ") || raw.startsWith("@@") || raw.startsWith("+++") || raw.startsWith("---")) {
      lines.push({ kind: "meta", text: raw });
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "remove", text: raw.slice(1) });
    } else {
      lines.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw });
    }
  }
  // A final newline in the patch reads as padding, not as a context line.
  while (lines.length > 0 && lines[lines.length - 1].kind === "context" && !lines[lines.length - 1].text) {
    lines.pop();
  }
  return lines;
}

function toDiffLine(row: DiffRow): DiffLine {
  return { kind: row.kind, text: row.text };
}

/** The diff of an edit call: its rendered rows, plus how many were omitted. */
export interface EditDiff {
  lines: DiffLine[];
  omitted: number;
}

/**
 * The diff lines of an edit call, from whichever shape the transcript carries.
 * A patch is classified line by line; an old/new pair (or several) is diffed
 * with the LCS port in `textDiff`, so unchanged lines stay context and the
 * tinted rows are exactly the changed ones; a written file is all additions.
 * Null when the call carries no diffable payload — the caller shows raw then.
 */
export function editDiffLines(call: {
  input?: string;
  arguments?: unknown;
}): EditDiff | null {
  const shape = editShape(call);
  if (!shape) return null;
  if (shape.kind === "patch") {
    return { lines: splitPatch(shape.text), omitted: 0 };
  }
  if (shape.kind === "write") {
    const diff = lineDiff(null, shape.file.content);
    return { lines: diff.rows.map(toDiffLine), omitted: diff.omitted };
  }
  const lines: DiffLine[] = [];
  let omitted = 0;
  for (const [index, pair] of shape.pairs.entries()) {
    // A separator keeps two blocks of one file apart.
    if (index > 0) lines.push({ kind: "meta", text: "⋯" });
    const diff = lineDiff(pair.old, pair.new);
    lines.push(...diff.rows.map(toDiffLine));
    omitted += diff.omitted;
  }
  return { lines, omitted };
}

/**
 * How many lines a call added and removed, when that can be told.
 *
 * The server's counts (from Codex's patch stats or the patch text) are exact,
 * so they win when present. Otherwise the same LCS the diff uses produces
 * them, which keeps the number and the picture consistent: an edit changing
 * three lines reads +3 -3, not the size of the blocks it was cut from.
 */
export function toolChangeStats(call: {
  added?: number;
  removed?: number;
  input?: string;
  arguments?: unknown;
}): { added: number; removed: number } | null {
  if (typeof call.added === "number" || typeof call.removed === "number") {
    return { added: call.added ?? 0, removed: call.removed ?? 0 };
  }
  const shape = editShape(call);
  if (!shape) return null;
  if (shape.kind === "patch") {
    const lines = splitPatch(shape.text);
    const added = lines.filter((line) => line.kind === "add").length;
    const removed = lines.filter((line) => line.kind === "remove").length;
    return added + removed > 0 ? { added, removed } : null;
  }
  if (shape.kind === "write") {
    const diff = lineDiff(null, shape.file.content);
    return diff.stat.added > 0 ? diff.stat : null;
  }
  let added = 0;
  let removed = 0;
  for (const pair of shape.pairs) {
    const stat = lineDiff(pair.old, pair.new).stat;
    added += stat.added;
    removed += stat.removed;
  }
  return added + removed > 0 ? { added, removed } : null;
}

/** The thinking row uses the same anatomy as a tool row, with its own glyph. */
export const ReasoningVisual: ToolVisual = { icon: Brain, label: "思考" };

function matches(value: string | undefined, patterns: string[]): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return patterns.some((pattern) => lower === pattern || lower.startsWith(pattern));
}

/**
 * Picks the visual for one tool call.
 *
 * `kind` is the server's normalised category (the parser's variant name in
 * lower case, for example `execcommand`); `name` is the agent's own tool name.
 * The kind is authoritative when it is specific; the name covers agents whose
 * calls parse as `unknown` and the MCP `server__tool` naming scheme.
 *
 * Labels are ZCode's own (终端/编辑/读取/搜索/子智能体/待办), so the fold reads
 * the way its history does.
 */
export function toolVisual(kind: string | undefined, name: string | undefined): ToolVisual {
  const k = (kind ?? "").toLowerCase();
  const n = name ?? "";

  if (
    k === "execcommand" ||
    k === "codemode" ||
    k === "shellhook" ||
    matches(n, ["exec", "shell", "bash", "write_stdin", "run_command"])
  ) {
    return { icon: SquareTerminal, label: "终端" };
  }
  // TodoWrite and friends are checked before the edit patterns: a substring
  // match on "write" would file a todo list under edits, which is the exact
  // mistake ZCode's own resolver comments about.
  if (matches(n, ["todo"])) {
    return { icon: ListTodo, label: "待办" };
  }
  if (k === "patchapply" || matches(n, ["apply_patch", "edit", "write", "str_replace"])) {
    return { icon: Pencil, label: "编辑" };
  }
  if (k === "websearch" || matches(n, ["web_search", "search", "explore", "grep"])) {
    return { icon: Search, label: "搜索" };
  }
  if (matches(n, ["read", "view", "cat"])) {
    // ZCode reads with the magnifier too: reading is looking, not changing.
    return { icon: Search, label: "读取" };
  }
  if (
    k === "spawnagent" ||
    k === "waitagent" ||
    k === "interruptagent" ||
    k === "followuptask" ||
    matches(n, ["spawn_agent", "agent", "task", "close_agent", "interrupt_agent"])
  ) {
    return { icon: Bot, label: "子智能体" };
  }
  if (k === "mcptool" || n.startsWith("mcp__") || n.includes("__")) {
    return { icon: Plug, label: "MCP" };
  }
  return { icon: Wrench, label: "工具" };
}
