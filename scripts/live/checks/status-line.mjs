import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatSeconds, hasMarker, MODELS } from '../lib/evidence.mjs';
import { cancelUnfinishedJobs } from '../lib/runs.mjs';
import { pane, sessionEnvironment } from '../lib/terminal.mjs';
import { commandResult, setupEvidence, setupJob } from './commands.mjs';

const counted = screen => screen.split('\n').some(line => /\brelay:[ \t]+\d+\b/.test(line));
const running = (screen, count) => screen.split('\n').some(line => new RegExp(`\\brelay:[ \\t]+${count}[ \\t]+running\\b`).test(line));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export default {
  id: 'status-line', title: 'Status line counts this repository\'s running jobs',
  surfaces: ['terminal'], probes: [], timeoutMinutes: 15, marker: 'LIVE-STATUS-LINE-READY',
  prompt({ runId }) {
    return `Live suite run ${runId}.\nDo not run any tool. Reply with exactly this line and nothing else:\n${this.marker}\n`;
  },
  completed(entries, run) { return hasMarker(entries, this.marker) && run.completed === true; },
  async runTerminal(ctx, { env = process.env, signal, execute = promisify(execFile), drive = pane,
    sleep = pause, now = Date.now } = {}) {
    const run = ctx.run, stamp = () => new Date(now()).toISOString();
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
        if (now() <= deadline && matches(screen)) return;
        if (now() >= deadline) throw new Error(`Status line did not ${phase === 'running' ? 'show the running count' : 'clear'} within 60 seconds.`);
        await sleep(Math.min(1000, deadline - now()));
      }
    };
    const cancel = async () => {
      const receipts = await cancelUnfinishedJobs(run, { env: cleanEnv, execute });
      ctx.save();
      if (receipts.some(receipt => receipt.status === 'failed')) throw new Error('Could not cancel status-line jobs; see run.json.');
    };
    try {
      if (fs.readdirSync(ctx.jobsHome).length) throw new Error('status-line requires an empty jobs home.');
      // The ordinary driver proves module loading and a ready lead; no count text is sent to it.
      await ctx.paneDriver(ctx, { ...this, completed: entries => hasMarker(entries, this.marker) }, { keep: true, drive });
      run.completed = false;
      checkAbort();
      run.setup = { jobs: {} };
      run.statusLine = { screens: [] };
      capture('before');
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
          run.statusLine.startedAt = stamp();
          ctx.save();
        };
        let output;
        // A start interrupted after creating its job can still supply the receipt cleanup needs.
        try { output = await execute(process.execPath, [path.join(ctx.pluginDir, 'scripts/companion.mjs'), 'start', '--prompt-file', file], options); }
        catch (error) { if (error.stdout) remember(error.stdout); throw error; }
        remember(output.stdout);
      }
      await waitFor('running', run.statusLine.startedAt, screen => running(screen, ctx.backends.length));
      checkAbort();
      await cancel();
      run.statusLine.cancelledAt = stamp();
      ctx.save();
      await waitFor('cleared', run.statusLine.cancelledAt, screen => !counted(screen));
      run.completed = true;
    } catch (error) {
      run.completed = false;
      run.error = error.message;
      throw error;
    } finally {
      try { if (run.setup) await cancel(); }
      catch (error) { run.completed = false; run.error = error.message; throw error; }
      finally {
        try { if (run.pane) drive(['stop', run.pane]); }
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
      if (!before || counted(before.text)) throw new Error('Missing empty screen before the jobs started.');
      const shown = screens.find(row => row.phase === 'running' && running(row.text, input.backends.length));
      if (!shown) throw new Error(`No screen shows relay: ${input.backends.length} running.`);
      const cleared = screens.find(row => row.phase === 'cleared' && !counted(row.text));
      if (!cleared) throw new Error('The status line never clears.');
      const shownSeconds = (Date.parse(shown.at) - Date.parse(saved.startedAt)) / 1000;
      const clearedSeconds = (Date.parse(cleared.at) - Date.parse(saved.cancelledAt)) / 1000;
      if (![shownSeconds, clearedSeconds].every(value => Number.isFinite(value) && value >= 0 && value <= 60) ||
          !(Date.parse(before.at) <= Date.parse(saved.startedAt)) || !(Date.parse(shown.at) <= Date.parse(saved.cancelledAt))) {
        throw new Error('Status line observations are out of order or outside the 60 second bounds.');
      }
      timings = { shownSeconds: [shownSeconds], clearedSeconds: [clearedSeconds] };
    } catch (error) { screenError = error.message; }
    const results = input.backends.map(backend => {
      const result = commandResult(backend);
      try {
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
