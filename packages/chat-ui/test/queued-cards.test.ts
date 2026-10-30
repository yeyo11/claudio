import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import i18next from 'i18next';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import type { ChatPendingMessage, MessageDelivery, TranscriptEntry } from '@claudio/shared';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { datedByDelivery, readDismissed, reconcileCards, writeDismissed, type DeliveryFacts, type QueuedCard, type QueuedMessage } from '../src/composer/queued';
import { QueuedCards, type QueuedCardsProps } from '../src/composer/QueuedCards';

// The queued cards over the composer, matched by the id each message was sent with
// (docs/chat-delivery.md): never by its words, never by a clock on the page. A message Claudio or
// its Supervisor wrote is a notice, and a message held behind a foreground call offers to send that
// call to the background (docs/plans/regression-fixes-2026-10-29.md, C2 and D4).

const AT = 1_000_000;

const card = (id: string, over: Partial<QueuedCard> = {}): QueuedCard => ({ id, text: id, attachments: [], state: 'waiting', source: 'person', seenAt: AT, ...over });
const pending = (id: string, state: ChatPendingMessage['state'] = 'written', over: Partial<ChatPendingMessage> = {}): ChatPendingMessage => ({
  id,
  text: `said ${id}`,
  attachments: [],
  state,
  sentAt: '2026-10-08T12:00:00.000Z',
  source: 'person',
  ...over,
});
const AGENT_CALL = { toolUseId: 'toolu_agent_1', name: 'Agent', description: 'look around the repository' };

function facts(over: Partial<DeliveryFacts> & { told?: MessageDelivery[] } = {}): DeliveryFacts {
  const told = new Map((over.told ?? []).map((d) => [d.id, d]));
  return { pending: [], readAt: AT, delivery: (id) => told.get(id), written: new Set(), dismissed: new Set(), ...over };
}

test('a card goes when the stream says the agent took its message, and the others stay', () => {
  const held = [card('m1'), card('m2')];
  const next = reconcileCards(held, facts({ pending: [pending('m2')], told: [{ id: 'm1', state: 'delivered' }] }));
  assert.deepEqual(next.map((c) => c.id), ['m2']);
});

test('two messages the agent read as one prompt clear both cards', () => {
  const held = [card('m1'), card('m2')];
  const next = reconcileCards(held, facts({ told: [{ id: 'm1', state: 'delivered' }, { id: 'm2', state: 'delivered' }] }));
  assert.deepEqual(next, []);
});

test('a card is called lost only when the server says so, and keeps its files', () => {
  const files = [{ id: 'u1', name: 'notes.txt', mediaType: 'text/plain', kind: 'file' as const, sizeBytes: 12 }];
  const held = [card('m1', { attachments: files })];
  // The turn ended long ago and the chat reads idle: still waiting, since nothing said otherwise
  assert.equal(reconcileCards(held, facts({ pending: [pending('m1')], readAt: AT + 60_000 })), held);
  const lost = reconcileCards(held, facts({ told: [{ id: 'm1', state: 'undelivered', reason: 'not-read' }] }));
  assert.equal(lost[0]?.state, 'lost');
  assert.deepEqual(lost[0]?.attachments, files);
});

test('a withdrawn message takes its card with it, and the list does not bring it back', () => {
  const held = [card('m1'), card('m2')];
  const told: MessageDelivery[] = [{ id: 'm1', state: 'undelivered', reason: 'cancelled' }];
  assert.deepEqual(reconcileCards(held, facts({ told })).map((c) => c.id), ['m2']);
  assert.deepEqual(reconcileCards([], facts({ pending: [pending('m1', 'undelivered')], told })), []);
});

test('a reloaded page rebuilds the cards from what the chat lists as pending, each with who sent it', () => {
  const next = reconcileCards([], facts({ pending: [pending('m1'), pending('m2', 'held'), pending('m3', 'undelivered'), pending('h1', 'written', { source: 'supervisor' })] }));
  assert.deepEqual(next.map((c) => [c.id, c.state, c.text, c.source]), [
    ['m1', 'waiting', 'said m1', 'person'],
    ['m2', 'held', 'said m2', 'person'],
    ['m3', 'lost', 'said m3', 'person'],
    ['h1', 'waiting', 'said h1', 'supervisor'],
  ]);
});

test('a row stored before the source was recorded reads as the person\'s', () => {
  const stored = { ...pending('m1') } as Partial<ChatPendingMessage>;
  delete stored.source;
  const [rebuilt] = reconcileCards([], facts({ pending: [stored as ChatPendingMessage] }));
  assert.equal(rebuilt?.source, 'person');
});

test('a card follows the foreground call the server says holds it, and lets go of it when the call returns', () => {
  const held = [card('m1')];
  const blocked = reconcileCards(held, facts({ pending: [pending('m1', 'written', { blockedBy: AGENT_CALL })] }));
  assert.deepEqual(blocked[0]?.blockedBy, AGENT_CALL);
  // The same read again changes nothing
  assert.equal(reconcileCards(blocked, facts({ pending: [pending('m1', 'written', { blockedBy: AGENT_CALL })] })), blocked);
  const free = reconcileCards(blocked, facts({ pending: [pending('m1')] }));
  assert.equal(free[0]?.blockedBy, undefined);
});

test('a card stays through a read that set out before its message was sent', () => {
  const held = [card('m1')];
  assert.equal(reconcileCards(held, facts({ readAt: AT + 500 })), held);
  // A read well after it that no longer lists it: the agent has it
  assert.deepEqual(reconcileCards(held, facts({ readAt: AT + 10_000 })), []);
});

test("the agent's transcript holding the message clears its card", () => {
  const held = [card('m1')];
  assert.deepEqual(reconcileCards(held, facts({ pending: [pending('m1')], written: new Set(['m1']) })), []);
});

test('a card the person put back in the box is not brought back by the list', () => {
  assert.deepEqual(reconcileCards([], facts({ pending: [pending('m1', 'undelivered')], dismissed: new Set(['m1']) })), []);
});

test('a held message turns into a waiting one when the next process takes it into its queue', () => {
  const held = [card('m1', { state: 'held' })];
  assert.equal(reconcileCards(held, facts({ pending: [pending('m1', 'written')] }))[0]?.state, 'waiting');
});

test('the cards a person dismissed are kept per chat for the tab, so a reload does not bring them back', () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) };
  writeDismissed('chat-a', new Set(['m1', 'm2']), storage);
  assert.deepEqual([...readDismissed('chat-a', storage)], ['m1', 'm2']);
  // Another chat's are its own
  assert.deepEqual([...readDismissed('chat-b', storage)], []);
  // Bounded: the newest kept
  writeDismissed('chat-a', new Set(Array.from({ length: 80 }, (_, i) => `m${String(i)}`)), storage);
  const kept = [...readDismissed('chat-a', storage)];
  assert.equal(kept.length, 50);
  assert.equal(kept.at(-1), 'm79');
  // A storage that cannot be read keeps nothing, and breaks nothing
  assert.deepEqual([...readDismissed('chat-a', { getItem: () => '{not json' })], []);
  assert.deepEqual([...readDismissed('chat-a', null)], []);
});

test('a message the agent took into a running turn is dated when it took it', () => {
  const entry = (uuid: string, role: TranscriptEntry['role'] = 'user'): TranscriptEntry => ({ uuid, role, timestamp: '2026-10-29T10:00:00.000Z', model: null, isSidechain: false, parentToolUseId: null, blocks: [{ type: 'text', text: uuid }] });
  const told = new Map<string, MessageDelivery>([['m1', { id: 'm1', state: 'delivered', at: '2026-10-29T10:04:00.000Z' }]]);
  const delivery = (id: string) => told.get(id);
  assert.equal(datedByDelivery(entry('m1'), delivery).timestamp, '2026-10-29T10:04:00.000Z');
  const untold = entry('m2');
  assert.equal(datedByDelivery(untold, delivery), untold, 'nothing heard: the same entry');
  const answer = entry('m1', 'assistant');
  assert.equal(datedByDelivery(answer, delivery), answer, 'only a message of the person is a delivery');
});

// ---------- the card as drawn ----------

// tsx compiles the packages' files with the classic runtime, and they do not import React
(globalThis as { React?: typeof React }).React = React;

const english = JSON.parse(readFileSync(new URL('../src/locales/en/chat.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { chat: english } }, ns: ['chat'], defaultNS: 'chat', interpolation: { escapeValue: false } });

function draw(queued: QueuedMessage[], over: Partial<QueuedCardsProps> = {}): string {
  const noop = () => {};
  const props: QueuedCardsProps = { queued, agent: 'Claude Code', onSendNow: noop, onBackground: noop, onWithdraw: noop, onDismiss: noop, onRestore: noop, ...over };
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(TooltipProvider, null, createElement(QueuedCards, props))));
}

const buttonsOf = (html: string): string[] => [...html.matchAll(/<button[^>]*class="btn btn-small"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1] ?? '');

test('a waiting message of the person offers Send now, and a way to take it back', () => {
  const html = draw([card('m1', { text: 'look at the config first' })]);
  assert.deepEqual(buttonsOf(html), ['Send now']);
  assert.match(html, /aria-label="Take it back to the box"/);
});

test('a message held behind a foreground agent offers the background and names what an interrupt ends', () => {
  const html = draw([card('m1', { blockedBy: AGENT_CALL })]);
  assert.deepEqual(buttonsOf(html), ['Send to background and deliver', 'Interrupt the turn']);
  assert.match(html, /Waits for the agent “look around the repository” to finish\. Interrupting the turn ends that agent/);
  const command = draw([card('m1', { blockedBy: { toolUseId: 'toolu_bash_1', name: 'Bash', description: 'pnpm e2e' } })]);
  assert.match(command, /Waits for the command “pnpm e2e” to finish/);
});

test("a Supervisor's hint is a notice: no Send now, and a Dismiss", () => {
  const html = draw([card('h1', { text: 'is a connection left open?', source: 'supervisor' })]);
  assert.deepEqual(buttonsOf(html), []);
  assert.match(html, /class="chat-queued-item is-notice"/);
  assert.match(html, /Supervisor&#x27;s hint:|Supervisor's hint:/);
  assert.match(html, /aria-label="Dismiss"/);
  assert.doesNotMatch(html, /Take it back to the box/);
});

test("a notice beside a person's waiting message leaves Send now to the person's", () => {
  let sent = '';
  const html = draw([card('h1', { source: 'claudio' }), card('m1')], { onSendNow: (id) => (sent = id) });
  assert.deepEqual(buttonsOf(html), ['Send now']);
  assert.equal(sent, '');
  assert.match(html, /Note from Claudio:/);
});

test('a lost message of the person is handed back, with no button to hurry it', () => {
  const html = draw([card('m1', { state: 'lost' })]);
  assert.deepEqual(buttonsOf(html), []);
  assert.match(html, /class="chat-queued is-lost"/);
  assert.match(html, /aria-label="Put it back in the box"/);
});

test('nothing waiting draws no card', () => {
  assert.equal(draw([]), '');
});
