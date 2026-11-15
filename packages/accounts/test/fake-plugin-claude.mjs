// A `claude` that answers only `plugin ...`, the way 2.1.322 does for a user-scope plugin: the
// account's own `plugins/` holds the records and a clone of each marketplace catalog as it was when
// the marketplace was added or last updated, and `enabledPlugins` goes into the settings file
// through any link. Usage: fake-plugin-claude.mjs <state file> <log file> <args...>.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [stateFile, logFile, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile, 'utf8')); // { sources, catalog, fail, hang, delayMs }
const dir = process.env.CLAUDE_CONFIG_DIR;
const started = Date.now();
const log = (extra) => appendFileSync(logFile, `${JSON.stringify({ dir, args, started, ended: Date.now(), leaks: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDIO_AUTH_TOKEN'].filter((n) => process.env[n]), ...extra })}\n`);
const fail = (message) => {
  log({ failed: message });
  console.error(message);
  process.exit(1);
};
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const plugins = join(dir, 'plugins');
mkdirSync(plugins, { recursive: true });
const recordsFile = join(plugins, 'installed_plugins.json');
const knownFile = join(plugins, 'known_marketplaces.json');
const cloneFile = (market) => join(plugins, `catalog-${market}.json`);
const records = () => readJson(recordsFile, { version: 2, plugins: {} });
const settingsFile = () => {
  try {
    return realpathSync(join(dir, 'settings.json'));
  } catch {
    return join(dir, 'settings.json');
  }
};
const setEnabled = (id, on) => {
  const settings = readJson(settingsFile(), {});
  settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}) };
  if (on) settings.enabledPlugins[id] = true;
  else delete settings.enabledPlugins[id];
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
};
const cloneVersion = (id) => {
  const at = id.lastIndexOf('@');
  const clone = readJson(cloneFile(id.slice(at + 1)), null);
  if (!clone) fail(`Marketplace "${id.slice(at + 1)}" not found`);
  const version = clone[id.slice(0, at)];
  if (!version) fail(`Plugin "${id}" not found`);
  return version;
};
const snapshot = (market) => writeFileSync(cloneFile(market), JSON.stringify(state.catalog[market] ?? {}));

if (args[0] !== 'plugin') fail(`this fake answers only plugin commands, got ${args[0]}`);
if (state.hang) {
  log({ hung: true });
  setTimeout(() => process.exit(0), 60_000);
} else {
  const [, sub, third, fourth] = args;
  const key = sub === 'marketplace' ? `marketplace-${third}:${fourth}` : `${sub}:${third}`;
  if ((state.fail ?? []).includes(key)) fail(`simulated failure of ${key}`);
  const finish = () => {
    if (sub === 'marketplace' && third === 'add') {
      const name = state.sources[fourth];
      if (!name) fail(`unknown marketplace source ${fourth}`);
      writeFileSync(knownFile, JSON.stringify({ ...readJson(knownFile, {}), [name]: { source: { source: 'github', repo: fourth }, installLocation: join(plugins, 'marketplaces', name) } }));
      snapshot(name);
    } else if (sub === 'marketplace' && third === 'update') {
      if (!(fourth in readJson(knownFile, {}))) fail(`Marketplace "${fourth}" not found`);
      snapshot(fourth);
    } else if (sub === 'install' || sub === 'update') {
      const version = cloneVersion(third);
      const doc = records();
      if (sub === 'update' && !doc.plugins[third]) fail(`Plugin "${third}" is not installed`);
      doc.plugins[third] = [{ scope: 'user', installPath: join(plugins, 'cache', third, version), version, installedAt: new Date(started).toISOString() }];
      writeFileSync(recordsFile, JSON.stringify(doc, null, 2));
      if (sub === 'install') setEnabled(third, true);
    } else if (sub === 'uninstall') {
      const doc = records();
      if (!doc.plugins[third]) fail(`Plugin "${third}" is not installed`);
      delete doc.plugins[third];
      writeFileSync(recordsFile, JSON.stringify(doc, null, 2));
      setEnabled(third, false);
    } else fail(`unknown command ${args.join(' ')}`);
    log({});
  };
  setTimeout(finish, state.delayMs ?? 0);
}
