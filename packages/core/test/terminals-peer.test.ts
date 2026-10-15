import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import test from 'node:test';
import { processTable } from '../src/processes.ts';
import { PeerCheck, type PeerVerdict } from '../src/terminals/peer.ts';

const procReadable = PeerCheck.prototype.available.call({}) === 'on';
const linux = { skip: procReadable ? false : '/proc is not readable here' };

const children: ChildProcess[] = [];
const servers: Server[] = [];
test.after(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const server of servers) server.close();
});

/** A listening socket that hands each accepted connection to the test */
async function listen(host: string): Promise<{ port: number; next: () => Promise<Socket> }> {
  const waiting: Array<(socket: Socket) => void> = [];
  const ready: Socket[] = [];
  const server = createServer((socket) => {
    const waiter = waiting.shift();
    if (waiter) waiter(socket);
    else ready.push(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { port: address.port, next: () => new Promise((resolve) => (ready.length > 0 ? resolve(ready.shift() as Socket) : waiting.push(resolve))) };
}

/** What a client process holds open: it connects and waits */
const CLIENT = "const s = require('node:net').connect(Number(process.argv[1]), process.argv[2]); s.on('error', () => process.exit(1)); setInterval(() => undefined, 1000);";

function client(port: number, host: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, ['-e', CLIENT, String(port), host], { env: { ...process.env, ...env }, stdio: 'ignore' });
  children.push(child);
  return child;
}

async function verdict(host: string, via: (port: number) => void, bind = host, chats?: () => number[]): Promise<PeerVerdict> {
  const { port, next } = await listen(bind);
  via(port);
  const socket = await next();
  assert.ok(socket.remotePort && socket.remoteAddress);
  // Let the client's connect settle, and the process table with it
  await new Promise((done) => setTimeout(done, 100));
  const check = chats ? new PeerCheck({ table: processTable, chatPids: chats }) : new PeerCheck();
  const found = check.check({ address: socket.remoteAddress, port: socket.remotePort, serverPort: port });
  socket.destroy();
  return found;
}

test('a connection from a process that carries CLAUDIO_CHAT_ID is an agent', linux, async () => {
  assert.equal(await verdict('127.0.0.1', (port) => client(port, '127.0.0.1', { CLAUDIO_CHAT_ID: 'chat-1' })), 'agent');
});

test('a connection from a descendant of a chat\'s process is an agent even if it dropped the variable', linux, async () => {
  const found = await verdict('127.0.0.1', (port) => {
    const parent = spawn(
      '/bin/sh',
      ['-c', `env -u CLAUDIO_CHAT_ID "${process.execPath}" -e "${CLIENT}" ${String(port)} 127.0.0.1 & wait`],
      { env: { ...process.env, CLAUDIO_CHAT_ID: 'chat-2' }, stdio: 'ignore' },
    );
    children.push(parent);
  });
  assert.equal(found, 'agent');
});

test('a connection from a process Claudio started for an agent (CLAUDIO_AGENT_RUN) is an agent, and so is its descendant', linux, async () => {
  assert.equal(await verdict('127.0.0.1', (port) => client(port, '127.0.0.1', { CLAUDIO_AGENT_RUN: 'orch-1' })), 'agent');
  const found = await verdict('127.0.0.1', (port) => {
    const parent = spawn(
      '/bin/sh',
      ['-c', `env -u CLAUDIO_AGENT_RUN "${process.execPath}" -e "${CLIENT}" ${String(port)} 127.0.0.1 & wait`],
      { env: { ...process.env, CLAUDIO_AGENT_RUN: 'orch-2' }, stdio: 'ignore' },
    );
    children.push(parent);
  });
  assert.equal(found, 'agent');
});

test("a connection from a process outside every chat's tree is not an agent", linux, async () => {
  // A chat of this test's own, and a client that is not below it. (Chats of other runs on this
  // machine may have descriptors this user cannot read, which would make the answer unknown.)
  const chat = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { env: { ...process.env, CLAUDIO_CHAT_ID: 'chat-3' }, stdio: 'ignore' });
  children.push(chat);
  const outcome = await verdict('127.0.0.1', (port) => client(port, '127.0.0.1', {}), '127.0.0.1', () => [chat.pid as number]);
  assert.equal(outcome, 'not-agent');
});

test('IPv6 loopback and a v4-mapped peer are found in the right table', linux, async (t) => {
  let v6: PeerVerdict;
  try {
    v6 = await verdict('::1', (port) => client(port, '::1', { CLAUDIO_CHAT_ID: 'chat-4' }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL' || (error as NodeJS.ErrnoException).code === 'EAFNOSUPPORT') {
      t.skip('no IPv6 loopback here');
      return;
    }
    throw error;
  }
  assert.equal(v6, 'agent');
  // A dual-stack server sees an IPv4 client as ::ffff:127.0.0.1
  assert.equal(await verdict('127.0.0.1', (port) => client(port, '127.0.0.1', { CLAUDIO_CHAT_ID: 'chat-5' }), '::'), 'agent');
});

test('a peer that cannot be found is unknown, never "not an agent"', linux, () => {
  assert.equal(new PeerCheck().check({ address: '127.0.0.1', port: 1, serverPort: 2 }), 'unknown');
  assert.equal(new PeerCheck().check({ address: '::1', port: 1, serverPort: 2 }), 'unknown');
});
