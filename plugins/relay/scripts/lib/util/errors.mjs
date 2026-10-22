export class UsageError extends Error {}

// A cancel for an attempt the job has moved past (`cancel --attempt N`): nothing was cancelled.
export class AttemptChanged extends Error {}

// A job reference that names no job of this jobs home (pruned, mistyped, another home's).
export class JobNotFound extends Error {}
