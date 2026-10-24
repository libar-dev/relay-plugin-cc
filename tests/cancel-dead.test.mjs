import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { setup, companion, waitFor } from "./support/job-helpers.mjs";
import { writeExecutable } from "./support/helpers.mjs";
import { createJobDir, readJob, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { isProcessIdentityAlive, listProcesses, readProcessStartTime } from "../plugins/relay/scripts/lib/util/process.mjs";

function recorded(ctx, worker, server = null) {
  const id = "job-dead-cancel";
  const { jobDir } = createJobDir(ctx.work, id, ctx.env);
  writeJob(jobDir, { id, kind: "task", state: "running", createdAt: new Date().toISOString(),
    attempts: [{ attempt: 1, state: "running" }], worker, server });
  return { id, jobDir };
}

async function sleeper(t, detached) {
  const child = spawn("sleep", ["30"], { detached, stdio: "ignore" });
  await once(child, "spawn");
  const identity = { pid: child.pid, startTime: readProcessStartTime(child.pid) };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGKILL");
      await ended;
    }
  });
  return { child, identity };
}

for (const detached of [false, true]) {
  test(`cancel leaves a real reused pid ${detached ? "and its own group" : "in another group"} alive`, async t => {
    const ctx = setup(t);
    const { identity } = await sleeper(t, detached);
    const { id, jobDir } = recorded(ctx, { pid: identity.pid, startTime: "linux:1" });
    assert.match(companion(ctx, ["status", id]).stdout, /^state: dead$/m);
    const result = companion(ctx, ["cancel", id, "--json"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readJob(jobDir).state, "cancelled");
    assert.equal(isProcessIdentityAlive(identity), true);
    assert.deepEqual(JSON.parse(result.stdout).actions, [
      "the worker was already gone and its process id now belongs to another process; nothing was signalled"
    ]);
  });
}

test("cancel stops an orphan in the dead worker's original group", async t => {
  const ctx = setup(t);
  const marker = path.join(ctx.root, "orphan.json");
  const worker = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    const child = spawn('sleep', ['300'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ worker: process.pid, child: child.pid }));
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: "ignore" });
  const ended = once(worker, "exit");
  t.after(() => { try { process.kill(-worker.pid, "SIGKILL"); } catch {} });
  const data = await waitFor(() => fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, "utf8")));
  const identity = { pid: worker.pid, startTime: readProcessStartTime(worker.pid) };
  const orphan = { pid: data.child, startTime: readProcessStartTime(data.child) };
  const { id, jobDir } = recorded(ctx, identity);
  worker.kill("SIGTERM");
  await ended;
  assert.equal(isProcessIdentityAlive(orphan), true);
  assert.equal(listProcesses().find(row => row.pid === orphan.pid).pgid, identity.pid);
  const result = companion(ctx, ["cancel", id, "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readJob(jobDir).state, "cancelled");
  assert.equal(isProcessIdentityAlive(orphan), false);
});

test("dead cancel fails without signalling when group discovery cannot read the table", async t => {
  const ctx = setup(t);
  const { identity } = await sleeper(t, true);
  const { id, jobDir } = recorded(ctx, { pid: identity.pid, startTime: "linux:1" });
  const counter = path.join(ctx.root, "table-read");
  writeExecutable(path.join(ctx.bin, "ps"), `#!/bin/sh
if [ "$1" = "-A" ]; then
  if [ -e '${counter}' ]; then exit 1; fi
  touch '${counter}'
fi
exec /bin/ps "$@"
`);
  const result = companion(ctx, ["cancel", id]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Could not cancel .*the process table could not be read/);
  assert.equal(readJob(jobDir).state, "running");
  assert.equal(isProcessIdentityAlive(identity), true);
});

test("dead cancel still stops a verified server when the worker pid was reused", async t => {
  const ctx = setup(t);
  const unrelated = await sleeper(t, true);
  const server = await sleeper(t, false);
  const { id, jobDir } = recorded(ctx, { pid: unrelated.identity.pid, startTime: "linux:1" }, server.identity);
  const result = companion(ctx, ["cancel", id, "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readJob(jobDir).state, "cancelled");
  assert.equal(isProcessIdentityAlive(unrelated.identity), true);
  assert.equal(isProcessIdentityAlive(server.identity), false);
  assert.ok(!JSON.parse(result.stdout).actions.some(action => action.includes("nothing was signalled")));
});

test("live cancel rechecks ownership after its last liveness check before signalling", { skip: process.platform !== "linux" }, async t => {
  const ctx = setup(t, { env: { RELAY_JOBS_CANCEL_GRACE_MS: "0" } });
  const { identity } = await sleeper(t, true);
  const { id, jobDir } = recorded(ctx, identity);
  const preload = path.join(ctx.root, "reuse-at-signal.mjs");
  const marker = path.join(ctx.root, "identity-rechecked");
  // The real victim remains alive. Change the observed identity exactly when the
  // forceful termination helper runs, and retain that replacement for the sweep.
  fs.writeFileSync(preload, `
import fs from "node:fs";
const read = fs.readFileSync;
let reused = false;
fs.readFileSync = function(file, ...args) {
  const value = read.call(this, file, ...args);
  if (String(file) === ${JSON.stringify(`/proc/${identity.pid}/stat`)}) {
    if (/terminateProcessTree/.test(new Error().stack)) {
      reused = true;
      fs.writeFileSync(${JSON.stringify(marker)}, "");
    }
    if (reused) {
      const end = value.lastIndexOf(")") + 2;
      const fields = value.slice(end).split(" ");
      fields[19] = String(BigInt(fields[19]) + 1n);
      return value.slice(0, end) + fields.join(" ");
    }
  }
  return value;
};
`);
  const result = companion(ctx, ["cancel", id, "--json"], { NODE_OPTIONS: `--import=${preload}` });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(readJob(jobDir).state, "cancelled");
  assert.equal(isProcessIdentityAlive(identity), true);
  assert.ok(!JSON.parse(result.stdout).actions.some(action => action.startsWith("killed the worker")));
});
