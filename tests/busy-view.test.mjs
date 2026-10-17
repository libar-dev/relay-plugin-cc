// A busy job, through every reader that can meet one: a job whose record changes during every
// pass of a view (support/busy-view.mjs). Busy is no state. A reader retries, or says the job is
// busy and exits 4; it never shows the job in a state, and never leaves it out.
import test from "node:test";
import assert from "node:assert/strict";
import { HEADER, companion, finishJob, jobDir, setup, startJob } from "./support/job-helpers.mjs";

const BUSY_VIEW = new URL("./support/busy-view.mjs", import.meta.url).href;
const busyLine = id => new RegExp(`^Job ${id} is busy: its record changed during each of 8 reads\\. Try again\\.\\n$`);

// The environment of a companion in which the job's every view is busy.
function busy(ctx, dir, options = {}) {
  return {
    NODE_OPTIONS: `${ctx.env.NODE_OPTIONS ?? ""} --import=${BUSY_VIEW}`.trim(),
    RELAY_TEST_BUSY_JOB: dir,
    ...(options.reads ? { RELAY_TEST_BUSY_READS: String(options.reads) } : {}),
    ...(options.until ? { RELAY_TEST_BUSY_UNTIL: options.until } : {})
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
