import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commandRuns, moduleText, statusRows, readJob, readTranscript, scopeToRun, MODELS, formatSeconds } from '../lib/evidence.mjs';
import { sessionEnvironment } from '../lib/terminal.mjs';
import { cancelTimeout } from '../lib/runs.mjs';

export function commandPrompt(runId, marker) {
  return `Live suite run ${runId}.\nThis run checks relay's slash commands, which come as the next messages. Do not run any tool. Reply with exactly this line and nothing else:\n${marker}\n`;
}

export async function setupJobs(ctx, running, { env = process.env, execute = promisify(execFile),
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, signal } = {}) {
  const companion = path.join(ctx.pluginDir, 'scripts/companion.mjs');
  const options = { cwd: ctx.workDir, env: { ...sessionEnvironment(env).env, RELAY_JOBS_HOME: ctx.jobsHome },
    encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 };
  ctx.run.setup = { jobs: {}, decoys: {} };
  const started = [];
  const remember = (stdout, backend, kind, decoy) => {
    const id = stdout?.match(/^job: (.+)$/m)?.[1], dir = stdout?.match(/^dir: (.+)$/m)?.[1];
    if (id && !started.includes(id)) started.push(id);
    if (!id || !dir) throw new Error(`No job id or directory from start for ${backend} ${kind}.`);
    const jobDir = path.relative(ctx.jobsHome, path.resolve(ctx.workDir, dir));
    if (jobDir.startsWith('..') || path.isAbsolute(jobDir)) throw new Error('Started job is outside jobsHome.');
    const receipt = { id, jobDir };
    (decoy ? ctx.run.setup.decoys : (ctx.run.setup.jobs[backend] ??= {}))[kind] = receipt;
    ctx.save();
    return receipt;
  };
  try {
    for (const kind of ['done', 'running']) {
      const targets = (kind === 'done' || running ? ctx.backends : []).map(backend => ({ backend, decoy: false }));
      targets.push({ backend: ctx.backends[0], decoy: true });
      for (const { backend, decoy } of targets) {
        signal?.throwIfAborted();
        const prompt = `${backend === 'codex' ? '' : `backend: ${backend}\n`}model: ${MODELS[backend]}\neffort: low\n---\n` +
          (kind === 'done' ? (decoy ? 'Reply with exactly one line: decoy.' : `Reply with exactly one line: done for ${backend}. Do not run any command.`) :
            'Run the shell command `sleep 600` exactly once, and wait for it to finish. Then reply with one line: slept.');
        const file = path.join(ctx.evidenceDir, `${backend}-${decoy ? 'decoy-' : ''}${kind}.txt`);
        fs.writeFileSync(file, prompt + '\n');
        let output;
        // Let start return its job receipt even on interruption, so cleanup knows what it started.
        try { output = await execute(process.execPath, [companion, 'start', '--prompt-file', file], options); }
        catch (error) {
          if (error.stdout) remember(error.stdout, backend, kind, decoy);
          throw error;
        }
        const receipt = remember(output.stdout, backend, kind, decoy), deadline = now() + 240000;
        let ready = false;
        while (now() < deadline) {
          signal?.throwIfAborted();
          const job = readJob(path.join(ctx.jobsHome, receipt.jobDir));
          if (kind === 'done' ? job.state === 'completed' : job.state === 'running' && job.attempts?.length) { ready = true; break; }
          if (['failed', 'cancelled', 'completed'].includes(job.state)) throw new Error(`${backend} ${kind} ended ${job.state}.`);
          await pause(1000);
        }
        if (!ready) throw new Error(`Timed out waiting for ${backend} ${kind}.`);
      }
    }
    signal?.throwIfAborted();
  } catch (error) {
    ctx.run.setup.cancellations = [];
    for (const id of started) {
      const receipt = { jobId: id, status: 'cancelled' };
      try { await execute(process.execPath, [companion, 'cancel', id], { ...options, timeout: cancelTimeout(env) }); }
      catch (failure) { receipt.status = 'failed'; receipt.error = failure.message; }
      ctx.run.setup.cancellations.push(receipt);
    }
    ctx.save();
    throw error;
  }
}

export function plannedCommands(run) {
  return [{ text: '/relay:status', backend: null },
    ...run.backends.map(backend => ({ text: `/relay:result ${run.setup?.jobs[backend]?.done?.id}`, backend })),
    ...run.backends.map(backend => ({ text: `/relay:cancel ${run.setup?.jobs[backend]?.running?.id}`, backend })),
    { text: '/relay:status', backend: null }];
}

export function requireCommand(row, text) {
  // The transcript holds the command without its arguments (see commandRuns).
  if (!row || `/${row.command}` !== text.split(' ')[0] || !row.answer) throw new Error(`Missing answer to ${text}.`);
  if (row.plugin !== 'relay') throw new Error(`${text} was not answered by relay.`);
  if (!row.noModelReply) throw new Error(`Model reply after ${text}.`);
  if (row.seconds === null || row.seconds < 0) throw new Error(`Missing or invalid start time for ${text}.`);
  const parsed = moduleText(row.text);
  if (!parsed) throw new Error(`Invalid module text for ${text}.`);
  if (parsed.command !== text) throw new Error(`Echoed command ${JSON.stringify(parsed.command)} does not match ${text}.`);
  return parsed;
}

export function setupJob(input, backend, kind, evidence, result) {
  const saved = input.run?.setup?.jobs?.[backend]?.[kind];
  if (!saved?.id || !saved.jobDir || path.isAbsolute(saved.jobDir) || saved.jobDir.split(path.sep).includes('..')) {
    throw new Error(`Missing setup job for ${backend} ${kind}.`);
  }
  if (!evidence.agents.some(agent => agent.jobDir === saved.jobDir)) evidence.agents.push({ jobDir: saved.jobDir });
  const dir = path.join(input.jobsHome, saved.jobDir), job = readJob(dir);
  const model = job.request?.model ?? job.model ?? null, version = job.attempts?.at(-1)?.relayVersion ?? null;
  result.model ??= model;
  result.relayVersion ??= version;
  if (version !== input.relayVersion) { result.relayVersion = version; throw new Error(`Job relayVersion ${version} does not match ${input.relayVersion}.`); }
  if (job.id !== saved.id) throw new Error('Job id does not match setup.');
  if ((job.request?.backend ?? job.backend ?? 'codex') !== backend) throw new Error('Job backend does not match setup.');
  if (model !== MODELS[backend]) throw new Error(`Job model ${model} does not match ${MODELS[backend]}.`);
  return { ...saved, dir, job };
}

export function requireResult(parsed, job) {
  if (!parsed.verbatim.split('\n').includes('state: completed') ||
      !parsed.verbatim.split('\n').includes(`job: ${job.id}`) || job.job.state !== 'completed') throw new Error('Result has the wrong job or state.');
  let report;
  try { report = fs.readFileSync(path.join(job.dir, 'report.md'), 'utf8'); }
  catch { throw new Error('Cannot read report.md.'); }
  if (parsed.report !== report) throw new Error('Result report differs from report.md.');
}

export function requireStatus(parsed, job, state) {
  const rows = statusRows(parsed.table).filter(row => row.job === job.id);
  if (rows.length !== 1 || rows[0].state !== state) throw new Error(`Status for ${job.id} is not ${state}.`);
}

export function setupEvidence(run) {
  return [...Object.values(run.setup?.jobs ?? {}).flatMap(jobs => Object.values(jobs)), ...Object.values(run.setup?.decoys ?? {})]
    .filter(job => typeof job.jobDir === 'string' && !path.isAbsolute(job.jobDir) && !job.jobDir.split(path.sep).includes('..'))
    .map(({ jobDir }) => ({ jobDir }));
}

export function statusBuild(parsed) {
  const lines = parsed.verbatim.split('\n').filter(line => line.startsWith('relay-version:'));
  const match = lines.length === 1 && lines[0].match(/^relay-version: (\S+?)(?: \(([a-f0-9]{12}(?:-dirty)?)\))?$/i);
  return { relayVersion: match?.[1] ?? null, relayCommit: match?.[2] ?? null };
}

export function requireBuild(parsed, run) {
  const build = statusBuild(parsed);
  if (build.relayVersion !== run.relayVersion) throw new Error(`Status relay-version does not match ${run.relayVersion}.`);
  if ((run.surface === 't3' && !build.relayCommit) || (build.relayCommit && build.relayCommit !== run.relayCommit)) {
    throw new Error(`Status relay-version commit ${build.relayCommit ?? '(missing)'} does not match ${run.relayCommit}.`);
  }
  return build;
}

export function commandResult(backend) {
  return { backend, model: null, relayVersion: null, delivery: null, timings: {}, result: 'fail', reason: null };
}

export default {
  id: 'commands', title: 'Answer /relay:status, /relay:result and /relay:cancel with no model turn',
  surfaces: ['terminal', 't3'], probes: [], timeoutMinutes: 15, marker: 'LIVE-COMMANDS-READY',
  prompt({ runId }) { return commandPrompt(runId, this.marker); },
  setup(ctx, dependencies) { return setupJobs(ctx, true, dependencies); },
  commands: plannedCommands,
  analyze(input) {
    const entries = (this.scope ?? scopeToRun)(readTranscript(input.transcript), input.runId);
    const rows = commandRuns(entries, input.run), plan = this.commands(input.run);
    const evidence = { transcripts: [input.transcript], agents: setupEvidence(input.run) }, details = [];
    const results = input.backends.map(backend => {
      const result = commandResult(backend);
      try {
        const done = setupJob(input, backend, 'done', evidence, result);
        const running = setupJob(input, backend, 'running', evidence, result);
        if (rows.length !== plan.length) throw new Error(`Expected ${plan.length} command inputs, found ${rows.length}.`);
        const relevant = plan.map((command, index) => ({ ...command, index })).filter(command => command.backend === null || command.backend === backend);
        const parsed = relevant.map(command => requireCommand(rows[command.index], command.text));
        requireBuild(parsed[0], input.run);
        requireStatus(parsed[0], done, 'completed');
        requireStatus(parsed[0], running, 'running');
        requireResult(parsed[1], done);
        const cancelled = parsed[2].verbatim.split('\n');
        if (!cancelled.includes(`job: ${running.id}`)) throw new Error('Cancel shows another job.');
        if (!cancelled.includes('state: cancelled') || running.job.state !== 'cancelled') throw new Error('Cancel has the wrong state.');
        requireStatus(parsed[3], running, 'cancelled');
        result.timings = { answeredSeconds: [0, 1, 3].map(index => rows[relevant[index].index].seconds),
          cancelledSeconds: [rows[relevant[2].index].seconds] };
        result.result = 'pass';
      } catch (error) { result.reason = error.message; }
      details.push({ backend, commands: rows, reason: result.reason });
      return result;
    });
    return { results, details, evidence };
  },
  cell(record) {
    return `no model turn; answered in ${formatSeconds(record.timings.answeredSeconds ?? [])}, cancelled in ${formatSeconds(record.timings.cancelledSeconds ?? [])}`;
  }
};
