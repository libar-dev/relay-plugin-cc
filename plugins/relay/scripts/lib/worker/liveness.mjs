// A silent turn is allowed to run indefinitely while its backend answers requests.
// The first ping discovers support on this connection; failure disables only this watchdog.
import { TransportTimeout } from "../backends/transport/stdio-rpc.mjs";
export const STALLED_AFTER_MS = 10 * 60 * 1000;
export const PING_INTERVAL_MS = 5 * 60 * 1000;

export function backendLiveness(connection, { now = Date.now, note = (_info) => {} } = {}) {
  let enabled = false, stopped = false, pending = false, misses = 0, lastPing = -Infinity;
  let lastNotification = now();
  const method = connection.pingMethod;
  const ping = async () => {
    try { await connection.ping(); return true; }
    catch (error) {
      // An RPC error is an answer too (ACP normally answers -32601).
      if (Number.isInteger(error.rpcCode)) return true;
      return false;
    }
  };
  return {
    touch() { lastNotification = now(); },
    stop() { stopped = true; },
    async open() {
      if (!connection.ping) return;
      enabled = await ping();
      if (!stopped) note({ enabled, method, state: enabled ? "backend answering" : "watchdog disabled", reason: enabled ? null : "open-time ping was not answered; control deadlines remain active" });
    },
    async tick(active) {
      if (!active || !enabled || stopped || pending || now() - lastNotification < STALLED_AFTER_MS || now() - lastPing < PING_INTERVAL_MS) return;
      pending = true;
      lastPing = now();
      note({ enabled, method, state: "checking the backend" });
      try {
        const answered = await ping();
        if (stopped) return;
        misses = answered ? 0 : misses + 1;
        note({ enabled, method, state: answered ? "backend answering" : "checking the backend", misses });
        if (misses >= 2) connection.server.markWedged(new TransportTimeout(connection.request.backend, method, 30000));
      } finally { pending = false; }
    }
  };
}
