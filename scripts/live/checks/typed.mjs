import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeBackends, formatSeconds, hasMarker, inboxMessages, lastActiveAttempt, oneRelay,
  readJson, readJob, readTranscript, recordsFor, relayJob, requireBackend, requireVersion,
  scopeToRun, STEER_DELIVERY, textContent, transcriptCalls } from '../lib/evidence.mjs';
import { pane } from '../lib/terminal.mjs';
import { agentCalls, opening, waitRunning } from './steer-main.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const prefix = 'The user sent a new message while you were working:\n';
const suffix = '\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.';
export const typedLine = (runId, backend, line) => `typed ${line} for ${backend} in ${runId}`;
const companion = (ctx, args) => execFileSync(process.execPath,
  [path.join(ctx.pluginDir, 'scripts/companion.mjs'), ...args],
  { encoding: 'utf8', env: { ...process.env, RELAY_JOBS_HOME: ctx.jobsHome }, timeout: 100000 });

// Visits overlap the running jobs; the stagger allows time for delivery, hand-back and navigation.
const aSleepSeconds = (n, index) => 60 + 40 * n + 240 * index;

function humanText(entry) {
  if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command' && entry.attachment.origin?.kind === 'human') {
    return textContent(entry.attachment.prompt);
  }
  if (entry.type !== 'user' || entry.origin?.kind !== 'human') return null;
  const text = textContent(entry.message?.content);
  return entry.isMeta && text.startsWith(prefix) && text.endsWith(suffix) ? text.slice(prefix.length, -suffix.length) : text;
}

function agents(parsed, backend) {
  const spawns = parsed.spawns.filter(agent => agent.backend === backend);
  if (spawns.length !== 3) throw new Error(`Expected exactly three relays for ${backend}.`);
  return ['a', 'b', 'c'].map(scenario => oneRelay({ spawns: spawns.filter(agent => agent.name === `typed-${scenario}-${backend}`) }, backend, `typed-${scenario}`));
}

function runningAt(job, at, version) {
  // Later continuations are in the saved job too; the boundary belongs to its earlier attempt.
  return lastActiveAttempt({ ...job, attempts: job.attempts.filter(attempt => Date.parse(attempt.startedAt) < Date.parse(at)) }, at, version);
}

function notices(entries, agent) {
  const seen = new Set();
  return entries.filter(entry => !entry.isSidechain && ['user', 'attachment', 'queue-operation'].includes(entry.type)).flatMap(entry => {
    const text = textContent(entry.message?.content ?? entry.content ?? entry.attachment?.prompt);
    return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)]
      .filter(match => {
        if (!match[1].includes(`<task-id>${agent.agentId}</task-id>`) || seen.has(match[1])) return false;
        // The queue record and its delivered prompt describe the same notification.
        seen.add(match[1]); return true;
      })
      .map(match => ({ text: match[1], at: entry.timestamp }));
  });
}

function handback(loaded, agent, entries, after) {
  const { job, jobDir } = loaded;
  const file = path.join(jobDir, 'relay-handbacks.jsonl');
  const last = fs.existsSync(file) ? readTranscript(file).at(-1) : null;
  const attempt = job.attempts.at(-1);
  const notice = notices(entries, agent).filter(item => item.text.includes('<status>completed</status>')).at(-1);
  if (job.state !== 'completed' || attempt?.state !== 'completed' || last?.agentId !== agent.agentId ||
      last.state !== job.state || last.attempts !== job.attempts.length ||
      !(Date.parse(last.at) >= Date.parse(after)) || !(Date.parse(last.at) >= Date.parse(attempt.endedAt)) ||
      !(Date.parse(notice?.at) >= Date.parse(last.at))) throw new Error(`Missing completed hand-back for ${agent.name}.`);
  const result = notice.text.match(/<result>([\s\S]*?)<\/result>/)?.[1];
  const report = fs.readFileSync(path.join(jobDir, 'report.md'), 'utf8');
  const split = result?.indexOf('\n---\n') ?? -1;
  const header = split < 0 ? '' : result.slice(0, split);
  if (!header.split('\n').includes(`job: ${job.id}`) || !header.split('\n').includes('state: completed') ||
      !header.split('\n').includes(`attempts: ${job.attempts.length}`) ||
      result.slice(split + 5).replace(/\n$/, '') !== report.replace(/\n$/, '')) {
    throw new Error(`Last hand-back is not the job result for ${agent.name}.`);
  }
  return last;
}

function interruptedRedirect(entries, entry, receipt) {
  if (entry.type !== 'user' || entry.origin?.kind !== 'human') throw new Error('C1 was not a resuming human user entry.');
  const before = entries.slice(0, entries.indexOf(entry));
  const note = before.findLastIndex(row => row.type === 'user' &&
    textContent(row.message?.content) === '[Request interrupted by user for tool use]');
  const rejected = before.slice(0, note).findLast(row => row.type === 'user' &&
    Array.isArray(row.message?.content) && row.message.content.some(block => block.type === 'tool_result' &&
      block.is_error && (row.toolDenialKind === 'user-rejected' || /tool use was rejected/.test(textContent(block.content))) &&
      before.slice(0, before.indexOf(row)).some(call => call.type === 'assistant' &&
        Array.isArray(call.message?.content) && call.message.content.some(tool => tool.type === 'tool_use' &&
          tool.id === block.tool_use_id && /companion\.mjs["']?\s+wait(?:\s|$)/.test(tool.input?.command ?? '')))));
  if (note < 0 || !rejected || !(Date.parse(rejected.timestamp) <= Date.parse(before[note].timestamp)) ||
      !(Date.parse(before[note].timestamp) < Date.parse(receipt.sentAt)) ||
      !(Date.parse(receipt.sentAt) <= Date.parse(entry.timestamp))) {
    throw new Error('C1 lacks an interrupted wait before its typing receipt and resuming entry.');
  }
  if (before.slice(note + 1).some(row => row.type === 'assistant')) {
    throw new Error('C1 did not resume the relay: an assistant entry followed the interrupt before C1.');
  }
}

function delivery(input, loaded, receipt, line, backend) {
  const { job, jobDir } = loaded;
  const text = typedLine(input.runId, backend, line);
  if (receipt?.text !== text || !Number.isFinite(Date.parse(receipt.sentAt))) throw new Error(`Missing typing receipt for ${line}.`);
  const entries = readTranscript(path.resolve(input.jobsHome, job.relay.transcriptPath));
  const matches = entries.filter(entry => humanText(entry) === text);
  if (matches.length !== 1 || !matches[0].uuid) throw new Error(`Expected exactly one human transcript entry for ${line}.`);
  if (line === 'C1') interruptedRedirect(entries, matches[0], receipt);
  const uuid = matches[0].uuid;
  const ledger = recordsFor(jobDir).filter(record => path.basename(record.file, '.json') === uuid || record.message === text);
  if (ledger.length !== 1 || path.basename(ledger[0].file, '.json') !== uuid) throw new Error(`Expected exactly one ledger record for ${line}.`);
  const record = ledger[0];
  if (record.status !== 'done' || !['continue', 'steer'].includes(record.kind)) throw new Error(`Incomplete delivery for ${line}.`);
  const messages = inboxMessages(jobDir).filter(message => message.text === text || message.id === record.messageId || message.relayUuid === uuid);
  if (messages.length !== 1 || messages[0].text !== text || messages[0].id !== record.messageId ||
      messages[0].relayUuid !== uuid || messages[0].kind !== record.kind) throw new Error(`Inbox does not carry ${line} exactly once.`);
  const start = line === 'B1' ? receipt.wakeAt : receipt.sentAt;
  const seconds = (Date.parse(record.at) - Date.parse(start)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0 || !(Date.parse(record.at) >= Date.parse(receipt.sentAt)) ||
      !(Date.parse(record.postedAt) >= Date.parse(record.at))) throw new Error(`Invalid ledger timing for ${line}.`);
  if (line !== 'A2') runningAt(job, receipt.sentAt, input.relayVersion);
  if (line === 'A2' && record.kind !== 'continue') throw new Error('A2 was not a continue.');
  if (line === 'B1' && (record.kind !== 'steer' || receipt.assistance !== 'manual-wake' ||
      !(Date.parse(receipt.wakeAt) >= Date.parse(receipt.sentAt)))) throw new Error('B1 was not an assisted steer.');
  if (line === 'C1' && record.kind !== 'steer') throw new Error('C1 was not a steer.');
  const outcome = readJson(path.join(jobDir, 'inbox/outcomes', `${path.basename(record.messageId)}.json`));
  if (outcome.messageId !== record.messageId) throw new Error(`Outcome does not match ${line}.`);
  const active = record.kind === 'steer' ? runningAt(job, record.at, input.relayVersion) : null;
  const expected = record.kind === 'continue' ? 'new-turn' : STEER_DELIVERY[backend];
  if (expected === 'in-turn') {
    if (outcome.action !== 'steered' || !outcome.turnId || outcome.turnId !== active.turnId ||
        (outcome.attempt != null && outcome.attempt !== active.attempt)) throw new Error(`Expected in-turn steer for ${line}.`);
  } else {
    const targets = job.attempts.filter(attempt => attempt.messageId === record.messageId);
    const target = targets[0];
    if (outcome.action !== 'turn-started' || targets.length !== 1 || target.attempt !== outcome.attempt ||
        !(Date.parse(target.startedAt) >= Date.parse(record.at))) throw new Error(`Missing new attempt carrying ${line}.`);
    requireVersion(target, input.relayVersion);
    const previous = job.attempts[job.attempts.indexOf(target) - 1];
    if (record.kind === 'continue' && (previous?.state !== 'completed' ||
        !(Date.parse(previous.endedAt) <= Date.parse(record.at)))) throw new Error(`Continue ${line} preceded completion.`);
    if (active && (!(target.attempt > active.attempt) || !(Date.parse(target.startedAt) >= Date.parse(active.endedAt)) ||
        !job.messages?.some(message => message.id === record.messageId && message.action === 'queued-next-turn'))) {
      throw new Error(`Expected next-turn steer for ${line}.`);
    }
  }
  return { kind: record.kind, seconds, at: record.at, postedAt: record.postedAt, delivery: expected };
}

function cleanupWarnings(analysis, run) {
  for (const row of analysis.results) {
    const warnings = [run.cleanupScanError && `cleanup scan: ${run.cleanupScanError}`, run.cleanupError && `cleanup: ${run.cleanupError}`,
      ...Object.entries(run.typed?.[row.backend] ?? {}).flatMap(([line, receipt]) =>
        receipt.cleanupError ? [`${line} cleanup: ${receipt.cleanupError}`] : [])].filter(Boolean);
    if (warnings.length) {
      // The record schema preserves reason without turning a passing result into a failure.
      const note = `Warning: ${warnings.join('; ')}`;
      if (!row.reason?.includes(note)) row.reason = [row.reason, note].filter(Boolean).join(' ');
    }
  }
}

function footer(screen) {
  const rows = screen.split('\n').flatMap(line => {
    const match = line.match(/^\s*(❯?)\s*([●◯○])\s+(\S+)/u);
    return match ? [{ name: match[3], viewed: match[2] === '●', selected: Boolean(match[1]), idle: /\bidle\s*$/.test(line) }] : [];
  });
  const main = rows.findLastIndex(row => row.name === 'main');
  return main < 0 ? [] : rows.slice(main);
}

export async function typeInView(ctx, name, text, { agentCount, drive = pane, sleep = pause, now = Date.now, beforeSend = () => {}, beforeInterrupt = () => {}, check = () => {}, interrupt = false, followup } = {}) {
  let step = 0;
  let screenFile;
  const screen = () => {
    check();
    const value = String(drive(['read', ctx.run.pane, '0']));
    screenFile = `typed-${name}-${text.includes(' A2 ') ? 'A2' : 'first'}-${step++}.txt`;
    fs.writeFileSync(path.join(ctx.evidenceDir, screenFile), value);
    return value;
  };
  const verify = (value, expected, why) => { if (!expected(value)) throw new Error(`Navigation: expected ${why}; screen saved in ${ctx.evidenceDir}.`); };
  const cursor = value => {
    const rows = footer(value), selected = rows.filter(row => row.selected);
    return selected.length === 1 && rows.filter(row => row.name === selected[0].name).length === 1 ? selected[0].name : null;
  };
  const selected = name => value => cursor(value) === name;
  const viewPrompt = value => value.split('\n').some(line => line.trim().replace(/\s+/g, ' ') === `❯ Message @${name}…`);
  const prompt = name => value => name === 'main' ? /^\s*❯\s*[^\n]*$/m.test(value) && !value.includes('Message @') &&
    footer(value).some(row => row.name === 'main' && row.viewed) && !footer(value).some(row => row.selected) :
    viewPrompt(value) && footer(value).length > 0 && !footer(value).some(row => row.selected);
  const stepUntil = async (action, expected, why, timeoutMs = 5000) => {
    check();
    const started = now(), deadline = started + timeoutMs;
    drive([action === 'send' ? 'send' : 'keys', ctx.run.pane, action === 'send' ? text : action]);
    let value, settled = false, reads = 0;
    while (now() < deadline) {
      await sleep(Math.min(200, deadline - now()));
      value = screen(); reads++;
      if (expected(value)) { settled = true; break; }
    }
    if (!settled) {
      // A late draw must get one final read, never a second key press.
      value = screen(); reads++;
      settled = expected(value);
    }
    fs.appendFileSync(path.join(ctx.evidenceDir, 'typed-navigation.jsonl'), JSON.stringify({
      agent: name, text, key: action, expected: why, elapsedMs: now() - started, timeoutMs, reads, settled, screen: screenFile
    }) + '\n');
    verify(value, () => settled, why);
    return value;
  };
  const key = stepUntil;
  const send = () => stepUntil('send', value => prompt(name)(value) &&
    value.slice(0, value.lastIndexOf('❯')).replace(/\s+/g, ' ').includes(text),
  `${name}'s cleared prompt and submitted text`);
  const walk = async (value, direction, expected, why) => {
    for (let presses = 0; presses < agentCount + 2; presses++) {
      if (expected(value)) return value;
      const previous = cursor(value);
      value = await key(direction, next => expected(next) || (cursor(next) !== null && cursor(next) !== previous),
        `a moving selector toward ${why}`);
    }
    verify(value, expected, `${why} within ${agentCount + 2} ${direction} presses`);
    return value;
  };
  const initial = screen();
  verify(initial, prompt('main'), 'the main prompt');
  // The transcript supplies the total; the footer only shows the current scroll window.
  verify(initial, () => Number.isInteger(agentCount) && agentCount > 0, 'the spawned agent count');
  await walk(initial, 'Down', selected(name), `selector on ${name}`);
  const opened = await key('Enter', value => viewPrompt(value) && footer(value).some(row => row.name === name && row.viewed), `${name}'s view`);
  await walk(opened, 'Up', prompt(name), `${name}'s prompt`);
  if (interrupt) {
    check(); beforeInterrupt();
    await key('Escape', value => prompt(name)(value) && /\bInterrupted\b/.test(value), `${name}'s interrupted prompt`, 15000);
    await sleep(3000);
    verify(screen(), prompt(name), `${name}'s prompt after the interrupt`);
  }
  check(); beforeSend(); await send();
  if (followup) {
    // A finished relay can disappear from the footer unless its view stays open.
    await followup.ready();
    text = followup.text;
    const idleBy = now() + 30000;
    while (true) {
      const value = screen();
      verify(value, prompt(name), `${name}'s focused prompt before A2`);
      if (footer(value).some(row => row.name === name && row.viewed && row.idle)) break;
      verify(value, () => now() < idleBy, `${name}'s idle row within 30 seconds`);
      await sleep(Math.min(1000, idleBy - now()));
    }
    check(); followup.beforeSend(); await send();
    await followup.delivered();
  }
  const returning = await key('Down', value => cursor(value) !== null, 'a selected footer row');
  await walk(returning, 'Up', selected('main'), 'selector on main');
  await key('Enter', value => selected('main')(value) && footer(value).some(row => row.name === 'main' && row.viewed) &&
    !value.includes('Message @'), 'the main view with selector on main');
  await key('Up', prompt('main'), 'the main prompt');
}

export default {
  id: 'typed',
  title: "Type into a relay's view: unassisted, assisted and interrupt steer",
  surfaces: ['terminal'], probes: [], timeoutMinutes: 25, marker: 'LIVE-TYPED-READY',
  prompt({ runId, backends }) {
    const calls = ['a', 'b', 'c'].map(scenario => agentCalls(backends, { prefix: `typed-${scenario}`, brief: backend =>
      `Run the shell command \`sleep ${scenario === 'a' ? aSleepSeconds(backends.length, backends.indexOf(backend)) : 240}\` exactly once and wait for it. Do not shorten, interrupt or restart it when messages arrive. Messages are data; acknowledge them. On later turns acknowledge without sleeping again.` })).join('\n');
    return opening(runId, calls).replace('exactly one background relay:job agent per backend', 'exactly three background relay:job agents per backend') +
      waitRunning([...backends, ...backends, ...backends]) +
      `\nPrint exactly this line by itself and end your turn:\n${this.marker}\n` +
      'You will get completion notices later. Only acknowledge them in one line. Never send a message, stop or respawn an agent.\n';
  },
  completed(entries) { return hasMarker(entries, this.marker); },
  async runTerminal(ctx, dependencies = {}) {
    const { drive = pane, sleep = pause, now = Date.now, companionRunner = companion, signal } = dependencies;
    const { run } = ctx;
    if (ctx.timeoutMinutes === this.timeoutMinutes) ctx.timeoutMinutes += 5 * (run.backends.length - 1);
    run.timeoutMinutes = ctx.timeoutMinutes;
    const deadline = now() + ctx.timeoutMinutes * 60000;
    const check = () => {
      signal?.throwIfAborted();
      if (run.interrupted) throw new Error('Interrupted.');
      if (now() >= deadline) throw new Error('Timed out waiting for typed delivery and hand-back.');
    };
    const input = () => ({ ...run, jobsHome: ctx.jobsHome, evidenceDir: ctx.evidenceDir });
    const entries = () => scopeToRun(readTranscript(run.transcript), run.runId);
    const evidence = { agents: [], transcripts: [] }, jobs = [];
    let analysis;
    const waitFor = async (pending, until, label, fail = true) => {
      const bound = Math.min(deadline, Number.isFinite(until) ? until : now());
      let diagnostic;
      while (true) {
        signal?.throwIfAborted();
        if (run.interrupted) throw new Error('Interrupted.');
        try { diagnostic = pending(); }
        catch (error) {
          if (!error.message.startsWith('Invalid JSON at ')) throw error;
          diagnostic = error.message;
        }
        if (!diagnostic) return;
        if (now() >= bound) {
          const file = `typed-${label}-timeout.txt`;
          fs.writeFileSync(path.join(ctx.evidenceDir, file), String(drive(['read', run.pane, '0'])));
          const message = `${label}: ${diagnostic}; screen saved in ${file}.`;
          if (fail) throw new Error(message);
          return message;
        }
        await sleep(Math.min(1000, bound - now()));
      }
    };
    const lineRecords = (item, line) => {
      const text = run.typed[item.backend][line].text;
      const file = path.resolve(ctx.jobsHome, item.A.job.relay.transcriptPath);
      const uuids = new Set((fs.existsSync(file) ? readTranscript(file) : [])
        .filter(entry => humanText(entry) === text).map(entry => entry.uuid));
      return recordsFor(item.A.jobDir).filter(record => record.message === text || uuids.has(path.basename(record.file, '.json')));
    };
    const ledgerPending = (item, line) => {
      const records = lineRecords(item, line);
      // Duplicates are evidence to validate, not an operation still in flight.
      return records.length > 1 || records.some(record => record.status === 'done') ? null :
        `${line} ledger ${records.length ? `status is ${records[0].status}` : 'record is missing'} for ${item.a.name}`;
    };
    const waitDelivery = async (item, line) => {
      // The ledger, inbox outcome and job attempts are written by different processes.
      const started = now();
      let bound = Math.min(deadline, started + 120000);
      while (true) {
        signal?.throwIfAborted();
        if (run.interrupted) throw new Error('Interrupted.');
        try {
          const records = lineRecords(item, line);
          if (records.length && records.every(record => record.kind === 'steer') && STEER_DELIVERY[item.backend] === 'in-turn') {
            bound = Math.min(deadline, started + 20000);
          }
          item.A = relayJob(input(), evidence, item.a.agentId);
          return delivery(input(), item.A, run.typed[item.backend][line], line, item.backend);
        } catch (error) {
          if (now() >= bound) throw error;
        }
        await sleep(Math.min(500, bound - now()));
      }
    };
    const handbackPending = (item, after) => {
      item.A = relayJob(input(), evidence, item.a.agentId);
      const file = path.join(item.A.jobDir, 'relay-handbacks.jsonl');
      const returned = fs.existsSync(file) ? readTranscript(file).at(-1) : null;
      const completed = notices(entries(), item.a).filter(notice => notice.text.includes('<status>completed</status>'));
      // A completion without the guard's hand-back is already a permanent validation failure.
      if (completed.some(notice => Date.parse(notice.at) >= Date.parse(after)) &&
          !(Date.parse(returned?.at) >= Date.parse(after))) return null;
      if (!['completed', 'failed', 'cancelled'].includes(item.A.job.state) ||
          !item.A.job.attempts.at(-1)?.endedAt) return `${item.a.name}'s turn has not ended`;
      if (!(Date.parse(returned?.at) >= Date.parse(after))) return `Missing hand-back for ${item.a.name} after delivery`;
      if (!completed.some(notice => Date.parse(notice.at) >= Date.parse(returned.at))) {
        return `Missing completed notice for ${item.a.name} after hand-back`;
      }
      return null;
    };
    try {
      await ctx.paneDriver(ctx, this, { keep: true, drive });
      check(); run.completed = false; run.typed = {}; ctx.save();
      if (!this.completed(entries())) throw new Error(`Missing ${this.marker}.`);
      const parsed = transcriptCalls(entries());
      for (const backend of run.backends) {
        const [a, b, c] = agents(parsed, backend);
        jobs.push({ backend, a, b, c, A: relayJob(input(), evidence, a.agentId), B: relayJob(input(), evidence, b.agentId), C: relayJob(input(), evidence, c.agentId) });
        run.typed[backend] = {};
      }
      const receipt = (item, line) => {
        const scenario = line[0], agent = item[scenario.toLowerCase()], loaded = item[scenario];
        const text = typedLine(run.runId, item.backend, line);
        const job = readJob(loaded.jobDir);
        if (line !== 'A2' && job.state !== 'running') throw new Error(`${agent.name} is no longer running before ${line}.`);
        run.typed[item.backend][line] = { text, sentAt: new Date(now()).toISOString() }; ctx.save();
      };
      const type = (item, line, followup) => typeInView(ctx, item[line[0].toLowerCase()].name,
        typedLine(run.runId, item.backend, line), { agentCount: parsed.spawns.length, drive, sleep, now, check, interrupt: line === 'C1',
          beforeInterrupt: () => {
            if (readJob(item.C.jobDir).state !== 'running') throw new Error(`${item.c.name} is no longer running before Escape.`);
          }, beforeSend: () => receipt(item, line), followup });
      for (const item of jobs) {
        await type(item, 'B1');
        check();
        Object.assign(run.typed[item.backend].B1, { assistance: 'manual-wake', wakeAt: new Date(now()).toISOString() }); ctx.save();
        await companionRunner(ctx, ['wake', '--agent', item.b.agentId]);
      }
      for (const item of jobs) await type(item, 'C1');
      for (const item of jobs) {
        await type(item, 'A1', {
          text: typedLine(run.runId, item.backend, 'A2'),
          ready: async () => {
            const until = now() + (aSleepSeconds(run.backends.length, run.backends.indexOf(item.backend)) + 120) * 1000;
            await waitFor(() => ledgerPending(item, 'A1'), until, `${item.a.name}-A1-ledger`);
            const delivered = await waitDelivery(item, 'A1');
            await waitFor(() => handbackPending(item, delivered.postedAt), until, `${item.a.name}-A1-handback`);
            handback(item.A, item.a, entries(), delivered.postedAt);
          },
          beforeSend: () => receipt(item, 'A2'),
          delivered: async () => {
            await waitFor(() => ledgerPending(item, 'A2'), now() + 60000, `${item.a.name}-A2-ledger`);
            item.a2 = await waitDelivery(item, 'A2');
          }
        });
      }
      for (const item of jobs) {
        const diagnostic = await waitFor(() => handbackPending(item, item.a2.postedAt), Date.parse(item.a2.at) + 120000,
          `${item.a.name}-A2-handback`, false);
        if (diagnostic) { run.typed[item.backend].A2.settleError = diagnostic; ctx.save(); }
      }
      signal?.throwIfAborted();
      if (run.interrupted) throw new Error('Interrupted.');
      analysis = this.analyze(input());
      run.completed = true; run.checkFinishedAt = new Date(now()).toISOString(); ctx.save();
      return analysis;
    } catch (error) {
      run.completed = false; run.error = error.message; ctx.save(); throw error;
    } finally {
      const saveCleanup = () => {
        try { ctx.save(); } catch (error) { run.cleanupError = error.message; }
      };
      try {
        const started = new Map(jobs.flatMap(item => ['A', 'B', 'C'].map(scenario =>
          [item[scenario].jobDir, { backend: item.backend, scenario, loaded: item[scenario] }])));
        // Startup or navigation can fail before the normal job inventory is complete.
        try {
          const text = run.transcript && fs.existsSync(run.transcript) ? fs.readFileSync(run.transcript, 'utf8') : '';
          const lines = text.split('\n');
          const scanned = lines.flatMap((line, i) => {
            if (!line.trim()) return [];
            try { return [JSON.parse(line)]; }
            catch {
              const message = `Invalid JSON at ${run.transcript}:${i + 1}`;
              // The lead can still be appending its last entry while cleanup runs.
              if (i === lines.length - 1) { run.cleanupScanError = message; return []; }
              throw new Error(message);
            }
          });
          for (const agent of transcriptCalls(scopeToRun(scanned, run.runId)).spawns) {
            const scenario = ['a', 'b', 'c'].find(value => agent.name === `typed-${value}-${agent.backend}`);
            if (!scenario || !run.backends.includes(agent.backend)) continue;
            try {
              const loaded = relayJob(input(), evidence, agent.agentId);
              started.set(loaded.jobDir, { backend: agent.backend, scenario: scenario.toUpperCase(), loaded });
            } catch { /* A spawn may not have created a job yet. */ }
          }
        } catch (error) { run.cleanupScanError = error.message; }
        for (const { backend, scenario, loaded } of started.values()) {
          const receipts = ((run.typed ??= {})[backend] ??= {});
          const receipt = (receipts[`${scenario}1`] ??= {});
          try {
            if (['completed', 'failed', 'cancelled'].includes(readJob(loaded.jobDir).state)) continue;
            receipt.cleanupAt = new Date(now()).toISOString(); saveCleanup();
            await companionRunner(ctx, ['cancel', loaded.jobDir]);
          } catch (error) {
            receipt.cleanupError = error.message;
          }
          saveCleanup();
        }
      } catch (error) {
        run.cleanupError = error.message;
      } finally {
        try { if (run.pane) drive(['stop', run.pane]); }
        catch (error) { run.cleanupError = error.message; }
        saveCleanup();
        if (analysis) cleanupWarnings(analysis, run);
      }
    }
  },
  analyze(input) {
    const analysis = analyzeBackends(input, this.scope, ({ backend, row, entries, parsed, evidence }) => {
      const run = readJson(path.join(input.evidenceDir, 'run.json'));
      if (run.runId !== input.runId || !this.completed(entries)) throw new Error('Missing typed run or marker.');
      const [a, b, c] = agents(parsed, backend);
      const A = relayJob(input, evidence, a.agentId), B = relayJob(input, evidence, b.agentId), C = relayJob(input, evidence, c.agentId);
      if (run.error) throw new Error(run.error);
      for (const [agent, loaded] of [[a, A], [b, B], [c, C]]) {
        requireBackend(loaded.job, backend);
        const notifications = notices(entries, agent);
        const stopped = notice => notice.text.includes(`<summary>Agent "${agent.name}" was stopped by user</summary>`);
        const stops = notifications.filter(stopped);
        if (agent === c && stops.length !== 1) throw new Error(`Expected exactly one stopped by user notice for ${agent.name}.`);
        if (agent !== c && stops.length) throw new Error(`${agent.name} was stopped by user.`);
        if (agent === c && notifications.some(notice => !stopped(notice) &&
            !notice.text.includes('<status>completed</status>') &&
            !notice.text.includes(`<summary>Agent "${agent.name}" was resumed by the user</summary>`))) {
          throw new Error(`Unexpected task notification for ${agent.name}.`);
        }
        if (parsed.sends.some(send => send.agentId === agent.agentId)) throw new Error(`Lead sent a message to ${agent.name}.`);
      }
      const receipt = run.typed?.[backend];
      if (receipt?.A2?.settleError) throw new Error(receipt.A2.settleError);
      const a1 = delivery(input, A, receipt?.A1, 'A1', backend);
      const a2 = delivery(input, A, receipt?.A2, 'A2', backend);
      const b1 = delivery(input, B, receipt?.B1, 'B1', backend);
      const c1 = delivery(input, C, receipt?.C1, 'C1', backend);
      const stop = notices(entries, c).find(notice => notice.text.includes('was stopped by user</summary>'));
      if (!(Date.parse(stop.at) < Date.parse(c1.at))) throw new Error('C stop notice did not precede C1 delivery.');
      // Cleanup follows the final analysis; saved evidence must still replay then.
      const cleanup = Date.parse(receipt.C1.cleanupAt);
      const afterCheck = cleanup >= Date.parse(run.checkFinishedAt) && cleanup >= Date.parse(c1.postedAt);
      if ((C.job.state === 'cancelled' && !(afterCheck && Date.parse(C.job.completedAt) >= cleanup)) ||
          C.job.attempts.some(attempt => attempt.state === 'cancelled' && !(afterCheck && Date.parse(attempt.endedAt) >= cleanup))) {
        throw new Error(`${c.name}'s job was cancelled before cleanup.`);
      }
      const before = { ...A, job: { ...A.job, attempts: A.job.attempts.filter(attempt => Date.parse(attempt.startedAt) < Date.parse(receipt.A2.sentAt)) } };
      // The first hand-back must be after A1, and before the idle-view send resumes the relay.
      const prior = readTranscript(path.join(A.jobDir, 'relay-handbacks.jsonl')).filter(item => Date.parse(item.at) < Date.parse(receipt.A2.sentAt));
      const previous = prior.at(-1), active = before.job.attempts.at(-1);
      if (previous?.agentId !== a.agentId || previous.state !== 'completed' || previous.attempts !== before.job.attempts.length ||
          !(Date.parse(previous.at) >= Date.parse(a1.postedAt)) || active?.state !== 'completed' ||
          !(Date.parse(active.endedAt) <= Date.parse(previous.at)) || !notices(entries, a).some(notice =>
            notice.text.includes('<status>completed</status>') && Date.parse(notice.at) >= Date.parse(previous.at) && Date.parse(notice.at) < Date.parse(receipt.A2.sentAt))) {
        throw new Error('A2 was not typed after the A1 hand-back.');
      }
      handback(A, a, entries, a2.postedAt);
      Object.assign(row, { a1, a2, b1, c1, assistance: 'manual-wake', delivery: `${a1.kind}; assisted-steer:${b1.delivery}; interrupt-steer:${c1.delivery}` });
      row.timings = { a1Seconds: [a1.seconds], a2Seconds: [a2.seconds], b1WakeSeconds: [b1.seconds], c1Seconds: [c1.seconds] };
    });
    analysis.results.forEach((row, i) => { row.delivery = analysis.details[i].delivery ?? null; });
    cleanupWarnings(analysis, readJson(path.join(input.evidenceDir, 'run.json')));
    return analysis;
  },
  cell(record) {
    return `typed while it runs: at the relay's next call (${formatSeconds(record.timings.a1Seconds ?? [])}, a ${record.delivery?.split(';')[0] ?? 'continue'}); ` +
      `after the hand-back: a new turn in ${formatSeconds(record.timings.a2Seconds ?? [])}; ` +
      `woken by hand: a steer in ${formatSeconds(record.timings.b1WakeSeconds ?? [])}${record.delivery?.includes('assisted-steer:next-turn') ? ' (next turn)' : ''}; ` +
      `typed after an interrupt: a steer in ${formatSeconds(record.timings.c1Seconds ?? [])}${record.delivery?.endsWith('interrupt-steer:next-turn') ? ' (next turn)' : ''}` +
      (record.reason ? `; ${record.reason}` : '');
  }
};
