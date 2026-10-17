// A busy job, through every reader that can meet one: a job whose record changes during every
// pass of a view (support/busy-view.mjs). Busy is no state. A reader retries, or says the job is
// busy and exits 4; it never shows the job in a state, and never leaves it out.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { HEADER, companion, finishJob, jobDir, readJob, setup, startJob, waitFor } from "./support/job-helpers.mjs";
import { jobPaths } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { isWorkerAlive, isWorkerLease, readLease } from "../plugins/relay/scripts/lib/jobs/lease.mjs";

const BUSY_VIEW = new URL("./support/busy-view.mjs", import.meta.url).href;
const busyLine = id => new RegExp(`^Job ${id} is busy: its record changed during each of 8 reads\\. Try again\\.\\n$`);

// The environment of a companion in which the job's every view is busy.
function busy(ctx, dir, options = {}) {
  return {
    NODE_OPTIONS: `${ctx.env.NODE_OPTIONS ?? ""} --import=${BUSY_VIEW}`.trim(),
    RELAY_TEST_BUSY_JOB: dir,
    ...(options.reads ? { RELAY_TEST_BUSY_READS: String(options.reads) } : {}),
    ...(options.within ? { RELAY_TEST_BUSY_WITHIN: options.within } : {})
  };
}

test("status lists no jobs while one is busy: it exits 4 and names it, by repository and with --all", async t => {
  const ctx = setup(t);
  const quiet = startJob(ctx, HEADER, "[quick] Quiet job.").id;
  await finishJob(ctx, quiet);
  const active = startJob(ctx, HEADER, "[quick] Busy job.").id;
  await finishJob(ctx, active);
  const env = busy(ctx, jobDir(ctx, active));
  for (const args of [["status"], ["status", "--all", "--json"]]) {
    const listed = companion(ctx, args, env);
    assert.equal(listed.status, 4, `${args.join(" ")}: ${listed.stdout}`);
    assert.equal(listed.stdout, "", `${args.join(" ")} printed a listing without the busy job`);
    assert.match(listed.stderr, busyLine(active));
  }
  // Once its views hold again, both jobs are listed.
  const listed = companion(ctx, ["status", "--all", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).jobs.map(job => job.id).sort(), [active, quiet].sort());
});

test("wait polls a busy job again within its deadline, and shows it once its views hold", async t => {
  const ctx = setup(t);
  const { id } = startJob(ctx, HEADER, "[quick] Settles.");
  await finishJob(ctx, id);
  // Busy for its first 48 reads: more than one view's eight passes.
  const waited = companion(ctx, ["wait", id, "--timeout-seconds", "15"], busy(ctx, jobDir(ctx, id), { reads: 48 }));
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(waited.stderr, "");
  assert.match(waited.stdout, /^state: completed$/m);
  assert.ok(waited.stdout.endsWith("---\nReport for: [quick] Settles.\n"), waited.stdout);
});

test("a job busy through wait's deadline: exit 4 and the busy line; the relay's wait exits 0 on its still-running line", async t => {
  const ctx = setup(t);
  const { id } = startJob(ctx, HEADER, "[quick] Never settles.");
  await finishJob(ctx, id);
  const env = busy(ctx, jobDir(ctx, id));
  const waited = companion(ctx, ["wait", id, "--timeout-seconds", "1", "--json"], env);
  assert.equal(waited.status, 4, waited.stdout);
  assert.equal(waited.stdout, "", "no view of a busy job");
  assert.match(waited.stderr, busyLine(id));
  const relay = companion(ctx, ["wait", id, "--timeout-seconds", "1", "--exit-zero-while-running", "--state-only"], env);
  assert.equal(relay.status, 0, relay.stderr);
  assert.equal(relay.stdout, "still running: not an error. Run the same wait again.\n");
  assert.match(relay.stderr, busyLine(id));
});

test("result and status of a busy job exit 4 with the busy line and no view: by id, and as the repository's newest", async t => {
  const ctx = setup(t);
  const { id } = startJob(ctx, HEADER, "[quick] Busy job.");
  await finishJob(ctx, id);
  const env = busy(ctx, jobDir(ctx, id));
  for (const args of [["result", id], ["result"], ["status", id, "--json"]]) {
    const read = companion(ctx, args, env);
    assert.equal(read.status, 4, `${args.join(" ")}: ${read.stdout}`);
    assert.equal(read.stdout, "", args.join(" "));
    assert.match(read.stderr, busyLine(id));
  }
});

// Every message ever posted to the job: pending in its inbox, or claimed by a worker.
function posted(dir) {
  const { inbox, claimed } = jobPaths(dir);
  return [inbox, claimed].flatMap(sub => fs.existsSync(sub) ? fs.readdirSync(sub).filter(name => name.endsWith(".json")).map(name => path.join(sub, name)) : []);
}

test("a message sent to a job busy right after is reported sent, never a read to try again; resume sends nothing while busy", async t => {
  const ctx = setup(t);
  const { id } = startJob(ctx, HEADER, "[quick] First.");
  await finishJob(ctx, id);
  const dir = jobDir(ctx, id);
  const env = busy(ctx, dir);
  const sent = companion(ctx, ["continue", id, "--message", "[quick] Second."], env);
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(sent.stderr, "");
  assert.match(sent.stdout, new RegExp(`^job: ${id}\\nmessage: continue \\S+\\noutcome: (?!pending)`));
  assert.match(sent.stdout, new RegExp(`^note: the job is busy, so its state is not shown; status ${id} shows it\\n$`, "m"));
  assert.doesNotMatch(sent.stdout, /^state:/m);
  await finishJob(ctx, id);
  const json = companion(ctx, ["continue", id, "--message", "[quick] Third.", "--json"], env);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).state, null);
  assert.ok(JSON.parse(json.stdout).outcome?.action, json.stdout);
  await finishJob(ctx, id);
  // resume reads the job before it sends: busy there, it sends nothing and says the job is busy.
  const before = posted(dir).length;
  const resumed = companion(ctx, ["resume", id], env);
  assert.equal(resumed.status, 4, resumed.stdout);
  assert.equal(resumed.stdout, "");
  assert.match(resumed.stderr, busyLine(id));
  assert.equal(posted(dir).length, before, "resume posted nothing");
  const job = readJob(ctx, id);
  assert.deepEqual(job.attempts.map(attempt => attempt.state), ["completed", "completed", "completed"], "each message ran once");
});

// A job running a long turn under its worker.
async function runningJob(ctx) {
  const { id } = startJob(ctx, HEADER, "Long work.");
  const dir = jobDir(ctx, id);
  await waitFor(() => readJob(ctx, id).state === "running" && isWorkerLease(readLease(dir)));
  return { id, dir };
}

test("cancel of a busy job says it is busy and exits 4, and leaves the job running; once its views hold, cancel ends it", async t => {
  const ctx = setup(t, { turnMs: 30000 });
  const { id, dir } = await runningJob(ctx);
  const { worker } = readJob(ctx, id);
  const before = posted(dir).length;
  for (const args of [["cancel", id], ["cancel"]]) {
    const refused = companion(ctx, args, busy(ctx, dir));
    assert.equal(refused.status, 4, `${args.join(" ")}: ${refused.stdout}`);
    assert.equal(refused.stdout, "", args.join(" "));
    assert.match(refused.stderr, busyLine(id));
  }
  assert.equal(posted(dir).length, before, "no cancel was posted");
  assert.equal(readJob(ctx, id).state, "running");
  assert.equal(isWorkerAlive(worker), true, "the worker was not stopped");
  const cancelled = companion(ctx, ["cancel", id]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /^state: cancelled$/m);
});

// Busy only where cancel waits for the job to end (stateNow): its other reads hold.
test("cancel's waits take a busy job for one that has not ended: it waits out its grace, then ends the job", async t => {
  const ctx = setup(t, { turnMs: 30000 });
  const { id, dir } = await runningJob(ctx);
  const graceMs = 1000;
  const startedAt = Date.now();
  const cancelled = companion(ctx, ["cancel", id], { ...busy(ctx, dir, { within: "stateNow" }), RELAY_JOBS_CANCEL_GRACE_MS: String(graceMs) });
  const tookMs = Date.now() - startedAt;
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /^state: cancelled$/m);
  assert.ok(tookMs >= graceMs, `cancel returned after ${tookMs} ms: it took a busy job for an ended one`);
  assert.equal(readJob(ctx, id).state, "cancelled");
});
