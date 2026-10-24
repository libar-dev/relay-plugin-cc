import './support/isolate-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setup, companion, promptFile, jobDirs, waitFor, ROOT } from './support/job-helpers.mjs';
import { reserveWaitingPlace, bindReservation, readReservation, describeGuard, spawnWithAdmission, admit, DEFAULTS as D } from '../plugins/relay/scripts/lib/worker/admission.mjs';
import { readJob, writeJob, jobPaths } from '../plugins/relay/scripts/lib/jobs/store.mjs';
import { computeJobView, loadJobView, exitCodeFor } from '../plugins/relay/scripts/lib/jobs/view.mjs';
import { hasLiveWorker, startWithinWindow, awaitOutcome } from '../plugins/relay/scripts/lib/worker/delivery.mjs';
import { acquireWorkerLease, releaseWorkerLease } from '../plugins/relay/scripts/lib/jobs/lease.mjs';
import { claimInboxMessages, messageAccount, postInboxMessage, writeOutcome } from '../plugins/relay/scripts/lib/jobs/messages.mjs';
import { readProcessStartTime } from '../plugins/relay/scripts/lib/util/process.mjs';
import { resumeDeadJobOnce } from '../plugins/relay/scripts/lib/worker/recovery.mjs';

function domain(t, limit = 2) {
  const ctx = setup(t, { env: { RELAY_ADMISSION: 'on', RELAY_MAX_WAITING_WORKERS: String(limit), RELAY_ADMISSION_POLL_MS: '20', RELAY_JOBS_ACK_TIMEOUT_MS: '200' } });
  ctx.env.RELAY_ADMISSION_HOME = path.join(ctx.root, 'admission');
  ctx.env.RELAY_TEST_ADMISSION_READINGS = path.join(ctx.root, 'readings.json');
  const machine = { totalBytes: 18 * 2**30, availableBytes: 16 * 2**30, cores: 12, load5: 0 };
  fs.writeFileSync(ctx.env.RELAY_TEST_ADMISSION_READINGS, JSON.stringify(machine));
  let now = Date.now();
  const deps = { now: () => now, readMachine: () => machine, scanUnslotted: () => [], env: ctx.env };
  return { ctx, deps, tick: (ms) => now += ms, machine };
}
function job(s, id = 'job-window', state = 'starting') {
  const dir = path.join(s.ctx.jobs, 'repo', id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jobPaths(dir).brief, '[quick] Dummy job.');
  writeJob(dir, { id, kind: 'task', state, createdAt: new Date().toISOString(), pendingFirstTurn: true, attempts: [],
    request: { backend: 'codex', cwd: s.ctx.work, model: 'synthetic-model', effort: 'low', notes: [] } });
  return dir;
}

test('gate reserves Q places, binds once, converts without double counting, and expires after 45 seconds', t => {
  const s = domain(t), a = reserveWaitingPlace(s.ctx.env, s.deps), b = reserveWaitingPlace(s.ctx.env, s.deps);
  assert.ok(a.pass && b.pass); assert.equal(reserveWaitingPlace(s.ctx.env, s.deps).pass, false);
  assert.equal(bindReservation(a.reservation, 'a-first', s.ctx.env, s.deps), true);
  assert.equal(readReservation('a-first', s.ctx.env), a.reservation);
  assert.equal(bindReservation(a.reservation, 'a-other', s.ctx.env, s.deps), false);
  const dir = job(s);
  assert.equal(spawnWithAdmission(dir, s.ctx.env, () => 123, s.deps, { reservation: a.reservation }), 123);
  const files = fs.readdirSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, 'slots'));
  assert.equal(files.length, 2); assert.ok(files.includes('job-window.json'));
  writeJob(dir, { ...readJob(dir), state: 'completed' });
  s.tick(D.reservationMs + 1);
  assert.equal(reserveWaitingPlace(s.ctx.env, s.deps).pass, true);
});

test('guard-off gate passes without reading or writing admission storage', t => {
  const s = domain(t); s.ctx.env.RELAY_ADMISSION = 'off'; s.ctx.env.RELAY_ADMISSION_HOME = '/dev/null/unwritable';
  assert.deepEqual(reserveWaitingPlace(s.ctx.env, s.deps), { pass: true, reservation: null });
  assert.equal(companion(s.ctx, ['gate']).stdout, 'pass\n');
});

test('window refusal exits 6 and readers never resurrect its brief after capacity frees', t => {
  const s = domain(t, 0);
  const result = companion(s.ctx, ['start', '--prompt-file', promptFile(s.ctx)]);
  assert.equal(result.status, 6, result.stderr + result.stdout);
  assert.match(result.stdout, /state: not started.*\nerror: Not started: waiting worker limit: 0 of 0/);
  const dir = jobDirs(s.ctx)[0], refused = readJob(dir);
  assert.equal(refused.state, 'failed'); assert.equal(refused.admission.state, 'not-started'); assert.equal(hasLiveWorker(dir), false);
  assert.equal(fs.existsSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, 'slots', `${refused.id}.json`)), false);
  s.ctx.env.RELAY_MAX_WAITING_WORKERS = '4';
  for (const argv of [['status', refused.id], ['result', refused.id], ['wait', refused.id, '--timeout-seconds', '1'], ['status', '--json', '--all']]) {
    const read = companion(s.ctx, argv); assert.doesNotMatch(read.stderr, /spawn|launch failed/);
  }
  assert.equal(readJob(dir).attempts.length, 0);
});

test('pressure clearing inside the start window acknowledges a real live worker lease', async t => {
  const s = domain(t), dir = job(s); s.machine.availableBytes = 0;
  const me = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
  let attempts = 0;
  const result = await startWithinWindow(dir, s.ctx.work, s.ctx.env, { windowMs: 200, spawn: () => {
    attempts++;
    if (attempts === 1) return spawnWithAdmission(dir, s.ctx.env, () => assert.fail('pressure'), s.deps);
    s.machine.availableBytes = 16 * 2**30;
    assert.equal(acquireWorkerLease(dir, me), true);
  } });
  assert.equal(result.accepted, true); assert.equal(hasLiveWorker(dir), true); releaseWorkerLease(dir, me);
});

test('a killed launcher is dead rather than an ownerless durable queue', async t => {
  const s = domain(t, 0); s.ctx.env.RELAY_JOBS_ACK_TIMEOUT_MS = '60000';
  const child = spawn(process.execPath, [path.join(ROOT, 'plugins/relay/scripts/companion.mjs'), 'start', '--prompt-file', promptFile(s.ctx)], { cwd: s.ctx.work, env: s.ctx.env, stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const dir = await waitFor(() => jobDirs(s.ctx).find(dir => readJob(dir).admission?.launcher));
  const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
  const view = computeJobView(readJob(dir)); assert.equal(view.state, 'dead'); assert.match(view.deadReason, /process starting it ended/);
});

test('a completed job continuation without a place is withdrawn and never runs later', async t => {
  const s = domain(t, 0), dir = job(s, 'job-completed', 'completed');
  const message = postInboxMessage(dir, { kind: 'continue', text: 'Never run this.' });
  const relay = path.join(jobPaths(dir).inbox, 'relay'); fs.mkdirSync(relay);
  fs.writeFileSync(path.join(relay, 'entry.json'), JSON.stringify({ messageId: message.id }));
  const result = await awaitOutcome(dir, message.id, { env: s.ctx.env, timeoutMs: 100 });
  assert.equal(result.consumer, false); assert.equal(result.outcome.action, 'not-started');
  assert.ok(fs.existsSync(path.join(dir, 'withdrawn', `${message.id}.json`)));
  assert.equal(fs.existsSync(path.join(relay, 'entry.json')), false);
  assert.deepEqual(messageAccount(dir).undelivered, []);
  s.ctx.env.RELAY_MAX_WAITING_WORKERS = '4';
  assert.equal(spawnWithAdmission(dir, s.ctx.env, () => assert.fail('withdrawn message ran'), s.deps), null);
});

test('a worker claim beating withdrawal delivers once rather than refusing the claimed message', async t => {
  const s = domain(t, 0), dir = job(s, 'job-race', 'completed');
  const msg = postInboxMessage(dir, { kind: 'continue', text: 'Once.' });
  const rename = fs.renameSync; let claims = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(dir, 'withdrawn', `${msg.id}.json`)) {
      claims += claimInboxMessages(dir).length;
      writeOutcome(dir, msg.id, { action: 'turn-started', turnId: 'synthetic-turn' });
    }
    return rename(from, to);
  });
  const result = await awaitOutcome(dir, msg.id, { env: s.ctx.env, timeoutMs: 0 });
  assert.equal(result.consumer, true); assert.equal(result.outcome.action, 'turn-started'); assert.equal(claims, 1);
});

test('recovery with no place preserves dead state and retries the same reserved message', async t => {
  const s = domain(t, 0), dir = job(s, 'job-recovery', 'running');
  writeJob(dir, { ...readJob(dir), worker: { pid: 2147483647, startTime: 'gone' } });
  assert.equal(await resumeDeadJobOnce(dir, s.ctx.env), false);
  const first = readJob(dir); assert.equal(computeJobView(first).state, 'dead'); assert.equal(first.automaticResumes[0].state, 'reserved');
  assert.equal(await resumeDeadJobOnce(dir, s.ctx.env), false);
  assert.equal(readJob(dir).automaticResumes[0].id, first.automaticResumes[0].id);
  assert.equal(fs.readdirSync(jobPaths(dir).inbox).filter(n => n.endsWith('.json')).length, 1);
});

test('33 gated submissions reach backend admission with no refused or unowned work', t => {
  const s = domain(t, 20), waiting = [], running = [], me = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
  let submitted = 0, admitted = 0, held = 0;
  while (admitted < 33) {
    while (submitted < 33) {
      const place = reserveWaitingPlace(s.ctx.env, s.deps);
      if (!place.pass) { held++; break; }
      const dir = job(s, `job-floor-${++submitted}`);
      const request = { ...readJob(dir).request, model: submitted <= 30 ? 'synthetic-sol' : 'synthetic-astra', effort: 'high' };
      writeJob(dir, { ...readJob(dir), request });
      assert.equal(spawnWithAdmission(dir, s.ctx.env, () => 1, s.deps, { reservation: place.reservation }), 1);
      // A synthetic worker owns each waiting slot while the fake backend is gated.
      const file = path.join(s.ctx.env.RELAY_ADMISSION_HOME, 'slots', `${readJob(dir).id}.json`);
      const slot = JSON.parse(fs.readFileSync(file)); fs.writeFileSync(file, JSON.stringify({ ...slot, pid: me.pid, processStart: me.startTime, state: 'waiting' }));
      waiting.push({ home: s.ctx.env.RELAY_ADMISSION_HOME, jobDir: dir, jobId: readJob(dir).id, me, request });
    }
    for (const ctx of [...waiting]) {
      const result = admit(ctx, s.deps); ctx.admission = result.record; ctx.waitingSince = result.record.since;
      if (result.admit) { waiting.splice(waiting.indexOf(ctx), 1); running.push(ctx); admitted++; }
    }
    s.tick(7000);
    // Fake remote work uses little resident memory; release startup holds naturally.
    assert.ok(admitted + waiting.length === submitted);
  }
  assert.equal(submitted, 33); assert.ok(held > 0); assert.equal(running.length, 33);
  for (const ctx of running) writeJob(ctx.jobDir, { ...readJob(ctx.jobDir), state: 'completed' });
});

test('foreground task uses a detached worker rather than the waiting caller', async t => {
  const s = domain(t); s.ctx.env.RELAY_ADMISSION = 'off'; s.ctx.env.RELAY_JOBS_ACK_TIMEOUT_MS = '5000';
  const script = path.join(ROOT, 'plugins/relay/scripts/companion.mjs');
  const caller = spawn(process.execPath, [script, 'task', '[quick] Dummy.'], { cwd: s.ctx.work, env: s.ctx.env, stdio: 'ignore' });
  const exited = once(caller, 'exit');
  t.after(() => { try { caller.kill('SIGKILL'); } catch {} });
  const dir = await waitFor(() => jobDirs(s.ctx).find(dir => readJob(dir).worker?.pid));
  assert.notEqual(readJob(dir).worker.pid, caller.pid); assert.equal(hasLiveWorker(dir), true);
  await exited;
});

test('a continuation interrupted at handoff is named as owed on the finished job and can retry', async t => {
  const s = domain(t); s.ctx.env.RELAY_ADMISSION = 'off'; s.ctx.env.RELAY_JOBS_ACK_TIMEOUT_MS = '5000';
  const started = companion(s.ctx, ['start', '--prompt-file', promptFile(s.ctx), '--json']);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const id = JSON.parse(started.stdout).jobId;
  assert.equal(companion(s.ctx, ['wait', id, '--timeout-seconds', '15']).status, 0);
  const dir = jobDirs(s.ctx)[0];
  await waitFor(() => !hasLiveWorker(dir));
  const msg = postInboxMessage(dir, { kind: 'continue', text: '[quick] Interrupted handoff.' });
  fs.writeFileSync(path.join(dir, 'launch-interrupted.json'), JSON.stringify({ state: 'handoff-failed', requestedAt: new Date(Date.now() + 1).toISOString(), worker: { pid: 2147483647, startTime: 'gone' } }));
  const view = loadJobView(dir); assert.ok(view.undelivered.includes(msg.id));
  const block = companion(s.ctx, ['result', id, '--state-only']); assert.match(block.stdout, new RegExp(msg.id));
  const result = await awaitOutcome(dir, msg.id, { env: s.ctx.env, wait: false, timeoutMs: 5000 });
  assert.equal(result.consumer, true);
  assert.equal(companion(s.ctx, ['wait', id, '--timeout-seconds', '15']).status, 0);
  assert.equal(readJob(dir).attempts.filter(a => a.messageId === msg.id).length, 1);
});

test('a message racing warm-worker exit redispatches promptly after the lease disappears', async t => {
  const s = domain(t); s.ctx.env.RELAY_ADMISSION = 'off'; s.ctx.env.RELAY_JOBS_ACK_TIMEOUT_MS = '5000'; s.ctx.env.RELAY_ADMISSION_POLL_MS = '3000';
  const dir = job(s, 'job-warm-exit', 'completed');
  const leaseModule = new URL('../plugins/relay/scripts/lib/jobs/lease.mjs', import.meta.url).href;
  const processModule = new URL('../plugins/relay/scripts/lib/util/process.mjs', import.meta.url).href;
  const warm = spawn(process.execPath, ['--input-type=module', '-e', `import {acquireWorkerLease,releaseWorkerLease} from ${JSON.stringify(leaseModule)};
import {readProcessStartTime} from ${JSON.stringify(processModule)};
const dir=${JSON.stringify(dir)}, me={pid:process.pid,startTime:readProcessStartTime(process.pid)};
acquireWorkerLease(dir,me); console.log(JSON.stringify(me));
setTimeout(()=>releaseWorkerLease(dir,me),100); setTimeout(()=>process.exit(0),300);`], { cwd: s.ctx.work, env: s.ctx.env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { warm.kill('SIGKILL'); } catch {} });
  const identity = JSON.parse(String((await once(warm.stdout, 'data'))[0]));
  fs.writeFileSync(path.join(dir, 'launch-warm.json'), JSON.stringify({ state: 'acknowledged', worker: identity, requestedAt: new Date().toISOString() }));
  writeJob(dir, { ...readJob(dir), worker: identity });
  const msg = postInboxMessage(dir, { kind: 'continue', text: '[quick] Warm-exit message.' });
  const begin = Date.now();
  const result = await awaitOutcome(dir, msg.id, { env: s.ctx.env, timeoutMs: 5000 });
  assert.equal(result.consumer, true); assert.match(result.outcome?.action, /^(queued-next-turn|turn-started)$/); assert.notEqual(readJob(dir).worker?.pid, identity.pid); assert.ok(Date.now() - begin < 2800, 'redispatch must not wait for the old five-second timer');
});

test('a dispatch arriving after refusal cannot acquire the worker lease or run the brief', async t => {
  const s = domain(t, 0), dir = job(s);
  await startWithinWindow(dir, s.ctx.work, s.ctx.env, { windowMs: 0 });
  assert.equal(readJob(dir).admission.state, 'not-started');
  const me = { pid: process.pid, startTime: readProcessStartTime(process.pid) };
  assert.equal(acquireWorkerLease(dir, me), false);
  assert.equal(hasLiveWorker(dir), false);
  const explicit = postInboxMessage(dir, { kind: 'resume', text: '[quick] Submit again explicitly.' });
  assert.equal(acquireWorkerLease(dir, me), true); releaseWorkerLease(dir, me);
  // The assertion fixture has no actual worker; close the explicit message for teardown.
  claimInboxMessages(dir); writeOutcome(dir, explicit.id, { action: 'skipped' });
});

test('recovery converts an adopting relay reservation rather than blocking behind it', async t => {
  const s = domain(t, 1); s.ctx.env.RELAY_ADMISSION_POLL_MS = '1000';
  const dir = job(s, 'job-reserved-recovery', 'running');
  writeJob(dir, { ...readJob(dir), worker: { pid: 2147483647, startTime: 'gone' }, relay: { agentId: 'a-adopted' } });
  const place = reserveWaitingPlace(s.ctx.env, s.deps);
  assert.equal(bindReservation(place.reservation, 'a-adopted', s.ctx.env, s.deps), true);
  assert.equal(reserveWaitingPlace(s.ctx.env, s.deps).pass, false);
  assert.equal(await resumeDeadJobOnce(dir, s.ctx.env), true);
  assert.equal(fs.existsSync(path.join(s.ctx.env.RELAY_ADMISSION_HOME, 'slots', `r-${place.reservation}.json`)), false);
  await waitFor(() => readJob(dir).state === 'completed' && !hasLiveWorker(dir));
});

test('a guard error is an error from the gate so hooks can fall back to bounded start', t => {
  const s = domain(t); s.ctx.env.RELAY_ADMISSION_HOME = '/dev/null/unwritable';
  const result = companion(s.ctx, ['gate', '--wait-seconds', '30']);
  assert.equal(result.status, 1); assert.match(result.stderr, /guard unavailable/); assert.equal(result.stdout, '');
});

test('a plain resume with no job bypasses the retry gate even if no waiting place is free', t => {
  const s = domain(t, 0);
  const transcript = path.join(s.ctx.root, 'subagents', 'agent-a-refused.jsonl');
  fs.mkdirSync(path.dirname(transcript)); fs.writeFileSync(transcript, '');
  const result = companion(s.ctx, ['gate', '--retry', '--agent', 'a-refused', '--transcript', transcript, '--wait-seconds', '30']);
  assert.equal(result.status, 0); assert.equal(result.stdout, 'pass\n');
});


test('an unclassified retry with no transcript waits for capacity instead of bypassing the gate', t => {
  const s = domain(t, 0);
  const transcript = path.join(s.ctx.root, 'subagents', 'workflows', 'wf-test', 'agent-a-unknown.jsonl');
  const result = companion(s.ctx, ['gate', '--retry', '--agent', 'a-unknown', '--transcript', transcript]);
  assert.equal(result.status, 0); assert.match(result.stdout, /^hold waiting worker limit: 0 of 0/);
});
