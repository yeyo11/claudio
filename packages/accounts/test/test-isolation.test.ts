import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AccountStore, envFor, login } from '../src/index.ts';

// B15 (docs/reports/test-writes-real-dirs.md): the unit tests' fake CLI signed in and counted its
// probes inside two of the owner's real account dirs, because a test run from a chat Claudio had
// started inherited that chat's CLAUDE_CONFIG_DIR and the default account kept it. These tests fail
// if a test process can again resolve an account directory outside its own temp dir.
const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, 'fake-claude.mjs');

const inside = (parent: string, path: string): boolean => {
  const rel = relative(resolve(parent), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'claudio-isolation-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('a test process cannot reach the real account dirs', () => {
  it('inherits no directory selector from outside its temp dir', () => {
    for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDIO_DATA_DIR', 'CLAUDIO_WORKSPACE_DIR']) {
      const value = process.env[name];
      if (value === undefined) continue;
      assert.ok(inside(tmpdir(), value), `${name}=${value} is outside ${tmpdir()}: scripts/test-tmp-preload.mjs should have dropped it (run the tests through scripts/test-tmp.mjs)`);
    }
  });

  it('gives the default account its own dir even when the base environment names another', () => {
    const decoy = join(root, 'decoy-account');
    const own = join(root, 'own-default');
    const env = envFor({ id: 'default', kind: 'login', dir: own }, { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: decoy });
    assert.equal(env.CLAUDE_CONFIG_DIR, own);
  });

  it('keeps the base variable of the default account when it names the same dir', () => {
    const own = join(root, 'same-default');
    const env = envFor({ id: 'default', kind: 'login', dir: own }, { CLAUDE_CONFIG_DIR: `${own}/` });
    assert.equal(env.CLAUDE_CONFIG_DIR, `${own}/`);
  });

  it('signs the default account in and counts its probes in the store\'s dir, never in an inherited one', async () => {
    const decoy = join(root, 'inherited-real-account');
    const defaultDir = join(root, 'store-default');
    const dataDir = join(root, 'store-data');
    mkdirSync(decoy, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    // The environment of a chat on a non-default account, as a test process would inherit it
    const env = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: decoy };
    const store = new AccountStore({ dataDir, defaultDir, claude: FAKE, env });

    await store.models('default');
    const session = login(store.ref('default'), { claude: FAKE, env });
    await session.url;
    session.submitCode('good-code');
    assert.equal(await session.done, 0);

    assert.deepEqual(readdirSync(decoy), [], 'nothing was written to the inherited dir');
    assert.ok(existsSync(join(defaultDir, 'initialize-count')));
    assert.ok(existsSync(join(defaultDir, 'fake-login.json')));
  });

  it('builds every AccountStore of the test suites with a data dir and a default dir of its own', () => {
    // A store without them resolves ~/.claude and the real data dir, the other road to B15
    const roots = [join(HERE, '..', '..', 'core', 'test'), join(HERE, '..', '..', '..', 'apps', 'api', 'test'), HERE];
    const bare: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'fixtures') scan(path);
        } else if (entry.name.endsWith('.test.ts') && entry.name !== 'test-isolation.test.ts') {
          const text = readFileSync(path, 'utf8');
          for (const match of text.matchAll(/new AccountStore\(\{([\s\S]*?)\}\)/g)) {
            const body = match[1] ?? '';
            if (!/\bdataDir\b/.test(body) || !/\bdefaultDir\b/.test(body)) bare.push(`${relative(HERE, path)}: new AccountStore({${body.trim().slice(0, 60)}…`);
          }
        }
      }
    };
    for (const dir of roots) if (existsSync(dir)) scan(dir);
    assert.deepEqual(bare, []);
  });
});
