import fs from "node:fs";
import path from "node:path";
import { independentWorkerRegistry, safeWorkerRegistry, isProcessIdentityAlive } from "../util/process.mjs";
import { readJsonOrNull, writeJsonAtomic } from "../jobs/store.mjs";

export function registerWorker(worker, { env = process.env, platform = process.platform, directory = independentWorkerRegistry() } = {}) {
  if (!["linux", "darwin"].includes(platform)) return null;
  // Cleanup boundaries must survive an unwritable admission directory, even with
  // the guard off. Publish before handoff; inability to publish prevents launch.
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!safeWorkerRegistry(directory)) throw new Error("Worker identity directory must be private, owned by this user and not a symlink.");
  if (!worker?.startTime) throw new Error("Worker process identity could not be read; no backend was started.");
  pruneWorkerRegistry(directory);
  const file = path.join(directory, `${worker.pid}.json`);
  writeJsonAtomic(file, worker);
  return file;
}

// Registration performs a small rotating maintenance pass, independently of
// heartbeat sampling. Identity checks retain live or unreadable identities.
export function pruneWorkerRegistry(directory = independentWorkerRegistry(), { limit = 128, isAlive = isProcessIdentityAlive } = {}) {
  let names;
  try { names = fs.readdirSync(directory).filter(name => /^\d+\.json$/.test(name)).sort(); }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  const cursorFile = path.join(directory, ".sweep.json");
  const cursor = readJsonOrNull(cursorFile)?.after ?? "";
  const ordered = [...names.filter(name => name > cursor), ...names.filter(name => name <= cursor)].slice(0, limit);
  let removed = 0;
  for (const name of ordered) {
    const file = path.join(directory, name), worker = readJsonOrNull(file);
    if (worker?.startTime && !isAlive(worker)) { fs.rmSync(file, { force: true }); removed++; }
  }
  if (ordered.length) writeJsonAtomic(cursorFile, { after: ordered.at(-1) });
  return removed;
}
