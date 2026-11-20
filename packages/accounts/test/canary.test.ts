import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canaryState, isCompleteCanary, type CliCanary, type CliCanaryCheckId } from '@claudio/shared';
import { runCanary } from '../src/canary.ts';
import { mcpOAuthKey } from '../src/mcp-oauth-key.ts';

const FAKE = fileURLToPath(new URL('./fake-canary-claude.mjs', import.meta.url));

let work: string;
let SEEN: string;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'canary-test-'));
  SEEN = join(work, 'seen.log');
});
after(() => rmSync(work, { recursive: true, force: true }));

/** A `claude` that is the fake in one mode; the canary gives it no environment but a PATH, so the mode rides in the script */
function claude(mode: string): string {
  const path = join(work, `claude-${mode}`);
  writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} ${mode} ${JSON.stringify(SEEN)} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

const run = (mode: string, extra: { timeoutMs?: number } = {}): Promise<CliCanary> => runCanary({ claude: claude(mode), version: '2.1.999', tmp: work, timeoutMs: 15_000, ...extra });
const check = (result: CliCanary, id: CliCanaryCheckId) => {
  const found = result.checks.find((c) => c.id === id);
  assert.ok(found, `no ${id} check`);
  return found;
};

describe('the CLI canary', () => {
  it('passes every check against a CLI that behaves as 2.1.322 does', async () => {
    const result = await run('ok');
    assert.deepEqual(result.checks.map((c) => `${c.id}:${c.state}`), ['s1:pass', 's2:pass', 's3c:pass', 's6:pass']);
    assert.equal(result.state, 'pass');
    assert.equal(result.version, '2.1.999');
    assert.ok(isCompleteCanary(result));
  });

  it('fails S1 when the CLI replaces the linked state file with a file of its own', async () => {
    const result = await run('replace-state');
    assert.equal(check(result, 's1').state, 'fail');
    assert.match(check(result, 's1').observed, /replaced the linked state file/);
    assert.equal(result.state, 'fail');
    // The others still run: one broken behaviour does not hide another
    assert.equal(check(result, 's2').state, 'pass');
  });

  it('fails S1 when the link stays but the write was lost', async () => {
    assert.match(check(await run('drop-server'), 's1').observed, /does not hold the new server/);
  });

  it('fails S2 naming settings.json when a plugin install replaces its link', async () => {
    const s2 = check(await run('replace-settings'), 's2');
    assert.equal(s2.state, 'fail');
    assert.match(s2.observed, /settings\.json/);
  });

  it('fails S2 naming plugins/ when an install replaces its link', async () => {
    const s2 = check(await run('replace-plugins'), 's2');
    assert.equal(s2.state, 'fail');
    assert.match(s2.observed, /plugins\//);
  });

  it('fails S2 when the links survive but the install is recorded nowhere', async () => {
    assert.match(check(await run('no-record'), 's2').observed, /no install record/);
  });

  it('fails S3c when an untrusted project\'s server connects', async () => {
    const s3c = check(await run('always-trust'), 's3c');
    assert.equal(s3c.state, 'fail');
    assert.match(s3c.observed, /without the account trusting/);
  });

  it('fails S3c when trust no longer makes the server connect', async () => {
    const s3c = check(await run('never-trust'), 's3c');
    assert.equal(s3c.state, 'fail');
    assert.match(s3c.observed, /no longer makes its server connect/);
  });

  it('fails S6 when the CLI no longer finds a copied entry under the computed key', async () => {
    const s6 = check(await run('s6-other-key'), 's6');
    assert.equal(s6.state, 'fail');
    assert.match(s6.observed, /no longer accepted/);
    assert.match(s6.observed, /without the entry the server was failed/);
    assert.equal(check(await run('s6-other-key'), 's3c').state, 'pass');
  });

  it('reports S6 as "error", not "fail", when the server connects with no token at all', async () => {
    assert.equal(check(await run('s6-open'), 's6').state, 'error');
  });

  it('never puts the token the S6 server wants into what it observed', async () => {
    const s6 = check(await run('ok'), 's6');
    assert.equal(s6.state, 'pass');
    assert.doesNotMatch(s6.observed, /[0-9a-f]{32}/);
    assert.match(s6.observed, /with the entry copied under the computed key it was connected/);
  });

  it('computes the key of an MCP OAuth entry as name|sha256 of type, url and headers, cut to 16 hex', () => {
    const url = 'https://mcp.example.com/mcp';
    const hash = createHash('sha256').update(JSON.stringify({ type: 'http', url, headers: {} })).digest('hex').slice(0, 16);
    assert.equal(mcpOAuthKey({ name: 'shipcast', type: 'http', url }), `shipcast|${hash}`);
    assert.equal(mcpOAuthKey({ name: 'shipcast', type: 'http', url, headers: {} }), `shipcast|${hash}`);
    assert.notEqual(mcpOAuthKey({ name: 'shipcast', type: 'http', url, headers: { 'x-a': 'b' } }), `shipcast|${hash}`);
    assert.match(mcpOAuthKey({ name: 'a', type: 'sse', url }), /^a\|[0-9a-f]{16}$/);
  });

  it('reports "error", not "fail", for a server that never settles: that says nothing of the CLI', async () => {
    const s3c = check(await runCanary({ claude: claude('never-settles'), version: 'x', tmp: work, timeoutMs: 15_000, settleMs: 1_500 }), 's3c');
    assert.equal(s3c.state, 'error');
  });

  it('marks the checks a signed-out CLI will not run as needing sign-in, and runs no turn', async () => {
    const result = await run('signed-out');
    assert.equal(check(result, 's1').state, 'needs-sign-in');
    assert.equal(check(result, 's3c').state, 'needs-sign-in');
    assert.equal(result.state, 'needs-sign-in');
  });

  it('reports every check as an error, with the reason, when there is no CLI', async () => {
    const result = await runCanary({ claude: join(work, 'no-such-claude'), version: '1.0.0', tmp: work });
    assert.deepEqual(result.checks.map((c) => c.state), ['error', 'error', 'error', 'error']);
    assert.equal(result.state, 'error');
    assert.match(check(result, 's1').observed, /could not run/);
  });

  it('gives the CLI no credential and no real HOME, and leaves nothing of its own behind', async () => {
    const before = readdirSync(work).filter((n) => n.startsWith('claudio-canary-'));
    rmSync(SEEN, { force: true });
    await runCanary({ claude: claude('ok'), version: 'x', tmp: work, timeoutMs: 15_000, env: { PATH: process.env.PATH, HOME: '/home/someone', ANTHROPIC_API_KEY: 'sk-secret', CLAUDE_CONFIG_DIR: '/home/someone/.claude' } });
    const calls = readFileSync(SEEN, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { key: string | null; home: string; dir: string });
    assert.ok(calls.length > 5);
    for (const c of calls) {
      assert.equal(c.key, null);
      assert.ok(c.home.startsWith(work) && c.dir.startsWith(work), `${c.home} / ${c.dir} escaped the temp dir`);
    }
    assert.deepEqual(readdirSync(work).filter((n) => n.startsWith('claudio-canary-')), before);
  });

  it('judges a result complete only when every check is in it', () => {
    const one: CliCanary = { version: '1', checkedAt: '2026-01-01T00:00:00Z', state: 'pass', checks: [{ id: 's1', state: 'pass', observed: '' }] };
    assert.equal(isCompleteCanary(one), false);
    assert.equal(canaryState([{ id: 's1', state: 'error', observed: '' }, { id: 's2', state: 'fail', observed: '' }]), 'fail');
    assert.equal(canaryState([{ id: 's1', state: 'pass', observed: '' }, { id: 's2', state: 'needs-sign-in', observed: '' }]), 'needs-sign-in');
  });

  // The real CLI, in a temp dir with no credential: skipped where it is not installed (CI)
  const real = (() => {
    try {
      return execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
    } catch {
      return null;
    }
  })();
  it('runs its checks against the installed CLI without leaving its temp dir', { skip: real === null ? 'no claude binary' : false, timeout: 180_000 }, async () => {
    const result = await runCanary({ version: real ?? '', tmp: work });
    assert.deepEqual(result.checks.map((c) => c.id), ['s1', 's2', 's3c', 's6']);
    assert.ok(!result.checks.some((c) => c.state === 'error' && /ENOENT/.test(c.observed)));
    assert.equal(existsSync(join(work, 'claudio-canary-')), false);
  });
});
