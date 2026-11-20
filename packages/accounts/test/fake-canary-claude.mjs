#!/usr/bin/env node
// A stand-in for the claude CLI for the canary: the commands S1, S2 and S3c run, in the way the real
// CLI answers them on 2.1.322 (a write through a link, a plugin install, a project server whose
// headersHelper runs only for a trusted project). The first argument is a mode that makes one of them
// behave as a release that broke it would; every call is noted in the file named by the second argument.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode, seenLog, ...args] = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR ?? '/nonexistent';
appendFileSync(seenLog, `${JSON.stringify({ args: args.slice(0, 3), key: process.env.ANTHROPIC_API_KEY ?? null, home: process.env.HOME ?? null, dir })}\n`);
const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);
// Writing a path that is a link writes the file it points to, as the real CLI does on this version
const writeThrough = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const signedOut = () => {
  console.error('Not logged in. Please run /login');
  process.exit(1);
};

if (args[0] === '--version') {
  console.log('2.1.999 (Claude Code)');
} else if (args[0] === 'mcp' && args[1] === 'add') {
  if (mode === 'signed-out') signedOut();
  const file = join(dir, '.claude.json');
  const doc = readJson(file, {});
  doc.mcpServers = { ...doc.mcpServers, [args[4]]: { type: 'stdio', command: args[6] } };
  if (mode === 'replace-state') rmSync(file);
  if (mode === 'drop-server') delete doc.mcpServers[args[4]];
  writeThrough(file, doc);
} else if (args[0] === 'plugin') {
  const settings = join(dir, 'settings.json');
  if (args[1] === 'marketplace' && args[2] === 'add') {
    const doc = readJson(settings, {});
    doc.extraKnownMarketplaces = { 'canary-market': { source: { source: 'directory', path: args[3] } } };
    writeThrough(settings, doc);
  } else if (args[1] === 'install') {
    const doc = readJson(settings, {});
    doc.enabledPlugins = { ...doc.enabledPlugins, [args[2]]: true };
    if (mode === 'replace-settings') rmSync(settings);
    writeThrough(settings, doc);
    if (mode === 'replace-plugins') {
      rmSync(join(dir, 'plugins'), { recursive: true, force: true });
      mkdirSync(join(dir, 'plugins'));
    }
    if (mode !== 'no-record') {
      mkdirSync(join(dir, 'plugins'), { recursive: true });
      writeThrough(join(dir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { [args[2]]: [{ scope: 'user', version: '1.0.0' }] } });
    }
  }
} else if (args.includes('--input-format')) {
  let buffer = '';
  let asked = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      const reply = (response) => console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } }));
      if (msg.request.subtype === 'initialize') {
        if (mode === 'signed-out') console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'Not logged in' } }));
        else reply({ commands: [], models: [] });
      } else if (msg.request.subtype === 'mcp_status') {
        if (mode === 'never-settles' || asked++ === 0) {
          const s6 = readJson(join(dir, '.claude.json'), {}).mcpServers?.['canary-oauth'];
          reply({ mcpServers: [{ name: s6 ? 'canary-oauth' : 'canary', status: 'pending' }] });
          continue;
        }
        const own = readJson(join(dir, '.claude.json'), {}).mcpServers?.['canary-oauth'];
        if (own) {
          // S6: the server of the account's state file, signed in through an `mcpOAuth` entry under the key the real CLI computes
          const hash = createHash('sha256').update(JSON.stringify({ type: own.type, url: own.url, headers: own.headers ?? {} })).digest('hex').slice(0, 16);
          const key = `canary-oauth|${mode === 's6-other-key' ? hash.split('').reverse().join('') : hash}`;
          const entry = readJson(join(dir, '.credentials.json'), {}).mcpOAuth?.[key];
          const res = await fetch(own.url, { method: 'POST', headers: { 'content-type': 'application/json', ...(entry?.accessToken ? { authorization: `Bearer ${entry.accessToken}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
          const open = mode === 's6-open';
          reply({ mcpServers: [{ name: 'canary-oauth', status: res.ok || open ? 'connected' : 'failed' }] });
          continue;
        }
        const mcp = readJson(join(process.cwd(), '.mcp.json'), { mcpServers: {} }).mcpServers.canary;
        const state = readJson(join(dir, '.claude.json'), {});
        const trusted = mode === 'always-trust' || (mode !== 'never-trust' && state.projects?.[realpathSync(process.cwd())]?.hasTrustDialogAccepted === true);
        if (!trusted) {
          reply({ mcpServers: [{ name: 'canary', status: 'failed' }] });
          continue;
        }
        const headers = JSON.parse(execFileSync(process.execPath, [mcp.headersHelper], { encoding: 'utf8' }));
        const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
        reply({ mcpServers: [{ name: 'canary', status: res.ok ? 'connected' : 'failed' }] });
      }
    }
  });
}
