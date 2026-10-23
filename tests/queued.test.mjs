import "./support/isolate-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { computeJobView, exitCodeFor, isTerminalView, jobViewJson, renderJobBlock } from "../plugins/relay/scripts/lib/jobs/view.mjs";
import { readProcessStartTime } from "../plugins/relay/scripts/lib/util/process.mjs";

test("durable queued jobs without a worker stay pending, with reason and since", () => {
  const job = { id: "job-queued", state: "queued", createdAt: "2025-01-01T00:00:00.000Z", admission: { state: "waiting", waitKind: "worker", reason: "memory low", since: "2025-01-01T00:00:00.000Z" } };
  const view = { ...computeJobView(job), job, hasReport: false, paths: { brief: "/synthetic/absent" }, jobDir: "/synthetic/job-queued" };
  assert.equal(view.state, "queued");
  assert.equal(view.stalled, false);
  assert.equal(isTerminalView(view), false);
  assert.equal(exitCodeFor(view), 4);
  assert.equal(jobViewJson(view, { messages: false }).admission, job.admission);
  assert.match(renderJobBlock(view), /queued: memory low \(since 2025/);
});
test("resident queued jobs never stall; dead queued workers remain recoverable", () => {
  const job = { state: "queued", createdAt: "2025-01-01T00:00:00Z", worker: { pid: process.pid, startTime: readProcessStartTime(process.pid) } };
  assert.equal(computeJobView(job).state, "queued");
  assert.equal(computeJobView(job).stalled, false);
  assert.equal(computeJobView({ ...job, worker: { pid: 2147483647 } }).state, "dead");
});
