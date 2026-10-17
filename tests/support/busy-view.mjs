// A job whose record changes during every pass of a view, as it would under a worker that began
// attempt after attempt faster than a view reads: each read of its job.json made inside
// loadJobView (or inside the function `within` names) returns a newer version than the read
// before, so every such view of it is busy (JobViewBusy). Every other read sees the record as it
// is: the worker's, a cancel's own read-modify-write, the test's. The job is busy for `reads`
// such reads, or until the returned function restores fs.
//
// In a companion: NODE_OPTIONS="--import <this file>" with RELAY_TEST_BUSY_JOB=<job dir>, and
// RELAY_TEST_BUSY_READS or RELAY_TEST_BUSY_WITHIN. Only that process: the variables are removed,
// so a worker it starts reads the job as it is.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export function busyViews(jobDir, { reads = Infinity, within = "loadJobView" } = {}) {
  const file = path.join(jobDir, "job.json");
  const caller = new RegExp(`\\bat ${within} \\(`);
  const original = fs.readFileSync;
  let changed = 0;
  fs.readFileSync = function readFileSync(target, ...rest) {
    const content = original.call(this, target, ...rest);
    if (String(target) !== file || changed >= reads || !caller.test(new Error().stack ?? "")) {
      return content;
    }
    changed += 1;
    const job = JSON.parse(String(content));
    const attempts = Array.isArray(job.attempts) ? job.attempts : [];
    // A newer version each time: its last attempt began after the one the read before saw.
    const newer = JSON.stringify({ ...job, state: "running", attempts: [...attempts, { attempt: attempts.length + 1, state: "running", startedAt: `busy-${changed}` }] });
    return typeof content === "string" ? newer : Buffer.from(newer);
  };
  return () => { fs.readFileSync = original; };
}

if (process.env.RELAY_TEST_BUSY_JOB) {
  const { RELAY_TEST_BUSY_JOB, RELAY_TEST_BUSY_READS, RELAY_TEST_BUSY_WITHIN } = process.env;
  busyViews(RELAY_TEST_BUSY_JOB, { reads: Number(RELAY_TEST_BUSY_READS) || Infinity, within: RELAY_TEST_BUSY_WITHIN || "loadJobView" });
  for (const name of ["RELAY_TEST_BUSY_JOB", "RELAY_TEST_BUSY_READS", "RELAY_TEST_BUSY_WITHIN"]) delete process.env[name];
}
