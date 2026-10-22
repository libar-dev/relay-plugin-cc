import fs from 'node:fs';
import path from 'node:path';
import { analyzeBackends, filesUnder, formatSeconds, hasMarker, inboxMessages, lastActiveAttempt, MODELS,
  oneRelay, readJob, readJson, readTranscript, recordsFor, relayJob, requireBackend, requireVersion,
  scopeToRun, textContent, toolResults, transcriptCalls } from '../lib/evidence.mjs';
import { pane } from '../lib/terminal.mjs';
import { agentCalls, opening, waitRunning } from './steer-main.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ready = 'LIVE-BOARD-READY';
const ended = job => ['completed', 'failed', 'cancelled'].includes(job.state);
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');
// Claude Code 2.1.308: active turns have an ellipsis and a parenthesized elapsed
// time. Completed turns say e.g. "✻ Cogitated for 1m 39s · done 10:19 PM".
export function leadIsIdle(screen) {
  return !/^\s*[·✢✳✶✻✽*] [^\n]*?(?:…|\.\.\.)\s+\(\d+(?:h|m|s)(?: \d+(?:h|m|s))*\b/m.test(plain(screen));
}
// Use a blank transcript line to measure the dock boundary in screen cells,
// independent of emoji or wide characters elsewhere in the transcript.
export function elementCell(screen, wanted) {
  const lines = plain(screen).split('\n');
  if (wanted === '❯') {
    const y = lines.findLastIndex(line => /^❯\s*$/.test(line));
    return y < 0 ? null : { x: 1, y: y + 1 };
  }
  const boundary = lines.find(line => /^ *│/.test(line))?.indexOf('│');
  if (boundary === undefined) return null;
  for (const [y, line] of lines.entries()) {
    const divider = line.lastIndexOf('│');
    if (divider < 0) continue;
    const body = line.slice(divider + 1), at = body.indexOf(wanted);
    if (at < 0) continue;
    if (wanted.startsWith('job-')) {
      if (!/^ *(?:> )?$/.test(body.slice(0, at)) || !body.slice(at + wanted.length).startsWith(' · ')) continue;
    } else if (!wanted.startsWith('[') && body.slice(0, at).trim()) continue;
    return { x: boundary + 2 + [...body.slice(0, at)].length, y: y + 1 };
  }
  return null;
}
export function clickBytes({ x, y }) {
  return [...Buffer.from(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`)].map(byte => byte.toString(16).padStart(2, '0'));
}
export function focusedText(screen) {
  let inverse = false, offset = 0, text = '';
  for (const match of screen.matchAll(/\x1b\[([0-9;]*)m/g)) {
    if (inverse) text += screen.slice(offset, match.index);
    const codes = (match[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if ([38, 48, 58].includes(code)) { i += codes[i + 1] === 2 ? 4 : 2; continue; }
      if (code === 0 || code === 27) inverse = false;
      if (code === 7) inverse = true;
    }
    offset = match.index + match[0].length;
  }
  if (inverse) text += screen.slice(offset);
  return text.trim();
}
export const steerText = (kind, backend) => `board steer ${kind} ${backend}`;
export const continueText = (kind, backend) => `board continue ${kind} ${backend}: run the shell command \`sleep 60\` exactly once and wait for it. Then reply with one line: board continued ${kind} ${backend}.`;
const brief = backend => `Run the shell command \`sleep 120\` exactly once and wait for it. Do not shorten, interrupt or restart it when messages arrive. Then reply with one line: board done ${backend}. If a queued message arrives as a later turn, reply with one line without sleeping again.`;
export function boardWorkflow(backends) {
  return 'export const meta = { name: \'live-board\', description: \'Board Workflow relays\' }\n' +
    'return await parallel([\n' + backends.map(backend => {
      const prompt = `${backend === 'codex' ? '' : `backend: ${backend}\n`}model: ${MODELS[backend]}\neffort: low\n---\n${brief(backend)}`;
      return `  () => agent(${JSON.stringify(prompt)}, { agentType: 'relay:job', label: 'board-wf-${backend}' })`;
    }).join(',\n') + '\n])';
}

// The launch and journal tie Workflow agents to this run even while its result is pending.
function boardJobs(input, evidence) {
  const entries = scopeToRun(readTranscript(input.transcript), input.runId), parsed = transcriptCalls(entries);
  const calls = parsed.calls.filter(call => call.name === 'Workflow'), results = toolResults(entries);
  if (calls.length !== 1 || calls[0].input?.script?.trimEnd() !== boardWorkflow(input.backends)) throw new Error('Missing this run\'s board Workflow.');
  const result = results.get(calls[0].id);
  const workflowId = result?.result?.runId ?? textContent(result?.content).match(/^Run ID:\s*([\w.-]+)\s*$/m)?.[1];
  if (!workflowId || !/^[\w.-]+$/.test(workflowId) || result.is_error) throw new Error('Missing board Workflow launch result.');
  const folder = path.join(input.transcript.replace(/\.jsonl$/, ''), 'subagents/workflows', workflowId);
  const journalFile = path.join(folder, 'journal.jsonl'), journal = readTranscript(journalFile);
  evidence.transcripts.push(journalFile);
  return input.backends.flatMap(backend => ['agent', 'workflow'].map(kind => {
    const label = `board-${kind === 'agent' ? 'agent' : 'wf'}-${backend}`;
    const agents = journal.filter(entry => entry.type === 'started' && entry.label === label);
    if (kind === 'workflow' && agents.length !== 1) throw new Error(`Missing unique Workflow relay ${label}.`);
    const agentId = kind === 'agent' ? oneRelay(parsed, backend, 'board-agent').agentId : agents[0].agentId;
    const loaded = relayJob(input, evidence, agentId), job = loaded.job;
    requireBackend(job, backend);
    if (job.relay?.label !== label || (kind === 'workflow' ? job.relay.workflowRunId !== workflowId : job.relay.workflowRunId != null) ||
        job.launchedBy?.claudeSessionId !== input.run.sessionId || !(Date.parse(job.createdAt) >= Date.parse(entries[0]?.timestamp))) {
      throw new Error(`Board job ${label} belongs to another run or session.`);
    }
    const pointer = readJson(path.join(input.jobsHome, 'relays', `${agentId}.json`));
    const transcript = path.resolve(input.jobsHome, pointer.transcriptPath ?? job.relay.transcriptPath);
    if (!evidence.transcripts.includes(transcript)) evidence.transcripts.push(transcript);
    return { ...loaded, kind, backend, agentId, transcript, folder };
  }));
}

// Capture every candidate, including a fork outside the Workflow folder. Copies retain the files.
function relayFiles(input, job, evidence) {
  const files = filesUnder(path.join(input.transcript.replace(/\.jsonl$/, ''), 'subagents'), file => /^agent-.*\.jsonl$/.test(path.basename(file)))
    .filter(file => path.basename(file).includes(job.agentId) || readTranscript(file).some(entry => entry.agentId === job.agentId));
  evidence.transcripts.push(...files.filter(file => !evidence.transcripts.includes(file)));
  return files.map(file => path.relative(input.transcript.replace(/\.jsonl$/, ''), file)).sort();
}

const hasRow = (screen, job) => screen.split('\n').some(line => line.includes(`${job.id} · ${job.request.backend} · `) && / · attempt \d+\b/.test(line));
function seconds(after, before, limit, label) {
  const value = (Date.parse(after) - Date.parse(before)) / 1000;
  if (!(value >= 0 && value <= limit)) throw new Error(`${label} was not within ${limit} seconds of the press.`);
  return value;
}
function messageFor(jobDir, action) {
  const matches = inboxMessages(jobDir).filter(message => message.kind === action.action &&
    (action.action === 'cancel' || message.text === action.text) && Date.parse(message.createdAt) >= Date.parse(action.at));
  if (matches.length !== 1) throw new Error(`Missing unique ${action.action} message after the press.`);
  return matches[0];
}
function route(item, action, message) {
  const ledger = recordsFor(item.jobDir).filter(record => record.messageId === message.id);
  if (item.kind === 'workflow') {
    if (ledger.length) throw new Error('Workflow action has an inbox/relay record.');
    return;
  }
  if (ledger.length !== 1 || ledger[0].kind !== action.action || ledger[0].status !== 'done') throw new Error('Agent action has no completed inbox/relay record.');
  const record = ledger[0], entry = readTranscript(item.transcript).find(entry => entry.uuid === path.basename(record.file, '.json'));
  if (!(entry?.type === 'attachment' && entry.attachment?.type === 'queued_command') &&
      !(action.action === 'continue' && entry?.type === 'user')) throw new Error('Missing relay delivery transcript entry.');
  const origin = entry.type === 'attachment' ? entry.attachment.origin : entry.origin;
  const text = entry?.type === 'attachment' ? entry.attachment?.prompt : textContent(entry?.message?.content);
  const carried = entry.type === 'user' ? `The coordinator sent a message while you were working:\n${action.text}\n\nAddress this before completing your current task.` : action.text;
  if (origin?.kind !== 'coordinator' || origin.plugin !== 'relay' || text !== carried) throw new Error('Agent delivery lacks the main conversation origin with plugin relay.');
  seconds(record.postedAt, action.at, action.action === 'steer' ? 30 : 60, 'Relay delivery');
  seconds(entry.timestamp, action.at, action.action === 'steer' ? 30 : 60, 'Relay transcript entry');
}

export default {
  id: 'board', title: 'The board steers, continues and cancels jobs',
  surfaces: ['terminal'], probes: [], timeoutMinutes: 25, marker: ready,
  prompt({ runId, backends }) {
    return opening(runId, agentCalls(backends, { prefix: 'board-agent', brief })).replace(/^Keep your turn[^\n]*\n/m, '') +
      `\nRun one Workflow now. This is an explicit request to use the Workflow tool. Pass this script inline and verbatim, with no args:\n\n${boardWorkflow(backends)}\n\n` +
      waitRunning([...backends, ...backends]).replace('each ${RELAY_JOBS_HOME:-$HOME/.relay-jobs}/relays/<agentId>.json pointer',
        'each ${RELAY_JOBS_HOME:-$HOME/.relay-jobs}/relays/<agentId>.json pointer (including the board-wf labels and agentIds in the Workflow journal)') +
      `Send no messages yourself. Do not steer, continue, cancel or respawn any job. Print ${ready} on its own line as your final answer and end your turn immediately. Leave the background relays and the Workflow running. Do not wait for their completion or for a file, and print no second marker.\n`;
  },
  completed(entries) { return hasMarker(entries, this.marker); },
  async runTerminal(ctx, { drive = pane, sleep = pause, now = Date.now, signal } = {}) {
    const run = ctx.run, stamp = () => new Date(now()).toISOString();
    const saved = run.board = { actions: [], screens: [] }, input = () => ({ ...ctx, run, transcript: run.transcript });
    const evidence = { transcripts: [], agents: [] };
    const checkAbort = () => { signal?.throwIfAborted(); if (run.interrupted) throw new Error('Interrupted.'); };
    const waitFor = async (label, predicate, timeout = 60000, since = now()) => {
      const until = since + timeout;
      while (true) {
        checkAbort();
        const matched = await predicate();
        if (now() <= until && matched) return;
        if (now() >= until) throw new Error(`Timed out waiting for ${label}.`);
        await sleep(250);
      }
    };
    const capture = phase => {
      const file = `board-${saved.screens.length}.txt`, text = drive(['screen-escapes', run.pane]);
      fs.writeFileSync(path.join(ctx.evidenceDir, file), text);
      saved.screens.push({ phase, file, at: stamp() }); ctx.save();
      return plain(text);
    };
    const bytes = (...hex) => drive(['bytes', run.pane, ...hex]);
    const locate = async wanted => {
      let cell;
      await waitFor(`element ${wanted}`, () => (cell = elementCell(drive(['screen-escapes', run.pane]), wanted)), 15000);
      return cell;
    };
    const click = async wanted => bytes(...clickBytes(await locate(wanted)));
    // Only the new, agent-free narrow session uses keyboard focus and idle waits.
    const waitIdle = async (until = now() + 60000) => {
      let screen;
      await waitFor('idle lead', () => {
        screen = drive(['screen-escapes', run.pane]);
        return leadIsIdle(screen);
      }, until - now());
      return screen;
    };
    const focus = async wanted => {
      await waitIdle();
      // Recovery shares the focus deadline: a new turn must not restart the bound.
      const until = now() + 15000;
      await waitFor(`focus on ${wanted}`, async () => {
        const inverse = focusedText(await waitIdle(until));
        if (wanted instanceof RegExp ? wanted.test(inverse) : inverse.includes(wanted)) return true;
        if (!inverse) {
          bytes('18');
          await sleep(100);
          await waitIdle(until);
        }
        bytes('09'); return false;
      }, until - now());
    };
    const select = async (item, narrow = false) => {
      if (narrow) { await focus(item.job.id); bytes('0d'); }
      else await click(item.job.id);
      let clickedAt = now();
      await waitFor('selected job details', async () => {
        const screen = plain(drive(['screen-escapes', run.pane]));
        if (screen.includes(`> ${item.job.id}`) && screen.includes(`model ${MODELS[item.backend]}`) && screen.includes(`relay board-${item.kind === 'agent' ? 'agent' : 'wf'}-${item.backend}`)) return true;
        // A click can land while the session redraws, and selecting a row again changes nothing.
        if (!narrow && now() - clickedAt > 3000) { await click(item.job.id); clickedAt = now(); }
        return false;
      });
    };
    const open = async (phase, jobs) => {
      if (phase === 'narrow') {
        await waitFor('narrow first prompt', () => {
          const screen = drive(['screen-escapes', run.pane]);
          return leadIsIdle(screen) && /^❯\s*$/m.test(plain(screen));
        });
      } else await click('❯');
      drive(['keys', run.pane, '-l', '/relay-board']); bytes('0d');
      await waitFor('every board row', () => jobs.every(item => hasRow(plain(drive(['screen-escapes', run.pane])), readJob(item.jobDir))));
      capture(phase);
    };
    const start = async (width, fullscreen, selected, sessionCtx = ctx) => {
      await ctx.paneDriver(sessionCtx, selected, { keep: true, drive(args, text) {
        if (args[0] !== 'start') return drive(args, text);
        const at = args.indexOf('--');
        const changed = fullscreen ? [...args.slice(0, at), '--env', 'CLAUDE_CODE_NO_FLICKER=1', ...args.slice(at)] :
          [...args.slice(0, at + 1), 'env', '-u', 'CLAUDE_CODE_NO_FLICKER', ...args.slice(at + 1)];
        const result = drive(changed, text);
        drive(['size', args[1], String(width), '60']);
        return result;
      } });
      run.completed = false; ctx.save();
    };
    const send = async (item, action) => {
      await select(item);
      const label = action === 'continue' ? 'Continue:' : item.backend === 'kimi' ? 'Queue next turn:' : 'Steer:';
      await click(label);
      // Clear the field left by a previous selection before typing literal text.
      bytes('05', '15');
      const text = action === 'steer' ? steerText(item.kind, item.backend) : continueText(item.kind, item.backend);
      drive(['keys', run.pane, '-l', text]);
      const files = item.kind === 'workflow' ? relayFiles(input(), item, evidence) : undefined;
      const receipt = { runId: run.runId, sessionId: run.sessionId, jobId: item.job.id, kind: item.kind, backend: item.backend, action, text, at: stamp() };
      if (files) receipt.relayFiles = files;
      saved.actions.push(receipt); bytes('0d'); ctx.save();
      // An Enter can be lost while the session redraws. The field then keeps its text and nothing
      // was sent, so pressing again cannot send the message twice.
      for (let tries = 1; ; tries++) {
        const until = now() + 4000;
        let pending = true;
        while (now() < until && (pending = plain(drive(['screen-escapes', run.pane])).includes(`${label} ${text}`))) await sleep(250);
        if (!pending || tries === 3) break;
        await click(label); bytes('0d');
      }
      await waitFor(`${action} accepted by the job`, () => {
        const messages = inboxMessages(item.jobDir).filter(message => message.text === text && Date.parse(message.createdAt) >= Date.parse(receipt.at));
        return messages.some(message => readJson(path.join(item.jobDir, 'inbox/outcomes', `${message.id}.json`), true));
      }, action === 'steer' ? 30000 : 60000, Date.parse(receipt.at));
      capture(`${action}-${item.kind}-${item.backend}`);
      return receipt;
    };
    try {
      if (fs.readdirSync(ctx.jobsHome).length) throw new Error('board requires an empty jobs home.');
      await start(200, true, this);
      const jobs = boardJobs(input(), evidence);
      await open('wide', jobs);
      for (const item of jobs) await send(item, 'steer');
      await waitFor('all steered jobs to end', () => jobs.every(item => {
        const job = readJob(item.jobDir);
        return ended(job) && (item.backend !== 'kimi' || job.attempts.length >= 2);
      }), 300000);
      // Cancel each Workflow continuation promptly, before its 60-second sleep can finish.
      for (const item of jobs) {
        await send(item, 'continue');
        if (item.kind !== 'workflow') continue;
        await waitFor('continued turn running', () => readJob(item.jobDir).state === 'running');
        const attempt = readJob(item.jobDir).attempts.at(-1).attempt;
        await click('[ Cancel ]');
        let cancelAt = now();
        await waitFor('cancel confirmation', async () => {
          if (plain(drive(['screen-escapes', run.pane])).includes(`Cancel job ${item.job.id}, attempt ${attempt}?`)) return true;
          // The first press only asks; pressing it again before the question shows asks again.
          if (now() - cancelAt > 3000) { await click('[ Cancel ]'); cancelAt = now(); }
          return false;
        });
        capture(`confirm-${item.backend}`);
        const yes = await locate('[ Yes ]');
        const receipt = { runId: run.runId, sessionId: run.sessionId, jobId: item.job.id, kind: item.kind, backend: item.backend, action: 'cancel', attempt, at: stamp() };
        saved.actions.push(receipt); bytes(...clickBytes(yes)); ctx.save();
        // Yes goes away once pressed; while it is still there, the press was lost.
        let yesAt = now();
        await waitFor('cancelled job', async () => {
          if (readJob(item.jobDir).state === 'cancelled') return true;
          const cell = elementCell(drive(['screen-escapes', run.pane]), '[ Yes ]');
          if (cell && now() - yesAt > 3000) { bytes(...clickBytes(cell)); yesAt = now(); }
          return false;
        }, 15000, Date.parse(receipt.at));
        capture(`cancel-${item.backend}`);
      }
      await waitFor('Agent continuations to end', () => jobs.every(item => ended(readJob(item.jobDir))), 120000);
      drive(['stop', run.pane]);
      const wide = { sessionId: run.sessionId, pane: run.pane, transcript: run.transcript, debugLog: run.debugLog,
        startupEvidence: run.startupEvidence, promptSentAt: run.promptSentAt };
      const narrowDir = path.join(ctx.evidenceDir, 'narrow'); fs.mkdirSync(narrowDir);
      fs.writeFileSync(path.join(narrowDir, 'prompt.txt'), `Live suite run ${run.runId}.\nDo not run any tools. Reply with exactly LIVE-BOARD-NARROW-READY.\n`);
      try {
        await start(100, false, { ...this, completed: entries => hasMarker(entries, 'LIVE-BOARD-NARROW-READY') }, { ...ctx, evidenceDir: narrowDir });
        saved.narrow = { sessionId: run.sessionId, transcript: run.transcript, debugLog: run.debugLog, startupEvidence: run.startupEvidence };
        await open('narrow', jobs); await select(jobs[0], true);
        saved.selectedJob = jobs[0].job.id; capture('narrow-detail');
      } finally {
        try { drive(['stop', run.pane]); }
        finally { Object.assign(run, wide); }
      }
      run.completed = true;
    } catch (error) {
      run.completed = false; run.error = error.message;
      try { if (run.pane) capture('failure'); } catch { /* Keep the original failure if the pane is gone. */ }
      throw error;
    }
    finally {
      try { if (run.pane) drive(['stop', run.pane]); }
      finally { run.checkFinishedAt = stamp(); ctx.save(); }
    }
  },
  analyze(input) {
    let jobs;
    return analyzeBackends(input, this.scope, ({ backend, row, entries, allEntries, evidence }) => {
      jobs ??= boardJobs(input, evidence);
      const saved = input.run.board;
      const start = Date.parse(entries.find(entry => hasMarker([entry], ready))?.timestamp), end = Date.parse(input.run.checkFinishedAt);
      const next = allEntries[allEntries.indexOf(entries.at(-1)) + 1];
      if (!Number.isFinite(start) || !(end > start)) throw new Error('Missing board ready marker or runner finish time in this run.');
      const screens = (saved?.screens ?? []).map(screen => {
        const file = path.join(input.evidenceDir, screen.file);
        (evidence.files ??= []).push(file);
        return { ...screen, text: plain(fs.readFileSync(input.evidencePath ? input.evidencePath(file) : file, 'utf8')) };
      });
      for (const phase of ['wide', 'narrow']) {
        if (!screens.some(screen => screen.phase === phase && jobs.every(item => hasRow(screen.text, item.job)))) throw new Error(`Missing job row in ${phase} capture.`);
      }
      const selected = jobs.find(item => item.job.id === saved.selectedJob);
      if (!selected || !screens.some(screen => screen.phase === 'narrow-detail' && screen.text.includes(`> ${selected.job.id}`) &&
          screen.text.includes(`model ${MODELS[selected.backend]}`) && screen.text.includes(`relay ${selected.job.relay.label}`))) throw new Error('Missing selected job details in narrow capture.');
      if (saved.narrow?.transcript) (evidence.files ??= []).push(saved.narrow.transcript);
      for (const item of jobs.filter(item => item.backend === backend)) {
        const { job, jobDir, kind } = item;
        for (const actionName of ['steer', 'continue', ...(kind === 'workflow' ? ['cancel'] : [])]) {
          const actions = saved.actions.filter(action => action.backend === backend && action.kind === kind && action.action === actionName);
          if (actions.length !== 1) throw new Error(`Expected one ${kind} ${actionName}.`);
          const action = actions[0], at = Date.parse(action.at);
          if (action.runId !== input.runId || action.sessionId !== input.run.sessionId || action.jobId !== job.id ||
              !(at >= start && at < end && (!next || at < Date.parse(next.timestamp)))) throw new Error('Board action belongs to another run.');
          if (actionName !== 'cancel' && action.text !== (actionName === 'steer' ? steerText(kind, backend) : continueText(kind, backend))) throw new Error('Unexpected board message text.');
          const message = messageFor(jobDir, action), outcome = readJson(path.join(jobDir, 'inbox/outcomes', `${message.id}.json`), true);
          if (outcome?.messageId !== message.id) throw new Error('Missing board message outcome.');
          if (!(Date.parse(message.createdAt) < end && Date.parse(outcome.at) >= at && Date.parse(outcome.at) < end &&
              (!next || Date.parse(outcome.at) < Date.parse(next.timestamp)))) throw new Error('Message outcome belongs to another run.');
          const attempts = job.attempts ?? [], active = attempts.find(attempt => Date.parse(attempt.startedAt) <= at && Date.parse(attempt.endedAt) > at);
          let elapsed;
          if (actionName === 'cancel') {
            const attempt = lastActiveAttempt(job, action.at, input.relayVersion);
            const continued = attempts.find(attempt => attempt.source === 'continue');
            if (job.state !== 'cancelled' || attempt.state !== 'cancelled' || outcome.action !== 'cancelled' ||
                attempt !== continued || action.attempt !== attempt.attempt || message.attempt !== attempt.attempt ||
                attempt.attempt !== (backend === 'kimi' ? 3 : 2)) throw new Error('Cancel targeted another attempt or did not cancel the continued turn.');
            seconds(outcome.at, action.at, 15, 'Cancel outcome');
            seconds(attempt.endedAt, action.at, 15, 'Attempt cancellation');
            elapsed = seconds(job.completedAt, action.at, 15, 'Cancellation');
          } else {
            route(item, action, message);
            if (kind === 'workflow') {
              const after = relayFiles(input, item, evidence);
              if (!Array.isArray(action.relayFiles) || after.some(file => !action.relayFiles.includes(file))) throw new Error('Workflow action started a new relay loop.');
            }
            const target = attempts.find(attempt => attempt.attempt === outcome.attempt);
            if (actionName === 'continue') {
              const previous = attempts.filter(attempt => Date.parse(attempt.startedAt) < at).at(-1);
              if (!previous?.endedAt || !ended(previous) || !(Date.parse(previous.endedAt) <= at) || !target || target.attempt !== previous.attempt + 1 ||
                  target.messageId !== message.id || target.source !== 'continue' || outcome.action !== 'turn-started') throw new Error('Continue has no new attempt after the job ended.');
              requireVersion(target, input.relayVersion);
              elapsed = seconds(target.startedAt, action.at, 60, 'Continue');
            } else {
              if (!active) throw new Error('Steer did not target a running attempt.');
              requireVersion(active, input.relayVersion);
              if (backend === 'kimi') {
                const queued = job.messages?.find(entry => entry.id === message.id && entry.action === 'queued-next-turn');
                if (!queued || outcome.action !== 'turn-started' || !target || target.attempt <= active.attempt || target.messageId !== message.id ||
                    !(Date.parse(target.startedAt) >= Date.parse(active.endedAt))) throw new Error('Kimi steer did not queue and start a later attempt.');
                requireVersion(target, input.relayVersion);
                elapsed = seconds(queued.at, action.at, 30, 'Steer');
              } else {
                if (outcome.action !== 'steered' || target !== active) throw new Error('Steer outcome did not reach the active attempt.');
                elapsed = seconds(outcome.at, action.at, 30, 'Steer');
              }
            }
          }
          row.timings[actionName === 'cancel' ? 'cancelSeconds' : `${actionName}${kind === 'agent' ? 'Agent' : 'Workflow'}Seconds`] = [elapsed];
        }
      }
    });
  },
  cell(record) {
    const t = name => formatSeconds(record.timings[name] ?? []);
    return `steer agent ${t('steerAgentSeconds')}, workflow ${t('steerWorkflowSeconds')}; continue agent ${t('continueAgentSeconds')}, workflow ${t('continueWorkflowSeconds')}; cancel ${t('cancelSeconds')}`;
  }
};
