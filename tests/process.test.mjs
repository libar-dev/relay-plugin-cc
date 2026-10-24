import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { makeTempDir, writeExecutable } from "./support/helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { groupSurvivors, inOwnUserScope, isProcessAlive, isProcessIdentityAlive, readProcessStartTime, snapshotProcessTree, terminateProcessTree, listProcesses, liveSnapshotMembers, stopProcessSnapshot } from "../plugins/relay/scripts/lib/util/process.mjs";

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

test("a worker started from a unit of the user's systemd goes through systemd-run --user --scope, and only then", () => {
  const service = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/t3code.service\n";
  const scoped = inOwnUserScope("node", ["companion.mjs", "worker", "/j"], { platform: "linux", env: {}, cgroup: service, probe: () => true, description: "relay job worker j" });
  assert.equal(scoped.command, "systemd-run");
  assert.deepEqual(scoped.args, ["--user", "--scope", "--quiet", "--collect", "--description=relay job worker j", "--", "node", "companion.mjs", "worker", "/j"]);
  const plain = { command: "node", args: ["w"] };
  assert.deepEqual(inOwnUserScope("node", ["w"], { platform: "darwin", env: {}, cgroup: service, probe: () => true }), plain, "not Linux");
  assert.deepEqual(inOwnUserScope("node", ["w"], { platform: "linux", env: { RELAY_WORKER_SCOPE: "off" }, cgroup: service, probe: () => true }), plain, "turned off");
  assert.deepEqual(inOwnUserScope("node", ["w"], { platform: "linux", env: {}, cgroup: "0::/user.slice/user-1000.slice/session-7.scope\n", probe: () => true }), plain, "a login session");
  assert.deepEqual(inOwnUserScope("node", ["w"], { platform: "linux", env: {}, cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-p1-i2.scope\n", probe: () => true }), plain, "already a scope");
  assert.deepEqual(inOwnUserScope("node", ["w"], { platform: "linux", env: {}, cgroup: service, probe: () => false }), plain, "systemd-run cannot make a scope");
});


test("groupSurvivors finds only original group members born no earlier than the worker", () => {
  const leader = { pid: 4321, startTime: "linux:99" };
  const row = (pid, pgid, startTime, zombie = false) => ({ pid, pgid, ppid: 1, startTime, zombie, startedAtMs: 1000 });
  const table = [row(5000, 4321, "linux:100"), row(5001, 4321, "linux:99"),
    row(5002, 4321, "linux:98"), row(5003, 4322, "linux:100"), row(5004, 4321, null),
    row(5005, 4321, "linux:101", true)];
  const expected = [{ pid: 5000, startTime: "linux:100" }, { pid: 5001, startTime: "linux:99" }, { pid: 5004, startTime: null }];
  assert.deepEqual(groupSurvivors(leader, table, { aliveUntil: "1970-01-01T00:00:03Z" }), expected);
  assert.deepEqual(groupSurvivors(leader, [...table, row(4321, 4321, "linux:200")]), []);
  assert.equal(groupSurvivors(leader, [...table, row(4321, 4321, null)]).some(entry => entry.pid === 4321 && entry.startTime === null), true);
  assert.deepEqual(groupSurvivors({ pid: 4321, startTime: null }, table), []);
  assert.deepEqual(groupSurvivors(null, table), []);
  assert.match(groupSurvivors(leader, null).cause, /process table could not be read/);
});

test("groupSurvivors compares ps identities chronologically across date boundaries", () => {
  const leader = { pid: 4321, startTime: "ps:Wed Dec 31 23:59:59 2025" };
  const table = [
    { pid: 5000, pgid: 4321, startTime: "ps:Thu Jan 1 00:00:00 2026" },
    { pid: 5001, pgid: 4321, startTime: "ps:Wed Dec 31 23:59:58 2025" },
    { pid: 5002, pgid: 4321, startTime: "linux:100" }
  ];
  assert.deepEqual(groupSurvivors(leader, table, { aliveUntil: "2026-01-01T00:00:02Z" }), [{ pid: 5000, startTime: table[0].startTime }]);
});

test("the process table and worker records use the same start-time identity", () => {
  const row = listProcesses().find(row => row.pid === process.pid);
  assert.equal(row.startTime, readProcessStartTime(process.pid));
});

test("terminateProcessTree refuses a mismatched, missing or different-pid identity", () => {
  for (const identity of [{ pid: process.pid, startTime: "linux:1" }, { pid: process.pid },
    { pid: process.pid + 1, startTime: readProcessStartTime(process.pid) }]) {
    const signals = [];
    const result = terminateProcessTree(process.pid, { identity, killImpl: (pid, signal) => { if (signal !== 0) signals.push([pid, signal]); } });
    assert.equal(result.attempted, false);
    assert.deepEqual(signals, []);
  }
});

test("terminateProcessTree rechecks identity between a failed group signal and pid fallback", { skip: process.platform !== "linux" }, t => {
  const identity = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
  const read = fs.readFileSync;
  let reused = false;
  t.mock.method(fs, "readFileSync", function(file, ...args) {
    const value = read.call(this, file, ...args);
    if (reused && String(file) === `/proc/${process.pid}/stat`) {
      const end = value.lastIndexOf(")") + 2;
      const fields = value.slice(end).split(" ");
      fields[19] = String(BigInt(fields[19]) + 1n);
      return value.slice(0, end) + fields.join(" ");
    }
    return value;
  });
  const signals = [];
  const result = terminateProcessTree(process.pid, { identity, killImpl(pid, signal) {
    if (signal === 0) return;
    signals.push([pid, signal]);
    reused = true;
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  } });
  assert.equal(result.delivered, false);
  assert.deepEqual(signals, [[-process.pid, "SIGTERM"]]);
});

test("a group member whose pid is reused after discovery is never signalled", async () => {
  const leader = { pid: 4321, startTime: "linux:99" };
  const tree = groupSurvivors(leader, [{ pid: 5000, pgid: 4321, startTime: "linux:100", startedAtMs: 1000 }], { aliveUntil: "1970-01-01T00:00:03Z" });
  const signals = [];
  const remaining = await stopProcessSnapshot(tree, {
    listProcesses: () => [{ pid: 5000, pgid: 5000, startTime: "linux:200" }],
    killImpl: (pid, signal) => signals.push([pid, signal]), graceMs: 0
  });
  assert.deepEqual(remaining, []);
  assert.deepEqual(signals, []);
});

test("a member replaced between TERM and KILL is not killed under its reused pid", async () => {
  const original = { pid: 5000, startTime: "linux:100" };
  let replaced = false;
  const signals = [];
  const remaining = await stopProcessSnapshot([original], {
    listProcesses: () => [{ ...original, startTime: replaced ? "linux:200" : original.startTime }],
    killImpl: (pid, signal) => { signals.push([pid, signal]); replaced = true; }, graceMs: 0
  });
  assert.deepEqual(remaining, []);
  assert.deepEqual(signals, [[5000, "SIGTERM"]]);
});


test("an absent group leader needs heartbeat or recorded-server proof, including a recorded pgid", () => {
  const leader = { pid: 4321, pgid: 4320, startTime: "linux:100" };
  const early = { pid: 7000, pgid: 4320, startTime: "linux:101", startedAtMs: 1000 };
  const late = { pid: 7001, pgid: 4320, startTime: "linux:9001", startedAtMs: 9000 };
  const bound = { aliveUntil: "1970-01-01T00:00:03Z" };
  const expected = [early, late].map(({ pid, startTime }) => ({ pid, startTime }));
  assert.equal(groupSurvivors(leader, [late], bound).length, 0);
  assert.equal(groupSurvivors(leader, [late], bound).unverified, 1);
  assert.equal(groupSurvivors(leader, [early, late]).unverified, 2, "no timestamps means no ownership proof");
  assert.deepEqual(groupSurvivors(leader, [early, late], bound), expected);
  assert.deepEqual(groupSurvivors(leader, [early, late], { servers: [expected[1]] }), expected);
  assert.equal(groupSurvivors(leader, [late], { servers: [{ pid: late.pid, startTime: "linux:2" }] }).unverified, 1);
});

test("terminateProcessTree uses the recorded process group", () => {
  const identity = { pid: process.pid, pgid: 4321, startTime: readProcessStartTime(process.pid) };
  const signals = [];
  terminateProcessTree(process.pid, { identity, killImpl: (pid, signal) => { if (signal !== 0) signals.push([pid, signal]); } });
  assert.deepEqual(signals, [[-4321, "SIGTERM"]]);
});

test("an unreadable live identity stays in discovery and is never signalled", { skip: process.platform !== "linux" }, async t => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  await once(child, "spawn");
  const ended = once(child, "exit");
  const identity = { pid: child.pid, startTime: readProcessStartTime(child.pid) };
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function(file, ...args) {
    if (String(file) === `/proc/${child.pid}/stat`) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    return read.call(this, file, ...args);
  });
  try {
    const table = listProcesses();
    assert.equal(table.find(row => row.pid === child.pid)?.startTime, null);
    const tree = snapshotProcessTree([child.pid], { table });
    assert.equal(tree[0].startTime, null);
    const group = groupSurvivors({ pid: child.pid, startTime: "linux:1" }, table);
    assert.equal(group[0].pid, child.pid);
    assert.ok(liveSnapshotMembers([identity], { table }).some(entry => entry.pid === child.pid));
    const signals = [];
    for (const snapshot of [[identity], tree, group]) {
      const remaining = await stopProcessSnapshot(snapshot, { killImpl: (pid, signal) => { if (signal !== 0) signals.push([pid, signal]); }, graceMs: 0 });
      assert.equal(remaining[0].pid, child.pid);
      assert.match(remaining.cause, /identities could not be read/);
    }
    assert.deepEqual(signals, []);
    assert.equal(isProcessAlive(child.pid), true);
  } finally {
    child.kill("SIGKILL");
    await ended;
  }
});

test("an identity becoming unreadable after TERM is unresolved and receives no KILL", async () => {
  const identity = { pid: 5000, startTime: "linux:100" };
  const signals = [];
  const remaining = await stopProcessSnapshot([identity], {
    listProcesses: () => [{ ...identity, startTime: signals.length ? null : identity.startTime }],
    killImpl: (pid, signal) => signals.push([pid, signal]), graceMs: 0
  });
  assert.deepEqual(signals, [[5000, "SIGTERM"]]);
  assert.equal(remaining[0].pid, identity.pid);
  assert.match(remaining.cause, /identities could not be read/);
});
