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
const MAX_COMMANDS = 100;

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
      if (commands.length >= MAX_COMMANDS) break;
    }
    return commands;
  } catch {
    return [];
  }
}

/** Persists the commands; a storage failure is swallowed, the list still works. */
export function saveCustomCommands(commands: readonly CustomCommand[]): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(commands.slice(0, MAX_COMMANDS)),
    );
  } catch {
    // A full or blocked localStorage keeps the session's copy; the next save
    // tries again.
  }
}
