// Model the local settings, registry, cache, and failures used by the smoke scripts.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SMOKE_CALL_LOG, JSON.stringify(args) + '\n');
if (args[0] === '--version') {
  console.log('2.1.308 (Claude Code)');
  process.exit(0);
}
const config = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
const dir = top.status === 0 ? top.stdout.trim() : process.cwd();
const file = path.join(dir, '.claude/settings.local.json');
const registry = path.join(config, 'plugins/installed_plugins.json');
const known = path.join(config, 'plugins/known_marketplaces.json');
const read = target => fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
const write = (target, value) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
};
const fail = message => { console.error(message); process.exit(1); };
const action = args.slice(0, args[1] === 'marketplace' ? 3 : 2).join(' ');
if (process.env.SMOKE_FAIL_ACTION === action) fail('Simulated CLI failure: ' + action);
const settings = read(file);
const installed = read(registry);
const marketplaces = read(known);
const plugin = 'relay@relay-smoke';
if (action === 'plugin marketplace add') {
  marketplaces['relay-smoke'] = { source: { source: 'directory', path: args[3] }, installLocation: args[3] };
  settings.extraKnownMarketplaces ??= {};
  settings.extraKnownMarketplaces['relay-smoke'] = { source: marketplaces['relay-smoke'].source };
  write(known, marketplaces);
} else if (action === 'plugin install') {
  const cache = path.join(config, 'plugins/cache/relay-smoke/relay/test-version');
  fs.mkdirSync(cache, { recursive: true });
  if (process.env.SMOKE_FAIL_AFTER_CACHE) fail('Simulated failure after caching the plugin');
  installed.plugins ??= {};
  installed.plugins[plugin] = [{ scope: 'local', projectPath: dir, installPath: cache }];
  write(registry, installed);
  settings.enabledPlugins ??= {};
  settings.enabledPlugins[plugin] = true;
} else if (action === 'plugin disable') {
  if (process.env.SMOKE_DISABLE_ERROR) fail(process.env.SMOKE_DISABLE_ERROR);
  if (settings.enabledPlugins?.['relay@libar-relay'] !== true) {
    fail('✘ Failed to disable plugin "relay@libar-relay": Plugin "relay@libar-relay" is already disabled at local scope');
  }
  settings.enabledPlugins['relay@libar-relay'] = false;
} else if (action === 'plugin uninstall') {
  if (!installed.plugins?.[plugin]?.length) fail(`Plugin "${plugin}" not found in installed plugins`);
  delete installed.plugins[plugin];
  delete settings.enabledPlugins?.[plugin];
  write(registry, installed);
} else if (action === 'plugin marketplace remove') {
  if (!marketplaces['relay-smoke']) fail('Marketplace not found');
  delete marketplaces['relay-smoke'];
  delete settings.extraKnownMarketplaces?.['relay-smoke'];
  write(known, marketplaces);
} else fail('Unsupported fake CLI command: ' + args.join(' '));
write(file, settings);
