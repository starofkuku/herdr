import { describe, expect, test } from "bun:test";
import {
  expandSlashMessage,
  filterSkills,
  loadSkillContent,
  loadSkills,
  skillInvocationText,
  slashQuery,
  slashSettled,
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

describe("slash trigger", () => {
  const names = new Set(["git-commit", "deploy", "docx-generator"]);

  test("a leading slash is a query; anything else is not", () => {
    expect(slashQuery("/git")).toBe("git");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/GIT-Commit")).toBe("git-commit");
    expect(slashQuery("hello /git")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });

  test("a space settles the word, so the query is only the first token", () => {
    expect(slashQuery("/git only the docs")).toBe("git");
  });

  test("a settled word matches a known skill exactly", () => {
    expect(slashSettled("/git-commit ", names)).toBe(true);
    expect(slashSettled("/git", names)).toBe(false);
    expect(slashSettled("plain text", names)).toBe(false);
  });
});

describe("skill filtering", () => {
  const skills: SkillEntry[] = [
    { name: "git-commit", description: "Commits changes", source: "user", dir: "/a" },
    { name: "deploy", description: "git push and more", source: "user", dir: "/a" },
    { name: "find-skills", description: "Searches skills", source: "project", dir: "/b" },
  ];

  test("prefix matches come before substring matches", () => {
    const hits = filterSkills(skills, "find");
    expect(hits[0]?.name).toBe("find-skills");
    expect(hits.length).toBe(1);
  });

  test("a description match ranks last", () => {
    const hits = filterSkills(skills, "git");
    expect(hits.map((skill) => skill.name)).toEqual(["git-commit", "deploy"]);
  });

  test("an empty query returns every skill, sorted by name", () => {
    const hits = filterSkills(skills, "");
    expect(hits.map((skill) => skill.name)).toEqual(["deploy", "find-skills", "git-commit"]);
  });
});

describe("slash rewriting on send", () => {
  const names = new Set(["git-commit", "deploy"]);
  const custom = [
    { name: "deploy-check", content: "check the deploy pipeline" },
    { name: "report", content: "summarize\nthe report" },
  ];

  test("a known skill with intent becomes the invocation prompt", () => {
    expect(expandSlashMessage("/git-commit only the docs", names, custom)).toBe(
      'Use the "git-commit" skill to: only the docs',
    );
  });

  test("a known skill alone still names itself", () => {
    expect(expandSlashMessage("/deploy", names, custom)).toBe('Use the "deploy" skill.');
  });

  test("an agent-native slash command passes through untouched", () => {
    expect(expandSlashMessage("/compact", names, custom)).toBe("/compact");
  });

  test("only line-initial slashes are rewritten", () => {
    expect(expandSlashMessage("see /deploy docs", names, custom)).toBe("see /deploy docs");
  });

  test("multi-line messages rewrite each invocation line", () => {
    expect(expandSlashMessage("before\n/deploy now\nafter", names, custom)).toBe(
      'before\nUse the "deploy" skill to: now\nafter',
    );
  });

  test("a custom command expands to its text, keeping what follows", () => {
    expect(expandSlashMessage("/report", names, custom)).toBe("summarize\nthe report");
    expect(expandSlashMessage("/deploy-check now", names, custom)).toBe(
      "check the deploy pipeline\nnow",
    );
  });

  test("a custom command wins over a skill of the same name", () => {
    const clash = [{ name: "deploy", content: "ship it" }];
    expect(expandSlashMessage("/deploy fast", names, clash)).toBe("ship it\nfast");
  });
});
