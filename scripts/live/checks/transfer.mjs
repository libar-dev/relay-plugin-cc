import { commandRuns, readTranscript, scopeToRun, formatSeconds } from '../lib/evidence.mjs';
import { commandPrompt, commandResult, requireCommand } from './commands.mjs';

export default {
  id: 'transfer', title: 'Answer /relay:transfer with no model turn', backends: ['codex'],
  surfaces: ['terminal', 't3'], probes: [], timeoutMinutes: 5, marker: 'LIVE-TRANSFER-READY',
  prompt({ runId }) { return commandPrompt(runId, this.marker); },
  commands: () => [{ text: '/relay:transfer', backend: 'codex' }],
  analyze(input) {
    const rows = commandRuns((this.scope ?? scopeToRun)(readTranscript(input.transcript), input.runId), input.run);
    const results = input.backends.map(backend => {
      const result = { ...commandResult(backend), relayVersion: input.relayVersion };
      try {
        if (rows.length > 1) throw new Error('Expected one transfer command.');
        const { verbatim } = requireCommand(rows[0], '/relay:transfer');
        const id = verbatim.match(/^Codex session ID: ([A-Za-z0-9-]+)$/m)?.[1];
        if (!id || !verbatim.split('\n').some(line => line === `codex resume ${id}` || line === `Resume in Codex: codex resume ${id}`)) throw new Error('Transfer did not name a Codex session and its resume command.');
        result.timings = { transferSeconds: [rows[0].seconds] };
        result.result = 'pass';
      } catch (error) { result.reason = error.message; }
      return result;
    });
    return { results, details: rows, evidence: { transcripts: [input.transcript], agents: [] } };
  },
  cell(record) { return `no model turn; imported in ${formatSeconds(record.timings.transferSeconds ?? [])}`; }
};
