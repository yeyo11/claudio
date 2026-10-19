import assert from 'node:assert/strict';
import { readdirSync, readlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import test from 'node:test';
import { PeerCheck, type PeerSocket, type ProcReader } from '../src/terminals/peer.ts';

// The check answers `not-agent` only for a holder it found and walked to the end. The races that
// would make a walk stop short (a holder that cannot be read, an ancestor that exits or is a zombie)
// cannot be held open from a test, so `/proc` is read through a fake process tree whose holder
// "holds" the descriptors of this process's own real loopback connection.

const procReadable = PeerCheck.prototype.available.call({}) === 'on';
const linux = { skip: procReadable ? false : '/proc is not readable here' };

const HOLDER = 900_001;
const PARENT = 900_002;
const OTHER = 900_003;

interface FakeProcess {
  ppid: number;
  state?: string;
  env?: string[];
  /** What reading its descriptors throws, if anything */
  fdsError?: string;
  /** What reading its stat line throws, if anything */
  statError?: string;
  holds?: boolean;
}

const errno = (code: string) => Object.assign(new Error(code), { code });

function reader(tree: Record<number, FakeProcess>): ProcReader {
  const at = (pid: number): FakeProcess => {
    const entry = tree[pid];
    if (!entry) throw errno('ENOENT');
    return entry;
  };
  return {
    pids: () => Object.keys(tree).map(Number),
    fds: (pid) => {
      const entry = at(pid);
      if (entry.fdsError) throw errno(entry.fdsError);
      return entry.holds ? readdirSync('/proc/self/fd') : [];
    },
    link: (_pid, fd) => readlinkSync(`/proc/self/fd/${fd}`),
    stat: (pid) => {
      const entry = at(pid);
      if (entry.statError) throw errno(entry.statError);
      return `${String(pid)} (a (b) c) ${entry.state ?? 'S'} ${String(entry.ppid)} 1 1 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 1`;
    },
    environ: (pid) => (at(pid).env ?? ['HOME=/home/someone']).join('\0'),
  };
}

const servers: Server[] = [];
const sockets: Socket[] = [];
test.after(() => {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
});

/** A loopback connection of this process's own, as the server side sees it, and the client end */
async function connection(): Promise<{ peer: PeerSocket; client: Socket }> {
  let client: Socket | undefined;
  const accepted = new Promise<Socket>((resolve) => {
    const server = createServer(resolve);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      client = connect(address.port, '127.0.0.1');
      sockets.push(client);
    });
  });
  const socket = await accepted;
  sockets.push(socket);
  assert.ok(client && socket.remoteAddress && socket.remotePort && socket.localPort);
  return { peer: { address: socket.remoteAddress, port: socket.remotePort, serverPort: socket.localPort }, client };
}

test('a holder whose ancestry is clean up to init is not an agent', linux, async () => {
  const { peer } = await connection();
  const check = new PeerCheck(reader({ [HOLDER]: { ppid: PARENT, holds: true }, [PARENT]: { ppid: 1 } }));
  assert.equal(await check.verdict(peer), 'not-agent');
});

test('a holder below a process that carries CLAUDIO_CHAT_ID or CLAUDIO_AGENT_RUN is an agent', linux, async () => {
  const { peer } = await connection();
  for (const mark of ['CLAUDIO_CHAT_ID=chat-1', 'CLAUDIO_AGENT_RUN=orch-1']) {
    const check = new PeerCheck(reader({ [HOLDER]: { ppid: PARENT, holds: true }, [PARENT]: { ppid: 1, env: ['HOME=/x', mark] } }));
    assert.equal(await check.verdict(peer), 'agent', mark);
  }
});

test('a socket held by two processes is an agent when either of them is', linux, async () => {
  const { peer } = await connection();
  const check = new PeerCheck(reader({ [HOLDER]: { ppid: 1, holds: true }, [OTHER]: { ppid: 1, holds: true, env: ['CLAUDIO_CHAT_ID=chat-2'] } }));
  assert.equal(await check.verdict(peer), 'agent');
});

test('a holder that cannot be read is unknown, never "not an agent"', linux, async () => {
  const { peer } = await connection();
  for (const code of ['EACCES', 'ENOENT']) {
    const check = new PeerCheck(reader({ [HOLDER]: { ppid: 1, holds: true, fdsError: code } }));
    assert.equal(await check.verdict(peer), 'unknown', code);
  }
});

test('an ancestor that exits mid-walk, or a zombie one, leaves the answer unknown', linux, async () => {
  const { peer } = await connection();
  const exited = new PeerCheck(reader({ [HOLDER]: { ppid: PARENT, holds: true }, [PARENT]: { ppid: 1, statError: 'ENOENT' } }));
  assert.equal(await exited.verdict(peer), 'unknown');
  // A chat's CLI that just ended reads an empty environment, and would hide the curl it left behind
  const zombie = new PeerCheck(reader({ [HOLDER]: { ppid: PARENT, holds: true }, [PARENT]: { ppid: 1, state: 'Z', env: [] } }));
  assert.equal(await zombie.verdict(peer), 'unknown');
});

test('an ancestor whose environment is another user\'s carries no mark, and the walk goes on', linux, async () => {
  const { peer } = await connection();
  const tree = reader({ [HOLDER]: { ppid: PARENT, holds: true }, [PARENT]: { ppid: OTHER }, [OTHER]: { ppid: 1, env: ['CLAUDIO_CHAT_ID=chat-3'] } });
  const environ = tree.environ;
  tree.environ = (pid) => {
    if (pid === PARENT) throw errno('EACCES');
    return environ(pid);
  };
  assert.equal(await new PeerCheck(tree).verdict(peer), 'agent');
});

test('a process caught exiting beside the holder does not change the answer', linux, async () => {
  const { peer } = await connection();
  const check = new PeerCheck(reader({ [HOLDER]: { ppid: 1, holds: true }, [OTHER]: { ppid: 1, fdsError: 'EACCES', env: ['CLAUDIO_CHAT_ID=chat-4'] } }));
  assert.equal(await check.verdict(peer), 'not-agent');
});

test('a client that closed its socket before the check is unknown', linux, async () => {
  const { peer, client } = await connection();
  client.destroy();
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(await new PeerCheck().verdict(peer), 'unknown');
});
