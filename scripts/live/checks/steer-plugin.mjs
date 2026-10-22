import { analyzeCheck } from '../lib/evidence.mjs';
import { agentCalls, opening, waitRunning, ending, steerCell } from './steer-main.mjs';

export default {
  id: 'steer-plugin',
  title: "Steer a running job with a plugin's session.send",
  surfaces: ['terminal'],
  probes: ['wake-probe'],
  timeoutMinutes: 15,
  marker: 'LIVE-PLUGIN-STEER-DONE',
  prompt({ runId, backends }) {
    const calls = backends.map(backend => `mcp__wake-probe__send(${JSON.stringify({ to: `steer-${backend}`, text: `steer from a plugin for ${backend}` })})`);
    return opening(runId, agentCalls(backends)) + waitRunning(backends) +
      `\nCall the probe tool directly exactly once per backend, with these exact calls. Wait for every tool result. Do not send any extra messages.\n${calls.join('\n')}\n\n` + ending('LIVE-PLUGIN-STEER-DONE');
  },
  analyze(input) {
    return analyzeCheck(input, { scope: this.scope, source: 'plugin', messages: backend => [`steer from a plugin for ${backend}`] });
  },
  cell: steerCell
};
