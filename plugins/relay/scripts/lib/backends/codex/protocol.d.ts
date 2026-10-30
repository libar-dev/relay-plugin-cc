// The Codex 0.162.0 wire fields this plugin sends or reads. Unread response fields are
// omitted; opaque JSON stays opaque. These declarations require no CLI generation.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface ClientInfo { name: string; title: string | null; version: string }
export interface InitializeCapabilities {
  experimentalApi: boolean;
  requestAttestation: boolean;
  optOutNotificationMethods?: string[] | null;
}
export interface InitializeParams { clientInfo: ClientInfo; capabilities: InitializeCapabilities | null }
export type InitializeResponse = Record<string, never>;

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type AskForApproval = "never";
export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };
export interface ThreadStartParams {
  cwd?: string | null;
  model?: string | null;
  serviceTier?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: { [key: string]: JsonValue } | null;
  developerInstructions?: string | null;
  serviceName?: string | null;
  ephemeral?: boolean | null;
}
export interface ThreadResumeParams {
  threadId: string;
  cwd?: string | null;
  model?: string | null;
  serviceTier?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: { [key: string]: JsonValue } | null;
  developerInstructions?: string | null;
}
export interface Thread {
  id: string;
  name: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  turns: Turn[];
}
export interface ThreadStartResponse { thread: Thread; serviceTier: string | null }
export interface ThreadResumeResponse { thread: Thread; serviceTier: string | null }
export interface ThreadReadParams { threadId: string; includeTurns?: boolean }
export interface ThreadReadResponse { thread: Thread }
export interface ThreadListParams { cwd?: string | null; limit?: number | null; sortKey?: "updated_at" | null; sourceKinds?: "appServer"[] | null; searchTerm?: string | null }
export interface ThreadListResponse { data: Thread[] }
export interface ThreadSetNameParams { threadId: string; name: string }
export type ThreadSetNameResponse = Record<string, never>;

export interface TextElement { byteRange: { start: number; end: number }; placeholder: string | null }
export type UserInput = { type: "text"; text: string; text_elements: TextElement[] };
export type TurnStatus = "inProgress" | "completed" | "failed" | "interrupted";
export interface TurnError { message: string; codexErrorInfo: unknown; additionalDetails: string | null }
export interface Turn { id: string; status: TurnStatus; items: ThreadItem[]; error: TurnError | null }
export type ThreadItem =
  | { type: "userMessage"; id: string; clientId: string | null }
  | { type: "agentMessage"; id: string; text: string; phase: "commentary" | "partial_answer" | "final_answer" | null }
  | { type: "reasoning"; id: string; summary: string[] }
  | { type: "commandExecution"; id: string; command: string; status: "inProgress" | "completed" | "failed" | "declined"; exitCode: number | null }
  | { type: "fileChange"; id: string; changes: { path: string }[]; status: "inProgress" | "completed" | "failed" | "declined" }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: "inProgress" | "completed" | "failed" }
  | { type: "dynamicToolCall"; id: string; tool: string; status: "inProgress" | "completed" | "failed" }
  | { type: "collabAgentToolCall"; id: string; tool: string; status: "inProgress" | "completed" | "failed" | "interrupted"; receiverThreadIds: string[] }
  | { type: "webSearch"; id: string; query: string }
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string };
export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  clientUserMessageId?: string | null;
  model?: string | null;
  effort?: string | null;
  serviceTier?: string | null;
  sandboxPolicy?: SandboxPolicy | null;
  outputSchema?: JsonValue | null;
}
export interface TurnStartResponse { turn: Turn }
export interface TurnSteerParams { threadId: string; input: UserInput[]; clientUserMessageId?: string | null; expectedTurnId: string }
export interface TurnSteerResponse { turnId: string }
export interface TurnInterruptParams { threadId: string; turnId: string }
export type TurnInterruptResponse = Record<string, never>;
export type ReviewTarget = { type: "uncommittedChanges" } | { type: "baseBranch"; branch: string };
export interface ReviewStartParams { threadId: string; target: ReviewTarget; delivery?: "inline" | "detached" | null }
export interface ReviewStartResponse { turn: Turn; reviewThreadId: string }

export interface SessionMigration { path: string; cwd: string; title: string | null }
export interface MigrationDetails {
  plugins: never[];
  sessions: SessionMigration[];
  mcpServers: never[];
  hooks: never[];
  subagents: never[];
  commands: never[];
}
export interface ExternalAgentConfigMigrationItem { itemType: "SESSIONS"; description: string; cwd: string | null; details: MigrationDetails | null }
export interface ExternalAgentConfigImportParams { migrationItems: ExternalAgentConfigMigrationItem[] }
export type ExternalAgentConfigImportResponse = Record<string, never>;

export type Account = { type: "apiKey" } | { type: "chatgpt"; email: string | null } | { type: "amazonBedrock" };
export interface GetAccountParams { refreshToken?: boolean }
export interface GetAccountResponse { account: Account | null; requiresOpenaiAuth: boolean }
export interface ConfigReadParams { includeLayers?: boolean; cwd?: string | null }
export interface Config {
  model: string | null;
  model_reasoning_effort: string | null;
  model_provider: string | null;
  model_providers?: { [key: string]: { name?: string } };
}
export interface ConfigReadResponse { config: Config }
export interface Model { id: string; model: string; hidden: boolean; supportedReasoningEfforts: { reasoningEffort: string }[]; defaultReasoningEffort: string; isDefault: boolean }
export interface ModelListParams { cursor?: string | null; limit?: number | null; includeHidden?: boolean | null }
export interface ModelListResponse { data: Model[]; nextCursor: string | null }

export interface ThreadStartedNotification { thread: Thread }
export interface ThreadNameUpdatedNotification { threadId: string; threadName?: string }
export interface TurnStartedNotification { threadId: string; turn: Turn }
export interface TurnCompletedNotification { threadId: string; turn: Turn }
export interface ItemStartedNotification { threadId: string; turnId: string; item: ThreadItem }
export interface ItemCompletedNotification { threadId: string; turnId: string; item: ThreadItem }
export interface ErrorNotification { threadId: string; turnId: string; error: TurnError }
export type ExternalAgentConfigImportCompletedNotification = Record<string, never>;
export interface WarningNotification { message: string }
export interface ConfigWarningNotification { summary: string }
export type ServerNotification =
  | { method: "thread/started"; params: ThreadStartedNotification }
  | { method: "thread/name/updated"; params: ThreadNameUpdatedNotification }
  | { method: "turn/started"; params: TurnStartedNotification }
  | { method: "turn/completed"; params: TurnCompletedNotification }
  | { method: "item/started"; params: ItemStartedNotification }
  | { method: "item/completed"; params: ItemCompletedNotification }
  | { method: "error"; params: ErrorNotification }
  | { method: "externalAgentConfig/import/completed"; params: ExternalAgentConfigImportCompletedNotification }
  | { method: "warning"; params: WarningNotification }
  | { method: "configWarning"; params: ConfigWarningNotification };

export interface ServerClientOptions {
  backendName?: string;
  env?: NodeJS.ProcessEnv;
  clientInfo?: ClientInfo;
  capabilities?: InitializeCapabilities;
}
export interface AppServerMethodMap {
  initialize: { params: InitializeParams; result: InitializeResponse };
  "externalAgentConfig/import": { params: ExternalAgentConfigImportParams; result: ExternalAgentConfigImportResponse };
  "thread/start": { params: ThreadStartParams; result: ThreadStartResponse };
  "thread/resume": { params: ThreadResumeParams; result: ThreadResumeResponse };
  "thread/name/set": { params: ThreadSetNameParams; result: ThreadSetNameResponse };
  "thread/read": { params: ThreadReadParams; result: ThreadReadResponse };
  "turn/steer": { params: TurnSteerParams; result: TurnSteerResponse };
  "thread/list": { params: ThreadListParams; result: ThreadListResponse };
  "review/start": { params: ReviewStartParams; result: ReviewStartResponse };
  "turn/start": { params: TurnStartParams; result: TurnStartResponse };
  "turn/interrupt": { params: TurnInterruptParams; result: TurnInterruptResponse };
  "account/read": { params: GetAccountParams; result: GetAccountResponse };
  "config/read": { params: ConfigReadParams; result: ConfigReadResponse };
  "model/list": { params: ModelListParams; result: ModelListResponse };
}
export type AppServerMethod = keyof AppServerMethodMap;
export type AppServerRequestParams<M extends AppServerMethod> = AppServerMethodMap[M]["params"];
export type AppServerResponse<M extends AppServerMethod> = AppServerMethodMap[M]["result"];
export type AppServerNotification = ServerNotification;
export type AppServerNotificationHandler = (message: AppServerNotification) => void;
