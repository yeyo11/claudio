import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db.ts';
import type { ChatRuntime } from '../src/live-chat.ts';
import { OpenAiConversationStore } from '../src/openai/conversations.ts';
import { fetchImage, isPublicAddress } from '../src/openai/fetch-image.ts';
import { sweepOpenAiChats } from '../src/openai/sweep.ts';
import { turnTokens } from '../src/usage.ts';

// Phase 2's pieces of core (docs/openai-compatible-api.md): a turn's own tokens from the CLI's
// cumulative figures, the sweep that expires API chats, and the image fetcher's refusals.

// ---------- a turn's tokens ----------

test("a turn's tokens are the growth of the process's cumulative counts since its previous result", () => {
  const first = [{ model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 }];
  assert.deepEqual(turnTokens([], first), { input: 10, output: 5, cacheRead: 100, cacheCreation: 20, total: 135 });
  const second = [
    { model: 'claude-sonnet-5-5', inputTokens: 25, outputTokens: 9, cacheReadInputTokens: 300, cacheCreationInputTokens: 20 },
    // A model the turn used for the first time (a subagent's) counts whole
    { model: 'claude-haiku-5-5', inputTokens: 3, outputTokens: 1 },
  ];
  assert.deepEqual(turnTokens(first, second), { input: 18, output: 5, cacheRead: 200, cacheCreation: 0, total: 223 });
});

test('a count that went down started again, and a result with no counts has no usage', () => {
  const before = [{ model: 'm', inputTokens: 50, outputTokens: 50 }];
  assert.deepEqual(turnTokens(before, [{ model: 'm', inputTokens: 7, outputTokens: 2 }]), { input: 7, output: 2, cacheRead: 0, cacheCreation: 0, total: 9 });
  assert.equal(turnTokens(before, []), null);
});

// ---------- the sweep ----------

function store(now: () => string): OpenAiConversationStore {
  const sql = new DatabaseSync(':memory:');
  migrate(sql);
  return new OpenAiConversationStore(sql, now);
}

/** No stored response leads anywhere: these sweeps are about the conversation keys */
const noResponses = { expire: () => 0, hasChat: () => false };

const runtime = (id: string, fields: Partial<ChatRuntime>): ChatRuntime => ({ id, origin: 'api', pid: null, updatedAt: '2026-01-01T00:00:00.000Z', ...fields }) as ChatRuntime;

test('the sweep drops stale keys and deletes only the idle api chats left with none', async () => {
  let at = '2026-01-01T00:00:00.000Z';
  const conversations = store(() => at);
  conversations.remember('old', 'stale-api', null);
  conversations.remember('old-person', 'person', null);
  at = '2026-01-20T00:00:00.000Z';
  conversations.remember('fresh', 'fresh-api', null);
  const chats = [
    runtime('stale-api', {}),
    runtime('fresh-api', {}),
    runtime('person', { origin: 'claudio' }),
    runtime('running-api', { pid: 123 }),
    runtime('recent-api', { updatedAt: '2026-01-19T00:00:00.000Z' }),
    runtime('keyless-api', {}),
  ];
  const removed: string[] = [];
  const now = Date.parse('2026-01-21T00:00:00.000Z');
  const sweep = await sweepOpenAiChats({ conversations, responses: noResponses, runtime: { list: () => chats }, remove: async (id) => void removed.push(id) }, now, 7 * 24 * 3600 * 1000);
  assert.equal(sweep.keys, 2);
  assert.deepEqual(removed.sort(), ['keyless-api', 'stale-api']);
  assert.deepEqual(sweep.chats.sort(), ['keyless-api', 'stale-api']);
  assert.ok(conversations.find('fresh'));
  assert.equal(conversations.hasChat('person'), false, "a person's chat loses its keys but is not deleted");
});

test('a chat that cannot be removed is left for the next sweep', async () => {
  const conversations = store(() => '2026-01-01T00:00:00.000Z');
  const sweep = await sweepOpenAiChats(
    { conversations, responses: noResponses, runtime: { list: () => [runtime('busy', {})] }, remove: () => Promise.reject(new Error('Something is running on this chat')) },
    Date.parse('2026-02-01T00:00:00.000Z'),
  );
  assert.deepEqual(sweep.chats, []);
});

// ---------- the image fetcher ----------

test('only public addresses are fetched from', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', 'ff02::1', 'not-an-ip']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}

const onlyLoopback = { allowAddress: (address: string) => address === '127.0.0.1' };

test('a loopback URL or name is refused before anything is sent', async () => {
  let hits = 0;
  const { server, url } = await serve((_req, res) => {
    hits++;
    res.end('x');
  });
  try {
    await assert.rejects(fetchImage(`${url}/a.png`, 1000), /does not fetch from/);
    await assert.rejects(fetchImage(url.replace('127.0.0.1', 'localhost'), 1000), /does not fetch from/);
    await assert.rejects(fetchImage('http://[::1]/a.png', 1000), /does not fetch from/);
    await assert.rejects(fetchImage('file:///etc/passwd', 1000), /only http and https/);
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});

test('a redirect to a private address is refused at the redirect', async () => {
  const { server, url } = await serve((req, res) => {
    if (req.url === '/hop') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
      return;
    }
    res.end('ok');
  });
  try {
    await assert.rejects(fetchImage(`${url}/hop`, 1000, onlyLoopback), /169\.254\.169\.254 is an address/);
  } finally {
    server.close();
  }
});

test('the fetcher stops past the size cap and gives up after its timeout', async () => {
  const { server, url } = await serve((req, res) => {
    if (req.url === '/big') {
      res.write(Buffer.alloc(800));
      res.end(Buffer.alloc(800));
      return;
    }
    if (req.url === '/declared') {
      res.writeHead(200, { 'content-length': '5000' });
      res.end(Buffer.alloc(5000));
      return;
    }
    if (req.url === '/slow') return; // never answers
    res.writeHead(200, { 'content-type': 'image/png; charset=binary' });
    res.end(Buffer.from('tiny'));
  });
  try {
    await assert.rejects(fetchImage(`${url}/big`, 1000, onlyLoopback), /more than 1000 bytes/);
    await assert.rejects(fetchImage(`${url}/declared`, 1000, onlyLoopback), /5000 bytes/);
    await assert.rejects(fetchImage(`${url}/slow`, 1000, { ...onlyLoopback, timeoutMs: 200 }), /timed out/);
    const ok = await fetchImage(`${url}/fine`, 1000, onlyLoopback);
    assert.equal(ok.bytes.toString(), 'tiny');
    assert.equal(ok.mediaType, 'image/png');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
