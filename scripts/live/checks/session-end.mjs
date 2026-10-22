import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeBackends, formatSeconds, hasMarker, hasReportLine, inboxMessages, lastActiveAttempt,
  oneRelay, readJson, readTranscript, relayJob, scopeToRun, transcriptCalls } from '../lib/evidence.mjs';
import { agentCalls, opening, waitRunning } from './steer-main.mjs';

export function sessionEndCalls(backends) {
  return agentCalls(backends, { prefix: 'session-end', brief: backend =>
    `Run the shell command \`sleep 150\` exactly once and wait for it. Then reply with exactly one line: session-end done for ${backend}` });
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const processes = ({ timeoutMs }) => execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8', timeout: timeoutMs });
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
    const { now = Date.now, sleep = pause, processRunner = processes, companionRunner = companion } = dependencies;
    const run = ctx.run;
    try {
      await ctx.paneDriver(ctx, this, { keep: false });
      const entries = (this.scope ?? scopeToRun)(readTranscript(run.transcript), run.runId);
      if (!this.completed(entries)) throw new Error(`Session ended without ${this.marker}.`);
      if (!run.sessionId) throw new Error('Missing Claude session id.');
      const deadline = now() + 15000;
      while (String(await processRunner({ timeoutMs: Math.max(1, Math.min(5000, deadline - now())) })).split('\n').some(line => {
        const words = line.trim().split(/\s+/);
        return words.some((word, i) => word === '--session-id' && words[i + 1] === run.sessionId);
      })) {
        if (now() >= deadline) throw new Error('Timed out waiting for the Claude process to end.');
        await sleep(Math.min(250, deadline - now()));
      }
      if (now() > deadline) throw new Error('Timed out waiting for the Claude process to end.');
      run.sessionEndedAt = new Date(now()).toISOString();
      ctx.save();
      const input = { runId: run.runId, backends: run.backends, surface: run.surface, relayVersion: run.relayVersion,
        transcript: run.transcript, jobsHome: ctx.jobsHome, evidenceDir: ctx.evidenceDir };
      const parsed = transcriptCalls(entries), evidence = { agents: [], transcripts: [] };
      const jobs = run.backends.map(backend => {
        const agent = oneRelay(parsed, backend, 'session-end');
        return { ...agent, ...relayJob(input, evidence, agent.agentId) };
      });
      await sleep(20000);
      run.afterEnd = {};
      const status = async (job, timeoutMs = 10000) => JSON.parse(await companionRunner(ctx, ['status', job.jobDir, '--json'], { timeoutMs }));
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
        if (pending.size) await sleep(Math.min(1000, waitDeadline - now()));
      }
      ctx.save();
      return this.analyze(input);
    } catch (error) {
      run.error = error.message;
      ctx.save();
      throw error;
    }
  },
  analyze(input) {
    return analyzeBackends(input, this.scope, ({ backend, row, parsed, evidence }) => {
      const run = readJson(path.join(input.evidenceDir, 'run.json'));
      if (run.runId !== input.runId || !Number.isFinite(Date.parse(run.sessionEndedAt))) throw new Error('Missing sessionEndedAt for this run.');
      const agent = oneRelay(parsed, backend, 'session-end');
      const { job, jobDir } = relayJob(input, evidence, agent.agentId);
      Object.assign(row, { agentId: agent.agentId, jobDir });
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
      row.timings.ranOnSeconds = [seconds];
    });
  },
  cell(record) { return `ran on and completed ${formatSeconds(record.timings.ranOnSeconds ?? [])} after the session ended`; }
};
