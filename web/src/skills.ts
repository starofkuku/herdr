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
