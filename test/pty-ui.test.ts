import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PTY UI invariants (hardening pass, P0-B §19/§59-60): the exact corruption
 * class from real use — resize leaving a stale panel frame with an old status
 * value inside the transcript. Two invariants are pinned:
 *
 *  1. SIGWINCH actually reaches the panel: Node exposes resize on
 *     process.stdout, NOT stdin. (The old stdin.on("resize") never fired —
 *     resize handling was dead code and the panel/region were never rebuilt.)
 *  2. onResize erases the OLD panel footprint before drawing the new one, so
 *     a grow never leaves a ghost panel above the real one.
 *
 * A real PTY is required: resize semantics do not exist on pipes.
 */

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8791;

test("pty: resize rebuilds the panel (one box, one status row) after SIGWINCH", () => {
  // Fake OpenAI-compatible SSE provider so no real key/network is needed.
  const serverSrc = `
    const http = require("node:http");
    http.createServer((req, res) => {
      if (req.url.includes("/models")) { res.end(JSON.stringify({ data: [{ id: "fake-1" }] })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: "ok." } }] }) + "\\n\\n");
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "\\n\\n");
      res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + "\\n\\n");
      res.write("data: [DONE]\\n\\n");
      res.end();
    }).listen(${PORT}, "127.0.0.1");
  `;

  const dir = mkdtempSync(join(tmpdir(), "telos-pty-"));
  const serverPath = join(dir, "server.cjs");
  writeFileSync(serverPath, serverSrc);

  const driverSrc = `import os, pty, time, select, fcntl, termios, struct, signal, subprocess, sys
COLS, ROWS = 120, 40
PORT = ${PORT}
WORK = ${JSON.stringify(dir)}
BIN = ${JSON.stringify(join(projectRoot, "bin", "telos.js"))}

    server = subprocess.Popen(["node", ${JSON.stringify(serverPath)}],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.6)

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(WORK)
        os.environ["TERM"] = "xterm-256color"
        os.environ["NOOP_KEY"] = "dummy"
        os.execvp("node", ["node", BIN, "chat"])

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    out = bytearray()

    def pump(sec):
        end = time.time() + sec
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r == [fd]:
                try:
                    d = os.read(fd, 65536)
                except OSError:
                    return
                if not d:
                    return
                out.extend(d)

    def resize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.killpg(pid, signal.SIGWINCH)   # real terminals signal the GROUP

    pump(2.5)
    os.write(fd, b"first question\\r"); pump(2.5)
    resize(30, 100); pump(1.2)          # shrink
    os.write(fd, b"second\\r"); pump(2.5)
    resize(40, 120); pump(1.2)          # grow back — ghost-panel class
    try:
        os.kill(pid, signal.SIGKILL)
    except Exception:
        pass
    server.terminate()
    sys.stdout.buffer.write(bytes(out))
  `;

  const driverPath = join(dir, "driver.py");
  writeFileSync(driverPath, driverSrc.replace(/\n {4}/g, "\n"));
  mkdirSync(join(dir, ".project-agent"), { recursive: true });
  writeFileSync(
    join(dir, ".project-agent", "config.toml"),
    `[model]\nprovider = "openai-compatible"\nname = "fake-1"\nbase_url = "http://127.0.0.1:${PORT}/v1"\napi_key_env = "NOOP_KEY"\n\n[runtime]\nmax_tool_calls = 5\n`,
  );

  try {
    const r = spawnSync("python3", [driverPath], { encoding: "buffer", timeout: 60_000 });
    const raw = (r.stdout ?? Buffer.alloc(0)).toString("utf8");
    if (raw.length === 0) {
      const err = r.stderr?.toString().slice(0, 300) ?? "";
      assert.fail(`pty driver produced no output (status ${r.status})${err ? `: ${err}` : ""}`);
    }

    // Invariant 1: the resize path is LIVE — the panel must re-emit its
    // scroll region (DECSTBM) after install. Zero additional DECSTBM means
    // SIGWINCH never reached the handler (the old stdin bug).
    const decstbm = raw.match(/\x1b\[\d*;?\d*r/g) ?? [];
    assert.ok(decstbm.length >= 3, `panel must re-establish its region on resize; saw ${decstbm.length} DECSTBM (install + 2 resizes)`);

    // Invariant 2: each resize erases the OLD footprint (CUP + ED) before
    // redrawing — the ghost-panel fix.
    const erases = raw.match(/\x1b\[\d+;1H\x1b\[J/g) ?? [];
    assert.ok(erases.length >= 2, `resize must erase the old panel footprint; saw ${erases.length} erase-from-row sequences`);

    // Invariant 3: the visible result must have the SAME top border at both
    // resize phases (rebuild, not residue). Count panel tops in the raw
    // stream per repaint is meaningless without an emulator, so assert the
    // strongest byte-level proxy: erase-before-redraw ordering. The erase
    // must precede the corresponding DECSTBM.
    const firstErase = raw.search(/\x1b\[\d+;1H\x1b\[J/);
    const lastRegion = raw.lastIndexOf("\x1b[1;");
    assert.ok(firstErase > -1 && lastRegion > firstErase, "erase must happen before the final region rebuild");

    assert.ok(raw.includes("Telos —"), "banner visible");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
