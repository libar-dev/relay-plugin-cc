// Kimi's own record of a session: `<home>/sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl`.
// Kimi appends each batch with a durable write within milliseconds of the event. The ACP stream
// alone cannot carry a turn's outcome: Kimi answers `end_turn` for a turn that failed, and sends
// nothing for a turn it starts on its own (a background task finishing). This record has both.
import fs from "node:fs";
import path from "node:path";

export function wireFile(home, sessionId) {
  if (!home || !/^[A-Za-z0-9_-]+$/.test(sessionId ?? "")) return null;
  const root = path.join(home, "sessions");
  let buckets = [];
  try { buckets = fs.readdirSync(root); } catch { return null; }
  for (const bucket of buckets) {
    const file = path.join(root, bucket, sessionId, "agents", "main", "wire.jsonl");
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Kimi puts the text of its UserPromptSubmit hooks in front of a prompt's own parts, each part
// marked with this source.
const HOOK_SOURCE = "user prompt submit hook";

/** A prompt's own text: its text parts without the ones Kimi's hooks added. */
export function promptText(input) {
  return textParts(input).filter(part => part.meta?.source !== HOOK_SOURCE).map(part => part.text ?? "").join("");
}

function textParts(input) {
  return (Array.isArray(input) ? input : []).filter(part => part?.type === "text");
}

/**
 * @typedef {{ turnId: number, origin: string | null, promptId: string | null, ended: any, report: string, didWork: boolean }} KimiTurn
 * @typedef {{ promptId: string, at: number, text: string | null, delivered: boolean, turnId: number | null, started: boolean, terminal: any }} KimiPrompt
 */

const NEWLINE = 0x0a;

// The session's record as it grows: one reader per connection, advanced by byte offset. A line
// without its newline, with any UTF-8 character it splits, waits in its bytes for the next read,
// so a record written across two reads is still read once, whole. Every read updates one state:
// each turn by Kimi's turn id, each prompt relay sent by Kimi's prompt id, and the turn running.
//
// A prompt has three records, each of which may be missing: delivered (Kimi committed the user
// input, `agent.message.appended`), started (`agent.turn.started` names it, `turn.prompt` runs
// it) and completed (its turn's `turn.ended`). A prompt Kimi's hook blocked, or one cancelled
// before it started, ends with `prompt.completed` or `prompt.aborted` and no turn. Every record
// form of one prompt joins it by Kimi's prompt id, so a prompt counts once however many forms
// the record holds, and two prompts with the same text stay two.
//
// Kimi records two kinds of turn. An engine turn (`agent.turn.started`, `agent.turn.ended`) is one
// run of its loop; a prompt turn (`turn.prompt`, `turn.ended`) is what a prompt, or a turn of
// Kimi's own, asked for. They share ids but not ends: a background task's notice that comes as a
// prompt turn ends runs as a second engine turn inside that prompt turn. Kimi is busy while
// either kind runs, and messages belong to the prompt turn. The engine writes its messages and its
// own end on one path and `turn.ended` on another, so a turn's last messages can follow its
// `turn.ended`: a message goes to the engine turn's prompt turn while that engine turn runs. An
// engine turn with no prompt turn of its own (a notice run inside one) belongs to the prompt turn
// that ran when it started.
export class KimiWire {
  /** @param {() => string | null} locate */
  constructor(locate) {
    this.locate = locate;
    /** @type {string | null} */
    this.file = null;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    /** @type {Map<number, KimiTurn>} */
    this.turns = new Map();
    /** @type {Map<string, KimiPrompt>} */
    this.prompts = new Map();
    /** The prompt turn running, and the engine turn running. @type {number | null} */
    this.running = null;
    /** @type {number | null} */
    this.engine = null;
    /** The prompt turn running when the engine turn started. @type {number | null} */
    this.engineOwner = null;
    // User messages Kimi kept in its context by id, for a prompt blocked before its input record.
    /** @type {Map<string, string[]>} */
    this.userMessages = new Map();
  }

  /** The byte offset just past the last whole record read. */
  get consumed() { return this.offset - this.partial.length; }

  /** Whether a turn runs now, either kind: Kimi's own or one relay sent. */
  get busy() { return this.running !== null || this.engine !== null; }

  /** The prompt turn the running engine turn belongs to, or null. */
  get engineTurn() {
    if (this.engine === null) return null;
    return this.turns.has(this.engine) ? this.engine : this.engineOwner;
  }

  read() {
    this.file ??= this.locate();
    if (!this.file) return this;
    let fd;
    try { fd = fs.openSync(this.file, "r"); }
    catch (error) { if (error.code === "ENOENT") return this; throw error; }
    let chunk;
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= this.offset) return this;
      chunk = Buffer.alloc(size - this.offset);
      chunk = chunk.subarray(0, fs.readSync(fd, chunk, 0, chunk.length, this.offset));
    } finally {
      fs.closeSync(fd);
    }
    const start = this.consumed;
    const bytes = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk;
    this.offset += chunk.length;
    let from = 0;
    for (let end = bytes.indexOf(NEWLINE); end !== -1; end = bytes.indexOf(NEWLINE, from)) {
      const line = bytes.subarray(from, end).toString("utf8");
      const at = start + from;
      from = end + 1;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; /* a line Kimi itself could not load either */ }
      this.apply(record, at);
    }
    this.partial = Buffer.from(bytes.subarray(from));
    return this;
  }

  // A new server process: a turn the record left open belonged to one that died.
  forgetRunning() { this.running = null; this.engine = null; this.engineOwner = null; }

  /**
   * The first prompt relay sent with this text, first recorded at or after byte `from`. Only the
   * prompt's own text counts: a hook's part, which Kimi marks in the record, never matches.
   */
  promptSince(from, text) {
    for (const prompt of this.prompts.values()) {
      if (prompt.at >= from && prompt.text === text) return prompt;
    }
    return null;
  }

  /** @returns {KimiTurn} */
  turn(turnId) {
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = { turnId, origin: null, promptId: null, ended: null, report: "", didWork: false };
      this.turns.set(turnId, turn);
    }
    return turn;
  }

  /** @returns {KimiPrompt} */
  prompt(promptId, at) {
    let prompt = this.prompts.get(promptId);
    if (!prompt) {
      prompt = { promptId, at, text: null, delivered: false, turnId: null, started: false, terminal: null };
      this.prompts.set(promptId, prompt);
    }
    return prompt;
  }

  // A prompt's own text, from the first record form that carries its content.
  inputOf(prompt, content) {
    if (prompt.text !== null || !Array.isArray(content)) return;
    prompt.text = promptText(content);
  }

  started(promptId, turnId, at) {
    const prompt = this.prompt(promptId, at);
    prompt.turnId = turnId;
    prompt.started = true;
    this.turn(turnId).promptId = promptId;
    return prompt;
  }

  apply(record, at) {
    switch (record.type) {
      case "agent.turn.started":
        this.engine = record.turnId;
        this.engineOwner = this.running;
        if (typeof record.queueItemId === "string" && this.prompts.has(record.queueItemId)) this.started(record.queueItemId, record.turnId, at);
        return;
      case "turn.prompt": {
        const turn = this.turn(record.turnId);
        turn.origin = record.origin?.kind ?? null;
        if (!turn.ended) this.running = record.turnId;
        if (turn.origin !== "user" || typeof record.promptId !== "string") return;
        this.inputOf(this.started(record.promptId, record.turnId, at), record.input);
        return;
      }
      case "context.append_message": {
        const message = record.message;
        if (message?.role === "user" && typeof message.id === "string" && (message.origin?.kind ?? "user") === "user") {
          this.userMessages.set(message.id, message.content);
        }
        return;
      }
      case "prompt.completed":
      case "prompt.aborted": {
        if (typeof record.promptId !== "string") return;
        const prompt = this.prompt(record.promptId, at);
        prompt.terminal = record;
        this.inputOf(prompt, this.userMessages.get(record.promptId));
        return;
      }
      case "agent.turn.ended":
        if (this.engine === record.turnId) { this.engine = null; this.engineOwner = null; }
        return;
      case "turn.ended": {
        this.turn(record.turnId).ended = record;
        if (this.running === record.turnId) this.running = null;
        return;
      }
      case "agent.message.appended": {
        const message = record.message?.message;
        const meta = record.message?.meta;
        // Kimi committed the user input: delivered, before any turn exists for it.
        if (message?.role === "user" && meta?.source === "input" && meta.origin?.kind === "user" && typeof meta.promptId === "string") {
          const prompt = this.prompt(meta.promptId, at);
          prompt.delivered = true;
          this.inputOf(prompt, message.content);
          return;
        }
        const owner = this.engineTurn ?? this.running;
        const turn = owner === null ? null : this.turns.get(owner);
        if (!turn || !message) return;
        if (message.role === "tool") turn.didWork = true;
        if (message.role !== "assistant") return;
        const text = (message.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("");
        if (text) turn.didWork = true;
        // The report is the text after the turn's last tool call, as on the other backends.
        if (message.toolCalls?.length) {
          turn.didWork = true;
          turn.report = "";
        } else {
          turn.report += text;
        }
        return;
      }
    }
  }
}
