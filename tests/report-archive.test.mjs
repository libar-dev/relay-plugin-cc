// A reader's view of a job, and the next attempt archiving the report, interleaved at the worst
// point: right after the reader's first look at report.md, every time.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir } from "./support/helpers.mjs";
import { jobPaths, readJob, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { exitCodeFor, jobViewJson, loadJobView, renderJobWithReport, renderResultText } from "../plugins/relay/scripts/lib/jobs/view.mjs";

function completedJob() {
  const dir = makeTempDir("relay-report-archive-");
  writeJob(dir, { id: "job-archive", kind: "task", state: "completed", completedAt: new Date().toISOString(), attempts: [{ attempt: 1, state: "completed", hasReport: true }] });
  fs.writeFileSync(jobPaths(dir).report, "Attempt one's report.\n");
  return dir;
}

// What the worker's beginAttempt does: move the report under attempts/, then record the attempt.
function beginNextAttempt(dir) {
  const paths = jobPaths(dir);
  fs.mkdirSync(paths.attempts, { recursive: true });
  fs.renameSync(paths.report, path.join(paths.attempts, "1-report.md"));
  const job = readJob(dir);
  writeJob(dir, { ...job, state: "starting", completedAt: null, attempts: [...job.attempts, { attempt: 2, state: "starting" }] });
}

// The archive lands right after the first existence check or read of report.md.
function archiveAtFirstLook(t, dir) {
  const report = jobPaths(dir).report;
  const { existsSync, readFileSync } = fs;
  let done = false;
  const archive = () => { if (!done) { done = true; beginNextAttempt(dir); } };
  fs.existsSync = (file, ...rest) => { const result = existsSync(file, ...rest); if (String(file) === report) archive(); return result; };
  fs.readFileSync = (file, ...rest) => { if (String(file) === report) archive(); return readFileSync(file, ...rest); };
  t.after(() => Object.assign(fs, { existsSync, readFileSync }));
  return () => done;
}

test("a report the next attempt archives between a reader's first look and its read: the view keeps its snapshot's state and that attempt's report", t => {
  const dir = completedJob();
  const archived = archiveAtFirstLook(t, dir);
  const view = loadJobView(dir);
  assert.equal(archived(), true, "the archive ran inside the read");
  const archivedReport = path.join(jobPaths(dir).attempts, "1-report.md");
  assert.equal(view.state, "completed");
  assert.equal(view.job.attempts.length, 1);
  assert.equal(view.hasReport, true);
  assert.equal(view.report, "Attempt one's report.\n");
  assert.equal(view.reportPath, archivedReport);
  assert.equal(exitCodeFor(view), 0);
  // Rendering uses the copy the view read: no second read can miss the moved file.
  const result = renderResultText(view);
  assert.ok(result.includes(`\nreport: ${archivedReport}\n`), result);
  assert.ok(result.endsWith("---\nAttempt one's report.\n"), result);
  assert.ok(renderJobWithReport(view).endsWith("---\nAttempt one's report.\n"));
  assert.equal(jobViewJson(view).reportPath, archivedReport);
  // The job did move on: a new view sees the new attempt and no report yet.
  const next = loadJobView(dir);
  assert.equal(next.job.attempts.length, 2);
  assert.equal(next.hasReport, false);
  assert.equal(next.report, null);
});

test("with no archive in between, the view reads report.md once, and an attempt with no report has none", t => {
  const dir = completedJob();
  const view = loadJobView(dir);
  assert.equal(view.reportPath, jobPaths(dir).report);
  assert.equal(view.report, "Attempt one's report.\n");
  fs.rmSync(jobPaths(dir).report);
  assert.equal(loadJobView(dir).hasReport, false, "no archive of attempt 1 exists: no report");
});
