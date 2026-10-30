import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import type { ProjectSettings } from '@claudio/shared';
import type { HostReplyPart, CollabHostOptions } from '../src/collab/host-client.ts';
import { decodeInvite, encodeInvite } from '../src/collab/invite.ts';
import type { ReaderSources } from '../src/collab/readers.ts';
import { endpointIdFromSeed } from '../src/collab/roster.ts';
import type { ReplySink } from '../src/collab/serve.ts';
import { CollaboratorsService, type HostHandle } from '../src/collab/service.ts';
import type { WireReply } from '../src/collab/wire.ts';
import { CollabStore, Db } from '../src/db.ts';
import type { ClaudioEventInput } from '../src/events.ts';
import { tempConfig } from './helpers.ts';
import { setTimeout as sleep } from 'node:timers/promises';

/*
 * How a join that will not be signed ends (docs/collaborators.md, joins): the owner denies it, and the
 * joiner learns it from the owner or, while the owner is away, from the member the owner told; or the
 * invite expires first. Every install is a `CollaboratorsService` of its own over an in-process
 * network that hands each frame, as JSON, to the serving side of the install it is addressed to, so
 * who is online is the test's to decide. A peer can be made to answer as a release from before
 * denied joins did, to show the two still work together.
 */

// ---------- The network ----------

type Rewrite = (from: string, frame: Record<string, unknown>) => { frame: Record<string, unknown> } | { reply: WireReply };

interface Bound {
  options: CollabHostOptions;
  incoming: Set<AbortController>;
}

class Net {
  readonly bound = new Map<string, Bound>();
  /** Frames sent, as `from>to:type`, for the test to count */
  readonly sent: string[] = [];
  /** How a peer from another release reads what it is sent */
  readonly rewrites = new Map<string, Rewrite>();
  /** How long a frame to a peer takes to arrive: a dial to an owner whose network is slow */
  readonly delays = new Map<string, number>();
  /** Tells an install's service that its endpoint's connection changed, as the host's poll does */
  readonly connections = new Map<string, (connection: 'online' | 'no-relay') => void>();

  host(options: CollabHostOptions): HostHandle {
    let id: string | null = null;
    let status: HostHandle['status'] = null;
    const unbind = (): void => {
      if (!id) return;
      const was = this.bound.get(id);
      this.bound.delete(id);
      for (const controller of was?.incoming ?? []) controller.abort();
      for (const [other, peer] of this.bound) {
        peer.options.listener?.peer?.({ type: 'peer', endpointId: id, connected: false, path: null, rttMs: null });
        options.listener?.peer?.({ type: 'peer', endpointId: other, connected: false, path: null, rttMs: null });
      }
      status = null;
    };
    return {
      start: (start) => {
        id = endpointIdFromSeed(Uint8Array.from(start.secretKey));
        this.bound.set(id, { options, incoming: new Set() });
        const me = id;
        setImmediate(() => {
          if (this.bound.get(me)?.options !== options) return;
          status = { type: 'status', endpointId: me, connection: 'online', homeRelay: null, ticket: `T${me}`, directAddresses: ['127.0.0.1:1'] };
          options.listener?.status?.(status);
        });
        this.connections.set(me, (connection) => {
          if (!status) return;
          status = { ...status, connection };
          options.listener?.status?.(status);
        });
      },
      stop: async () => unbind(),
      dispose: () => unbind(),
      request: (to, frame) => this.request(id, to.endpointId, frame),
      disconnect: () => undefined,
      unavailable: null,
      startError: null,
      get status() {
        return status;
      },
    };
  }

  private async *request(from: string | null, to: string, frame: unknown): AsyncGenerator<HostReplyPart> {
    await Promise.resolve();
    const delay = this.delays.get(to);
    if (delay) await sleep(delay);
    const target = this.bound.get(to);
    if (!from || !this.bound.has(from) || !target) throw new Error('no route to the peer');
    let sent = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>;
    this.sent.push(`${from}>${to}:${String(sent.type)}`);
    for (const [a, b] of [[from, to], [to, from]] as const) {
      this.bound.get(b)?.options.listener?.peer?.({ type: 'peer', endpointId: a, connected: true, path: 'direct', rttMs: 1 });
    }
    const rewrite = this.rewrites.get(to)?.(from, sent);
    if (rewrite && 'reply' in rewrite) {
      yield { frame: rewrite.reply };
      return;
    }
    if (rewrite) sent = rewrite.frame;

    // The serving side answers into a queue the request reads from, as frames arrive
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const controller = new AbortController();
    target.incoming.add(controller);
    const sink: ReplySink = {
      signal: controller.signal,
      frame: async (reply) => {
        queue.push(JSON.parse(JSON.stringify(reply)));
        wake?.();
      },
      bytes: async () => undefined,
    };
    const serving = target.options.serve(from, sent, sink).finally(() => {
      done = true;
      wake?.();
    });
    try {
      for (;;) {
        while (queue.length) yield { frame: queue.shift() };
        if (done) break;
        if (controller.signal.aborted) throw new Error('the connection closed');
        await new Promise<void>((resolve) => {
          wake = resolve;
          controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        wake = null;
      }
    } finally {
      controller.abort();
      target.incoming.delete(controller);
      await serving.catch(() => undefined);
    }
  }
}

/** How a release from before denied joins reads frames: `joinAnswers` is unknown, and `roster` has no `denial` */
const OLD_RELEASE: Rewrite = (_from, frame) => {
  if (frame.type === 'joinAnswers') return { reply: { type: 'error', code: 'bad-request' } };
  const { denial: _denial, ...rest } = frame;
  return { frame: rest };
};

// ---------- Installs ----------

interface Install {
  name: string;
  service: CollaboratorsService;
  store: CollabStore;
  events: ClaudioEventInput[];
  id: string;
}

const dbs: Db[] = [];
const services: CollaboratorsService[] = [];
after(async () => {
  for (const s of services) await s.dispose();
  for (const db of dbs) db.close();
});

const sources = { events: { subscribe: () => () => undefined } } as unknown as ReaderSources;

async function install(net: Net, name: string, extra: { joinWaitMs?: number } = {}): Promise<Install> {
  const config = tempConfig();
  const db = new Db(config);
  dbs.push(db);
  const store = new CollabStore(db.connection);
  const vault = new Map<string, Record<string, string>>();
  const events: ClaudioEventInput[] = [];
  const service = new CollaboratorsService({
    config,
    store,
    vault: { get: (tool) => ({ ...(vault.get(tool) ?? {}) }), set: async (tool, values) => void vault.set(tool, { ...(vault.get(tool) ?? {}), ...values }) },
    emit: (event) => void events.push(event),
    projects: () => [],
    projectSettings: {
      stored: () => ({}) as ProjectSettings,
      update: async () => ({ before: {} as ProjectSettings, after: {} as ProjectSettings }),
      shareKeyHolder: () => null,
    },
    sources,
    host: (options) => net.host(options),
    reconcileMs: 60_000,
    retryMs: 50,
    debounceMs: 10,
    pendingMs: 60,
    idleMs: 2000,
    ...extra,
    ...(process.env.COLLAB_JOIN_DEBUG ? { log: (message: string) => console.log(`[${name}] ${message}`) } : {}),
  });
  services.push(service);
  const entry: Install = { name, service, store, events, id: '' };
  await on(entry);
  entry.id = service.endpointId() as string;
  return entry;
}

async function until<T>(what: string, probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}


async function on(i: Install): Promise<void> {
  await i.service.update({ enabled: true, displayName: i.name });
  await until(`${i.name} bound`, () => i.service.status().connection === 'online');
}

async function off(i: Install): Promise<void> {
  await i.service.update({ enabled: false });
}

const pendingOf = (i: Install, groupId: string) => i.service.groupList().pendingJoins.find((p) => p.groupId === groupId);

/** Ana owns a group Ben is in, and Ana has seen Ben online, so her invites name him as a relay */
async function team(net: Net) {
  const ana = await install(net, 'Ana');
  const ben = await install(net, 'Ben');
  const group = await ana.service.createGroup('UDD');
  const joined = await ben.service.join(ana.service.createInvite(group.id).text);
  assert.equal(joined.state, 'joined');
  await until('Ana sees Ben online', () => ana.service.getGroup(group.id).members.find((m) => m.endpointId === ben.id)?.presence?.online);
  return { ana, ben, groupId: group.id };
}

/** A request left with Ben while Ana was away, which reaches Ana when she is back */
async function relayedRequest(ana: Install, ben: Install, joiner: Install, groupId: string): Promise<string> {
  const invite = ana.service.createInvite(groupId).text;
  await off(ana);
  const pending = await joiner.service.join(invite);
  assert.equal(pending.state === 'pending' ? pending.pending.relayedBy?.endpointId : null, ben.id, 'Ben holds the request');
  await on(ana);
  await until('the request reaches Ana', () => ana.service.joinRequests(groupId).some((r) => r.from === joiner.id));
  return invite;
}

// ---------- The tests ----------

test('a denial the owner makes while the joiner is away reaches the joiner through the member, with the owner gone again', async () => {
  const net = new Net();
  const { ana, ben, groupId } = await team(net);
  const cleo = await install(net, 'Cleo');
  await relayedRequest(ana, ben, cleo, groupId);
  // Cleo is away when Ana answers, and Ana is away when Cleo asks: only Ben can tell her
  await off(cleo);
  ana.service.denyJoin(groupId, cleo.id);
  const learnt = await until('Ben learns of the denial', () => ben.store.joinDenials(groupId, new Date().toISOString())[0]);
  assert.equal(learnt.endpointId, cleo.id);
  assert.equal(learnt.secretHash, null, "a member never holds the secret's hash");
  assert.equal(ben.store.joinRequest(groupId, cleo.id), null, 'Ben no longer holds the request');
  await off(ana);

  await on(cleo);
  const denied = await until('Cleo learns she was denied', () => (pendingOf(cleo, groupId)?.state === 'denied' ? pendingOf(cleo, groupId) : null));
  assert.equal(denied.owner.name, 'Ana');
  assert.equal(denied.groupName, 'UDD');
  assert.ok(denied.endedAt);
  const ended = cleo.events.find((e) => e.type === 'collaborators.join-ended');
  assert.ok(ended?.type === 'collaborators.join-ended');
  assert.equal(ended.title, 'Ana denied the request to join UDD');
  assert.equal(ended.pending.state, 'denied');

  // Nothing asks after an ended join, and it stays on the page until dismissed
  const before = net.sent.filter((s) => s.startsWith(`${cleo.id}>`)).length;
  await sleep(300);
  assert.equal(net.sent.filter((s) => s.startsWith(`${cleo.id}>`)).length, before, 'Cleo stops asking');
  assert.equal(pendingOf(cleo, groupId)?.state, 'denied');
  await cleo.service.cancelJoin(groupId);
  assert.equal(pendingOf(cleo, groupId), undefined);

  // A new invite is a new question: Cleo is not taken for denied with it
  await on(ana);
  const again = await cleo.service.join(ana.service.createInvite(groupId).text);
  assert.equal(again.state, 'joined');
});

test('a joiner asking the owner after the denial is told at once, and the same invite pasted again is refused as denied', async () => {
  const net = new Net();
  const { ana, ben, groupId } = await team(net);
  const dan = await install(net, 'Dan');
  const invite = await relayedRequest(ana, ben, dan, groupId);
  // Ben is gone: the answer can only come from Ana
  await off(ben);
  ana.service.denyJoin(groupId, dan.id);
  const answered = ana.events.filter((e) => e.type === 'collaborators.join-answered').at(-1);
  assert.ok(answered?.type === 'collaborators.join-answered' && answered.answer === 'denied' && answered.from === dan.id);
  assert.equal(ana.store.joinDenials(groupId, new Date().toISOString())[0]?.endpointId, dan.id);

  await until('Dan learns he was denied', () => pendingOf(dan, groupId)?.state === 'denied');
  await assert.rejects(dan.service.join(invite), /Ana denied the request to join UDD/);
  assert.ok(!ana.service.getGroup(groupId).members.some((m) => m.endpointId === dan.id));
});

test('an invite that expires before the owner answers ends the join as expired, and nothing asks after it', async () => {
  const net = new Net();
  const { ana, ben, groupId } = await team(net);
  const eve = await install(net, 'Eve');
  // The joiner keeps the invite's expiry as written: an earlier one ends its wait sooner
  const invite = decodeInvite(ana.service.createInvite(groupId).text);
  const soon = encodeInvite({ ...invite, expiresAt: new Date(Date.now() + 800).toISOString() });
  await off(ana);
  const pending = await eve.service.join(soon);
  assert.equal(pending.state === 'pending' ? pending.pending.relayedBy?.endpointId : null, ben.id);
  assert.equal(pendingOf(eve, groupId)?.state, 'waiting');

  const expired = await until('the join expires', () => (pendingOf(eve, groupId)?.state === 'expired' ? pendingOf(eve, groupId) : null));
  assert.ok(expired.endedAt);
  const ended = eve.events.find((e) => e.type === 'collaborators.join-ended');
  assert.ok(ended?.type === 'collaborators.join-ended');
  assert.equal(ended.title, 'The invite to UDD expired before Ana answered');
  const before = net.sent.filter((s) => s.startsWith(`${eve.id}>`)).length;
  await sleep(300);
  assert.equal(net.sent.filter((s) => s.startsWith(`${eve.id}>`)).length, before, 'Eve stops asking');
  await eve.service.cancelJoin(groupId);
  assert.equal(eve.service.groupList().pendingJoins.length, 0);
});

test('with an owner from before denied joins, a member syncs as before and the joiner keeps waiting rather than failing', async () => {
  const net = new Net();
  const { ana, ben, groupId } = await team(net);
  const cleo = await install(net, 'Cleo');
  await relayedRequest(ana, ben, cleo, groupId);
  net.rewrites.set(ana.id, OLD_RELEASE);
  ana.service.denyJoin(groupId, cleo.id);
  // Ben asks, is refused the frame it sent, and learns nothing; its sync goes on
  await until('Ben asks Ana for her denials', () => net.sent.some((s) => s === `${ben.id}>${ana.id}:joinAnswers`));
  await until('Ben reads her catalog after it', () => net.sent.lastIndexOf(`${ben.id}>${ana.id}:catalog`) > net.sent.indexOf(`${ben.id}>${ana.id}:joinAnswers`));
  assert.deepEqual(ben.store.joinDenials(groupId, new Date().toISOString()), []);
  // Cleo asks Ana and Ben over several rounds; neither answers in a way she knows, so she waits
  const asked = net.sent.filter((s) => s === `${cleo.id}>${ana.id}:roster`).length;
  await until('Cleo asks again', () => net.sent.filter((s) => s === `${cleo.id}>${ana.id}:roster`).length >= asked + 3);
  assert.equal(pendingOf(cleo, groupId)?.state, 'waiting');
});

test('an answer the joiner does not know, from a newer peer, reads as still waiting', async () => {
  const net = new Net();
  const { ana, ben, groupId } = await team(net);
  const cleo = await install(net, 'Cleo');
  await relayedRequest(ana, ben, cleo, groupId);
  const future: Rewrite = (_from, frame) => (frame.type === 'roster' && frame.denial ? { reply: { type: 'answered-in-2027', groupId } as unknown as WireReply } : { frame });
  net.rewrites.set(ana.id, future);
  net.rewrites.set(ben.id, future);
  const asked = net.sent.filter((s) => s === `${cleo.id}>${ana.id}:roster`).length;
  await until('Cleo asks again', () => net.sent.filter((s) => s === `${cleo.id}>${ana.id}:roster`).length >= asked + 3);
  assert.equal(pendingOf(cleo, groupId)?.state, 'waiting');
  assert.ok(!cleo.events.some((e) => e.type === 'collaborators.join-ended'));
});

test('a member the owner removed is not taken for a member when she asks again: her request waits with a member, and the denial reaches her', async () => {
  const net = new Net();
  const { ana, ben, groupId } = await team(net);
  const cleo = await install(net, 'Cleo');
  assert.equal((await cleo.service.join(ana.service.createInvite(groupId).text)).state, 'joined');
  await ana.service.removeMember(groupId, cleo.id);
  await until('Ben learns of the removal', () => !ben.service.getGroup(groupId).members.some((m) => m.endpointId === cleo.id));
  // Nobody sends a removed member the version that removes her: her chain still lists her
  assert.ok(cleo.service.getGroup(groupId).members.some((m) => m.endpointId === cleo.id));

  const invite = ana.service.createInvite(groupId).text;
  await off(ana);
  const asked = await cleo.service.join(invite);
  assert.equal(asked.state === 'pending' ? asked.pending.relayedBy?.endpointId : null, ben.id, 'Ben holds the request');
  assert.equal(pendingOf(cleo, groupId)?.state, 'waiting', 'the stale chain does not hide the waiting join');

  await on(ana);
  await until('the request reaches Ana', () => ana.service.joinRequests(groupId).some((r) => r.from === cleo.id));
  ana.service.denyJoin(groupId, cleo.id);
  await until('Cleo learns she was denied', () => pendingOf(cleo, groupId)?.state === 'denied');
  assert.ok(!ana.service.getGroup(groupId).members.some((m) => m.endpointId === cleo.id));
});

test('a member pasting an invite again is still a member: a member answers with the chain while the owner is away, and the held chain when nobody answers', async () => {
  const net = new Net();
  const { ana, ben, groupId } = await team(net);
  const dan = await install(net, 'Dan');
  assert.equal((await dan.service.join(ana.service.createInvite(groupId).text)).state, 'joined');
  // Ben answers with the chain only once Ana's announcement reached him; asked before it, he rightly holds a request
  await until('Ben holds the version that lists Dan', () => ben.service.getGroup(groupId).members.some((m) => m.endpointId === dan.id));
  const invite = ana.service.createInvite(groupId).text;
  await off(ana);
  const viaBen = await dan.service.join(invite);
  assert.equal(viaBen.state, 'joined');
  assert.equal(ben.store.joinRequest(groupId, dan.id), null, 'Ben holds no request for a member');
  assert.equal(dan.service.groupList().pendingJoins.length, 0, 'nothing waits');

  await off(ben);
  const alone = await dan.service.join(invite);
  assert.equal(alone.state, 'joined');
  assert.equal(dan.service.groupList().pendingJoins.length, 0, 'nothing waits');
});

// ---------- An owner that is slow or away (docs/reports/regression-audit-2026-10-29.md §5.3–5.5) ----------

test('a join the owner does not answer in time is answered pending at once, and completes on its own', async () => {
  const net = new Net();
  const ana = await install(net, 'Ana');
  const cleo = await install(net, 'Cleo', { joinWaitMs: 150 });
  const group = await ana.service.createGroup('UDD');
  const invite = ana.service.createInvite(group.id).text;
  // Every frame to Ana takes longer than the join waits: a dial to an owner on a bad network
  net.delays.set(ana.id, 800);
  const began = Date.now();
  const answer = await cleo.service.join(invite);
  assert.equal(answer.state, 'pending', 'the route answers 202 with the pending join');
  assert.ok(Date.now() - began < 700, `answered after ${String(Date.now() - began)} ms`);
  assert.equal(pendingOf(cleo, group.id)?.state, 'waiting', 'the page shows the join waiting');
  // The attempt goes on after the answer, and only once: no pass sends the join beside it
  const joined = await until('Cleo joined in the background', () => cleo.service.groupList().groups.find((g) => g.id === group.id));
  assert.equal(joined.name, 'UDD');
  await until('the pending join cleared', () => !pendingOf(cleo, group.id));
  assert.equal(net.sent.filter((x) => x === `${cleo.id}>${ana.id}:join`).length, 1, 'the join was sent once');
});

test('leaving with the owner away answers at once, and the leave reaches the owner once she is back', async () => {
  const net = new Net();
  const { ana, ben, groupId } = await team(net);
  net.delays.set(ana.id, 1_500);
  const began = Date.now();
  await ben.service.leaveGroup(groupId);
  assert.ok(Date.now() - began < 1_000, `the leave waited ${String(Date.now() - began)} ms for the owner`);
  assert.ok(!ben.service.groupList().groups.some((g) => g.id === groupId), 'the group is gone here at once');
  assert.deepEqual(ben.service.pendingLeaves(), [{ groupId, endpointId: ana.id }]);
  // Away for good, then back: the leave is sent again until she takes it, and she removes Ben
  await off(ana);
  net.delays.delete(ana.id);
  await sleep(200);
  assert.deepEqual(ben.service.pendingLeaves(), [{ groupId, endpointId: ana.id }], 'kept while nobody acknowledged it');
  await on(ana);
  await until('Ana removed Ben', () => !ana.service.getGroup(groupId).members.some((m) => m.endpointId === ben.id));
  await until('the leave is done', () => ben.service.pendingLeaves().length === 0);
});

test('the endpoint coming back online pokes every peer at once', async () => {
  const net = new Net();
  const { ana, ben, groupId } = await team(net);
  const hellos = () => net.sent.filter((x) => x === `${ben.id}>${ana.id}:hello`).length;
  await sleep(100);
  const before = hellos();
  // No relay for a while, then back: before, every peer waited its own timer (reconcile is a minute here)
  net.connections.get(ben.id)?.('no-relay');
  await sleep(100);
  assert.equal(hellos(), before, 'losing the relay does not dial anyone');
  net.connections.get(ben.id)?.('online');
  await until('Ben says hello to Ana again', () => hellos() > before, 2_000);
  assert.ok(ben.service.getGroup(groupId));
});

test('a pass over the waiting joins runs one at a time, however long the owner takes', async () => {
  const net = new Net();
  const { ana, ben, groupId } = await team(net);
  const cleo = await install(net, 'Cleo');
  await relayedRequest(ana, ben, cleo, groupId);
  // Each ask to Ana and Ben now takes far longer than the 60 ms between passes
  net.delays.set(ana.id, 400);
  net.delays.set(ben.id, 400);
  const asks = () => net.sent.filter((x) => x === `${cleo.id}>${ana.id}:roster`).length;
  const before = asks();
  await sleep(1_300);
  // One pass asks Ana once and takes ~800 ms; overlapping passes every 60 ms would ask her ~20 times
  assert.ok(asks() - before <= 3, `Ana was asked ${String(asks() - before)} times`);
  assert.equal(pendingOf(cleo, groupId)?.state, 'waiting');
});
