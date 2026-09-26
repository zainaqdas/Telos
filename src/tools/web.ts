import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolRegistry, ToolResult, ToolExecContext } from "./registry.ts";
import { truncateOutput } from "./util.ts";

/**
 * Web tools (Parts 48–49). Zero runtime dependencies: web_search uses the
 * DuckDuckGo Lite HTML endpoint (keyless) with a deterministic result parser;
 * read_url fetches a page and extracts readable text. Research results keep
 * their sources (URLs travel with every claim) and are redacted + capped like
 * every other tool output.
 */

const UA = "Mozilla/5.0 (X11; Linux x86_64) Telos/0.1 (terminal agent)";

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

function result(ok: boolean, output: string, meta?: Record<string, unknown>, errorCategory?: string): ToolResult {
  return { ok, output, meta, errorCategory };
}

/** Deterministic HTML-entity decode (no dep). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x2F;|&#47;/g, "/");
}

/** Strip tags + collapse whitespace. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Parse DuckDuckGo Lite results. Shape (verified against the live endpoint):
 * a results table where each row is
 *   <td valign="top">N.&nbsp;</td>
 *   <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=ENCODED&rut=…" class='result-link'>TITLE</a></td>
 *   <td class='result-snippet'>SNIPPET (may contain <b> and &lt;em&gt;)</td>
 * Class attributes use SINGLE quotes; snippets are siblings of the link cells
 * in document order, so we pair them by walking the rows.
 */
export function parseDuckDuckGoLite(html: string): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  // href may precede or follow class; accept both orders and both quote styles.
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*result-link[^"']*["'][^>]*>([\s\S]*?)<\/a>|<a\b[^>]*class=["'][^"']*result-link[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]*class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi;

  // Snippets carry real tags (<b>) AND HTML-escaped markup (&lt;em&gt;):
  // decode first, then strip decoded tags with empty string (a space would
  // orphan punctuation: "site .").
  const snippets: string[] = [];
  for (const m of html.matchAll(snippetRe)) {
    const raw = m[1] ?? "";
    snippets.push(textOf(decodeEntities(raw).replace(/<[^>]*>/g, "")));
  }

  let i = 0;
  for (const m of html.matchAll(anchorRe)) {
    // Two alternatives: href-then-class (groups 1/2) or class-then-href (3/4).
    const rawUrl = decodeEntities(m[1] ?? m[3] ?? "");
    const url = normalizeDuckUrl(rawUrl);
    if (!url || !/^https?:\/\//.test(url)) continue;
    const title = textOf(m[2] ?? m[4] ?? "");
    if (!title) continue;
    hits.push({ title, url, snippet: snippets[i] ?? "" });
    i += 1;
    if (hits.length >= 10) break;
  }
  return hits;
}

/** DuckDuckGo wraps target URLs in a redirect (/l/?uddg=ENCODED); unwrap. */
export function normalizeDuckUrl(url: string): string {
  const m = /\/\/duckduckgo\.com\/l\/\?.*uddg=([^&]+)/.exec(url);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return "";
    }
  }
  return url;
}

/** Extract readable text from an HTML page: drop script/style/nav noise. */
export function extractReadableText(html: string): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<(br|p|div|section|article|h[1-6]|li|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(cleaned)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Extract <title>. */
export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? textOf(m[1] ?? "").slice(0, 200) : "";
}

async function fetchWithTimeout(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" }, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function registerWebTools(registry: ToolRegistry): void {
  registry.register({
    name: "web_search",
    description: "Search the web (DuckDuckGo, keyless) and return up to 10 results with title, URL, and snippet. Always cite the URL when using a result.",
    permission: "network",
    mutative: false,
    risk: "low",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const query = String(args["query"] ?? "").trim();
      if (!query) return result(false, "web_search: query required", undefined, "bad_args");
      try {
        const res = await fetchWithTimeout(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, 15_000, ctx.signal);
        if (!res.ok) return result(false, `web_search: HTTP ${res.status}`, undefined, "network");
        const hits = parseDuckDuckGoLite(await res.text());
        if (!hits.length) return result(true, `web_search: no results for ${JSON.stringify(query)}`);
        const body = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet.slice(0, 240)}` : ""}`).join("\n");
        const t = truncateOutput(ctx.redact(body), ctx.maxOutputBytes);
        return result(true, t.text, { count: hits.length });
      } catch (err) {
        return result(false, `web_search failed: ${(err as Error).message}`, undefined, "network");
      }
    },
  });

  registry.register({
    name: "read_url",
    description:
      "Fetch a URL and return its readable text (scripts/styles/nav stripped, entities decoded, capped). Writes the full text to .project-agent/cache/reads/ for reference and returns title + text + a cache path.",
    permission: "network",
    mutative: false,
    risk: "low",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http(s) URL" }, max_chars: { type: "integer", description: "Cap on returned text (default 20000)" } },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const url = String(args["url"] ?? "").trim();
      if (!/^https?:\/\//i.test(url)) return result(false, "read_url: an absolute http(s) URL is required", undefined, "bad_args");
      const maxChars = typeof args["max_chars"] === "number" && args["max_chars"] > 0 ? Math.min(args["max_chars"], 100_000) : 20_000;
      try {
        const res = await fetchWithTimeout(url, 20_000, ctx.signal);
        if (!res.ok) return result(false, `read_url: HTTP ${res.status} for ${url}`, undefined, "network");
        const contentType = res.headers.get("content-type") ?? "";
        const raw = await res.text();
        const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(raw);
        const title = isHtml ? extractTitle(raw) : "";
        const text = isHtml ? extractReadableText(raw) : raw;
        // Cache the full text for later reference (sources are kept, Part 48).
        const cacheDir = join(ctx.root, ".project-agent", "cache", "reads");
        await mkdir(cacheDir, { recursive: true });
        const safeName = url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]+/gi, "_").slice(0, 80) || "read";
        const cachePath = join(".project-agent", "cache", "reads", `${safeName}.txt`);
        await writeFile(join(ctx.root, cachePath), text, "utf8").catch(() => {});
        const header = `${title ? `title: ${title}\n` : ""}url: ${url}\ncached: ${cachePath}\n\n`;
        const t = truncateOutput(ctx.redact(header + text.slice(0, maxChars)), ctx.maxOutputBytes);
        return result(true, t.text, { url, title, cachedPath: cachePath });
      } catch (err) {
        return result(false, `read_url failed: ${(err as Error).message}`, undefined, "network");
      }
    },
  });
}
