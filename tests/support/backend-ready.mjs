// A check under a short time limit counts the limit from a backend process that runs, not from one
// still starting. Setup and the stop gate's probes arm each check's limit right after spawning the
// backend binary (codex, grok, zcode or kimi), in the same tick. That timer is armed only once the
// process has created <RELAY_TEST_READY_DIR>/<its pid>, or has ended; everything else runs as usual
// meanwhile, the other checks included. A test that makes one check hang needs that process, and
// every process of the checks meant to finish, to get that far before the limit, and a busy machine
// can make a fake's start alone slower than the limit. The fakes say they run (READY_SOURCE); a
// wrapper script that never runs one says so itself.
//
// In a companion or a hook: NODE_OPTIONS="--import <this file>" with RELAY_TEST_READY_DIR=<dir>
// (backendReadyEnv). The processes it starts see the variable, so the fakes can answer; they start
// no backend binary, so nothing of theirs waits.
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { syncBuiltinESMExports } from "node:module";

// The environment for a companion or hook whose checks count their limits from running processes.
export function backendReadyEnv(env = process.env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ready-"));
  return { NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${import.meta.url}`.trim(), RELAY_TEST_READY_DIR: dir };
}

// Source for a fake backend: the process says it runs.
export const READY_SOURCE = `if (process.env.RELAY_TEST_READY_DIR) require("node:fs").writeFileSync(require("node:path").join(process.env.RELAY_TEST_READY_DIR, String(process.pid)), "");`;

const BACKENDS = new Set(["codex", "grok", "zcode", "kimi"]);
const ready = process.env.RELAY_TEST_READY_DIR;
if (ready) {
  const { setTimeout: arm, clearTimeout: disarm } = globalThis;
  const deferred = new WeakSet();
  let spawned = null;
  const spawn = childProcess.spawn;
  childProcess.spawn = function (command, ...rest) {
    const child = spawn.call(this, command, ...rest);
    if (BACKENDS.has(path.basename(String(command)))) {
      spawned = child;
      queueMicrotask(() => { if (spawned === child) spawned = null; });
    }
    return child;
  };
  syncBuiltinESMExports();
  globalThis.setTimeout = function (callback, ms, ...args) {
    const child = spawned;
    if (!child) return arm(callback, ms, ...args);
    spawned = null;
    const marker = path.join(ready, String(child.pid));
    const limit = { timer: null, cleared: false };
    deferred.add(limit);
    const start = () => {
      if (limit.cleared) return;
      const runs = fs.existsSync(marker) || child.exitCode !== null || child.signalCode !== null;
      limit.timer = runs ? arm(callback, ms, ...args) : arm(start, 5);
    };
    start();
    return limit;
  };
  globalThis.clearTimeout = function (timer) {
    if (deferred.has(timer)) {
      timer.cleared = true;
      disarm(timer.timer);
    } else disarm(timer);
  };
}
