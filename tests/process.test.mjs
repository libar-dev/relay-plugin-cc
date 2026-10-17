import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { makeTempDir, writeExecutable } from "./support/helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { isProcessAlive, isProcessIdentityAlive, readProcessStartTime, terminateProcessTree, listProcesses, liveSnapshotMembers, stopProcessSnapshot } from "../plugins/relay/scripts/lib/util/process.mjs";

test("terminateProcessTree signals the pid when the group kill fails with ESRCH", () => {
  const calls = [];
  const outcome = terminateProcessTree(4321, {
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        const error = new Error("kill ESRCH");
        error.code = "ESRCH";
        throw error;
      }
    }
  });

  assert.deepEqual(calls, [
    [-4321, "SIGTERM"],
    [4321, "SIGTERM"]
  ]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process");
});

test("isProcessAlive and readProcessStartTime describe the current process", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(-1), false);
  assert.ok(readProcessStartTime(process.pid));
  assert.equal(readProcessStartTime(process.pid), readProcessStartTime(process.pid));
});

test('an unreadable process table retains a stale identity and signals nothing', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const ended = once(child, 'exit');
  const oldPath = process.env.PATH;
  const bin = makeTempDir('relay-ps-');
  writeExecutable(path.join(bin, 'ps'), '#!/bin/sh\nexit 1\n');
  const snapshot = [{ pid: child.pid, startTime: 'ps:Thu Jan 1 00:00:00 1970' }];
  const signals = [];
  try {
    assert.ok(listProcesses().some(row => row.pid === child.pid));
    assert.deepEqual(liveSnapshotMembers(snapshot), []);
    process.env.PATH = bin;
    const survivors = await stopProcessSnapshot(snapshot, { killImpl: (pid, signal) => signals.push([pid, signal]), graceMs: 0 });
    assert.deepEqual(signals, []);
    assert.deepEqual([...survivors], snapshot);
    assert.match(survivors.cause, /process table could not be read/);
    assert.deepEqual(liveSnapshotMembers(snapshot), snapshot);
  } finally {
    process.env.PATH = oldPath;
    child.kill();
    await ended;
  }
});

test('cancel fails with the cause when the process table becomes unreadable after its snapshot', async t => {
  const { setup, startJob, readJob, waitFor, companion } = await import('./support/job-helpers.mjs');
  const ctx = setup(t, { turnMs: 30000 });
  const { id } = startJob(ctx, undefined, "Long running task");
  await waitFor(() => readJob(ctx, id).turnId);
  const bin = makeTempDir('relay-cancel-ps-');
  const counter = path.join(bin, 'read');
  writeExecutable(path.join(bin, 'ps'), `#!/bin/sh
if [ "$1" = "-A" ]; then
  if [ -e '${counter}' ]; then exit 1; fi
  touch '${counter}'
fi
exec /bin/ps "$@"
`);
  const cancelled = companion(ctx, ['cancel', id], { PATH: `${bin}:${ctx.env.PATH}`, RELAY_JOBS_CANCEL_GRACE_MS: '0' });
  assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
  assert.match(cancelled.stderr, /process table could not be read/);
});

test("a cancel whose later process-table read fails still signals the worker's group, then reports the failure", async t => {
  const { setup, startJob, readJob, waitFor, companion } = await import('./support/job-helpers.mjs');
  const ctx = setup(t, { turnMs: 30000 });
  // The worker reads its inbox slowly, so a cancel with no grace takes the kill path.
  ctx.env.RELAY_JOBS_POLL_MS = '5000';
  const { id } = startJob(ctx, undefined, "Long running task");
  await waitFor(() => readJob(ctx, id).turnId && readJob(ctx, id).server?.pid);
  const { worker, server } = readJob(ctx, id);
  assert.ok(isProcessIdentityAlive(worker) && isProcessIdentityAlive(server));
  const bin = makeTempDir('relay-cancel-ps-');
  const counter = path.join(bin, 'read');
  // The first read of the whole table works; every later one fails.
  writeExecutable(path.join(bin, 'ps'), `#!/bin/sh
if [ "$1" = "-A" ]; then
  if [ -e '${counter}' ]; then exit 1; fi
  touch '${counter}'
fi
exec /bin/ps "$@"
`);
  const cancelled = companion(ctx, ['cancel', id], { PATH: `${bin}:${ctx.env.PATH}`, RELAY_JOBS_CANCEL_GRACE_MS: '0' });
  assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
  assert.match(cancelled.stderr, /process table could not be read/);
  // The signals still went: the worker and the server in its group are gone, and the job, never
  // marked cancelled, reads dead.
  await waitFor(() => !isProcessIdentityAlive(worker) && !isProcessIdentityAlive(server), 5000);
  assert.match(companion(ctx, ['status', id]).stdout, /^state: dead$/m);
});
