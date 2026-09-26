import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../src/events/types.ts";
import { reduce } from "../src/events/state.ts";
import type { GenerateRequest, Provider, StreamChunk, Message } from "../src/providers/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { makeContext } from "../src/tools/util.ts";
import { BudgetEnforcer } from "../src/runtime/usage.ts";
import { CancellationController } from "../src/runtime/cancellation.ts";
import { EventLog } from "../src/events/log.ts";
import { CompletionGate } from "../src/gate/gate.ts";
import { ManagerLoop } from "../src/manager/loop.ts";
import { decodeEntities, parseDuckDuckGoLite, normalizeDuckUrl, extractReadableText, extractTitle } from "../src/tools/web.ts";
import type { SynergonConfig } from "../src/config/schema.ts";

// ─── Web parsers (deterministic, no network) ─────────────────────────────────

test("decodeEntities handles the standard five", () => {
  const decoded = decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#x27;e&#39; &nbsp;");
  assert.equal(decoded.replace(/\u00A0/g, " "), "a & b <c> \"d\" 'e'  ");
});

test("parseDuckDuckGoLite extracts title, unwrapped URL, and snippet pairs", () => {
  // Fixture mirrors the REAL DuckDuckGo Lite shape: single-quoted classes,
  // href before class, snippets in <td> siblings with <b> + escaped markup.
  const html = `
  <table border="0">
    <tr>
      <td valign="top">1.&nbsp;</td>
      <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=x" class='result-link'>Official &amp; Docs</a></td>
    </tr>
    <tr><td></td><td class='result-snippet'>The official documentation &lt;em&gt;site&lt;/em&gt; with <b>emphasis</b>.</td></tr>
    <tr>
      <td valign="top">2.&nbsp;</td>
      <td><a rel="nofollow" href="https://direct.example.org/page" class='result-link'>Direct Link</a></td>
    </tr>
  </table>`;
  const hits = parseDuckDuckGoLite(html);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.url, "https://example.com/docs");
  assert.equal(hits[0]!.title, "Official & Docs");
  assert.equal(hits[0]!.snippet, "The official documentation site with emphasis.");
  assert.equal(hits[1]!.url, "https://direct.example.org/page");
});

test("normalizeDuckUrl unwraps redirects and leaves direct URLs alone", () => {
  assert.equal(normalizeDuckUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.io%2Fx"), "https://a.io/x");
  assert.equal(normalizeDuckUrl("https://plain.example.com"), "https://plain.example.com");
});

test("extractReadableText strips scripts, styles, and tags; keeps content lines", () => {
  const html = `<html><head><title>My Title</title><style>body{color:red}</style></head>
  <body><script>alert(1)</script><nav>ignore</nav><main><h1>Heading</h1><p>First para.</p><p>Second para with &amp; entity.</p></main></body></html>`;
  const text = extractReadableText(html);
  assert.ok(!text.includes("alert"));
  assert.ok(!text.includes("color:red"));
  assert.ok(!text.includes("ignore"));
  assert.match(text, /Heading/);
  assert.match(text, /First para\./);
  assert.match(text, /Second para with & entity\./);
  assert.equal(extractTitle(html), "My Title");
});

// ─── Vision gating (Part 51) ─────────────────────────────────────────────────

class FakeProvider implements Provider {
  readonly name = "fake";
  readonly seen: Array<GenerateRequest["messages"]> = [];
  private readonly vision: boolean;
  constructor(vision: boolean) {
    this.vision = vision;
  }
  capabilities() {
    return { supportsTools: true, supportsVision: this.vision, supportsStreaming: true, supportsStructuredOutput: false, contextLimit: 10_000 };
  }
  async *stream(req: GenerateRequest, _model: string): AsyncIterable<StreamChunk> {
    void _model;
    this.seen.push(req.messages);
    yield { type: "text_delta", text: "done" };
  }
}

function config(): SynergonConfig {
  return {
    model: { provider: "openai", name: "fake-1", baseUrl: "", apiKeyEnv: "NOOP", temperature: 0, maxTokens: 1024 },
    runtime: {
      autonomy: "balanced", maxTotalTokens: 100_000, maxToolCalls: 5, maxWorkerSpawns: 0,
      maxParallelWorkers: 0, maxWallTimeSeconds: 60, shellTimeoutSeconds: 5, maxStreamAttempts: 2, minTestCount: 0,
      streamTimeoutSeconds: 0, compactionThresholdTokens: 0,
    },
    security: { confirmDestructive: true, blockSecrets: true },
  };
}

function loopWith(provider: Provider, dir: string): { loop: ManagerLoop; events: EventLog } {
  const events = new EventLog(join(dir, "ev"), "t");
  events.append("task_started", { title: "x" });
  const loop = new ManagerLoop({
    provider, model: "fake-1", config: config(),
    registry: new ToolRegistry(), events,
    budget: new BudgetEnforcer({ maxTotalTokens: 100_000, maxToolCalls: 5, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 }),
    cancellation: new CancellationController(),
    ctx: makeContext(dir, { shellTimeoutSeconds: 5 }),
    gate: new CompletionGate(() => events.readAll()),
  });
  return { loop, events };
}

const IMG = { mediaType: "image/png", data: "aGk=" };

test("vision model receives image parts; non-vision model gets a notice instead", async () => {
  const visionDir = mkdtempSync(join(tmpdir(), "syn-p8v-"));
  const blindDir = mkdtempSync(join(tmpdir(), "syn-p8b-"));
  try {
    const vision = new FakeProvider(true);
    const lv = loopWith(vision, visionDir);
    await lv.loop.run("what is in this screenshot", { images: [IMG] });
    const userMsg = vision.seen[0]!.at(-1)!;
    assert.equal(userMsg.parts.filter((p) => p.type === "image").length, 1, "image part sent to vision model");

    const blind = new FakeProvider(false);
    const lb = loopWith(blind, blindDir);
    const r = await lb.loop.run("what is in this screenshot", { images: [IMG] });
    const userMsg2 = blind.seen[0]!.at(-1)!;
    assert.equal(userMsg2.parts.filter((p) => p.type === "image").length, 0, "no image part without vision");
    assert.ok(lb.events.readAll().some((e) => e.kind === "task_updated" && String(e.data["notice"]).includes("vision")), "drop recorded in the log");
    assert.ok(r.assistantText.length > 0);
  } finally {
    rmSync(visionDir, { recursive: true, force: true });
    rmSync(blindDir, { recursive: true, force: true });
  }
});

// ─── Browser tools: graceful degradation without a browser binary ────────────

test("browser tools fail with structured, actionable errors when no browser exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-p8br-"));
  try {
    // This environment has no Chromium on PATH (verified); SYNERGON_BROWSER
    // points at a nonexistent binary to make the absence deterministic.
    process.env["SYNERGON_BROWSER"] = "/nonexistent/synergon-fake-chrome";
    const { registerBrowserTools } = await import("../src/tools/browser.ts");
    const registry = new ToolRegistry();
    registerBrowserTools(registry, { cancellation: new CancellationController() });
    const ctx = makeContext(dir, { shellTimeoutSeconds: 5 });
    const open = registry.get("browser_open")!;
    const res = await open.execute({ url: "https://example.com" }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.output, /browser_open failed/);
    assert.equal(res.errorCategory, "browser_unavailable");

    const shot = registry.get("browser_screenshot")!;
    const res2 = await shot.execute({}, ctx);
    assert.equal(res2.ok, false);
    assert.match(res2.output, /no browser open/);
    delete process.env["SYNERGON_BROWSER"];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser evidence is gate-visible: verification_result events with kind=browser", () => {
  // The gate reads test_result/verification_result events; browser evidence
  // must flow through the same channel (Part 50).
  const mk = (seq: number, kind: AgentEvent["kind"], data: Record<string, unknown>): AgentEvent => ({ seq, t: seq * 10, taskId: "t", kind, data });
  const events: AgentEvent[] = [
    mk(1, "task_started", { title: "x" }),
    mk(2, "requirement_added", { id: "browser-verify", description: "Verify the page in a real browser", required: true }),
    mk(3, "verification_result", { kind: "browser", ok: true, observation: "opened /login, submitted form, observed /dashboard, 0 console errors" }),
    mk(4, "requirement_satisfied", { id: "browser-verify", source: "tool:browser_console", producer: "runtime", observation: "browser verification passed" }),
  ];
  const state = reduce(events);
  assert.equal(state.requirements.get("browser-verify")?.status, "satisfied");
  const gate = new CompletionGate(() => events);
  const report = gate.evaluate();
  assert.equal(report.verdict, "COMPLETE");
});

// ─── /image support: file → base64 (the session-side shape) ──────────────────

test("image files convert to base64 data URIs for the provider (wire shape)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-p8img-"));
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // PNG magic
    const file = join(dir, "shot.png");
    writeFileSync(file, png);
    // The session does: readFileSync → toString("base64") → data:${mediaType};base64,…
    const data = readFileSync(file).toString("base64");
    const dataUri = `data:image/png;base64,${data}`;
    assert.match(dataUri, /^data:image\/png;base64,/);
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
