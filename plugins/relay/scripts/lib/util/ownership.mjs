// One owner per lock. The worker lease
// (`worker.lease`) and the relay's inbox lock (`inbox/relay.lock`) both use it.
//
// Ownership is a series of numbered records in `<lock>.d/`: 1, 2, 3 and on. The highest
// number decides. It is the owner while its holder (pid and process start time) lives and
// it is not a release record.
//
// - Every attempt writes its whole record to a temporary file and links it as the number
//   above the highest it read. A link that fails with EEXIST means another process took
//   that number. A record is never half-written, and one exclusive create is the only step
//   that makes an owner.
// - A taker that finds the highest holder dead links the next number. A taker that read an
//   old highest and links late finds a newer number above its own, and does not own.
// - Release links the next number as a release record.
// - Any process may delete numbers below the highest it has seen. No path removes, renames
//   or replaces the highest record, so no record a live process may own is ever touched.
// - A record that cannot be parsed is stale only once it is older than 10 seconds.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { isProcessIdentityAlive, readProcessStartTime } from "./process.mjs";

const UNREADABLE_STALE_MS = 10 * 1000;

// The number and token of every lock this process holds, by lock path.
const held = new Map();
let selfStartTime;

function self() {
  if (selfStartTime === undefined) {
    selfStartTime = readProcessStartTime(process.pid);
  }
  return { pid: process.pid, startTime: selfStartTime };
}

export function ownershipDir(file) {
  return `${file}.d`;
}

// Write the whole record, then link it into place. True when this call created `file`.
function publish(file, record) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(record), "utf8");
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// The record numbers present, highest first.
function numbers(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return names.filter((name) => /^\d+$/.test(name)).map(Number).sort((a, b) => b - a);
}

// A record file read and judged: "held" by a live owner, or "free" (released, dead, or
// unreadable for more than 10 seconds). Null when the file is gone.
function judge(file, isAlive = isProcessIdentityAlive) {
  let raw;
  let mtimeMs;
  try {
    raw = fs.readFileSync(file, "utf8");
    const stat = fs.statSync(file);
    mtimeMs = stat.mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let record = null;
  try {
    record = JSON.parse(raw);
  } catch {
    record = null;
  }
  if (record?.release === true) {
    return { state: "free", record: null };
  }
  if (!record || typeof record !== "object" || !Number.isInteger(record.pid)) {
    return { state: Date.now() - mtimeMs > UNREADABLE_STALE_MS ? "free" : "held", record: null };
  }
  return { state: isAlive(record) ? "held" : "free", record };
}

// The highest record: its number and judgement. The highest is never deleted, so a record
// gone between listing and reading means a higher one appeared: list again.
function highest(dir, isAlive = isProcessIdentityAlive) {
  for (let tries = 0; tries < 50; tries += 1) {
    const [n] = numbers(dir);
    if (n === undefined) {
      return { n: 0, state: "free", record: null };
    }
    const seen = judge(path.join(dir, String(n)), isAlive);
    if (seen) {
      return { n, ...seen };
    }
  }
  return { n: Infinity, state: "held", record: null };
}

// Delete the numbers below `top`. They decide nothing once a higher number exists.
function dropBelow(dir, top) {
  for (const n of numbers(dir)) {
    if (n < top) {
      fs.rmSync(path.join(dir, String(n)), { force: true });
    }
  }
}

// Take the lock at `file` for `identity` (pid and start time; this process by default).
// Returns the published record, or null when a live holder has it.
export function acquireOwnership(file, identity = {}, { isAlive = isProcessIdentityAlive } = {}) {
  const dir = ownershipDir(file);
  fs.mkdirSync(dir, { recursive: true });
  const record = { ...(identity.pid && "startTime" in identity ? {} : self()), ...identity, token: randomBytes(16).toString("hex") };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const top = highest(dir, isAlive);
    if (top.state === "held") {
      return null;
    }
    const n = top.n + 1;
    if (!publish(path.join(dir, String(n)), record)) {
      // Another process took that number; judge it.
      continue;
    }
    const [now] = numbers(dir);
    if (now > n) {
      // A newer number exists: this take read an old highest and is not the owner.
      dropBelow(dir, now);
      return null;
    }
    held.set(file, { n, token: record.token });
    dropBelow(dir, n);
    return record;
  }
  return null;
}

// Release a lock this process took, by linking a release record above its own.
export function releaseOwnership(file) {
  const mine = held.get(file);
  held.delete(file);
  if (!mine) {
    return false;
  }
  const dir = ownershipDir(file);
  const [top] = numbers(dir);
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(path.join(dir, String(top)), "utf8"));
  } catch {
    record = null;
  }
  if (top !== mine.n || record?.token !== mine.token) {
    return false;
  }
  if (!publish(path.join(dir, String(top + 1)), { release: true })) {
    return false;
  }
  dropBelow(dir, top + 1);
  return true;
}

// The highest numbered record unless it is a release record. Null when the lock is free.
export function readOwnership(file, { isAlive = isProcessIdentityAlive } = {}) {
  return highest(ownershipDir(file), isAlive).record;
}
