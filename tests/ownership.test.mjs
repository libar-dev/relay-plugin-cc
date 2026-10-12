// One owner per lock. The worker lease
// (`worker.lease`) and the relay's inbox lock (`inbox/relay.lock`) share one ownership
// helper, and every test here runs once for each lock. Contenders are separate processes,
// as they are in use: a worker, a relay hook, a wait. A child pauses at a chosen point
// through a hook on `fs`, so a race is opened on purpose instead of hoped for.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { makeTempDir } from "./support/helpers.mjs";
import { acquireWorkerLease, readLease, releaseWorkerLease } from "../plugins/relay/scripts/lib/jobs/lease.mjs";
import { jobPaths } from "../plugins/relay/scripts/lib/jobs/store.mjs";
import { ownershipDir, readOwnership } from "../plugins/relay/scripts/lib/util/ownership.mjs";
import { readProcessStartTime } from "../plugins/relay/scripts/lib/util/process.mjs";

const JOBS_URL = new URL("../plugins/relay/scripts/lib/jobs/lease.mjs", import.meta.url).href;
const RELAY_URL = new URL("../plugins/relay/scripts/lib/harness/relay.mjs", import.meta.url).href;
const PROCESS_URL = new URL("../plugins/relay/scripts/lib/util/process.mjs", import.meta.url).href;

const me = () => ({ pid: process.pid, startTime: readProcessStartTime(process.pid) });

// The two locks, each through its own module's functions.
const LOCKS = {
  lease: {
    file: (dir) => jobPaths(dir).lease,
    acquire: async (dir) => acquireWorkerLease(dir, me()),
    release: async (dir) => releaseWorkerLease(dir, me()),
    owner: (dir) => readLease(dir),
    child: {
      acquire: `const { acquireWorkerLease } = await import(${JSON.stringify(JOBS_URL)});
        const { readProcessStartTime } = await import(${JSON.stringify(PROCESS_URL)});
        return acquireWorkerLease(dir, { pid: process.pid, startTime: readProcessStartTime(process.pid) });`,
      release: `const { releaseWorkerLease } = await import(${JSON.stringify(JOBS_URL)});
        releaseWorkerLease(dir, {});`
    }
  },
  relay: {
    file: (dir) => path.join(dir, "inbox", "relay.lock"),
    acquire: async (dir) => (await import(RELAY_URL)).tryLock(dir),
    release: async (dir) => (await import(RELAY_URL)).unlock(dir),
    owner: (dir) => readOwnership(path.join(dir, "inbox", "relay.lock")),
    child: {
      acquire: `const { tryLock } = await import(${JSON.stringify(RELAY_URL)});
        return tryLock(dir);`,
      release: `const { unlock } = await import(${JSON.stringify(RELAY_URL)});
        unlock(dir);`
    }
  }
};

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

// The numbered records in the lock's directory, lowest first.
function records(kind, dir) {
  const generations = ownershipDir(LOCKS[kind].file(dir));
  return fs.readdirSync(generations).filter((name) => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b)
    .map((n) => ({ n, raw: fs.readFileSync(path.join(generations, String(n)), "utf8") }));
}

// A child process that takes one lock (and with `release`, gives it back), reports, and
// stays alive until the test kills it. `pause: "seen"` stops it once it has read a lock
// record and is about to judge it; `pause: "created"` right after the call that creates a
// lock record. It
// writes `<tag>-<pause>` when it stops and goes on once `<tag>-go` exists. Every file it
// writes for the test is renamed into place, so the test never reads one half-written.
function lockChild(t, kind, dir, sync, tag, { pause = null, release = false } = {}) {
  const lock = LOCKS[kind].file(dir);
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    const dir = ${JSON.stringify(dir)};
    const generations = ${JSON.stringify(ownershipDir(lock))};
    const sync = ${JSON.stringify(sync)};
    const tag = ${JSON.stringify(tag)};
    const pause = ${JSON.stringify(pause)};
    const signal = (name, text = "") => {
      const tmp = path.join(sync, "." + tag + "-" + name + ".tmp");
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, path.join(sync, tag + "-" + name));
    };
    const hold = () => {
      signal(pause);
      while (!fs.existsSync(path.join(sync, tag + "-go"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    };
    const isRecord = (target) => typeof target === "string" && (path.dirname(target) === generations && /^\\d+$/.test(path.basename(target)));
    let paused = false;
    const hook = (name, target) => {
      const original = fs[name];
      fs[name] = function (...args) {
        const out = original.apply(this, args);
        if (!paused && isRecord(target(args)) && fs.existsSync(target(args))) {
          paused = true;
          hold();
        }
        return out;
      };
    };
    if (pause === "created") {
      hook("openSync", (args) => args[0]);
      hook("linkSync", (args) => args[1]);
      hook("renameSync", (args) => args[1]);
    } else if (pause === "seen") {
      hook("statSync", (args) => args[0]);
    }
    const acquire = async () => { ${LOCKS[kind].child.acquire} };
    const got = Boolean(await acquire());
    if (got && ${JSON.stringify(release)}) {
      ${LOCKS[kind].child.release}
    }
    signal("result", JSON.stringify({ got }));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = once(child, "close");
  t.after(async () => {
    child.kill("SIGKILL");
    await closed;
  });
  return {
    child,
    identity: () => ({ pid: child.pid, startTime: readProcessStartTime(child.pid) }),
    async result() {
      const file = path.join(sync, `${tag}-result`);
      await waitFor(() => fs.existsSync(file) || child.exitCode !== null);
      assert.ok(fs.existsSync(file), `child ${tag} ended without a result: ${stderr}`);
      return JSON.parse(fs.readFileSync(file, "utf8")).got;
    },
    async paused() {
      const file = path.join(sync, `${tag}-${pause}`);
      await waitFor(() => fs.existsSync(file) || child.exitCode !== null);
      assert.ok(fs.existsSync(file), `child ${tag} never paused: ${stderr}`);
    },
    go() {
      fs.writeFileSync(path.join(sync, `${tag}-go`), "");
    }
  };
}

// The identity of a process that has exited.
async function deadIdentity() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const closed = once(child, "close");
  await waitFor(() => readProcessStartTime(child.pid));
  const identity = { pid: child.pid, startTime: readProcessStartTime(child.pid) };
  child.kill("SIGKILL");
  await closed;
  return identity;
}

function lockDir(kind) {
  const dir = makeTempDir(`relay-ownership-${kind}-`);
  fs.mkdirSync(path.dirname(LOCKS[kind].file(dir)), { recursive: true });
  return { dir, sync: makeTempDir("relay-ownership-sync-") };
}

// A lock whose only record (number 1) names a dead holder.
async function deadLock(kind, dir) {
  const generations = ownershipDir(LOCKS[kind].file(dir));
  fs.mkdirSync(generations, { recursive: true });
  fs.writeFileSync(path.join(generations, "1"), JSON.stringify({ ...(await deadIdentity()), token: "dead-holder" }));
}

function age(file, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(file, when, when);
}

for (const kind of Object.keys(LOCKS)) {
  test(`${kind}: many takers of one dead holder at once leave exactly one owner`, async (t) => {
    const { dir, sync } = lockDir(kind);
    await deadLock(kind, dir);
    // Every taker reads the dead holder's record before any of them acts on it.
    const takers = ["a", "b", "c", "d", "e", "f"].map((tag) => lockChild(t, kind, dir, sync, tag, { pause: "seen" }));
    await Promise.all(takers.map((taker) => taker.paused()));
    for (const taker of takers) taker.go();
    const got = await Promise.all(takers.map((taker) => taker.result()));
    assert.equal(got.filter(Boolean).length, 1, JSON.stringify(got));
    assert.equal(LOCKS[kind].owner(dir).pid, takers[got.indexOf(true)].child.pid);
  });

  test(`${kind}: a taker paused between seeing the dead holder and creating finds a newer number and does not own`, async (t) => {
    const { dir, sync } = lockDir(kind);
    await deadLock(kind, dir);
    const late = lockChild(t, kind, dir, sync, "late", { pause: "seen" });
    await late.paused();
    // Meanwhile this process takes over, releases and takes the lock again, so the number
    // the paused taker will create (2) has been taken and deleted below a higher one.
    assert.equal(await LOCKS[kind].acquire(dir), true);
    await LOCKS[kind].release(dir);
    assert.equal(await LOCKS[kind].acquire(dir), true);
    t.after(() => LOCKS[kind].release(dir));
    const before = records(kind, dir);
    assert.deepEqual(before.map((entry) => entry.n), [4]);
    late.go();
    assert.equal(await late.result(), false);
    assert.equal(LOCKS[kind].owner(dir).pid, process.pid);
    assert.deepEqual(records(kind, dir), before, "the owner's record is untouched and the late take is gone");
  });

  test(`${kind}: a holder that takes the lock during another's takeover is not removed`, async (t) => {
    const { dir, sync } = lockDir(kind);
    await deadLock(kind, dir);
    const taker = lockChild(t, kind, dir, sync, "taker", { pause: "seen" });
    await taker.paused();
    assert.equal(await LOCKS[kind].acquire(dir), true);
    t.after(() => LOCKS[kind].release(dir));
    const mine = records(kind, dir).at(-1);
    taker.go();
    assert.equal(await taker.result(), false);
    assert.deepEqual(records(kind, dir).at(-1), mine);
    assert.equal(LOCKS[kind].owner(dir).pid, process.pid);
  });

  test(`${kind}: a record is never seen half-written, so a live owner keeps it`, async (t) => {
    // Atomic publication keeps the record complete even while its holder pauses,
    // so a contender cannot take the lock from a live holder.
    const { dir, sync } = lockDir(kind);
    const owner = lockChild(t, kind, dir, sync, "owner", { pause: "created" });
    await owner.paused();
    const [record] = records(kind, dir);
    assert.equal(JSON.parse(record.raw).pid, owner.child.pid, "the record is complete while publication is paused");
    const contenderGot = await LOCKS[kind].acquire(dir);
    t.after(() => contenderGot && LOCKS[kind].release(dir));
    owner.go();
    const ownerGot = await owner.result();
    assert.equal(contenderGot, false);
    assert.equal(ownerGot, true);
    assert.equal(LOCKS[kind].owner(dir).pid, owner.child.pid);
  });

  test(`${kind}: release followed by acquire`, async (t) => {
    const { dir, sync } = lockDir(kind);
    const first = lockChild(t, kind, dir, sync, "first", { release: true });
    assert.equal(await first.result(), true);
    assert.equal(LOCKS[kind].owner(dir), null, "a released lock has no owner");
    assert.equal(await LOCKS[kind].acquire(dir), true);
    assert.equal(LOCKS[kind].owner(dir).pid, process.pid);
    assert.deepEqual(records(kind, dir).map((entry) => entry.n), [3], "numbers below the owner's are deleted");
    await LOCKS[kind].release(dir);
    assert.equal(LOCKS[kind].owner(dir), null);
    assert.equal(JSON.parse(records(kind, dir).at(-1).raw).release, true);
  });

  test(`${kind}: a release by a non-owner leaves the lock in place`, async (t) => {
    const { dir, sync } = lockDir(kind);
    const owner = lockChild(t, kind, dir, sync, "owner");
    assert.equal(await owner.result(), true);
    const before = records(kind, dir);
    await LOCKS[kind].release(dir);
    assert.deepEqual(records(kind, dir), before);
    assert.equal(LOCKS[kind].owner(dir).pid, owner.child.pid);
  });

  test(`${kind}: release with a mismatched token leaves the numbered lock`, async () => {
    const { dir } = lockDir(kind);
    assert.equal(await LOCKS[kind].acquire(dir), true);
    const file = LOCKS[kind].file(dir);
    const top = records(kind, dir).at(-1);
    fs.writeFileSync(path.join(ownershipDir(file), String(top.n)), JSON.stringify({ ...JSON.parse(top.raw), token: "replacement" }));
    const before = records(kind, dir);
    await LOCKS[kind].release(dir);
    assert.deepEqual(records(kind, dir), before);
  });

  test(`${kind}: an unreadable record is stale only once it is older than 10 seconds`, async () => {
    const { dir } = lockDir(kind);
    const file = LOCKS[kind].file(dir);
    // A numbered record that cannot be parsed.
    const top = path.join(ownershipDir(file), "1");
    fs.mkdirSync(ownershipDir(file), { recursive: true });
    fs.writeFileSync(top, "{");
    age(top, 9500);
    assert.equal(await LOCKS[kind].acquire(dir), false);
    assert.equal(fs.readFileSync(top, "utf8"), "{");
    age(top, 10500);
    assert.equal(await LOCKS[kind].acquire(dir), true);
    assert.equal(LOCKS[kind].owner(dir).pid, process.pid);
    await LOCKS[kind].release(dir);
  });

  test(`${kind}: a live holder is never broken, however old its record`, async (t) => {
    const { dir, sync } = lockDir(kind);
    const owner = lockChild(t, kind, dir, sync, "owner");
    assert.equal(await owner.result(), true);
    const top = records(kind, dir).at(-1);
    age(path.join(ownershipDir(LOCKS[kind].file(dir)), String(top.n)), 600000);
    assert.equal(await LOCKS[kind].acquire(dir), false);
    assert.equal(LOCKS[kind].owner(dir).pid, owner.child.pid);
  });
}
