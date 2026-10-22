// The board's values in `$.state`, which the engine checks the module's reads and writes against.
// plugin.json names this file as the plugin's `types`. Rows and views are the companion's JSON
// (docs/design.md, "JSON for programs"), kept as it printed them.

export type RelayBoardJob = {
  id: string;
  state: "starting" | "running" | "completed" | "failed" | "cancelled" | "dead";
  backend: string;
  model: string | null;
  effort: string | null;
  attempts: number;
  updatedAt: string | null;
  claudeSessionId: string | null;
  reportPath: string | null;
  relay: {
    agentId: string | null;
    workflowRunId: string | null;
    label: string | null;
    lastToolAt: string | null;
  } | null;
  notHandedBack: boolean;
  undeliveredCount: number;
  relayViolationCount: number;
  openMessages: number;
};

export type RelayBoardList = {
  jobs: RelayBoardJob[];
  nextCursor: string | null;
  readAt: number | null;
  // A busy answer kept the last read.
  isBusy: boolean;
  error: string | null;
};

export type RelayBoardMessage = {
  kind: string;
  preview: string;
  stage: string;
  outcome: { action: string } | null;
};

export type RelayBoardDetail = {
  id: string;
  // The row's facts the view was read at; null to read it again.
  mark: string | null;
  messages: RelayBoardMessage[];
  report: string | null;
  isBusy: boolean;
  error: string | null;
};

declare module "claude-code" {
  interface PluginState {
    relay: {
      boardList: RelayBoardList | null;
      boardLimit: number;
      boardSelected: string | null;
      boardDetail: RelayBoardDetail | null;
      // The last send's or cancel's line for a job, and a refused send's text to send directly.
      boardNote: { id: string; line: string; retry: string | null } | null;
      boardConfirm: { id: string; attempt: number } | null;
    };
  }
}
