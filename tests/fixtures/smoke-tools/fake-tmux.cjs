const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SMOKE_TMUX_LOG, JSON.stringify(args) + '\n');
const globals = JSON.parse(process.env.SMOKE_TMUX_GLOBALS || '{}');
const command = args[2];
if (command === 'show-environment') {
  if (process.env.SMOKE_TMUX_NO_SERVER) process.exit(1);
  for (const [name, value] of Object.entries(globals)) console.log(value === null ? `-${name}` : `${name}=${value}`);
} else if (command === 'new-session') {
  const separator = args.indexOf('--');
  const env = { ...process.env, ...globals };
  for (const [name, value] of Object.entries(env)) if (value === null) delete env[name];
  for (let i = 3; i < separator; i++) if (args[i] === '-e') {
    const assignment = args[++i], equal = assignment.indexOf('=');
    env[assignment.slice(0, equal)] = assignment.slice(equal + 1);
  }
  const result = spawnSync(args[separator + 1], args.slice(separator + 2), { env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (command === 'capture-pane') {
  process.stdout.write(process.env.SMOKE_TMUX_SCREEN ?? '');
} else if (!['set-option', 'send-keys'].includes(command)) throw new Error(`Unsupported fake tmux command: ${command}`);
