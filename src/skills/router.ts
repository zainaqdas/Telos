import type { RepoProfile } from "../context/profile.ts";
import type { EventLog } from "../events/log.ts";
import { reduce } from "../events/state.ts";
import type { SkillDefinition } from "./schema.ts";

/**
 * Deterministic-first skill routing (Parts 34–35):
 *
 *   explicit user mention > trigger match > file-pattern evidence >
 *   framework evidence > command evidence > confidence check
 *
 * No LLM classifier is called on the happy path; the hook exists for
 * genuine ambiguity (Part 35) but stays unused until a real workload needs it.
 */

export interface SkillMatch {
  skill: SkillDefinition;
  score: number;
  reasons: string[];
}

export interface SkillRouterDeps {
  skills: SkillDefinition[];
  events: EventLog;
  profile?: RepoProfile;
  /** Optional ambiguity classifier (small LLM); not used by deterministic tiers. */
  classifyAmbiguous?: (instruction: string, candidates: SkillDefinition[]) => Promise<string[]>;
}

const THRESHOLD = 2;

export class SkillRouter {
  private readonly deps: SkillRouterDeps;

  constructor(deps: SkillRouterDeps) {
    this.deps = deps;
  }

  /** Definitions known to the router (for constraint lookups). */
  get skills(): SkillDefinition[] {
    return this.deps.skills;
  }

  /** Route one user instruction to skills that should activate. */
  async route(instruction: string): Promise<SkillMatch[]> {
    const lowered = instruction.toLowerCase();
    const matches: SkillMatch[] = [];

    for (const skill of this.deps.skills) {
      if (!skill.autoInvoke) continue;
      const reasons: string[] = [];
      let score = 0;

      // Tier 1: explicit mention by name — decisive.
      if (lowered.includes(skill.name.toLowerCase())) {
        score += 10;
        reasons.push("explicitly named");
      }

      // Tier 2: trigger phrase match — strong.
      for (const trigger of skill.triggers) {
        if (lowered.includes(trigger.toLowerCase())) {
          score += 3;
          reasons.push(`trigger "${trigger}"`);
        }
      }

      // Tier 3: file-pattern evidence from the REPO profile only. Matching
      // the instruction text here caused false activations (e.g. the bugfix
      // skill activating for a greenfield build that merely mentions
      // "test/app.test.js"), and an unsatisfiable reproduce checklist can
      // block the gate forever on tasks that have no bug at all.
      if (this.deps.profile) {
        const profileText = `${this.deps.profile.entryPoints.join(" ")} ${this.deps.profile.keyDirs.join(" ")}`;
        for (const pattern of skill.filePatterns) {
          const stem = pattern.replace(/[*]/g, "").replace(/\.([a-z]+)$/, "");
          if (stem && profileText.includes(stem)) {
            score += 2;
            reasons.push(`file evidence "${pattern}"`);
            break;
          }
        }

        // Tier 4: framework evidence.
        for (const fw of skill.frameworks) {
          if (this.deps.profile.frameworks.includes(fw)) {
            score += 2;
            reasons.push(`framework ${fw}`);
            break;
          }
        }

        // Tier 5: command evidence (repo scripts like "test"/"prisma").
        for (const cmd of skill.commands) {
          const head = cmd.split(" ")[0]!.toLowerCase();
          if (this.deps.profile.scripts["test"]?.includes(head) || lowered.includes(head)) {
            score += 1;
            reasons.push(`command "${head}"`);
            break;
          }
        }
      }

      if (score >= THRESHOLD) {
        matches.push({ skill, score, reasons });
      }
    }

    matches.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

    // Ambiguity hook: only when deterministic tiers disagree or under-select.
    if (matches.length === 0 && this.deps.classifyAmbiguous) {
      const names = await this.deps.classifyAmbiguous(instruction, this.deps.skills.filter((s) => s.autoInvoke));
      for (const name of names) {
        const skill = this.deps.skills.find((s) => s.name === name);
        if (skill) matches.push({ skill, score: 1, reasons: ["ambiguity classifier"] });
      }
    }

    return matches.slice(0, 3); // cap concurrent activations per instruction
  }

  /**
   * Activate a skill: lifecycle event + checklist requirements registered in
   * the event log, so the Completion Gate enforces them (Part 37).
   */
  activate(match: SkillMatch): void {
    const { skill, reasons } = match;
    // Idempotent per task: re-routing to an already-active skill is a no-op.
    const state = reduce(this.deps.events.readAll());
    if (state.skills.has(skill.name)) return;
    this.deps.events.append("skill_activated", { skill: skill.name, source: skill.source, reasons });
    for (const item of skill.checklist) {
      this.deps.events.append("requirement_added", {
        id: item.requirementId,
        description: item.description,
        required: item.required,
        skill: skill.name,
      });
    }
  }

  /** /new (Part 61): rebind to the fresh task's event log — skill activation
   *  dedup and checklist registration must follow the CURRENT task. */
  attachEvents(events: EventLog): void {
    (this.deps as { events: EventLog }).events = events;
  }
}
