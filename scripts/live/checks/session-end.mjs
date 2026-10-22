import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { analyzeBackends, formatSeconds, hasMarker, hasReportLine, inboxMessages, lastActiveAttempt,
  oneRelay, readJson, readTranscript, relayJob, requireBackend, scopeToRun, transcriptCalls } from '../lib/evidence.mjs';
import { pane } from '../lib/terminal.mjs';
import { agentCalls, opening, waitRunning } from './steer-main.mjs';

export function sessionEndCalls(backends) {
  return agentCalls(backends, { prefix: 'session-end', brief: backend =>
    `Run the shell command \`sleep 150\` exactly once and wait for it. Then reply with exactly one line: session-end done for ${backend}` });
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const processes = ({ pid, timeoutMs }) => {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: timeoutMs });
  if (result.error) throw Object.assign(result.error, { signal: result.signal, status: result.status });
  if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return '';
  if (result.status !== 0) throw Object.assign(new Error(`Could not read Claude process start time: ${result.stderr.trim() || result.signal || result.status}`),
    { signal: result.signal, status: result.status });
  return result.stdout.trim();
};
const validPid = identity => Number.isSafeInteger(identity?.pid) && identity.pid > 0 &&
  typeof identity.startedAt === 'string' && Boolean(identity.startedAt.trim());
const companion = (ctx, args, { timeoutMs = 10000 } = {}) => execFileSync(process.execPath, [path.join(ctx.pluginDir, 'scripts/companion.mjs'), ...args],
  { encoding: 'utf8', env: { ...process.env, RELAY_JOBS_HOME: ctx.jobsHome }, timeout: timeoutMs });

export default {
  id: 'session-end',
  title: 'End the Claude session during a job; the job runs on',
  surfaces: ['terminal'],
  probes: [],
  timeoutMinutes: 15,
  marker: 'LIVE-SESSION-END-READY',
  prompt({ runId, backends }) {
    return opening(runId, sessionEndCalls(backends)) + waitRunning(backends) +
      '\nPrint exactly this line by itself and end the turn without waiting for any completion notice:\nLIVE-SESSION-END-READY\n';
  },
  completed(entries) { return hasMarker(entries, this.marker); },
  async runTerminal(ctx, dependencies = {}) {
    const { now = Date.now, sleep = pause, processRunner = processes, companionRunner = companion, drive = pane } = dependencies;
    const run = ctx.run;
    let aborted = false, listening = false;
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const abort = () => { aborted = true; };
    const checkAbort = () => {
      if (aborted || run.interrupted) { run.interrupted = true; throw new Error('Interrupted.'); }
    };
    const wait = async ms => {
      const until = now() + ms;
      while (now() < until) {
        checkAbort();
        await sleep(Math.min(250, until - now()));
      }
      checkAbort();
    };
    try {
      delete run.claudePid;
      delete run.claudePidError;
      await ctx.paneDriver(ctx, this, { keep: false, drive(args, input) {
        if (args[0] !== 'stop') return drive(args, input);
        try {
          const raw = String(drive(['pid', args[1]])).trim();
          const pid = /^\d+$/.test(raw) ? Number(raw) : null;
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Missing Claude pane pid.');
          const result = processRunner({ pid, timeoutMs: 5000 });
          // The driver's drive call is synchronous; only the later wait loop can await this runner.
          if (typeof result?.then === 'function') throw new Error('processRunner must be synchronous in the stop wrapper.');
          const identity = { pid, startedAt: String(result).trim() };
          if (!validPid(identity)) throw new Error('Missing Claude process start time.');
          run.claudePid = identity;
          ctx.save();
        } catch (error) {
          delete run.claudePid;
          run.claudePidError = error.message;
          if (signals.includes(error.signal)) aborted = true;
          ctx.save();
        } finally { drive(args, input); }
      } });
      for (const signal of signals) process.on(signal, abort);
      listening = true;
      checkAbort();
      const entries = (this.scope ?? scopeToRun)(readTranscript(run.transcript), run.runId);
      if (!this.completed(entries)) throw new Error(`Session ended without ${this.marker}.`);
      if (!validPid(run.claudePid)) throw new Error(`Missing Claude pane pid and start time.${run.claudePidError ? ` ${run.claudePidError}` : ''}`);
      const deadline = now() + 15000;
      while (true) {
        checkAbort();
        const startedAt = String(await processRunner({ pid: run.claudePid.pid,
          timeoutMs: Math.max(1, Math.min(5000, deadline - now())) })).trim();
        checkAbort();
        if (now() > deadline) throw new Error('Timed out waiting for the Claude process to end.');
        if (startedAt !== run.claudePid.startedAt) break;
        if (now() >= deadline) throw new Error('Timed out waiting for the Claude process to end.');
        await wait(Math.min(250, deadline - now()));
      }
      run.sessionEndedAt = new Date(now()).toISOString();
      ctx.save();
      const input = { runId: run.runId, backends: run.backends, surface: run.surface, relayVersion: run.relayVersion,
        transcript: run.transcript, jobsHome: ctx.jobsHome, evidenceDir: ctx.evidenceDir };
      const parsed = transcriptCalls(entries), evidence = { agents: [], transcripts: [] };
      const jobs = run.backends.map(backend => {
        const agent = oneRelay(parsed, backend, 'session-end');
        return { ...agent, ...relayJob(input, evidence, agent.agentId) };
      });
      await wait(20000);
      run.afterEnd = {};
      const status = async (job, timeoutMs = 10000) => {
        checkAbort();
        const result = await companionRunner(ctx, ['status', job.jobDir, '--json'], { timeoutMs });
        checkAbort();
        return JSON.parse(result);
      };
      for (const job of jobs) {
        const result = await status(job);
        run.afterEnd[job.agentId] = { at: new Date(now()).toISOString(), state: result.state };
        ctx.save();
      }
      const waitDeadline = now() + 360000;
      const pending = new Set(jobs);
      while (pending.size) {
        if (now() >= waitDeadline) throw new Error('Timed out waiting for jobs after the session ended.');
        for (const job of pending) {
          if (now() >= waitDeadline) throw new Error('Timed out waiting for jobs after the session ended.');
          const result = await status(job, Math.max(1, Math.min(10000, waitDeadline - now())));
          if (now() > waitDeadline) throw new Error('Timed out waiting for jobs after the session ended.');
          if (['completed', 'failed', 'cancelled'].includes(result.state)) pending.delete(job);
        }
        ctx.save();
        if (pending.size) await wait(Math.min(1000, waitDeadline - now()));
      }
      ctx.save();
      const analysis = this.analyze(input);
      checkAbort();
      return analysis;
    } catch (error) {
      if (aborted || run.interrupted || signals.includes(error.signal)) { run.interrupted = true; error = new Error('Interrupted.'); }
      run.error = error.message;
      ctx.save();
      throw error;
    } finally {
      if (listening) for (const signal of signals) process.off(signal, abort);
    }
  },
  analyze(input) {
    return analyzeBackends(input, this.scope, ({ backend, row, allEntries, parsed, evidence }) => {
      const run = readJson(path.join(input.evidenceDir, 'run.json'));
      if (run.runId !== input.runId || !Number.isFinite(Date.parse(run.sessionEndedAt))) throw new Error('Missing sessionEndedAt for this run.');
      if (allEntries.some(entry => !entry.isSidechain && Date.parse(entry.timestamp) > Date.parse(run.sessionEndedAt))) {
        throw new Error('Lead transcript entry is later than sessionEndedAt.');
      }
      const agent = oneRelay(parsed, backend, 'session-end');
      const { job, jobDir } = relayJob(input, evidence, agent.agentId);
      Object.assign(row, { agentId: agent.agentId, jobDir });
      requireBackend(job, backend);
      const attempt = lastActiveAttempt(job, run.sessionEndedAt, input.relayVersion);
      const after = run.afterEnd?.[agent.agentId];
      if (after?.state !== 'running' || !(Date.parse(after.at) - Date.parse(run.sessionEndedAt) >= 15000)) {
        throw new Error('No running observation at least 15 seconds after the session ended.');
      }
      const seconds = (Date.parse(job.completedAt) - Date.parse(run.sessionEndedAt)) / 1000;
      if (job.state !== 'completed' || attempt.state !== 'completed' || !(seconds > 0) ||
          !(Date.parse(attempt.endedAt) > Date.parse(after.at)) || !(Date.parse(job.completedAt) > Date.parse(after.at))) {
        throw new Error('Job did not complete in the same attempt after the running observation.');
      }
      if ([...(job.messages ?? []), ...inboxMessages(jobDir)].some(message => message.kind === 'cancel')) throw new Error('Job has a cancel message.');
      if (!hasReportLine(fs.readFileSync(path.join(jobDir, 'report.md'), 'utf8'), `session-end done for ${backend}`)) throw new Error('Report is missing the session-end line.');
      if (!validPid(run.claudePid)) throw new Error('Missing claudePid and process start time for this run.');
      row.timings.ranOnSeconds = [seconds];
    });
  },
  cell(record) { return `ran on and completed ${formatSeconds(record.timings.ranOnSeconds ?? [])} after the session ended`; }
};
