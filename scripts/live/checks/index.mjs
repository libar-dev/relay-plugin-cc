import steerMain from './steer-main.mjs';
import steerWorkflow from './steer-workflow.mjs';
import steerPlugin from './steer-plugin.mjs';
import continueCheck from './continue.mjs';

import commands from './commands.mjs';
import transfer from './transfer.mjs';
import headless from './headless.mjs';

export const checks = [steerMain, steerWorkflow, steerPlugin, continueCheck, commands, transfer, headless];

export function getCheck(id) {
  return checks.find(check => check.id === id);
}
