import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancellationController, killTree } from "../src/runtime/cancellation.ts";

/**
 * Mandatory acceptance test (Part 79 / Part 47):
 * a long-running shell command with a grandchild process must leave NO orphan
 * after cancellation — the port/file-lock analogy in the spec: the child tree
 * is really terminated, not merely unread.
 */

function startOrphanPair(scriptPath: string): ChildProcess {
  // Detached => own process group => group-kill reaches the grandchild.
  return spawn(process.execPath, [scriptPath], { detached: true, stdio: "ignore" });
}

const SPAWN_SCRIPT = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 500)"], { detached: false, stdio: "ignore" });
writeFileSync(join(__dirname, "grandchild.pid"), String(child.pid));
setInterval(() => {}, 500);
`;

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("cancellation terminates the child process tree (no orphans)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-cancel-"));
  try {
    const script = join(dir, "spawner.cjs");
    writeFileSync(script, SPAWN_SCRIPT, "utf8");

    const ctrl = new CancellationController();
    const child = startOrphanPair(script);
    ctrl.track(child);

    const gcPidPath = join(dir, "grandchild.pid");
    for (let i = 0; i < 40 && !existsSync(gcPidPath); i++) await wait(50);
    assert.ok(existsSync(gcPidPath), "grandchild pid file should appear");
    const gcPid = Number(readFileSync2(gcPidPath));
    assert.ok(Number.isInteger(gcPid) && gcPid > 0);
    assert.ok(pidAlive(gcPid), "grandchild should be running before cancel");

    ctrl.cancel("test");

    const exited = await waitForExit(child, 5000);
    assert.ok(exited, "child should exit after cancellation");
    await wait(300);
    assert.ok(!pidAlive(gcPid), "grandchild must be terminated — no orphans allowed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("killTree terminates an untracked child directly", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 500)"], { detached: true, stdio: "ignore" });
  await wait(150);
  killTree(child);
  const exited = await waitForExit(child, 5000);
  assert.ok(exited, "child should exit after killTree");
});

function readFileSync2(path: string): string {
  return readFileSync(path, "utf8");
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
