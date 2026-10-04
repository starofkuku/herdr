// Custom slash commands the reader defines for themselves, stored in this
// browser. A command is a name and the text it stands for: picking it from the
// slash menu drops the text into the composer, and sending `/name` expands the
// same way, so a long prompt you keep retyping becomes two keystrokes.
//
// These live beside the settings rather than on the server on purpose: a
// prompt template is presentation-layer preference, not a session fact, and it
// should keep working when the server is being restarted.

/** One reader-defined slash command. */
export interface CustomCommand {
  /** The command without its slash, lowercase, as typed to invoke it. */
  name: string;
  /** The text the command stands for. */
  content: string;
}

const STORAGE_KEY = "herdr-custom-commands";
export const MAX_CUSTOM_COMMANDS = 100;
export const MAX_COMMAND_BACKUP_BYTES = 5 * 1024 * 1024;
const BACKUP_FORMAT = "herdr-custom-commands";

/**
 * The shape a name must take: no slash, no spaces, lowercase. Names come from
 * free-text input, so they are normalized rather than rejected.
 */
export function normalizeCustomCommandName(raw: string): string {
  return raw
    .trim()
    .replace(/[\s/]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
}

/** The first line of a command's text, for the one-row menu listing. */
export function customCommandSummary(content: string): string {
  const firstLine = content.split("\n", 1)[0] ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

/** Reads the stored commands; anything unparsable is dropped, not fatal. */
export function loadCustomCommands(): CustomCommand[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const commands: CustomCommand[] = [];
    for (const entry of parsed) {
      const record = entry as Partial<CustomCommand>;
      const name =
        typeof record.name === "string" ? normalizeCustomCommandName(record.name) : "";
      const content = typeof record.content === "string" ? record.content : "";
      if (!name || !content.trim()) continue;
      commands.push({ name, content });
      if (commands.length >= MAX_CUSTOM_COMMANDS) break;
    }
    return commands;
  } catch {
    return [];
  }
}

/** Reports failed writes so importing never claims an unsaved backup succeeded. */
export function saveCustomCommands(commands: readonly CustomCommand[]): boolean {
  if (commands.length > MAX_CUSTOM_COMMANDS) return false;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(commands),
    );
    return true;
  } catch {
    return false;
  }
}

/** Portable backups keep multiline command content exactly as stored. */
export function serializeCustomCommands(commands: readonly CustomCommand[]): string {
  return JSON.stringify({ format: BACKUP_FORMAT, version: 1, commands }, null, 2) + "\n";
}

/** Validate the whole file before changing any saved commands. */
export function parseCustomCommandsBackup(text: string): CustomCommand[] {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error("文件不是有效的 JSON，请选择导出的快捷命令文件。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("文件格式不正确，请选择导出的快捷命令文件。");
  }
  const backup = value as Record<string, unknown>;
  if (backup.format !== BACKUP_FORMAT || backup.version !== 1 || !Array.isArray(backup.commands)) {
    throw new Error("不支持此文件格式或版本，请选择导出的快捷命令文件。");
  }
  if (backup.commands.length > MAX_CUSTOM_COMMANDS) {
    throw new Error(`一个文件最多包含 ${MAX_CUSTOM_COMMANDS} 条命令。`);
  }
  return backup.commands.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`第 ${index + 1} 条命令格式不正确。`);
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? normalizeCustomCommandName(record.name) : "";
    if (!name || typeof record.content !== "string" || !record.content.trim()) {
      throw new Error(`第 ${index + 1} 条命令必须包含有效的命令名和内容。`);
    }
    return { name, content: record.content };
  });
}

/** Existing names win; a repeated name in the file is imported only once. */
export function mergeCustomCommands(
  existing: readonly CustomCommand[],
  imported: readonly CustomCommand[],
): { commands: CustomCommand[]; added: number; skipped: number } {
  const commands = [...existing];
  const names = new Set(existing.map((command) => command.name));
  let skipped = 0;
  for (const command of imported) {
    if (names.has(command.name)) {
      skipped += 1;
      continue;
    }
    names.add(command.name);
    commands.push(command);
  }
  if (commands.length > MAX_CUSTOM_COMMANDS) {
    throw new Error(`合并后超过 ${MAX_CUSTOM_COMMANDS} 条命令，未导入。请先删除不需要的命令。`);
  }
  return {
    commands: commands.sort((a, b) => a.name.localeCompare(b.name)),
    added: commands.length - existing.length,
    skipped,
  };
}
