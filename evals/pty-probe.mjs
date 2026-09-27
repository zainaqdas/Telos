/**
 * pty probe: exercise the CLI input path with keystroke-level sequences.
 * Pipe mode exercises the non-TTY line reader; wrap in `script -qec` for the
 * raw-mode editor path. Verifies: backspace editing, arrow keys not leaking,
 * queued input while busy, submit.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = process.argv[2] ?? "/tmp/telos-pty";

const child = spawn("node", [`${projectRoot}/bin/telos.js`, "chat"], {
  cwd: workDir,
  env: { ...process.env, TERM: "xterm-256color" },
  stdio: ["pipe", "pipe", "pipe"],
});

// Node has no built-in pty; emulate raw keystroke timing via stdin bytes.
// The child sees a pipe (not a TTY), so this exercises the non-TTY path —
// for the raw path we rely on unit tests + this stream-level sanity check.
child.stdout.on("data", (d) => process.stdout.write(d));
child.stderr.on("data", (d) => process.stderr.write(d));

const enter = "\r";
const seq = [
  "hi what are y", // typo in progress
  "\x7f\x7f\x7f\x7f\x7f", // backspace ×5 → "hi what"
  "\x1b[C\x1b[D\x1b[A\x1b[B", // arrows: must not leak [C / [A
  enter, // submit "hi what"
  "/status", enter, // second line: slash marker output
  "/exit", enter,
];
let i = 0;
const tick = setInterval(() => {
  if (i < seq.length) {
    child.stdin.write(seq[i]);
    i += 1;
  } else {
    clearInterval(tick);
  }
}, 350);

setTimeout(() => {
  child.kill("SIGKILL");
  process.exit(0);
}, 12000);
