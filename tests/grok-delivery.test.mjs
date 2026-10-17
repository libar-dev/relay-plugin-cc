import test from "node:test";
import assert from "node:assert/strict";
import { postInboxMessage, readOutcome } from "../plugins/relay/scripts/lib/jobs/messages.mjs";
import { companion, finishJob, jobDir, readJob, setup, startJob, waitFor } from "./support/job-helpers.mjs";
import { installFakeGrok } from "./fakes/grok.mjs";
import { scriptedConnection } from "./support/backend-connection.mjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as tick } from "node:timers/promises";
import { grokEventRecorder } from "../plugins/relay/scripts/lib/backends/grok/connection.mjs";
import { grokSessionMessages } from "../plugins/relay/scripts/lib/backends/grok/history.mjs";
import { buildLaunchRequest } from "../plugins/relay/scripts/lib/jobs/request.mjs";

// Delivery receipts and persisted history
{

  // A steer is delivered exactly once, or reported as
  // not delivered. Grok's `queued` answer is not durable: only its persisted history makes a
  // steer `steered`, and after a death every open or requeued steer is checked against that
  // history before anything is sent.

  const HEADER = "backend: grok\nmodel: exact-model\neffort: high";

  function fixture(t, options) {
    const ctx = setup(t);
    const fake = installFakeGrok(ctx.bin, options);
    ctx.env.GROK_BINARY = fake.binary;
    ctx.grok = fake.state;
    return ctx;
  }

  // Copies Grok holds: interjections it kept in a turn, and prompts run with the text.
  function copies(ctx, text) {
    const state = ctx.grok();
    const held = Object.values(state.sessions).flat().flatMap(turn => turn.steers).filter(entry => entry === text).length;
    const replayed = state.turns.filter(turn => turn.text === text).length;
    return { held, replayed };
  }

  const actions = (ctx, id, messageId) => (readJob(ctx, id).messages ?? []).filter(entry => entry.id === messageId).map(entry => entry.action);

  async function steerRunning(ctx, text) {
    const { id } = startJob(ctx, HEADER, "Initial task");
    const dir = jobDir(ctx, id);
    await waitFor(() => readJob(ctx, id).turnId);
    const message = postInboxMessage(dir, { kind: "steer", text });
    const first = await waitFor(() => readOutcome(dir, message.id));
    return { id, dir, message, first };
  }

  for (const death of ["server", "worker"]) {
    test(`a queued steer Grok never persisted runs once after a ${death} death, never closed as steered`, async t => {
      const ctx = fixture(t, { turnMs: 1000, interjectNotHeld: true });
      const { id, dir, message, first } = await steerRunning(ctx, "[quick] Required follow-up");
      assert.notEqual(first.action, "steered", "a queued answer alone is not delivery");
      assert.equal(ctx.grok().interjections.length, 1);
      if (death === "server") {
        process.kill(readJob(ctx, id).serverPid, "SIGKILL");
      } else {
        process.kill(readJob(ctx, id).worker.pid, "SIGKILL");
        await waitFor(() => companion(ctx, ["status", id]).stdout.includes("state: dead"));
        assert.equal(companion(ctx, ["resume", id]).status, 0);
      }
      const end = await finishJob(ctx, id);
      assert.deepEqual(copies(ctx, message.text), { held: 0, replayed: 1 });
      assert.equal(readOutcome(dir, message.id).action, "turn-started");
      assert.ok(!actions(ctx, id, message.id).includes("steered"));
      assert.doesNotMatch(end.stdout, /undelivered:|dropped:/);
      assert.equal(readJob(ctx, id).state, "completed");
    });
  }

  test("a server death after Grok persisted a steer but before its reply delivers it once, with no second send", async t => {
    const ctx = fixture(t, { turnMs: 1000, interjectDelayMs: 30000 });
    const { id } = startJob(ctx, HEADER, "Initial task");
    const dir = jobDir(ctx, id);
    await waitFor(() => readJob(ctx, id).turnId);
    const message = postInboxMessage(dir, { kind: "steer", text: "[quick] Append once" });
    await waitFor(() => {
      const job = readJob(ctx, id);
      return grokSessionMessages(job.request, job.sessionId).some(entry => entry.method === "_x.ai/interject" && entry.text === message.text);
    });
    process.kill(readJob(ctx, id).serverPid, "SIGKILL");
    await finishJob(ctx, id);
    assert.deepEqual(copies(ctx, message.text), { held: 1, replayed: 0 });
    assert.equal(ctx.grok().interjections.length, 1);
    assert.equal(readOutcome(dir, message.id).action, "delivered-before");
    assert.equal(readJob(ctx, id).state, "completed");
  });

  test("with no death, a queued steer Grok never persisted runs as the next turn, once", async t => {
    const ctx = fixture(t, { turnMs: 600, interjectNotHeld: true });
    const { id, dir, message, first } = await steerRunning(ctx, "[quick] Follow-up");
    assert.equal(first.action, "interject-queued");
    await finishJob(ctx, id);
    assert.deepEqual(copies(ctx, message.text), { held: 0, replayed: 1 });
    assert.equal(readOutcome(dir, message.id).action, "turn-started");
    assert.ok(!actions(ctx, id, message.id).includes("steered"));
  });

  for (const requested of [false, true]) {
    test(`${requested ? 'requested' : 'spontaneous'} cancellation with a non-empty queue settles an unconfirmed steer`, async t => {
      const ctx = fixture(t, {
        turnMs: requested ? 30000 : 1500, stopReason: 'cancelled',
        interjectNotHeld: true, cancelWithQueuedEntries: true
      });
      const { id, dir, message, first } = await steerRunning(ctx, "[quick] Required after cancellation");
      assert.equal(first.action, "interject-queued");
      if (requested) {
        const result = companion(ctx, ["cancel", id]);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.doesNotMatch(result.stdout, /killed the worker/);
      }
      await finishJob(ctx, id, requested ? 5 : 3);
      const job = readJob(ctx, id);
      assert.equal(job.state, requested ? "cancelled" : "failed");
      assert.equal(job.errorMessage, requested ? "Cancelled." : "The turn was interrupted.");
      assert.deepEqual(job.attempts.map(attempt => attempt.state), requested ? ["cancelled"] : ["failed", "failed"]);
      assert.deepEqual(copies(ctx, message.text), { held: 0, replayed: requested ? 0 : 1 });
      assert.equal(readOutcome(dir, message.id).action, requested ? "dropped" : "turn-started");
      assert.ok(!actions(ctx, id, message.id).includes("steered"));
      assert.equal(ctx.grok().interjections.length, 1);
    });
  }

  test("a queued steer becomes steered once Grok's history shows it, and is sent once", async t => {
    const ctx = fixture(t, { turnMs: 1500, persistAfterReplyMs: 400 });
    const { id, dir, message, first } = await steerRunning(ctx, "Late persistence");
    assert.equal(first.action, "interject-queued");
    await waitFor(() => readOutcome(dir, message.id)?.action === "steered");
    // Promoted while its turn still runs, not at the turn's end.
    assert.equal((ctx.grok().completed ?? []).length, 0);
    await finishJob(ctx, id);
    assert.deepEqual(copies(ctx, message.text), { held: 1, replayed: 0 });
    assert.deepEqual(actions(ctx, id, message.id), ["interject-queued", "steered"]);
    assert.equal(readJob(ctx, id).attempts.length, 1);
  });
}

// Identical interjections and settlement
{

  // Each persisted copy confirms at most one
  // steer. Identical open steers are confirmed in the order they were sent, one per copy beyond
  // what the history held before the first of them; the resumed-history check after a death
  // counts the same way, and a steer never confirmed runs once as the next turn.

  const HEADER = "backend: grok\nmodel: default\neffort: default";
  const TEXT = "Append one more record";

  function fixture(t, options) {
    const ctx = setup(t);
    const fake = installFakeGrok(ctx.bin, options);
    ctx.env.GROK_BINARY = fake.binary;
    ctx.grok = fake.state;
    return ctx;
  }

  // Copies of the text Grok holds as interjections, and prompts it ran with the text.
  function copies(ctx) {
    const state = ctx.grok();
    return {
      held: Object.values(state.sessions).flat().flatMap(turn => turn.steers).filter(entry => entry === TEXT).length,
      replayed: state.turns.filter(turn => turn.text === TEXT).length
    };
  }

  for (const death of ["server", "worker"]) {
    test(`two identical steers queued before persistence: one copy confirms one, the other survives a ${death} death`, async t => {
      // The first interjection persists after 200 ms; the second not before the death.
      const ctx = fixture(t, { turnMs: 2500, persistAfterReplyMs: [200, 30000] });
      const { id } = startJob(ctx, HEADER, "Initial task");
      const dir = jobDir(ctx, id);
      await waitFor(() => readJob(ctx, id).turnId);
      // Two messages posted together are sent in inbox order: the first sent takes the copy.
      const posted = [postInboxMessage(dir, { kind: "steer", text: TEXT }), postInboxMessage(dir, { kind: "steer", text: TEXT })];
      await waitFor(() => posted.every(message => readOutcome(dir, message.id)) && posted.some(message => readOutcome(dir, message.id).action === "steered"));
      const [a, b] = readOutcome(dir, posted[0].id).action === "steered" ? posted : [...posted].reverse();
      const before = readJob(ctx, id);
      assert.equal(readOutcome(dir, b.id).action, "interject-queued", "one persisted copy confirmed both steers");
      assert.deepEqual([a.id, b.id].map(messageId => before.backendState.deliveries[messageId].heldBefore), [0, 1]);
      if (death === "server") {
        process.kill(before.serverPid, "SIGKILL");
      } else {
        process.kill(before.worker.pid, "SIGKILL");
        await waitFor(() => companion(ctx, ["status", id]).stdout.includes("state: dead"));
        assert.equal(companion(ctx, ["resume", id]).status, 0);
      }
      const end = await finishJob(ctx, id);
      assert.deepEqual(copies(ctx), { held: 1, replayed: 1 });
      assert.equal(readOutcome(dir, a.id).action, "steered");
      assert.equal(readOutcome(dir, b.id).action, "turn-started");
      assert.doesNotMatch(end.stdout, /undelivered:|dropped:/);
    });
  }

  test("with no death, the second of two identical queued steers runs once as the next turn", async t => {
    // Both are answered queued before the first persists (after 200 ms); the second never does.
    const ctx = fixture(t, { turnMs: 1200, persistAfterReplyMs: [200], holdInterjections: 1 });
    const { id } = startJob(ctx, HEADER, "Initial task");
    const dir = jobDir(ctx, id);
    await waitFor(() => readJob(ctx, id).turnId);
    const posted = [postInboxMessage(dir, { kind: "steer", text: TEXT }), postInboxMessage(dir, { kind: "steer", text: TEXT })];
    await finishJob(ctx, id);
    assert.deepEqual(copies(ctx), { held: 1, replayed: 1 });
    assert.deepEqual(posted.map(message => readOutcome(dir, message.id).action).sort(), ["steered", "turn-started"]);
  });

  test("an intentional repeated steer stays open until the history holds a copy beyond its baseline", async t => {
    // Grok holds the first interjection only: the repeat is answered queued and never persisted.
    const ctx = fixture(t, { turnMs: 1500, holdInterjections: 1 });
    const { id } = startJob(ctx, HEADER, "Initial task");
    const dir = jobDir(ctx, id);
    await waitFor(() => readJob(ctx, id).turnId);
    const a = postInboxMessage(dir, { kind: "steer", text: TEXT });
    await waitFor(() => readOutcome(dir, a.id)?.action === "steered");
    const b = postInboxMessage(dir, { kind: "steer", text: TEXT });
    const first = await waitFor(() => readOutcome(dir, b.id));
    assert.equal(first.action, "interject-queued", "an older identical copy confirmed the repeat");
    assert.equal(readJob(ctx, id).backendState.deliveries[b.id].heldBefore, 1);
    await finishJob(ctx, id);
    assert.deepEqual(copies(ctx), { held: 1, replayed: 1 });
    assert.equal(readOutcome(dir, b.id).action, "turn-started");
  });

  test("identical open interjections take successive copies; one ruled out or confirmed moves the count", async () => {
    const connection = await scriptedConnection("grok", {}, { cwd: "/nonexistent", grokHome: "/nonexistent" }, { env: {}, state: {}, saveState() {}, tap() {} });
    connection.sessionId = "s";
    const send = clientId => connection.prepareDelivery({ clientId, source: "steer", prompt: TEXT }, "_x.ai/interject");
    const [a, b, c] = [send("a"), send("b"), send("c")];
    assert.deepEqual([a, b, c].map(entry => entry.heldBefore), [0, 1, 2]);
    // A refused (never held): the later identical ones move down a place.
    assert.deepEqual(connection.settle(a, false), [a, b, c]);
    assert.deepEqual([b, c].map(entry => entry.heldBefore), [0, 1]);
    // B confirmed: C keeps its place, and the next one comes after C.
    assert.deepEqual(connection.settle(b, true), []);
    assert.equal(send("d").heldBefore, 2);
    // A different text is counted on its own.
    assert.equal(connection.prepareDelivery({ clientId: "e", source: "steer", prompt: "Other" }, "_x.ai/interject").heldBefore, 0);
  });

  test("final settlement saves the counts it adjusts for later identical steers", async t => {
    // Keep confirmation at final settlement, and make the first history check miss
    // the copy. The next check sees it, after the later counts have moved down.
    const ctx = fixture(t, { turnMs: 1200, persistAfterReplyMs: [30000, 30000, 200] });
    const preload = path.join(ctx.root, "final-confirmation.mjs");
    fs.writeFileSync(preload, `
      import { grokBackend } from ${JSON.stringify(new URL('../plugins/relay/scripts/lib/backends/grok/index.mjs', import.meta.url).href)};
      const connect = grokBackend.connect;
      grokBackend.connect = async (...args) => {
      const connection = await connect(...args);
      const prototype = Object.getPrototypeOf(connection);
      const prepare = prototype.prepareDelivery, held = prototype.held;
      const ids = [];
      prototype.prepareDelivery = function(item, method) {
        if (method === '_x.ai/interject') ids.push(item.clientId);
        return prepare.call(this, item, method);
      };
      prototype.held = function(delivery) {
        if (delivery.id === ids[0] || this.running || this.promptPending) return false;
        return held.call(this, delivery);
      };
      return connection;
      };
    `);
    ctx.env.NODE_OPTIONS = `${ctx.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`;
    const { id } = startJob(ctx, HEADER, "Initial task");
    const dir = jobDir(ctx, id);
    await waitFor(() => readJob(ctx, id).turnId);
    const posted = Array.from({ length: 3 }, () => postInboxMessage(dir, { kind: "steer", text: TEXT }));
    await waitFor(() => posted.every(message => readOutcome(dir, message.id)?.action === 'interject-queued'));
    await finishJob(ctx, id);
    const held = posted.filter(message => readOutcome(dir, message.id)?.action === 'steered');
    assert.equal(held.length, 1);
    assert.equal(readJob(ctx, id).backendState.deliveries[held[0].id].heldBefore, 0);
  });
}

// Refused interjections
{

  const TEXT = 'Append one more record';
  for (const death of ['server', 'worker']) {
    test(`Grok: a refused steer cannot borrow an identical held steer after ${death} death`, async t => {
      const ctx = setup(t);
      const fake = installFakeGrok(ctx.bin, { turnMs: 1500 });
      ctx.env.GROK_BINARY = fake.binary;
      const source = fs.readFileSync(fake.binary, 'utf8');
      const needle = "case '_x.ai/interject':";
      assert.equal(source.split(needle).length, 2);
      fs.writeFileSync(fake.binary, source.replace(needle, needle + `
        if (!state.refusedFirst) { state.refusedFirst = true; save(); error('interjection refused'); break; }
      `));
      const { id } = startJob(ctx, 'backend: grok\nmodel: default\neffort: default', 'Initial task');
      const dir = jobDir(ctx, id);
      await waitFor(() => readJob(ctx, id).turnId);
      const a = postInboxMessage(dir, { kind: 'steer', text: TEXT });
      await waitFor(() => readOutcome(dir, a.id)?.action === 'queued-next-turn');
      const b = postInboxMessage(dir, { kind: 'steer', text: TEXT });
      await waitFor(() => readOutcome(dir, b.id)?.action === 'steered');
      const before = readJob(ctx, id);
      const confirmation = await scriptedConnection("grok", {}, before.request, { env: {}, state: before.backendState, saveState() {}, tap() {} });
      confirmation.sessionId = before.sessionId;
      assert.equal(confirmation.held(before.backendState.deliveries[a.id]), false,
        "confirmation credited B's persisted copy to refused A");
      assert.equal(confirmation.held(before.backendState.deliveries[b.id]), true);
      if (death === 'server') {
        process.kill(before.serverPid, 'SIGKILL');
      } else {
        process.kill(before.worker.pid, 'SIGKILL');
        await waitFor(() => companion(ctx, ['status', id]).stdout.includes('state: dead'));
        assert.equal(companion(ctx, ['resume', id]).status, 0);
      }
      const end = await finishJob(ctx, id);
      const state = fake.state();
      assert.equal(Object.values(state.sessions).flat().flatMap(turn => turn.steers).filter(text => text === TEXT).length, 1);
      assert.equal(state.turns.filter(turn => turn.text === TEXT).length, 1);
      assert.equal(readOutcome(dir, a.id).action, 'turn-started');
      assert.equal(readOutcome(dir, b.id).action, 'steered');
      assert.equal(readJob(ctx, id).state, 'completed');
      assert.doesNotMatch(end.stdout, /undelivered:|dropped:/);
    });
  }
}

// Recovery and protocol ordering
{

  const HEADER = 'backend: grok\nmodel: exact-model\neffort: exact-effort';
  function fixture(t, options = {}) {
    const ctx = setup(t);
    const fake = installFakeGrok(ctx.bin, options);
    ctx.env.GROK_BINARY = fake.binary;
    ctx.grok = fake.state;
    return ctx;
  }
  const report = (ctx, id) => fs.readFileSync(path.join(jobDir(ctx, id), 'report.md'), 'utf8');
  const events = (ctx, id) => fs.readFileSync(path.join(jobDir(ctx, id), 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const deliveryCount = (ctx, text) => ctx.grok().turns.filter(turn => turn.text === text).length + (ctx.grok().interjections ?? []).filter(turn => turn.text === text).length;

  // Fault injection stops the actual worker at an atomic publication boundary. It never
  // writes job.json or fabricates a delivery receipt. Recovery runs without the armed fault.
  function armPublicationFault(ctx, action) {
    const armed = path.join(ctx.root, 'armed.json');
    const marker = path.join(ctx.root, 'killed.json');
    const preload = path.join(ctx.root, 'publication-fault.mjs');
    fs.writeFileSync(preload, `
      import fs from 'node:fs';
      const armed = ${JSON.stringify(armed)}, marker = ${JSON.stringify(marker)};
      const rename = fs.renameSync;
      fs.renameSync = function(from, to) {
        if (process.argv.includes('worker') && fs.existsSync(armed)) {
          const action = JSON.parse(fs.readFileSync(armed, 'utf8')).action;
          let value; try { value = JSON.parse(fs.readFileSync(from, 'utf8')); } catch {}
          if ((action === 'brief' && String(to).endsWith('/job.json') && value?.state === 'running' && value.pendingFirstTurn === false) ||
              (String(to).includes('/inbox/outcomes/') && value?.action === action)) {
            fs.unlinkSync(armed); fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, value }));
            process.kill(process.pid, 'SIGKILL');
          }
        }
        return rename.apply(this, arguments);
      };
    `);
    ctx.env.NODE_OPTIONS = `${ctx.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`;
    fs.writeFileSync(armed, JSON.stringify({ action }));
    return marker;
  }

  for (const source of ['brief', 'continue', 'steer']) {
    for (const boundary of ['before-id-or-reply', 'before-outcome']) {
      test(`delivery ${source} survives worker death ${boundary}, once`, async t => {
        const options = { turnMs: source === 'continue' && boundary === 'before-outcome' ? 4000 : 30000, splitReplay: true,
          ...(boundary === 'before-id-or-reply' && source !== 'steer' ? { noQueueId: true } : {}),
          ...(boundary === 'before-id-or-reply' && source === 'steer' ? { interjectDelayMs: 30000 } : {}) };
        const ctx = fixture(t, options);
        let marker;
        if (boundary === 'before-outcome') marker = armPublicationFault(ctx, source === 'brief' ? 'brief' : source === 'continue' ? 'turn-started' : 'steered');
        const text = `Delivered ${source}, exactly once.\n`;
        const { id } = startJob(ctx, HEADER, source === 'brief' ? text : source === 'continue' ? '[quick] Initial.' : 'Long first turn.');
        let messageId = `brief-${id}`;
        if (source === 'continue') {
          await finishJob(ctx, id);
          // Start a second worker through the real command; no response id has been invented.
          const result = companion(ctx, ['continue', id, '--message', text], { RELAY_JOBS_POLL_MS: '1000' });
          assert.equal(result.status, 0, result.stderr + result.stdout);
          messageId = /^message: continue (.+)$/m.exec(result.stdout)[1];
        } else if (source === 'steer') {
          await waitFor(() => readJob(ctx, id).turnId);
          messageId = postInboxMessage(jobDir(ctx, id), { kind: 'steer', text }).id;
        }
        await waitFor(() => deliveryCount(ctx, text) === 1);
        if (marker) await waitFor(() => fs.existsSync(marker));
        const before = readJob(ctx, id);
        const record = before.backendState.deliveries?.[messageId];
        assert.ok(record, 'production persisted the record before sending');
        assert.equal(record.id, messageId); assert.equal(record.kind, source); assert.equal(record.text, text);
        assert.equal(record.method, source === 'steer' ? '_x.ai/interject' : 'session/prompt');
        assert.equal(record.sessionId, before.sessionId);
        if (boundary === 'before-outcome') {
          assert.ok(before.backendState.promptIds[messageId], 'production saved the real prompt id');
          const actual = source === 'steer' ? ctx.grok().interjections[0].promptId : ctx.grok().turns.find(turn => turn.text === text).id;
          assert.equal(before.backendState.promptIds[messageId], actual);
        } else {
          if (source !== 'steer') assert.equal(before.backendState.promptIds?.[messageId], undefined);
          process.kill(before.worker.pid, 'SIGKILL');
        }
        if (source === 'continue' && boundary === 'before-outcome') {
          // continue waits for a receipt and can restart the killed consumer itself.
          // The receipt and completed job survive even when the caller misses its death.
          await finishJob(ctx, id);
          assert.equal(readOutcome(jobDir(ctx, id), messageId).action, 'delivered-before');
          assert.equal(readJob(ctx, id).state, 'completed');
        } else {
          await waitFor(() => companion(ctx, ['status', id]).stdout.includes('state: dead'));
        }
        assert.equal(companion(ctx, ['resume', id, '--message', '[quick] Recover.']).status, 0);
        await finishJob(ctx, id);
        const after = readJob(ctx, id);
        assert.equal(after.sessionId, before.sessionId);
        assert.equal(deliveryCount(ctx, text), 1, 'the interjection is delivered exactly once');
        assert.equal(after.pendingFirstTurn, false);
        if (source !== 'brief') assert.equal(readOutcome(jobDir(ctx, id), messageId).action, 'delivered-before');
        assert.ok(ctx.grok().requests.some(r => r.method === 'session/load'));
        assert.match(report(ctx, id), /Recover/);
      });
    }
  }

  test('a queued acknowledgement without held text is delivered on recovery', async t => {
    const ctx = fixture(t, { turnMs: 30000, interjectNotHeld: true });
    // A queued answer without held text is published open, never as `steered`.
    const marker = armPublicationFault(ctx, 'interject-queued');
    const { id } = startJob(ctx, HEADER, 'Long first turn.');
    await waitFor(() => readJob(ctx, id).turnId);
    const text = '[quick] Accepted but not persisted.\n';
    const message = postInboxMessage(jobDir(ctx, id), { kind: 'steer', text });
    await waitFor(() => fs.existsSync(marker));
    const before = readJob(ctx, id);
    assert.equal(before.backendState.deliveries[message.id].method, '_x.ai/interject');
    assert.ok(before.backendState.promptIds[message.id], 'even an acknowledged prompt id does not prove held text');
    assert.equal(companion(ctx, ['resume', id, '--message', '[quick] Recover.']).status, 0);
    await finishJob(ctx, id);
    assert.equal(ctx.grok().interjections.filter(entry => entry.text === text).length, 1);
    assert.equal(ctx.grok().turns.filter(entry => entry.text === text).length, 1);
    assert.equal(readOutcome(jobDir(ctx, id), message.id).action, 'turn-started');
    assert.equal(readJob(ctx, id).backendState.deliveries[message.id].method, 'session/prompt');
  });

  test('automatic transport recovery deduplicates a sent brief without a prompt id', async t => {
    const ctx = fixture(t, { dieBeforeId: true, turnMs: 60, splitReplay: true });
    const text = 'Brief delivered before transport death.\n';
    const { id } = startJob(ctx, HEADER, text);
    await finishJob(ctx, id);
    assert.equal(deliveryCount(ctx, text), 1);
    const job = readJob(ctx, id);
    assert.equal(job.pendingFirstTurn, false);
    assert.equal(job.automaticResumes.length, 1);
    assert.equal(job.backendState.deliveries[`brief-${id}`].text, text);
    assert.equal(companion(ctx, ['continue', id, '--message', '[quick] Another.']).status, 0);
    await finishJob(ctx, id);
    assert.equal(deliveryCount(ctx, text), 1);
  });

  test('a never-sent message and an intentional repeated continuation both run', async t => {
    const ctx = fixture(t, { turnMs: 30000 });
    const text = '[quick] Repeated request.\n';
    const { id } = startJob(ctx, HEADER, text);
    await finishJob(ctx, id);
    assert.equal(companion(ctx, ['continue', id, '--message', text]).status, 0);
    await finishJob(ctx, id);
    assert.equal(deliveryCount(ctx, text), 2);
    const next = 'Long turn before a queued continuation.';
    companion(ctx, ['continue', id, '--message', next]);
    await waitFor(() => readJob(ctx, id).state === 'running');
    const msg = postInboxMessage(jobDir(ctx, id), { kind: 'continue', text: '[quick] Never sent.' });
    await waitFor(() => readOutcome(jobDir(ctx, id), msg.id)?.action === 'queued-next-turn');
    const before = readJob(ctx, id);
    assert.equal(before.backendState.deliveries[msg.id], undefined);
    process.kill(before.worker.pid, 'SIGKILL');
    await waitFor(() => companion(ctx, ['status', id]).stdout.includes('state: dead'));
    companion(ctx, ['resume', id, '--message', '[quick] Recover.']);
    await finishJob(ctx, id);
    assert.equal(deliveryCount(ctx, '[quick] Never sent.'), 1);
  });

  const connections = new WeakMap();
  async function connectionOf(client, request = { cwd: '/nonexistent', grokHome: '/nonexistent', model: null, effort: null }) {
    if (!connections.has(client)) {
      const connection = await scriptedConnection("grok", client, request, { env: {}, state: {}, saveState() {}, tap() {} });
      connection.sessionId = 's';
      connections.set(client, connection);
    }
    return connections.get(client);
  }
  function protocolClient() {
    let resolvePrompt;
    let resolveSteer;
    const client = {
      requests: [],
      exitPromise: new Promise(() => {}),
      setNotificationHandler(handler) { this.handler = handler; },
      emit(method, params) { this.handler?.({ method, params: { sessionId: 's', ...params } }); },
      update(update, sessionId = 's') { this.emit('session/update', { sessionId, update }); },
      request(method, params) {
        this.requests.push({ method, params });
        if (method === 'session/prompt') return new Promise(resolve => { resolvePrompt = resolve; });
        if (method === '_x.ai/interject') return new Promise(resolve => { resolveSteer = resolve; });
        return Promise.resolve({});
      },
      respond(value = { stopReason: 'end_turn', _meta: { promptId: 'ours' } }) { resolvePrompt(value); },
      acceptSteer() { resolveSteer({ result: { status: 'queued' } }); },
      notify(method, params) { this.requests.push({ method, params, notification: true }); }
    };
    return client;
  }
  const queue = (client, id, text, extra = {}) => client.emit('_x.ai/queue/changed', { entries: [], ...(id ? { runningPromptId: id, runningKind: 'prompt', runningText: text } : {}), ...extra });
  const chunk = (client, text, sessionId) => client.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, sessionId);
  const complete = (client, id = 'ours', sessionId = 's') => client.update({ sessionUpdate: 'turn_completed', prompt_id: id, stop_reason: 'end_turn' }, sessionId);

  test('replay joins user chunks across unrelated notifications and classifies wrappers at either boundary', async t => {
    const ctx = fixture(t);
    const wrap = text => `The user sent a message while you were working:\n<user_query>\n ${text} \n</user_query>\nFinish the task.`;
    for (const lastBoundary of [true, false]) {
      const client = protocolClient();
      client.request = async (method) => {
        if (method !== 'session/load') return {};
        const user = (text, index) => client.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { promptIndex: index } });
        user('hel', 0); queue(client, null); user('lo', 0);
        user(wrap('first'), 1); complete(client, 'previous');
        user(wrap('last'), 2);
        if (lastBoundary) complete(client, 'previous-2');
        return {};
      };
      const opened = await connectionOf(client, { cwd: ctx.work, grokHome: ctx.user, model: null, effort: null });
      await opened.open({ sessionId: 's', sessionUsed: false, sessionName: null });
      assert.deepEqual(opened.replay.messages, [
        { method: 'session/prompt', text: 'hello' },
        { method: '_x.ai/interject', text: 'first' },
        { method: '_x.ai/interject', text: 'last' }
      ]);
    }
  });

  test('foreign-session replay is no evidence, and another session\'s delivery record never deduplicates', async t => {
    const ctx = fixture(t);
    const request = { cwd: ctx.work, grokHome: ctx.user, model: null, effort: null };
    const openWith = async sessionId => {
      const client = protocolClient();
      client.request = async method => {
        if (method !== 'session/load') return {};
        client.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Shared text.' }, _meta: { promptIndex: 0 } }, sessionId);
        complete(client, 'previous', sessionId);
        return {};
      };
      const connection = await connectionOf(client, request);
      await connection.open({ sessionId: 's', sessionUsed: false, sessionName: null });
      return connection;
    };
    const item = { clientId: 'm1', recoveryCandidate: true };
    const record = sessionId => ({ deliveries: { m1: { id: 'm1', method: 'session/prompt', text: 'Shared text.', heldBefore: 0, sessionId } } });
    const foreign = await openWith('other');
    assert.deepEqual(foreign.replay.messages, []);
    foreign.state = record('s');
    assert.equal(foreign.delivered(item), false);
    const ours = await openWith('s');
    assert.deepEqual(ours.replay.messages, [{ method: 'session/prompt', text: 'Shared text.' }]);
    ours.state = record('s');
    assert.equal(ours.delivered(item), true);
    ours.state = record('other');
    assert.equal(ours.delivered(item), false);
  });

  test('replayed user messages identified only by the notification prompt id stay separate across unrelated notifications', async t => {
    const ctx = fixture(t);
    const client = protocolClient();
    client.request = async method => {
      if (method !== 'session/load') return {};
      const user = (text, promptId) => client.emit('session/update', { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }, _meta: { promptId } });
      user('first ', 'p1'); queue(client, null); user('message', 'p1');
      user('second', 'p2'); queue(client, null);
      user('third', 'p3');
      return {};
    };
    const opened = await connectionOf(client, { cwd: ctx.work, grokHome: ctx.user, model: null, effort: null });
    await opened.open({ sessionId: 's', sessionUsed: false, sessionName: null });
    assert.deepEqual(opened.replay.messages.map(message => message.text), ['first message', 'second', 'third']);
  });

  test('an unfinished final history record is no evidence, and an unreadable history fails', t => {
    const ctx = fixture(t);
    const request = { cwd: ctx.work, grokHome: ctx.user };
    const dir = path.join(ctx.user, 'sessions', encodeURIComponent(ctx.work), 'session-1');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'chat_history.jsonl');
    const record = JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\nHeld?\n</user_query>' }], prompt_index: 0 });
    fs.writeFileSync(file, record);
    assert.deepEqual(grokSessionMessages(request, 'session-1'), []);
    fs.appendFileSync(file, '\n');
    assert.deepEqual(grokSessionMessages(request, 'session-1'), [{ method: 'session/prompt', text: 'Held?' }]);
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.throws(() => grokSessionMessages(request, 'session-1'), error => error.code === 'EISDIR');
  });

  test('turn identification trims only its comparison, excludes old ids and unrelated kinds/text, and falls back to response', async () => {
    for (const responseOnly of [false, true]) {
      const client = protocolClient(); const ids = [];
      (await connectionOf(client)).state.promptIds = { previous: 'old' };
      const run = (await connectionOf(client)).run({ clientId: 'main', source: 'brief', onPending() {}, prompt: 'exact brief\n', onTurnId: id => ids.push(id) });
      assert.equal(client.requests[0].params.prompt[0].text, 'exact brief\n');
      if (!responseOnly) {
        for (const [id, text, kind] of [['old', 'exact brief', 'prompt'], ['unrelated', 'other text', 'prompt'], ['interjection', 'exact brief', 'interjection']]) {
          queue(client, id, text, { runningKind: kind }); complete(client, id);
          assert.deepEqual(ids, []);
        }
        queue(client, 'ours', 'exact brief'); assert.deepEqual(ids, ['ours']);
        complete(client); queue(client, null);
      }
      client.respond();
      assert.equal((await run).turnId, 'ours');
      assert.deepEqual(ids, ['ours']);
    }
  });

  test('idle steer is rejected without RPC, but pending prompts take controls before any id', async () => {
    const client = protocolClient();
    const idle = (await connectionOf(client)).steer(null, { id: 'idle', kind: 'steer', text: 'idle' });
    const rejection = assert.rejects(idle, /no turn is running/);
    await tick();
    assert.equal(client.requests.length, 0, 'an idle steer must make no RPC');
    await rejection;
    const run = (await connectionOf(client)).run({ clientId: 'main', source: 'brief', onPending() {}, prompt: 'newline\n', onTurnId() {} });
    const steer = (await connectionOf(client)).steer(null, { id: 'running', kind: 'steer', text: 'running' });
    await (await connectionOf(client)).interrupt(null);
    assert.equal(client.requests[1].method, '_x.ai/interject');
    assert.deepEqual(client.requests[2], { method: 'session/cancel', params: { sessionId: 's' }, notification: true });
    client.acceptSteer(); await steer; client.respond({ stopReason: 'cancelled', _meta: { promptId: 'ours' } });
    assert.equal((await run).turnStatus, 'interrupted');
  });

  for (const idKnown of [false, true]) {
    for (const control of ['steer', 'cancel']) {
      test(`newline brief ${control} while id is ${idKnown ? 'known' : 'unknown'}`, async t => {
        const ctx = fixture(t, { turnMs: control === 'cancel' ? 30000 : 700, ...(control === 'steer' ? { steered: true } : {}), ...(idKnown ? {} : { noQueueId: true }) });
        const { id } = startJob(ctx, HEADER, 'Newline brief.\n');
        await waitFor(() => ctx.grok().turns.length === 1 && readJob(ctx, id).state === 'running' && (!idKnown || readJob(ctx, id).turnId));
        assert.equal(Boolean(readJob(ctx, id).turnId), idKnown);
        const result = companion(ctx, [control, id, ...(control === 'steer' ? ['--message', 'Replacement.'] : [])]);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        await finishJob(ctx, id, control === 'cancel' ? 5 : 0);
        assert.ok(ctx.grok().requests.some(r => r.method === (control === 'steer' ? '_x.ai/interject' : 'session/cancel')));
        assert.equal(ctx.grok().turns.length, 1);
        if (control === 'steer') assert.match(report(ctx, id), /Replacement/);
      });
    }
  }

  test('prompt response waits for a delayed interjection reply and subsequent Grok work', async () => {
    const client = protocolClient(); let finished = false;
    const run = (await connectionOf(client)).run({ clientId: 'main', source: 'brief', onPending() {}, prompt: 'first', onTurnId() {} }).then(result => { finished = true; return result; });
    queue(client, 'ours', 'first');
    const steer = (await connectionOf(client)).steer('ours', { id: 'late', kind: 'steer', text: 'late' });
    chunk(client, 'first report'); queue(client, null); complete(client); client.respond();
    await tick(); assert.equal(finished, false, 'the unacknowledged steer still belongs to this capture');
    queue(client, 'followup', 'late'); client.acceptSteer(); await steer;
    chunk(client, 'last report'); complete(client, 'followup'); queue(client, null);
    assert.equal((await run).finalMessage, 'last report');
  });

  test('empty queue waits for completion on a later event-loop delivery', async () => {
    const client = protocolClient(); let finished = false;
    const run = (await connectionOf(client)).run({ clientId: 'main', source: 'brief', onPending() {}, prompt: 'first', onTurnId() {} }).then(result => { finished = true; return result; });
    queue(client, 'ours', 'first'); chunk(client, 'first report'); complete(client);
    queue(client, 'followup', 'second'); client.respond(); await tick();
    chunk(client, 'last report'); queue(client, null); await tick();
    assert.equal(finished, false);
    complete(client, 'followup');
    assert.equal((await run).finalMessage, 'last report');
  });

  test('foreign-session text, queue and completion cannot change this turn', async () => {
    const client = protocolClient(); const ids = [];
    const run = (await connectionOf(client)).run({ clientId: 'main', source: 'brief', onPending() {}, prompt: 'mine', onTurnId: id => ids.push(id) });
    queue(client, 'alien', 'mine', { sessionId: 'other' }); chunk(client, 'alien report', 'other'); complete(client, 'alien', 'other');
    assert.deepEqual(ids, []);
    queue(client, 'ours', 'mine'); chunk(client, 'our report'); complete(client); queue(client, null); client.respond();
    assert.deepEqual(await run, { turnId: 'ours', turnStatus: 'completed', finalMessage: 'our report', didWork: true });
  });

  for (const cancelWithQueuedEntries of [false, true]) {
    test(`spontaneous cancellation is failed with ${cancelWithQueuedEntries ? 'a non-empty' : 'an empty'} queue, without a requested cancel masking its status`, async t => {
      const ctx = fixture(t, { stopReason: 'cancelled', cancelWithQueuedEntries }); const { id } = startJob(ctx, HEADER);
      await finishJob(ctx, id, 3);
      assert.equal(readJob(ctx, id).state, 'failed');
      assert.equal(readJob(ctx, id).errorMessage, 'The turn was interrupted.');
    });
  }

  test('D exact capabilities, MCP arrays, config ids/values and default omission on new and load', async t => {
    for (const defaults of [false, true]) {
      const ctx = fixture(t); const header = defaults ? 'backend: grok\nmodel: default\neffort: default' : HEADER;
      const { id } = startJob(ctx, header); await finishJob(ctx, id);
      companion(ctx, ['continue', id, '--message', '[quick] Next.']); await finishJob(ctx, id);
      const requests = ctx.grok().requests;
      for (const req of requests.filter(r => r.method === 'initialize')) {
        assert.deepEqual(req.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
        assert.equal(req.params.protocolVersion, 1);
      }
      for (const method of ['session/new', 'session/load']) {
        const entries = requests.filter(r => r.method === method); assert.equal(entries.length, 1);
        assert.deepEqual(entries[0].params.mcpServers, []);
      }
      const config = requests.filter(r => r.method === 'session/set_config_option').map(r => [r.params.configId, r.params.value]);
      assert.deepEqual(config, defaults ? [] : [['model', 'exact-model'], ['reasoning_effort', 'exact-effort'], ['model', 'exact-model'], ['reasoning_effort', 'exact-effort']]);
    }
  });

  test('E unsupported request and rejection remain in events.jsonl with the exact RPC error', async t => {
    const ctx = fixture(t, { unsupported: true }); const { id } = startJob(ctx, HEADER); await finishJob(ctx, id);
    assert.deepEqual(ctx.grok().requests.find(r => r.id === 'unknown' && !r.method).error, { code: -32601, message: 'Unsupported server request: client/missing' });
    const log = events(ctx, id);
    assert.ok(log.some(e => e.method === 'grok/serverRequest' && e.params.id === 'unknown' && e.params.method === 'client/missing' && e.params.params.question === 'unhandled'));
    assert.ok(log.some(e => e.method === 'grok/serverRequestRejected' && e.params.id === 'unknown' && e.params.code === -32601 && e.params.message === 'Unsupported server request: client/missing'));
  });

  test('E interleaved kinds and non-text chunks retain one record per message at each boundary', () => {
    for (const boundary of ['response_completed', 'turn_completed', '_x.ai/session/prompt_complete', 'tool_call']) {
      const log = []; let touches = 0;
      const recorder = grokEventRecorder(e => log.push(e), () => touches++);
      const emit = (kind, content) => recorder.record({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: kind, content } } });
      emit('agent_thought_chunk', { type: 'text', text: 't1' }); emit('agent_message_chunk', { type: 'text', text: 'a1' });
      emit('agent_thought_chunk', { type: 'text', text: 't2' }); emit('agent_message_chunk', { type: 'text', text: 'a2' });
      emit('tool_call_delta_chunk', { type: 'resource_link', uri: 'file:///one' });
      emit('tool_call_delta_chunk', { type: 'resource_link', uri: 'file:///two' });
      if (boundary.startsWith('_')) recorder.record({ method: boundary, params: { sessionId: 's', promptId: 'p' } }); else emit(boundary);
      assert.equal(touches, 7); assert.equal(log.length, 4, boundary);
      assert.deepEqual(log.slice(0, 2).map(e => e.params.update.content.text), ['t1t2', 'a1a2']);
      assert.equal(log[2].params.update.content.uri, 'file:///one');
      assert.equal(log[2].params.update.chunks[0].content.uri, 'file:///two');
    }
  });

  test('E server death flushes partial chunk evidence', async t => {
    const ctx = fixture(t, { dieInitialize: true }); const { id } = startJob(ctx, HEADER);
    await finishJob(ctx, id, 3);
    assert.ok(events(ctx, id).some(e => e.params?.update?.content?.text === 'partial before death'));
  });

  test('F setup invokes models under its selected home, reports signed-out and failed version diagnostics', t => {
    for (const options of [{}, { signedOut: true }, { versionFail: true }]) {
      const ctx = fixture(t, options);
      const result = companion(ctx, ['setup', '--backend', 'grok', '--grok-home', 'jobs', '--json']);
      const output = JSON.parse(result.stdout);
      const [block] = output.backends;
      assert.equal(output.ready, !options.signedOut && !options.versionFail);
      assert.equal(result.status, output.ready ? 0 : 1);
      assert.deepEqual(ctx.grok().invocations.map(call => call.args).sort(), [['--version'], ['models']]);
      assert.equal(ctx.grok().invocations.find(call => call.args[0] === 'models').env.GROK_HOME, path.join(ctx.user, '.grok-jobs'));
      assert.equal(ctx.grok().requests.length, 0);
      if (options.signedOut) { assert.equal(block.signIn.state, 'signed-out'); assert.match(block.signIn.detail, /Not signed in/); }
      if (options.versionFail) {
        assert.match(block.error, /exit 9/); assert.match(block.error, /VERSION DENIED/);
        assert.match(companion(ctx, ['setup', '--backend', 'grok']).stdout, /exit 9[\s\S]*VERSION DENIED/);
      }
    }
  });

  test('G missing settings name Grok, invalid home is refused, and home/fast rendering is exact', async t => {
    const ctx = fixture(t);
    for (const field of ['model', 'effort']) {
      assert.throws(() => buildLaunchRequest({ backend: 'grok', model: 'default', effort: 'default', [field]: undefined }, { baseDir: ctx.work }), error => error.message.includes("Grok's own default") && !error.message.includes('Codex'));
    }
    assert.throws(() => buildLaunchRequest({ backend: 'grok', model: 'default', effort: 'default', grokHome: '../bad' }, { baseDir: ctx.work }), /grok-home must/);
    for (const home of [' default ', 'jobs']) {
      const brief = path.join(ctx.root, 'direct.md'); fs.writeFileSync(brief, '[quick] Home.');
      const result = companion(ctx, ['start', '--backend', 'grok', '--grok-home', home, '--model', 'default', '--effort', 'default', '--fast', '--brief-file', brief]);
      assert.equal(result.status, 0, result.stderr);
      const id = /^job: (.+)$/m.exec(result.stdout)[1]; await finishJob(ctx, id);
      const job = readJob(ctx, id);
      assert.equal(job.request.fast, false); assert.equal(job.request.grokHomeDefault, home.trim() === 'default');
      for (const block of [result.stdout, companion(ctx, ['result', id]).stdout, companion(ctx, ['result', id, '--state-only']).stdout]) {
        assert.equal(/^grok-home: /m.test(block), home === 'jobs');
        if (home === 'jobs') assert.match(block, new RegExp(`^grok-home: ${ctx.user}/.grok-jobs$`, 'm'));
        assert.doesNotMatch(block, /^tier: fast$/m); assert.match(block, /^note: .*grok-4.7-build-fast/m);
      }
    }
  });
}
