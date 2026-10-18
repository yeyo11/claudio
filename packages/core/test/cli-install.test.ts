import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AuthMode } from '@claudio/shared';
import { CliInstallRefusal, CliInstaller } from '../src/updates/cli-install.ts';
import { writeTree } from './bundle-helpers.ts';

// The installer runs only in the Linux x64 container, which is what the package it installs is for
const skip = process.platform !== 'linux' || process.arch !== 'x64';
const PKG = '@anthropic-ai/claude-code-linux-x64';

/** The registry's tarball of the platform package: `package/claude`, here a script that reports `reports` */
function packageTarball(root: string, reports: string): Buffer {
  const tree = join(root, `pkg-${reports}`);
  writeTree(tree, {
    'package/claude': `#!/bin/sh\necho "${reports} (Claude Code)"\n`,
    'package/package.json': '{"scripts":{"postinstall":"touch /tmp/never"}}',
    'package/README.md': '',
  });
  const out = join(root, `pkg-${reports}.tgz`);
  execFileSync('tar', ['-czf', out, '-C', tree, 'package']);
  return readFileSync(out);
}

const integrityOf = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

function installer(options: { reports?: string; integrity?: string; env?: NodeJS.ProcessEnv; mode?: AuthMode } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claudio-cli-install-'));
  const dataDir = join(root, 'data');
  const tarball = packageTarball(root, options.reports ?? '2.1.300');
  const urls: string[] = [];
  let changed = 0;
  const fetchFn = (async (url: string | URL | Request) => {
    urls.push(String(url));
    if (String(url).endsWith(`/${PKG}/2.1.300`)) {
      return Response.json({ name: PKG, version: '2.1.300', dist: { tarball: 'https://registry.test/claude.tgz', integrity: options.integrity ?? integrityOf(tarball) } });
    }
    if (String(url) === 'https://registry.test/claude.tgz') return new Response(new Uint8Array(tarball));
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const cli = new CliInstaller({
    dataDir,
    distribution: 'docker',
    env: options.env ?? {},
    fetch: fetchFn,
    range: '>=2.1 <3',
    pinned: () => '2.1.278',
    current: () => '2.1.278',
    latest: () => '2.1.300',
    security: () => ({ mode: options.mode ?? 'token', readOnly: false }),
    changed: async () => {
      changed += 1;
    },
  });
  return { cli, dataDir, urls, changed: () => changed };
}

function refusal(run: () => unknown): CliInstallRefusal {
  try {
    run();
  } catch (err) {
    assert.ok(err instanceof CliInstallRefusal, String(err));
    return err;
  }
  assert.fail('expected a refusal');
}

test('the platform package is checked, only its binary kept, and current swapped to it', { skip }, async () => {
  const { cli, dataDir, urls, changed } = installer();
  cli.install();
  assert.equal(cli.info(null).install?.state, 'installing');
  await cli.pending;
  const info = cli.info(join(dataDir, 'cli', 'current', 'bin', 'claude'));
  assert.deepEqual(info.install, { state: 'idle', version: '2.1.300', error: null });
  assert.equal(info.source, 'data');
  assert.equal(info.installable, true);
  assert.equal(readlinkSync(join(dataDir, 'cli', 'current')), '2.1.300');
  const binary = join(dataDir, 'cli', '2.1.300', 'bin', 'claude');
  assert.equal(statSync(binary).mode & 0o777, 0o755);
  assert.equal(existsSync(join(dataDir, 'cli', '2.1.300', 'package')), false, 'nothing but the binary');
  assert.equal(urls[0], `https://registry.npmjs.org/${PKG}/2.1.300`);
  assert.equal(changed(), 1);
  assert.equal(cli.source('/home/node/.local/bin/claude'), 'image');
});

test("a tarball that does not match the registry's integrity is discarded", { skip }, async () => {
  const { cli, dataDir } = installer({ integrity: `sha512-${Buffer.alloc(64).toString('base64')}` });
  cli.install('2.1.300');
  await cli.pending;
  assert.deepEqual(cli.info(null).install, { state: 'failed', version: '2.1.300', error: 'integrity' });
  assert.equal(existsSync(join(dataDir, 'cli', 'current')), false);
  assert.equal(existsSync(join(dataDir, 'cli', '2.1.300')), false);
});

test('a binary that does not report the version it was installed as is discarded', { skip }, async () => {
  const { cli, dataDir } = installer({ reports: '2.1.299' });
  cli.install('2.1.300');
  await cli.pending;
  assert.equal(cli.info(null).install?.error, 'version-mismatch');
  assert.equal(existsSync(join(dataDir, 'cli', 'current')), false);
});

test("a version outside the driver's range, or not newer than the pin, is refused before any download", { skip }, () => {
  const { cli, urls } = installer();
  const out = refusal(() => cli.install('3.0.0'));
  assert.equal(out.statusCode, 422);
  assert.equal(out.reason, 'cli.out-of-range');
  const old = refusal(() => cli.install('2.1.278'));
  assert.equal(old.reason, 'cli.not-newer');
  assert.equal(refusal(() => cli.install('2.1.200')).reason, 'cli.not-newer');
  assert.equal(urls.length, 0);
});

test('not offered outside the container or without a token; one install at a time', { skip }, async () => {
  const none = installer({ mode: 'none' });
  assert.equal(none.cli.installable, false);
  assert.equal(refusal(() => none.cli.install()).reason, 'cli.needs-auth');
  assert.equal(none.cli.info(null).install, null);
  const off = installer({ env: { CLAUDIO_SERVER_UPDATE: 'off' } });
  assert.equal(refusal(() => off.cli.install()).reason, 'cli.unsupported');
  const { cli } = installer();
  cli.install();
  assert.equal(refusal(() => cli.install()).reason, 'cli.busy');
  await cli.pending;
});

test("the registry comes from CLAUDIO_CLI_REGISTRY_URL, and going back to the image's version removes the link", { skip }, async () => {
  const { cli, dataDir, urls, changed } = installer({ env: { CLAUDIO_CLI_REGISTRY_URL: 'http://mirror.test/npm/@anthropic-ai/claude-code/latest' } });
  cli.install();
  await cli.pending;
  assert.equal(urls[0], `http://mirror.test/npm/${PKG}/2.1.300`);
  await cli.uninstall();
  assert.equal(existsSync(join(dataDir, 'cli', 'current')), false);
  assert.equal(changed(), 2);
  await assert.rejects(cli.uninstall(), (err: unknown) => err instanceof CliInstallRefusal && err.reason === 'cli.not-installed');
});
