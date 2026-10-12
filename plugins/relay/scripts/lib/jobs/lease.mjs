import { jobPaths } from "./store.mjs";
import { acquireOwnership, readOwnership, releaseOwnership } from "../util/ownership.mjs";
import { isProcessIdentityAlive } from "../util/process.mjs";


export const isWorkerAlive = isProcessIdentityAlive;


// The worker lease: one worker per job, through the ownership helper the relay lock also
// uses. The record names the holder (pid and start time),
// its role and a token; a lease whose holder is gone is taken over, a live one never, and
// only the process that took the lease releases it. The role tells a worker, the only
// holder that consumes inbox messages, from a cancel or a recovery that takes the lease to
// write job.json. `worker` in the release is kept for the callers' symmetry.
export function acquireWorkerLease(jobDir, worker, role = "worker") {
  return Boolean(acquireOwnership(jobPaths(jobDir).lease, { ...worker, role }));
}


// Is the lease held by a live worker? Other holders do not consume inbox messages.
export function isWorkerLease(lease) {
  return Boolean(lease && lease.role === "worker" && isWorkerAlive(lease));
}


export function releaseWorkerLease(jobDir, worker) {
  releaseOwnership(jobPaths(jobDir).lease);
}


// The lease holder's record, live or not; null when the lease is free.
export function readLease(jobDir) {
  return readOwnership(jobPaths(jobDir).lease);
}
