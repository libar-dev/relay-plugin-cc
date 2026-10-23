// The board's values in `$.state`, which the engine checks the module's reads and writes against.
// plugin.json names this file as the plugin's `types`. Rows are the companion's JSON (docs/design.md,
// "JSON for programs") cut to what the board draws; views are kept as it printed them.

export type RelayBoardJob = {
  id: string;
  state: "starting" | "running" | "completed" | "failed" | "cancelled" | "dead";
  backend: string;
  model: string | null;
  effort: string | null;
  attempts: number;
  completedAt: string | null;
  reportPath: string | null;
  relay: {
    agentId: string | null;
    workflowRunId: string | null;
    label: string | null;
    lastToolAt: string | null;
  } | null;
  // A running job whose relay had not called for 15 minutes when the list was read.
  isRelayLost: boolean;
  notHandedBack: boolean;
  undeliveredCount: number;
  relayViolationCount: number;
  openMessages: number;
};

export type RelayBoardList = {
  jobs: RelayBoardJob[];
  nextCursor: string | null;
  // Whether a read has succeeded; until one has, there is nothing to list.
  isRead: boolean;
  // A busy answer kept the last read.
  isBusy: boolean;
  error: string | null;
};

export type RelayBoardMessage = {
  kind: string;
  preview: string;
  stage: string;
  createdAt: string | null;
  // The relay's record of handing the message to the job; null for a message sent to it directly.
  relay: { entry: string; at: string | null } | null;
  outcome: { action: string } | null;
};

export type RelayBoardDetail = {
  id: string;
  // The row's facts the view was read at; null to read it again.
  mark: string | null;
  // When the last read that succeeded started; a live job's view is read again 30 s after it.
  readAt: number | null;
  // After a failed read, the time before which it is not read again unless its row is pressed.
  retryAt: number | null;
  // Whether a read has succeeded.
  isRead: boolean;
  messages: RelayBoardMessage[];
  report: string | null;
  isBusy: boolean;
  error: string | null;
};

// A send the relay refused, for the person to send to the job directly: its text, its kind, and
// the attempt count it was meant for.
export type RelayBoardRetry = {
  text: string;
  kind: "steer" | "continue";
  attempts: number;
};

declare module "claude-code" {
  interface PluginState {
    relay: {
      boardList: RelayBoardList | null;
      // The rows listed, and the cursor of the page they start at (null for the newest).
      boardWindow: { limit: number; cursor: string | null };
      boardSelected: string | null;
      boardDetail: RelayBoardDetail | null;
      // The last send's or cancel's line for a job, a refused send to send directly, and for a send
      // the relay took, the line once the job's messages show it handed over: a message the relay
      // carried, created since `since`, whose preview is the sent text's `preview`.
      boardNote: {
        id: string;
        line: string;
        retry: RelayBoardRetry | null;
        delivered: { since: number; preview: string; line: string } | null;
      } | null;
      boardConfirm: { id: string; attempt: number } | null;
      // Not the board's: the stop notice's TaskStop marks, an agent id or the text a TaskStop named,
      // each with the time its mark ends, or null for a mark made when the clock could not be read.
      stopMarks: Record<string, number | null>;
    };
  }
}
