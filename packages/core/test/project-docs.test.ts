import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectorsOverview } from '@claudio/shared';
import type { ChatRuntime, NewChat, RunResult } from '../src/chats.ts';
import { mcpServerPrefix, parseDocUrl, ProjectDocsError, ProjectDocsService, type DocsRuntime } from '../src/project-docs.ts';
import { tempConfig } from './helpers.ts';

const overview = (status: 'connected' | 'needs-auth' | null): ConnectorsOverview => ({
  connectors: status ? [{ id: 'claude.ai Claude Docs', name: 'Claude Docs', kind: 'docs', status, detail: '' }] : [],
  notListed: [],
  authorisation: { steps: [], links: [] },
  unavailable: [],
  checkedAt: new Date().toISOString(),
});

function fakeRuntime(answers: unknown[]): { runtime: DocsRuntime; started: NewChat[]; removed: string[] } {
  const started: NewChat[] = [];
  const removed: string[] = [];
  const runtime: DocsRuntime = {
    start(opts) {
      started.push(opts);
      return { id: `c${String(started.length)}` } as ChatRuntime;
    },
    waitForResult: () => Promise.resolve({ isError: false, result: '', structuredOutput: answers.shift(), costUsd: 0 } satisfies RunResult),
    stop: () => undefined,
    exited: () => Promise.resolve(),
    remove(id) {
      removed.push(id);
      return true;
    },
  };
  return { runtime, started, removed };
}

const report = (id: string, title: string, found = true) => ({ id, found, title, url: found ? `https://claude.ai/docs/${id}` : '' });

function service(answers: unknown[], status: 'connected' | 'needs-auth' | null = 'connected') {
  const config = tempConfig();
  const fake = fakeRuntime(answers);
  const docs = new ProjectDocsService({ config, runtime: fake.runtime, connectors: { overview: () => Promise.resolve(overview(status)) } });
  return { docs, ...fake };
}

test('the server prefix is the CLI name of the connector', () => {
  assert.equal(mcpServerPrefix('claude.ai Claude Docs'), 'mcp__claude_ai_Claude_Docs');
});

test('only claude.ai https links are accepted', () => {
  assert.equal(parseDocUrl(' https://claude.ai/docs/a#x '), 'https://claude.ai/docs/a');
  for (const bad of ['http://claude.ai/a', 'https://evil.example/a', 'https://claude.ai.evil.example/a', 'nope', 3]) {
    assert.throws(() => parseDocUrl(bad), ProjectDocsError);
  }
});

test('adds a document by link through a confined session, and removes it from the registry only', async () => {
  const { docs, started, removed } = service([{ docs: [report('d1', 'Plan')] }, { docs: [report('d1', 'Plan')] }]);
  const entry = await docs.add('p1', { url: 'https://claude.ai/docs/d1' });
  assert.deepEqual([entry.id, entry.title, entry.createdBy, entry.status], ['d1', 'Plan', 'person', 'ok']);
  assert.deepEqual(docs.overview('p1').docs.map((d) => d.id), ['d1']);
  const chat = started[0];
  assert.deepEqual(chat?.allowedTools, ['mcp__claude_ai_Claude_Docs']);
  assert.deepEqual(chat?.confine, { tools: [], settingSources: [] });
  assert.equal(chat?.toolConfig?.mcp, null);
  assert.equal(chat?.permissionMode, 'dontAsk');
  assert.deepEqual(removed, ['c1']);
  await assert.rejects(() => docs.add('p1', { url: 'https://claude.ai/docs/d1' }), /already/);
  await docs.remove('p1', 'd1');
  assert.deepEqual(docs.overview('p1').docs, []);
  await assert.rejects(() => docs.remove('p1', 'd1'), /not found/);
});

test('creates a document and records it as made by Claudio', async () => {
  const { docs, started } = service([{ docs: [report('n1', 'Spec')] }]);
  const entry = await docs.add('p1', { create: { title: 'Spec', body: 'First draft' } }, 'es');
  assert.equal(entry.createdBy, 'claudio');
  assert.match(started[0]?.prompt ?? '', /create exactly one new document/);
  assert.match(started[0]?.prompt ?? '', /First draft/);
});

test('an empty body asks for an outline in the person\'s language', async () => {
  const { docs, started } = service([{ docs: [report('n1', 'Spec')] }]);
  await docs.add('p1', { create: { title: 'Spec', body: '' } }, 'es');
  assert.match(started[0]?.prompt ?? '', /Spanish/);
});

test('refuses a request with both or neither of url and create', async () => {
  const { docs } = service([]);
  await assert.rejects(() => docs.add('p1', {}), /either/);
  await assert.rejects(() => docs.add('p1', { url: 'https://claude.ai/a', create: { title: 't', body: '' } }), /either/);
});

test('a document the connector cannot open is not added', async () => {
  const { docs } = service([{ docs: [report('', '', false)] }]);
  await assert.rejects(() => docs.add('p1', { url: 'https://claude.ai/docs/zz' }), /could not open/);
  assert.deepEqual(docs.overview('p1').docs, []);
});

test('needs a connected Docs connector', async () => {
  for (const status of ['needs-auth', null] as const) {
    const { docs, started } = service([], status);
    await assert.rejects(() => docs.add('p1', { url: 'https://claude.ai/docs/d1' }), (err: unknown) => err instanceof ProjectDocsError && err.statusCode === 409);
    assert.equal(started.length, 0);
  }
});

test('an unreadable answer is a 502 and the session is still removed', async () => {
  const { docs, removed } = service([{ nonsense: true }]);
  await assert.rejects(() => docs.add('p1', { url: 'https://claude.ai/docs/d1' }), (err: unknown) => err instanceof ProjectDocsError && err.statusCode === 502);
  assert.deepEqual(removed, ['c1']);
});

test('refresh updates titles, and marks a vanished document instead of dropping it', async () => {
  const { docs } = service([{ docs: [report('a', 'A')] }, { docs: [report('b', 'B')] }, { docs: [report('a', 'A renamed'), report('b', '', false)] }]);
  await docs.add('p1', { url: 'https://claude.ai/docs/a' });
  await docs.add('p1', { url: 'https://claude.ai/docs/b' });
  const result = await docs.refresh('p1');
  assert.deepEqual(result.docs.map((d) => [d.id, d.title, d.status]), [['a', 'A renamed', 'ok'], ['b', 'B', 'unavailable']]);
  assert.ok(result.refreshedAt);
});

test('refreshing an empty registry starts no session', async () => {
  const { docs, started } = service([]);
  const result = await docs.refresh('p1');
  assert.deepEqual(result.docs, []);
  assert.equal(started.length, 0);
});
