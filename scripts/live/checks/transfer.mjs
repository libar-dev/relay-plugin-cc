import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandRuns, readTranscript, scopeToRun, formatSeconds } from '../lib/evidence.mjs';
import { commandPrompt, commandResult, requireCommand, requireBuild, statusBuild } from './commands.mjs';

export default {
  id: 'transfer', title: 'Answer /relay:transfer with no model turn', backends: ['codex'],
  surfaces: ['terminal', 't3'], probes: [], timeoutMinutes: 5, marker: 'LIVE-TRANSFER-READY',
  prompt({ runId }) { return commandPrompt(runId, this.marker); },
  commands: () => [{ text: '/relay:status', backend: null }, { text: '/relay:transfer', backend: 'codex' }],
  analyze(input) {
    const rows = commandRuns((this.scope ?? scopeToRun)(readTranscript(input.transcript), input.runId), input.run);
    const evidence = { transcripts: [input.transcript], agents: [], files: [] };
    // Preserve just this session's ledger entries and canonical path, before the transcript grows
    // or disappears. A replay must prove the same import without consulting the user's live ledger.
    const snapshot = path.join(input.evidenceDir, 'transfer-imports.json');
    let imports;
    if (!input.fromCopy) {
      imports = { sourcePath: null, records: [] };
      try {
        imports.sourcePath = fs.realpathSync(input.transcript);
        const home = (input.env ?? process.env).CODEX_HOME || path.join(os.homedir(), '.codex');
        const ledger = JSON.parse(fs.readFileSync(path.join(home, 'external_agent_session_imports.json'), 'utf8'));
        imports.records = (Array.isArray(ledger?.records) ? ledger.records : [])
          .filter(record => record?.source_path === imports.sourcePath);
      } catch (error) { imports.error = `Cannot read transfer import evidence: ${error.code ?? error.message}.`; }
      fs.writeFileSync(snapshot, JSON.stringify(imports) + '\n');
    }
    try {
      const file = (input.evidencePath ?? (file => file))(snapshot);
      evidence.files.push(file);
      imports = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) { imports = { error: `Cannot read transfer import evidence: ${error.code ?? error.message}.` }; }
    const results = input.backends.map(backend => {
      const result = commandResult(backend);
      try {
        if (rows.length !== 2) throw new Error('Expected status and transfer commands.');
        const status = requireCommand(rows[0], '/relay:status');
        Object.assign(result, statusBuild(status));
        requireBuild(status, input.run);
        const { verbatim } = requireCommand(rows[1], '/relay:transfer');
        const id = verbatim.match(/^Codex session ID: ([A-Za-z0-9-]+)$/m)?.[1];
        if (!id || !verbatim.split('\n').some(line => line === `codex resume ${id}` || line === `Resume in Codex: codex resume ${id}`)) throw new Error('Transfer did not name a Codex session and its resume command.');
        if (imports.error) throw new Error(imports.error);
        const start = Date.parse(rows[1].startedAt) / 1000, answer = Date.parse(rows[1].answeredAt) / 1000;
        if (!imports.records.some(record => record.imported_thread_id === id && record.source_path === imports.sourcePath &&
          Number.isInteger(record.imported_at) && record.imported_at >= start - 2 && record.imported_at <= answer + 2)) {
          throw new Error('Transfer import ledger does not match the named Codex session, this transcript and this command\'s time.');
        }
        result.timings = { transferSeconds: [rows[1].seconds] };
        result.result = 'pass';
      } catch (error) { result.reason = error.message; }
      return result;
    });
    return { results, details: rows, evidence };
  },
  cell(record) { return `no model turn; imported in ${formatSeconds(record.timings.transferSeconds ?? [])}`; }
};
