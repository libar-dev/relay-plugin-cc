import steerMain from './steer-main.mjs';
import steerWorkflow from './steer-workflow.mjs';
import steerPlugin from './steer-plugin.mjs';
import continueCheck from './continue.mjs';
import commands from './commands.mjs';
import transfer from './transfer.mjs';
import headless from './headless.mjs';
import stop from './stop.mjs';
import sessionEnd from './session-end.mjs';
import spawnCheck from './spawn-check.mjs';
import typed from './typed.mjs';
import statusLine from './status-line.mjs';
import board from './board.mjs';

export const checks = [steerMain, steerWorkflow, steerPlugin, continueCheck, commands, transfer, headless, stop, sessionEnd, spawnCheck, typed, statusLine, board];

export function getCheck(id) {
  return checks.find(check => check.id === id);
}
