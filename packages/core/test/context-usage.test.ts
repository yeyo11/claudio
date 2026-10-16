import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseContextUsage } from '../src/providers/claude-code/context-usage.ts';

const recorded = (file: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/recordings/claude/${file}`, import.meta.url)), 'utf8')) as Record<string, unknown>;

/** An answer with `loaded` loaded tools of 10 tokens on one server, in a window of `window` tokens */
const mcpAnswer = (loaded: number, window = 1_000_000, tokensEach = 10) => ({
  maxTokens: window,
  rawMaxTokens: window,
  mcpTools: Array.from({ length: loaded }, (_, i) => ({ name: `mcp__big__t${i}`, serverName: 'big', tokens: tokensEach, isLoaded: true })),
});

test('the recorded full answer parses: figures, keyed rows, auto-compaction, memory files, skills', () => {
  const b = parseContextUsage(recorded('context-usage-full.json'));
  assert.equal(b.model, 'claude-haiku-5-5');
  assert.equal(b.totalTokens, 18514);
  assert.equal(b.maxTokens, 1_000_000);
  assert.equal(b.rawMaxTokens, 1_000_000);
  assert.equal(b.percentage, 2);
  assert.deepEqual(b.autoCompact, { enabled: true, thresholdTokens: 967_000 });
  assert.equal(b.overBy, null);
  assert.deepEqual(
    b.categories.map((c) => [c.key, c.kind]),
    [
      ['system-prompt', 'used'], ['system-tools', 'used'], ['mcp-tools', 'used'], ['mcp-tools-deferred', 'deferred'],
      ['system-tools-deferred', 'deferred'], ['memory-files', 'used'], ['skills', 'used'], ['messages', 'used'],
      ['autocompact-buffer', 'buffer'], ['free-space', 'free'],
    ],
  );
  assert.deepEqual(b.memoryFiles, [{ path: '/home/user/probe/CLAUDE.md', type: 'Project', tokens: 58 }]);
  assert.deepEqual(b.skills, { total: 14, included: 14, tokens: 2210 });
  assert.deepEqual(b.slashCommands, { total: 14, included: 14, tokens: 919 });
  assert.deepEqual(b.messages, { toolCalls: 77, toolResults: 67, attachments: 19661, assistant: 283, user: 37, other: 0 });
  assert.deepEqual(b.agents, []);
});

test('the recorded summary answer parses to the same shape, with its own (higher) estimates', () => {
  const summary = parseContextUsage(recorded('context-usage-summary.json'));
  const full = parseContextUsage(recorded('context-usage-full.json'));
  assert.deepEqual(Object.keys(summary), Object.keys(full));
  assert.ok(summary.categories.find((c) => c.key === 'system-tools')!.tokens > full.categories.find((c) => c.key === 'system-tools')!.tokens);
});

test('a project agent is read by its type and source', () => {
  const b = parseContextUsage(recorded('context-usage-agent.json'));
  assert.deepEqual(b.agents, [{ name: 'probe-reviewer', source: 'projectSettings', tokens: 39 }]);
  assert.equal(b.categories.find((c) => c.key === 'custom-agents')?.kind, 'used');
  assert.deepEqual(b.mcp.servers, []);
});

test('a row with no tokens is dropped, and the rest keep their order', () => {
  const b = parseContextUsage({
    categories: [
      { name: 'Messages', tokens: 0, kind: 'used' },
      { name: 'Skills', tokens: 5, kind: 'used' },
      { name: 'Free space', tokens: 0, kind: 'free' },
      { name: 'System prompt', tokens: 7, kind: 'used' },
    ],
  });
  assert.deepEqual(b.categories.map((c) => c.name), ['Skills', 'System prompt']);
});

test('deferred tools count as tools but not as loaded, and stay out of the share', () => {
  const b = parseContextUsage(recorded('context-usage-full.json'));
  assert.deepEqual(b.mcp.servers.map((s) => [s.server, s.tools, s.loadedTools]), [['alpha', 10, 1], ['beta', 1, 0]]);
  assert.equal(b.mcp.loadedTools, 1);
  assert.equal(b.mcp.tokens, 71);
  assert.equal(b.mcp.share, 71 / 1_000_000);
  assert.deepEqual(b.mcp.warnings, []);
});

test('MCP tools are summed per server, the heaviest server first', () => {
  const b = parseContextUsage({
    maxTokens: 1000,
    mcpTools: [
      { name: 'mcp__a__x', serverName: 'a', tokens: 5, isLoaded: true },
      { name: 'mcp__b__x', serverName: 'b', tokens: 30 },
      { name: 'mcp__a__y', serverName: 'a', tokens: 6 },
      { name: 'mcp__a__z', serverName: 'a', tokens: 99, isLoaded: false },
    ],
  });
  // `isLoaded` absent counts as loaded
  assert.deepEqual(b.mcp.servers, [
    { server: 'b', tools: 1, loadedTools: 1, tokens: 30 },
    { server: 'a', tools: 3, loadedTools: 2, tokens: 11 },
  ]);
  assert.equal(b.mcp.tokens, 41);
});

test('many-tools is raised at 81 loaded tools and not at 80', () => {
  assert.deepEqual(parseContextUsage(mcpAnswer(80)).mcp.warnings, []);
  assert.deepEqual(parseContextUsage(mcpAnswer(81)).mcp.warnings, ['many-tools']);
});

test('large-share is raised at 20 % of the window and not below it', () => {
  assert.deepEqual(parseContextUsage(mcpAnswer(1, 100, 19)).mcp.warnings, []);
  assert.deepEqual(parseContextUsage(mcpAnswer(1, 100, 20)).mcp.warnings, ['large-share']);
  assert.deepEqual(parseContextUsage(mcpAnswer(81, 10_000, 1)).mcp.warnings, ['many-tools']);
  assert.deepEqual(parseContextUsage(mcpAnswer(100, 100, 1)).mcp.warnings, ['many-tools', 'large-share']);
});

test('deferred tools never raise a warning however many there are', () => {
  const b = parseContextUsage({
    maxTokens: 100,
    mcpTools: Array.from({ length: 300 }, (_, i) => ({ name: `mcp__d__t${i}`, serverName: 'd', tokens: 50, isLoaded: false })),
  });
  assert.deepEqual(b.mcp.warnings, []);
  assert.equal(b.mcp.servers[0]?.tools, 300);
  assert.equal(b.mcp.share, 0);
});

test('a name that was not recorded is not keyed, and its kind still counts', () => {
  const b = parseContextUsage({ categories: [{ name: 'Plugins', tokens: 12, kind: 'deferred' }] });
  assert.deepEqual(b.categories, [{ name: 'Plugins', key: null, kind: 'deferred', tokens: 12 }]);
});

test('a row of a kind nobody knows is left out rather than guessed', () => {
  assert.deepEqual(parseContextUsage({ categories: [{ name: 'Messages', tokens: 3, kind: 'mystery' }] }).categories, []);
});

test('a window the total passes reports by how much', () => {
  const b = parseContextUsage({ totalTokens: 1_250, maxTokens: 1_000, rawMaxTokens: 1_000 });
  assert.equal(b.overBy, 250);
});

test('a value of the wrong type is read as absent, and nothing throws', () => {
  const b = parseContextUsage({
    model: 7,
    totalTokens: 'many',
    maxTokens: null,
    percentage: {},
    categories: 'none',
    mcpTools: [null, 'x', { serverName: 4, tokens: 1 }, { serverName: 'ok', tokens: 'lots' }],
    memoryFiles: [{ path: 1, tokens: 'x' }],
    agents: {},
    skills: 'no',
    slashCommands: [],
    messageBreakdown: 5,
    autoCompactThreshold: '90',
    isAutoCompactEnabled: 'yes',
  });
  assert.equal(b.model, '');
  assert.equal(b.totalTokens, 0);
  assert.equal(b.maxTokens, 0);
  assert.equal(b.percentage, 0);
  assert.deepEqual(b.categories, []);
  assert.deepEqual(b.mcp.servers, [{ server: 'ok', tools: 1, loadedTools: 1, tokens: 0 }]);
  assert.deepEqual(b.memoryFiles, [{ path: '', type: '', tokens: 0 }]);
  assert.deepEqual(b.agents, []);
  assert.equal(b.skills, null);
  assert.equal(b.slashCommands, null);
  assert.equal(b.messages, null);
  assert.deepEqual(b.autoCompact, { enabled: false, thresholdTokens: null });
  assert.doesNotThrow(() => parseContextUsage({}));
});
