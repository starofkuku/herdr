// The agent skills installed on the server, as the picker panel reads them.
//
// Read-only: installing a skill is the agent tooling's job (`npx skills` and
// friends); the panel lists what exists and turns one into a prompt. Each
// loader follows the same contract as `files.ts` — a narrow structural client,
// a defensive parser, and a failure that resolves to "nothing" rather than
// rejecting, because a panel that cannot load is not an error the reader can
// act on.

/** The slice of the gateway client these loaders need. */
interface SkillsClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/** One installed skill. */
export interface SkillEntry {
  /** The name an agent recognises. */
  name: string;
  /** What the skill does, from its frontmatter; empty when absent. */
  description: string;
  /** `user` for home-directory skills, `project` for ones beside the code. */
  source: "user" | "project";
  /** The skills directory it was found in, for the reader's context. */
  dir: string;
}

/** What `skills.list` reports for a pane. */
export interface SkillsState {
  /** False when the pane's agent has no skill system of its own; the shared
   * `.agents` skills still apply, so the list is shown with a note. */
  available: boolean;
  skills: SkillEntry[];
}

/** One skill's text, as the preview shows it. */
export interface SkillContent {
  name: string;
  path: string;
  content: string;
  truncated: boolean;
  size: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseSkill(raw: unknown): SkillEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const name = asString(record.name);
  if (!name) return null;
  const source = record.source === "project" ? "project" : "user";
  return {
    name,
    description: typeof record.description === "string" ? record.description : "",
    source,
    dir: asString(record.dir) ?? "",
  };
}

/** Loads the skills a pane's agent can use. Null when the call fails. */
export async function loadSkills(
  client: SkillsClient,
  paneId: string,
): Promise<SkillsState | null> {
  try {
    const response = await client.call<{ skills?: unknown }>("skills.list", {
      pane_id: paneId,
    });
    const result = response?.skills as Record<string, unknown> | undefined;
    if (!result) return null;
    const rawSkills = Array.isArray(result.skills) ? result.skills : [];
    const skills: SkillEntry[] = [];
    for (const raw of rawSkills) {
      const skill = parseSkill(raw);
      if (skill) skills.push(skill);
    }
    return { available: result.available !== false, skills };
  } catch {
    return null;
  }
}

/** Loads one skill's `SKILL.md` for preview. Null when it cannot be read. */
export async function loadSkillContent(
  client: SkillsClient,
  paneId: string,
  name: string,
): Promise<SkillContent | null> {
  try {
    const response = await client.call<{ skill?: unknown }>("skills.read", {
      pane_id: paneId,
      name,
    });
    const skill = response?.skill as Record<string, unknown> | undefined;
    if (!skill) return null;
    return {
      name: asString(skill.name) ?? name,
      path: asString(skill.path) ?? "",
      content: typeof skill.content === "string" ? skill.content : "",
      truncated: skill.truncated === true,
      size: typeof skill.size === "number" ? skill.size : 0,
    };
  } catch {
    return null;
  }
}

/**
 * The prompt that invokes a skill. Skills are matched by name in conversation
 * rather than exposed as commands, so the invocation says the name and hands
 * over the reader's intent; the agent loads the skill it names.
 */
export function skillInvocationText(name: string, extra: string): string {
  const intent = extra.trim();
  return intent
    ? `Use the "${name}" skill to: ${intent}`
    : `Use the "${name}" skill.`;
}

/**
 * The slash query a draft carries, or null when the composer is not invoking
 * one. A trigger is the message's first character: mid-message slashes stay
 * plain text so a URL or a fraction never opens the picker.
 */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  const rest = draft.slice(1);
  // A space ends the command word: "/git " is a settled invocation, not a query
  // still being typed.
  const word = rest.split(/\s/u, 1)[0] ?? "";
  return word.toLowerCase();
}

/**
 * Whether the draft's slash word matches a known skill exactly, meaning the
 * composer has a settled invocation and the menu can close behind it.
 */
export function slashSettled(draft: string, names: ReadonlySet<string>): boolean {
  const query = slashQuery(draft);
  return query !== null && names.has(query);
}

/** Anything the slash menu can offer: a name with an optional description. */
export interface SlashMenuItem {
  name: string;
  description: string;
}

/**
 * Entries matching a slash query, best matches first: a prefix beats a
 * substring, and names sort before descriptions.
 */
export function filterSlashItems<T extends SlashMenuItem>(
  items: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  const scored: { item: T; rank: number }[] = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    let rank = -1;
    if (name.startsWith(needle)) rank = 0;
    else if (name.includes(needle)) rank = 1;
    else if (item.description.toLowerCase().includes(needle)) rank = 2;
    if (rank >= 0) scored.push({ item, rank });
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.item.name.localeCompare(b.item.name),
  );
  return scored.map((entry) => entry.item);
}

/** Kept for the tests and callers that name it what it is. */
export function filterSkills(
  skills: readonly SkillEntry[],
  query: string,
): SkillEntry[] {
  return filterSlashItems(skills, query);
}

/**
 * The composer's slash menu in one value: the reader's own commands, the
 * skills, and the agent's own commands, each filtered and grouped, with a flat
 * order the keyboard walks across the groups. Custom commands come first: they
 * are the ones this reader reaches for. Entries are capped per group so one
 * long list cannot push the other off the panel.
 */
export function buildSlashMenu(
  skills: readonly SkillEntry[],
  commands: readonly SlashMenuItem[],
  custom: readonly SlashMenuItem[],
  query: string,
  perGroupCap = 8,
): {
  custom: SlashMenuItem[];
  skills: SkillEntry[];
  commands: SlashMenuItem[];
  flat: SlashMenuItem[];
} {
  const customHits = filterSlashItems(custom, query).slice(0, perGroupCap);
  const skillHits = filterSlashItems(skills, query).slice(0, perGroupCap);
  const commandHits = filterSlashItems(commands, query).slice(0, perGroupCap);
  return {
    custom: customHits,
    skills: skillHits,
    commands: commandHits,
    flat: [...customHits, ...skillHits, ...commandHits],
  };
}

/**
 * The message to send: a custom command expands to its text, one invocation
 * per known skill is rewritten into the prompt that names it, and anything
 * else — an agent's own slash command, plain text — passes through untouched.
 * A name the reader defined wins over a skill of the same name.
 */
export function expandSlashMessage(
  message: string,
  skillNames: ReadonlySet<string>,
  customCommands: readonly { name: string; content: string }[],
): string {
  const customByName = new Map(customCommands.map((command) => [command.name, command]));
  return message
    .split("\n")
    .map((line) => {
      if (!line.startsWith("/")) return line;
      const trimmed = line.slice(1);
      const spaceAt = trimmed.search(/\s/u);
      const word = (spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt)).toLowerCase();
      const rest = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1).trim();
      const custom = customByName.get(word);
      if (custom) {
        return rest ? `${custom.content}\n${rest}` : custom.content;
      }
      if (!skillNames.has(word)) return line;
      return skillInvocationText(word, rest);
    })
    .join("\n");
}
