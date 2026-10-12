import fs from "node:fs";
import path from "node:path";

const INTERJECTION = /^The user sent a message while you were working:\s*[\s\S]*?<user_query>\s*([\s\S]*?)\s*<\/user_query>/;
export function heldMessage(text) {
  const match = INTERJECTION.exec(text);
  return match ? { method: "_x.ai/interject", text: match[1].trim() } : { method: "session/prompt", text };
}
export function evidenceKey(method, text) { return JSON.stringify([method, method === "_x.ai/interject" ? text.trim() : text]); }
export function countHeld(messages, method, text) {
  return messages.filter(message => evidenceKey(message.method, message.text) === evidenceKey(method, text)).length;
}

// Read only this job's session. Grok can persist an interjection in chat_history.jsonl
// without putting its wrapper among session/load's user_message_chunk notifications.
export function grokSessionMessages(request, sessionId) {
  if (!request.grokHome || !/^[a-zA-Z0-9-]+$/.test(sessionId ?? "")) return [];
  const directories = new Set([request.cwd]);
  try { directories.add(fs.realpathSync(request.cwd)); } catch {}
  for (const cwd of directories) {
    const file = path.join(request.grokHome, "sessions", encodeURIComponent(cwd), sessionId, "chat_history.jsonl");
    let source;
    try { source = fs.readFileSync(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const messages = [];
    // Ignore an unfinished last line, never infer delivery from partial persistence.
    for (const line of source.split("\n").slice(0, -1)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type !== "user") continue;
      const text = typeof entry.content === "string" ? entry.content : (entry.content ?? []).filter(part => part.type === "text").map(part => part.text).join("");
      if (entry.synthetic_reason === "interjection" && INTERJECTION.test(text)) messages.push(heldMessage(text));
      else if (entry.prompt_index != null) {
        const query = /^<user_query>\n([\s\S]*)\n<\/user_query>$/.exec(text);
        if (query) messages.push({ method: "session/prompt", text: query[1] });
      }
    }
    return messages;
  }
  return [];
}

