import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { Terminal, TerminalChangedEvent, TerminalStatus } from '@claudio/shared';
import { keys } from '../src/api';
import { applyTerminalEvent, shareTerminalFeed } from '../src/components/terminal/use-terminals';
import { dispatchEvent } from '../src/lib/feed';

const status = (available: boolean): TerminalStatus =>
  ({ enabled: available, available, reason: available ? null : 'off', settings: {}, sources: {}, peerCheck: 'on', running: 0 }) as unknown as TerminalStatus;

const terminal = (id: string): Terminal => ({
  id, scope: { kind: 'workspace' }, cwd: '/workspace', shell: '/bin/bash', state: 'running', cols: 80, rows: 24, clients: 1, startedAt: '2026-10-18T10:00:00Z', endedAt: null, endReason: null, exitCode: null,
});

/** A client with the queries a page keeps watching, each counting how often it went to the server */
function watched() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const asked: Record<string, number> = {};
  const watch = <T>(name: string, queryKey: readonly unknown[], value: T) => {
    const observer = new QueryObserver(client, {
      queryKey,
      queryFn: async () => {
        asked[name] = (asked[name] ?? 0) + 1;
        return value;
      },
    });
    const off = observer.subscribe(() => undefined);
    return off;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { client, asked, watch, settle };
}

test('a terminal.changed that says the feature is off asks the server for nothing, lists included', async () => {
  const w = watched();
  const stops = [w.watch('status', keys.terminalStatus, status(true)), w.watch('list', keys.terminalList('all'), [] as Terminal[])];
  await w.settle();
  applyTerminalEvent(w.client, { status: status(false), terminals: [] });
  await w.settle();
  assert.deepEqual(w.asked, { status: 1, list: 1 });
  assert.equal(w.client.getQueryData<TerminalStatus>(keys.terminalStatus)?.available, false);
  for (const stop of stops) stop();
});

test('a terminal the server no longer lists is forgotten from the event, never asked for again', async () => {
  const w = watched();
  const stops = [
    w.watch('status', keys.terminalStatus, status(true)),
    w.watch('kept', keys.terminalOne('term_kept'), terminal('term_kept')),
    w.watch('closed', keys.terminalOne('term_closed'), terminal('term_closed')),
  ];
  await w.settle();
  const kept = { ...terminal('term_kept'), clients: 2 };
  applyTerminalEvent(w.client, { status: status(true), terminals: [kept] });
  await w.settle();
  // The status is this client's to read again (the gate may refuse this device); the terminals come from the event
  assert.deepEqual(w.asked, { status: 2, kept: 1, closed: 1 });
  assert.equal(w.client.getQueryData(keys.terminalOne('term_closed')), null);
  assert.equal(w.client.getQueryData<Terminal>(keys.terminalOne('term_kept'))?.clients, 2);
  for (const stop of stops) stop();
});

const changed = (id: number): TerminalChangedEvent => ({ id, at: '2026-11-07T10:00:00Z', title: 'Terminals changed', type: 'terminal.changed', terminals: [], status: status(true) });

test('a terminal.changed is applied once however many components read the status', async () => {
  // The desktop shell with the dock open reads the status in five places (the bar, the More sheet's
  // count and its list, the status bar item, the dock). Each applied the event on its own, and each
  // invalidation cancelled the fetch the one before it had just started: on CI every event cost four
  // aborted GET /terminal and GET /terminals pairs, each of them a peer check on the server.
  const w = watched();
  const stops = [w.watch('status', keys.terminalStatus, status(true)), w.watch('list', keys.terminalList('all'), [] as Terminal[])];
  await w.settle();
  const readers = Array.from({ length: 5 }, () => shareTerminalFeed(w.client));
  dispatchEvent(changed(1));
  await w.settle();
  assert.deepEqual(w.asked, { status: 2, list: 2 });

  // Still once while some of them remain, and not at all once the last one is gone
  for (const release of readers.slice(1)) release();
  // A second release of the same reader is no release of another one
  readers[1]?.();
  dispatchEvent(changed(2));
  await w.settle();
  assert.deepEqual(w.asked, { status: 3, list: 3 });
  readers[0]?.();
  dispatchEvent(changed(3));
  await w.settle();
  assert.deepEqual(w.asked, { status: 3, list: 3 });
  for (const stop of stops) stop();
});

test('a reader that mounts again after every other one left listens again', async () => {
  const w = watched();
  const stops = [w.watch('status', keys.terminalStatus, status(true))];
  await w.settle();
  shareTerminalFeed(w.client)();
  const again = shareTerminalFeed(w.client);
  dispatchEvent(changed(4));
  await w.settle();
  assert.deepEqual(w.asked, { status: 2 });
  again();
  for (const stop of stops) stop();
});
