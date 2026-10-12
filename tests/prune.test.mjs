import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, run } from "./support/helpers.mjs";
import { createJobDir, repoSlugFor, writeJob } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { writeRelayPointer } from "../plugins/relay/scripts/lib/harness/relay.mjs";
import { ownershipDir } from "../plugins/relay/scripts/lib/util/ownership.mjs";
import { readProcessStartTime } from "../plugins/relay/scripts/lib/util/process.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/relay/scripts/companion.mjs", import.meta.url));
const OLD = new Date(Date.now() - 30 * 86400000).toISOString();
const YOUNG = new Date().toISOString();
function setup(t) {
  const root = makeTempDir("prune-test-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "jobs");
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  const env = { ...process.env, RELAY_JOBS_HOME: home };
  return {
    root, home, work, env,
    job(id, patch = {}, cwd = work) {
      const { jobDir, slug } = createJobDir(cwd, id, env);
      writeJob(jobDir, { id, repoSlug: slug, state: "completed", createdAt: OLD, completedAt: OLD, ...patch });
      fs.writeFileSync(path.join(jobDir, "report.md"), "a report\n");
      return jobDir;
    },
    prune(...args) {
      const result = run(process.execPath, [SCRIPT, "prune", ...args], { cwd: work, env });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    }
  };
}
const live = () => ({ pid: process.pid, startTime: readProcessStartTime(process.pid) });

test("prune removes an old completed job and its empty slug", (t) => {
  const ctx = setup(t);
  const dir = ctx.job("old-completed");
  const size = fs.readdirSync(dir).reduce((sum, name) => sum + (fs.statSync(path.join(dir, name)).isFile() ? fs.statSync(path.join(dir, name)).size : 0), 0);
  const out = ctx.prune();
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(path.dirname(dir)), false);
  assert.match(out, /old-completed  state: completed  age: \d+h/);
  assert.match(out, new RegExp(`total: 1 jobs, 0 files; freed: ${size} bytes`));
});

test("prune keeps a young job based on ended time", (t) => {
  const ctx = setup(t);
  const dir = ctx.job("young", { completedAt: YOUNG });
  ctx.prune();
  assert.ok(fs.existsSync(dir));
});

test("prune keeps an old running job with a live worker", (t) => {
  const ctx = setup(t);
  const dir = ctx.job("live-running", { state: "running", completedAt: null, worker: live() });
  ctx.prune();
  assert.ok(fs.existsSync(dir));
});

test("prune keeps a terminal job with a live worker or lease", (t) => {
  const ctx = setup(t);
  const worker = ctx.job("terminal-worker", { worker: live() });
  const lease = ctx.job("terminal-lease");
  const leaseDir = ownershipDir(path.join(lease, "worker.lease"));
  fs.mkdirSync(leaseDir);
  fs.writeFileSync(path.join(leaseDir, "1"), JSON.stringify({ ...live(), role: "worker" }));
  ctx.prune();
  assert.ok(fs.existsSync(worker));
  assert.ok(fs.existsSync(lease));
});

test("prune removes a dead old job", (t) => {
  const ctx = setup(t);
  // The worker never started, so the standard reader computes dead after its grace period.
  const dir = ctx.job("dead-old", { state: "running", completedAt: null, lastEventAt: OLD });
  assert.match(ctx.prune(), /dead-old  state: dead/);
  assert.equal(fs.existsSync(dir), false);
});

test("prune dry-run removes nothing including files and empty slugs", (t) => {
  const ctx = setup(t);
  const dir = ctx.job("dry-old");
  fs.mkdirSync(path.join(ctx.home, "drafts"));
  const file = path.join(ctx.home, "drafts", "old.md");
  fs.writeFileSync(file, "draft");
  fs.utimesSync(file, new Date(OLD), new Date(OLD));
  const before = fs.readFileSync(path.join(dir, "job.json"), "utf8");
  const out = ctx.prune("--dry-run");
  assert.match(out, /would remove: dry-old/);
  assert.match(out, /would free: \d+ bytes/);
  assert.equal(fs.readFileSync(path.join(dir, "job.json"), "utf8"), before);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.existsSync(path.join(dir, "worker.lease")), false);
});

test("prune defaults to this slug and all crosses slugs", (t) => {
  const ctx = setup(t);
  const elsewhere = path.join(ctx.root, "other");
  fs.mkdirSync(elsewhere);
  const here = ctx.job("here");
  const there = ctx.job("there", {}, elsewhere);
  ctx.prune();
  assert.equal(fs.existsSync(here), false);
  assert.ok(fs.existsSync(there));
  ctx.prune("--all");
  assert.equal(fs.existsSync(there), false);
});

test("prune leaves unrecognised directories and symlinks alone", (t) => {
  const ctx = setup(t);
  const slugDir = path.join(ctx.home, repoSlugFor(ctx.work));
  const unknownRoot = path.join(ctx.home, "unknown-root");
  fs.mkdirSync(unknownRoot, { recursive: true });
  const noRecord = path.join(slugDir, "unknown");
  fs.mkdirSync(noRecord, { recursive: true });
  const wrongId = ctx.job("wrong-id", { id: "different" });
  const wrongSlug = ctx.job("wrong-slug", { repoSlug: "different" });
  const invalid = ctx.job("invalid-date", { createdAt: "invalid" });
  const corrupt = ctx.job("corrupt");
  fs.writeFileSync(path.join(corrupt, "job.json"), "{");
  const target = path.join(ctx.root, "outside");
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(slugDir, "linked"));
  const linkedRecord = ctx.job("linked-record");
  fs.renameSync(path.join(linkedRecord, "job.json"), path.join(target, "record.json"));
  fs.symlinkSync(path.join(target, "record.json"), path.join(linkedRecord, "job.json"));
  ctx.prune("--all");
  for (const dir of [unknownRoot, noRecord, wrongId, wrongSlug, invalid, corrupt, linkedRecord, target]) assert.ok(fs.existsSync(dir), dir);
  assert.ok(fs.lstatSync(path.join(slugDir, "linked")).isSymbolicLink());
});

test("prune uses last event then creation and keeps starting grace", (t) => {
  const ctx = setup(t);
  const oldEvent = ctx.job("old-event", { state: "failed", completedAt: null, lastEventAt: OLD });
  const oldCreation = ctx.job("old-creation", { state: "cancelled", completedAt: null });
  const youngEvent = ctx.job("young-event", { state: "failed", completedAt: null, lastEventAt: YOUNG });
  const starting = ctx.job("starting", { state: "starting", completedAt: null, launchPendingAt: YOUNG });
  ctx.prune();
  assert.equal(fs.existsSync(oldEvent), false);
  assert.equal(fs.existsSync(oldCreation), false);
  assert.ok(fs.existsSync(youngEvent));
  assert.ok(fs.existsSync(starting));
});

test("prune cleans stale drafts and relays but keeps retained job pointers", (t) => {
  const ctx = setup(t);
  const removed = ctx.job("removed");
  const retained = ctx.job("retained", { completedAt: YOUNG });
  writeRelayPointer(ctx.env, { agentId: "removed", jobDir: removed });
  writeRelayPointer(ctx.env, { agentId: "retained", jobDir: retained });
  writeRelayPointer(ctx.env, { agentId: "failed-start", startError: "failed" });
  const drafts = path.join(ctx.home, "drafts");
  fs.mkdirSync(path.join(drafts, "prompt-stale"), { recursive: true });
  const draft = path.join(drafts, "prompt-stale", "prompt.md");
  fs.writeFileSync(draft, "old prompt");
  const fresh = path.join(drafts, "fresh.md");
  fs.writeFileSync(fresh, "fresh prompt");
  const link = path.join(drafts, "link");
  fs.symlinkSync(fresh, link);
  const pointers = ["removed", "retained", "failed-start"].map((name) => path.join(ctx.home, "relays", `${name}.json`));
  for (const file of [draft, ...pointers]) fs.utimesSync(file, new Date(OLD), new Date(OLD));
  assert.match(ctx.prune(), /total: 1 jobs, 3 files;/);
  assert.equal(fs.existsSync(draft), false);
  assert.equal(fs.existsSync(path.dirname(draft)), false);
  assert.equal(fs.existsSync(pointers[0]), false);
  assert.equal(fs.existsSync(pointers[2]), false);
  assert.ok(fs.existsSync(pointers[1]));
  assert.ok(fs.existsSync(fresh));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});

test("prune accepts days hours and minutes and rejects invalid arguments", (t) => {
  const ctx = setup(t);
  for (const duration of ["1d", "24h", "1440m"]) {
    const dir = ctx.job(`duration-${duration}`, { completedAt: new Date(Date.now() - 2 * 86400000).toISOString() });
    ctx.prune("--older-than", duration);
    assert.equal(fs.existsSync(dir), false);
  }
  for (const args of [["--older-than", "14"], ["--older-than", "-1d"], ["--older-than"], ["--typo"], ["extra"]]) {
    const result = run(process.execPath, [SCRIPT, "prune", ...args], { cwd: ctx.work, env: ctx.env });
    assert.equal(result.status, 1, args.join(" "));
  }
});
