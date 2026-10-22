import fs from 'node:fs';
import path from 'node:path';
import { analyzeBackends, formatSeconds, inboxMessages, lastActiveAttempt, oneRelay, readJson, relayJob, requireBackend, textContent } from '../lib/evidence.mjs';
import { agentCalls, opening, waitRunning, waitLoop } from './steer-main.mjs';

export default {
  id: 'stop',
  title: 'Stop a running job with TaskStop',
  surfaces: ['terminal', 't3'],
  probes: [],
  timeoutMinutes: 15,
  marker: 'LIVE-STOP-DONE',
  prompt({ runId, backends }) {
    return opening(runId, agentCalls(backends, { prefix: 'stop', seconds: 240 })) + waitRunning(backends) +
      `\nStop each agent exactly once, by name, with these exact calls, in parallel if possible, and report each result:\n` +
      backends.map(backend => `TaskStop(${JSON.stringify({ task_id: `stop-${backend}` })})`).join('\n') +
      `\nThen run one Bash wait of 20 seconds: ${waitLoop(20)}\nDo not send messages, spawn replacements or wait for completion notices. Print exactly this line by itself:\nLIVE-STOP-DONE\n`;
  },
  analyze(input) {
    return analyzeBackends(input, this.scope, ({ backend, row, entries, parsed, results, evidence }) => {
      const agent = oneRelay(parsed, backend, 'stop');
      const { job, jobDir } = relayJob(input, evidence, agent.agentId);
      Object.assign(row, { agentId: agent.agentId, jobDir });
      requireBackend(job, backend);
      const calls = parsed.calls.filter(call => call.name === 'TaskStop' && [agent.name, agent.agentId].includes(call.input?.task_id));
      if (calls.length !== 1) throw new Error(`Expected exactly one TaskStop for ${agent.name}, found ${calls.length}.`);
      const call = calls[0], result = results.get(call.id);
      if (!result || result.is_error) throw new Error('Missing or failed TaskStop result.');
      const response = result.result ?? JSON.parse(textContent(result.content));
      if (response?.task_id !== agent.agentId) throw new Error('TaskStop result names another relay.');
      const contexts = entries.filter(entry => !entry.isSidechain && entry.type === 'attachment' &&
        entry.attachment?.type === 'hook_additional_context' && entry.attachment.hookName === 'PostToolUse:TaskStop' &&
        entry.attachment.toolUseID === call.id &&
        (Array.isArray(entry.attachment.content) ? entry.attachment.content.join('\n') : String(entry.attachment.content ?? '')).startsWith(`TaskStop stopped the relay:job agent ${agent.agentId}, and the relay hook cancelled its job ${job.id}:\n`));
      if (!job.id || !contexts.length) throw new Error('No successful hook context for this TaskStop naming the job.');
      if (job.state !== 'cancelled') throw new Error('Job is not cancelled.');
      const attempt = lastActiveAttempt(job, call.timestamp, input.relayVersion, { endedAtBoundary: true });
      if (attempt.state !== 'cancelled') throw new Error('Active attempt is not cancelled.');
      // Receipts live in claimed too; the job ledger can repeat one message's id for each action.
      const cancels = new Map([...(job.messages ?? []), ...inboxMessages(jobDir)]
        .filter(message => message.kind === 'cancel').map(message => [message.id, message]));
      if (cancels.size !== 1) throw new Error(`Expected exactly one cancel message, found ${cancels.size}.`);
      const message = [...cancels.values()][0];
      if (!message.id || !(Date.parse(message.createdAt) >= Date.parse(call.timestamp)) ||
          !contexts.some(entry => Date.parse(message.createdAt) <= Date.parse(entry.timestamp))) {
        throw new Error('No cancel message posted between TaskStop and its hook context.');
      }
      const outcome = readJson(path.join(jobDir, 'inbox/outcomes', `${path.basename(message.id)}.json`), true);
      if (outcome?.messageId !== message.id || outcome.action !== 'cancelled') throw new Error('Cancel message has no cancelled outcome.');
      // The caller got the cancelled job's block beside the TaskStop result, so the hook records it as handed back.
      let handbacks = [];
      try { handbacks = fs.readFileSync(path.join(jobDir, 'relay-handbacks.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read relay-handbacks.jsonl: ${error.message}`); }
      const recorded = handbacks.filter(entry => entry.by === 'TaskStop');
      if (recorded.length !== 1 || recorded[0].agentId !== agent.agentId || recorded[0].state !== 'cancelled' ||
          recorded[0].attempts !== job.attempts?.length || !(Date.parse(recorded[0].at) >= Date.parse(call.timestamp))) {
        throw new Error('The TaskStop hook recorded no hand-back of the cancelled job.');
      }
      const seconds = (Date.parse(job.completedAt) - Date.parse(call.timestamp)) / 1000;
      if (!(seconds >= 0 && seconds <= 15)) throw new Error('Cancellation was not within 0 to 15 seconds of TaskStop.');
      row.timings.cancelledSeconds = [seconds];
    });
  },
  cell(record) { return `cancelled in ${formatSeconds(record.timings.cancelledSeconds ?? [])}`; }
};
