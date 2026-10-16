import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { PermissionBroker } from '../src/permissions.ts';
import { ClaudeBranches } from '../src/providers/claude-code/branches.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import type { DriverEvent } from '../src/providers/driver.ts';
import { tempConfig } from './helpers.ts';

// What the CLI's stream-json becomes in a chat: the summary and the event buffer, after replaying
// recorded streams through the fake CLI. The expectations live in fixtures/golden/stream-*.json;
// moving the code that reads the stream must not change a byte. UPDATE_GOLDEN=1 rewrites them,
// which a change of behaviour has to justify.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const fixture = (...parts: string[]) => fileURLToPath(new URL(join('./fixtures', ...parts), import.meta.url));
/** The checkout the fixtures are read from: the prompts of a replay name them by absolute path */
const FIXTURES = fixture();
const golden = (name: string) => fixture('golden', `stream-${name}.json`);

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/;
/** Machine and clock dependent, whatever the code does */
const VOLATILE = new Set(['seq', 'ts', 'pid', 'durationMs']);

/** The same JSON with the ids, times and paths of this run replaced by names, and no key order to lean on. */
function stable(value: unknown, root: string): unknown {
  if (typeof value === 'string') return TIMESTAMP.test(value) ? '<time>' : value.split(root).join('<root>').split(FIXTURES).join('<fixtures>').replace(UUID, '<id>');
  if (Array.isArray(value)) return value.map((v) => stable(v, root));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, v]) => !VOLATILE.has(key) && v !== undefined)
        .map(([key, v]) => [key, stable(v, root)]),
    );
  }
  return value;
}

interface Rig {
  chats: ChatManager;
  broker: PermissionBroker;
  root: string;
  /** What the manager announced besides the stored events, in order */
  heard: Array<[string, unknown]>;
  close(): void;
}

function rig(): Rig {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const chats = new ChatManager(config, db);
  const broker = new PermissionBroker();
  chats.permissions = broker;
  const heard: Array<[string, unknown]> = [];
  for (const name of ['chat-result', 'chat-structured']) chats.on(name, (id: string, payload: unknown) => heard.push([name, payload]));
  return {
    chats,
    broker,
    heard,
    root: join(config.dataDir, '..'),
    close: () => {
      chats.stopAll();
      broker.close();
      db.close();
    },
  };
}

const replay = (file: string, raw = false) => `${raw ? 'REPLAY-RAW' : 'REPLAY'} ${fixture(...file.split('/'))}`;

/** A scenario drives one chat to a resting point and names its id */
const SCENARIOS: Record<string, (r: Rig) => Promise<string>> = {
  'agent-turn': async ({ chats }) => {
    const chat = chats.start({ prompt: replay('replay/agent-turn.jsonl', true), name: 'golden', keepAlive: false });
    await chats.exited(chat.id);
    return chat.id;
  },
  'workflow-session': async ({ chats }) => {
    const chat = chats.start({ prompt: replay('workflow-session/stream.jsonl'), name: 'golden', keepAlive: false });
    await chats.exited(chat.id);
    return chat.id;
  },
  'rate-limit': async ({ chats }) => {
    const chat = chats.start({ prompt: replay('replay/rate-limit.jsonl', true), name: 'golden', keepAlive: false });
    await chats.exited(chat.id);
    return chat.id;
  },
  'budget-stop': async ({ chats }) => {
    const chat = chats.start({ prompt: replay('replay/budget.jsonl', true), name: 'golden', keepAlive: false, maxBudgetUsd: 1 });
    await chats.exited(chat.id);
    return chat.id;
  },
  structured: async ({ chats }) => {
    const chat = chats.start({ prompt: replay('replay/structured.jsonl', true), name: 'golden', keepAlive: false });
    await chats.exited(chat.id);
    return chat.id;
  },
  'permission-prompt': async ({ chats, broker }) => {
    const chat = chats.start({ prompt: 'ASK Bash', name: 'golden', permissionPrompts: 'host' });
    const asked = await until(() => broker.list(chat.id)[0], 'the prompt');
    broker.answer(asked.id, { behavior: 'allow' });
    await until(() => chats.get(chat.id)?.status === 'idle' && chats.events(chat.id).some((e) => e.kind === 'result'), 'the answer');
    return chat.id;
  },
  interrupt: async ({ chats, broker }) => {
    const chat = chats.start({ prompt: 'ASK Bash', name: 'golden', permissionPrompts: 'host' });
    await until(() => broker.list(chat.id)[0], 'the prompt');
    await chats.interrupt(chat.id);
    await until(() => chats.get(chat.id)?.status === 'idle', 'the interrupted turn');
    return chat.id;
  },
};

for (const [name, drive] of Object.entries(SCENARIOS)) {
  test(`the stream of "${name}" folds into the same chat as before chats.ts was split`, async () => {
    const r = rig();
    try {
      const id = await drive(r);
      const stored = readChat(r, id);
      const actual = stable({ summary: stored.summary, events: stored.events, heard: r.heard }, r.root);
      const file = golden(name);
      mkdirSync(join(file, '..'), { recursive: true });
      if (process.env.UPDATE_GOLDEN || !existsSync(file)) writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
      assert.deepEqual(actual, JSON.parse(readFileSync(file, 'utf8')));
    } finally {
      r.close();
    }
  });
}

function readChat(r: Rig, id: string) {
  const summary = r.chats.get(id);
  assert.ok(summary, 'the chat is known');
  return { summary, events: r.chats.events(id) };
}

// A compaction is read from the stream alone: what the manager does with it belongs to the runtime,
// so this one reads the recorded lines into driver events, with no chat in between.
const compactionEvents = (lines: string[]): DriverEvent[] => {
  const events: DriverEvent[] = [];
  const io = { write: () => {}, end: () => {}, up: () => true };
  const session = new ClaudeCodeDriver('claude').attach(io, (e) => events.push(e), new ClaudeBranches());
  for (const line of lines) session.readLine(line);
  return events;
};
const recordedLines = (file: string) => readFileSync(fixture('replay', file), 'utf8').split('\n').filter((l) => l.trim());
/** The environment of an `init` is the same in every recording and says nothing about a compaction */
const folded = (events: DriverEvent[]) => events.map((e) => (e.kind === 'init' ? { kind: e.kind, sessionId: e.sessionId, model: e.model } : e));

test('the stream of "compact" reads the recorded manual compaction, and the one that failed, into the same events as before', () => {
  const manual = compactionEvents(recordedLines('compact-manual.jsonl'));
  const failed = compactionEvents(recordedLines('compact-failed.jsonl'));
  // A status that carries the permission mode while compacting says both, and the mode comes second
  const withMode = compactionEvents([
    JSON.stringify({ type: 'system', subtype: 'status', status: 'compacting', permissionMode: 'plan' }),
    JSON.stringify({ type: 'system', subtype: 'status', status: null, permissionMode: 'default', compact_result: 'success' }),
    // The mode echo of a `set_permission_mode`: no compaction in it
    JSON.stringify({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' }),
  ]);
  assert.deepEqual(withMode.map((e) => e.kind), ['compacting', 'mode-changed', 'compacting', 'mode-changed', 'mode-changed']);
  assert.deepEqual(withMode.filter((e) => e.kind === 'compacting'), [{ kind: 'compacting', active: true }, { kind: 'compacting', active: false }]);

  const actual = stable({ manual: folded(manual), failed: folded(failed), withMode }, '/no/root/in/a/stream');
  const file = fixture('golden', 'stream-compact.json');
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(readFileSync(file, 'utf8')));
});

test('a boundary read from the stream and from the session file is the same entry', () => {
  const live = compactionEvents(recordedLines('compact-manual.jsonl')).find((e) => e.kind === 'compacted');
  assert.ok(live && live.kind === 'compacted');
  assert.equal(live.trigger, 'manual');
  assert.equal(live.entry.compaction?.part, 'boundary');
  assert.equal(live.run.kind, 'message');
  assert.equal(live.preTokens, 18517);
  assert.equal(live.postTokens, 1655);
  assert.equal(live.durationMs, 7063);
});

test('a status that is not about compacting never says compacting is over', () => {
  const events = compactionEvents([
    JSON.stringify({ type: 'system', subtype: 'status', status: null }),
    JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' }),
  ]);
  assert.deepEqual(events, []);
});

test('an automatic attempt that failed reports its error and carries on', () => {
  const events = compactionEvents(recordedLines('compact-auto.jsonl'));
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(events.filter((e) => e.kind === 'compact-failed'), [{ kind: 'compact-failed', error: 'too_few_groups' }]);
  assert.equal(kinds.filter((k) => k === 'compacted').length, 1);
  assert.equal(kinds.filter((k) => k === 'result').length, 2);
});
