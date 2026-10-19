import assert from 'node:assert/strict';
import test from 'node:test';
import type { TerminalServerFrame } from '@claudio/shared';
import {
  backoffDelay,
  defaultSocketUrl,
  TerminalConnection,
  type ConnectionDeps,
  type ConnectionHandlers,
  type SocketLike,
} from '../src/components/terminal/terminal-connection';
import type { LinkState } from '../src/components/terminal/terminal-model';

class FakeSocket implements SocketLike {
  binaryType = 'blob';
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  sent: Array<string | Uint8Array> = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  frame(frame: TerminalServerFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  bytes(data: number[]) {
    this.onmessage?.({ data: new Uint8Array(data).buffer });
  }
  drop(code?: number) {
    this.readyState = 3;
    this.onclose?.(code === undefined ? {} : { code });
  }
}

function setup(custom?: ConnectionDeps['ticket']) {
  let issued = 0;
  const ticket: ConnectionDeps['ticket'] = custom ?? (async () => ({ ticket: `t${++issued}`, expiresAt: '' }));
  const sockets: FakeSocket[] = [];
  const timers: Array<{ run: () => void; ms: number; live: boolean }> = [];
  const links: LinkState[] = [];
  const events: string[] = [];
  const outputs: number[][] = [];
  const deps: ConnectionDeps = {
    ticket,
    open: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    socketUrl: (id, value) => defaultSocketUrl(id, value, '/api', { protocol: 'http:', host: 'localhost:5181' }),
    setTimer: (run, ms) => {
      const timer = { run, ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { live: boolean }).live = false;
    },
  };
  const on: ConnectionHandlers = {
    onLink: (link) => links.push(link),
    onHello: (hello) => events.push(`hello ${hello.cols}x${hello.rows}`),
    onOutput: (bytes) => outputs.push([...bytes]),
    onSize: (cols, rows) => events.push(`size ${cols}x${rows}`),
    onExit: (code) => events.push(`exit ${code}`),
    onClosed: (reason, again) => events.push(`closed ${reason} ${again}`),
  };
  const connection = new TerminalConnection('term_1', deps, on);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const fire = async () => {
    const timer = timers.find((entry) => entry.live);
    assert.ok(timer, 'a retry is scheduled');
    timer.live = false;
    timer.run();
    await flush();
  };
  return { connection, sockets, timers, links, events, outputs, flush, fire, issuedCount: () => issued };
}

test('the socket opens with a ticket in its address, and asks for bytes as a buffer', async () => {
  const t = setup();
  t.connection.start();
  await t.flush();
  assert.equal(t.sockets.length, 1);
  assert.equal(t.sockets[0]?.url, 'ws://localhost:5181/api/terminals/term_1/socket?ticket=t1');
  assert.equal(t.sockets[0]?.binaryType, 'arraybuffer');
  t.sockets[0]?.open();
  assert.deepEqual(t.links, ['connecting', 'open']);
});

test('the page speaks https, so the socket speaks wss', () => {
  assert.equal(defaultSocketUrl('a b', 'x+y', '/api', { protocol: 'https:', host: 'claudio.example' }), 'wss://claudio.example/api/terminals/a%20b/socket?ticket=x%2By');
});

test('a dropped socket reconnects with a new ticket, backing off between failures', async () => {
  const t = setup();
  t.connection.start();
  await t.flush();
  t.sockets[0]?.open();
  t.sockets[0]?.drop();
  assert.equal(t.links.at(-1), 'reconnecting');
  assert.equal(t.timers.at(-1)?.ms, backoffDelay(0));
  await t.fire();
  assert.equal(t.sockets.length, 2);
  assert.match(t.sockets[1]?.url ?? '', /ticket=t2$/);
  // It never opened: the next wait is longer
  t.sockets[1]?.drop();
  assert.equal(t.timers.at(-1)?.ms, backoffDelay(1));
  await t.fire();
  assert.match(t.sockets[2]?.url ?? '', /ticket=t3$/);
  // Once it opens, the wait starts over
  t.sockets[2]?.open();
  t.sockets[2]?.drop();
  assert.equal(t.timers.at(-1)?.ms, backoffDelay(0));
});

test('the wait doubles from half a second and stops at fifteen', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 10].map(backoffDelay), [500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000]);
});

test('a ticket the server refuses for good ends the connection; one that fails to arrive is tried again', async () => {
  const gone = setup(async () => {
    throw Object.assign(new Error('gone'), { status: 404 });
  });
  gone.connection.start();
  await gone.flush();
  assert.equal(gone.links.at(-1), 'ended');
  assert.equal(gone.timers.length, 0);

  let tries = 0;
  const flaky = setup(async () => {
    if (++tries === 1) throw Object.assign(new Error('offline'), { status: 0 });
    return { ticket: 'ok', expiresAt: '' };
  });
  flaky.connection.start();
  await flaky.flush();
  assert.equal(flaky.links.at(-1), 'reconnecting');
  await flaky.fire();
  assert.equal(flaky.sockets.length, 1);
});

test('hello, the screen tail and the live bytes reach the view in order', async () => {
  const t = setup();
  t.connection.start();
  await t.flush();
  const socket = t.sockets[0];
  socket?.open();
  socket?.frame({ type: 'hello', terminal: {} as never, snapshot: 'screen', cols: 100, rows: 30 });
  socket?.bytes([1, 2]);
  socket?.bytes([3]);
  socket?.frame({ type: 'size', cols: 90, rows: 20 });
  assert.deepEqual(t.events, ['hello 100x30', 'size 90x20']);
  assert.deepEqual(t.outputs, [[1, 2], [3]]);
});

test('the shell exiting or the server closing the terminal is final; a slow client is put back on from a snapshot', async () => {
  const exited = setup();
  exited.connection.start();
  await exited.flush();
  exited.sockets[0]?.open();
  exited.sockets[0]?.frame({ type: 'exit', code: 0, signal: null });
  exited.sockets[0]?.drop();
  assert.equal(exited.links.at(-1), 'ended');
  assert.equal(exited.timers.length, 0);

  const closed = setup();
  closed.connection.start();
  await closed.flush();
  closed.sockets[0]?.open();
  closed.sockets[0]?.frame({ type: 'closed', reason: 'idle' });
  closed.sockets[0]?.drop();
  assert.deepEqual(closed.events, ['closed idle false']);
  assert.equal(closed.timers.length, 0);

  const slow = setup();
  slow.connection.start();
  await slow.flush();
  slow.sockets[0]?.open();
  slow.sockets[0]?.frame({ type: 'closed', reason: 'evicted-slow' });
  slow.sockets[0]?.drop();
  assert.deepEqual(slow.events, ['closed evicted-slow true']);
  await slow.fire();
  assert.equal(slow.sockets.length, 2);
});

test('input goes out as bytes on an open socket and is dropped on a closed one; control frames are JSON', async () => {
  const t = setup();
  t.connection.start();
  await t.flush();
  const socket = t.sockets[0];
  assert.equal(t.connection.input('ls'), false);
  socket?.open();
  assert.equal(t.connection.input('é'), true);
  t.connection.frame({ type: 'resize', cols: 120, rows: 40 });
  assert.deepEqual([...(socket?.sent[0] as Uint8Array)], [0xc3, 0xa9]);
  assert.equal(socket?.sent[1], JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
});

test('stopping closes the socket and cancels a pending retry', async () => {
  const t = setup();
  t.connection.start();
  await t.flush();
  t.sockets[0]?.open();
  t.sockets[0]?.drop();
  t.connection.stop();
  assert.equal(t.timers.at(-1)?.live, false);
  const second = setup();
  second.connection.start();
  await second.flush();
  second.connection.stop();
  assert.equal(second.sockets[0]?.closed, true);
});

test('a terminal closed by the person is forgotten: the socket goes and no ticket is asked again', async () => {
  const t = setup();
  t.connection.start();
  await t.flush();
  t.sockets[0]?.open();
  t.connection.forget();
  assert.equal(t.sockets[0]?.closed, true);
  // Whatever the socket does as it goes, nothing is scheduled and no second ticket is spent
  t.sockets[0]?.drop();
  await t.flush();
  assert.equal(t.timers.length, 0);
  assert.equal(t.issuedCount(), 1);
  assert.equal(t.sockets.length, 1);
});

test('a socket the server would not attach (1008: the terminal is gone) is not retried', async () => {
  const t = setup();
  t.connection.start();
  await t.flush();
  t.sockets[0]?.drop(1008);
  assert.equal(t.links.at(-1), 'ended');
  assert.equal(t.timers.length, 0);
  assert.equal(t.issuedCount(), 1);
});

test('a terminal closed on the server ends the connection for good, even when the socket drops after the frame', async () => {
  const t = setup();
  t.connection.start();
  await t.flush();
  t.sockets[0]?.open();
  t.sockets[0]?.frame({ type: 'closed', reason: 'closed' });
  t.sockets[0]?.drop(1000);
  await t.flush();
  assert.deepEqual(t.events, ['closed closed false']);
  assert.equal(t.timers.length, 0);
  assert.equal(t.issuedCount(), 1);
});
