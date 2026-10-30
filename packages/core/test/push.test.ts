import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import webpush from 'web-push';
import type { ClaudioEvent, PushPayload, TunnelState } from '@claudio/shared';
import { Db } from '../src/db.ts';
import { DecisionEngine } from '../src/decisions/engine.ts';
import { decisionPoint } from '../src/decisions/points.ts';
import { DecisionCredentialStore, DecisionSettingsStore, DEFAULT_DECISION_SETTINGS } from '../src/decisions/settings.ts';
import { EventBus, type ClaudioEventInput } from '../src/events.ts';
import type { ToolCall } from '../src/health.ts';
import { PushService, absoluteOn, idOfEndpoint, riskLine, truncateEndpoint, type PushTransport } from '../src/push.ts';
import { readinessFromStatus } from '../src/tunnel.ts';
import { tempConfig } from './helpers.ts';

const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABsubscription-one';
const OTHER = 'https://fcm.googleapis.com/fcm/send/cDEFghijkl:APA91bHsubscription-two';

const keys = { p256dh: 'BExampleP256dhKeyForTests', auth: 'exampleAuthSecret' };

interface Sent {
  endpoint: string;
  payload: PushPayload;
  /** The VAPID `sub` this push was signed with: the claim a push service accepts or refuses */
  subject: string;
}

/** A push service that records what it was handed, and fails the endpoints the test names. */
function fakeTransport(fail: Map<string, Error> = new Map()): { transport: PushTransport; sent: Sent[] } {
  const sent: Sent[] = [];
  const transport: PushTransport = async (subscription, payload, options) => {
    const error = fail.get(subscription.endpoint);
    if (error) throw error;
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as PushPayload, subject: options.vapidDetails.subject });
    return undefined;
  };
  return { transport, sent };
}

function harness(transport?: PushTransport) {
  const config = tempConfig();
  const db = new Db(config);
  const events = new EventBus();
  const push = new PushService({ config, db, events, ...(transport ? { transport } : {}) });
  const logged: string[] = [];
  push.log = (line) => logged.push(line);
  return { config, db, events, push, logged };
}

const waitingEvent: ClaudioEventInput = {
  type: 'run.waiting',
  title: 'chat-1 needs your approval to use Bash',
  runId: 'chat-1',
  runName: 'chat-1',
  sessionId: 'chat-1',
  orchestrationId: null,
  internal: false,
  reason: 'permission',
  permissionId: 'req-1',
  toolName: 'Bash',
};

const endedEvent: ClaudioEventInput = {
  type: 'run.ended',
  title: 'chat-2 finished',
  runId: 'chat-2',
  runName: 'chat-2',
  sessionId: 'chat-2',
  orchestrationId: null,
  internal: false,
  status: 'completed',
  error: null,
  turns: 3,
  costUsd: 0.1,
};

/** The sender is deliberately not awaited by the bus, so a test has to let its microtasks run. */

test('the VAPID keypair is made on first use and only its public half is ever handed out', async () => {
  const { config, push } = harness();
  const first = await push.keyInfo();
  assert.equal(first.configured, true);
  assert.equal(typeof first.publicKey, 'string');
  assert.ok(first.publicKey && first.publicKey.length > 20);
  assert.deepEqual(Object.keys(first).sort(), ['configured', 'publicKey']);

  const file = join(config.dataDir, 'push.json');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the private key is a secret in a shared data dir');
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { publicKey: string; privateKey: string; subject: string };
  assert.equal(doc.publicKey, first.publicKey);
  assert.ok(doc.privateKey);
  assert.equal(doc.subject, 'https://github.com/yeyo11/claudio');

  // Every subscription is taken out against one public key: a second call must not replace it
  assert.deepEqual(await push.keyInfo(), first);
  const reopened = harness();
  assert.equal((await reopened.push.keyInfo()).publicKey !== first.publicKey, true, 'a different data dir gets its own keypair');
});

test('an endpoint is registered once, and the list never hands the whole of it back', () => {
  const { push } = harness();
  const registered = push.register({ endpoint: ENDPOINT, keys, label: 'Pixel 8 · Chrome' });
  assert.equal(registered.id, idOfEndpoint(ENDPOINT));
  assert.equal(registered.label, 'Pixel 8 · Chrome');
  assert.deepEqual(registered.kinds, ['waiting', 'run', 'orchestration', 'conflict', 'limit', 'activity', 'health', 'collaborators']);
  assert.equal(registered.endpoint.includes('gAAAAAB'), false, 'a full endpoint is a capability to notify that install');
  assert.equal(registered.endpoint, truncateEndpoint(ENDPOINT));

  const again = push.register({ endpoint: ENDPOINT, keys, kinds: ['waiting'], label: 'Pixel 8 · Chrome' });
  assert.deepEqual(push.list().length, 1, 'the same endpoint is one install, however often it re-subscribes');
  assert.equal(again.createdAt, registered.createdAt, 'a browser rotating its keys is the same device');
  assert.deepEqual(again.kinds, ['waiting']);
});

test('a registration that could never deliver is refused instead of stored', () => {
  const { push } = harness();
  assert.throws(() => push.register(null), /JSON object/);
  assert.throws(() => push.register({ keys }), /endpoint is required/);
  assert.throws(() => push.register({ endpoint: 'not a url', keys }), /absolute URL/);
  assert.throws(() => push.register({ endpoint: 'http://push.example/x', keys }), /https/);
  assert.throws(() => push.register({ endpoint: ENDPOINT }), /p256dh and auth/);
  assert.throws(() => push.register({ endpoint: ENDPOINT, keys: { p256dh: 'k' } }), /keys.auth is required/);
  assert.throws(() => push.register({ endpoint: ENDPOINT, keys, kinds: 'waiting' }), /kinds must be an array/);
  assert.throws(() => push.register({ endpoint: ENDPOINT, keys, kinds: ['nope'] }), /unknown notification kind/);
  assert.throws(() => push.register({ endpoint: ENDPOINT, keys, level: 'loud' }), /level must be one of/);
  assert.deepEqual(push.list(), []);
});

test('an install is woken only for what its level lets interrupt, and keeps the level it chose', async () => {
  const { transport, sent } = fakeTransport();
  const { push, events } = harness(transport);
  assert.equal(push.register({ endpoint: ENDPOINT, keys, label: 'phone' }).level, 'important', 'no level is the default one');
  push.register({ endpoint: OTHER, keys, level: 'silent', label: 'laptop' });

  // A chat that finished well is news for the bell, not for a phone at the default level
  events.emit(endedEvent);
  await push.idle();
  assert.equal(sent.length, 0);

  events.emit({ ...endedEvent, runId: 'chat-3', runName: 'chat-3', sessionId: 'chat-3', status: 'failed', error: 'boom' });
  events.emit(waitingEvent);
  await push.idle();
  assert.deepEqual(
    sent.map((s) => [s.endpoint, s.payload.kind]),
    [
      [ENDPOINT, 'run'],
      [ENDPOINT, 'waiting'],
    ],
    'a failure and a chat waiting reach the phone; the silent laptop gets nothing',
  );
  assert.equal(push.list().find((s) => s.label === 'laptop')?.level, 'silent');
});

test('an event reaches only the installs that asked for its kind, with the key it is collapsed by', async () => {
  const { transport, sent } = fakeTransport();
  const { push, events } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, kinds: ['waiting'], label: 'phone' });
  push.register({ endpoint: OTHER, keys, kinds: ['run'], level: 'all', label: 'laptop' });

  events.emit(waitingEvent);
  await push.idle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.endpoint, ENDPOINT, 'only the install that asked for `waiting`');
  const payload = sent[0]?.payload;
  assert.equal(payload?.kind, 'waiting');
  assert.equal(payload?.key, 'wait:chat-1:req-1', 'the dedupe key the browser already uses, so a chat replaces its own notification');
  assert.equal(payload?.href, '/chats/chat-1?prompt=req-1');
  assert.equal(payload?.priority, 'high');
  assert.equal('permissionId' in (payload ?? {}), false, 'a payload travels through a relay: only what a lock screen shows');

  events.emit(endedEvent);
  await push.idle();
  assert.deepEqual(
    sent.map((s) => s.endpoint),
    [ENDPOINT, OTHER],
  );
});

test("a join request wakes the owner's phone at the default level, and not an install that left its kind out", async () => {
  const { transport, sent } = fakeTransport();
  const { push, events } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  push.register({ endpoint: OTHER, keys, kinds: ['waiting', 'run'], level: 'all', label: 'laptop' });
  const joinEvent: ClaudioEventInput = {
    type: 'collaborators.join-request',
    title: 'Cleo asks to join Platform',
    groupName: 'Platform',
    request: { groupId: 'a'.repeat(64), from: 'c'.repeat(64), name: 'Cleo', relayedBy: { endpointId: 'b'.repeat(64), name: 'Ben' }, receivedAt: '2026-10-16T10:00:00.000Z', expiresAt: '2026-10-23T10:00:00.000Z' },
  };

  // A second relay of the same request is not pushed again
  events.emit(joinEvent);
  events.emit(joinEvent);
  await push.idle();
  assert.deepEqual(
    sent.map((s) => [s.endpoint, s.payload.kind, s.payload.title, s.payload.href]),
    [[ENDPOINT, 'collaborators', 'Cleo asks to join Platform', '/collaborators']],
  );
  assert.equal(sent[0]?.payload.body, 'Relayed by Ben. Accept or deny it on the Collaborators page.');
});

test('the same news inside its dedupe window is pushed once', async () => {
  const { transport, sent } = fakeTransport();
  const { push, events } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, level: 'all', label: 'phone' });

  // `run.waiting` keys on the permission id and never repeats; `run.ended` keys on the turn count
  events.emit(waitingEvent);
  events.emit(waitingEvent);
  events.emit(endedEvent);
  events.emit(endedEvent);
  await push.idle();
  assert.deepEqual(
    sent.map((s) => s.payload.key),
    ['wait:chat-1:req-1', 'run-done:chat-2:3'],
  );
});

test('nothing is sent, and no key is spent, while no install is registered', async () => {
  const { transport, sent } = fakeTransport();
  const { push, events } = harness(transport);
  events.emit(waitingEvent);
  await push.idle();
  assert.equal(sent.length, 0);

  push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  events.emit(waitingEvent);
  await push.idle();
  assert.equal(sent.length, 1, 'the first event a subscriber could have heard is still news');
});

test('an endpoint the push service says is gone is deleted on the spot', async () => {
  const gone = new Map([[OTHER, new webpush.WebPushError('gone', 410, {}, '', OTHER)]]);
  const { transport, sent } = fakeTransport(gone);
  const { push, events, logged } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  push.register({ endpoint: OTHER, keys, label: 'old phone' });

  events.emit(waitingEvent);
  await push.idle();
  assert.deepEqual(
    push.list().map((s) => s.label),
    ['phone'],
    'anything else and the sender slowly becomes a pile of dead endpoints',
  );
  assert.equal(sent.length, 1);
  assert.match(logged.join('\n'), /is gone \(410\); removed/);
});

test('a failing endpoint is a log line, never an exception in the event path', async () => {
  const failing = new Map([[OTHER, new Error('socket hang up')]]);
  const { transport, sent } = fakeTransport(failing);
  const { push, events, logged } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  push.register({ endpoint: OTHER, keys, label: 'flaky' });

  const heard: ClaudioEvent[] = [];
  events.subscribe((event) => heard.push(event));
  assert.doesNotThrow(() => events.emit(waitingEvent));
  await push.idle();

  assert.equal(heard.length, 1, 'the feed carried on');
  assert.equal(sent.length, 1, 'the other install was still notified');
  assert.equal(push.list().length, 2, 'a transport failure is not proof the endpoint is gone');
  assert.match(logged.join('\n'), /failed: socket hang up/);
});

test('the configured subject replaces the one stored beside the keypair, keypair untouched', async () => {
  const { transport, sent } = fakeTransport();
  const { config, db, events, push } = harness(transport);
  const file = join(config.dataDir, 'push.json');
  const made = await push.keyInfo();

  // What an install made before the default named a real domain looks like on disk. Apple refuses
  // this claim outright (403 BadJwtToken), so it has to be replaceable without a new keypair.
  const stale = { ...(JSON.parse(readFileSync(file, 'utf8')) as object), subject: 'mailto:claudio@localhost' };
  writeFileSync(file, JSON.stringify(stale));

  const reopened = new PushService({ config, db, events, transport });
  reopened.register({ endpoint: ENDPOINT, keys, label: 'iPhone' });
  await reopened.test({ endpoint: ENDPOINT });

  assert.equal(sent.at(-1)?.subject, 'https://github.com/yeyo11/claudio', 'the claim in force, not the one the file was written with');
  await reopened.idle();
  const stored = JSON.parse(readFileSync(file, 'utf8')) as { publicKey: string; subject: string };
  assert.equal(stored.subject, 'https://github.com/yeyo11/claudio', 'and the file is caught up for the next boot');
  assert.equal(stored.publicKey, made.publicKey, 'every registered install was taken out against this key: it cannot change');
  reopened.close();
});

test('a push a service refuses comes back with what it said, and keeps the row', async () => {
  const refused = new Map([[ENDPOINT, new webpush.WebPushError('Received unexpected response code', 403, {}, '{"reason":"BadJwtToken"}', ENDPOINT)]]);
  const { transport } = fakeTransport(refused);
  const { push, logged } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, label: 'iPhone' });

  assert.deepEqual(await push.test({ endpoint: ENDPOINT }), { sent: 0, removed: 0, failed: 1, reason: '403 {"reason":"BadJwtToken"}' });
  assert.equal(push.list().length, 1, 'a claim the service refused is this server\'s to fix, not a phone that has gone');
  assert.match(logged.join('\n'), /failed: 403 \{"reason":"BadJwtToken"\}/, 'the status and body, or nobody can tell this from a dead network');
});

test('the test notification names its target, counts what happened and prunes what is gone', async () => {
  const gone = new Map([[OTHER, new webpush.WebPushError('gone', 404, {}, '', OTHER)]]);
  const { transport, sent } = fakeTransport(gone);
  const { push } = harness(transport);
  await assert.rejects(push.test({}), /no push subscription is registered/);

  push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  push.register({ endpoint: OTHER, keys, label: 'old phone' });

  assert.deepEqual(await push.test({ endpoint: ENDPOINT }), { sent: 1, removed: 0, failed: 0 });
  assert.equal(sent.at(-1)?.payload.title, 'Claudio push works');

  assert.deepEqual(await push.test(undefined), { sent: 1, removed: 1, failed: 0 });
  assert.deepEqual(
    push.list().map((s) => s.label),
    ['phone'],
  );
});

test('unsubscribing by endpoint or by id removes the row, and says so only when there was one', () => {
  const { push } = harness();
  const registered = push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  push.register({ endpoint: OTHER, keys, label: 'laptop' });

  assert.deepEqual(push.remove({ endpoint: ENDPOINT }), { removed: true });
  assert.deepEqual(push.remove({ endpoint: ENDPOINT }), { removed: false }, 'a second unsubscribe is not an error');
  assert.deepEqual(push.remove({ id: idOfEndpoint(OTHER) }), { removed: true });
  assert.equal(registered.id, idOfEndpoint(ENDPOINT));
  assert.deepEqual(push.list(), []);
  assert.throws(() => push.remove({}), /endpoint or the id/);
});

test('a closed service stops hearing the bus', async () => {
  const { transport, sent } = fakeTransport();
  const { push, events } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  push.close();
  events.emit(waitingEvent);
  await push.idle();
  assert.equal(sent.length, 0);
});

// ---------- The tunnel's current address ----------

const TUNNEL = 'https://claudio-test.tail0000.ts.net:8443';

function tunnelEvent(state: TunnelState, url: string | null): ClaudioEventInput {
  return {
    type: 'tunnel.changed',
    title: `Tunnel ${state}`,
    tunnel: { state, url, since: url ? new Date().toISOString() : null, reason: null, checking: false, enabled: true, managed: false, tailscale: { state: 'ready', version: '1.102.4', host: 'claudio-test.tail0000.ts.net', reason: null }, port: 8443, portSource: 'default', portTaken: null, settings: { startWithClaudio: false, port: 8443 } },
  };
}

test('while a tunnel is active every push carries its path on the current address', async () => {
  const { transport, sent } = fakeTransport();
  const { push, events } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, level: 'all', label: 'phone' });

  events.emit(waitingEvent);
  await push.idle();
  assert.equal(sent.at(-1)?.payload.url, null, 'no tunnel, no address: the install opens its own origin');

  events.emit(tunnelEvent('active', TUNNEL));
  events.emit(endedEvent);
  await push.idle();
  assert.equal(sent.at(-1)?.payload.href, '/chats/chat-2');
  assert.equal(sent.at(-1)?.payload.url, `${TUNNEL}/chats/chat-2`);

  // The address moved (a renamed node): the next push names the new one, which is the whole point
  const moved = 'https://renamed.tail0000.ts.net:8443';
  events.emit(tunnelEvent('starting', null));
  events.emit(tunnelEvent('verifying', null));
  events.emit(tunnelEvent('active', moved));
  assert.deepEqual(await push.test({ endpoint: ENDPOINT }), { sent: 1, removed: 0, failed: 0 });
  assert.equal(sent.at(-1)?.payload.url, `${moved}/`, 'the test notification too, and with no path it opens the app');
});

test('a reconnecting or stopped tunnel takes its address out of the payload', async () => {
  const { transport, sent } = fakeTransport();
  const { push, events } = harness(transport);
  push.register({ endpoint: ENDPOINT, keys, label: 'phone' });
  for (const state of ['starting', 'stopping', 'stopped', 'failed'] as const) {
    events.emit(tunnelEvent('active', TUNNEL));
    events.emit(tunnelEvent(state, null));
    await push.test({ endpoint: ENDPOINT });
    // The address being replaced is the one that stopped answering: better the old origin than a guess
    assert.equal(sent.at(-1)?.payload.url, null, state);
  }
});

test('only a path of ours on an https address becomes an absolute URL', () => {
  assert.equal(absoluteOn(TUNNEL, '/chats/a?prompt=b'), `${TUNNEL}/chats/a?prompt=b`);
  assert.equal(absoluteOn(`${TUNNEL}/`, null), `${TUNNEL}/`);
  assert.equal(absoluteOn(null, '/chats/a'), null);
  assert.equal(absoluteOn('http://claudio-test.tail0000.ts.net:8443', '/chats/a'), null);
  assert.equal(absoluteOn(TUNNEL, '//evil.example/x'), null);
  assert.equal(absoluteOn(TUNNEL, 'https://evil.example/x'), null);
  assert.equal(absoluteOn('not a url', '/x'), null);
});

test('the worker follows only the kind of address the tunnel hands out', () => {
  // sw.js is a plain file with no imports: the suffix it trusts is read from its source
  const worker = readFileSync(join(import.meta.dirname, '../../../apps/web/public/sw.js'), 'utf8');
  const suffix = /const TUNNEL_SUFFIX = '([^']+)';/.exec(worker)?.[1];
  assert.ok(suffix, 'sw.js names the suffix it follows');
  const { host } = readinessFromStatus(
    { BackendState: 'Running', Self: { DNSName: 'claudio-test.tail0000.ts.net.' }, CurrentTailnet: { MagicDNSEnabled: true }, CertDomains: ['claudio-test.tail0000.ts.net'] },
    '1.102.4',
  );
  assert.ok(host?.endsWith(suffix), `${String(host)} ends with ${suffix}`);
});

const callAt = (id: string, name: string, input: Record<string, unknown>, at: string): ToolCall => ({ id, name, input, at, endedAt: null, isError: false, result: '' });
const NOW = Date.parse('2026-01-01T12:00:00Z');
const CTX = { cwd: '/work/app', roots: [] as string[] };

test('riskLine names the riskiest call of the last ten minutes, and nothing when every call is low', () => {
  const calls = [
    callAt('a', 'Bash', { command: 'ls' }, '2026-01-01T11:59:00Z'),
    callAt('b', 'Edit', { file_path: '/work/app/.github/workflows/ci.yml' }, '2026-01-01T11:58:00Z'),
    callAt('c', 'Bash', { command: 'git push --force origin main' }, '2026-01-01T11:57:00Z'),
  ];
  assert.match(riskLine(calls, CTX, NOW) ?? '', /^high: .*history-rewrite.* \(git push --force origin main\)$/);
  // Older than ten minutes says nothing about why the chat asks now
  assert.equal(riskLine([callAt('c', 'Bash', { command: 'rm -rf /home/x' }, '2026-01-01T11:40:00Z')], CTX, NOW), null);
  assert.equal(riskLine([calls[0] as ToolCall], CTX, NOW), null);
});

/** An engine that only records what it is asked, and never raises anything */
function askingEngine(): { engine: Pick<DecisionEngine, 'ask' | 'effective'>; asked: Array<Record<string, unknown>> } {
  const asked: Array<Record<string, unknown>> = [];
  const engine = {
    effective: () => ({ mode: 'shadow', provider: 'jev', limited: false }),
    ask: (_point: string, subject: { data: Record<string, unknown> }) => {
      asked.push(subject.data);
      return Promise.resolve({ act: false, answers: null });
    },
  } as unknown as Pick<DecisionEngine, 'ask' | 'effective'>;
  return { engine, asked };
}

const idleEvent = {
  type: 'run.updated',
  title: 'chat-1 is idle',
  runId: 'chat-1',
  runName: 'chat-1',
  sessionId: 'chat-1',
  orchestrationId: null,
  internal: false,
  previousStatus: 'busy',
  status: 'idle',
  turns: 1,
} as unknown as ClaudioEventInput;

async function urgencyState(recent: ((runId: string) => string | null) | null): Promise<Array<Record<string, unknown>>> {
  const { push, events } = harness(fakeTransport().transport);
  const { engine, asked } = askingEngine();
  push.decisions = engine;
  push.recentRisk = recent;
  push.register({ endpoint: ENDPOINT, keys, kinds: ['run'], level: 'all' });
  events.emit(idleEvent);
  await push.idle();
  return asked;
}

test('the urgency state carries risk only when the run made a risky call, masked and at most 300 characters', async () => {
  const none = await urgencyState(() => null);
  assert.equal(none.length, 1);
  assert.equal('risk' in (none[0] ?? {}), false);
  assert.equal('risk' in ((await urgencyState(null))[0] ?? {}), false);

  const risky = await urgencyState(() => 'high: irreversible (rm -rf /srv/x)');
  assert.equal(risky[0]?.risk, 'high: irreversible (rm -rf /srv/x)');

  const long = `high: leaves-machine (curl -H "Authorization: Bearer abcdefghijklmnop1234" ${'x'.repeat(600)})`;
  const clipped = String((await urgencyState(() => long))[0]?.risk);
  assert.ok(clipped.length <= 300);
  assert.equal(clipped.includes('abcdefghijklmnop1234'), false);

  // A failing reader is a question without the field, not a lost notification
  const broken = await urgencyState(() => {
    throw new Error('boom');
  });
  assert.equal(broken.length, 1);
  assert.equal('risk' in (broken[0] ?? {}), false);
});

test('notification.urgency is at state version 2 and lists risk, so a consent for version 1 no longer counts', async () => {
  const urgency = decisionPoint('notification.urgency');
  assert.equal(urgency?.stateVersion, 2);
  assert.ok(urgency?.fields.includes('risk'));

  const asks = async (version: number): Promise<number> => {
    const config = tempConfig();
    const settings = new DecisionSettingsStore(config, new DecisionCredentialStore(config));
    const engine = new DecisionEngine({ settings, db: new Db(config), projectDecisions: () => null });
    let calls = 0;
    engine.register({
      id: 'jev',
      available: () => true,
      ask: () => {
        calls++;
        return Promise.resolve({ status: 'unavailable', reason: 'no-quota', latencyMs: 1 });
      },
    });
    await settings.set({ ...structuredClone(DEFAULT_DECISION_SETTINGS), provider: 'jev', points: { 'notification.urgency': { mode: 'shadow', threshold: 0.85, consent: null } } });
    await settings.setConsent('notification.urgency', { granted: true, stateVersion: version, providers: ['jev'] });
    await engine.ask('notification.urgency', { kind: 'notification', id: 'k', data: { kind: 'run', title: 't', body: 'b' } }, { projectId: null });
    return calls;
  };
  assert.equal(await asks(1), 0, 'the earlier consent is not enough for the new preview');
  assert.equal(await asks(2), 1);
});
