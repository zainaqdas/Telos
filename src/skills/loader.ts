import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseToml } from "../config/toml.ts";
import { validateSkill, type SkillDefinition } from "./schema.ts";
import { BUILTIN_SKILLS } from "./builtins.ts";

/**
 * Skill discovery (Parts 34, 70–71). Skills are TOML files containing
 * [[skill]] tables. Sources, in ascending precedence:
 *   builtin → global (~/.synergon/skills/) → project (.project-agent/skills/)
 * A project skill with the same name as a global/builtin one wins (Part 71).
 */

export function loadSkills(projectRoot: string, globalDir = join(homedir(), ".synergon", "skills")): SkillDefinition[] {
  const byName = new Map<string, SkillDefinition>();

  const ingest = (raw: unknown, source: SkillDefinition["source"], file: string): void => {
    const list = Array.isArray(raw) ? raw : [raw];
    for (const entry of list) {
      try {
        const skill = validateSkill(entry, source);
        byName.set(skill.name, skill);
      } catch (err) {
        // A malformed skill degrades to a warning, never blocks the session.
        console.error(`warning: ${file}: ${(err as Error).message}`);
      }
    }
  };

  // Built-ins first (lowest precedence).
  for (const s of BUILTIN_SKILLS) byName.set(s.name, s);

  // Global skills.
  if (globalDir && existsSync(globalDir)) {
    for (const file of tomlFiles(globalDir)) {
      try {
        const parsed = parseToml(readFileSync(join(globalDir, file), "utf8"));
        const raw = parsed["skill"] ?? parsed["skills"];
        ingest(raw, "global", `global/${file}`);
      } catch (err) {
        console.error(`warning: global skill ${file}: ${(err as Error).message}`);
      }
    }
  }

  // Project skills (highest precedence).
  const projectDir = join(projectRoot, ".project-agent", "skills");
  if (existsSync(projectDir)) {
    for (const file of tomlFiles(projectDir)) {
      try {
        const parsed = parseToml(readFileSync(join(projectDir, file), "utf8"));
        const raw = parsed["skill"] ?? parsed["skills"];
        ingest(raw, "project", `project/${file}`);
      } catch (err) {
        console.error(`warning: project skill ${file}: ${(err as Error).message}`);
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function tomlFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".toml")).sort();
  } catch {
    return [];
  }
}
