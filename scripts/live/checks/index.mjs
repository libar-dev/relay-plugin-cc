import steerMain from './steer-main.mjs';
import steerWorkflow from './steer-workflow.mjs';
import steerPlugin from './steer-plugin.mjs';
import continueCheck from './continue.mjs';

export const checks = [steerMain, steerWorkflow, steerPlugin, continueCheck];

export function getCheck(id) {
  return checks.find(check => check.id === id);
}
