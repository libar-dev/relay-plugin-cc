import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeBackends, formatSeconds, hasMarker, inboxMessages, lastActiveAttempt, MODELS,
  readJson, readJob, readTranscript, relayJob, requireBackend, scopeToRun, textContent, transcriptCalls } from '../lib/evidence.mjs';
import { pane } from '../lib/terminal.mjs';
import { opening, waitRunning } from './steer-main.mjs';
import { viewNavigation } from './typed.mjs';

export const taskStopLine = 'Stop the background agent stop-ts now with the TaskStop tool, then end your turn. Do nothing else.';
export const noticeText = (name, id) => `relay: ${name} was stopped, and its job ${id} keeps running. /relay:cancel ${id} cancels it, /relay:result ${id} shows it.`;
const names = ['stop-x', 'stop-esc', 'stop-ts'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const companion = (ctx, args) => execFileSync(process.execPath,
  [path.join(ctx.pluginDir, 'scripts/companion.mjs'), ...args],
  { encoding: 'utf8', env: { ...process.env, RELAY_JOBS_HOME: ctx.jobsHome }, timeout: 100000 });
const informational = (entries, name) => entries.filter(entry => !entry.isSidechain && entry.type === 'system' &&
  entry.subtype === 'informational' && typeof entry.content === 'string' && entry.content.startsWith(`relay: ${name} was stopped`));
const turnEnd = (entries, after) => entries.find(entry => !entry.isSidechain && entry.type === 'system' &&
  entry.subtype === 'turn_duration' && Date.parse(entry.timestamp) > Date.parse(after));

const taskStopRequests = (entries, sentAt) => entries.filter(entry => !entry.isSidechain &&
  Date.parse(entry.timestamp) >= Date.parse(sentAt) && (
    entry.type === 'user' && !entry.isMeta && textContent(entry.message?.content) === taskStopLine ||
    entry.type === 'attachment' && entry.attachment?.type === 'queued_command' &&
      entry.attachment.origin?.kind === 'human' && textContent(entry.attachment.prompt) === taskStopLine));
const notification = (entries, receipt) => entries.find(entry => {
  if (entry.isSidechain || !(Date.parse(entry.timestamp) >= Date.parse(receipt.keyAt))) return false;
  const text = entry.type === 'user' ? textContent(entry.message?.content) :
    entry.type === 'attachment' && entry.attachment?.type === 'queued_command' ? textContent(entry.attachment.prompt) : '';
  return text.includes('<task-notification>') && text.includes(`<task-id>${receipt.agentId}</task-id>`) &&
    text.includes('<status>killed</status>');
});
const notificationBar = screen => screen.slice([...screen.matchAll(/^.*─{10,}.*$/gm)].at(-1)?.index ?? screen.length)
  .split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
const skippedLine = (text, agentId, after) => text.split('\n').find(line =>
  line.endsWith(`stop notice skipped for ${agentId}: TaskStop named it`) &&
  Date.parse(line.split(/\s/)[0]) >= Date.parse(after));

function taskStopEnd(entries, sentAt) {
  const request = taskStopRequests(entries, sentAt)[0];
  if (!request) return null;
  const call = transcriptCalls(entries).calls.find(call => call.name === 'TaskStop' &&
    Date.parse(call.timestamp) >= Date.parse(request.timestamp));
  if (!call) return null;
  const context = entries.find(entry => !entry.isSidechain && entry.attachment?.type === 'hook_additional_context' &&
    entry.attachment.hookName === 'PostToolUse:TaskStop' && entry.attachment.toolUseID === call.id);
  return context && Date.parse(context.timestamp) >= Date.parse(call.timestamp) ? turnEnd(entries, context.timestamp) : null;
}

function agents(parsed, backend) {
  const spawns = parsed.spawns.filter(agent => agent.backend === backend);
  if (spawns.length !== 3 || names.some(name => spawns.filter(agent => agent.name === name).length !== 1)) {
    throw new Error('Expected exactly three relays named stop-x, stop-esc and stop-ts.');
  }
  return names.map(name => spawns.find(agent => agent.name === name));
}

function cancelledByTaskStop(input, agent, loaded, entries, parsed, results, sentAt) {
  const { job, jobDir } = loaded;
  const calls = parsed.calls.filter(call => call.name === 'TaskStop');
  const call = calls[0];
  if (calls.length !== 1 || ![agent.name, agent.agentId].includes(call.input?.task_id) ||
      !(Date.parse(call.timestamp) >= Date.parse(sentAt))) throw new Error('Expected exactly one TaskStop for stop-ts after the request.');
  const result = results.get(call.id);
  if (!result || result.is_error) throw new Error('Missing or failed TaskStop result.');
  if ((result.result ?? JSON.parse(textContent(result.content)))?.task_id !== agent.agentId) throw new Error('TaskStop result names another relay.');
  const contexts = entries.filter(entry => !entry.isSidechain && entry.type === 'attachment' &&
    entry.attachment?.type === 'hook_additional_context' && entry.attachment.hookName === 'PostToolUse:TaskStop' &&
    entry.attachment.toolUseID === call.id &&
    (Array.isArray(entry.attachment.content) ? entry.attachment.content.join('\n') : String(entry.attachment.content ?? ''))
      .startsWith(`TaskStop stopped the relay:job agent ${agent.agentId}, and the relay hook cancelled its job ${job.id}:\n`));
  if (!job.id || !contexts.length) throw new Error('No successful hook context for this TaskStop naming the job.');
  const attempt = lastActiveAttempt(job, call.timestamp, input.relayVersion, { endedAtBoundary: true });
  if (job.state !== 'cancelled' || attempt.state !== 'cancelled') throw new Error('TaskStop job and active attempt are not cancelled.');
  const cancels = new Map([...(job.messages ?? []), ...inboxMessages(jobDir)]
    .filter(message => message.kind === 'cancel').map(message => [message.id, message]));
  if (cancels.size !== 1) throw new Error('Expected exactly one TaskStop cancel message.');
  const message = [...cancels.values()][0];
  if (!message.id || !(Date.parse(message.createdAt) >= Date.parse(call.timestamp)) ||
      !contexts.some(entry => Date.parse(message.createdAt) <= Date.parse(entry.timestamp))) throw new Error('No cancel message between TaskStop and its hook context.');
  const outcome = readJson(path.join(jobDir, 'inbox/outcomes', `${path.basename(message.id)}.json`), true);
  if (outcome?.messageId !== message.id || outcome.action !== 'cancelled') throw new Error('Cancel message has no cancelled outcome.');
  const recorded = readTranscript(path.join(jobDir, 'relay-handbacks.jsonl')).filter(entry => entry.by === 'TaskStop');
  if (recorded.length !== 1 || recorded[0].agentId !== agent.agentId || recorded[0].state !== 'cancelled' ||
      recorded[0].attempts !== job.attempts.length || !(Date.parse(recorded[0].at) >= Date.parse(call.timestamp))) {
    throw new Error('The TaskStop hook recorded no hand-back of the cancelled job.');
  }
  const seconds = (Date.parse(job.completedAt) - Date.parse(call.timestamp)) / 1000;
  if (!(seconds >= 0 && seconds <= 15)) throw new Error('Cancellation was not within 0 to 15 seconds of TaskStop.');
  return seconds;
}

function runsOn(input, agent, { job, jobDir }, receipt) {
  if (receipt?.agentId !== agent.agentId || receipt.jobId !== job.id || !Number.isFinite(Date.parse(receipt.keyAt))) {
    throw new Error(`Missing stop receipt for ${agent.name}.`);
  }
  const after = receipt.after;
  if (after?.state !== 'running' || !(Date.parse(after.at) - Date.parse(receipt.keyAt) >= 15000)) {
    throw new Error(`No running observation at least 15 seconds after ${agent.name}'s stop.`);
  }
  const attempt = lastActiveAttempt(job, receipt.keyAt, input.relayVersion);
  const cancels = [...(job.messages ?? []), ...inboxMessages(jobDir)].filter(message => message.kind === 'cancel');
  const cleanupAt = Date.parse(receipt.cleanupAt);
  if (cancels.some(message => !(Date.parse(message.createdAt ?? message.at) >= cleanupAt)) ||
      (receipt.cleanupAt && !(cleanupAt >= Date.parse(after.at)))) throw new Error(`Early cancellation of ${agent.name}.`);
  if (job.state !== 'cancelled' || attempt.state !== 'cancelled' || !Number.isFinite(cleanupAt) ||
      !(Date.parse(attempt.endedAt) >= cleanupAt) || !(Date.parse(job.completedAt) >= cleanupAt)) {
    throw new Error(`${agent.name}'s job did not run on until check cleanup.`);
  }
  const messages = new Map(cancels.map(message => [message.id, message]));
  const message = [...messages.values()][0];
  const outcome = message?.id && readJson(path.join(jobDir, 'inbox/outcomes', `${path.basename(message.id)}.json`), true);
  if (messages.size !== 1 || outcome?.messageId !== message?.id || outcome?.action !== 'cancelled') {
    throw new Error(`Missing cancelled cleanup receipt for ${agent.name}.`);
  }
}

export async function driveStops(ctx, { drive = pane, sleep = pause, now = Date.now, check = () => {},
  beforeStop = () => {}, beforeTaskStop = () => {}, submitted = () => false,
  entries = () => [], record = () => {} } = {}) {
  const options = { agentCount: 3, drive, sleep, now, check };
  const receipt = key => ctx.run.stopNotice.codex[key];
  const poll = async (nav, value, kind, ready, timeoutMs) => {
    const startedAt = new Date(now()).toISOString(), deadline = now() + timeoutMs;
    let found, reads = 1;
    while (true) {
      check();
      try { found = ready(value); }
      catch (error) { if (!error.message.startsWith('Invalid JSON at ')) throw error; }
      if (found || now() >= deadline) break;
      await sleep(Math.min(250, deadline - now()));
      value = nav.screen(); reads++;
    }
    const detail = { startedAt, at: new Date(now()).toISOString(), elapsedMs: now() - Date.parse(startedAt),
      timeoutMs, reads, found: Boolean(found), source: found || null, screen: nav.screenFile };
    record(kind, detail);
    nav.verify(value, () => Boolean(found), `${kind} within ${timeoutMs / 1000} seconds`);
    return value;
  };
  const idle = (nav, value, key, phase) => {
    let quietSince, endedAt;
    return poll(nav, value, `${key}-${phase}-idle`, screen => {
      const rows = entries().filter(entry => !entry.isSidechain);
      const event = notification(rows, receipt(key));
      const end = rows.findLastIndex(entry => entry.type === 'system' && entry.subtype === 'turn_duration');
      const pending = rows.slice(end + 1).some(entry => ['user', 'assistant', 'queued_command'].includes(entry.type) ||
        entry.type === 'attachment' && entry.attachment?.type === 'queued_command');
      const busy = /esc to interrupt|^[ \t]*[✢✳✶✻✽*·].*…/mu.test(screen);
      if (!event || end <= rows.indexOf(event) || !(Date.parse(rows[end].timestamp) > Date.parse(event.timestamp)) || pending || busy) {
        quietSince = endedAt = undefined;
        return false;
      }
      // The stopped line precedes the notification turn, and an old turn end cannot prove the screen is quiet.
      if (endedAt !== rows[end].timestamp) quietSince = undefined;
      endedAt = rows[end].timestamp;
      quietSince ??= now();
      return now() - quietSince >= 1000 && 'turn_duration';
    }, 30000);
  };
  const main = async (nav, value) => {
    if (nav.prompt('main')(value)) return value;
    if (nav.cursor(value) === null) value = await nav.key('Down', next => nav.cursor(next) !== null, 'a selected footer row');
    await nav.walk(value, 'Up', nav.selected('main'), 'selector on main');
    await nav.key('Enter', next => nav.selected('main')(next) && nav.rows(next).some(row => row.name === 'main' && row.viewed) &&
      !next.includes('Message @'), 'the main view with selector on main');
    return nav.key('Up', nav.prompt('main'), 'the main prompt');
  };
  const x = viewNavigation(ctx, 'stop-x', () => taskStopLine, options);
  const initial = x.screen();
  x.verify(initial, x.prompt('main'), 'the main prompt');
  const selected = await x.walk(initial, 'Down', x.selected('stop-x'), 'selector on stop-x');
  x.verify(selected, value => /\bx to stop\b/.test(value), 'x to stop on stop-x');
  check(); beforeStop('x');
  let stopped = await x.key('x', value => !x.rows(value).some(row => row.name === 'stop-x') ||
    (x.selected('stop-x')(value) && /\bx to clear\b/.test(value)), 'stop-x stopped in the footer', 15000);
  stopped = await poll(x, stopped, 'x-toast', value =>
    notificationBar(value).includes(noticeText('stop-x', receipt('x').jobId)) && 'notification-bar', 15000);
  stopped = await idle(x, stopped, 'x', 'main');
  const mainAfterX = await main(x, stopped);

  const esc = viewNavigation(ctx, 'stop-esc', () => taskStopLine, options);
  await esc.walk(mainAfterX, 'Down', esc.selected('stop-esc'), 'selector on stop-esc');
  const opened = await esc.key('Enter', value => esc.viewPrompt(value) &&
    esc.rows(value).some(row => row.name === 'stop-esc' && row.viewed), "stop-esc's view");
  await esc.walk(opened, 'Up', esc.prompt('stop-esc'), "stop-esc's prompt");
  check(); beforeStop('esc');
  const interrupted = await esc.key('Escape', value => esc.prompt('stop-esc')(value) && /\bInterrupted\b/.test(value),
    "stop-esc's interrupted prompt", 15000);
  const quiet = await idle(esc, interrupted, 'esc', 'main');
  await main(esc, quiet);

  const lead = viewNavigation(ctx, 'main', () => taskStopLine, options);
  const ready = await idle(lead, lead.screen(), 'esc', 'send');
  lead.verify(ready, lead.prompt('main'), 'the main prompt before TaskStop');
  check(); beforeTaskStop();
  await lead.key('send', value => lead.prompt('main')(value) && submitted(), 'the main TaskStop request in the transcript', 15000);
}

export default {
  id: 'stop-notice', title: 'Stop relay agents from Claude Code controls; their jobs run on',
  surfaces: ['terminal'], probes: [], backends: ['codex'], timeoutMinutes: 15, marker: 'LIVE-STOP-NOTICE-READY',
  prompt({ runId }) {
    const calls = names.map(name => `Agent(${JSON.stringify({ subagent_type: 'relay:job', name, description: name,
      run_in_background: true, prompt: `model: ${MODELS.codex}\neffort: low\n---\nRun the shell command \`sleep 240\` exactly once and wait for it. Then reply done.` })})`).join('\n');
    return opening(runId, calls).replace('exactly one background relay:job agent per backend', 'exactly three background relay:job agents') +
      waitRunning(names) + `\nPrint exactly this line by itself and end your turn:\n${this.marker}\n` +
      'Later you will be asked to stop one agent with TaskStop. Do exactly that and nothing else, then end your turn. ' +
      'Until then do not stop, cancel, message or respawn any agent. Acknowledge completion notices in one line only.\n';
  },
  completed(entries) { return hasMarker(entries, this.marker); },
  async runTerminal(ctx, dependencies = {}) {
    const { drive = pane, sleep = pause, now = Date.now, companionRunner = companion, signal } = dependencies;
    const { run } = ctx;
    const deadline = now() + ctx.timeoutMinutes * 60000;
    const input = () => ({ ...run, jobsHome: ctx.jobsHome, evidenceDir: ctx.evidenceDir });
    const entries = () => scopeToRun(readTranscript(run.transcript), run.runId);
    const evidence = { agents: [], transcripts: [] }, started = new Map();
    const check = () => {
      signal?.throwIfAborted();
      if (run.interrupted) throw new Error('Interrupted.');
      if (now() >= deadline) throw new Error('Timed out waiting for stop-notice.');
    };
    const waitFor = async (ready, why, timeoutMs = 30000) => {
      const bound = Math.min(deadline, now() + timeoutMs);
      while (true) {
        check();
        try { if (ready()) return; }
        catch (error) { if (!error.message.startsWith('Invalid JSON at ')) throw error; }
        if (now() >= bound) throw new Error(`Timed out waiting for ${why}.`);
        await sleep(Math.min(250, bound - now()));
      }
    };
    const remember = agent => {
      const loaded = relayJob(input(), evidence, agent.agentId);
      const key = agent.name === 'stop-ts' ? 'taskStop' : agent.name.slice(5);
      started.set(loaded.jobDir, { ...loaded, agent, key });
      return loaded;
    };
    let failure;
    try {
      await ctx.paneDriver(ctx, this, { keep: true, drive });
      run.completed = false; run.stopNotice = { codex: {} }; ctx.save();
      check();
      const first = entries();
      if (!this.completed(first)) throw new Error(`Missing ${this.marker}.`);
      for (const agent of agents(transcriptCalls(first), 'codex')) remember(agent);
      const marker = first.find(entry => hasMarker([entry], this.marker));
      await waitFor(() => turnEnd(entries(), marker.timestamp), 'the initial lead turn to end');
      const receipts = run.stopNotice.codex;
      const beforeStop = key => {
        const item = [...started.values()].find(item => item.key === key);
        if (readJob(item.jobDir).state !== 'running') throw new Error(`${item.agent.name}'s job is not running before its stop.`);
        receipts[key] = { agentId: item.agent.agentId, jobId: item.job.id, keyAt: new Date(now()).toISOString() }; ctx.save();
      };
      await driveStops(ctx, { drive, sleep, now, check, beforeStop, entries,
        record(kind, detail) {
          (run.stopNotice.waits ??= []).push({ kind, ...detail });
          if (kind === 'x-toast') receipts.x.toast = detail;
          ctx.save();
        }, beforeTaskStop() {
          const item = [...started.values()].find(item => item.key === 'taskStop');
          if (readJob(item.jobDir).state !== 'running') throw new Error('stop-ts is not running before TaskStop.');
          receipts.taskStop = { text: taskStopLine, sentAt: new Date(now()).toISOString() }; ctx.save();
        }, submitted: () => {
          try { return taskStopRequests(entries(), receipts.taskStop.sentAt).length > 0; }
          catch (error) { if (!error.message.startsWith('Invalid JSON at ')) throw error; return false; }
        } });
      await waitFor(() => taskStopEnd(entries(), receipts.taskStop.sentAt), 'the TaskStop lead turn to end', 120000);
      receipts.taskStop.endedAt = new Date(now()).toISOString(); ctx.save();
      const call = transcriptCalls(entries()).calls.find(call => call.name === 'TaskStop');
      const agent = [...started.values()].find(item => item.key === 'taskStop').agent;
      await waitFor(() => {
        if (!run.debugLog || !fs.existsSync(run.debugLog)) return false;
        const log = fs.readFileSync(run.debugLog, 'utf8');
        if (!skippedLine(log, agent.agentId, call.timestamp)) return false;
        fs.writeFileSync(path.join(ctx.evidenceDir, 'stop-notice-debug.txt'), log);
        return true;
      }, 'the TaskStop marked-agent debug line');
      for (const key of ['x', 'esc']) {
        const item = [...started.values()].find(item => item.key === key);
        await waitFor(() => now() - Date.parse(receipts[key].keyAt) >= 15000, `${item.agent.name}'s observation time`);
        check();
        const status = JSON.parse(await companionRunner(ctx, ['status', item.jobDir, '--json']));
        check();
        receipts[key].after = { at: new Date(now()).toISOString(), state: status.state }; ctx.save();
      }
      await waitFor(() => ['stop-x', 'stop-esc'].every(name => informational(entries(), name).length), 'both stop notices');
      run.completed = true;
    } catch (error) {
      failure = error; run.completed = false; run.error = error.message;
    } finally {
      const save = () => { try { ctx.save(); } catch (error) { run.cleanupError = error.message; } };
      try {
        // Startup can fail after spawning; retain complete rows even if the final write is partial.
        const scanned = [];
        const text = run.transcript && fs.existsSync(run.transcript) ? fs.readFileSync(run.transcript, 'utf8') : '';
        for (const [i, line] of text.split('\n').entries()) {
          if (!line.trim()) continue;
          try { scanned.push(JSON.parse(line)); }
          catch { run.cleanupScanError = `Invalid JSON at ${run.transcript}:${i + 1}`; }
        }
        for (const agent of transcriptCalls(scopeToRun(scanned, run.runId)).spawns) {
          try { remember(agent); }
          catch (error) { run.cleanupScanError = error.message; }
        }
      } catch (error) { run.cleanupScanError = error.message; }
      for (const item of started.values()) {
        const receipt = (((run.stopNotice ??= {})[item.agent.backend] ??= {})[item.key] ??= {});
        try {
          if (['completed', 'failed', 'cancelled'].includes(readJob(item.jobDir).state)) continue;
          receipt.cleanupAt = new Date(now()).toISOString(); save();
          await companionRunner(ctx, ['cancel', item.jobDir]);
          if (!['completed', 'failed', 'cancelled'].includes(readJob(item.jobDir).state)) throw new Error('Job is still running after cleanup cancel.');
        } catch (error) { receipt.cleanupError = error.message; }
        save();
      }
      try { if (run.pane) drive(['stop', run.pane]); }
      catch (error) { run.cleanupError = error.message; }
      run.checkFinishedAt = new Date(now()).toISOString(); save();
    }
    if (failure) throw failure;
    return this.analyze(input());
  },
  analyze(input) {
    return analyzeBackends(input, this.scope, ({ backend, row, entries, parsed, results, evidence }) => {
      const run = readJson(path.join(input.evidenceDir, 'run.json'));
      const spawned = agents(parsed, backend);
      const loaded = spawned.map(agent => relayJob(input, evidence, agent.agentId));
      if (run.runId !== input.runId || !this.completed(entries)) throw new Error('Missing stop-notice run or marker.');
      if (run.error || run.interrupted || run.completed !== true) throw new Error(run.error || 'Stop-notice run did not complete.');
      const receipts = run.stopNotice?.[backend];
      const errors = [run.cleanupError, run.cleanupScanError, ...Object.values(receipts ?? {}).map(receipt => receipt.cleanupError)].filter(Boolean);
      if (errors.length) throw new Error(`Cleanup failed: ${errors.join('; ')}`);
      for (const job of loaded) requireBackend(job.job, backend);
      for (const [i, key] of [[0, 'x'], [1, 'esc']]) {
        const agent = spawned[i], receipt = receipts?.[key];
        const notices = informational(entries, agent.name);
        if (notices.length !== 1 || notices[0].content !== noticeText(agent.name, loaded[i].job.id)) {
          throw new Error(`Expected exactly one exact notice for ${agent.name}, found ${notices.length}.`);
        }
        const seconds = (Date.parse(notices[0].timestamp) - Date.parse(receipt?.keyAt)) / 1000;
        if (!(seconds >= 0)) throw new Error(`Invalid notice timing for ${agent.name}.`);
        if (key === 'x') {
          const toast = receipt?.toast;
          const screen = toast?.screen && path.join(input.evidenceDir, path.basename(toast.screen));
          if (!toast?.found || !(Date.parse(toast.at) >= Date.parse(receipt.keyAt)) ||
              !screen || !fs.existsSync(screen) || !notificationBar(fs.readFileSync(screen, 'utf8')).includes(noticeText(agent.name, loaded[i].job.id))) {
            throw new Error('Missing stop-x toast on the notification bar.');
          }
        }
        runsOn(input, agent, loaded[i], receipt);
        row.timings[`${key}NoticeSeconds`] = [seconds];
      }
      if (informational(entries, 'stop-ts').length) throw new Error('Unexpected notice for stop-ts.');
      const sent = receipts?.taskStop;
      const requests = taskStopRequests(entries, sent?.sentAt);
      row.timings.cancelledSeconds = [cancelledByTaskStop(input, spawned[2], loaded[2], entries, parsed, results, sent?.sentAt)];
      const end = taskStopEnd(entries, sent?.sentAt);
      if (sent?.text !== taskStopLine || requests.length !== 1 || !end ||
          !(Date.parse(sent.endedAt) >= Date.parse(end.timestamp))) throw new Error('Missing main TaskStop request or ended turn.');
      if (receipts.taskStop.cleanupAt) throw new Error('TaskStop job required check cleanup.');
      const debugFile = path.join(input.evidenceDir, 'stop-notice-debug.txt');
      const call = parsed.calls.find(call => call.name === 'TaskStop');
      if (!fs.existsSync(debugFile) || !skippedLine(fs.readFileSync(debugFile, 'utf8'), spawned[2].agentId, call.timestamp)) {
        throw new Error('Missing TaskStop marked-agent debug line for stop-ts after TaskStop.');
      }
    });
  },
  cell(record) {
    return `x to stop: notice in ${formatSeconds(record.timings.xNoticeSeconds ?? [])}, job runs on; ` +
      `Esc: notice in ${formatSeconds(record.timings.escNoticeSeconds ?? [])}, job runs on; TaskStop: no notice, job cancelled`;
  }
};
