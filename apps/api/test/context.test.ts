import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, ContextRefusal, loadConfig } from '@claudio/core';
import type { ChatCompaction, ChatContextUsage, ChatSessionNote, CompactRefusal } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

// The routes of docs/plans/context-control.md: what each answers, the 409 codes, and that a chat
// with no process (or a CLI that does not report) is a state and never an error.

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const CHAT = 'chat-ctx-1';
const SUMMARY = ['This session is being continued from a previous conversation.', '', '## Goal', 'Fix the parser.'].join('\n');

async function wrapper(): Promise<{ app: FastifyInstance; core: Core }> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-context-'));
  const config = loadConfig({
    CLAUDE_BIN: '/nonexistent/claude',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
    CLAUDIO_DATA_DIR: join(root, 'data'),
  });
  const dir = join(config.projectsDir, '-work-ctx');
  mkdirSync(dir, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  const at = '2026-03-10T10:00:00Z';
  const usage = { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0, output_tokens: 5 };
  writeFileSync(
    join(dir, `${CHAT}.jsonl`),
    [
      line({ type: 'user', uuid: 'u1', timestamp: at, cwd: '/work/ctx', sessionId: CHAT, message: { role: 'user', content: 'refactor the parser' } }),
      line({ type: 'assistant', uuid: 'a1', timestamp: at, cwd: '/work/ctx', sessionId: CHAT, message: { id: 'm1', role: 'assistant', model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'done' }] } }),
      line({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', timestamp: at, cwd: '/work/ctx', sessionId: CHAT, compact_metadata: { trigger: 'manual', pre_tokens: 90_000, post_tokens: 4_000 } }),
      line({ type: 'user', uuid: 's1', timestamp: at, cwd: '/work/ctx', sessionId: CHAT, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: SUMMARY } }),
    ].join('\n'),
  );
  const core = new Core(config);
  return { app: await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') }), core };
}

const refusal = (code: CompactRefusal | 'saved') => async (): Promise<never> => {
  throw new ContextRefusal(code);
};

test('GET context: no process is a 200 with live false, and a bad detail is a 400', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const res = await app.inject(`/api/chats/${CHAT}/context`);
  assert.equal(res.statusCode, 200);
  const body = res.json() as ChatContextUsage;
  assert.equal(body.live, false);
  assert.equal(body.unreported, 'no-process');
  assert.equal(body.breakdown, null);
  assert.equal((await app.inject(`/api/chats/${CHAT}/context?detail=full`)).statusCode, 200);
  assert.equal((await app.inject(`/api/chats/${CHAT}/context?detail=everything`)).statusCode, 400);
  assert.equal((await app.inject('/api/chats/nope/context')).statusCode, 404);
});

test('GET context: a CLI that does not report is a 200 with unreported', async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const unsupported: ChatContextUsage = { live: true, unreported: 'unsupported', detail: null, observedAt: '2026-03-10T10:00:00Z', snapshot: null, breakdown: null };
  core.context.usage = async () => unsupported;
  const res = await app.inject(`/api/chats/${CHAT}/context`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), unsupported);
});

test('POST compact: 202 with the row, 400 for a bad body, 404, and every refusal is a 409 with its code', async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats/nope/compact', ...json({}) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/compact`, ...json({ focus: 7 }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/compact`, ...json({ focus: 'x'.repeat(501) }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/compact`, ...json({ structuredNote: 'yes' }) })).statusCode, 400);

  const row = { id: 'c1', chatId: CHAT, origin: 'person', state: 'requested' } as ChatCompaction;
  core.context.compact = async () => row;
  const ok = await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/compact`, ...json({ focus: 'the parser' }) });
  assert.equal(ok.statusCode, 202);
  assert.equal((ok.json() as ChatCompaction).id, 'c1');

  const codes: CompactRefusal[] = ['busy', 'waiting', 'open', 'read-only', 'housekeeping', 'at-limit', 'run', 'unsupported', 'no-history'];
  for (const code of codes) {
    core.context.compact = refusal(code);
    const res = await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/compact`, ...json({}) });
    assert.equal(res.statusCode, 409, code);
    const body = res.json() as { code: string; error: string };
    assert.equal(body.code, code);
    assert.ok(body.error.length > 0);
  }
});

test('POST compact: an open row is refused for real, with code open', async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const now = new Date();
  const claimed = core.db.claimHousekeeping(
    CHAT,
    { kind: 'compaction', leaseUntil: new Date(now.getTime() + 60_000).toISOString(), row: { id: 'open-1', origin: 'person', focus: null, structuredNote: true, flowRunId: null, requestedBy: null, requestedAt: now.toISOString() } },
    now.toISOString(),
  );
  assert.ok(claimed);
  const res = await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/compact`, ...json({}) });
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as { code: string }).code, 'open');
  const agent = await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/notes`, ...json({ from: 'agent' }) });
  assert.equal(agent.statusCode, 409);
  assert.equal((agent.json() as { code: string }).code, 'open');
});

test('GET compactions and notes: lists, 404 for an unknown chat', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  assert.deepEqual((await app.inject(`/api/chats/${CHAT}/compactions`)).json(), []);
  assert.deepEqual((await app.inject(`/api/chats/${CHAT}/notes`)).json(), []);
  assert.equal((await app.inject('/api/chats/nope/compactions')).statusCode, 404);
  assert.equal((await app.inject('/api/chats/nope/notes')).statusCode, 404);
});

test('POST notes: summary is 201 and ready, a second time is 409 saved, agent is 202, bad bodies are 400', async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats/nope/notes', ...json({ from: 'agent' }) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/notes`, ...json({ from: 'dream' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/notes`, ...json({ from: 'summary' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/notes`, ...json({ from: 'summary', entryUuid: 'u1' }) })).statusCode, 400);

  const saved = await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/notes`, ...json({ from: 'summary', entryUuid: 's1' }) });
  assert.equal(saved.statusCode, 201);
  const note = saved.json() as ChatSessionNote;
  assert.equal(note.source, 'summary');
  assert.equal(note.state, 'ready');
  const again = await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/notes`, ...json({ from: 'summary', entryUuid: 's1' }) });
  assert.equal(again.statusCode, 409);
  assert.equal((again.json() as { code: string }).code, 'saved');
  assert.equal(((await app.inject(`/api/chats/${CHAT}/notes`)).json() as ChatSessionNote[]).length, 1);

  const pending = { ...note, id: 'n2', source: 'agent', state: 'pending', text: null } as ChatSessionNote;
  core.notes.requestFromAgent = async () => pending;
  const agent = await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/notes`, ...json({ from: 'agent' }) });
  assert.equal(agent.statusCode, 202);
  assert.equal((agent.json() as ChatSessionNote).state, 'pending');
  core.notes.requestFromAgent = refusal('busy');
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/notes`, ...json({ from: 'agent' }) })).statusCode, 409);
});

test('DELETE note: 204, then 404; unknown chat is 404', async (t) => {
  const { app } = await wrapper();
  t.after(() => app.close());
  const note = (await app.inject({ method: 'POST', url: `/api/chats/${CHAT}/notes`, ...json({ from: 'summary', entryUuid: 's1' }) })).json() as ChatSessionNote;
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/chats/nope/notes/${note.id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/chats/${CHAT}/notes/${note.id}` })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/chats/${CHAT}/notes/${note.id}` })).statusCode, 404);
});
