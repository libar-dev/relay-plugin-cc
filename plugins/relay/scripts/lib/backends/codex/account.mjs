import { CodexAppServerClient } from "./client.mjs";
import { binaryAvailable, runLimited } from "../../util/process.mjs";


export async function withDirectAppServer(cwd, fn) {
  const client = await CodexAppServerClient.connect(cwd);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}


export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}


// Each probe has its own time limit and process group, so a hung binary or wrapper
// cannot hold the stop gate open or leave its children running.
export async function getCodexAvailabilityWithin(cwd, { timeoutMs, env = process.env }) {
  const probe = async (args) => {
    const result = await runLimited("codex", args, { cwd, env, timeoutMs });
    if (result.timedOut) {
      return { available: false, detail: `codex ${args.join(" ")}: no answer in ${Number((timeoutMs / 1000).toFixed(1))} s` };
    }
    if (result.error) {
      return { available: false, detail: /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT" ? "not found" : result.error.message };
    }
    if (result.status !== 0) {
      return { available: false, detail: result.stderr.trim() || result.stdout.trim() || (result.signal ? `signal ${result.signal}` : `exit ${result.status}`) };
    }
    return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
  };
  const versionStatus = await probe(["--version"]);
  if (!versionStatus.available) {
    return versionStatus;
  }
  const appServerStatus = await probe(["app-server", "--help"]);
  if (!appServerStatus.available) {
    return { available: false, detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}` };
  }
  return { available: true, detail: `${versionStatus.detail}; advanced runtime available` };
}
