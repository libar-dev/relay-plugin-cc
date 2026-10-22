import { analyzeCheck, formatSeconds } from '../lib/evidence.mjs';
import { agentCalls, opening, ending, waitLoop } from './steer-main.mjs';

export default {
  id: 'continue',
  title: 'Continue a job after its hand-back',
  surfaces: ['terminal', 't3'],
  probes: [],
  timeoutMinutes: 15,
  marker: 'LIVE-CONTINUE-DONE',
  prompt({ runId, backends }) {
    const calls = backends.map(backend => `SendMessage(${JSON.stringify({ to: `continue-${backend}`,
      message: `continue for ${backend}: reply with exactly one line: second turn for ${backend}`,
      summary: `Continue ${backend} for its second turn` })})`);
    return opening(runId, agentCalls(backends, { prefix: 'continue' })) +
      `\nWait for EVERY agent's first completion notice before you send anything: each first turn must have ended and handed back. The notices arrive by themselves between your tool calls; hold your turn meanwhile with Bash until-loops of about 60 seconds each (${waitLoop(60)}).\nThen send each agent exactly once with these exact calls, and wait for every SendMessage result:\n${calls.join('\n')}\n\n` +
      ending('LIVE-CONTINUE-DONE', "every agent's second completion notice");
  },
  analyze(input) {
    return analyzeCheck(input, { kind: 'continue', messages: backend => [`continue for ${backend}: reply with exactly one line: second turn for ${backend}`] });
  },
  cell(record) {
    return `a new turn of the job, delivered in ${formatSeconds(record.timings.deliveredSeconds ?? [])}`;
  }
};
