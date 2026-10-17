import assert from 'node:assert/strict';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import test from 'node:test';
import { PeerCheck, type PeerSocket, type ProcReader } from '../src/terminals/peer.ts';

// A process of a chat's tree caught between the start of its exit and becoming a zombie: the kernel
// already refuses to list its descriptors (EACCES) while its state still reads running, with the
// exiting flag set. On a machine whose agents start and end processes all the time, that made the
// person's own browser read `unknown`, and under `mode: none` be refused the terminal. The kernel
// window lasts milliseconds and cannot be held open from a test, so `/proc` is read through a fake
// for the chat's process, and the client is a real socket of this test's own.

const procReadable = PeerCheck.prototype.available.call({}) === 'on';
const linux = { skip: procReadable ? false : '/proc is not readable here' };

const FAKE_PID = 999_999_001;
const statLine = (state: string, flags: number) => `${String(FAKE_PID)} (node) ${state} 1 1 1 0 -1 ${String(flags)} 0 0 0 0 0 0 0 0 20 0 1 0 1`;
const PF_EXITING = 0x4;
const eacces = () => Object.assign(new Error('EACCES'), { code: 'EACCES' });
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

/** `/proc` as the system has it, except for the fake chat process, which `fake` answers for */
function reader(fake: { fds(): string[]; stat(): string }): ProcReader {
  return {
    fds: (pid) => (pid === FAKE_PID ? fake.fds() : readdirSync(`/proc/${String(pid)}/fd`)),
    link: (pid, fd) => readlinkSync(`/proc/${String(pid)}/fd/${fd}`),
    stat: (pid) => (pid === FAKE_PID ? fake.stat() : readFileSync(`/proc/${String(pid)}/stat`, 'utf8')),
  };
}

const servers: Server[] = [];
const sockets: Socket[] = [];
test.after(() => {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
});

/** A loopback connection of this process's own, as the server side sees it */
async function connection(): Promise<PeerSocket> {
  const accepted = new Promise<Socket>((resolve) => {
    const server = createServer(resolve);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      sockets.push(connect(address.port, '127.0.0.1'));
    });
  });
  const socket = await accepted;
  sockets.push(socket);
  assert.ok(socket.remoteAddress && socket.remotePort && socket.localPort);
  return { address: socket.remoteAddress, port: socket.remotePort, serverPort: socket.localPort };
}

const noTable = { table: () => [{ pid: 1, ppid: 0, started: 0, argv: ['init'] }], chatPids: () => [FAKE_PID] };

test('a chat process caught exiting is waited for, and the browser beside it is not an agent', linux, async () => {
  const peer = await connection();
  let looks = 0;
  const check = new PeerCheck(noTable, reader({
    fds: () => {
      looks++;
      throw looks === 1 ? eacces() : enoent();
    },
    // Exiting on the first look, a zombie by the time the check looks again
    stat: () => (looks <= 1 ? statLine('R', PF_EXITING) : statLine('Z', 0)),
  }));
  assert.equal(await check.verdict(peer), 'not-agent');
  assert.equal(looks, 2, 'the check looked again once the process had finished');
});

test('a chat process whose descriptors are refused for good keeps the answer unknown, without waiting', linux, async () => {
  const peer = await connection();
  const check = new PeerCheck(noTable, reader({ fds: () => { throw eacces(); }, stat: () => statLine('S', 0) }));
  const started = Date.now();
  assert.equal(await check.verdict(peer), 'unknown');
  assert.ok(Date.now() - started < 100, `a process that is not exiting is not waited for (${String(Date.now() - started)} ms)`);
});

test('a chat process that stays caught exiting is waited for only so long, and the answer stays unknown', linux, async () => {
  const peer = await connection();
  const check = new PeerCheck(noTable, reader({ fds: () => { throw eacces(); }, stat: () => statLine('R', PF_EXITING) }));
  const started = Date.now();
  assert.equal(await check.verdict(peer), 'unknown');
  const waited = Date.now() - started;
  assert.ok(waited >= 400 && waited < 2000, `the wait is bounded (${String(waited)} ms)`);
});

test('a chat process that exits holding the client socket is never let through', linux, async () => {
  const peer = await connection();
  // The client socket stands for one the chat process held: when it "exits", its descriptors close
  // and the socket goes with them, which is what the check looks for again once it has finished
  const client = sockets.find((s) => s.localPort === peer.port);
  assert.ok(client);
  let looks = 0;
  const check = new PeerCheck(noTable, reader({
    fds: () => {
      looks++;
      if (looks === 1) {
        client.destroy();
        throw eacces();
      }
      throw enoent();
    },
    stat: () => (looks <= 1 ? statLine('R', PF_EXITING) : statLine('Z', 0)),
  }));
  assert.equal(await check.verdict(peer), 'unknown');
  assert.equal(looks, 1, 'the second look found no socket to look for');
});

test('one look answers `exiting` at once, and waiting it out leaves the server free to serve everyone else', linux, async () => {
  const peer = await connection();
  const check = new PeerCheck(noTable, reader({ fds: () => { throw eacces(); }, stat: () => statLine('R', PF_EXITING) }));
  const started = Date.now();
  assert.equal(check.check(peer), 'exiting');
  assert.ok(Date.now() - started < 100, 'a single look does not wait');
  // A timer due during the wait fires on time, and a request to another server is answered: the
  // wait is spaced by timers, never a blocking one
  const timer = new Promise<number>((resolve) => {
    const at = Date.now();
    setTimeout(() => resolve(Date.now() - at), 50);
  });
  const answered = new Promise<boolean>((resolve) => {
    const server = createServer((socket) => socket.end('pong'));
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const other = connect(address.port, '127.0.0.1');
      sockets.push(other);
      other.on('data', () => resolve(Date.now() - started < 400));
    });
  });
  const verdict = check.verdict(peer);
  const late = await timer;
  assert.ok(late < 200, `the timer fired ${String(late)} ms after it was set, for 50`);
  assert.equal(await answered, true, 'another connection was served while the check waited');
  assert.equal(await verdict, 'unknown');
});

test('a first look slower than the whole old wait is still followed by another, so a loaded machine does not refuse the person', linux, async () => {
  // Under a load near 60 one look took over 500 ms by itself (the process table and every chat's
  // descriptors), and a wait measured in time was over before a second look: T8-1's detached
  // process was refused because its parent, already gone a moment later, was caught exiting
  const peer = await connection();
  let looks = 0;
  const check = new PeerCheck(noTable, reader({
    fds: () => {
      looks++;
      if (looks === 1) {
        for (const end = Date.now() + 700; Date.now() < end; ) {
          // the slow first look
        }
        throw eacces();
      }
      throw enoent();
    },
    stat: () => (looks <= 1 ? statLine('R', PF_EXITING) : statLine('Z', 0)),
  }));
  assert.equal(await check.verdict(peer), 'not-agent');
  assert.equal(looks, 2);
});
