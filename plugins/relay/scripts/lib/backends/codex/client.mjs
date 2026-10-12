import { partialLineNote, SpawnedServerClient } from "../transport/stdio-rpc.mjs";


export function serverEndMessage(info) {
  const how = info?.signal ? `signal ${info.signal}` : `exit ${info?.code ?? "unknown"}`;
  return `codex server ended before turn/completed (${how}).${info?.pid ? ` pid ${info.pid}.` : ""}${partialLineNote(info)}`;
}


export class CodexAppServerClient {
  // Each client owns its server's lifetime. Sharing a long-lived server can reuse
  // ChatGPT's single-use refresh token and log out other clients of the same home
  // (openai/codex-plugin-cc#789); closing it also bounds its process and memory use.
  static async connect(cwd, options = {}) {
    const client = new SpawnedServerClient(cwd, options);
    try {
      await client.initialize();
    } catch (error) {
      await client.close();
      throw error;
    }
    return client;
  }
}
