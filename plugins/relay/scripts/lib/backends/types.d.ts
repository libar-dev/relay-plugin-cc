// The backend contract. Each backend is one folder under lib/backends/ whose index.mjs
// exports one object of type Backend; lib/backends/index.mjs is the registry and the only
// module that names them. docs/backends.md explains each member.

import type { ChildProcess } from "node:child_process";

export type BackendName = "codex" | "grok" | "zcode" | "kimi";
export type Mode = "yolo" | "write" | "read-only";
export type WebSearch = "live" | "cached" | "indexed" | "disabled";

// ---------------------------------------------------------------------------------------
// The backend object

export interface Backend {
  /** The header's `backend:` value. */
  name: BackendName;
  /** The name in text a person reads: "Codex", "Grok", "ZCode", "Kimi". */
  label: string;
  /** What the backend can do. The one declaration of each fact. */
  capabilities: Capabilities;
  /** Words that qualify a capability on setup's `can:` line. They never state one. */
  capabilityNotes: CapabilityNotes;
  /** How a header becomes this backend's launch request. */
  request: RequestRules;
  /** The state block's lines and `status --json` fields this backend adds. */
  view: StateView;
  /** Start one server process for a worker attempt or a review. */
  connect(request: LaunchRequest, hooks: ConnectHooks): Promise<Connection>;
  /** The transport error for a server that ended before its turn did. */
  endMessage(exit: ExitInfo | null): string;
  /** Which notifications reach events.jsonl, and when. */
  eventRecorder(write: (notification: Notification) => void, touch: () => void): EventRecorder;
  /** The setup page's checks for this backend's homes. */
  setup: SetupProbe;
  /** How reviews run on this backend. */
  review: ReviewSupport;
  /** Import a Claude Code session into a backend session (`capabilities.transfer`). */
  transfer?(cwd: string, sourcePath: string, env: NodeJS.ProcessEnv): Promise<TransferResult>;
  /** Whether the backend can start at all, within a time limit (`capabilities.stopGate`). */
  probe?(cwd: string, options: { timeoutMs: number, env: NodeJS.ProcessEnv }): Promise<ProbeResult>;
}

export interface Capabilities {
  modes: Mode[];
  webSearch: WebSearch[];
  /** `fast: true` selects OpenAI's priority service tier. */
  priorityTier: boolean;
  steer: boolean;
  resume: boolean;
  review: boolean;
  adversarialReview: boolean;
  stopGate: boolean;
  transfer: boolean;
}

export interface CapabilityNotes {
  /** After the mode list: "write refused". */
  modes?: string;
  /** After "web search off": "tool filter". */
  webSearchOff?: string;
  /** After the review features the backend lacks: "Codex only". */
  lacking?: string;
}

// ---------------------------------------------------------------------------------------
// Requests

/** The header's values, by request field name (`web-search` arrives as `webSearch`). */
export type HeaderValues = Record<string, string | string[] | undefined>;

/** The stored launch request. Generic fields first; a backend adds its own (`BackendFields`). */
export interface LaunchRequest extends BackendFields {
  backend: BackendName;
  model: string | null;
  effort: string | null;
  fast: boolean;
  mode: Mode;
  network: boolean;
  webSearch: WebSearch;
  cwd: string;
  addDirs: string[];
  /** Extra roots a `write` job may write: `add-dir` and a linked worktree's git directories. */
  writableRoots: string[];
  /** What the plugin decided on its own; printed as `note:` lines. */
  notes: string[];
}

/** Fields only one backend reads, such as Grok's home or Codex's MCP servers turned off. */
export interface BackendFields {
  [field: string]: unknown;
}

export interface RequestRules {
  /** Header keys only this backend takes, mapped to the request field each sets. */
  headerKeys: Record<string, string>;
  /** Ends the "is required" message: "Use `model: default` to <defaultSource>." */
  defaultSource: string;
  /** The effort `effort: default` gives a job; null leaves it to the backend's configuration. */
  defaultEffort: string | null;
  /**
   * Why a value the capabilities lack is refused: the text after
   * "<key>: <value> is not supported for <label>", with its own punctuation.
   */
  refusals: { mode?: Partial<Record<Mode, string>>, webSearch?: string };
  /** The note for an ignored `fast: true` when the backend has no priority tier. */
  priorityTierNote?: string;
  /**
   * The backend's own fields, checks and notes, after every generic rule passed. Pushes notes
   * onto `request.notes`; throws a UsageError for a combination the backend refuses.
   */
  complete(request: LaunchRequest, values: HeaderValues, context: RequestContext): BackendFields;
}

export interface RequestContext {
  env: NodeJS.ProcessEnv;
  /** The user settings in the jobs home's config.json. */
  userConfig: { fastTier: string, mcpOff: string[] };
}

export interface StateView {
  /** Backend settings at the existing settings position in launch and state blocks. */
  settingLines?(request: LaunchRequest): string[];
  /** Lines after `backend:`, which generic code prints for every backend but the default. */
  lines(request: LaunchRequest): string[];
  /** The same facts for `status --json`, beside `backend`. */
  json(request: LaunchRequest): Record<string, unknown>;
  /** The state note for a completion inferred from this backend's history. */
  completionInferenceLine?(inference: Record<string, unknown>, context: { sessionId: string | null, turnId: string | null }): string | null;
}

// ---------------------------------------------------------------------------------------
// Sessions

export interface ConnectHooks {
  env: NodeJS.ProcessEnv;
  /** This backend's record in job.json (`job.backendState`), as last saved. */
  state: Record<string, unknown>;
  /** Merge a patch into `job.backendState` and write job.json before returning. */
  saveState(patch: Record<string, unknown>): void;
  /** Every notification the server sends, and every event the backend records itself. */
  tap(notification: Notification): void;
  onSpawn?(proc: ChildProcess): void;
  onStderr?(chunk: Buffer): void;
  onEnd?(exit: ExitInfo): void;
}

/**
 * One server process and the session on it. A connection is stateful: it remembers its
 * session, its running turn and what it sent, so the worker passes only the work.
 */
export interface Connection {
  readonly server: ServerState;
  /** Open a new session, or resume `sessionId`. */
  open(options: OpenOptions): Promise<OpenedSession>;
  /** Whether a work item reached the session before a previous worker died. */
  delivered(item: Pick<WorkItem, "clientId" | "recoveryCandidate">): boolean;
  /** Run one turn and wait for it to end. Never throws for a turn that failed. */
  run(turn: TurnInput): Promise<TurnResult>;
  /** Whether steer and interrupt can be sent to the running turn now. */
  controlsReady(turnId: string | null): boolean;
  /** Add a message to the running turn. Throws when the turn cannot take it. */
  steer(turnId: string | null, message: InboxMessage): Promise<SteerReceipt>;
  interrupt(turnId: string | null): Promise<void>;
  /**
   * For a steer whose receipt was `unconfirmed`: whether the backend's own history now holds
   * it. A backend whose receipts are always proof leaves these out.
   */
  steerHeld?(messageId: string): boolean;
  /** The worker gave up on an unconfirmed steer: it runs as the next turn instead. */
  steerLost?(messageId: string): void;
  close(): Promise<void>;
}

export interface ServerState {
  readonly exitInfo: ExitInfo | null;
  /** The process exited; its pipes may still be draining. */
  readonly exitSeen: boolean;
  /** The end is recorded and every pending request has failed. */
  readonly exitResolved: boolean;
  readonly exitPromise: Promise<void>;
  /** The last 4 KiB of the server's stderr. */
  readonly stderr: string;
}

export interface ExitInfo {
  pid: number | null;
  code: number | null;
  signal: string | null;
  endedAt: string;
  stdoutClosedBeforeExit: boolean;
  partialStdoutBytes: number;
  stderrTail: string;
}

export interface OpenOptions {
  sessionId: string | null;
  /** Whether a turn ever ran on `sessionId`, so a lost draft is told from lost work. */
  sessionUsed: boolean;
  /** A label for a new session, where the backend has one. */
  sessionName: string | null;
  /** A session the backend may forget once it closes (reviews). */
  ephemeral?: boolean;
}

export interface OpenedSession {
  sessionId: string;
  resumed: boolean;
  /** The service tier the backend chose, where it reports one. */
  serviceTier?: string | null;
  /** What the backend decided on its own while opening; each becomes a `note:` once. */
  notes?: string[];
}

export interface WorkItem {
  prompt: string;
  source: "brief" | "steer" | "continue" | "resume" | "retry";
  message: InboxMessage | null;
  /** Sent with the prompt, so a resumed session tells which items reached it. */
  clientId: string;
  /** The default "write the final report" resume, dropped when other work runs. */
  isDefault?: boolean;
  /** Re-queued after a worker or server death: check `delivered` before sending it again. */
  recoveryCandidate?: boolean;
}

export interface InboxMessage {
  id: string;
  kind: "steer" | "continue" | "resume" | "cancel";
  text: string;
  automatic?: boolean;
  isDefault?: boolean;
}

export interface TurnInput {
  prompt: string;
  clientId: string;
  source: WorkItem["source"];
  /** The backend accepted the prompt; steers and interrupts may go from now on. */
  onPending(): void;
  /** The backend named the turn. */
  onTurnId(turnId: string): void;
  /** The schema the answer must match, for a backend whose `review.schema` is `"turn"`. */
  outputSchema?: object;
}

export interface TurnResult {
  turnStatus: "completed" | "failed" | "interrupted" | string | null;
  turnId?: string | null;
  finalMessage?: string;
  error?: { message?: string, codexErrorInfo?: unknown, data?: unknown } | null;
  /** The turn ended, but its completion could not be read: the final message may stand. */
  completionReadError?: string | null;
  completionInference?: Record<string, unknown> | null;
  /** False for a backend that retries model calls itself: the worker never retries it. */
  retryable?: boolean;
  /** A capacity or request-rate failure identified by the backend's protocol. */
  capacity?: boolean;
  /** The turn did work beyond reading its prompt, so a retry continues instead of resending. */
  didWork?: boolean;
  /** Steers the backend accepted but lost before a turn took them: they run next. */
  unjoinedSteers?: string[];
  /** Steers the backend may still hold: reported dropped, never sent again. */
  droppedSteers?: Array<{ id: string, reason: string }>;
  /**
   * The backend took the prompt but cannot show that it started, and may still hold it. The job
   * fails with `error`, the prompt is reported dropped and never sent again, and the round ends:
   * nothing more is sent on this server, which the worker then closes.
   */
  teardown?: boolean;
  reasoningSummary?: string[] | null;
  /** Stderr for a foreground result, where the backend filters transport diagnostics. */
  stderr?: string;
}

export interface SteerReceipt {
  turnId?: string | null;
  /** The backend's own id for the steer, kept in the outcome. */
  promptId?: string;
  /** Acknowledged without proof of delivery: confirm with `steerHeld`. */
  unconfirmed?: boolean;
}

export interface Notification {
  method: string;
  params?: any;
}

export interface EventRecorder {
  record(notification: Notification): void;
  flush(): void;
}

// ---------------------------------------------------------------------------------------
// Setup

export interface SetupProbe {
  /** The flag of `setup --backend <name>` that picks a non-default home: "grok-home". */
  homeFlag?: string;
  /** Every home of this backend, in page order. */
  homes(env: NodeJS.ProcessEnv): SetupHome[];
  /** The home `setup --backend <name> [--<homeFlag> value]` checks. */
  home(value: string | null, env: NodeJS.ProcessEnv): SetupHome;
  /** Started once per page for every home of this backend: the binary and its version. */
  prepare(context: SetupContext): unknown;
  check(home: SetupHome, shared: unknown, context: SetupContext): Promise<SetupBlock>;
  /** The sign-in line, where the generic wording does not fit; null keeps the generic one. */
  signInText?(block: SetupBlock): string | null;
  /** What to do next for this block; empty when nothing is needed. */
  nextSteps(block: SetupBlock, context: SetupContext): string[];
  /** The page offers this backend's optional stop gate when it is off. */
  reviewGateNextStep?: string;
}

export interface SetupContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  limits: { commandMs: number, serverMs: number };
}

export interface SetupHome {
  backend: BackendName;
  home: string;
  homeDefault: boolean;
  /** The header value that selects this home, for a non-default one. */
  selector: string | null;
}

export interface SetupBlock extends SetupHome {
  binary: string | null;
  binaryIsScript: boolean;
  realBinary: string | null;
  version: string | null;
  signIn: { state: string, method: string | null, detail: string | null };
  model: string | null;
  modelNote: string | null;
  effort: string | null;
  effortNote: string | null;
  modelsReason: string | null;
  models: Array<{ id: string, efforts: string[] | null, defaultEffort: string | null }>;
  can: Omit<Capabilities, "webSearch" | "priorityTier"> & { webSearchOff: boolean };
  warnings: string[];
  ready: boolean;
  error: string | null;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------------------
// Reviews, transfer, probe

export interface ReviewSupport {
  /** The adversarial schema reaches the model as the turn's `outputSchema`, or in the prompt. */
  schema: "turn" | "prompt";
  /** The review reads only a diff inlined in its prompt, so the inline limits apply. */
  inlineDiff: boolean;
  /** The note for an effort the native reviewer ignores. */
  nativeEffortNote?(effort: string): string;
  /** Advice when this backend cannot review an oversized inline diff. */
  inlineDiffAdvice?: string;
  /** Check runtime availability before collecting review input. */
  prepare?(request: LaunchRequest): void;
  /** `/relay:review` on the backend's own reviewer. Absent: the plugin's plain prompt runs. */
  native?(request: LaunchRequest, target: NativeReviewTarget, hooks: ConnectHooks): Promise<NativeReviewResult>;
}

export interface NativeReviewTarget {
  mode: "working-tree" | "branch";
  baseRef?: string | null;
  label: string;
}

export interface NativeReviewResult {
  status: number;
  sessionId: string | null;
  /** The session the review was started from, where the backend reviews in a second one. */
  sourceSessionId?: string | null;
  reviewText: string;
  reasoningSummary: string[] | null;
  error?: { message?: string } | null;
  stderr: string;
  /** Backend-specific fields in the existing native review JSON block. */
  details?: Record<string, unknown>;
}

export interface TransferResult {
  sessionId: string;
  stderr: string;
  /** The transfer command preserves the backend's established payload and text. */
  payload: Record<string, unknown>;
  lines: string[];
}

export interface ProbeResult {
  available: boolean;
  detail: string;
}
