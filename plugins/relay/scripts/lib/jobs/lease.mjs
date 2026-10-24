import { jobPaths, readJob } from "./store.mjs";
import { acquireOwnership, readOwnership, releaseOwnership } from "../util/ownership.mjs";
import { pendingInboxMessages, owedMessages } from "./messages.mjs";
import { isProcessIdentityAlive } from "../util/process.mjs";


export const isWorkerAlive = isProcessIdentityAlive;


// The worker lease: one worker per job, through the ownership helper the relay lock also
// uses. The record names the holder (pid and start time),
// its role and a token; a lease whose holder is gone is taken over, a live one never, and
// only the process that took the lease releases it. The role tells a worker, the only
// holder that consumes inbox messages, from a cancel or a recovery that takes the lease to
// write job.json. `worker` in the release is kept for the callers' symmetry.
export function acquireWorkerLease(jobDir, worker, role = "worker") {
  const file = jobPaths(jobDir).lease;
  if (!acquireOwnership(file, { ...worker, role })) return false;
  // A dispatch already in flight may arrive after the submitting window closed.
  // Under the same fence as refusal, prevent it from reviving an unstarted brief.
  // A later explicit message is work the user has asked to submit again.
  if (role === "worker" && readJob(jobDir)?.admission?.state === "not-started" &&
      pendingInboxMessages(jobDir).length === 0 && owedMessages(jobDir).length === 0) {
    releaseOwnership(file); return false;
  }
  return true;
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
