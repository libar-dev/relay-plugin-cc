import steerMain from './steer-main.mjs';
import steerWorkflow from './steer-workflow.mjs';
import steerPlugin from './steer-plugin.mjs';
import continueCheck from './continue.mjs';

import stop from './stop.mjs';
import sessionEnd from './session-end.mjs';
import spawnCheck from './spawn-check.mjs';

export const checks = [steerMain, steerWorkflow, steerPlugin, continueCheck, stop, sessionEnd, spawnCheck];

export function getCheck(id) {
  return checks.find(check => check.id === id);
}
