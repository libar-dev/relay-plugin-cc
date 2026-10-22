import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configDirectory, findTranscript } from './runs.mjs';

const paneScript = fileURLToPath(new URL('../../smoke/pane.sh', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function inspectDebug(text, pluginDir, pluginName = 'relay') {
  const lines = text.split('\n');
  const hooksPath = path.join(pluginDir, 'hooks/hooks.json');
  const modulePath = path.join(pluginDir, pluginName === 'relay' ? 'hooks/mod/register.js' : 'hooks/register.js');
  const name = pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`hooks module.*\\b${name}(?:@|\\s|:)|\\b${name}(?:@[^\\s:]+)?:.*module`, 'i');
  const pluginLines = lines.filter(line => line.includes(`Read hooks.json for plugin ${pluginName} (enabled=true):`) && line.includes(hooksPath));
  const startupLines = lines.filter(line => line.includes('Hooks: SessionStart:startup') && line.includes(pluginDir));
  const moduleLines = lines.filter(line => line.includes(modulePath) || named.test(line));
  const moduleErrors = moduleLines.filter(line => /error|fail|refus|cannot|not loaded|could not|rejected/i.test(line));
  const moduleLoaded = moduleLines.some(line => /\bloaded\b/i.test(line) && !/not loaded|unloaded/i.test(line));
  return { pluginRead: pluginLines.length > 0, startup: startupLines.length > 0,
    moduleLoaded: moduleLoaded && moduleErrors.length === 0, modulePath,
    pluginLines, startupLines, moduleLines, moduleErrors };
}

export function claudeArgs({ pluginDir, probeDirs, sessionId, model }) {
  return ['claude', '--plugin-dir', pluginDir, ...probeDirs.flatMap(dir => ['--plugin-dir', dir]),
    '--dangerously-skip-permissions', '--settings', JSON.stringify({ skipDangerousModePermissionPrompt: true }),
    '--debug', '--session-id', sessionId, '--model', model];
}

export function paneStartArgs(ctx, name, sessionId) {
  return ['start', name, ctx.workDir, '--env', `RELAY_JOBS_HOME=${ctx.jobsHome}`, '--', ...claudeArgs({ ...ctx, sessionId })];
}

function pane(args, input) {
  return execFileSync('bash', [paneScript, ...args], { encoding: 'utf8', input, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
}

export async function runTerminal(ctx, check, { run, save, readers, keep = false, env = process.env,
  log = console.log, warn = console.error, drive = pane, pause = delay } = {}) {
  const sessionId = randomUUID();
  const name = `relay-live-${sessionId.slice(0, 8)}`;
  const configDir = configDirectory(env);
  const debugLog = path.join(configDir, 'debug', `${sessionId}.txt`);
  Object.assign(run, { sessionId, pane: name, debugLog });
  save();
  let started = false, startSucceeded = false, aborted = false;
  const abort = () => { aborted = true; };
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  process.on('SIGHUP', abort);
  const deadline = Date.now() + ctx.timeoutMinutes * 60000;
  try {
    started = true;
    let startup;
    try { startup = drive(paneStartArgs(ctx, name, sessionId)); }
    catch (error) { startup = error.stdout; throw error; }
    finally {
      run.removedEnvironment = [...new Set(String(startup ?? '').split('\n')
        .flatMap(line => line.match(/^RELAY_LIVE_UNSET ([A-Za-z_][A-Za-z0-9_]*)$/)?.slice(1) ?? []))].sort();
      save();
    }
    startSucceeded = true;
    log(drive(['attach-command', name]).trim());
    let trusted = false, ready = false;
    const startupDeadline = Math.min(deadline, Date.now() + 120000);
    while (Date.now() < startupDeadline && !aborted) {
      const screen = drive(['read', name, '0']);
      fs.writeFileSync(path.join(ctx.evidenceDir, 'screen.txt'), screen);
      if (/Yes, I (accept|understand)/i.test(screen) && /bypass|skip.permissions|dangerously/i.test(screen)) {
        throw new Error('The bypass-permissions dialog appeared; it is not answered here, since that changes the user\'s settings.');
      }
      if (!trusted && screen.includes('Yes, I trust this folder')) {
        if (!ctx.workDirCreated) throw new Error(`${ctx.workDir} is not trusted by Claude Code; open it in Claude Code once, or let the runner create the work folder.`);
        drive(['trust', name]); trusted = true;
        await pause(1000); continue;
      }
      const debug = fs.existsSync(debugLog) ? fs.readFileSync(debugLog, 'utf8') : '';
      const plugins = [['relay', ctx.pluginDir], ...check.probes.map((probe, i) => [probe, ctx.probeDirs[i]])];
      run.startupEvidence = Object.fromEntries(plugins.map(([plugin, dir]) => [plugin, inspectDebug(debug, dir, plugin)]));
      save();
      for (const [plugin, evidence] of Object.entries(run.startupEvidence)) {
        if (evidence.moduleErrors.length) throw new Error(`${plugin} hooks module failed to load; see run.json.`);
      }
      if (Object.values(run.startupEvidence).every(item => item.pluginRead && item.moduleLoaded)) { ready = true; break; }
      await pause(1000);
    }
    if (aborted) throw new Error('Interrupted.');
    if (!ready) throw new Error('Startup timed out without plugin and module load evidence; see run.json and screen.txt.');
    await pause(1000);
    if (aborted) throw new Error('Interrupted.');
    drive(['send', name, '-'], fs.readFileSync(path.join(ctx.evidenceDir, 'prompt.txt'), 'utf8'));
    run.promptSentAt = new Date().toISOString();
    save();
    let done = false, lastUpdate = 0;
    while (Date.now() < deadline && !aborted) {
      const screen = drive(['read', name, '2000']);
      fs.writeFileSync(path.join(ctx.evidenceDir, 'screen.txt'), screen);
      run.transcript = findTranscript(ctx.workDir, debugLog, configDir, readers.readTranscript);
      let all = null;
      try { all = run.transcript ? readers.readTranscript(run.transcript) : null; }
      catch (error) {
        // Claude Code may be writing the last line; the next poll reads it whole. The analysis
        // after the run reads the file again and reports a line that stays broken.
        if (!String(error?.message).startsWith('Invalid JSON at ')) throw error;
      }
      if (all) {
        const entries = (check.scope ?? readers.scopeToRun)(all, run.runId);
        done = check.commands ? readers.hasMarker(entries, check.marker) : check.completed ? check.completed(entries, run) :
          Boolean(check.marker && screen.includes(check.marker) && readers.hasMarker(entries, check.marker));
        if (done) break;
      }
      if (Date.now() - lastUpdate >= 30000) {
        log(`Waiting for completion; ${Math.max(0, Math.ceil((deadline - Date.now()) / 60000))} minutes left.`);
        lastUpdate = Date.now(); save();
      }
      await pause(2000);
    }
    if (done && check.commands) {
      run.completed = false;
      await runCommands(ctx, check, { run, save, readers, drive, pause, aborted: () => aborted });
    }
    run.completed = done;
    if (aborted) throw new Error('Interrupted.');
    if (!done) throw new Error(`Timed out waiting for ${check.marker}. Available evidence will be analyzed.`);
  } finally {
    try {
      // A signal can arrive between sending the prompt and the first poll.
      if (run.promptSentAt && !run.transcript) run.transcript = findTranscript(ctx.workDir, debugLog, configDir, readers.readTranscript);
    } finally {
      try {
        if (started) {
          if (keep && !aborted && startSucceeded) log(`Pane kept: ${drive(['attach-command', name]).trim()}`);
          else {
            try { drive(['stop', name]); }
            catch (error) {
              run.error = `Could not stop ${name}: ${error.message}`;
              throw new Error(run.error);
            }
          }
        }
      } finally {
        run.interrupted = aborted;
        process.off('SIGINT', abort);
        process.off('SIGTERM', abort);
        process.off('SIGHUP', abort);
        save();
      }
    }
  }
}

export function sessionEnvironment(env = process.env) {
  // pane.sh owns this list; read its case patterns without executing the tmux driver.
  const source = fs.readFileSync(paneScript, 'utf8');
  const patterns = source.match(/^        (CLAUDECODE\|[A-Z_*|]+)\)$/m)?.[1].split('|');
  if (!patterns) throw new Error('Cannot read the parent-session variable list in pane.sh.');
  const removed = Object.keys(env).filter(key => patterns.some(pattern =>
    pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern)).sort();
  return { env: Object.fromEntries(Object.entries(env).filter(([key]) => !removed.includes(key))), removed };
}

export async function runCommands(ctx, check, { run, save, readers, drive = pane, pause = delay,
  aborted = () => false, now = Date.now } = {}) {
  const answers = () => {
    try {
      return readers.readTranscript(run.transcript).filter(entry => !entry.isSidechain &&
        entry.type === 'system' && entry.subtype === 'local_command' && entry.commandRun).length;
    } catch (error) {
      if (String(error.message).startsWith('Invalid JSON at ')) return null;
      throw error;
    }
  };
  run.commands = [];
  for (const command of check.commands(run)) {
    if (aborted()) throw new Error('Interrupted.');
    const readDeadline = now() + 5000;
    let before = answers();
    while (before === null && now() < readDeadline && !aborted()) {
      await pause(250);
      before = answers();
    }
    if (aborted()) throw new Error('Interrupted.');
    if (before === null) throw new Error('Incomplete transcript before command send.');
    run.commands.push({ text: command.text, sentAt: new Date(now()).toISOString() });
    save();
    drive(['send', run.pane, command.text]);
    const deadline = now() + 200000;
    let answered = false;
    while (now() < deadline && !aborted()) {
      fs.writeFileSync(path.join(ctx.evidenceDir, 'screen.txt'), drive(['read', run.pane, '2000']));
      const count = answers();
      if (count !== null && count > before) { answered = true; break; }
      await pause(1000);
    }
    if (aborted()) throw new Error('Interrupted.');
    if (!answered) throw new Error(`No answer to ${command.text} within 200 seconds. Available evidence will be analyzed.`);
  }
}
