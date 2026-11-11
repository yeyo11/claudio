import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AGENT_MESSAGE_AUTO_PREFIX, AGENT_MESSAGE_PERSON_PREFIX, AGENT_MESSAGE_SUPERVISOR_PREFIX, readSystemMessage, relayToSubagent, type MessageDelivery } from '@claudio/shared';
import { AgentMessageRefusal, AgentMessages, BRIDGE_UNAVAILABLE } from '../src/agent-messages.ts';
import { BRIDGE_MOD_FILES, BRIDGE_MOD_NAME, bridgeModDir, writeBridgeMod } from '../src/bridge-mod.ts';
import { ChatService, type ChatServiceDeps } from '../src/chat-service.ts';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { buildArgs } from '../src/providers/claude-code/args.ts';
import type { SessionLaunch } from '../src/providers/driver.ts';
import { tempConfig } from './helpers.ts';

// Messages straight to one subagent (docs/agent-messages.md): Claudio's queue as rows, the bridge's
// long poll and reports, every refusal and every `undelivered` reason, and the mod's files and flag.

function store(opts: { stopped?: Set<string>; unavailableMs?: number } = {}) {
  const db = new Db(tempConfig());
  const deliveries: Array<{ chatId: string; delivery: MessageDelivery }> = [];
  const messages = new AgentMessages(
    db.connection,
    {
      delivery: (chatId, delivery) => deliveries.push({ chatId, delivery }),
      agentStopped: (_chatId, agentId) => opts.stopped?.has(agentId) ?? false,
    },
    { unavailableMs: opts.unavailableMs ?? 60_000 },
  );
  return { db, messages, deliveries };
}

const words = (w: string) => ({ words: w, text: `${AGENT_MESSAGE_PERSON_PREFIX}\n\n${w}`, source: 'person' as const });

test('a message is listed as written with its `to`, handed to the poll in order, and turns delivered on the report', async () => {
  const { db, messages, deliveries } = store();
  try {
    const one = messages.write('c1', 'a1', words('first'));
    const two = messages.write('c1', 'a2', words('second'));
    assert.equal(one.state, 'written');
    const listed = messages.list('c1', true);
    assert.deepEqual(
      listed.map((m) => [m.id, m.text, m.state, m.to?.agentId, m.source]),
      [
        [one.id, 'first', 'written', 'a1', 'person'],
        [two.id, 'second', 'written', 'a2', 'person'],
      ],
    );
    const next = await messages.next('c1', 0);
    assert.deepEqual(next.messages.map((m) => [m.id, m.agentId]), [[one.id, 'a1'], [two.id, 'a2']]);
    assert.ok(next.messages[0]?.text.startsWith(AGENT_MESSAGE_PERSON_PREFIX));
    // Taken once: a second poll gets nothing
    assert.deepEqual((await messages.next('c1', 0)).messages, []);
    // Still on its way until the CLI answers
    assert.equal(messages.list('c1', true).length, 2);
    assert.equal(messages.report('c1', one.id, { isDelivered: true }), true);
    assert.equal(messages.get('c1', one.id)?.state, 'delivered');
    assert.deepEqual(deliveries.map((d) => [d.delivery.id, d.delivery.state, d.delivery.to?.agentId]), [[one.id, 'delivered', 'a1']]);
    assert.deepEqual(messages.list('c1', true).map((m) => m.id), [two.id]);
  } finally {
    messages.dispose();
    db.close();
  }
});

test('a held poll is woken by the message written meanwhile, and one given up on takes nothing', async () => {
  const { db, messages } = store();
  try {
    const waiting = messages.next('c1', 5);
    const sent = messages.write('c1', 'a1', words('now'));
    assert.deepEqual((await waiting).messages.map((m) => m.id), [sent.id]);
    const gone = new AbortController();
    const abandoned = messages.next('c1', 5, gone.signal);
    gone.abort();
    assert.deepEqual((await abandoned).messages, []);
    const later = messages.write('c1', 'a1', words('later'));
    assert.deepEqual((await messages.next('c1', 0)).messages.map((m) => m.id), [later.id]);
  } finally {
    messages.dispose();
    db.close();
  }
});

test('not-read keeps the CLI reason; a report for another chat or a message not taken counts for nothing', async () => {
  const { db, messages, deliveries } = store();
  try {
    const sent = messages.write('c1', 'a1', words('hello'));
    // Not taken yet: a forged report changes nothing
    assert.equal(messages.report('c1', sent.id, { isDelivered: true }), false);
    await messages.next('c1', 0);
    assert.equal(messages.report('c2', sent.id, { isDelivered: true }), false);
    const reason = 'Agent "a1" was not resumed: the host has ended its input.';
    assert.equal(messages.report('c1', sent.id, { isDelivered: false, reason }), true);
    const row = messages.get('c1', sent.id);
    assert.equal(row?.state, 'undelivered');
    assert.equal(row?.reasonCode, 'not-read');
    assert.equal(row?.reason, reason);
    const event = deliveries.at(-1)?.delivery;
    assert.equal(event?.reason, 'not-read');
    assert.equal(event?.message?.reason, reason);
    assert.deepEqual(event?.to, { agentId: 'a1' });
    // The lost one is still listed, for the page to offer back, until the person writes to it again
    assert.deepEqual(messages.list('c1', true).map((m) => [m.id, m.state]), [[sent.id, 'undelivered']]);
    messages.write('c1', 'a1', words('again'));
    assert.deepEqual(messages.list('c1', true).map((m) => m.text), ['again']);
  } finally {
    messages.dispose();
    db.close();
  }
});

test('bridge-unavailable: no poll for the window while a message waits; a poll held open keeps it', async () => {
  const { db, messages, deliveries } = store({ unavailableMs: 60 });
  try {
    const lost = messages.write('c1', 'a1', words('nobody polls'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const row = messages.get('c1', lost.id);
    assert.equal(row?.state, 'undelivered');
    assert.equal(row?.reasonCode, 'bridge-unavailable');
    assert.equal(row?.reason, BRIDGE_UNAVAILABLE);
    assert.equal(deliveries.at(-1)?.delivery.reason, 'bridge-unavailable');
    // The page offers "Send through the lead" for this one only, so the listing carries the code
    assert.equal(messages.list('c1', true)[0]?.reasonCode, 'bridge-unavailable');
  } finally {
    messages.dispose();
    db.close();
  }
});

test('agent-stopped: a message to a subagent stopped meanwhile is settled instead of handed out', async () => {
  const stopped = new Set<string>();
  const { db, messages, deliveries } = store({ stopped });
  try {
    const sent = messages.write('c1', 'a1', words('hi'));
    stopped.add('a1');
    assert.deepEqual((await messages.next('c1', 0)).messages, []);
    assert.equal(messages.get('c1', sent.id)?.reasonCode, 'agent-stopped');
    assert.equal(deliveries.at(-1)?.delivery.reason, 'agent-stopped');
  } finally {
    messages.dispose();
    db.close();
  }
});

test('cancelled: withdrawn before the bridge took it; 409 taken after; 404 for another agent; a lost one is dismissed', async () => {
  const { db, messages, deliveries } = store();
  try {
    const first = messages.write('c1', 'a1', words('take it back'));
    assert.deepEqual(messages.withdraw('c1', 'a1', first.id), { id: first.id, state: 'undelivered' });
    assert.equal(deliveries.at(-1)?.delivery.reason, 'cancelled');
    assert.deepEqual(messages.list('c1', true), []);
    const second = messages.write('c1', 'a1', words('keep'));
    assert.throws(() => messages.withdraw('c1', 'a2', second.id), (err: unknown) => err instanceof AgentMessageRefusal && err.statusCode === 404);
    await messages.next('c1', 0);
    assert.throws(() => messages.withdraw('c1', 'a1', second.id), (err: unknown) => err instanceof AgentMessageRefusal && err.statusCode === 409 && err.reason === 'taken');
    messages.report('c1', second.id, { isDelivered: false, reason: 'no' });
    messages.withdraw('c1', 'a1', second.id);
    assert.deepEqual(messages.list('c1', true), []);
  } finally {
    messages.dispose();
    db.close();
  }
});

test("the chat's process ending loses what waits, and the rows survive a new store on the same data dir", async () => {
  const config = tempConfig();
  const db = new Db(config);
  const host = { delivery: () => undefined, agentStopped: () => false };
  const first = new AgentMessages(db.connection, host);
  const sent = first.write('c1', 'a1', words('across a restart'));
  first.dispose();
  const second = new AgentMessages(db.connection, host);
  try {
    assert.deepEqual(second.list('c1', true).map((m) => m.id), [sent.id]);
    // Listed for a chat whose process is gone: nobody is left to carry it
    const listed = second.list('c1', false, 'the process ended');
    assert.deepEqual(listed.map((m) => [m.state, m.reason]), [['undelivered', 'the process ended']]);
  } finally {
    second.dispose();
    db.close();
  }
});

test('the mod is written under the data dir, rewritten when it differs, and loaded with --plugin-dir', () => {
  const { dataDir } = tempConfig();
  const dir = writeBridgeMod(dataDir);
  assert.equal(dir, bridgeModDir(dataDir));
  assert.equal(dir, join(dataDir, 'claude-plugins', BRIDGE_MOD_NAME));
  for (const [path, body] of Object.entries(BRIDGE_MOD_FILES)) assert.equal(readFileSync(join(dir, path), 'utf8'), body);
  assert.equal(JSON.parse(readFileSync(join(dir, '.claude-plugin/plugin.json'), 'utf8')).name, 'claudio-bridge');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'hooks/hooks.json'), 'utf8')), { modules: ['./register.js'] });
  writeFileSync(join(dir, 'hooks/register.js'), 'edited');
  writeBridgeMod(dataDir);
  assert.equal(readFileSync(join(dir, 'hooks/register.js'), 'utf8'), BRIDGE_MOD_FILES['hooks/register.js']);
  // The module never names the token's value or logs; it only uses the mods API
  const source = BRIDGE_MOD_FILES['hooks/register.js'] ?? '';
  assert.match(source, /\$\.env\.get\('CLAUDIO_API_TOKEN'\)/);
  assert.match(source, /\$\.session\.send\(\{ to: \{ agentId/);
  assert.doesNotMatch(source, /console\.|\$\.ui\.|setTimeout|require\(|import /);
  // Never a held poll: the CLI waits for a fetch in flight before it exits, and a re-run found the old process still up
  assert.match(source, /const WAIT_S = 0\n/);
  assert.match(source, /again\(IDLE_MS\)/);
  const spec = { id: 's', nativeId: null, created: false, forkFrom: null, name: 'n', cwd: '/w', permissionMode: 'default', permissionPrompts: 'none', policy: null, pluginDirs: [dir] } as unknown as SessionLaunch;
  const args = buildArgs(spec);
  assert.equal(args[args.indexOf('--plugin-dir') + 1], dir);
  assert.ok(!buildArgs({ ...spec, pluginDirs: undefined }).includes('--plugin-dir'));
  assert.ok(existsSync(dir));
});

// ChatService.messageAgent over a stub of the runtime with the real store

function service(opts: { live?: boolean; bridged?: boolean; pid?: number | null; subagent?: { agentId: string | null; status: 'running' | 'completed' | 'stopped'; description?: string } | null; files?: Array<{ id: string; status: string; description?: string }> } = {}) {
  const { db, messages } = store();
  const record = { id: 'c1', name: 'chat', prompt: 'hi', executions: [], pid: opts.pid === undefined ? 1 : opts.pid, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  /** What the lead was sent: the text it reads, and what the message records */
  const sent: Array<{ text: string; from: unknown }> = [];
  const deps = {
    config: tempConfig(),
    runtime: {
      get: (id: string) => (id === 'c1' ? record : null),
      live: () => opts.live ?? true,
      bridged: () => (opts.live ?? true) && (opts.bridged ?? true),
      subagentOf: () => (opts.subagent === undefined ? { agentId: 'a1', status: 'running', description: 'Audit the bundle' } : opts.subagent),
      agentMessages: messages,
      sendMessage: (_id: string, text: string, _attachments: string[], _messageId: undefined, _purpose: undefined, from: unknown) => {
        sent.push({ text, from });
        return { id: `m${sent.length}`, taken: 'written' };
      },
    },
  } as unknown as ChatServiceDeps;
  const chats = new ChatService(deps);
  (chats as unknown as { subagents: () => Promise<Array<{ id: string; status: string }>> }).subagents = async () => opts.files ?? [];
  return { chats, messages, sent, close: () => (messages.dispose(), db.close()) };
}

test('messageAgent frames the words for the subagent by who wrote them, and keeps them apart', async () => {
  const { chats, messages, close } = service();
  try {
    const receipt = await chats.messageAgent('c1', 'a1', '  look at the totals  ');
    assert.equal(receipt.state, 'written');
    const row = messages.get('c1', receipt.id);
    assert.equal(row?.words, 'look at the totals');
    assert.equal(row?.text, `${AGENT_MESSAGE_PERSON_PREFIX}\n\nlook at the totals`);
    const supervisor = await chats.messageAgent('c1', 'a1', 'you look stuck', { source: 'supervisor' });
    assert.equal(messages.get('c1', supervisor.id)?.text, `${AGENT_MESSAGE_SUPERVISOR_PREFIX}\n\nyou look stuck`, 'the Supervisor signs its own');
    assert.equal(messages.get('c1', supervisor.id)?.source, 'supervisor');
    const auto = await chats.messageAgent('c1', 'a1', 'the chat is about to end', { source: 'claudio' });
    assert.equal(messages.get('c1', auto.id)?.text, `${AGENT_MESSAGE_AUTO_PREFIX}\n\nthe chat is about to end`);
  } finally {
    close();
  }
});

test('messageAgent refuses: no live process (409), unknown subagent (404), stopped (409 agent-stopped), empty text; a finished one is accepted', async () => {
  const status = async (p: Promise<unknown>) => p.then(() => '200', (err: { statusCode?: number; reason?: string }) => `${err.statusCode ?? 400}${err.reason ? ` ${err.reason}` : ''}`);
  let s = service({ live: false });
  assert.equal(await status(s.chats.messageAgent('c1', 'a1', 'x')), '409');
  s.close();
  s = service({ bridged: false });
  assert.equal(await status(s.chats.messageAgent('c1', 'a1', 'x')), '409', 'a run without the bridge mod refuses up front');
  s.close();
  s = service({ subagent: null });
  assert.equal(await status(s.chats.messageAgent('c1', 'nope', 'x')), '404');
  s.close();
  s = service({ subagent: { agentId: 'a1', status: 'stopped' } });
  assert.equal(await status(s.chats.messageAgent('c1', 'a1', 'x')), '409 agent-stopped');
  s.close();
  s = service({ subagent: { agentId: null, status: 'running' } });
  assert.equal(await status(s.chats.messageAgent('c1', 'tool-use-1', 'x')), '404', 'a subagent without an agent id yet cannot be addressed');
  s.close();
  s = service();
  assert.equal(await status(s.chats.messageAgent('c1', 'a1', '   ')), '400');
  assert.equal(await status(s.chats.messageAgent('gone', 'a1', 'x')), '404');
  s.close();
  s = service({ subagent: { agentId: 'a1', status: 'completed' } });
  assert.equal(await status(s.chats.messageAgent('c1', 'a1', 'carry on')), '200');
  s.close();
  // Known only from the transcript's files: addressed by the id they give
  s = service({ subagent: null, files: [{ id: 'a9', status: 'completed' }] });
  const receipt = await s.chats.messageAgent('c1', 'a9', 'carry on');
  assert.equal(s.messages.get('c1', receipt.id)?.agentId, 'a9');
  s.close();
});

test("a relay through the lead hands the lead the person's words framed for the subagent, recorded with the bare words", async () => {
  const { chats, sent, messages, close } = service({ bridged: false });
  try {
    const receipt = await chats.relayToAgent('c1', 'a1', '  try the other port  ');
    assert.deepEqual(receipt, { id: 'm1', state: 'written' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.text, relayToSubagent('person', { name: 'Audit the bundle', agentId: 'a1' }, 'try the other port'));
    assert.deepEqual(sent[0]?.from, { source: 'person', words: 'try the other port' });
    assert.equal(readSystemMessage(sent[0]?.text ?? '')?.kind, 'relay-person');
    assert.equal(messages.history('c1').length, 0, "nothing waits in the bridge's queue");
  } finally {
    close();
  }
});

test("the Supervisor's relay is its own, and a subagent known only from its files is named by its description", async () => {
  const { chats, sent, close } = service({ subagent: null, files: [{ id: 'a9', status: 'completed', description: 'Read the logs' }] });
  try {
    await chats.relay('c1', { name: 'Read the logs', agentId: 'a9' }, 'stop retrying', { source: 'supervisor' });
    assert.equal(readSystemMessage(sent[0]?.text ?? '')?.kind, 'relay-supervisor');
    await chats.relayToAgent('c1', 'a9', 'carry on');
    assert.deepEqual(readSystemMessage(sent[1]?.text ?? '')?.agent, { name: 'Read the logs', agentId: 'a9' });
  } finally {
    close();
  }
});

test('a relay is refused without a live process, for an unknown or stopped subagent, and for empty words', async () => {
  const status = async (p: Promise<unknown>) => p.then(() => '200', (err: { statusCode?: number; reason?: string }) => `${err.statusCode ?? 400}${err.reason ? ` ${err.reason}` : ''}`);
  let s = service({ pid: null });
  assert.equal(await status(s.chats.relayToAgent('c1', 'a1', 'x')), '409');
  s.close();
  s = service({ subagent: null });
  assert.equal(await status(s.chats.relayToAgent('c1', 'nope', 'x')), '404');
  s.close();
  s = service({ subagent: { agentId: 'a1', status: 'stopped' } });
  assert.equal(await status(s.chats.relayToAgent('c1', 'a1', 'x')), '409 agent-stopped');
  s.close();
  s = service();
  assert.equal(await status(s.chats.relayToAgent('c1', 'a1', '  ')), '400');
  assert.equal(s.sent.length, 0);
  s.close();
});

test('a run handed a chat token loads the mod; a confined one and one with api: false do not', async () => {
  const fake = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
  const config = { ...tempConfig(), claudeBin: fake };
  const spawns = join(config.dataDir, 'bridge.spawns');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  const db = new Db(config);
  const chats = new ChatManager(config, db);
  chats.apiUrl = 'http://127.0.0.1:9/api';
  const argvs: string[][] = [];
  try {
    for (const extra of [{}, { confine: { tools: ['Read'], settingSources: [] } }, { api: false as const }]) {
      writeFileSync(spawns, '');
      const chat = chats.start({ prompt: 'hello', name: 'bridge', keepAlive: false, ...extra });
      await chats.exited(chat.id);
      argvs.push(readFileSync(spawns, 'utf8').split('\n').filter(Boolean)[0]?.split(' ') ?? []);
    }
  } finally {
    chats.stopAll();
    db.close();
  }
  const [plain, confined, noApi] = argvs;
  assert.equal(plain?.[(plain?.indexOf('--plugin-dir') ?? -2) + 1], bridgeModDir(config.dataDir));
  assert.ok(existsSync(join(bridgeModDir(config.dataDir), 'hooks/register.js')));
  assert.ok(!confined?.includes('--plugin-dir'));
  assert.ok(!noApi?.includes('--plugin-dir'));
});
