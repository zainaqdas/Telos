import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolRegistry, ToolResult, ToolExecContext } from "./registry.ts";
import { truncateOutput } from "./util.ts";
import { CancellationController } from "../runtime/cancellation.ts";

/**
 * Browser verification tools (Parts 49–50) — zero dependencies.
 * Drives the user's own Chromium-based browser over the Chrome DevTools
 * Protocol using Node's built-in WebSocket (design: docs/browser-design.md).
 * Every operation emits structured results the gate can consume as
 * verification evidence; screenshots land in .project-agent/cache/screenshots/.
 */

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

interface ConsoleEntry {
  type: string;
  text: string;
  t: number;
}

interface BrowserSession {
  child: ChildProcess;
  ws: WebSocket;
  port: number;
  consoleEntries: ConsoleEntry[];
  currentUrl: string;
}

let session: BrowserSession | undefined;

function result(ok: boolean, output: string, meta?: Record<string, unknown>, errorCategory?: string): ToolResult {
  return { ok, output, meta, errorCategory };
}

const BROWSER_CANDIDATES = process.env["TELOS_BROWSER"]
  ? [process.env["TELOS_BROWSER"]]
  : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge", "brave-browser"];

/** Find a usable Chromium-family browser binary. */
async function findBrowser(): Promise<string | undefined> {
  const { access, constants } = await import("node:fs/promises");
  for (const bin of BROWSER_CANDIDATES) {
    if (!bin) continue;
    if (bin.includes("/")) {
      try {
        await access(bin, constants.X_OK);
        return bin;
      } catch {
        continue;
      }
    }
    for (const dir of (process.env["PATH"] ?? "").split(":")) {
      if (!dir) continue;
      try {
        await access(join(dir, bin), constants.X_OK);
        return bin;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

/** Launch headless browser with CDP and return (port, child). */
async function launchBrowser(ctx: ToolExecContext, url: string): Promise<{ port: number; child: ChildProcess }> {
  const bin = await findBrowser();
  if (!bin) {
    throw new Error(
      "no Chromium-based browser found (looked for: " + BROWSER_CANDIDATES.filter(Boolean).join(", ") + "). Install Chrome/Chromium or set TELOS_BROWSER=/path/to/chrome",
    );
  }
  const child = spawn(bin, ["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + join(ctx.root, ".project-agent", "cache", "browser-profile"), url], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("browser did not report a DevTools port within 15s")), 15_000);
    let buf = "";
    const onData = (d: Buffer): void => {
      buf += d.toString();
      const m = /DevTools listening on ws:\/\/[^\s]*:(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    child.stderr!.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`browser exited early (code ${code}): ${buf.slice(0, 200)}`));
    });
  });
  return { port, child };
}

/** Minimal CDP-over-WebSocket client: request(id) → response, events buffered. */
async function connectCdp(port: number, onEvent: (type: string, text: string) => void): Promise<WebSocket> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<Record<string, unknown>>;
  const page = targets.find((t) => t["type"] === "page");
  const wsUrl = page?.["webSocketDebuggerUrl"];
  if (typeof wsUrl !== "string") throw new Error("no page target found in browser");
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP WebSocket connect timed out")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP WebSocket failed to connect"));
    }, { once: true });
  });
  ws.addEventListener("message", (ev) => {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(String(ev.data)) as CdpMessage;
    } catch {
      return;
    }
    if (msg.id !== undefined || !msg.method || !msg.params) return; // responses matched in sendCdp
    if (msg.method === "Runtime.consoleAPICalled") {
      const args = (msg.params["args"] ?? []) as Array<Record<string, unknown>>;
      onEvent(String(msg.params["type"] ?? "log"), args.map((a) => String(a["value"] ?? a["description"] ?? "")).join(" "));
    } else if (msg.method === "Log.entryAdded") {
      const entry = (msg.params["entry"] ?? {}) as Record<string, unknown>;
      onEvent(String(entry["level"] ?? "log"), String(entry["text"] ?? ""));
    }
  });
  return ws;
}

let cdpSeq = 1;
function sendCdp(ws: WebSocket, method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const id = cdpSeq++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), timeoutMs);
    const onMessage = (ev: MessageEvent): void => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(String(ev.data)) as CdpMessage;
      } catch {
        return;
      }
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`CDP ${method}: ${msg.error.message}`));
      else resolve(msg.result ?? {});
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Get or create the shared browser session. */
async function ensureSession(ctx: ToolExecContext, cancellation: CancellationController, startUrl: string): Promise<BrowserSession> {
  if (session && session.ws.readyState === WebSocket.OPEN) return session;
  await closeSession();
  const { port, child } = await launchBrowser(ctx, startUrl);
  cancellation.track(child);
  const entries: ConsoleEntry[] = [];
  const ws = await connectCdp(port, (type, text) => {
    entries.push({ type, text, t: Date.now() });
    if (entries.length > 500) entries.shift();
  });
  await sendCdp(ws, "Runtime.enable");
  await sendCdp(ws, "Page.enable");
  await sendCdp(ws, "Log.enable");
  session = { child, ws, port, consoleEntries: entries, currentUrl: startUrl };
  return session;
}

async function closeSession(): Promise<void> {
  if (!session) return;
  try {
    session.ws.close();
  } catch {
    /* already closed */
  }
  try {
    session.child.kill("SIGKILL");
  } catch {
    /* already dead */
  }
  session = undefined;
}

/** End the browser session (wired into the runtime on cancellation/shutdown). */
export async function closeBrowserSession(): Promise<void> {
  await closeSession();
}

async function navigate(ctx: ToolExecContext, cancellation: CancellationController, url: string): Promise<ToolResult> {
  const s = await ensureSession(ctx, cancellation, "about:blank");
  await sendCdp(s.ws, "Page.navigate", { url });
  await new Promise((r) => setTimeout(r, 800)); // give JS a beat to settle
  s.currentUrl = url;
  return result(true, `opened ${url}`);
}

export function registerBrowserTools(registry: ToolRegistry, deps: { cancellation: CancellationController }): void {
  const browserTool = (partial: Omit<ToolDefinition, "permission" | "mutative" | "risk">): ToolDefinition => ({
    permission: "network",
    mutative: false,
    risk: "medium",
    ...partial,
  });

  registry.register(
    browserTool({
      name: "browser_open",
      description: "Launch (or reuse) the headless browser and navigate to a URL. Required before other browser_* tools. Fails clearly if no Chromium browser exists.",
      parameters: { type: "object", properties: { url: { type: "string", description: "Absolute http(s) URL to open" } }, required: ["url"], additionalProperties: false },
      async execute(args, ctx) {
        const url = String(args["url"] ?? "").trim();
        if (!/^https?:\/\//i.test(url) && url !== "about:blank") return result(false, "browser_open: an absolute http(s) URL is required", undefined, "bad_args");
        try {
          return await navigate(ctx, deps.cancellation, url);
        } catch (err) {
          return result(false, `browser_open failed: ${(err as Error).message}`, undefined, "browser_unavailable");
        }
      },
    }),
  );

  registry.register(
    browserTool({
      name: "browser_click",
      description: "Click an element in the open browser page by CSS selector.",
      parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector" } }, required: ["selector"], additionalProperties: false },
      async execute(args, ctx) {
        if (!session) return result(false, "browser_click: no browser open — call browser_open first", undefined, "bad_args");
        const selector = String(args["selector"] ?? "");
        try {
          const r = await sendCdp(session.ws, "Runtime.evaluate", {
            expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return "NOT_FOUND"; el.click(); return "CLICKED"; })()`,
            returnByValue: true,
          });
          const value = String((r["result"] as Record<string, unknown> | undefined)?.["value"] ?? "");
          if (value === "NOT_FOUND") return result(false, `browser_click: no element matches ${selector}`, undefined, "selector_not_found");
          await new Promise((res) => setTimeout(res, 400));
          return result(true, `clicked ${selector}`);
        } catch (err) {
          return result(false, `browser_click failed: ${(err as Error).message}`, undefined, "browser_error");
        }
      },
    }),
  );

  registry.register(
    browserTool({
      name: "browser_type",
      description: "Type text into an input/textarea in the open browser page (clears existing value first).",
      parameters: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" } }, required: ["selector", "text"], additionalProperties: false },
      async execute(args, ctx) {
        if (!session) return result(false, "browser_type: no browser open — call browser_open first", undefined, "bad_args");
        const selector = String(args["selector"] ?? "");
        const text = String(args["text"] ?? "");
        try {
          const r = await sendCdp(session.ws, "Runtime.evaluate", {
            expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return "NOT_FOUND"; el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return "TYPED"; })()`,
            returnByValue: true,
          });
          const value = String((r["result"] as Record<string, unknown> | undefined)?.["value"] ?? "");
          if (value === "NOT_FOUND") return result(false, `browser_type: no element matches ${selector}`, undefined, "selector_not_found");
          return result(true, `typed into ${selector}`);
        } catch (err) {
          return result(false, `browser_type failed: ${(err as Error).message}`, undefined, "browser_error");
        }
      },
    }),
  );

  registry.register(
    browserTool({
      name: "browser_screenshot",
      description: "Capture a PNG screenshot of the open page. Saved under .project-agent/cache/screenshots/; the path is returned. Attach it with /image for visual inspection.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        if (!session) return result(false, "browser_screenshot: no browser open — call browser_open first", undefined, "bad_args");
        try {
          const r = await sendCdp(session.ws, "Page.captureScreenshot", { format: "png" });
          const data = String(r["data"] ?? "");
          if (!data) return result(false, "browser_screenshot: empty capture", undefined, "browser_error");
          const dir = join(ctx.root, ".project-agent", "cache", "screenshots");
          await mkdir(dir, { recursive: true });
          const path = join(".project-agent", "cache", "screenshots", `shot-${Date.now()}.png`);
          await writeFile(join(ctx.root, path), Buffer.from(data, "base64"));
          return result(true, `screenshot saved: ${path} (${Math.round((data.length * 3) / 4 / 1024)} KB, url: ${session.currentUrl})`, { path });
        } catch (err) {
          return result(false, `browser_screenshot failed: ${(err as Error).message}`, undefined, "browser_error");
        }
      },
    }),
  );

  registry.register(
    browserTool({
      name: "browser_console",
      description: "Return collected console messages and page errors (log/warn/error) since the browser opened, plus the current URL and page title.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        if (!session) return result(false, "browser_console: no browser open — call browser_open first", undefined, "bad_args");
        try {
          const r = await sendCdp(session.ws, "Runtime.evaluate", { expression: "document.title", returnByValue: true });
          const title = String((r["result"] as Record<string, unknown> | undefined)?.["value"] ?? "");
          const lines = [`url: ${session.currentUrl}`, `title: ${title}`, session.consoleEntries.length ? "console:" : "console: (no entries)"];
          for (const e of session.consoleEntries.slice(-40)) lines.push(`  [${e.type}] ${e.text.slice(0, 200)}`);
          const errors = session.consoleEntries.filter((e) => e.type === "error").length;
          const t = truncateOutput(ctx.redact(lines.join("\n")), ctx.maxOutputBytes);
          return result(true, t.text, { errors });
        } catch (err) {
          return result(false, `browser_console failed: ${(err as Error).message}`, undefined, "browser_error");
        }
      },
    }),
  );
}
