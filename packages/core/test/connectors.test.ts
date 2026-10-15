import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Connectors, connectorKind, parseConnectors } from '../src/connectors.ts';
import { tempConfig } from './helpers.ts';

const LIST = `Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ! Needs authentication
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ✘ Failed to connect
claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected
my-own-server: npx -y some-mcp - ✔ Connected
`;

test('parses only the claude.ai connectors, with the CLI status and prepared actions', () => {
  const connectors = parseConnectors(LIST);
  assert.deepEqual(
    connectors.map((c) => [c.id, c.name, c.kind, c.status]),
    [
      ['claude.ai Claude Docs', 'Claude Docs', 'docs', 'connected'],
      ['claude.ai Gmail', 'Gmail', 'gmail', 'needs-auth'],
      ['claude.ai Google Calendar', 'Google Calendar', 'calendar', 'unknown'],
      ['claude.ai Slack', 'Slack', 'other', 'connected'],
    ],
  );
  const [docs, gmail, calendar, slack] = connectors;
  assert.ok(docs?.actions?.length);
  // Nothing to ask of a connector that cannot answer yet, nor of one Claudio has no prompts for
  assert.equal(gmail?.actions, undefined);
  assert.ok(calendar?.actions?.length);
  assert.equal(slack?.actions, undefined);
  assert.match(calendar?.detail ?? '', /fail/i);
});

test('classifies a connector by its name', () => {
  assert.equal(connectorKind('claude.ai Google Calendar'), 'calendar');
  assert.equal(connectorKind('claude.ai Gmail'), 'gmail');
  assert.equal(connectorKind('claude.ai Claude Docs'), 'docs');
  assert.equal(connectorKind('claude.ai Slack'), 'other');
});

test('overview reports what is missing, what a person must do and what has no CLI surface', async () => {
  const config = tempConfig();
  const stub = join(config.dataDir, 'claude-stub.sh');
  const counter = join(config.dataDir, 'calls');
  // A shell stub stands in for the CLI: `claude mcp list` is the only thing asked of it
  writeFileSync(stub, `#!/bin/sh\n[ "$1" = mcp ] || exit 1\necho x >> '${counter}'\ncat <<'EOF'\nclaude.ai Gmail: https://g - ✔ Connected\nEOF\n`);
  chmodSync(stub, 0o755);
  const connectors = new Connectors({ ...config, claudeBin: stub });

  const overview = await connectors.overview();
  assert.equal(overview.error, undefined);
  assert.deepEqual(overview.notListed, ['docs', 'calendar']);
  assert.ok(overview.authorisation.steps.some((s) => s.text.includes('/mcp')));
  assert.deepEqual(overview.unavailable.map((l) => l.id), ['web-artifacts', 'claude-ai-memory']);
  for (const limit of overview.unavailable) assert.match(limit.reason.text, /no public API and no CLI command/);

  // Served from the cache until a refresh is asked for
  await connectors.overview();
  await connectors.overview(true);
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(counter, 'utf8').trim().split('\n').length, 2);
});

test('a missing CLI is an error on the overview, not an empty list read as "no connectors"', async () => {
  const overview = await new Connectors({ ...tempConfig(), claudeBin: '/nonexistent/claude' }).overview();
  assert.deepEqual(overview.connectors, []);
  assert.ok(overview.error);
  assert.equal(overview.unavailable.length, 2);
});

/**
 * A stand-in CLI that answers `mcp_status` on stdin: the first `pendingFor` answers read `pending`
 * before the servers settle. `claude mcp list` prints a line of its own, so a test can tell which
 * source answered.
 */
function statusStub(dir: string, servers: unknown[], pendingFor = 0): string {
  const stub = join(dir, 'claude-status-stub.mjs');
  writeFileSync(
    stub,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
if (process.argv[2] === 'mcp') {
  console.log('claude.ai Fallback: https://f - ✔ Connected');
  process.exit(0);
}
let asked = 0;
const servers = ${JSON.stringify(servers)};
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const pending = asked++ < ${String(pendingFor)};
  const list = servers.map((s) => (pending ? { name: s.name, status: 'pending', scope: s.scope } : s));
  console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { mcpServers: list } } }));
});
`,
  );
  chmodSync(stub, 0o755);
  return stub;
}

const SERVERS = [
  { name: 'mine', status: 'connected', scope: 'user', tools: [{ name: 'x' }] },
  { name: 'claude.ai Gmail', status: 'needs-auth', scope: 'claudeai', source: 'claudeai' },
  { name: 'claude.ai Claude Docs', status: 'connected', scope: 'claudeai', source: 'claudeai', config: { token: 'secret' }, tools: [{ name: 'read' }, { name: 'update' }] },
  { name: 'claude.ai Slack', status: 'failed', scope: 'claudeai', source: 'claudeai', error: 'boom' },
];

test('the overview comes from mcp_status: a connector pending authorisation shows, with tool counts', async () => {
  const config = tempConfig();
  const connectors = new Connectors({ ...config, claudeBin: statusStub(config.dataDir, SERVERS) });
  const overview = await connectors.overview();
  assert.equal(overview.error, undefined);
  assert.deepEqual(
    overview.connectors.map((c) => [c.id, c.name, c.kind, c.status, c.toolCount, c.detail]),
    [
      ['claude.ai Gmail', 'Gmail', 'gmail', 'needs-auth', undefined, undefined],
      ['claude.ai Claude Docs', 'Claude Docs', 'docs', 'connected', 2, undefined],
      ['claude.ai Slack', 'Slack', 'other', 'unknown', undefined, 'boom'],
    ],
  );
  assert.deepEqual(overview.notListed, ['calendar']);
  assert.equal(JSON.stringify(overview).includes('secret'), false);
});

test('the probe polls while a server is pending and reports it once settled', async () => {
  const config = tempConfig();
  const connectors = new Connectors({ ...config, claudeBin: statusStub(config.dataDir, SERVERS, 2) }, { probePollMs: 10 });
  const overview = await connectors.overview();
  assert.equal(overview.connectors.find((c) => c.name === 'Claude Docs')?.status, 'connected');
});

test('a server still pending at the ceiling is reported as it is, not as an error', async () => {
  const config = tempConfig();
  const connectors = new Connectors({ ...config, claudeBin: statusStub(config.dataDir, SERVERS, 1_000_000) }, { probePollMs: 10, probeCeilingMs: 100 });
  const overview = await connectors.overview();
  assert.equal(overview.error, undefined);
  const docs = overview.connectors.find((c) => c.name === 'Claude Docs');
  assert.equal(docs?.status, 'unknown');
  assert.equal(docs?.detail, 'Still connecting');
});

test('when the probe fails the claude mcp list scrape answers', async () => {
  const config = tempConfig();
  const stub = join(config.dataDir, 'claude-mute-stub.sh');
  // Exits at once without answering mcp_status; `mcp list` still works
  writeFileSync(stub, `#!/bin/sh\nif [ "$1" = mcp ]; then echo 'claude.ai Gmail: https://g - ✔ Connected'; exit 0; fi\nexit 3\n`);
  chmodSync(stub, 0o755);
  const overview = await new Connectors({ ...config, claudeBin: stub }).overview();
  assert.equal(overview.error, undefined);
  assert.deepEqual(overview.connectors.map((c) => c.id), ['claude.ai Gmail']);
});
