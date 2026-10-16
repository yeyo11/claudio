import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateLegacyStorage } from '../src/lib/legacy-storage.ts';

class MemoryStorage {
  readonly items = new Map<string, string>();
  constructor(entries: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(entries)) this.items.set(key, value);
  }
  get length(): number {
    return this.items.size;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

test('every key kept under the old product name moves to its claudio name and the old one is removed', () => {
  const storage = new MemoryStorage({
    'agentry-theme': 'light',
    'agentry-language': 'es',
    'agentry-notifications:v1': '{"items":[]}',
    'agentry:filters:/chats': '{"q":"x"}',
    'agentry.token': 'secret',
    'agentry-composer-draft:chat-1': 'half a prompt',
    'agentry-review-seen:v1:cr-1': '["a.ts"]',
  });
  assert.equal(migrateLegacyStorage(storage), 7);
  assert.deepEqual(Object.fromEntries(storage.items), {
    'claudio-theme': 'light',
    'claudio-language': 'es',
    'claudio-notifications:v1': '{"items":[]}',
    'claudio:filters:/chats': '{"q":"x"}',
    'claudio.token': 'secret',
    'claudio-composer-draft:chat-1': 'half a prompt',
    'claudio-review-seen:v1:cr-1': '["a.ts"]',
  });
});

test('a value already stored under the new name wins, and the old key still goes', () => {
  const storage = new MemoryStorage({ 'agentry-diff-mode': 'split', 'claudio-diff-mode': 'unified' });
  assert.equal(migrateLegacyStorage(storage), 0);
  assert.deepEqual(Object.fromEntries(storage.items), { 'claudio-diff-mode': 'unified' });
});

test('keys that are not the old product’s own are left alone, and a second run moves nothing', () => {
  const storage = new MemoryStorage({ 'cw:sidebar-collapsed': '1', agentryish: 'x', 'claudio-motion': 'off', 'agentry-chat-inspector': 'closed' });
  assert.equal(migrateLegacyStorage(storage), 1);
  assert.equal(migrateLegacyStorage(storage), 0);
  assert.deepEqual(Object.fromEntries(storage.items), { 'cw:sidebar-collapsed': '1', agentryish: 'x', 'claudio-motion': 'off', 'claudio-chat-inspector': 'closed' });
});
