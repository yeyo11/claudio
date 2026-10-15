import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { tempConfig } from './helpers.ts';

// CHAT-13: a chat someone is reading keeps its process past the idle timeout (docs/plans/chat-experience.md)

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-queue.mjs', import.meta.url));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(20);
  }
}

function rig(limit?: number) {
  const saved = { idle: process.env.CLAUDIO_IDLE_TIMEOUT_MS, max: process.env.CLAUDIO_VIEWED_IDLE_MAX_MS };
  process.env.CLAUDIO_IDLE_TIMEOUT_MS = '200';
  process.env.CLAUDIO_VIEWED_IDLE_MAX_MS = '700';
  const config = tempConfig();
  if (limit) Object.assign(config, { maxConcurrentRuns: limit });
  const db = new Db(config);
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE)]);
  const close = async () => {
    chats.stopAll();
    await pause(150);
    db.close();
    for (const [key, value] of [['CLAUDIO_IDLE_TIMEOUT_MS', saved.idle], ['CLAUDIO_VIEWED_IDLE_MAX_MS', saved.max]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  };
  return { chats, close };
}

const idle = (r: ReturnType<typeof rig>, id: string) => until(() => r.chats.get(id)?.status === 'idle', 'the chat to idle');

test('CHAT-13: an idle chat with a viewer outlives the idle timeout, then ends at the ceiling', async () => {
  const r = rig();
  try {
    const chat = r.chats.start({ prompt: 'hello' });
    await idle(r, chat.id);
    const off = r.chats.subscribe(chat.id, () => {});
    await pause(450);
    assert.equal(r.chats.activeCount(), 1, 'still warm');
    await until(() => r.chats.activeCount() === 0, 'the ceiling to end it', 3000);
    off();
  } finally {
    await r.close();
  }
});

test('CHAT-13: without a viewer the chat ends after the idle timeout', async () => {
  const r = rig();
  try {
    const chat = r.chats.start({ prompt: 'hello' });
    await idle(r, chat.id);
    const off = r.chats.subscribe(chat.id, () => {});
    off();
    await until(() => r.chats.activeCount() === 0, 'the idle end', 1500);
  } finally {
    await r.close();
  }
});

test('CHAT-13: a start at the limit frees a warm idle chat', async () => {
  const r = rig(1);
  try {
    const warm = r.chats.start({ prompt: 'hello' });
    await idle(r, warm.id);
    r.chats.subscribe(warm.id, () => {});
    await pause(300);
    const next = r.chats.start({ prompt: 'second' });
    assert.ok(next.id);
    await until(() => r.chats.activeCount() <= 1, 'the warm one to exit');
  } finally {
    await r.close();
  }
});
