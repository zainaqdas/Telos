/**
 * Skill schema (Parts 34, 36–38). A skill is operational infrastructure:
 * metadata for deterministic routing, checklists that become Completion Gate
 * requirements, and constraints the runtime enforces. Validation is
 * hand-rolled (zero deps) and normalizes on load.
 */

export type ConstraintSeverity = "advisory" | "required" | "blocking";

export interface SkillConstraint {
  /** Machine-readable rule id, e.g. "before_db_migration". */
  id: string;
  description: string;
  /** Which tool must not run before the constraint's verification exists. */
  beforeTool: string;
  /** Requirement id that, when satisfied, discharges the constraint. */
  requiresRequirement: string;
  severity: ConstraintSeverity;
}

export interface SkillChecklistItem {
  /** Stable requirement id fed to the Completion Gate, e.g. "react-verify-behavior". */
  requirementId: string;
  description: string;
  required: boolean;
}

export interface SkillDefinition {
  name: string;
  description: string;
  triggers: string[];
  frameworks: string[];
  filePatterns: string[];
  commands: string[];
  autoInvoke: boolean;
  priority: "low" | "normal" | "high";
  /** Checklist items that become runtime requirements on activation. */
  checklist: SkillChecklistItem[];
  constraints: SkillConstraint[];
  /** Where it was found, for precedence and audit. */
  source: "builtin" | "project" | "global";
}

function strArray(v: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(v)) return fallback;
  return v.filter((x): x is string => typeof x === "string");
}

export function validateSkill(raw: unknown, source: SkillDefinition["source"]): SkillDefinition {
  if (typeof raw !== "object" || raw === null) throw new Error(`skill: expected table, got ${typeof raw}`);
  const r = raw as Record<string, unknown>;

  const name = typeof r["name"] === "string" && r["name"].trim() ? r["name"].trim() : (() => { throw new Error("skill: name is required"); })();
  const description = typeof r["description"] === "string" ? r["description"] : "";
  if (!description) throw new Error(`skill ${name}: description is required`);

  const priority = r["priority"] === "high" || r["priority"] === "low" ? r["priority"] : "normal";

  const checklistRaw = Array.isArray(r["checklist"]) ? (r["checklist"] as unknown[]) : [];
  const checklist: SkillChecklistItem[] = [];
  for (const item of checklistRaw) {
    if (typeof item !== "object" || item === null) throw new Error(`skill ${name}: checklist items must be tables`);
    const c = item as Record<string, unknown>;
    const id = typeof c["requirement_id"] === "string" ? c["requirement_id"] : "";
    const desc = typeof c["description"] === "string" ? c["description"] : "";
    if (!id || !desc) throw new Error(`skill ${name}: checklist items need requirement_id and description`);
    checklist.push({ requirementId: id, description: desc, required: c["required"] !== false });
  }

  const constraintsRaw = Array.isArray(r["constraints"]) ? (r["constraints"] as unknown[]) : [];
  const constraints: SkillConstraint[] = [];
  for (const item of constraintsRaw) {
    if (typeof item !== "object" || item === null) throw new Error(`skill ${name}: constraints must be tables`);
    const c = item as Record<string, unknown>;
    const id = typeof c["id"] === "string" ? c["id"] : "";
    const beforeTool = typeof c["before_tool"] === "string" ? c["before_tool"] : "";
    const requires = typeof c["requires_requirement"] === "string" ? c["requires_requirement"] : "";
    if (!id || !beforeTool || !requires) {
      throw new Error(`skill ${name}: constraints need id, before_tool, and requires_requirement`);
    }
    const sev = c["severity"] === "advisory" || c["severity"] === "blocking" ? c["severity"] : "required";
    constraints.push({
      id,
      description: typeof c["description"] === "string" ? c["description"] : id,
      beforeTool,
      requiresRequirement: requires,
      severity: sev as ConstraintSeverity,
    });
  }

  // Constraint requirements must exist in the checklist so they can actually
  // be discharged — otherwise a blocking constraint could never be satisfied.
  for (const c of constraints) {
    if (!checklist.some((k) => k.requirementId === c.requiresRequirement)) {
      throw new Error(`skill ${name}: constraint ${c.id} requires unknown checklist item ${c.requiresRequirement}`);
    }
  }

  return {
    name,
    description,
    triggers: strArray(r["triggers"]),
    frameworks: strArray(r["frameworks"]),
    filePatterns: strArray(r["file_patterns"]),
    commands: strArray(r["commands"]),
    autoInvoke: r["auto_invoke"] !== false,
    priority: priority as SkillDefinition["priority"],
    checklist,
    constraints,
    source,
  };
}
