# Browser automation — design decision (spec Parts 49–50)

## Requirement

Real browser verification (open/click/type/screenshot/console/logs) whose
results can become Completion Gate evidence. Constraint inherited from the
product's foundation: **zero runtime dependencies** (the entire CLI runs on
Node built-ins; only TypeScript + `@types/node` exist as devDependencies).

## Options considered

| Option | Verdict |
|---|---|
| Playwright / Puppeteer | Rejected for v1: heavy runtime deps (100+ MB browser downloads), violates the zero-dep foundation, and drags install complexity into every user's project. Revisit only as an *optional* peer package later. |
| Selenium / WebDriver | Rejected: external JVM/driver processes, brittle wiring, same dependency problem. |
| Headless "HTTP-only" fake (fetch + string matching) | Rejected: it is exactly the "convincing reasoning instead of verified work" failure the spec forbids — no layout, no JS, no console, no screenshots. |
| **Chrome DevTools Protocol (CDP) over Node's built-in WebSocket client** | **Chosen.** Node ≥22 ships a stable native `WebSocket` global. A Chromium-based browser (Chrome/Edge/Chromium/Brave) driven over CDP needs *no npm package*: launch the browser with `--remote-debugging-port`, discover targets via the `http://127.0.0.1:<port>/json` HTTP endpoint, connect, and send JSON commands. |

## The chosen design

```
browser_launch(user-supplied executable path or env override)
  → spawn <browser> --headless=new --remote-debugging-port=0 <url>
  → read "DevTools listening on ws://127.0.0.1:PORT/..." from stderr
  → GET /json/list → pick page target → webSocketDebuggerUrl
  → native WebSocket to the target
  → JSON-RPC: Runtime.evaluate, Page.navigate, Page.captureScreenshot,
              Runtime.consoleAPICalled (event), Log.entryAdded (event)
```

Key properties:

- **No dependencies.** `spawn`, `fetch`, `WebSocket` — all Node built-ins.
- **The user's own browser.** Synergon never downloads a browser; it looks for
  `google-chrome`, `chromium`, `chrome`, or `msedge` on PATH (or the
  `SYNERGON_BROWSER` env var). Browsers are near-universal; the tool fails
  with a clear, actionable message when none exists.
- **One browser per session**, launched lazily on first `browser_*` call,
  killed on session end (tracked by the CancellationController — no orphans,
  same discipline as shell children).
- **Deterministic evidence**: every browser operation appends a
  `verification_result` event (`kind: "browser"`, `ok`, observation), and
  screenshots are written to `.project-agent/cache/screenshots/` so the user
  can inspect what the agent saw. Gate integration reuses the existing
  `*-verify` checklist path.
- **Commands** (spec Part 49, mapped to CDP):
  `browser_open` (launch/navigate), `browser_click` (Runtime.evaluate →
  `el.click()` by selector), `browser_type` (focus + input events),
  `browser_screenshot` (`Page.captureScreenshot`, base64 → file),
  `browser_console` (collected `consoleAPICalled`/`Log.entryAdded` entries).
  `scroll` folds into `browser_click`/`browser_type` via evaluate; the five
  tools cover the spec's open/click/type/screenshot/console/logs list with
  logs = `browser_console`.

## Risks / limits (honest)

- CDP shape varies slightly across Chromium versions; we pin to commands that
  have been stable for years (evaluate/navigate/screenshot/console).
- No Firefox/Safari (their CDP support is incomplete). Documented, not hidden.
- If no browser binary exists, every tool returns a structured
  "browser not found" failure — the gate then honestly reports BLOCKED rather
  than pretending verification happened.
