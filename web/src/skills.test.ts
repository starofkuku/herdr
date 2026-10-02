import { describe, expect, test } from "bun:test";
import {
  loadSkillContent,
  loadSkills,
  skillInvocationText,
  type SkillEntry,
} from "./skills";

/** A client that answers from a canned response, or fails when told to. */
function fakeClient(response: unknown, fail = false) {
  return {
    call: async () => {
      if (fail) throw new Error("gateway down");
      return response;
    },
  };
}

describe("skills loader", () => {
  test("parses the skill list defensively", async () => {
    const client = fakeClient({
      skills: {
        available: true,
        skills: [
          { name: "git-commit", description: "Commits changes", source: "user", dir: "/home/u/.claude/skills" },
          { name: "deploy", source: "project", dir: "/w/.claude/skills" },
          { description: "no name is dropped" },
          "not an object",
          null,
        ],
      },
    });
    const state = await loadSkills(client, "p_1");
    expect(state?.available).toBe(true);
    expect(state?.skills.length).toBe(2);
    const commit = state?.skills[0];
    expect(commit?.name).toBe("git-commit");
    expect(commit?.description).toBe("Commits changes");
    expect(commit?.source).toBe("user");
    expect(state?.skills[1].source).toBe("project");
    expect(state?.skills[1].description).toBe("");
  });

  test("treats a missing availability flag as available", async () => {
    const client = fakeClient({ skills: { skills: [] } });
    const state = await loadSkills(client, "p_1");
    expect(state?.available).toBe(true);
  });

  test("resolves to null when the call fails", async () => {
    expect(await loadSkills(fakeClient(null, true), "p_1")).toBeNull();
  });

  test("resolves to null when the envelope is missing", async () => {
    expect(await loadSkills(fakeClient({}), "p_1")).toBeNull();
  });
});

describe("skill content loader", () => {
  test("reads the skill text", async () => {
    const client = fakeClient({
      skill: {
        name: "git-commit",
        path: "/home/u/.claude/skills/git-commit/SKILL.md",
        content: "---\nname: git-commit\n---\n",
        truncated: false,
        size: 30,
      },
    });
    const content = await loadSkillContent(client, "p_1", "git-commit");
    expect(content?.name).toBe("git-commit");
    expect(content?.truncated).toBe(false);
    expect(content?.size).toBe(30);
  });

  test("defaults missing fields rather than failing", async () => {
    const client = fakeClient({ skill: { name: "deploy" } });
    const content = await loadSkillContent(client, "p_1", "deploy");
    expect(content?.content).toBe("");
    expect(content?.truncated).toBe(false);
    expect(content?.size).toBe(0);
  });

  test("resolves to null when the call fails", async () => {
    expect(await loadSkillContent(fakeClient(null, true), "p_1", "x")).toBeNull();
  });
});

describe("skill invocation text", () => {
  test("names the skill and hands over the intent", () => {
    expect(skillInvocationText("git-commit", "stage only the docs")).toBe(
      'Use the "git-commit" skill to: stage only the docs',
    );
  });

  test("stands alone without extra intent", () => {
    expect(skillInvocationText("deploy", "   ")).toBe('Use the "deploy" skill.');
  });
});

/** The entry shape other components build on stays structural. */
test("skill entries keep their source narrow", () => {
  const entry: SkillEntry = {
    name: "x",
    description: "",
    source: "project",
    dir: "/d",
  };
  expect(entry.source).toBe("project");
});
