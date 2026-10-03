import { describe, expect, test } from "bun:test";
import { commandsForAgent } from "./agentCommands";
import { buildSlashMenu } from "./skills";
import type { SkillEntry } from "./skills";

describe("agent command tables", () => {
  test("claude, codex, zcode, and pi each get their curated set", () => {
    const claude = commandsForAgent("claude");
    const codex = commandsForAgent("codex");
    const zcode = commandsForAgent("zcode");
    const pi = commandsForAgent("pi");
    expect(claude.map((command) => command.name)).toContain("compact");
    expect(claude.map((command) => command.name)).toContain("resume");
    expect(codex.map((command) => command.name)).toContain("diff");
    expect(zcode.map((command) => command.name)).toContain("compact");
    expect(zcode.map((command) => command.name)).toContain("dwf");
    expect(pi.map((command) => command.name)).toContain("compact");
    expect(pi.map((command) => command.name)).toContain("scoped-models");
    for (const command of [...claude, ...codex, ...zcode, ...pi]) {
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  test("unknown agents get none rather than guesses", () => {
    expect(commandsForAgent("amp")).toEqual([]);
    expect(commandsForAgent(undefined)).toEqual([]);
  });
});

describe("grouped slash menu", () => {
  const skills: SkillEntry[] = [
    { name: "git-commit", description: "Commits", source: "user", dir: "/a" },
    { name: "deploy", description: "", source: "project", dir: "/b" },
  ];
  const commands = [
    { name: "compact", description: "压缩历史" },
    { name: "model", description: "切换模型" },
  ];
  const custom = [
    { name: "deploy-check", description: "check the deploy pipeline" },
  ];

  test("an empty query shows custom first, then skills, then commands", () => {
    const menu = buildSlashMenu(skills, commands, custom, "");
    expect(menu.custom.map((item) => item.name)).toEqual(["deploy-check"]);
    expect(menu.skills.map((skill) => skill.name)).toEqual(["deploy", "git-commit"]);
    expect(menu.commands.map((command) => command.name)).toEqual(["compact", "model"]);
    expect(menu.flat.length).toBe(5);
    expect(menu.flat[0]?.name).toBe("deploy-check");
    expect(menu.flat[1]?.name).toBe("deploy");
    expect(menu.flat[3]?.name).toBe("compact");
  });

  test("a query narrows each group independently", () => {
    const menu = buildSlashMenu(skills, commands, custom, "comp");
    expect(menu.custom).toEqual([]);
    expect(menu.skills).toEqual([]);
    expect(menu.commands.map((command) => command.name)).toEqual(["compact"]);
  });

  test("a substring of a skill name still matches that skill", () => {
    const menu = buildSlashMenu(skills, commands, custom, "com");
    expect(menu.skills.map((skill) => skill.name)).toEqual(["git-commit"]);
    expect(menu.commands.map((command) => command.name)).toEqual(["compact"]);
  });

  test("a custom command matches its own summary text", () => {
    const menu = buildSlashMenu(skills, commands, custom, "pipeline");
    expect(menu.custom.map((item) => item.name)).toEqual(["deploy-check"]);
    expect(menu.flat.length).toBe(1);
  });

  test("groups cap independently so one cannot push the other off", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `skill-${i}`,
      description: "",
      source: "user" as const,
      dir: "/a",
    }));
    const menu = buildSlashMenu(many, commands, custom, "", 8);
    expect(menu.custom.length).toBe(1);
    expect(menu.skills.length).toBe(8);
    expect(menu.commands.length).toBe(2);
  });

  test("no matches anywhere is an empty menu, not an error", () => {
    const menu = buildSlashMenu(skills, commands, custom, "zzz");
    expect(menu.flat).toEqual([]);
  });
});
