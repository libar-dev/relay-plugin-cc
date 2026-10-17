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
