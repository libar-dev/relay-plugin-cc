import "./support/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { envNumber } from "../plugins/relay/scripts/cli/shared.mjs";

// CodeRabbit: an empty variable read as 0, so RELAY_JOBS_CANCEL_GRACE_MS="" made cancel wait no grace.
test("envNumber reads an empty or blank variable as unset and keeps an explicit zero", () => {
  const name = "RELAY_TEST_ENV_NUMBER";
  const cases = [[undefined, 7], ["", 7], ["  ", 7], ["0", 0], ["15", 15], ["-1", 7], ["soon", 7]];
  for (const [value, expected] of cases) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    assert.equal(envNumber(name, 7), expected, String(value));
  }
  delete process.env[name];
});
