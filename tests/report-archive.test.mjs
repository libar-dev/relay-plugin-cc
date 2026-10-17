// A reader's view of a job, and the next attempt changing the job, interleaved at the worst
// point: right after the reader's first look at report.md, every time. A view must read one
// version of the job: its state, its attempts, its report and its owed work together.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir } from "./support/helpers.mjs";
import { jobPaths, readJob, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { claimInboxMessages, postInboxMessage, writeOutcome } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
import { acquireWorkerLease, releaseWorkerLease } from "../plugins/relay/scripts/lib/jobs/lease.mjs";
import { readProcessStartTime } from "../plugins/relay/scripts/lib/util/process.mjs";
import { exitCodeFor, JobViewBusy, jobViewJson, loadJobView, loadJobViewSettled, renderJobWithReport, renderResultText } from "../plugins/relay/scripts/lib/jobs/view.mjs";
import { HEADER, companion, finishJob, jobDir as jobDirOf, readJob as readJobOf, setup, startJob } from "./support/job-helpers.mjs";

const me = () => ({ pid: process.pid, startTime: readProcessStartTime(process.pid) });

// A job whose first attempt completed with a report; this process stands in for its worker.
function completedJob(backend = "codex") {
  const dir = makeTempDir("relay-report-archive-");
  writeJob(dir, { id: "job-archive", kind: "task", request: { backend }, worker: me(), state: "completed", completedAt: new Date().toISOString(), attempts: [{ attempt: 1, state: "completed", hasReport: true, startedAt: "2026-10-17T00:00:00.000Z" }] });
  fs.writeFileSync(jobPaths(dir).report, "First report.\n");
  return dir;
}

// What the worker's beginAttempt does: move the report under attempts/, then record the next
// attempt. `record: false` stops between the two, as a worker that died there; `report` stands
// for that attempt ending with its own report.
function nextAttempt(dir, { state = "running", report = null, record = true } = {}) {
  const paths = jobPaths(dir);
  fs.mkdirSync(paths.attempts, { recursive: true });
  fs.renameSync(paths.report, path.join(paths.attempts, "1-report.md"));
  if (!record) return;
  const job = readJob(dir);
  writeJob(dir, { ...job, state, completedAt: null, attempts: [...job.attempts, { attempt: 2, state, startedAt: "2026-10-17T00:00:01.000Z" }] });
  if (report) fs.writeFileSync(paths.report, report);
}

// `change` runs right after the first existence check or read of report.md.
function atFirstLook(t, dir, change) {
  const report = jobPaths(dir).report;
  const { existsSync, readFileSync } = fs;
  let done = false;
  const once = () => { if (!done) { done = true; change(); } };
  fs.existsSync = (file, ...rest) => { const result = existsSync(file, ...rest); if (String(file) === report) once(); return result; };
  fs.readFileSync = (file, ...rest) => { if (String(file) === report) once(); return readFileSync(file, ...rest); };
  t.after(() => Object.assign(fs, { existsSync, readFileSync }));
  return () => done;
}

for (const backend of ["codex", "grok", "zcode", "kimi"]) {
  test(`${backend}: a newer attempt's report written during the read is never paired with the older attempt's state`, t => {
    const dir = completedJob(backend);
    const changed = atFirstLook(t, dir, () => nextAttempt(dir, { state: "completed", report: "Second report.\n" }));
    const view = loadJobView(dir);
    assert.equal(changed(), true);
    assert.equal(view.job.attempts.length, 2);
    assert.equal(view.report, "Second report.\n");
    assert.equal(view.reportPath, jobPaths(dir).report);
    assert.ok(renderResultText(view).endsWith("---\nSecond report.\n"));
  });

  test(`${backend}: work owed before the read that starts during it keeps the job running, not completed with the old report`, t => {
    const dir = completedJob(backend);
    assert.equal(acquireWorkerLease(dir, me()), true);
    t.after(() => releaseWorkerLease(dir, me()));
    const message = postInboxMessage(dir, { kind: "continue", text: "Still running." });
    const changed = atFirstLook(t, dir, () => {
      nextAttempt(dir);
      claimInboxMessages(dir);
      writeOutcome(dir, message.id, { action: "turn-started", attempt: 2, turnId: "running-turn" });
    });
    const view = loadJobView(dir);
    assert.equal(changed(), true);
    assert.equal(view.state, "running");
    assert.equal(exitCodeFor(view), 4);
    assert.equal(view.job.attempts.length, 2);
    assert.equal(view.hasReport, false);
    assert.equal(view.report, null);
  });
}

test("a report moved to attempts/ before the next attempt is recorded (a worker that died between the two) is still that attempt's report", t => {
  const dir = completedJob();
  atFirstLook(t, dir, () => nextAttempt(dir, { record: false }));
  const view = loadJobView(dir);
  const archived = path.join(jobPaths(dir).attempts, "1-report.md");
  assert.equal(view.state, "completed");
  assert.equal(view.job.attempts.length, 1);
  assert.equal(view.report, "First report.\n");
  assert.equal(view.reportPath, archived);
  assert.equal(exitCodeFor(view), 0);
  const result = renderResultText(view);
  assert.ok(result.includes(`\nreport: ${archived}\n`), result);
  assert.ok(result.endsWith("---\nFirst report.\n"), result);
  assert.ok(renderJobWithReport(view).endsWith("---\nFirst report.\n"));
  assert.equal(jobViewJson(view).reportPath, archived);
});

test("with nothing changing, the view reads report.md once, and an attempt with no report has none", () => {
  const dir = completedJob();
  const view = loadJobView(dir);
  assert.equal(view.reportPath, jobPaths(dir).report);
  assert.equal(view.report, "First report.\n");
  fs.rmSync(jobPaths(dir).report);
  assert.equal(loadJobView(dir).hasReport, false, "no archive of attempt 1 exists: no report");
});

// With real workers on the fake Codex, a follow-up runs at every one of the view's eight report
// reads. Ending running, or ending completed, the view must never return the pass it has just
// shown to be invalid: no attempt 8 completed while attempt 9 runs, and no attempt 8 with attempt
// 9's report. It says the job is busy.
for (const finalState of ["running", "completed"]) {
  test(`a job that changes during each of the view's eight reads, ending ${finalState}, is busy: no pass that failed is returned`, async t => {
    const ctx = setup(t, { turnMs: 30000 });
    const { id } = startJob(ctx, HEADER, "[quick] Initial");
    await finishJob(ctx, id);
    const dir = jobDirOf(ctx, id);
    const report = jobPaths(dir).report;
    const original = fs.readFileSync;
    let changes = 0;
    fs.readFileSync = function readFileSync(file, ...args) {
      if (String(file) === report && changes < 8) {
        changes += 1;
        const last = changes === 8;
        const sent = companion(ctx, ["continue", id, "--message", last && finalState === "running" ? "Long final work" : `[quick] Follow-up ${changes}`]);
        assert.equal(sent.status, 0, sent.stdout + sent.stderr);
        if (last && finalState === "running") {
          const deadline = Date.now() + 10000;
          while (!(readJobOf(ctx, id).messages ?? []).some(m => m.action === "turn-started" && m.attempt === 9)) {
            if (Date.now() > deadline) throw new Error("the worker did not start attempt 9");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        } else {
          const ended = companion(ctx, ["wait", id, "--timeout-seconds", "15"]);
          assert.equal(ended.status, 0, ended.stdout + ended.stderr);
        }
      }
      return original.call(this, file, ...args);
    };
    try {
      assert.throws(() => loadJobView(dir), error => error instanceof JobViewBusy && /^Job .* is busy: its record changed during each of 8 reads\. Try again\.$/.test(error.message));
    } finally {
      fs.readFileSync = original;
    }
    assert.equal(changes, 8);
    // Once it stops changing, a settled read is that version: attempt 9 with its own report.
    const view = loadJobViewSettled(dir);
    const actual = readJobOf(ctx, id);
    assert.equal(view.job.attempts.length, 9);
    assert.equal(view.job.attempts.length, actual.attempts.length);
    if (finalState === "running") {
      assert.equal(isTerminal(view), false);
      assert.notEqual(exitCodeFor(view), 0);
    } else {
      assert.equal(view.state, "completed");
      assert.equal(view.report, "Report for: [quick] Follow-up 8\n");
    }
  });
}
const isTerminal = view => ["completed", "failed", "cancelled", "dead"].includes(view.state);
