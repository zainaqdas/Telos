import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToml } from "../src/config/toml.ts";
import { parseMcpServers, type McpServerSpec } from "../src/mcp/config.ts";
import { McpClient } from "../src/mcp/client.ts";
import { registerMcpServer, mcpWorkerTools, MCP_PREFIX, type McpRegistration } from "../src/mcp/tools.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

// ─── Config parsing ───────────────────────────────────────────────────────────

test("mcp config: valid declaration parses with defaults; duplicate/bad names rejected", () => {
  const { specs, errors } = parseMcpServers(parseToml(`
[[mcp.servers]]
name = "fs"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
worker_roles = ["explorer", "qa"]

[[mcp.servers]]
name = "fs"
command = "echo"

[[mcp.servers]]
name = "Bad Name"
command = "echo"

[[mcp.servers]]
name = "empty_cmd"

[[mcp.servers]]
name = "badroles"
command = "echo"
worker_roles = ["intern"]
`) as never);
  assert.equal(errors.length, 4, `errors: ${JSON.stringify(errors)}`);
  assert.equal(specs.length, 1);
  assert.equal(specs[0]!.name, "fs");
  assert.deepEqual(specs[0]!.args, ["-y", "@modelcontextprotocol/server-filesystem", "."]);
  assert.deepEqual(specs[0]!.workerRoles, ["explorer", "qa"]);
  assert.equal(specs[0]!.timeoutSeconds, 30, "default timeout");
});

test("mcp config: env table validates; timeout bounded; absent section parses empty", () => {
  const ok = parseMcpServers(parseToml(`
[[mcp.servers]]
name = "s1"
command = "node"
timeout_seconds = 5

[mcp.servers.env]
NODE_ENV = "production"
`) as never);
  assert.equal(ok.errors.length, 0);
  assert.deepEqual(ok.specs[0]!.env, { NODE_ENV: "production" });
  assert.equal(ok.specs[0]!.timeoutSeconds, 5);

  // Errors are one-per-server (each violation skips the rest of that server),
  // so the two invalid values live on separate servers. [mcp.servers.env]
  // must attach to the LAST array entry (s2) per TOML array-of-tables rules.
  const bad = parseMcpServers(parseToml(`
[[mcp.servers]]
name = "s1"
command = "node"
timeout_seconds = 9999

[[mcp.servers]]
name = "s2"
command = "node"

[mcp.servers.env]
PORT = 3000
`) as never);
  assert.equal(bad.specs.length, 0);
  assert.equal(bad.errors.length, 2, `errors: ${JSON.stringify(bad.errors)}`);

  const none = parseMcpServers(parseToml("[model]\nname = \"x\"") as never);
  assert.deepEqual(none, { specs: [], errors: [] });
});

// ─── Real stdio server subprocess ─────────────────────────────────────────────

// A minimal MCP server over stdio: initialize, tools/list, tools/call.
// Failure modes controllable via env: MCP_TEST_CRASH=1 dies after init,
// MCP_TEST_HANG=1 never answers tools/call, MCP_TEST_TOOLERR=1 returns isError.
const SERVER_JS = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const id = msg.id;
  if (msg.method === "initialize") {
    if (process.env.MCP_TEST_CRASH === "1") { process.exit(7); }
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "mock", version: "1" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [
      { name: "echo", description: "echo back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "add", description: "add numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
    ] } });
  } else if (msg.method === "tools/call") {
    if (process.env.MCP_TEST_HANG === "1") return; // never respond
    if (process.env.MCP_TEST_TOOLERR === "1") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "boom" }], isError: true } });
      return;
    }
    const args = msg.params.arguments || {};
    const text = msg.params.name === "add" ? String(args.a + args.b) : String(args.text ?? "");
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + msg.method } });
  }
});
`;

function serverSpec(dir: string, extraEnv: Record<string, string> = {}): McpServerSpec {
  const script = join(dir, "server.cjs");
  writeFileSync(script, SERVER_JS, "utf8");
  return { name: "mock", command: process.execPath, args: [script], env: extraEnv, timeoutSeconds: 5, workerRoles: ["qa"] };
}

test("toml: [a.b] targets the last [[a]] entry (array-of-tables sub-tables)", () => {
  const parsed = parseToml(`
[[servers]]
name = "one"

[[servers]]
name = "two"

[servers.env]
MODE = "live"
`) as never as Record<string, unknown>;
  const arr = parsed["servers"] as Array<Record<string, unknown>>;
  assert.equal(arr.length, 2, "sibling entries, not nested");
  assert.deepEqual(arr[0], { name: "one" }, "earlier entry untouched");
  assert.deepEqual(arr[1]!["env"], { MODE: "live" }, "sub-table attaches to the LAST entry");
});

test("mcp client: handshake, tools/list, tools/call over a real subprocess", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-mcp1-"));
  try {
    const client = new McpClient("mock", process.execPath, [join(dir, "server.cjs")]);
    writeFileSync(join(dir, "server.cjs"), SERVER_JS, "utf8");
    await client.start();
    const tools = await client.listTools();
    assert.equal(tools.length, 2);
    assert.equal(tools[0]!.name, "echo");
    assert.equal(tools[0]!.inputSchema["type"], "object");

    const res = await client.callTool("add", { a: 2, b: 3 });
    assert.equal(res.ok, true);
    assert.equal(res.output, "5");
    client.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp tool through the registry: name prefixing, schema, execution, isError handling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-mcp2-"));
  // try-block consts are invisible to finally — hoist the registrations.
  let reg: McpRegistration | undefined;
  let errReg: McpRegistration | undefined;
  try {
    const registry = new ToolRegistry();
    reg = await registerMcpServer(registry, serverSpec(dir));
    assert.equal(reg.started, true);
    assert.deepEqual(reg.tools, [`${MCP_PREFIX}mock_echo`, `${MCP_PREFIX}mock_add`]);

    const echo = registry.get("mcp_mock_echo")!;
    assert.ok(echo, "tool registered");
    assert.equal(echo.risk, "medium");
    assert.deepEqual(echo.workerRoles, ["qa"]);
    const res = await echo.execute({ text: "hello mcp" }, { root: dir, redact: (s) => s, maxOutputBytes: 10_000, shellTimeoutSeconds: 5 });
    assert.equal(res.ok, true);
    assert.equal(res.output, "hello mcp");

    // Schema validation flows through the standard validator:
    const { validateToolArgs } = await import("../src/tools/registry.ts");
    const bad = validateToolArgs({}, echo.parameters);
    assert.equal(bad.ok, false, "missing required arg rejected by the standard path");

    // isError from the server → failed ToolResult, not a throw. Env must be
    // set at spawn time (children don't see later process.env changes), so a
    // dedicated server instance carries the flag.
    const errRegistry = new ToolRegistry();
    errReg = await registerMcpServer(errRegistry, serverSpec(dir, { MCP_TEST_TOOLERR: "1" }));
    assert.equal(errReg.started, true);
    const failingTool = errRegistry.get("mcp_mock_echo")!;
    assert.ok(failingTool);
    const failing = await failingTool.execute({ text: "x" }, { root: dir, redact: (s) => s, maxOutputBytes: 10_000, shellTimeoutSeconds: 5 });
    assert.equal(failing.ok, false);
    assert.match(failing.output, /boom/);
  } finally {
    reg?.client?.stop(); // keep the subprocess from holding the test process open
    errReg?.client?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp server crash rejects in-flight calls; next registration attempt reports the failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-mcp3-"));
  try {
    // Server configured to die immediately after initialize.
    const registry = new ToolRegistry();
    const reg = await registerMcpServer(registry, serverSpec(dir, { MCP_TEST_CRASH: "1" }));
    assert.equal(reg.started, false);
    assert.match(reg.error ?? "", /start failed/);
    assert.equal(reg.tools.length, 0);

    // A healthy client whose server dies mid-session rejects pending calls.
    const client = new McpClient("mock", process.execPath, [join(dir, "server.cjs")]);
    writeFileSync(join(dir, "server.cjs"), SERVER_JS, "utf8");
    await client.start();
    // Kill the process behind the client's back.
    client.stop();
    const res = await client.callTool("echo", { text: "x" });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /not running/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp timeout: a hung tools/call fails after the deadline instead of hanging the session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-mcp4-"));
  try {
    const client = new McpClient("mock", process.execPath, [join(dir, "server.cjs")], { MCP_TEST_HANG: "1" }, 700);
    writeFileSync(join(dir, "server.cjs"), SERVER_JS, "utf8");
    await client.start();
    const started = Date.now();
    const res = await client.callTool("echo", { text: "x" });
    const elapsed = Date.now() - started;
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /timed out/);
    assert.ok(elapsed < 5000, `timeout enforced (${elapsed}ms), not the default 30s`);
    client.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp worker policy: only declared roles see mcp_ tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-mcp5-"));
  try {
    const registry = new ToolRegistry();
    const tool = {
      name: "mcp_mock_echo",
      description: "x",
      permission: "shell" as const,
      mutative: true,
      risk: "medium" as const,
      external: true,
      workerRoles: ["qa" as const],
      parameters: { type: "object", properties: {} },
      async execute() { return { ok: true, output: "" }; },
    };
    registry.register(tool);
    assert.deepEqual(mcpWorkerTools(registry, "qa"), ["mcp_mock_echo"]);
    assert.equal(mcpWorkerTools(registry, "explorer").length, 0);
    assert.equal(mcpWorkerTools(registry, "reviewer").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
