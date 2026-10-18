import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import test from 'node:test';
import { PeerCheck, type PeerVerdict } from '../src/terminals/peer.ts';

const procReadable = PeerCheck.prototype.available.call({}) === 'on';
const linux = { skip: procReadable ? false : '/proc is not readable here' };

const children: ChildProcess[] = [];
/** Shells spawned as the leaders of their own process group, so killing the group takes their children too */
const groups: ChildProcess[] = [];
const servers: Server[] = [];
const ports: number[] = [];

/** The clients of this run still alive: their command line is CLIENT, and their port one of this run's */
function leftClients(): string[] {
  const left: string[] = [];
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    } catch {
      continue;
    }
    const at = argv.indexOf(CLIENT);
    if (at >= 0 && ports.includes(Number(argv[at + 1]))) left.push(`${pid} ${argv.join(' ')}`);
  }
  return left;
}

test.after(async () => {
  for (const child of children) child.kill('SIGKILL');
  for (const group of groups) {
    try {
      if (group.pid) process.kill(-group.pid, 'SIGKILL');
    } catch {
      // The group is already gone
    }
  }
  for (const server of servers) server.close();
  if (!procReadable) return;
  // A grandchild the shell left is reparented, and nothing else would ever end it: 140 of them
  // once piled up on a machine from runs of this file
  const end = Date.now() + 5000;
  while (leftClients().length > 0 && Date.now() < end) await new Promise((done) => setTimeout(done, 25));
  assert.deepEqual(leftClients(), [], 'every client process this file started has ended');
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
  ports.push(address.port);
  return { port: address.port, next: () => new Promise((resolve) => (ready.length > 0 ? resolve(ready.shift() as Socket) : waiting.push(resolve))) };
}

/** What a client process holds open: it connects and waits, and ends once the connection does */
const CLIENT =
  "const s = require('node:net').connect(Number(process.argv[1]), process.argv[2]); s.on('error', () => process.exit(1)); s.on('close', () => process.exit(0)); setInterval(() => undefined, 1000);";

/** This run's environment without the marks it may itself carry when an agent runs the tests */
function ambient(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDIO_CHAT_ID;
  delete env.CLAUDIO_AGENT_RUN;
  return env;
}

function client(port: number, host: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, ['-e', CLIENT, String(port), host], { env: { ...ambient(), ...env }, stdio: 'ignore' });
  children.push(child);
  return child;
}

async function verdict(host: string, via: (port: number) => void, bind = host): Promise<PeerVerdict> {
  const { port, next } = await listen(bind);
  via(port);
  const socket = await next();
  assert.ok(socket.remotePort && socket.remoteAddress);
  // Let the client's connect settle, and the process table with it
  await new Promise((done) => setTimeout(done, 100));
  const found = await new PeerCheck().verdict({ address: socket.remoteAddress, port: socket.remotePort, serverPort: port });
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
      { env: { ...ambient(), CLAUDIO_CHAT_ID: 'chat-2' }, stdio: 'ignore', detached: true },
    );
    groups.push(parent);
  });
  assert.equal(found, 'agent');
});

test('a connection from a process Claudio started for an agent (CLAUDIO_AGENT_RUN) is an agent, and so is its descendant', linux, async () => {
  assert.equal(await verdict('127.0.0.1', (port) => client(port, '127.0.0.1', { CLAUDIO_AGENT_RUN: 'orch-1' })), 'agent');
  const found = await verdict('127.0.0.1', (port) => {
    const parent = spawn(
      '/bin/sh',
      ['-c', `env -u CLAUDIO_AGENT_RUN "${process.execPath}" -e "${CLIENT}" ${String(port)} 127.0.0.1 & wait`],
      { env: { ...ambient(), CLAUDIO_AGENT_RUN: 'orch-2' }, stdio: 'ignore', detached: true },
    );
    groups.push(parent);
  });
  assert.equal(found, 'agent');
});

test("a connection from a process outside every chat's tree is not an agent, even while a chat runs beside it", linux, async () => {
  const chat = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { env: { ...ambient(), CLAUDIO_CHAT_ID: 'chat-3' }, stdio: 'ignore' });
  children.push(chat);
  assert.equal(await verdict('127.0.0.1', (port) => client(port, '127.0.0.1', {})), 'not-agent');
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

test('a peer that cannot be found is unknown, never "not an agent"', linux, async () => {
  assert.equal(await new PeerCheck().verdict({ address: '127.0.0.1', port: 1, serverPort: 2 }), 'unknown');
  assert.equal(await new PeerCheck().verdict({ address: '::1', port: 1, serverPort: 2 }), 'unknown');
});

test('a process that ended and waits to be reaped does not make the answer unknown', linux, async () => {
  const { port, next } = await listen('127.0.0.1');
  client(port, '127.0.0.1', {});
  const socket = await next();
  assert.ok(socket.remotePort && socket.remoteAddress);
  await new Promise((done) => setTimeout(done, 100));
  const dead = spawn(process.execPath, ['-e', ''], { env: { ...ambient(), CLAUDIO_CHAT_ID: 'chat-dead' }, stdio: 'ignore' });
  // Without yielding to the event loop nothing reaps the child, so it stays a zombie, whose
  // descriptor directory the kernel refuses to list
  const state = (): string => {
    try {
      return readFileSync(`/proc/${String(dead.pid)}/stat`, 'utf8').split(') ')[1]?.[0] ?? '';
    } catch {
      return '';
    }
  };
  for (const end = Date.now() + 5000; state() !== 'Z' && Date.now() < end; ) {
    // busy wait
  }
  assert.equal(state(), 'Z');
  const found = await new PeerCheck().verdict({ address: socket.remoteAddress, port: socket.remotePort, serverPort: port });
  socket.destroy();
  assert.equal(found, 'not-agent');
});
