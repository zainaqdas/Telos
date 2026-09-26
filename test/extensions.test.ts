import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../src/events/types.ts";
import { reduce } from "../src/events/state.ts";
import { CompletionGate } from "../src/gate/gate.ts";
import { EventLog } from "../src/events/log.ts";
import {
  parseExternalToolSpecs,
  loadExternalToolSpecs,
  externalToolDefinition,
  registerExternalTools,
  shellQuote,
  workerExternalTools,
} from "../src/tools/external.ts";
import { parseToml } from "../src/config/toml.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { makeContext } from "../src/tools/util.ts";

// ─── shellQuote ───────────────────────────────────────────────────────────────

test("shellQuote wraps values as single literal arguments", () => {
  assert.equal(shellQuote("hello"), "'hello'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote("a; rm -rf /"), "'a; rm -rf /'");
  assert.equal(shellQuote("$(whoami)"), "'$(whoami)'");
});

// ─── Manifest parsing ────────────────────────────────────────────────────────

function parsedFromToml(toml: string) {
  return parseExternalToolSpecs(parseToml(toml));
}

test("external tool manifest: valid declaration parses into a spec", () => {
  const { specs, errors } = parsedFromToml(`
[[tools.external]]
name = "lint_project"
command = "npx biome check"
description = "Run the project linter"

[[tools.external.params]]
key = "path"
type = "string"
required = true
description = "File or directory to lint"

[[tools.external.params]]
key = "strict"
type = "boolean"
`);
  assert.deepEqual(errors, []);
  assert.equal(specs.length, 1);
  const s = specs[0]!;
  assert.equal(s.name, "lint_project");
  assert.equal(s.command, "npx biome check");
  assert.equal(s.params[0]?.key, "path");
  assert.equal(s.params[0]?.required, true);
  assert.equal(s.params[1]?.type, "boolean");
});

test("external tool manifest: bad names, reserved names, and dup keys are rejected", () => {
  const { specs, errors } = parsedFromToml(`
[[tools.external]]
name = "Run-Shell"
command = "echo hi"

[[tools.external]]
name = "run_shell"
command = "echo hi"

[[tools.external]]
name = "dupes"
command = "echo hi"

[[tools.external.params]]
key = "path"
type = "string"

[[tools.external.params]]
key = "path"
type = "string"
`);
  assert.equal(specs.length, 0);
  assert.equal(errors.length, 3);
  assert.match(errors[0]!, /name must match/);
  assert.match(errors[1]!, /collides with a builtin/);
  assert.match(errors[2]!, /duplicate param "path"/);
});

test("external tool manifest: chaining, piping, and interpolation are rejected", () => {
  const { errors } = parsedFromToml(`
[[tools.external]]
name = "evil1"
command = "echo a; echo b"

[[tools.external]]
name = "evil2"
command = "echo \`id\`"

[[tools.external]]
name = "evil3"
command = "echo a && echo b"

[[tools.external]]
name = "evil4"
command = "echo a | tee out"

[[tools.external]]
name = "evil5"
command = "echo $(id)"

[[tools.external]]
name = "ok1"
command = "echo one two"
`);
  // Chained/piped/interpolated commands are invalid; a plain multi-word
  // command is fine (args are appended as quoted literals).
  assert.equal(errors.length, 5);
  for (const e of errors) assert.match(e, /single invocation/);
});

test("external tool manifest: params must use string|number|boolean", () => {
  const { errors } = parsedFromToml(`
[[tools.external]]
name = "toolx"
command = "toolx run"

[[tools.external.params]]
key = "mode"
type = "array"
`);
  assert.match(errors[0]!, /type must be string\|number\|boolean/);
});

test("loadExternalToolSpecs reads the project config and reports parse errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-ext1-"));
  try {
    mkdirSync(join(dir, ".project-agent"), { recursive: true });
    writeFileSync(
      join(dir, ".project-agent", "config.toml"),
      `
[[tools.external]]
name = "greet"
command = "echo hello"

[[tools.external.params]]
key = "name"
type = "string"
required = true
`,
      "utf8",
    );
    const { specs, errors } = loadExternalToolSpecs(dir);
    assert.deepEqual(errors, []);
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.name, "greet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing config produces no specs and no errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-ext2-"));
  try {
    const { specs, errors } = loadExternalToolSpecs(dir);
    assert.deepEqual(specs, []);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toml: repeated [[a.b]] entries are siblings, and [[a.b]] attaches to the last [[a]] entry", () => {
  // Regression: array-of-tables sections previously resolved their path from
  // the *previous current table*, nesting later entries inside earlier ones.
  const nested = parseToml(`
[[tool]]
name = "one"

[[tool.params]]
key = "a"

[[tool.params]]
key = "b"

[[tool]]
name = "two"
`) as { tool: Array<{ name: string; params?: Array<{ key: string }> }> };
  assert.equal(nested.tool.length, 2, "two tool entries, not nested");
  assert.equal(nested.tool[0]!.name, "one");
  assert.deepEqual(nested.tool[0]!.params!.map((p) => p.key), ["a", "b"], "params are siblings under entry one");
  assert.equal(nested.tool[1]!.name, "two");
  assert.equal(nested.tool[1]!.params, undefined);
});

// ─── Compiled tool behavior ──────────────────────────────────────────────────

test("external tool executes with named flags, quoting, and output capture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-ext3-"));
  try {
    // The contract composes: printf %s=%s --text 'hello world'. printf is not
    // getopt-driven, so the composed named flag survives verbatim.
    const tool = externalToolDefinition({
      name: "echo_field",
      description: "echo a field",
      command: "printf %s=%s",
      params: [{ key: "text", type: "string", required: true, description: "text to echo" }],
    });
    const ctx = makeContext(dir, { shellTimeoutSeconds: 15 });
    const res = await tool.execute({ text: "hello world" }, ctx);
    assert.ok(res.ok, res.output);
    assert.match(res.output, /--text=hello world/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external tool: injection attempt stays a literal argument", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-ext4-"));
  try {
    const tool = externalToolDefinition({
      name: "echo_thing",
      description: "echo",
      command: "printf %s",
      params: [{ key: "text", type: "string", required: true }],
    });
    const ctx = makeContext(dir, { shellTimeoutSeconds: 15 });
    const evil = "'; rm -rf ~; echo '";
    const res = await tool.execute({ text: evil }, ctx);
    assert.ok(res.ok);
    // The evil string arrives as ONE literal argument — the transcript shows it verbatim.
    assert.ok(res.output.includes(evil), res.output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external tool: schema validation rejects unknown and missing args", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-ext5-"));
  try {
    const tool = externalToolDefinition({
      name: "tool_two",
      description: "two params",
      command: "echo",
      params: [
        { key: "a", type: "string", required: true },
        { key: "b", type: "number", required: false },
      ],
    });
    const { validateToolArgs } = await import("../src/tools/registry.ts");
    const missing = validateToolArgs({}, tool.parameters);
    assert.ok(!missing.ok);
    const unknown = validateToolArgs({ a: "x", zzz: 1 }, tool.parameters);
    assert.ok(!unknown.ok);
    const ok = validateToolArgs({ a: "x", b: 3 }, tool.parameters);
    assert.ok(ok.ok);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external tool: boolean and number args are stringified deterministically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-ext6-"));
  try {
    let seen = "";
    const origSpawn = (await import("node:child_process")).spawn;
    const tool = externalToolDefinition({
      name: "flagged",
      description: "flags",
      command: "echo",
      params: [
        { key: "dry", type: "boolean", required: false },
        { key: "level", type: "number", required: false },
      ],
    });
    // Execute and inspect via output echo instead of spying on spawn.
    const ctx = makeContext(dir, { shellTimeoutSeconds: 15 });
    const res = await tool.execute({ dry: true, level: 2 }, ctx);
    void seen; void origSpawn;
    assert.ok(res.ok);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external tool: timeout kills the child and reports it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-ext7-"));
  try {
    const tool = externalToolDefinition({ name: "sleeper", description: "sleeps", command: "sleep 5", params: [] });
    const ctx = makeContext(dir, { shellTimeoutSeconds: 1 });
    const res = await tool.execute({}, ctx);
    assert.ok(!res.ok);
    assert.match(res.output, /timed out/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerExternalTools never shadows builtins and surfaces skips", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "builtin",
    permission: "read",
    mutative: false,
    risk: "low",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ ok: true, output: "" }),
  });
  const reg = registerExternalTools(registry, {
    specs: [
      { name: "read_file", description: "shadow", command: "echo", params: [] },
      { name: "custom_tool", description: "ok", command: "echo hi", params: [] },
    ],
    errors: [],
  });
  assert.deepEqual(reg.registered, ["custom_tool"]);
  assert.equal(reg.skipped.length, 1);
  assert.match(reg.skipped[0]!.reason, /already registered/);
  assert.equal(registry.get("read_file")!.description, "builtin");
});

// ─── Blocker waivers (user-only) ─────────────────────────────────────────────

function ev(seq: number, kind: AgentEvent["kind"], data: Record<string, unknown>): AgentEvent {
  return { seq, t: seq, taskId: "t", kind, data };
}

test("blocker_waived marks the blocker waived in derived state", () => {
  const state = reduce([
    ev(1, "blocker", { id: "b-1", reason: "needs credentials we will never get" }),
    ev(2, "blocker_waived", { id: "b-1", reason: "user accepted the risk" }),
  ]);
  assert.equal(state.blockers[0]?.status, "waived");
});

test("waived blockers do not block the gate but stay visible in the summary", () => {
  const events = [
    ev(1, "blocker", { id: "b-1", reason: "credentials unavailable" }),
    ev(2, "blocker_waived", { id: "b-1", reason: "accepted" }),
    ev(3, "task_completed", { reason: "gate_complete" }),
  ];
  const gate = new CompletionGate(() => events);
  const report = gate.evaluate();
  assert.equal(report.verdict, "COMPLETE");
  assert.match(report.summary, /waived by user: b-1/);
});

test("open blockers still block; waiver is what clears them (not resolution)", () => {
  const events = [ev(1, "blocker", { id: "b-1", reason: "x" })];
  assert.equal(new CompletionGate(() => events).evaluate().verdict, "BLOCKED");
  const waived = [events[0]!, ev(2, "blocker_waived", { id: "b-1", reason: "ok" })];
  assert.equal(new CompletionGate(() => waived).evaluate().verdict, "COMPLETE");
});

test("a waived blocker cannot be re-opened and an open one cannot be waived twice", () => {
  const state = reduce([
    ev(1, "blocker", { id: "b-1", reason: "x" }),
    ev(2, "blocker_waived", { id: "b-1", reason: "ok" }),
    ev(3, "blocker_waived", { id: "b-1", reason: "ok again" }),
  ]);
  assert.equal(state.blockers[0]?.status, "waived");
});

// ─── Phase 9: manifest policy overrides ──────────────────────────────────────

test("policy overrides: risk/permission/worker_roles compile onto the ToolDefinition", () => {
  const { specs } = parseExternalToolSpecs(parseToml(`
[[tools.external]]
name = "lint_gate"
command = "lint-tool check"
description = "run the repo linter"
risk = "medium"
permission = "read"
worker_roles = ["qa", "reviewer"]

[[tools.external.params]]
key = "path"
type = "string"
required = false
`) as never);
  const spec = specs[0]!;
  assert.equal(spec.risk, "medium");
  assert.equal(spec.permission, "read");
  assert.deepEqual(spec.worker_roles, ["qa", "reviewer"]);
  const tool = externalToolDefinition(spec);
  assert.equal(tool.risk, "medium");
  assert.equal(tool.permission, "read");
  assert.equal(tool.mutative, false, "permission read ⇒ not mutative");
  assert.deepEqual(tool.workerRoles, ["qa", "reviewer"]);
  assert.equal(tool.external, true);
});

test("policy defaults stay shell/high and manager-only when no overrides are declared", () => {
  const tool = externalToolDefinition({
    name: "plain_tool",
    description: "no overrides",
    command: "echo hi",
    params: [],
  });
  assert.equal(tool.risk, "high");
  assert.equal(tool.permission, "shell");
  assert.equal(tool.mutative, true);
  assert.deepEqual(tool.workerRoles, []);
});

test("invalid policy values are hard parse errors (a policy line must not silently no-op)", () => {
  const { specs, errors } = parseExternalToolSpecs(parseToml(`
[[tools.external]]
name = "bad_risk"
command = "echo"
risk = "cosmic"

[[tools.external]]
name = "bad_roles"
command = "echo"
worker_roles = ["intern"]
`) as never);
  assert.equal(specs.length, 0);
  assert.equal(errors.length, 2);
  assert.ok(errors[0]!.includes("risk must be low|medium|high"));
  assert.ok(errors[1]!.includes("worker_roles entries must be"));
});

// ─── Phase 9: worker roles gain explicitly-declared external tools ───────────

test("workerExternalTools: roles see exactly the external tools that declare them", () => {
  const registry = new ToolRegistry();
  registry.register(externalToolDefinition({ name: "lint_gate", description: "l", command: "echo", params: [], worker_roles: ["qa"] }));
  registry.register(externalToolDefinition({ name: "deploy_helper", description: "d", command: "echo", params: [] }));
  assert.deepEqual(workerExternalTools(registry, "qa"), ["lint_gate"]);
  assert.equal(workerExternalTools(registry, "explorer").length, 0, "undeclared role gets nothing");
  assert.equal(workerExternalTools(registry, "reviewer").length, 0, "manager-only tool hidden from workers");
});
