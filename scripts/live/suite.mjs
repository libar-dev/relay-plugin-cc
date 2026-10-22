#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeRun, cancelUnfinishedJobs, configDirectory, createRun, evidenceRoot, pluginCommit, pluginVersion, readJson,
  runDirectory, settingsGuard, smokeInstall, unanalyzedRecords, writeJson, writeRecords } from './lib/runs.mjs';
import { runTerminal } from './lib/terminal.mjs';
import { writeTable } from './lib/table.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export const usage = `Usage:
node scripts/live/suite.mjs list
node scripts/live/suite.mjs run <check>... | all  [--backends codex,grok,zcode,kimi] [--plugin-dir DIR]
        [--model sonnet] [--timeout-minutes N] [--keep] [--work-dir DIR] [--jobs-home DIR] [--records-dir DIR]
node scripts/live/suite.mjs prepare <check> --surface t3 --work-dir DIR [--backends ...]
node scripts/live/suite.mjs analyze <run id> [--transcript FILE] [--jobs-home DIR] [--from-copy] [--records-dir DIR]
node scripts/live/suite.mjs table [--records-dir DIR] [--out FILE] [--relay-version V] [--check]
`;

export class UsageError extends Error {}

function selectedBackends(check, backends) {
  const selected = backends.filter(backend => !check.backends || check.backends.includes(backend));
  if (!selected.length) throw new UsageError(`${check.id} does not apply to any selected backend.`);
  return selected;
}

async function setupRun(check, ctx, dependencies) {
  if (!check.setup) return;
  try {
    dependencies.signal?.throwIfAborted();
    await check.setup(ctx, dependencies);
    dependencies.signal?.throwIfAborted();
  }
  catch (error) {
    ctx.run.setupFailed = true;
    ctx.run.error = `Setup failed: ${error.message}`;
    throw new Error(ctx.run.error);
  } finally { ctx.save(); }
}

function interruptionGuard(run, save) {
  const controller = new AbortController();
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
    const handler = () => {
      run.interrupted = true;
      run.interruptedBy ??= signal;
      save();
      controller.abort(new Error(`Interrupted by ${run.interruptedBy}.`));
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  // The terminal driver still owns pane shutdown. This guard owns setup/headless cancellation
  // and stays installed while cleanup runs, without passing its aborted signal to cancellation.
  return { signal: controller.signal, close() { for (const [signal, handler] of handlers) process.off(signal, handler); } };
}

export function parseArgs(args, registry, backends) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const [command, ...rest] = args;
  const allowed = {
    list: [],
    run: ['--backends', '--plugin-dir', '--model', '--timeout-minutes', '--keep', '--work-dir', '--jobs-home', '--records-dir'],
    prepare: ['--surface', '--work-dir', '--backends'],
    analyze: ['--transcript', '--jobs-home', '--from-copy', '--records-dir'],
    table: ['--records-dir', '--out', '--relay-version', '--check']
  };
  if (!Object.hasOwn(allowed, command)) throw new UsageError(command ? `Unknown command: ${command}` : 'A command is required.');
  const options = { command };
  if (['run', 'analyze', 'table'].includes(command)) options.recordsDir = path.join(repository, 'docs/live/records');
  if (['run', 'prepare'].includes(command)) options.backends = [...backends];
  if (command === 'run') Object.assign(options, { pluginDir: path.join(repository, 'plugins/relay'), model: 'sonnet', keep: false });
  if (command === 'table') options.out = path.join(repository, 'docs/live/capabilities.md');
  const positional = [];
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    if (!allowed[command].includes(arg)) throw new UsageError(`Unknown argument for ${command}: ${arg}`);
    if (seen.has(arg)) throw new UsageError(`Repeated argument: ${arg}`);
    seen.add(arg);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (['--keep', '--from-copy', '--check'].includes(arg)) { options[key] = true; continue; }
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new UsageError(`${arg} requires a value.`);
    if (key === 'backends') {
      const selected = value.split(',').map(item => item.trim());
      if (selected.some(backend => !backends.includes(backend))) throw new UsageError(`--backends must contain only ${backends.join(',')}.`);
      if (new Set(selected).size !== selected.length) throw new UsageError('--backends must not repeat a backend.');
      options.backends = backends.filter(backend => selected.includes(backend));
    } else if (key === 'timeoutMinutes') {
      options[key] = Number(value);
      if (!Number.isFinite(options[key]) || options[key] <= 0) throw new UsageError('--timeout-minutes must be positive.');
    } else options[key] = ['pluginDir', 'workDir', 'jobsHome', 'recordsDir', 'out', 'transcript'].includes(key) ? path.resolve(value) : value;
  }
  if (command === 'run') {
    if (!positional.length) throw new UsageError('run requires at least one check or all.');
    if (positional.includes('all') && positional.length !== 1) throw new UsageError('all cannot be combined with check names.');
    options.all = positional[0] === 'all';
    options.checks = options.all ? registry.filter(check => check.surfaces.includes('terminal')).map(check => check.id) : positional;
    if (new Set(options.checks).size !== options.checks.length) throw new UsageError('A check must not be repeated.');
    for (const id of options.checks) {
      const check = registry.find(item => item.id === id);
      if (!check) throw new UsageError(`Unknown check: ${id}`);
      if (!check.surfaces.includes('terminal')) throw new UsageError(`${id} does not support terminal.`);
      if (!options.all) selectedBackends(check, options.backends);
    }
    if (!options.all && options.checks.length === 1) options.backends = selectedBackends(registry.find(check => check.id === options.checks[0]), options.backends);
    if (options.checks.length > 1 && (options.workDir || options.jobsHome)) throw new UsageError('--work-dir and --jobs-home require a single check.');
  } else if (command === 'prepare') {
    if (positional.length !== 1) throw new UsageError('prepare requires one check.');
    if (!registry.some(check => check.id === positional[0])) throw new UsageError(`Unknown check: ${positional[0]}`);
    if (options.surface !== 't3' || !options.workDir) throw new UsageError('prepare requires --surface t3 and --work-dir DIR.');
    options.checkId = positional[0];
    options.backends = selectedBackends(registry.find(check => check.id === options.checkId), options.backends);
  } else if (command === 'analyze') {
    if (positional.length !== 1) throw new UsageError('analyze requires one run id.');
    try { runDirectory('', positional[0]); } catch (error) { throw new UsageError(error.message); }
    if (options.fromCopy && (options.transcript || options.jobsHome)) throw new UsageError('--from-copy cannot be combined with --transcript or --jobs-home.');
    options.runId = positional[0];
  } else if (positional.length) throw new UsageError(`${command} takes no positional arguments.`);
  return options;
}

function summaries(result, registry, log) {
  for (const record of result.records) {
    const check = registry.find(item => item.id === record.check);
    log(`${record.check} ${record.backend}: ${record.result} ${record.result === 'pass' ? check.cell(record) : record.reason}`);
  }
  if (result.file) log(`Records: ${result.file}`);
}

function requireWorkTree(workDir) {
  try {
    if (execFileSync('git', ['-C', workDir, 'rev-parse', '--is-inside-work-tree'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === 'true') return;
  } catch {}
  throw new UsageError(`--work-dir must already be inside a git work tree: ${workDir}`);
}

async function cleanupRun(run, evidenceDir, { env, warn, cancelJobs = cancelUnfinishedJobs }) {
  let failed = false;
  try {
    const cancellations = await cancelJobs(run, { env });
    for (const item of cancellations.filter(item => item.status === 'failed')) {
      warn(`Could not cancel ${item.jobId}: ${item.error}`);
      failed = true;
    }
  } catch (error) {
    run.cancellationError = error.message;
    warn(error.message);
    failed = true;
  } finally { writeJson(path.join(evidenceDir, 'run.json'), run); }
  return failed;
}

export async function runChecks(options, registry, readers, { env = process.env, log = console.log,
  warn = console.error, driver = runTerminal, commitOf = pluginCommit, cancelJobs = cancelUnfinishedJobs } = {}) {
  if (options.workDir) requireWorkTree(options.workDir);
  let status = 0;
  for (const id of options.checks) {
    const check = registry.find(item => item.id === id);
    if (options.all && check.backends && !options.backends.some(backend => check.backends.includes(backend))) {
      log(`Skipping ${id}: does not apply to any selected backend.`);
      continue;
    }
    const pluginDir = fs.realpathSync(options.pluginDir);
    const relayVersion = pluginVersion(pluginDir);
    const workDir = options.workDir ?? fs.mkdtempSync('/tmp/relay-live-work-');
    const jobsHome = options.jobsHome ?? fs.mkdtempSync('/tmp/relay-live-jobs-');
    if (!options.workDir) execFileSync('git', ['init', '--quiet', workDir]);
    fs.mkdirSync(jobsHome, { recursive: true });
    const { run, evidenceDir } = createRun(evidenceRoot(env), check, { surface: 'terminal',
      backends: selectedBackends(check, readers.BACKENDS.filter(backend => options.backends.includes(backend))), workDir: fs.realpathSync(workDir),
      jobsHome: fs.realpathSync(jobsHome), workDirCreated: !options.workDir, jobsHomeCreated: !options.jobsHome,
      pluginDir, relayVersion, relayCommit: commitOf(pluginDir), model: options.model,
      timeoutMinutes: options.timeoutMinutes ?? check.timeoutMinutes,
      probeDirs: check.probes.map(probe => path.join(repository, 'scripts/live/probes', probe)) });
    const save = () => writeJson(path.join(evidenceDir, 'run.json'), run);
    const guard = settingsGuard(configDirectory(env));
    log(`Run: ${run.runId}\nEvidence: ${evidenceDir}`);
    const ctx = { runId: run.runId, backends: run.backends, pluginDir, probeDirs: run.probeDirs, workDir: run.workDir,
      jobsHome: run.jobsHome, workDirCreated: run.workDirCreated, jobsHomeCreated: run.jobsHomeCreated, evidenceDir,
      model: run.model, timeoutMinutes: run.timeoutMinutes, run, save, readers,
      paneDriver: (input = ctx, selected = check, overrides = {}) => driver(input, selected,
        { run, save, readers, keep: options.keep, env, log, warn, ...overrides }) };
    const interruption = interruptionGuard(run, save);
    let records;
    try {
      let analysis, sessionFailed = false;
      try {
        await setupRun(check, ctx, { env, signal: interruption.signal });
        interruption.signal.throwIfAborted();
        if (check.runTerminal) {
          analysis = await check.runTerminal(ctx, { env, signal: interruption.signal });
          // An override returning its analysis has completed its session work.
          run.promptSentAt ??= run.preparedAt;
          run.transcript ??= analysis?.evidence.transcripts[0] ?? null;
        } else await driver(ctx, check, { run, save, readers, keep: options.keep, env, log, warn });
        interruption.signal.throwIfAborted();
      } catch (error) {
        run.error = error.message;
        sessionFailed = true;
        status = 1;
        warn(error.message);
      } finally {
        const after = commitOf(pluginDir);
        if (run.relayCommit && after !== run.relayCommit) run.relayCommit = run.relayCommit.replace(/-dirty$/, '') + '-dirty';
        if (guard(run, evidenceDir, warn)) status = 1;
        save();
      }
      if (!check.setup && run.promptSentAt && run.jobsHomeCreated &&
        (sessionFailed || run.interrupted || run.completed === false)) {
        if (await cleanupRun(run, evidenceDir, { env, warn, cancelJobs })) status = 1;
      }
      try {
        if (run.promptSentAt) {
          try {
            const result = analyzeRun(run, evidenceDir, registry, readers, { recordsDir: options.recordsDir, analysis, env });
            records = result.records;
            summaries(result, registry, log);
            if (result.records.some(record => record.result !== 'pass')) status = 1;
          } catch (error) {
            run.error = error.message;
            save();
            warn(error.message);
            status = 1;
            records = unanalyzedRecords(run, error.message, readers, evidenceRoot(env));
            summaries({ records, file: writeRecords(run, records, evidenceDir, options.recordsDir) }, registry, log);
          }
        } else status = 1;
      } finally {
        if (check.setup && run.setup && (!run.setupFailed || run.interrupted)) {
          if (await cleanupRun(run, evidenceDir, { env, warn, cancelJobs })) status = 1;
        }
      }
    } finally {
      try {
        if (run.interrupted) {
          status = 1;
          // A signal during post-analysis cleanup must also invalidate the already written records.
          if (records) writeRecords(run, records, evidenceDir, options.recordsDir);
        }
        save();
      } finally { interruption.close(); }
    }
    if (run.interrupted) break;
  }
  return status;
}

export async function main(args, registry, readers, dependencies = {}) {
  const { env = process.env, log = console.log, warn = console.error } = dependencies;
  try {
    const options = parseArgs(args, registry, readers.BACKENDS);
    if (options.help) { log(usage.trimEnd()); return 0; }
    if (options.command === 'list') {
      for (const check of registry) log(`${check.id}\t${check.surfaces.join(',')}\t${check.probes.join(',') || '-'}\t${check.title}`);
      return 0;
    }
    if (options.command === 'table') return writeTable(options, registry, readers, warn);
    if (options.command === 'prepare') {
      const check = registry.find(item => item.id === options.checkId);
      if (!check.surfaces.includes('t3')) throw new Error(`${check.id} does not support t3.`);
      requireWorkTree(options.workDir);
      const build = smokeInstall(options.workDir, env);
      const { run, evidenceDir } = createRun(evidenceRoot(env), check, { surface: 't3', backends: options.backends, ...build,
        ...(check.setup ? { jobsHome: path.resolve(env.RELAY_JOBS_HOME || path.join(os.homedir(), '.relay-jobs')), jobsHomeCreated: false } : {}) });
      const save = () => writeJson(path.join(evidenceDir, 'run.json'), run);
      const interruption = interruptionGuard(run, save);
      try {
        await setupRun(check, { ...run, run, save, evidenceDir }, { env, signal: interruption.signal });
      } finally {
        try {
          if (run.interrupted && run.setup) await cleanupRun(run, evidenceDir, { env, warn, cancelJobs: dependencies.cancelJobs });
          save();
        } finally { interruption.close(); }
      }
      log(`${run.runId}\n${path.join(evidenceDir, 'prompt.txt')}\n---\n${fs.readFileSync(path.join(evidenceDir, 'prompt.txt'), 'utf8').replace(/\n$/, '')}`);
      if (check.commands) log('---\nAfter the marker, send each line below as its own message, in order; wait until the thread is idle after each:\n' +
        check.commands(run).map(command => command.text).join('\n'));
      return 0;
    }
    if (options.command === 'analyze') {
      const evidenceDir = runDirectory(evidenceRoot(env), options.runId);
      const run = readJson(path.join(evidenceDir, 'run.json'));
      let result, cleanupFailed = false;
      try {
        result = analyzeRun(run, evidenceDir, registry, readers, { ...options, env });
        summaries(result, registry, log);
      } finally {
        if (!options.fromCopy && !run.setupFailed && run.setup) {
          cleanupFailed = await cleanupRun(run, evidenceDir, { env, warn, cancelJobs: dependencies.cancelJobs });
        }
      }
      return cleanupFailed || run.settingsChanged || result.records.some(record => record.result !== 'pass') ? 1 : 0;
    }
    return await runChecks(options, registry, readers, dependencies);
  } catch (error) {
    warn(error.message);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { checks, getCheck } = await import('./checks/index.mjs');
    const { readTranscript, claudeCodeVersionOf, leadModelOf, hasMarker, runSpan, scopeToRun, promptText, BACKENDS, BACKEND_NAMES } = await import('./lib/evidence.mjs');
    const registry = checks.map(check => getCheck(check.id));
    process.exitCode = await main(process.argv.slice(2), registry,
      { readTranscript, claudeCodeVersionOf, leadModelOf, hasMarker, runSpan, scopeToRun, promptText, BACKENDS, BACKEND_NAMES });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
