import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isValidShareKey, preferredRemote, remoteShareKey, shareIdOf, shareKeyFor } from '../src/collab/share-key.ts';
import type { SshExec } from '../src/hosts/remote.ts';

const noSsh: SshExec = () => Promise.reject(new Error('no ssh in tests'));
const sshAliases =
  (table: Record<string, string>): SshExec =>
  async (args) => {
    const host = table[args[args.length - 1] ?? ''];
    if (!host) throw new Error('unknown alias');
    return `user git\nhostname ${host}\nport 22\n`;
  };

function repo(remotes: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'share-key-'));
  execFileSync('git', ['init', '-q', dir]);
  for (const [name, url] of Object.entries(remotes)) execFileSync('git', ['-C', dir, 'remote', 'add', name, url]);
  return dir;
}

test('remote preference: upstream, then origin, then the only remote', () => {
  assert.equal(preferredRemote(['origin', 'upstream']), 'upstream');
  assert.equal(preferredRemote(['fork', 'origin']), 'origin');
  assert.equal(preferredRemote(['mine']), 'mine');
  assert.equal(preferredRemote(['a', 'b']), null);
  assert.equal(preferredRemote([]), null);
});

test('a fork workflow meets on upstream', async () => {
  const mine = repo({ origin: 'git@github.com:alice/api.git', upstream: 'https://github.com/Acme/API.git' });
  const theirs = repo({ origin: 'https://github.com/bob/api', upstream: 'git@github.com:acme/api' });
  try {
    const a = await shareKeyFor(mine, { sshExec: noSsh });
    assert.equal(a, 'github.com/acme/api');
    assert.equal(await shareKeyFor(theirs, { sshExec: noSsh }), a);
    // the person may pick another remote, and a remote that is gone falls back to the default
    assert.equal(await shareKeyFor(mine, { sshExec: noSsh, remote: 'origin' }), 'github.com/alice/api');
    assert.equal(await shareKeyFor(mine, { sshExec: noSsh, remote: 'gone' }), a);
  } finally {
    rmSync(mine, { recursive: true, force: true });
    rmSync(theirs, { recursive: true, force: true });
  }
});

test('an SSH alias resolves to its real host', async () => {
  const ssh = sshAliases({ work: 'GitHub.com', corp: 'git.corp.example' });
  assert.equal(await remoteShareKey('git@work:Acme/API.git', ssh), 'github.com/acme/api');
  assert.equal(await remoteShareKey('git@corp:Acme/API.git', ssh), 'git.corp.example/Acme/API');
  // an alias ssh cannot resolve stays as written
  assert.equal(await remoteShareKey('git@nowhere:acme/api.git', ssh), 'nowhere/acme/api');
  // https is never looked up
  assert.equal(await remoteShareKey('https://work/acme/api', ssh), 'work/acme/api');
});

test('path case folds only on the hosts that ignore it', async () => {
  for (const host of ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'dev.azure.com']) {
    assert.equal(await remoteShareKey(`https://${host.toUpperCase()}/Acme/API.git`, noSsh), `${host}/acme/api`);
  }
  assert.equal(await remoteShareKey('https://Git.Corp.Example/Acme/API.git', noSsh), 'git.corp.example/Acme/API');
  assert.equal(await remoteShareKey('git@ssh.github.com:Acme/API.git', noSsh), 'github.com/acme/api');
  assert.equal(await remoteShareKey('https://oauth2:secret@gitlab.com/G/Sub/App.git', noSsh), 'gitlab.com/g/sub/app');
  assert.equal(await remoteShareKey('/srv/git/app.git', noSsh), null);
});

test('characters outside the key set are folded so the default is always valid', async () => {
  const key = await remoteShareKey('https://[2001:db8::1]/acme/my%20app.git', noSsh);
  assert.equal(key, '2001-db8--1/acme/my-app');
  assert.ok(key && isValidShareKey(key));
});

test('a project inside its repository carries the subpath', async () => {
  const dir = repo({ origin: 'https://github.com/acme/mono.git' });
  try {
    mkdirSync(join(dir, 'packages', 'API'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'web'), { recursive: true });
    const api = await shareKeyFor(join(dir, 'packages', 'API'), { sshExec: noSsh });
    const web = await shareKeyFor(join(dir, 'packages', 'web'), { sshExec: noSsh });
    assert.equal(api, 'github.com/acme/mono#packages/API');
    assert.equal(web, 'github.com/acme/mono#packages/web');
    assert.equal(await shareKeyFor(dir, { sshExec: noSsh }), 'github.com/acme/mono');
    assert.ok(isValidShareKey(api));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two clones of one repository get the same default key', async () => {
  const one = repo({ origin: 'git@github.com:acme/api.git' });
  const two = repo({ origin: 'https://github.com/acme/api' });
  try {
    assert.equal(await shareKeyFor(one, { sshExec: noSsh }), await shareKeyFor(two, { sshExec: noSsh }));
  } finally {
    rmSync(one, { recursive: true, force: true });
    rmSync(two, { recursive: true, force: true });
  }
});

test('no usable remote gives a random local key', async () => {
  const none = repo({});
  const many = repo({ a: 'https://github.com/x/a', b: 'https://github.com/x/b' });
  const path = repo({ origin: '/srv/git/app.git' });
  const plain = mkdtempSync(join(tmpdir(), 'share-key-plain-'));
  try {
    const hex = () => '0123456789abcdef0123456789abcdef';
    for (const dir of [none, many, path, plain, join(plain, 'missing')]) {
      assert.equal(await shareKeyFor(dir, { sshExec: noSsh, randomHex: hex }), `local/${hex()}`);
    }
    const a = await shareKeyFor(none, { sshExec: noSsh });
    const b = await shareKeyFor(none, { sshExec: noSsh });
    assert.match(a, /^local\/[0-9a-f]{32}$/);
    assert.notEqual(a, b);
    assert.ok(isValidShareKey(a));
  } finally {
    for (const dir of [none, many, path, plain]) rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid keys', () => {
  for (const key of ['github.com/acme/api', 'local/0123abcd', 'git.corp.example/Acme/API#packages/web', 'abc', 'x'.repeat(200), 'a.b_c-d/e#clone-2']) {
    assert.ok(isValidShareKey(key), key);
  }
  for (const key of ['', 'ab', 'x'.repeat(201), 'github.com/acme api', 'github.com:22/a', 'a/b?c', 'a/b\n', 'ñandú/x', 'a\\b\\c']) {
    assert.ok(!isValidShareKey(key), JSON.stringify(key));
  }
});

test('shareIdOf is sha256 of the key, 32 hex characters', () => {
  const id = shareIdOf('github.com/acme/api');
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(id, shareIdOf('github.com/acme/api'));
  assert.notEqual(id, shareIdOf('github.com/acme/api#web'));
  assert.equal(shareIdOf('abc'), 'ba7816bf8f01cfea414140de5dae2223');
});
