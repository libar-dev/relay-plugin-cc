import { mock } from "node:test";
import { backendNamed } from "../../plugins/relay/scripts/lib/backends/index.mjs";
import { CodexAppServerClient } from "../../plugins/relay/scripts/lib/backends/codex/client.mjs";
import { SpawnedServerClient } from "../../plugins/relay/scripts/lib/backends/transport/stdio-rpc.mjs";

// Use the backend's factory with a scripted server, so connection tests exercise the same
// construction as a worker without starting a process.
export async function scriptedConnection(backend, client, request, hooks = {}) {
  const initialize = mock.method(SpawnedServerClient.prototype, "initialize", async () => {});
  const connect = mock.method(CodexAppServerClient, "connect", async () => client);
  try {
    const connection = await backendNamed(backend).connect(request, { state: {}, saveState() {}, tap() {}, ...hooks, env: { GROK_BINARY: process.execPath, ZCODE_BINARY: process.execPath, ...hooks.env } });
    connection.client = client;
    return connection;
  } finally {
    initialize.mock.restore();
    connect.mock.restore();
  }
}
