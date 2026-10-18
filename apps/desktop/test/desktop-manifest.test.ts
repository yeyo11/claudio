import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { keyId } from '@claudio/core/launcher/protocol';
import { debCachePath, debInstallCommand, desktopManifestName, packageFileName, parseDesktopManifest, verifyDownload } from '../src/desktop-manifest.ts';

const root = mkdtempSync(join(tmpdir(), 'claudio-desktop-manifest-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** Throwaway keys: the release key never signs a test */
const release = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');

const DOWNLOADS = 'https://releases.invalid/download';
const hex = (algo: string, bytes: Buffer) => createHash(algo).update(bytes).digest('hex');

function signedRelease(version: string, file: Buffer, { signer = release.privateKey, keyed = false, name = packageFileName(version, 'appimage'), manifestVersion = version } = {}) {
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      version: manifestVersion,
      shellInputs: 'abc',
      minShell: '0.7.0',
      commit: 'x',
      builtAt: '2026-10-18T00:00:00Z',
      files: { [name]: { size: file.length, sha256: hex('sha256', file), sha512: hex('sha512', file) } },
    }),
  );
  const sig = sign(null, manifest, signer).toString('base64');
  return { manifest, sig: keyed ? `${keyId(release.publicKey)} ${sig}\n` : `${sig}\n` };
}

/** A release served from memory: the manifest and its .sig at the paths `verifyDownload` asks for */
function served(version: string, assets: { manifest?: Buffer; sig?: string } | 'offline'): typeof fetch {
  return (async (input: string | URL | Request) => {
    if (assets === 'offline') throw new TypeError('fetch failed');
    const url = String(input);
    const base = `${DOWNLOADS}/v${version}/${desktopManifestName(version)}`;
    if (url === base && assets.manifest) return new Response(assets.manifest);
    if (url === `${base}.sig` && assets.sig) return new Response(assets.sig);
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
}

function download(name: string, bytes: Buffer): string {
  const file = join(root, name);
  writeFileSync(file, bytes);
  return file;
}

const app = Buffer.from('an AppImage, as far as this test is concerned');
const keys = [release.publicKey];

test('a download listed with its size and hashes in a manifest signed by a shell key verifies', async () => {
  const file = download('ok.AppImage', app);
  const r = signedRelease('0.8.0', app);
  const verified = await verifyDownload({ version: '0.8.0', kind: 'appimage', file, keys, running: '0.7.0', fetch: served('0.8.0', r), downloads: DOWNLOADS });
  assert.deepEqual(verified, { ok: true, sha256: hex('sha256', app) });
  // A `.sig` line that names its key, as during a rotation
  const keyed = signedRelease('0.8.0', app, { keyed: true });
  assert.equal((await verifyDownload({ version: '0.8.0', kind: 'appimage', file, keys, running: '0.7.0', fetch: served('0.8.0', keyed), downloads: DOWNLOADS })).ok, true);
});

test('a changed file, another key, a missing manifest or a manifest for another version is refused as a bad signature', async () => {
  const file = download('changed.AppImage', Buffer.from('something else'));
  const opts = { version: '0.8.0', kind: 'appimage' as const, file, keys, running: '0.7.0', downloads: DOWNLOADS };
  const changed = await verifyDownload({ ...opts, fetch: served('0.8.0', signedRelease('0.8.0', app)) });
  assert.equal(!changed.ok && changed.code, 'bad-signature');

  const good = download('good.AppImage', app);
  const other = await verifyDownload({ ...opts, file: good, fetch: served('0.8.0', signedRelease('0.8.0', app, { signer: stranger.privateKey })) });
  assert.equal(!other.ok && other.code, 'bad-signature');
  assert.match(!other.ok ? other.message : '', /not signed by an accepted key/);

  const missing = await verifyDownload({ ...opts, file: good, fetch: served('0.8.0', {}) });
  assert.equal(!missing.ok && missing.code, 'bad-signature');

  const elsewhere = await verifyDownload({ ...opts, file: good, fetch: served('0.8.0', signedRelease('0.8.0', app, { manifestVersion: '0.8.1' })) });
  assert.equal(!elsewhere.ok && elsewhere.code, 'bad-signature');

  const unlisted = await verifyDownload({ ...opts, file: good, fetch: served('0.8.0', signedRelease('0.8.0', app, { name: 'Claudio-0.8.0-amd64.deb' })) });
  assert.match(!unlisted.ok ? unlisted.message : '', /does not list Claudio-0\.8\.0-x86_64\.AppImage/);
});

test('a manifest older than the running shell is a downgrade; the same version only for a switch', async () => {
  const file = download('same.AppImage', app);
  const fetchFn = served('0.7.0', signedRelease('0.7.0', app));
  const opts = { version: '0.7.0', kind: 'appimage' as const, file, keys, fetch: fetchFn, downloads: DOWNLOADS };
  assert.equal((await verifyDownload({ ...opts, running: '0.8.0' })).ok, false);
  assert.equal((await verifyDownload({ ...opts, running: '0.7.0' })).ok, false);
  assert.equal((await verifyDownload({ ...opts, running: '0.7.0', allowSame: true })).ok, true);
});

test('an unreachable release is fetch-failed, not a bad signature', async () => {
  const file = download('offline.AppImage', app);
  const verified = await verifyDownload({ version: '0.8.0', kind: 'appimage', file, keys, running: '0.7.0', fetch: served('0.8.0', 'offline'), downloads: DOWNLOADS });
  assert.equal(!verified.ok && verified.code, 'fetch-failed');
});

test('the manifest parser wants every hash in full', () => {
  assert.equal(typeof parseDesktopManifest(Buffer.from('{')), 'string');
  assert.equal(typeof parseDesktopManifest(Buffer.from(JSON.stringify({ schema: 2 }))), 'string');
  const bad = { schema: 1, version: '0.8.0', minShell: '0.7.0', shellInputs: 'x', files: { a: { size: 1, sha256: 'short', sha512: 'short' } } };
  assert.match(String(parseDesktopManifest(Buffer.from(JSON.stringify(bad)))), /malformed/);
});

const SHA = hex('sha256', app);

test('the .deb command copies to a root-owned path, checks that copy, then hands it to apt, with no -y', () => {
  const command = debInstallCommand('/home/me/.cache/claudio-updater/pending/Claudio-0.8.0-amd64.deb', '0.8.0', SHA);
  assert.equal(
    command,
    `/usr/bin/sudo /usr/bin/install -D -m 0644 -o root -g root -- '/home/me/.cache/claudio-updater/pending/Claudio-0.8.0-amd64.deb' '/var/cache/claudio/claudio_0.8.0_amd64.deb'` +
      ` && echo '${SHA}  /var/cache/claudio/claudio_0.8.0_amd64.deb' | /usr/bin/sha256sum -c -` +
      ` && /usr/bin/sudo /usr/bin/apt install -- '/var/cache/claudio/claudio_0.8.0_amd64.deb'`,
  );
  assert.equal(debCachePath('0.8.0'), '/var/cache/claudio/claudio_0.8.0_amd64.deb');
  assert.doesNotMatch(command, /\s-y\b/);
});

test('a cache path with spaces and a quote stays one argument when the shell reads the command', () => {
  const tricky = "/home/me/My Files/it's here/Claudio-0.8.0-amd64.deb";
  const command = debInstallCommand(tricky, '0.8.0', SHA);
  // The shell reads the first step's arguments back exactly; sudo is swapped for printf so nothing runs
  const first = command.split(' && ')[0]!.replace('/usr/bin/sudo /usr/bin/install', "printf '%s\\n'");
  const out = spawnSync('/bin/sh', ['-c', first], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.stdout.trimEnd().split('\n'), ['-D', '-m', '0644', '-o', 'root', '-g', 'root', '--', tricky, '/var/cache/claudio/claudio_0.8.0_amd64.deb']);
});

test('the command refuses what it cannot quote safely: a newline, a relative path, a version or a hash that is not one', () => {
  assert.throws(() => debInstallCommand('/home/me/a\nrm -rf ~', '0.8.0', SHA));
  assert.throws(() => debInstallCommand('relative.deb', '0.8.0', SHA));
  assert.throws(() => debInstallCommand('/home/me/a.deb', '0.8.0; reboot', SHA));
  assert.throws(() => debInstallCommand('/home/me/a.deb', '0.8.0', 'not-a-hash'));
});
