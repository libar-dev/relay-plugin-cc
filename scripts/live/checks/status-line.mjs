import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatSeconds, hasMarker, MODELS } from '../lib/evidence.mjs';
import { cancelUnfinishedJobs } from '../lib/runs.mjs';
import { pane, sessionEnvironment } from '../lib/terminal.mjs';
import { commandResult, setupEvidence, setupJob } from './commands.mjs';

// The prompt's rules separate the pinned footer from quotations in the transcript.
function pinned(screen) {
  const lines = screen.split('\n'), rule = line => /^\s*─+\s*$/.test(line ?? '');
  const prompt = lines.findLastIndex(line => /^\s*❯\s*$/.test(line));
  if (prompt < 1 || !rule(lines[prompt - 1]) || !rule(lines[prompt + 1])) return null;
  return lines.slice(prompt + 2).map(line => line.trim());
}
const prefix = /^⚠\uFE0F?\s+relay:\s*/;
// A plugin's status line starts its row with ⚠, so a prefix a narrow pane wrapped still keeps a row from clearing.
const cleared = screen => {
  const footer = pinned(screen);
  return footer !== null && !footer.some(line => line.startsWith('⚠'));
};
function running(screen, count) {
  const footer = pinned(screen);
  if (!footer || footer.filter(line => prefix.test(line)).length !== 1) return false;
  const at = footer.findIndex(line => prefix.test(line));
  let text = footer[at].replace(prefix, '');
  // Only count words can continue the line; never join a transcript or another footer widget.
  for (const line of footer.slice(at + 1)) {
    if (!/^(?:\d+\+?|running|dead|owed|·)(?:\s+(?:\d+\+?|running|dead|owed|·))*$/.test(line)) break;
    text += ` ${line}`;
  }
  return new RegExp(`^${count}\\s+running(?:\\s*·\\s*\\d+\\s+(?:dead|owed))*$`).test(text.trim());
}
// True on a clear that a capture more than 5 s later confirms; since() is the first capture of that clear.
function confirmedClear() {
  let first = null;
  const confirms = (screen, at) => {
    if (!cleared(screen)) { first = null; return false; }
    first ??= at;
    return at - first > 5000;
  };
  confirms.since = () => first;
  return confirms;
}
function homeJobs(home) {
  const directories = dir => fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => path.join(dir, entry.name));
  return directories(home).flatMap(directories).filter(dir => fs.existsSync(path.join(dir, 'job.json'))).map(dir => {
    let job;
    try { job = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')); } catch { /* Cancel can retry a busy record. */ }
    return { id: job?.id ?? path.basename(dir), jobDir: path.relative(home, dir) };
  });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export default {
  id: 'status-line', title: 'Status line counts this repository\'s running jobs',
  surfaces: ['terminal'], probes: [], timeoutMinutes: 15, marker: 'LIVE-STATUS-LINE-READY',
  prompt({ runId }) {
    return `Live suite run ${runId}.\nDo not run any tool. Reply with exactly this line and nothing else:\n${this.marker}\n`;
  },
  completed(entries) { return hasMarker(entries, this.marker); },
  async runTerminal(ctx, { env = process.env, signal, execute = promisify(execFile), drive = pane,
    sleep = pause, now = Date.now } = {}) {
    const run = ctx.run, stamp = () => new Date(now()).toISOString();
    let ownsHome = false, stopRequested = false;
    const cleanEnv = { ...sessionEnvironment(env).env, RELAY_JOBS_HOME: ctx.jobsHome };
    const options = { cwd: ctx.workDir, env: cleanEnv, encoding: 'utf8', timeout: 60000,
      maxBuffer: 8 * 1024 * 1024, detached: true };
    const checkAbort = () => {
      signal?.throwIfAborted();
      if (run.interrupted) throw new Error('Interrupted.');
    };
    const capture = phase => {
      const screen = drive(['screen', run.pane]);
      const file = `status-line-${run.statusLine.screens.length}.txt`;
      fs.writeFileSync(path.join(ctx.evidenceDir, file), screen);
      run.statusLine.screens.push({ phase, file, at: stamp() });
      ctx.save();
      return screen;
    };
    const waitFor = async (phase, since, matches) => {
      const deadline = Date.parse(since) + 60000;
      while (true) {
        checkAbort();
        const screen = capture(phase);
        if (now() <= deadline && matches(screen, Date.parse(run.statusLine.screens.at(-1).at))) return;
        if (now() >= deadline) {
          let detail = '';
          if (phase === 'running') {
            let jobs;
            try {
              // A dead worker can leave "running" in job.json; the companion computes its state.
              const output = await execute(process.execPath, [path.join(ctx.pluginDir, 'scripts/companion.mjs'),
                'status', '--json', '--limit', '200'], { ...options, timeout: 10000 });
              const answer = JSON.parse(output.stdout);
              if (answer.schema !== 'relay.status/1' || answer.error || !Array.isArray(answer.jobs)) throw new Error('Invalid status listing.');
              jobs = answer.jobs;
            } catch (error) { run.statusLine.deadlineError = error.message; }
            run.statusLine.jobsAtDeadline = Object.values(run.setup.jobs).map(({ running: job }) => ({ id: job.id,
              state: jobs?.find(found => found.id === job.id)?.state ?? (jobs ? 'missing' : 'unreadable') }));
            const inactive = run.statusLine.jobsAtDeadline.filter(job => !['starting', 'running'].includes(job.state));
            detail = ` Jobs not starting or running: ${inactive.map(job => `${job.id} (${job.state})`).join(', ') || 'none'}.`;
            if (run.statusLine.deadlineError) detail += ` Status read failed: ${run.statusLine.deadlineError}`;
            ctx.save();
          }
          throw new Error(`Status line did not ${phase === 'running' ? 'show the running count' : 'clear'} within 60 seconds.${detail}`);
        }
        await sleep(Math.min(1000, deadline - now()));
      }
    };
    const cancel = async () => {
      // This home was empty: receipts are not needed to own a job a failed start left behind.
      const receipts = await cancelUnfinishedJobs({ ...run, cancellations: run.cancellations ??= [],
        setup: { jobs: { discovered: homeJobs(ctx.jobsHome) } } }, { env: cleanEnv, execute });
      ctx.save();
      if (receipts.some(receipt => receipt.status === 'failed')) throw new Error('Could not cancel status-line jobs; see run.json.');
    };
    try {
      if (fs.readdirSync(ctx.jobsHome).length) throw new Error('status-line requires an empty jobs home.');
      ownsHome = true;
      // The ordinary driver proves module loading and a ready lead; no count text is sent to it.
      // It owns --keep; defer its stop until the observations and job cleanup have finished.
      await ctx.paneDriver(ctx, this, { drive(args, input) {
        if (args[0] === 'stop') { stopRequested = true; return ''; }
        return drive(args, input);
      } });
      run.completed = false;
      checkAbort();
      run.setup = { jobs: {} };
      run.statusLine = { screens: [] };
      capture('before');
      run.statusLine.startedAt = stamp();
      ctx.save();
      for (const backend of ctx.backends) {
        checkAbort();
        const file = path.join(ctx.evidenceDir, `${backend}-running.txt`);
        fs.writeFileSync(file, `${backend === 'codex' ? '' : `backend: ${backend}\n`}model: ${MODELS[backend]}\neffort: low\n---\n` +
          'Run the shell command `sleep 150` exactly once and wait for it. Then reply with one line: slept.\n');
        const remember = stdout => {
          const id = stdout?.match(/^job: (.+)$/m)?.[1], dir = stdout?.match(/^dir: (.+)$/m)?.[1];
          if (!id || !dir) throw new Error(`No job id or directory from start for ${backend}.`);
          const jobDir = path.relative(ctx.jobsHome, path.resolve(ctx.workDir, dir));
          if (jobDir.startsWith('..') || path.isAbsolute(jobDir)) throw new Error('Started job is outside jobsHome.');
          run.setup.jobs[backend] = { running: { id, jobDir } };
          ctx.save();
        };
        let output;
        // Keep a complete receipt as evidence even when start fails after printing it.
        try { output = await execute(process.execPath, [path.join(ctx.pluginDir, 'scripts/companion.mjs'), 'start', '--prompt-file', file], options); }
        catch (error) {
          if (/^job: .+$/m.test(error.stdout ?? '') && /^dir: .+$/m.test(error.stdout ?? '')) remember(error.stdout);
          throw error;
        }
        remember(output.stdout);
      }
      await waitFor('running', run.statusLine.startedAt, screen => running(screen, ctx.backends.length));
      checkAbort();
      run.statusLine.cancelledAt = stamp();
      ctx.save();
      await cancel();
      // The cancels run one after another and may each wait for their worker, so the bound starts when
      // they return; the timing still counts from the first cancel's start.
      run.statusLine.cancelsReturnedAt = stamp();
      ctx.save();
      await waitFor('cleared', run.statusLine.cancelsReturnedAt, confirmedClear());
      run.completed = true;
    } catch (error) {
      run.completed = false;
      run.error = error.message;
      throw error;
    } finally {
      try { if (ownsHome) await cancel(); }
      catch (error) { run.completed = false; run.error = error.message; throw error; }
      finally {
        // The ordinary driver kept the pane for --keep; an interrupted run stops it anyway, as that driver does.
        try { if (run.pane && (stopRequested || run.interrupted || signal?.aborted)) drive(['stop', run.pane]); }
        catch (error) { run.completed = false; run.error = error.message; throw error; }
        finally { run.checkFinishedAt = stamp(); ctx.save(); }
      }
    }
  },
  analyze(input) {
    const run = input.run, saved = run.statusLine;
    const evidence = { transcripts: [input.transcript], agents: setupEvidence(run), files: [] }, details = [];
    let timings, screenError;
    try {
      evidence.files = (saved?.screens ?? []).map(row => path.join(input.evidenceDir, row.file));
      const screens = (saved?.screens ?? []).map(row => {
        const file = path.join(input.evidenceDir, row.file);
        return { ...row, text: fs.readFileSync(input.evidencePath ? input.evidencePath(file) : file, 'utf8') };
      });
      const before = screens.find(row => row.phase === 'before');
      if (!before || !cleared(before.text)) throw new Error('Missing clear pinned region under a visible prompt before the jobs started.');
      const shown = screens.find(row => row.phase === 'running' && running(row.text, input.backends.length));
      if (!shown) throw new Error(`No screen shows relay: ${input.backends.length} running.`);
      const confirmsClear = confirmedClear();
      const clear = screens.find(row => row.phase === 'cleared' && confirmsClear(row.text, Date.parse(row.at)));
      if (!clear) throw new Error('The status line never clears on two captures more than 5 seconds apart.');
      const clearedAt = confirmsClear.since();
      const shownSeconds = (Date.parse(shown.at) - Date.parse(saved.startedAt)) / 1000;
      const clearedSeconds = (clearedAt - Date.parse(saved.cancelledAt)) / 1000;
      const returned = Date.parse(saved.cancelsReturnedAt ?? saved.cancelledAt);
      if (![shownSeconds, clearedSeconds].every(value => Number.isFinite(value) && value >= 0) || shownSeconds > 60 ||
          !(clearedAt - returned <= 60000) || !(returned >= Date.parse(saved.cancelledAt)) ||
          !(Date.parse(before.at) <= Date.parse(saved.startedAt)) || !(Date.parse(shown.at) <= Date.parse(saved.cancelledAt)) ||
          screens.some((row, i) => !Number.isFinite(Date.parse(row.at)) || (i > 0 && Date.parse(row.at) < Date.parse(screens[i - 1].at)) ||
            (row.phase === 'cleared' && Date.parse(row.at) < Date.parse(saved.cancelledAt)))) {
        throw new Error('Status line observations are out of order or outside the 60 second bounds.');
      }
      timings = { shownSeconds: [shownSeconds], clearedSeconds: [clearedSeconds] };
    } catch (error) { screenError = error.message; }
    const results = input.backends.map(backend => {
      const result = commandResult(backend);
      try {
        if (run.completed !== true || run.error) throw new Error(run.error || 'The status-line run did not complete.');
        const { job } = setupJob(input, backend, 'running', evidence, result);
        if (screenError) throw new Error(screenError);
        if (job.state !== 'cancelled') throw new Error('The setup job was not cancelled.');
        result.timings = timings;
        result.result = 'pass';
      } catch (error) { result.reason = error.message; }
      details.push({ backend, screens: saved?.screens ?? [], reason: result.reason });
      return result;
    });
    return { results, details, evidence };
  },
  cell(record) {
    return `count shown in ${formatSeconds(record.timings.shownSeconds ?? [])}, cleared in ${formatSeconds(record.timings.clearedSeconds ?? [])}`;
  }
};
