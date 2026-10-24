import './support/isolate-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './support/job-helpers.mjs';
import { createJobDir, readJob, writeJob, jobPaths } from '../plugins/relay/scripts/lib/jobs/store.mjs';
import { readLaunchPrompt } from '../plugins/relay/scripts/lib/jobs/request.mjs';
import { messageAccount, postInboxMessage } from '../plugins/relay/scripts/lib/jobs/messages.mjs';
import { readLease } from '../plugins/relay/scripts/lib/jobs/lease.mjs';
import { isProcessIdentityAlive } from '../plugins/relay/scripts/lib/util/process.mjs';
import { runWorker } from '../plugins/relay/scripts/lib/worker/worker.mjs';

function fixture(t) {
  const ctx = setup(t, { turnMs: 50, env: { RELAY_ADMISSION: 'off', RELAY_WORKER_SCOPE: 'off' } });
  const { jobDir } = createJobDir(ctx.work, 'job-storage', ctx.env);
  const { request, brief } = readLaunchPrompt('model: gpt-test\neffort: low\n---\n[quick] Finish.', { baseDir: ctx.work, env: ctx.env });
  writeJob(jobDir, { id: 'job-storage', kind: 'task', state: 'starting', pendingFirstTurn: true, attempts: [], request });
  fs.writeFileSync(jobPaths(jobDir).brief, brief);
  return { ctx, jobDir, paths: jobPaths(jobDir) };
}

for (const code of ['EACCES', 'EIO']) for (const stage of ['inbox', 'claimed', 'handoff', 'released']) {
  test(`${code} reading ${stage} during worker finalization fails explicitly and preserves owed work`, async t => {
    const { ctx, jobDir, paths } = fixture(t);
    const readdir = fs.readdirSync;
    let armed = false, injected = false, message, completionReads = 0;
    const mock = t.mock.method(fs, 'readdirSync', function (directory, ...args) {
      const job = readJob(jobDir);
      if (String(directory) === paths.inbox && job.state === 'completed') completionReads++;
      const finalizing = stage === 'released' ? completionReads >= 2 : stage === 'handoff' ? completionReads >= 1 : job.attempts?.at(-1)?.state === 'completed';
      if (!armed && finalizing) {
        message = postInboxMessage(jobDir, { kind: 'continue', text: 'Owed follow-up.' });
        if (stage === 'claimed') {
          fs.mkdirSync(paths.claimed, { recursive: true });
          fs.renameSync(path.join(paths.inbox, `${message.id}.json`), path.join(paths.claimed, `${message.id}.json`));
        }
        armed = true;
      }
      if (armed && String(directory) === (stage === 'claimed' ? paths.claimed : paths.inbox)) {
        injected = true;
        throw Object.assign(new Error('synthetic message storage failure'), { code });
      }
      return readdir.call(this, directory, ...args);
    });
    let rejected;
    try { await runWorker(jobDir, { env: ctx.env }); } catch (error) { rejected = error; }
    finally { mock.mock.restore(); }
    assert.equal(injected, true);
    const job = readJob(jobDir);
    assert.equal(job.state, 'failed');
    assert.match(job.errorMessage, new RegExp(`storage uncertain:.*${code}`));
    if (rejected) assert.match(rejected.message, /storage uncertain/);
    assert.deepEqual(messageAccount(jobDir).undelivered, [message.id]);
    assert.equal(readLease(jobDir), null);
    assert.equal(ctx.fakeState().appServerStarts, 1);
    assert.equal(isProcessIdentityAlive(job.server), false);
  });
}

test('absent message directories allow an empty worker to complete', async t => {
  const { ctx, jobDir, paths } = fixture(t);
  const readdir = fs.readdirSync;
  let injected = false;
  const mock = t.mock.method(fs, 'readdirSync', function (directory, ...args) {
    if ([paths.inbox, paths.claimed].includes(String(directory)) && readJob(jobDir).attempts?.at(-1)?.state === 'completed') {
      injected = true;
      throw Object.assign(new Error('absent directory'), { code: 'ENOENT' });
    }
    return readdir.call(this, directory, ...args);
  });
  try { await runWorker(jobDir, { env: ctx.env }); } finally { mock.mock.restore(); }
  assert.equal(injected, true);
  assert.equal(readJob(jobDir).state, 'completed');
  assert.equal(readLease(jobDir), null);
});
