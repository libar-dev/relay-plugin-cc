import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeBackends, filesUnder, hasReportLine, inside, jobsUnder, MODELS, readJson, rememberJob,
  requireBackend, requireVersion, runSpan, stateBlockJob, textContent, workflowEvidence } from '../lib/evidence.mjs';
import { opening, ending } from './steer-main.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
export const badPrompts = {
  codex: 'model: gpt-6.1-sol\nefort: low\n---\nSay hi.',
  grok: 'backend: grok\nmodel: grok-4.7\neffort: low\nweb-search: cached\n---\nSay hi.',
  zcode: 'backend: zcode\nmodel: glm-5.3-flash\neffort: low\nmode: write\n---\nSay hi.',
  kimi: 'backend: kimi\nmodel: kimi-code/kimi-for-coding\n---\nSay hi.'
};
export function goodPrompt(backend) {
  return `${backend === 'codex' ? '' : `backend: ${backend}\n`}model: ${MODELS[backend]}\neffort: low\n---\nReply with exactly one line: spawn check ok for ${backend}. Do not run any command.`;
}
export function workflowScript(backends) {
  return "export const meta = { name: 'live-spawn-check', description: 'A denied and a valid relay spawn per backend' }\n" +
    'return Object.fromEntries(await parallel([\n' + backends.map(backend =>
      `  async () => {\n    const bad = await agent(${JSON.stringify(badPrompts[backend])}, { agentType: 'relay:job', label: 'spawn-bad-${backend}' }).then(returned => ({ returned }), error => ({ error: String(error && error.message || error) }))\n` +
      `    const good = await agent(${JSON.stringify(goodPrompt(backend))}, { agentType: 'relay:job', label: 'spawn-good-${backend}' })\n    return ['${backend}', { bad, good }]\n  }`).join(',\n') + '\n]))';
}
export function checkHeader(prompt) {
  return spawnSync(process.execPath, [path.join(repository, 'plugins/relay/scripts/companion.mjs'), 'check-header'],
    { cwd: repository, input: prompt, encoding: 'utf8', timeout: 10000 });
}
export function expectedMessage(prompt, runner = checkHeader) {
  const result = runner(prompt);
  if (result.error || result.status !== 1 || result.stderr || !/^error: [^\r\n]+\r?\n?$/.test(result.stdout ?? '')) {
    throw new Error('check-header did not refuse the bad prompt with a parser message.');
  }
  const message = result.stdout.slice(7).trim();
  if (!message) throw new Error('check-header did not refuse the bad prompt with a parser message.');
  return message;
}

export default {
  id: 'spawn-check',
  title: 'Spawn with a bad header fails at once',
  surfaces: ['terminal', 't3'],
  probes: [],
  timeoutMinutes: 15,
  marker: 'LIVE-SPAWN-CHECK-DONE',
  prompt({ runId, backends }) {
    const calls = backends.map(backend => `Agent(${JSON.stringify({ subagent_type: 'relay:job', name: `spawn-bad-${backend}`,
      description: `spawn-bad-${backend}`, run_in_background: true, prompt: badPrompts[backend] })})`).join('\n');
    return opening(runId, calls).replace("Save the agentId from each Agent result and its name. ", '') + '\nReport each bad Agent result verbatim; do not retry any call.\n' +
      `Run one Workflow now. This is an explicit request to use the Workflow tool. Pass this script inline and verbatim, with no args:\n\n${workflowScript(backends)}\n\n` +
      ending('LIVE-SPAWN-CHECK-DONE', "the Workflow's result notice");
  },
  analyze(input, { checkHeaderRunner = checkHeader } = {}) {
    let inventory, metadata, inventoryError;
    return analyzeBackends(input, this.scope, ({ backend, row, entries, allEntries, parsed, results, evidence }) => {
      if (!inventory && !inventoryError) {
        try {
          const started = Date.parse(runSpan(allEntries, input.runId, this.marker).startedAt);
          const next = allEntries[allEntries.indexOf(entries.at(-1)) + 1];
          const before = next ? Date.parse(next.timestamp) : Infinity;
          if (!Number.isFinite(started) || Number.isNaN(before)) throw new Error('Missing run boundary timestamp.');
          const inRun = time => time >= started && time < before;
          inventory = jobsUnder(input.jobsHome);
          for (const item of inventory) item.inRun = inRun(Date.parse(item.job.createdAt));
          const session = input.transcript.replace(/\.jsonl$/, '');
          const saved = input.evidenceDir && readJson(path.join(input.evidenceDir, 'run.json'), true);
          const copied = saved?.copy && path.resolve(saved.copy.jobsHome) === path.resolve(input.jobsHome);
          for (const item of inventory) {
            const transcript = item.job.relay?.transcriptPath;
            // A missing relay transcript cannot be relocated by the evidence copier.
            const inOriginal = copied && typeof saved.transcript === 'string' && typeof saved.jobsHome === 'string' &&
              typeof transcript === 'string' && inside(saved.transcript.replace(/\.jsonl$/, ''), path.resolve(saved.jobsHome, transcript));
            if (typeof transcript === 'string' && (inside(session, path.resolve(input.jobsHome, transcript)) || inOriginal)) {
              item.inSession = true;
              const pointer = path.join(input.jobsHome, 'relays', `${item.job.relay.agentId}.json`);
              rememberJob(input, evidence, item.jobDir, item.job, fs.existsSync(pointer) ? pointer : undefined);
            }
          }
          const files = filesUnder(path.join(session, 'subagents'), file => /^agent-.*\.meta\.json$/.test(path.basename(file)))
            .filter(file => inRun(fs.statSync(file).mtimeMs));
          evidence.transcripts.push(...files);
          metadata = files.map(file => readJson(file));
        } catch (error) { inventoryError = error; }
      }
      if (inventoryError) throw inventoryError;
      const expected = expectedMessage(badPrompts[backend], checkHeaderRunner);
      const badName = `spawn-bad-${backend}`, goodName = `spawn-good-${backend}`;
      const calls = parsed.calls.filter(call => call.name === 'Agent' && call.input?.name === badName);
      if (calls.length !== 1 || calls[0].input?.subagent_type !== 'relay:job' || calls[0].input.prompt !== badPrompts[backend]) {
        throw new Error(`Expected exactly one bad Agent call for ${backend} with the expected prompt.`);
      }
      const reply = results.get(calls[0].id);
      const text = textContent(reply?.content).trim().replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, '$1').trim();
      if (!reply?.is_error || text !== `Subagent spawn denied by a plugin: ${expected}`) throw new Error('Agent result is not the parser spawn denial.');
      if (metadata.some(meta => meta.name === badName || meta.description === badName)) throw new Error('A meta file exists for the denied Agent.');
      const workflows = parsed.calls.filter(call => call.name === 'Workflow');
      if (workflows.length !== 1 || workflows[0].input?.script !== workflowScript(input.backends) || Object.hasOwn(workflows[0].input, 'args')) {
        throw new Error('Expected exactly one Workflow with the expected script and no args.');
      }
      const workflow = workflowEvidence(input, evidence, workflows[0], results.get(workflows[0].id));
      const result = workflow.result?.[backend];
      if (result?.bad?.error !== `Workflow agent spawn denied by a plugin: ${expected}`) throw new Error('Workflow bad.error is not the parser spawn denial.');
      const started = workflow.journal.filter(item => item.type === 'started');
      if (started.some(item => item.label === badName)) throw new Error('The bad Workflow label started.');
      const failed = workflow.journal.filter(item => item.type === 'failed');
      if (failed.length !== input.backends.length || failed.some(item => item.agentId !== '') ||
          new Set(failed.map(item => item.key)).size !== failed.length) throw new Error('Expected one failed journal line with empty agentId per bad call.');
      const good = started.filter(item => item.label === goodName);
      if (good.length !== 1 || !good[0].agentId) throw new Error('Expected one started journal line for the good label.');
      const { job, jobDir } = stateBlockJob(input, result.good, inventory);
      Object.assign(row, { jobDir, agentId: good[0].agentId, workflowRunId: workflow.runId });
      if (job.relay?.workflowRunId !== workflow.runId || job.relay.label !== goodName || job.relay.agentId !== good[0].agentId) {
        throw new Error('Good job belongs to another Workflow run, label or relay.');
      }
      requireBackend(job, backend);
      if (job.state !== 'completed') throw new Error('Good job is not completed.');
      requireVersion(job.attempts?.at(-1), input.relayVersion);
      if (!hasReportLine(fs.readFileSync(path.join(jobDir, 'report.md'), 'utf8'), `spawn check ok for ${backend}`)) throw new Error('Good report is missing the spawn check line.');
      const goodJobs = new Set(input.backends.map(name => stateBlockJob(input, workflow.result?.[name]?.good, inventory).jobDir));
      if (inventory.some(item => item.inSession && item.inRun && !goodJobs.has(item.jobDir))) throw new Error('An extra job belongs to this session.');
    });
  },
  cell() { return "refused at the spawn with the parser's message; a valid header runs"; }
};
