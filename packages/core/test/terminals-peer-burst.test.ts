import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import test from 'node:test';
import { PeerCheck, type PeerVerdict } from '../src/terminals/peer.ts';

// The reviewer's finding of 2026-10-18: from an agent's shell, a burst of requests got past the
// check now and then. Every client here is a new process started after the check last looked, the
// way a `curl` from a Bash tool is, and one check serves them all, as the server's single one does.

const procReadable = PeerCheck.prototype.available.call({}) === 'on';
const linux = { skip: procReadable ? false : '/proc is not readable here' };

const BURST = 60;
const CLIENT =
  "const s = require('node:net').connect(Number(process.argv[1]), process.argv[2]); s.on('error', () => process.exit(1)); s.on('close', () => process.exit(0)); setTimeout(() => process.exit(0), 20000).unref(); setInterval(() => undefined, 1000);";

const groups: ChildProcess[] = [];
const servers: Server[] = [];
test.after(() => {
  for (const group of groups) {
    try {
      if (group.pid) process.kill(-group.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const server of servers) server.close();
});

/** Starts each client, one after another, and judges its connection as it arrives, as the server judges a request */
async function judgeBurst(check: PeerCheck, mark?: Record<string, string>): Promise<PeerVerdict[]> {
  const { port, accepted, waitFor } = await listen();
  const start = chat(port, mark);
  const verdicts: PeerVerdict[] = [];
  for (let judged = 0; judged < BURST; judged++) {
    start(judged);
    await waitFor(judged + 1);
    const socket = accepted[judged];
    assert.ok(socket?.remoteAddress && socket.remotePort);
    verdicts.push(await check.verdict({ address: socket.remoteAddress, port: socket.remotePort, serverPort: port }));
    socket.destroy();
  }
  return verdicts;
}

async function listen(): Promise<{ port: number; accepted: Socket[]; waitFor(count: number): Promise<void> }> {
  const accepted: Socket[] = [];
  const server = createServer((socket) => accepted.push(socket));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    accepted,
    async waitFor(count) {
      for (const end = Date.now() + 20000; accepted.length < count && Date.now() < end; ) await new Promise((r) => setTimeout(r, 2));
      assert.ok(accepted.length >= count, 'every client connected');
    },
  };
}

/**
 * A long-lived process carrying `mark` (a chat's CLAUDIO_CHAT_ID, or nothing for the person's own
 * shell). Each line written to it starts one client: odd ones keep the variable, even ones drop it
 * and are only the chat's descendants.
 */
function chat(port: number, mark: Record<string, string> = { CLAUDIO_CHAT_ID: 'chat-burst' }): (index: number) => void {
  const script = `
    const { spawn } = require('node:child_process');
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const env = { ...process.env };
      if (Number(line) % 2 === 0) delete env.CLAUDIO_CHAT_ID;
      spawn(process.execPath, ['-e', ${JSON.stringify(CLIENT)}, '${String(port)}', '127.0.0.1'], { env, stdio: 'ignore' });
    });
  `;
  const ambient = { ...process.env };
  delete ambient.CLAUDIO_AGENT_RUN;
  delete ambient.CLAUDIO_CHAT_ID;
  const root = spawn(process.execPath, ['-e', script], { env: { ...ambient, ...mark }, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  groups.push(root);
  return (index) => root.stdin?.write(`${String(index)}\n`);
}

test(`a burst of ${String(BURST)} connections from processes an agent just started is refused every time`, linux, async () => {
  // Each client is started after the check last looked, the way a `curl` from a Bash tool is
  const verdicts = await judgeBurst(new PeerCheck());
  const allowed = verdicts.filter((v) => v === 'not-agent').length;
  assert.equal(allowed, 0, `${String(allowed)} of ${String(BURST)} read as not an agent: ${verdicts.join(' ')}`);
  assert.deepEqual(new Set(verdicts), new Set(['agent']));
});

test(`a burst of ${String(BURST)} connections from the person's own processes is let through every time`, linux, async () => {
  const verdicts = await judgeBurst(new PeerCheck(), {});
  assert.deepEqual(new Set(verdicts), new Set(['not-agent']), verdicts.join(' '));
});
