import { analyzeCheck } from '../lib/evidence.mjs';
import { agentCalls, opening, waitRunning, ending, steerCell } from './steer-main.mjs';

export const workflowScript = "export const meta = { name: 'live-steer-workflow', description: 'Workflow agents steer running relays by agent id' }\n" +
  'return await parallel(Object.entries(args).map(([backend, id]) => () => agent(`Use the SendMessage tool exactly once: send the message "steer from a workflow agent for ${backend}" to the agent whose id is ${id} (to: "${id}"). Reply with the SendMessage tool result only.`, { label: `steer-${backend}` })))';

export default {
  id: 'steer-workflow',
  title: "Steer a running job with a Workflow agent's SendMessage",
  surfaces: ['terminal', 't3'],
  probes: [],
  timeoutMinutes: 15,
  marker: 'LIVE-WORKFLOW-STEER-DONE',
  prompt({ runId, backends }) {
    return opening(runId, agentCalls(backends)) + waitRunning(backends) +
      `\nRun one Workflow now. This is an explicit request to use the Workflow tool. Pass this script inline and verbatim, and pass args as an object mapping exactly ${backends.join(', ')} to each relay's saved agentId. Do not replace the script or send any message yourself.\n\n${workflowScript}\n\n` +
      ending('LIVE-WORKFLOW-STEER-DONE', "the Workflow's result and every relay's completion notice");
  },
  analyze(input) {
    return analyzeCheck(input, { source: 'workflow', messages: backend => [`steer from a workflow agent for ${backend}`] });
  },
  cell: steerCell
};
