// Manual retention only. Never follow links into directories outside the job store.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { acquireWorkerLease, isWorkerAlive, readLease, releaseWorkerLease } from "./lease.mjs";
import { computeJobView, formatDuration } from "./view.mjs";
import { readJob, readJsonOrNull, repoSlugFor, resolveJobsHome, TERMINAL_STATES } from "./store.mjs";
import { ownershipDir } from "../util/ownership.mjs";
import { readProcessStartTime } from "../util/process.mjs";

function parseRetention(value = "14d") {
  const match = /^(\d+)([dhm])$/.exec(value);
  const ms = match ? Number(match[1]) * { d: 86400000, h: 3600000, m: 60000 }[match[2]] : NaN;
  if (!Number.isSafeInteger(ms)) throw new Error("--older-than needs a duration in d, h or m, such as 14d.");
  return ms;
}

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function bytes(dir) {
  const stat = fs.lstatSync(dir);
  return stat.isDirectory() ? entries(dir).reduce((sum, entry) => sum + bytes(path.join(dir, entry.name)), 0) : stat.size;
}

function candidate(dir, slug, cutoff, now, checkLease = true) {
  // A job must have the identity and timestamps written by start, in the right location.
  if (!fs.lstatSync(path.join(dir, "job.json"), { throwIfNoEntry: false })?.isFile()) return null;
  const job = readJob(dir);
  if (!job || job.id !== path.basename(dir) || job.repoSlug !== slug ||
      !["starting", "running", "queued", ...TERMINAL_STATES].includes(job.state) ||
      !Number.isFinite(Date.parse(job.createdAt))) return null;
  const view = computeJobView(job, { now });
  if (!(TERMINAL_STATES.has(view.state) || view.state === "dead")) return null;
  if (isWorkerAlive(job.worker) || (checkLease && isWorkerAlive(readLease(dir)))) return null;
  const activity = job.completedAt ?? job.lastEventAt ?? job.createdAt;
  const at = Date.parse(activity);
  if (!Number.isFinite(at) || at >= cutoff) return null;
  return { id: job.id, state: view.state, age: formatDuration(activity, new Date(now).toISOString()) };
}

export function pruneJobs({ cwd = process.cwd(), env = process.env, olderThan = "14d", all = false, dryRun = false, now = Date.now() } = {}) {
  const cutoff = now - parseRetention(olderThan);
  const home = resolveJobsHome(env);
  const removedJobs = new Set();
  const lines = [];
  let freed = 0;
  let files = 0;
  const me = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
  const slugs = all ? entries(home).filter((entry) => entry.isDirectory() && /^.+-[0-9a-f]{8}$/.test(entry.name)).map((entry) => entry.name) : [repoSlugFor(cwd)];
  for (const slug of slugs) {
    const slugDir = path.join(home, slug);
    if (!fs.lstatSync(slugDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const entry of entries(slugDir).filter((entry) => entry.isDirectory())) {
      const dir = path.join(slugDir, entry.name);
      let job = candidate(dir, slug, cutoff, now);
      if (!job) continue;
      if (!dryRun) {
        // Serialize with resumed workers, then read state and activity again under the lease.
        const leasePath = path.join(dir, "worker.lease");
        if (!acquireWorkerLease(dir, me)) continue;
        try {
          job = candidate(dir, slug, cutoff, now, false);
          if (!job) continue;
          // The ownership records are lock metadata, not retained job data.
          freed += bytes(dir) - bytes(ownershipDir(leasePath));
          fs.rmSync(dir, { recursive: true });
        } finally {
          releaseWorkerLease(dir, me);
        }
      } else {
        freed += bytes(dir);
      }
      removedJobs.add(dir);
      lines.push(`${dryRun ? "would remove" : "removed"}: ${job.id}  state: ${job.state}  age: ${job.age}`);
    }
    if (!dryRun && entries(slugDir).length === 0) fs.rmdirSync(slugDir);
  }
  function cleanFiles(dir, relay = false) {
    if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
    for (const entry of entries(dir)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !relay) {
        cleanFiles(file);
        if (!dryRun && entries(file).length === 0) fs.rmdirSync(file);
      } else if (entry.isFile() && fs.lstatSync(file).mtimeMs < cutoff) {
        if (relay) {
          // Pointers remain usable for follow-ups as long as their job is retained.
          const pointer = readJsonOrNull(file);
          if (pointer?.jobDir && fs.existsSync(pointer.jobDir) && !removedJobs.has(path.resolve(pointer.jobDir))) continue;
        }
        freed += fs.lstatSync(file).size;
        files += 1;
        lines.push(`${dryRun ? "would remove" : "removed"} file: ${file}`);
        if (!dryRun) fs.unlinkSync(file);
      }
    }
  }
  cleanFiles(path.join(home, "drafts"));
  cleanFiles(path.join(home, "relays"), true);
  lines.push(`total: ${removedJobs.size} jobs, ${files} files; ${dryRun ? "would free" : "freed"}: ${freed} bytes`);
  return `${lines.join("\n")}\n`;
}
