import { parseToml, type TomlTable } from "../config/toml.ts";

/**
 * [[mcp.servers]] declaration in .project-agent/config.toml (Part 55).
 * Each entry is a local stdio server: a command the user trusts, plus
 * optional args/env. Policy stays user-owned — which tools exist, which
 * worker roles may call them.
 *
 * ```toml
 * [[mcp.servers]]
 * name = "fs"
 * command = "npx"
 * args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
 * timeout_seconds = 30
 * worker_roles = ["explorer", "qa"]   # optional; default manager-only
 *
 * [mcp.servers.env]                   # optional extra environment
 * NODE_ENV = "production"
 * ```
 */

export const MCP_ROLES = ["explorer", "researcher", "reviewer", "qa"] as const;
export type McpWorkerRole = (typeof MCP_ROLES)[number];

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutSeconds: number;
  workerRoles: McpWorkerRole[];
}

export interface McpParseResult {
  specs: McpServerSpec[];
  errors: string[];
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;

/** Parse [[mcp.servers]] declarations. Resilient: errors are returned, not thrown. */
export function parseMcpServers(root: TomlTable): McpParseResult {
  const specs: McpServerSpec[] = [];
  const errors: string[] = [];
  const mcp = root["mcp"];
  if (mcp === undefined) return { specs, errors };
  if (typeof mcp !== "object" || Array.isArray(mcp)) {
    errors.push("[mcp]: expected a table");
    return { specs, errors };
  }
  const servers = (mcp as TomlTable)["servers"];
  if (servers === undefined) return { specs, errors };
  if (!Array.isArray(servers)) {
    errors.push("[[mcp.servers]]: expected an array of tables");
    return { specs, errors };
  }

  const seen = new Set<string>();
  for (const [i, raw] of servers.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`[[mcp.servers]] #${i + 1}: expected a table`);
      continue;
    }
    const t = raw as TomlTable;
    const name = typeof t["name"] === "string" ? t["name"] : "";
    if (!NAME_RE.test(name)) {
      errors.push(`[[mcp.servers]] #${i + 1}: name must match ${NAME_RE.source} (got "${name}")`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`[[mcp.servers]] "${name}": duplicate name`);
      continue;
    }
    const command = typeof t["command"] === "string" ? t["command"].trim() : "";
    if (!command) {
      errors.push(`[[mcp.servers]] "${name}": command is required`);
      continue;
    }
    if (command.includes("\n")) {
      errors.push(`[[mcp.servers]] "${name}": command must be a single line`);
      continue;
    }
    const rawArgs = t["args"];
    if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
      errors.push(`[[mcp.servers]] "${name}": args must be an array of strings`);
      continue;
    }
    const args = ((rawArgs as unknown[]) ?? []).map((a) => String(a));

    // Optional env table: string → string only (secrets come from env refs the user already controls).
    let env: Record<string, string> | undefined;
    const rawEnv = t["env"];
    if (rawEnv !== undefined) {
      if (typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
        errors.push(`[[mcp.servers]] "${name}": env must be a table of strings`);
        continue;
      }
      env = {};
      let envOk = true;
      for (const [k, v] of Object.entries(rawEnv as Record<string, unknown>)) {
        if (typeof v !== "string") {
          errors.push(`[[mcp.servers]] "${name}": env.${k} must be a string`);
          envOk = false;
          break;
        }
        env[k] = v;
      }
      if (!envOk) continue;
    }

    const timeoutSeconds = t["timeout_seconds"] === undefined ? 30 : Number(t["timeout_seconds"]);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 600) {
      errors.push(`[[mcp.servers]] "${name}": timeout_seconds must be 1..600`);
      continue;
    }

    const workerRoles: McpWorkerRole[] = [];
    const rawRoles = t["worker_roles"];
    if (rawRoles !== undefined) {
      if (!Array.isArray(rawRoles)) {
        errors.push(`[[mcp.servers]] "${name}": worker_roles must be an array of role names`);
        continue;
      }
      let rolesOk = true;
      for (const r of rawRoles) {
        if (!(MCP_ROLES as readonly string[]).includes(String(r))) {
          errors.push(`[[mcp.servers]] "${name}": worker_roles entries must be ${MCP_ROLES.join("|")} (got "${String(r)}")`);
          rolesOk = false;
          break;
        }
        workerRoles.push(r as McpWorkerRole);
      }
      if (!rolesOk) continue;
    }

    seen.add(name);
    specs.push({ name, command, args, env, timeoutSeconds, workerRoles });
  }
  return { specs, errors };
}
