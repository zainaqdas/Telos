import type { ToolDefinition, ToolRegistry, ToolResult, ToolExecContext } from "../tools/registry.ts";
import { truncateOutput } from "../tools/util.ts";
import { McpClient } from "./client.ts";
import type { McpServerSpec } from "./config.ts";
import type { WorkerRole } from "../workers/roles.ts";

/**
 * MCP → registry compilation (Part 55). An MCP tool appears as a standard
 * ToolDefinition — same schema validation, repetition guard, budgets, and
 * transcript treatment as builtins; there is no "special" category and no
 * MCP-specific logic anywhere in the Manager.
 *
 * Names are prefixed `mcp_<server>_<tool>` to keep servers namespace-isolated
 * and collisions impossible. A tool call that fails (server down, error,
 * timeout) returns a failed ToolResult — one bad server degrades, never crashes.
 */

export interface McpRegistration {
  serverName: string;
  started: boolean;
  tools: string[];
  /** Live client (same instance the compiled tools close over) when started. */
  client?: McpClient;
  error?: string;
}

/** Largest sanitized tool count per server; guards pathological manifests. */
const MAX_TOOLS_PER_SERVER = 64;

function sanitizeFragment(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "x";
}

/** Names MCP tools own; external/builtin names can't be shadowed. */
export const MCP_PREFIX = "mcp_";

export async function registerMcpServer(registry: ToolRegistry, spec: McpServerSpec): Promise<McpRegistration> {
  const client = new McpClient(spec.name, spec.command, spec.args, spec.env, spec.timeoutSeconds * 1000);
  const toolNames: string[] = [];
  try {
    await client.start();
  } catch (err) {
    client.stop();
    return { serverName: spec.name, started: false, tools: [], error: `start failed: ${(err as Error).message}` };
  }
  let infos;
  try {
    infos = await client.listTools();
  } catch (err) {
    client.stop();
    return { serverName: spec.name, started: true, tools: [], error: `tools/list failed: ${(err as Error).message}` };
  }
  for (const info of infos.slice(0, MAX_TOOLS_PER_SERVER)) {
    const name = `${MCP_PREFIX}${sanitizeFragment(spec.name)}_${sanitizeFragment(info.name)}`;
    if (registry.get(name)) continue; // never shadow anything
    registry.register(compileMcpTool(name, spec, client, info.name, info.description, info.inputSchema));
    toolNames.push(name);
  }
  return { serverName: spec.name, started: true, tools: toolNames, client };
}

function compileMcpTool(
  registryName: string,
  spec: McpServerSpec,
  client: McpClient,
  mcpToolName: string,
  description: string | undefined,
  inputSchema: Record<string, unknown>,
): ToolDefinition {
  const workerRoles = spec.workerRoles;
  // MCP tools are user-trusted local commands: medium risk, shell-class.
  return {
    name: registryName,
    description: description ? `[mcp:${spec.name}] ${description}` : `[mcp:${spec.name}] MCP tool ${mcpToolName}`,
    permission: "shell",
    mutative: true,
    risk: "medium",
    external: true,
    workerRoles,
    parameters: normalizeSchema(inputSchema),
    async execute(args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolResult> {
      const res = await client.callTool(mcpToolName, args);
      const t = truncateOutput(ctx.redact(res.output), ctx.maxOutputBytes);
      if (!res.ok) {
        return { ok: false, output: `mcp ${registryName} failed: ${res.error ?? t.text}`, errorCategory: "mcp_error" };
      }
      return { ok: true, output: t.text };
    },
  };
}

/** Ensure the schema is a valid object-shape for the registry validator. */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && schema["type"] === "object") return schema;
  // Servers occasionally emit draft shapes without top-level type; coerce
  // conservatively so validation treats unknown properties as rejected.
  return { type: "object", properties: {}, additionalProperties: false };
}

/** Worker-visible MCP tool names for a role (mirrors external tools policy). */
export function mcpWorkerTools(registry: ToolRegistry, role: WorkerRole): string[] {
  const names: string[] = [];
  for (const name of registry.names()) {
    if (!name.startsWith(MCP_PREFIX)) continue;
    const tool = registry.get(name);
    if (tool && Array.isArray(tool.workerRoles) && (tool.workerRoles as string[]).includes(role)) names.push(name);
  }
  return names;
}

/** Stop every MCP server tracked in the registry's session (helper for shutdown). */
export function closeMcpClients(clients: McpClient[]): void {
  for (const c of clients) c.stop();
}
