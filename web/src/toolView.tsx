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

/** One tool's presentation: the glyph ZCode gives that category, and its label. */
export interface ToolVisual {
  icon: LucideIcon;
  label: string;
}

/** The thinking row uses the same anatomy as a tool row, with its own glyph. */
export const ReasoningVisual: ToolVisual = { icon: Brain, label: "thinking" };

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
    return { icon: SquareTerminal, label: "run" };
  }
  if (k === "patchapply" || matches(n, ["apply_patch", "edit", "write", "str_replace"])) {
    return { icon: Pencil, label: "edit" };
  }
  if (k === "websearch" || matches(n, ["web_search", "search", "explore", "grep"])) {
    return { icon: Search, label: "search" };
  }
  if (matches(n, ["read", "view", "cat"])) {
    // ZCode gives reads the magnifier too: reading is looking, not changing.
    return { icon: Search, label: "read" };
  }
  if (
    k === "spawnagent" ||
    k === "waitagent" ||
    k === "interruptagent" ||
    k === "followuptask" ||
    matches(n, ["spawn_agent", "agent", "task", "close_agent", "interrupt_agent"])
  ) {
    return { icon: Bot, label: "agent" };
  }
  if (matches(n, ["todo"])) {
    return { icon: ListTodo, label: "todo" };
  }
  if (k === "mcptool" || n.startsWith("mcp__") || n.includes("__")) {
    return { icon: Plug, label: "mcp" };
  }
  return { icon: Wrench, label: "tool" };
}
