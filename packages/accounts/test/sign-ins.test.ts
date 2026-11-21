import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpOAuthKey } from '../src/mcp-oauth-key.ts';
import { AccountStore } from '../src/store.ts';
import { NEEDS_AUTH_CACHE, SIGN_INS_RECORD, SignInReconciler, withMcpOAuth, type SignInReconcilerOptions } from '../src/sign-ins.ts';

const FAKE_CANARY = fileURLToPath(new URL('./fake-canary-claude.mjs', import.meta.url));

let work: string;
let n = 0;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'sign-ins-test-'));
});
after(() => rmSync(work, { recursive: true, force: true }));

/** A login of the account's own, written with spacing the CLI may use, so that "kept" means every byte */
const LOGIN = '{\n  "claudeAiOauth": {"accessToken":"sk-ant-oat-own","refreshToken":"sk-ant-ort-own","expiresAt":1790000000000,"scopes":["user:inference"]},\n  "other": 1\n}\n';

const keyOf = (name: string): string => mcpOAuthKey({ name, type: 'http', url: `https://${name}.example/mcp` });

/** An `mcpOAuth` entry as the CLI writes it; `refresh` and `expiresAt` only when the server gave them */
const entry = (name: string, access: string | null, refresh?: string, expiresAt?: number): Record<string, unknown> => ({
  serverName: name,
  serverUrl: `https://${name}.example/mcp`,
  accessToken: access ?? '',
  ...(refresh !== undefined ? { refreshToken: refresh } : {}),
  ...(expiresAt !== undefined ? { expiresAt } : {}),
  discoveryState: { authorizationServerUrl: `https://${name}.example` },
});

interface World {
  def: string;
  data: string;
  say: string[];
  live: Set<string>;
  canaryFailed: { value: boolean };
  account(name: string, text?: string): string;
  setDefault(entries: Record<string, Record<string, unknown>>, login?: boolean): void;
  setAccount(dir: string, entries: Record<string, Record<string, unknown>>): void;
  mcp(dir: string): Record<string, Record<string, unknown>>;
  reconciler(targets: string[], extra?: Partial<SignInReconcilerOptions>): SignInReconciler;
}

function world(): World {
  const root = join(work, `w${(n += 1)}`);
  const def = join(root, 'default');
  const data = join(root, 'data');
  mkdirSync(def, { recursive: true });
  mkdirSync(data, { recursive: true });
  const say: string[] = [];
  const live = new Set<string>();
  const canaryFailed = { value: false };
  const credentials = (dir: string): string => join(dir, '.credentials.json');
  const read = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(credentials(dir), 'utf8')) as Record<string, unknown>;
  return {
    def,
    data,
    say,
    live,
    canaryFailed,
    account(name, text = LOGIN) {
      const dir = join(root, 'accounts', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(credentials(dir), text, { mode: 0o600 });
      return dir;
    },
    setDefault(entries, login = true) {
      writeFileSync(credentials(def), JSON.stringify({ ...(login ? { claudeAiOauth: { accessToken: 'sk-ant-oat-default', refreshToken: 'sk-ant-ort-default' } } : {}), mcpOAuth: entries }), { mode: 0o600 });
    },
    setAccount(dir, entries) {
      const doc = existsSync(credentials(dir)) ? read(dir) : {};
      writeFileSync(credentials(dir), JSON.stringify({ ...doc, mcpOAuth: entries }), { mode: 0o600 });
    },
    mcp: (dir) => (read(dir).mcpOAuth ?? {}) as Record<string, Record<string, unknown>>,
    reconciler(targets, extra = {}) {
      const r = new SignInReconciler({
        defaultDir: def,
        stateFile: join(data, 'account-sign-ins.json'),
        targets: () => targets.map((dir) => ({ id: dir.split('/').pop() ?? dir, dir })),
        idle: (id) => !live.has(id),
        stopped: () => canaryFailed.value,
        log: (line) => say.push(line),
        debounceMs: 10,
        retryMs: 60_000,
        ...extra,
      });
      r.start();
      return r;
    },
  };
}

const tokensIn = (lines: string[]): string[] => lines.filter((l) => /sk-|tok-|rt-/.test(l));

describe('MCP sign-ins of shared accounts', () => {
  let live: SignInReconciler | null = null;
  afterEach(() => {
    live?.close();
    live = null;
  });

  it('copies an entry with no refresh token, keeps the login byte for byte, writes 0600, records the copy and reads the default only', () => {
    const w = world();
    const acc = w.account('acc-a');
    w.setDefault({ [keyOf('linear')]: entry('linear', 'tok-linear') });
    const defaultBefore = readFileSync(join(w.def, '.credentials.json'), 'utf8');
    const defaultMtime = statSync(join(w.def, '.credentials.json')).mtimeMs;
    live = w.reconciler([acc]);
    assert.deepEqual(live.diff(acc), { missing: ['linear'], ownOnly: [], rotating: [] }, 'served before the copy');
    assert.equal(live.beforeSpawn({ id: 'acc-a', dir: acc }), 'done');

    const text = readFileSync(join(acc, '.credentials.json'), 'utf8');
    assert.ok(text.startsWith('{\n  "claudeAiOauth": {"accessToken":"sk-ant-oat-own","refreshToken":"sk-ant-ort-own","expiresAt":1790000000000,"scopes":["user:inference"]},\n  "other": 1'), 'the login is left exactly where it was');
    assert.deepEqual(w.mcp(acc)[keyOf('linear')], entry('linear', 'tok-linear'));
    assert.equal(statSync(join(acc, '.credentials.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(acc, SIGN_INS_RECORD)).mode & 0o777, 0o600);
    const record = JSON.parse(readFileSync(join(acc, SIGN_INS_RECORD), 'utf8')) as { copied: Record<string, { a: string }> };
    assert.deepEqual(Object.keys(record.copied), [keyOf('linear')]);
    assert.doesNotMatch(readFileSync(join(acc, SIGN_INS_RECORD), 'utf8'), /tok-linear/, 'the record holds a hash, never the token');
    assert.equal(readFileSync(join(w.def, '.credentials.json'), 'utf8'), defaultBefore, "the default's file is only read");
    assert.equal(statSync(join(w.def, '.credentials.json')).mtimeMs, defaultMtime);
    assert.deepEqual(live.diff(acc), { missing: [], ownOnly: [], rotating: [] });
    assert.equal(live.beforeSpawn({ id: 'acc-a', dir: acc }), 'noop', 'a second pass finds nothing to do');
    assert.deepEqual(tokensIn(w.say), [], 'no token reaches the log');
  });

  it("never copies the CLI's emptied entry, and replaces the account's emptied one", () => {
    const w = world();
    const acc = w.account('acc-a');
    w.setDefault({ [keyOf('stub')]: entry('stub', null), [keyOf('notion')]: entry('notion', 'tok-notion') });
    w.setAccount(acc, { [keyOf('notion')]: entry('notion', null) });
    live = w.reconciler([acc]);
    assert.equal(live.beforeSpawn({ id: 'acc-a', dir: acc }), 'done');
    const mcp = w.mcp(acc);
    assert.equal(mcp[keyOf('stub')], undefined, 'a stub is never copied');
    assert.equal(mcp[keyOf('notion')]?.accessToken, 'tok-notion');
  });

  it('copies a newer entry by expiresAt and leaves a newer one of the account', () => {
    const w = world();
    const acc = w.account('acc-a');
    const other = w.account('acc-b');
    w.setDefault({ [keyOf('gh')]: entry('gh', 'tok-gh-new', undefined, 2_000) });
    w.setAccount(acc, { [keyOf('gh')]: entry('gh', 'tok-gh-old', undefined, 1_000) });
    w.setAccount(other, { [keyOf('gh')]: entry('gh', 'tok-gh-own', undefined, 3_000) });
    live = w.reconciler([acc, other]);
    live.run();
    assert.equal(w.mcp(acc)[keyOf('gh')]?.accessToken, 'tok-gh-new');
    assert.equal(w.mcp(other)[keyOf('gh')]?.accessToken, 'tok-gh-own');
  });

  it('copies an entry with a refresh token only once the server was seen to keep it on a refresh', () => {
    const w = world();
    const acc = w.account('acc-a');
    w.setDefault({ [keyOf('stripe')]: entry('stripe', 'tok-a0', 'rt-0', 1_000) });
    live = w.reconciler([acc]);
    live.run();
    assert.equal(w.mcp(acc)[keyOf('stripe')], undefined, 'not copied while the server is not known');
    assert.deepEqual(live.diff(acc), { missing: [], ownOnly: [], rotating: ['stripe'] });
    assert.doesNotMatch(readFileSync(join(w.data, 'account-sign-ins.json'), 'utf8'), /rt-0|tok-a0/, 'what is learned holds hashes only');

    // The default's CLI refreshed: a new access token, the same refresh token
    w.setDefault({ [keyOf('stripe')]: entry('stripe', 'tok-a1', 'rt-0', 2_000) });
    live.run();
    assert.equal(live.rotation()[keyOf('stripe')], 'stable');
    assert.equal(w.mcp(acc)[keyOf('stripe')]?.refreshToken, 'rt-0');
    assert.equal(w.mcp(acc)[keyOf('stripe')]?.accessToken, 'tok-a1');
    assert.deepEqual(live.diff(acc), { missing: [], ownOnly: [], rotating: [] });

    // What was learned outlives the reconciler
    live.close();
    live = w.reconciler([acc]);
    assert.equal(live.rotation()[keyOf('stripe')], 'stable');
  });

  it('never copies a server whose refresh token changed, and takes back its untouched copies', () => {
    const w = world();
    const acc = w.account('acc-a');
    w.setDefault({ [keyOf('atlassian')]: entry('atlassian', 'tok-a0', 'rt-0', 1_000) });
    live = w.reconciler([acc]);
    live.run();
    w.setDefault({ [keyOf('atlassian')]: entry('atlassian', 'tok-a1', 'rt-0', 2_000) });
    live.run();
    assert.equal(w.mcp(acc)[keyOf('atlassian')]?.accessToken, 'tok-a1', 'copied while it looked stable');

    // The next refresh rotated it: the copy holds a grant a reuse would revoke for every account
    w.setDefault({ [keyOf('atlassian')]: entry('atlassian', 'tok-a2', 'rt-1', 3_000) });
    live.run();
    assert.equal(live.rotation()[keyOf('atlassian')], 'rotating');
    assert.equal(w.mcp(acc)[keyOf('atlassian')], undefined, 'the stale copy is removed');
    assert.deepEqual(live.diff(acc), { missing: [], ownOnly: [], rotating: ['atlassian'] });
    w.setDefault({ [keyOf('atlassian')]: entry('atlassian', 'tok-a3', 'rt-1', 4_000) });
    live.run();
    assert.equal(live.rotation()[keyOf('atlassian')], 'rotating', 'rotating is never undone');
    assert.equal(w.mcp(acc)[keyOf('atlassian')], undefined);

    // Signed in on the account itself, it is the account's own and stays
    w.setAccount(acc, { [keyOf('atlassian')]: entry('atlassian', 'tok-own', 'rt-own', 5_000) });
    live.run();
    assert.equal(w.mcp(acc)[keyOf('atlassian')]?.accessToken, 'tok-own');
    assert.deepEqual(live.diff(acc), { missing: [], ownOnly: [], rotating: [] });
  });

  it("learns rotation from a shared account's own CLI too, not from what Claudio wrote", () => {
    const w = world();
    const acc = w.account('acc-a');
    w.setDefault({ [keyOf('ctx')]: entry('ctx', 'tok-0', 'rt-0', 1_000) });
    w.setAccount(acc, { [keyOf('ctx')]: entry('ctx', 'tok-own-0', 'rt-own', 1_000) });
    live = w.reconciler([acc]);
    live.run();
    w.setAccount(acc, { [keyOf('ctx')]: entry('ctx', 'tok-own-1', 'rt-own-1', 2_000) });
    live.run();
    assert.equal(live.rotation()[keyOf('ctx')], 'rotating');
  });

  it('removes only the copies whose source dropped them, never an entry of the account', () => {
    const w = world();
    const acc = w.account('acc-a');
    w.setDefault({ [keyOf('linear')]: entry('linear', 'tok-l'), [keyOf('figma')]: entry('figma', 'tok-f') });
    w.setAccount(acc, { [keyOf('umami')]: entry('umami', 'tok-own') });
    live = w.reconciler([acc]);
    live.run();
    assert.deepEqual(Object.keys(w.mcp(acc)).sort(), [keyOf('figma'), keyOf('linear'), keyOf('umami')].sort());
    assert.deepEqual(live.diff(acc), { missing: [], ownOnly: ['umami'], rotating: [] });

    // The person signed in to figma on the account: it is theirs now
    const mine = w.mcp(acc);
    mine[keyOf('figma')] = entry('figma', 'tok-f-own');
    w.setAccount(acc, mine);
    w.setDefault({});
    live.run();
    const after = w.mcp(acc);
    assert.equal(after[keyOf('linear')], undefined, "Claudio's copy goes with the source");
    assert.equal(after[keyOf('figma')]?.accessToken, 'tok-f-own');
    assert.equal(after[keyOf('umami')]?.accessToken, 'tok-own');
    assert.deepEqual(live.diff(acc), { missing: [], ownOnly: ['figma', 'umami'], rotating: [] });
    const record = JSON.parse(readFileSync(join(acc, SIGN_INS_RECORD), 'utf8')) as { copied: Record<string, unknown> };
    assert.deepEqual(record.copied, {});
  });

  it('defers an account with a live chat and copies once it is idle', () => {
    const w = world();
    const acc = w.account('acc-a');
    w.setDefault({ [keyOf('linear')]: entry('linear', 'tok-l') });
    w.live.add('acc-a');
    live = w.reconciler([acc]);
    const before = readFileSync(join(acc, '.credentials.json'), 'utf8');
    assert.equal(live.beforeSpawn({ id: 'acc-a', dir: acc }), 'deferred');
    assert.equal(readFileSync(join(acc, '.credentials.json'), 'utf8'), before, 'nothing written under a running CLI');
    assert.deepEqual(live.diff(acc).missing, ['linear']);
    assert.ok(w.say.some((l) => /live chat/.test(l)));
    w.live.delete('acc-a');
    live.run();
    assert.equal(w.mcp(acc)[keyOf('linear')]?.accessToken, 'tok-l');
  });

  it("stops every copy while the canary's s6 check fails", () => {
    const w = world();
    const acc = w.account('acc-a');
    w.setDefault({ [keyOf('linear')]: entry('linear', 'tok-l') });
    w.canaryFailed.value = true;
    live = w.reconciler([acc]);
    assert.equal(live.beforeSpawn({ id: 'acc-a', dir: acc }), 'stopped');
    assert.equal(readFileSync(join(acc, '.credentials.json'), 'utf8'), LOGIN);
    assert.deepEqual(live.diff(acc).missing, ['linear']);
    w.canaryFailed.value = false;
    assert.equal(live.beforeSpawn({ id: 'acc-a', dir: acc }), 'done');
  });

  it("removes the copied server's line from the account's auth-failure cache and keeps the others", () => {
    const w = world();
    const acc = w.account('acc-a');
    const bare = w.account('acc-b');
    w.setDefault({ [keyOf('linear')]: entry('linear', 'tok-l') });
    writeFileSync(join(acc, NEEDS_AUTH_CACHE), JSON.stringify({ linear: { timestamp: Date.now() }, other: { timestamp: 1 } }));
    // Set after the write: the umask would take bits off a mode given to it
    chmodSync(join(acc, NEEDS_AUTH_CACHE), 0o644);
    live = w.reconciler([acc, bare]);
    live.run();
    assert.deepEqual(JSON.parse(readFileSync(join(acc, NEEDS_AUTH_CACHE), 'utf8')), { other: { timestamp: 1 } });
    assert.equal(statSync(join(acc, NEEDS_AUTH_CACHE)).mode & 0o777, 0o644, 'its mode is kept');
    assert.ok(!existsSync(join(bare, NEEDS_AUTH_CACHE)), 'no file, nothing made');
  });

  it("creates the file for an account without one, and leaves a linked credentials file alone", () => {
    const w = world();
    const keyAccount = join(work, `w${n}`, 'accounts', 'acc-key');
    mkdirSync(keyAccount, { recursive: true });
    const linked = join(work, `w${n}`, 'accounts', 'acc-linked');
    mkdirSync(linked, { recursive: true });
    symlinkSync(join(w.def, '.credentials.json'), join(linked, '.credentials.json'));
    w.setDefault({ [keyOf('linear')]: entry('linear', 'tok-l') });
    const defaultBefore = readFileSync(join(w.def, '.credentials.json'), 'utf8');
    live = w.reconciler([keyAccount, linked]);
    live.run();
    assert.equal(w.mcp(keyAccount)[keyOf('linear')]?.accessToken, 'tok-l');
    assert.equal(statSync(join(keyAccount, '.credentials.json')).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(w.def, '.credentials.json'), 'utf8'), defaultBefore, "a link to the default's file is never written through");
    assert.ok(w.say.some((l) => /acc-linked.*link/.test(l)));
  });

  it('does nothing until started: CLAUDIO_ACCOUNT_SIGN_INS=off and the test preload', () => {
    assert.equal((globalThis as Record<symbol, unknown>)[Symbol.for('claudio.accountSignInsOff')], true, 'the preload switches it off for every test Core');
    const w = world();
    const acc = w.account('acc-a');
    w.setDefault({ [keyOf('linear')]: entry('linear', 'tok-l') });
    const r = new SignInReconciler({ defaultDir: w.def, stateFile: join(w.data, 's.json'), targets: () => [{ id: 'acc-a', dir: acc }], idle: () => true, stopped: () => false, log: () => undefined });
    assert.equal(r.beforeSpawn({ id: 'acc-a', dir: acc }), 'skipped');
    r.run();
    r.close();
    assert.equal(readFileSync(join(acc, '.credentials.json'), 'utf8'), LOGIN);
  });

  it('touches no real dir: every path it wrote is under the test tmp', () => {
    const w = world();
    const acc = w.account('acc-a');
    w.setDefault({ [keyOf('linear')]: entry('linear', 'tok-l') });
    live = w.reconciler([acc]);
    live.run();
    const root = resolve(tmpdir()) + sep;
    for (const path of [w.def, acc, w.data]) assert.ok(resolve(path).startsWith(root));
    for (const real of [join(homedir(), '.claude'), join(homedir(), '.config', 'Claudio')]) assert.ok(!resolve(w.def).startsWith(real) && !resolve(acc).startsWith(real));
  });
});

describe('the credentials text', () => {
  it('replaces only the value of mcpOAuth, and appends it when absent', () => {
    assert.equal(withMcpOAuth('{"a":{"b":"}\\""},"mcpOAuth":{"x":1},"c":[1,{"d":2}]}', { y: 2 }), '{"a":{"b":"}\\""},"mcpOAuth":{"y":2},"c":[1,{"d":2}]}');
    assert.equal(withMcpOAuth('{ "claudeAiOauth" : { "k" : "v" } }\n', { y: 2 }), '{ "claudeAiOauth" : { "k" : "v" } ,"mcpOAuth":{"y":2}}\n');
    assert.equal(withMcpOAuth('{}', {}), '{"mcpOAuth":{}}');
    assert.equal(withMcpOAuth(null, { y: 2 }), '{"mcpOAuth":{"y":2}}');
  });
});

describe('the store before a run', () => {
  let live: SignInReconciler | null = null;
  afterEach(() => {
    live?.close();
    live = null;
  });

  it('reconciles a shared account in ref, and serves its sign-ins on the config', async () => {
    const w = world();
    w.setDefault({ [keyOf('linear')]: entry('linear', 'tok-l') });
    let reconciler: SignInReconciler | null = null;
    const store = new AccountStore({
      dataDir: w.data,
      defaultDir: w.def,
      claude: '/nonexistent',
      env: { PATH: process.env.PATH },
      log: () => undefined,
      beforeRun: (account) => void reconciler?.beforeSpawn(account),
      signInsOf: (dir) => reconciler?.diff(dir) ?? { missing: [], ownOnly: [], rotating: [] },
    });
    reconciler = new SignInReconciler({ defaultDir: w.def, stateFile: join(w.data, 's.json'), targets: () => store.pluginTargets(), idle: () => true, stopped: () => false, log: () => undefined });
    live = reconciler;
    const a = await store.add({ kind: 'login' });
    const dir = join(w.data, 'accounts', a.id);
    assert.deepEqual(store.configOf(a.id)?.signIns.missing, ['linear'], 'served from the files');
    store.ref(a.id);
    assert.ok(!existsSync(join(dir, '.credentials.json')) || !readFileSync(join(dir, '.credentials.json'), 'utf8').includes('tok-l'), 'nothing copied before the reconciler starts');
    reconciler.start();
    store.ref(a.id);
    assert.equal((JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')) as { mcpOAuth: Record<string, { accessToken: string }> }).mcpOAuth[keyOf('linear')]?.accessToken, 'tok-l');
    assert.deepEqual(store.configOf(a.id)?.signIns, { missing: [], ownOnly: [], rotating: [] });
  });
});

describe('a copy the CLI accepts', () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server?.closeAllConnections();
    server = null;
  });

  it("the fake CLI connects to a bearer-only server with the entry Claudio copied, and not without it", async () => {
    const token = randomBytes(16).toString('hex');
    server = createServer((req, res) => {
      res.statusCode = req.headers.authorization === `Bearer ${token}` ? 200 : 401;
      res.end('{}');
    });
    const port = await new Promise<number>((done) => server?.listen(0, '127.0.0.1', () => done((server?.address() as { port: number }).port)));
    const url = `http://127.0.0.1:${port}/mcp`;
    const name = 'canary-oauth';
    const w = world();
    const home = join(work, `w${n}`, 'home');
    mkdirSync(home, { recursive: true });
    const acc = w.account('acc-a');
    for (const dir of [w.def, acc]) writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { [name]: { type: 'http', url } } }));
    w.setDefault({ [mcpOAuthKey({ name, type: 'http', url })]: { serverName: name, serverUrl: url, accessToken: token } });

    const status = async (dir: string): Promise<string> => {
      const seen = join(work, `w${n}`, 'seen.log');
      const child = spawn(process.execPath, [FAKE_CANARY, 'normal', seen, '--input-format', 'stream-json'], { env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: dir }, cwd: home, stdio: ['pipe', 'pipe', 'inherit'] });
      let out = '';
      const answers: Record<string, unknown>[] = [];
      const wait = new Promise<void>((done) => {
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          for (let nl = out.indexOf('\n'); nl !== -1; nl = out.indexOf('\n')) {
            answers.push(JSON.parse(out.slice(0, nl)) as Record<string, unknown>);
            out = out.slice(nl + 1);
            if (answers.length === 2) done();
          }
        });
      });
      const ask = (id: string) => child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'mcp_status' } })}\n`);
      ask('1');
      ask('2');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
      await wait;
      clearTimeout(timeout);
      child.kill('SIGTERM');
      const last = answers[1] as { response: { response: { mcpServers: { status: string }[] } } };
      return last.response.response.mcpServers[0]?.status ?? 'none';
    };

    assert.equal(await status(acc), 'failed', 'without the entry the server refuses the account');
    const live = w.reconciler([acc]);
    try {
      assert.equal(live.beforeSpawn({ id: 'acc-a', dir: acc }), 'done');
    } finally {
      live.close();
    }
    assert.equal(await status(acc), 'connected', 'the copy is used under the key the CLI computes');
  });
});
