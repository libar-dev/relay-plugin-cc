import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commandRuns, moduleText, readTranscript, formatSeconds } from '../lib/evidence.mjs';
import { configDirectory } from '../lib/runs.mjs';
import { sessionEnvironment } from '../lib/terminal.mjs';
import { setupJobs, setupJob, setupEvidence, commandResult, requireCommand, requireResult, requireStatus } from './commands.mjs';

export function headlessCommands(run) {
  return [...run.backends.map(backend => ({ text: `/relay:result ${run.setup?.jobs[backend]?.done?.id}`, backend })),
    { text: '/relay:status', backend: null }];
}

export async function runHeadless(ctx, { env = process.env, execute = promisify(execFile), uuid = randomUUID } = {}) {
  const clean = sessionEnvironment(env);
  ctx.run.removedEnvironment = clean.removed;
  ctx.run.headless = [];
  for (const command of headlessCommands(ctx.run)) {
    const sessionId = uuid(), index = ctx.run.headless.length;
    const transcript = path.join(configDirectory(env), 'projects', ctx.workDir.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
    const stream = path.join(ctx.evidenceDir, `headless-${index}.jsonl`);
    const receipt = { ...command, sessionId, transcript, stream, exitCode: null, finished: false };
    ctx.run.headless.push(receipt);
    ctx.run.promptSentAt ??= new Date().toISOString();
    ctx.run.transcript ??= transcript;
    ctx.save();
    let output;
    try {
      output = await execute('claude', ['-p', command.text, '--output-format', 'stream-json', '--verbose',
        '--plugin-dir', ctx.pluginDir, '--session-id', sessionId, '--model', 'sonnet'],
      { cwd: ctx.workDir, env: { ...clean.env, RELAY_JOBS_HOME: ctx.jobsHome }, timeout: 120000,
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      receipt.exitCode = 0;
    } catch (error) {
      output = error;
      receipt.exitCode = Number.isInteger(error.code) ? error.code : null;
      receipt.error = error.message;
    }
    if (!fs.existsSync(transcript)) {
      receipt.expectedTranscript = transcript;
      receipt.transcript = path.join(ctx.evidenceDir, `headless-${index}-missing-transcript.jsonl`);
      fs.writeFileSync(receipt.transcript, '');
      if (ctx.run.transcript === transcript) ctx.run.transcript = receipt.transcript;
    }
    fs.writeFileSync(stream, output.stdout ?? '');
    fs.writeFileSync(path.join(ctx.evidenceDir, `headless-${index}.stderr.txt`), output.stderr ?? '');
    receipt.finished = true;
    ctx.save();
  }
  ctx.run.completed = true;
  ctx.save();
}

export default {
  id: 'headless', title: 'Answer /relay:result and /relay:status in claude -p with no model turn',
  surfaces: ['terminal'], probes: [], timeoutMinutes: 15, entrypoints: { terminal: ['sdk-cli'] },
  scope: entries => entries,
  prompt: ({ runId }) => `Live suite run ${runId}.\n`,
  setup(ctx, dependencies) { return setupJobs(ctx, false, dependencies); },
  runTerminal: runHeadless,
  completed(entries, run) {
    const plan = headlessCommands(run);
    return run.headless?.length === plan.length && plan.every((command, index) =>
      run.headless[index].finished && run.headless[index].text === command.text && run.headless[index].backend === command.backend);
  },
  analyze(input) {
    const evidence = { transcripts: [], agents: setupEvidence(input.run), files: [] }, details = [];
    const resolve = input.evidencePath ?? (file => file);
    const plan = headlessCommands(input.run);
    const executions = plan.map((command, index) => {
      const receipt = input.run.headless?.[index], row = { ...command, seconds: null, parsed: null, reason: null };
      try {
        if (!receipt?.finished || receipt.text !== command.text || receipt.backend !== command.backend) throw new Error(`Missing headless run for ${command.text}.`);
        const transcript = resolve(receipt.transcript), stream = resolve(receipt.stream);
        evidence.transcripts.push(transcript);
        evidence.files.push(stream);
        if (receipt.expectedTranscript) throw new Error('Missing headless transcript.');
        const entries = readTranscript(transcript), commands = commandRuns(entries);
        if (entries.find(entry => !entry.isSidechain && entry.entrypoint)?.entrypoint !== 'sdk-cli') throw new Error('Headless transcript entrypoint is not sdk-cli.');
        if (commands.length !== 1) throw new Error(`Missing or repeated command input for ${command.text}.`);
        const parsed = requireCommand(commands[0], command.text);
        const events = readTranscript(stream), results = events.filter(event => event.type === 'result');
        if (results.length !== 1) throw new Error('Missing or repeated result event.');
        const result = results[0];
        if (result.num_turns !== 0 || result.total_cost_usd !== 0 || result.is_error !== false) throw new Error('Headless result requires num_turns 0, total_cost_usd 0 and is_error false.');
        if (receipt.exitCode !== 0) throw new Error(`Headless exit code is ${receipt.exitCode}.`);
        if (result.session_id !== receipt.sessionId || entries.some(entry => entry.sessionId && entry.sessionId !== receipt.sessionId)) throw new Error('Headless session id does not match its receipt.');
        if (events.some(event => event.type === 'assistant' && event.message?.model !== '<synthetic>')) throw new Error('Model reply in headless stream.');
        const streamed = moduleText(result.result);
        if (!streamed || streamed.verbatim !== parsed.verbatim || streamed.report !== parsed.report) throw new Error('Stream result differs from the module answer.');
        if (!Number.isFinite(result.duration_ms) || result.duration_ms < 0) throw new Error('Missing or invalid result duration_ms.');
        row.seconds = result.duration_ms / 1000;
        row.parsed = parsed;
      } catch (error) { row.reason = error.code ? `Cannot read command evidence: ${error.code}.` : error.message; }
      details.push(row);
      return row;
    });
    const results = input.backends.map(backend => {
      const result = commandResult(backend);
      try {
        const done = setupJob(input, backend, 'done', evidence, result);
        const own = executions.find(row => row.backend === backend), status = executions.at(-1);
        if (own.reason || status.reason) throw new Error(own.reason || status.reason);
        requireResult(own.parsed, done);
        // The shared status command must cover every requested backend.
        for (const selected of input.backends) {
          const other = input.run.setup?.jobs?.[selected]?.done;
          if (!other) throw new Error(`Missing setup job for ${selected} done.`);
          requireStatus(status.parsed, other, 'completed');
        }
        result.timings = { answeredSeconds: [own.seconds, status.seconds] };
        result.result = 'pass';
      } catch (error) { result.reason = error.message; }
      return result;
    });
    return { results, details, evidence };
  },
  cell(record) { return `num_turns 0; answered in ${formatSeconds(record.timings.answeredSeconds ?? [])}`; }
};
