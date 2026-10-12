import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { makeTempDir } from "./support/helpers.mjs";
import { claimInboxMessages, messageAccount, postInboxMessage, writeOutcome } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
import { jobPaths, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { loadJobView, exitCodeFor, renderJobBlock } from "../plugins/relay/scripts/lib/jobs/view.mjs";

function accountingJob() {
  const dir = makeTempDir("relay-account-path-");
  writeJob(dir, { id: "job-path", kind: "task", state: "completed", attempts: [] });
  fs.writeFileSync(path.join(dir, "report.md"), "Old report");
  return dir;
}

test("a message claimed after the claimed listing cannot disappear from the view", t => {
  const dir = accountingJob();
  const paths = jobPaths(dir);
  const message = postInboxMessage(dir, { kind: "continue", text: "Follow-up" });
  fs.mkdirSync(paths.claimed, { recursive: true });
  const readdir = fs.readdirSync;
  let moved = false;
  t.mock.method(fs, "readdirSync", function (target, ...args) {
    const names = readdir.call(this, target, ...args);
    if (target === paths.claimed && !moved) {
      moved = true;
      claimInboxMessages(dir);
    }
    return names;
  });
  const view = loadJobView(dir);
  assert.equal(moved, true);
  assert.deepEqual(view.undelivered, [message.id]);
  assert.equal(exitCodeFor(view), 3);
  assert.match(renderJobBlock(view), /^undelivered: 1 /m);
});

test("a message seen in inbox then claimed counts once", t => {
  const dir = accountingJob();
  const paths = jobPaths(dir);
  const message = postInboxMessage(dir, { kind: "continue", text: "Follow-up" });
  const read = fs.readFileSync;
  let moved = false;
  t.mock.method(fs, "readFileSync", function (target, ...args) {
    const raw = read.call(this, target, ...args);
    if (target === path.join(paths.inbox, `${message.id}.json`) && !moved) {
      moved = true;
      claimInboxMessages(dir);
    }
    return raw;
  });
  assert.deepEqual(messageAccount(dir).undelivered, [message.id]);
  assert.equal(moved, true);
});

test("a dropped message moving during the read counts once across outcomes", t => {
  const dir = accountingJob();
  const paths = jobPaths(dir);
  const message = postInboxMessage(dir, { kind: "continue", text: "Follow-up" });
  const read = fs.readFileSync;
  let moved = false;
  t.mock.method(fs, "readFileSync", function (target, ...args) {
    const raw = read.call(this, target, ...args);
    if (target === path.join(paths.inbox, `${message.id}.json`) && !moved) {
      moved = true;
      claimInboxMessages(dir);
      writeOutcome(dir, message.id, { action: "dropped", reason: "cancelled" });
    }
    return raw;
  });
  assert.deepEqual(messageAccount(dir), { undelivered: [], dropped: [{ id: message.id, reason: "cancelled" }] });
  assert.equal(moved, true);
});

test("cancelled with a pending continuation exits five", () => {
  const dir = accountingJob();
  writeJob(dir, { id: "job-path", kind: "task", state: "cancelled", attempts: [] });
  const message = postInboxMessage(dir, { kind: "continue", text: "Still owed" });
  const view = loadJobView(dir);
  assert.deepEqual(view.undelivered, [message.id]);
  assert.equal(exitCodeFor(view), 5);
});

test("worker and ownership share identity decisions and keep private helpers private", async () => {
  const modules = makeTempDir("relay-identity-check-");
  for (const file of ["jobs/store.mjs", "jobs/lease.mjs", "util/ownership.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(modules, file)), { recursive: true });
    fs.copyFileSync(new URL(`../plugins/relay/scripts/lib/${file}`, import.meta.url), path.join(modules, file));
  }
  fs.writeFileSync(path.join(modules, "util/process.mjs"), `
    export const state = { alive: true, calls: [] };
    export function isProcessIdentityAlive(identity) { state.calls.push(identity); return state.alive; }
    export function readProcessStartTime() { return "controlled"; }
    export function runCommand() { return { status: 1, stdout: "" }; }
  `);
  const jobs = await import(pathToFileURL(path.join(modules, "jobs/lease.mjs")).href);
  const processes = await import(pathToFileURL(path.join(modules, "util/process.mjs")).href);
  const ownership = await import(pathToFileURL(path.join(modules, "util/ownership.mjs")).href);
  const recovery = await import("../plugins/relay/scripts/lib/worker/recovery.mjs");
  const identity = { pid: process.pid, startTime: "controlled" };
  const lock = path.join(modules, "worker.lease");
  fs.mkdirSync(ownership.ownershipDir(lock));
  fs.writeFileSync(path.join(ownership.ownershipDir(lock), "1"), JSON.stringify(identity));
  for (const alive of [true, false]) {
    processes.state.alive = alive;
    assert.equal(jobs.isWorkerAlive(identity), alive);
    assert.deepEqual(ownership.readOwnership(lock), identity);
  }
  assert.deepEqual(processes.state.calls, [identity, identity, identity, identity]);
  assert.equal("UNREADABLE_STALE_MS" in ownership, false);
  assert.equal("liveRecordedAppServers" in recovery, false);
});
