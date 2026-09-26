import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { STATE_DIRNAME } from "../config/loader.ts";
import { parseToml, type TomlTable } from "../config/toml.ts";
import type { ToolDefinition, ToolRegistry, ToolResult, ToolExecContext } from "./registry.ts";
import type { WorkerRole } from "../workers/roles.ts";
import { truncateOutput } from "./util.ts";
import { CancellationController, killTree } from "../runtime/cancellation.ts";

/**
 * User-declared external tools (Part 94). A user can expose a trusted CLI as
 * a first-class tool via [[tools.external]] in .project-agent/config.toml.
 * There is no "special" category: the declaration is compiled into the same
 * ToolDefinition shape as builtin tools, so schema validation, the repetition
 * guard, budgets, and transcripts apply unchanged.
 *
 * Deterministic argument mapping: the model fills a declared JSON schema, and
 * the runtime composes `command --key 'value'` — every value is shell-quoted
 * as a single literal argument. The model cannot inject shell syntax; it can
 * only pass strings as strings.
 */

export interface ExternalToolParam {
  key: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
}

export interface ExternalToolSpec {
  name: string;
  description: string;
  command: string;
  params: ExternalToolParam[];
  /** Optional per-tool policy overrides (Phase 9 / Part 55). */
  risk?: "low" | "medium" | "high";
  permission?: "read" | "write" | "shell" | "network";
  /** Worker roles that may use this tool; absent = manager-only. */
  worker_roles?: WorkerRole[];
}

export interface ExternalToolParseResult {
  specs: ExternalToolSpec[];
  errors: string[];
}

/** Names the builtin/session tools own; external declarations may not shadow them. */
const RESERVED = new Set([
  "read_file", "write_file", "edit_file", "list_directory", "find_files", "search_text",
  "run_shell", "git_status", "git_diff", "git_log", "delegate", "continue_worker", "decision",
]);

const NAME_RE = /^[a-z][a-z0-9_]{1,39}$/;
const KEY_RE = /^[a-z][a-z0-9_]*$/;

/** Parse [[tools.external]] declarations. Resilient: errors are returned, not thrown. */
export function parseExternalToolSpecs(root: TomlTable): ExternalToolParseResult {
  const specs: ExternalToolSpec[] = [];
  const errors: string[] = [];
  const tools = root["tools"];
  if (tools === undefined) return { specs, errors };
  if (typeof tools !== "object" || Array.isArray(tools)) {
    errors.push("[tools]: expected a table");
    return { specs, errors };
  }
  const external = (tools as TomlTable)["external"];
  if (external === undefined) return { specs, errors };
  if (!Array.isArray(external)) {
    errors.push("[[tools.external]]: expected an array of tables");
    return { specs, errors };
  }

  for (const [i, raw] of external.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`[[tools.external]] #${i + 1}: expected a table`);
      continue;
    }
    const t = raw as TomlTable;
    const name = typeof t["name"] === "string" ? t["name"] : "";
    if (!NAME_RE.test(name)) {
      errors.push(`[[tools.external]] #${i + 1}: name must match ${NAME_RE.source} (got "${name}")`);
      continue;
    }
    if (RESERVED.has(name)) {
      errors.push(`[[tools.external]] "${name}": name collides with a builtin tool`);
      continue;
    }
    const command = typeof t["command"] === "string" ? t["command"].trim() : "";
    // The base command must be ONE invocation: no chaining or interpolation.
    // Arguments are appended separately as quoted literals, so anything that
    // chains shells (;, &&, ||, |, &) or interpolates (`…`, $(…)) would break
    // the injection model.
    if (!command || command.includes("\n") || /[;`&|]|\$\(/.test(command) || command.length > 500) {
      errors.push(`[[tools.external]] "${name}": command must be a single invocation (no ; && || | & backticks or $(...)), <= 500 chars`);
      continue;
    }
    const description = typeof t["description"] === "string" && t["description"].trim()
      ? t["description"].trim()
      : `User-defined external tool (${command}).`;

    const params: ExternalToolParam[] = [];
    const rawParams = t["params"];
    if (rawParams !== undefined && !Array.isArray(rawParams)) {
      errors.push(`[[tools.external]] "${name}": params must be [[tools.external.params]] array-of-tables`);
      continue;
    }
    let paramsOk = true;
    const seen = new Set<string>();
    for (const rp of (rawParams as unknown[]) ?? []) {
      if (typeof rp !== "object" || rp === null || Array.isArray(rp)) {
        errors.push(`[[tools.external]] "${name}": each param must be a table`);
        paramsOk = false;
        continue;
      }
      const p = rp as TomlTable;
      const key = typeof p["key"] === "string" ? p["key"] : "";
      const type = typeof p["type"] === "string" ? p["type"] : "";
      if (!KEY_RE.test(key)) {
        errors.push(`[[tools.external]] "${name}": param key must match ${KEY_RE.source} (got "${key}")`);
        paramsOk = false;
        continue;
      }
      if (seen.has(key)) {
        errors.push(`[[tools.external]] "${name}": duplicate param "${key}"`);
        paramsOk = false;
        continue;
      }
      if (type !== "string" && type !== "number" && type !== "boolean") {
        errors.push(`[[tools.external]] "${name}": param "${key}" type must be string|number|boolean`);
        paramsOk = false;
        continue;
      }
      seen.add(key);
      params.push({
        key,
        type,
        required: p["required"] === true,
        description: typeof p["description"] === "string" ? p["description"] : undefined,
      });
    }
    if (!paramsOk) continue;

    // Optional policy overrides (Phase 9): default remains permission=shell,
    // risk=high. Invalid values are hard errors — a policy line that silently
    // no-ops is worse than a rejected declaration.
    const risk = t["risk"];
    if (risk !== undefined && risk !== "low" && risk !== "medium" && risk !== "high") {
      errors.push(`[[tools.external]] "${name}": risk must be low|medium|high (got "${String(risk)}")`);
      continue;
    }
    const permission = t["permission"];
    if (permission !== undefined && permission !== "read" && permission !== "write" && permission !== "shell" && permission !== "network") {
      errors.push(`[[tools.external]] "${name}": permission must be read|write|shell|network (got "${String(permission)}")`);
      continue;
    }
    const workerRoles: WorkerRole[] = [];
    const rawRoles = t["worker_roles"];
    if (rawRoles !== undefined) {
      if (!Array.isArray(rawRoles)) {
        errors.push(`[[tools.external]] "${name}": worker_roles must be an array of role names`);
        continue;
      }
      let rolesOk = true;
      for (const r of rawRoles) {
        if (r !== "explorer" && r !== "researcher" && r !== "reviewer" && r !== "qa") {
          errors.push(`[[tools.external]] "${name}": worker_roles entries must be explorer|researcher|reviewer|qa (got "${String(r)}")`);
          rolesOk = false;
          break;
        }
        workerRoles.push(r);
      }
      if (!rolesOk) continue;
    }

    specs.push({ name, description, command, params, risk: risk as ExternalToolSpec["risk"], permission: permission as ExternalToolSpec["permission"], worker_roles: workerRoles });
  }
  return { specs, errors };
}

/** Read the project's config.toml and extract external tool declarations. */
export function loadExternalToolSpecs(projectRoot: string): ExternalToolParseResult {
  const path = join(projectRoot, STATE_DIRNAME, "config.toml");
  let root: TomlTable;
  try {
    root = parseToml(readFileSync(path, "utf8")) as TomlTable;
  } catch {
    return { specs: [], errors: [] }; // no/!parsable config: no external tools (config errors surface elsewhere)
  }
  return parseExternalToolSpecs(root);
}

/** Shell-quote a value as ONE literal argument. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Compile a spec into a registry ToolDefinition. */
export function externalToolDefinition(spec: ExternalToolSpec): ToolDefinition {
  const properties: Record<string, unknown> = {};
  for (const p of spec.params) {
    properties[p.key] = { type: p.type, description: p.description ?? `Parameter ${p.key}` };
  }
  const required = spec.params.filter((p) => p.required).map((p) => p.key);
  const usage = spec.params.length
    ? `${spec.description} Invoked as: ${spec.command}${spec.params.map((p) => ` --${p.key} <${p.type}>`).join("")}`
    : spec.description;
  return {
    name: spec.name,
    description: usage,
    permission: spec.permission ?? "shell",
    mutative: spec.permission === undefined || spec.permission !== "read",
    risk: spec.risk ?? "high",
    external: true,
    workerRoles: spec.worker_roles ?? [],
    parameters: { type: "object", properties, required, additionalProperties: false },
    async execute(args, ctx) {
      const parts: string[] = [spec.command];
      for (const p of spec.params) {
        const v = args[p.key];
        if (v === undefined) continue; // required-ness enforced by schema validation
        parts.push(`--${p.key}`, shellQuote(stringifyArg(v, p.type)));
      }
      return runCommand(spec.name, parts.join(" "), ctx);
    },
  };
}

function stringifyArg(v: unknown, type: ExternalToolParam["type"]): string {
  if (type === "boolean") return v === true ? "true" : "false";
  return String(v);
}

/** Spawn through /bin/sh with the same discipline as run_shell. */
function runCommand(toolName: string, command: string, ctx: ToolExecContext): Promise<ToolResult> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, TELOS: "1" };
    for (const k of Object.keys(env)) {
      if (k.startsWith("NODE_TEST_")) delete env[k];
    }
    const child = spawn("/bin/sh", ["-c", command], { cwd: ctx.root, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env });
    const timeoutMs = ctx.shellTimeoutSeconds * 1000;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        killTree(child);
        settle({ ok: false, output: `${toolName}: timed out after ${ctx.shellTimeoutSeconds}s and was killed`, errorCategory: "timeout" });
      }
    }, timeoutMs);
    const settle = (r: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`.trim() || "(no output)";
      const t = truncateOutput(ctx.redact(combined), ctx.maxOutputBytes);
      resolve({ ...r, output: `${r.output}\n${t.text}`.trim() });
    };
    child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => settle({ ok: false, output: `${toolName}: spawn failed: ${err.message}`, errorCategory: "spawn_error" }));
    child.on("close", (code) => {
      if (settled) return;
      settle(code === 0 ? { ok: true, output: "exit 0" } : { ok: false, output: `exit ${code ?? "signal"}`, meta: { exitCode: code }, errorCategory: "command_failed" });
    });
  });
}

/**
 * External tool names whose manifest declares the given worker role
 * (`worker_roles`, Phase 9). Reads the registry directly so the policy lives
 * on the tool definition — no import cycle with the orchestrator.
 */
export function workerExternalTools(registry: ToolRegistry, role: WorkerRole): string[] {
  const names: string[] = [];
  for (const name of registry.names()) {
    const tool = registry.get(name);
    if (tool && tool.external === true && Array.isArray(tool.workerRoles) && (tool.workerRoles as string[]).includes(role)) {
      names.push(name);
    }
  }
  return names;
}

export interface ExternalToolRegistration {
  registered: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Register external tools into the shared registry. Collisions with already
 * registered tools are skipped (never shadow a builtin); parse errors are
 * surfaced, never thrown — a bad declaration must not break the session.
 */
export function registerExternalTools(registry: ToolRegistry, parsed: ExternalToolParseResult): ExternalToolRegistration {
  const registered: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = parsed.errors.map((reason) => ({ name: "(invalid)", reason }));
  for (const spec of parsed.specs) {
    if (registry.get(spec.name)) {
      skipped.push({ name: spec.name, reason: "name already registered" });
      continue;
    }
    registry.register(externalToolDefinition(spec));
    registered.push(spec.name);
  }
  return { registered, skipped };
}
