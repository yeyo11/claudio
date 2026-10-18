// The desktop manifest (docs/plans/unified-updates.md, D7): `claudio-desktop-<v>-linux-x64.json` and its
// `.sig`, attached to every release, list the AppImage's and the `.deb`'s sizes, sha256 and sha512,
// signed with the same Ed25519 key as the payload. electron-updater only checks a download against
// the sha512 in `latest-linux.yml`, which whoever serves the feed also writes; this checks it against
// a signature made in CI with a key the shell carries in its read-only resources, before an
// AppImage is installed, before the `.deb` install command is shown, and before a switch.
import { createHash, type KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { VERSION, compareVersions, verifyManifest } from '@claudio/core/launcher/protocol';

/** Where a release's assets are; electron-updater's GitHub feed reads the same release */
export const RELEASE_DOWNLOADS = 'https://github.com/yeyo11/claudio/releases/download';

export type ShellPackage = 'appimage' | 'deb';

/** electron-builder's `artifactName` (`Claudio-${version}-${arch}.${ext}`) for each package */
export const packageFileName = (version: string, kind: ShellPackage): string =>
  kind === 'appimage' ? `Claudio-${version}-x86_64.AppImage` : `Claudio-${version}-amd64.deb`;

export const desktopManifestName = (version: string): string => `claudio-desktop-${version}-linux-x64.json`;

export interface DesktopManifest {
  version: string;
  shellInputs: string;
  minShell: string;
  files: Record<string, { size: number; sha256: string; sha512: string }>;
}

/** Why a verification failed, by the code the card shows (`bad-signature`, `fetch-failed`) */
export type ShellUpdateError = 'bad-signature' | 'fetch-failed' | 'other';

export type Verified = { ok: true; sha256: string } | { ok: false; code: ShellUpdateError; message: string };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export function parseDesktopManifest(bytes: Buffer): DesktopManifest | string {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    return 'the desktop manifest is not JSON';
  }
  if (raw.schema !== 1) return 'unknown desktop manifest schema';
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) return 'the desktop manifest has no version';
  if (typeof raw.minShell !== 'string' || !VERSION.test(raw.minShell) || typeof raw.shellInputs !== 'string') return 'the desktop manifest has no shell facts';
  const files = raw.files && typeof raw.files === 'object' && !Array.isArray(raw.files) ? (raw.files as Record<string, unknown>) : null;
  if (!files) return 'the desktop manifest lists no files';
  const out: DesktopManifest['files'] = {};
  for (const [name, entry] of Object.entries(files)) {
    const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    if (typeof e.size !== 'number' || typeof e.sha256 !== 'string' || !HEX64.test(e.sha256) || typeof e.sha512 !== 'string' || !HEX128.test(e.sha512)) {
      return `the desktop manifest's entry for ${name} is malformed`;
    }
    out[name] = { size: e.size, sha256: e.sha256, sha512: e.sha512 };
  }
  return { version: raw.version, shellInputs: raw.shellInputs, minShell: raw.minShell, files: out };
}

/** Size, sha256 and sha512 of a file, read once */
export async function hashFile(file: string): Promise<{ size: number; sha256: string; sha512: string }> {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    const buf = chunk as Buffer;
    size += buf.length;
    sha256.update(buf);
    sha512.update(buf);
  }
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('hex') };
}

export interface VerifyOptions {
  version: string;
  kind: ShellPackage;
  /** The downloaded file */
  file: string;
  keys: readonly KeyObject[];
  /** The version running now: a manifest older than it is refused (a downgrade), and one equal to it unless `allowSame` */
  running: string;
  /** A switch to the AppImage may install the running version itself */
  allowSame?: boolean;
  fetch?: typeof fetch;
  /** `RELEASE_DOWNLOADS` unless a test serves its own */
  downloads?: string;
}

async function get(fetchFn: typeof fetch, url: string): Promise<Response | Verified> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { 'user-agent': 'claudio-desktop' }, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    return { ok: false, code: 'fetch-failed', message: `${url}: ${err instanceof Error ? err.message : String(err)}` };
  }
  // A release without a signed manifest is refused like a bad signature: nothing vouches for the file
  if (res.status === 404) return { ok: false, code: 'bad-signature', message: `${url} does not exist: the release has no signed desktop manifest` };
  if (!res.ok) return { ok: false, code: 'fetch-failed', message: `${url} answered ${String(res.status)}` };
  return res;
}

/**
 * Whether `file` is the package the release's signed desktop manifest lists for `version`: the
 * signature by one of the shell's keys, the manifest's version, never older than what runs, and the
 * file's size, sha256 and sha512. Answers the sha256 the `.deb` command embeds.
 */
export async function verifyDownload(o: VerifyOptions): Promise<Verified> {
  if (!VERSION.test(o.version)) return { ok: false, code: 'other', message: `not a version: ${o.version}` };
  const fetchFn = o.fetch ?? fetch;
  const base = `${o.downloads ?? RELEASE_DOWNLOADS}/v${o.version}/${desktopManifestName(o.version)}`;
  const manifestRes = await get(fetchFn, base);
  if (!(manifestRes instanceof Response)) return manifestRes;
  const sigRes = await get(fetchFn, `${base}.sig`);
  if (!(sigRes instanceof Response)) return sigRes;
  const bytes = Buffer.from(await manifestRes.arrayBuffer());
  const signature = await sigRes.text();
  if (!verifyManifest(bytes, signature, o.keys)) return { ok: false, code: 'bad-signature', message: 'the desktop manifest is not signed by an accepted key' };
  const manifest = parseDesktopManifest(bytes);
  if (typeof manifest === 'string') return { ok: false, code: 'bad-signature', message: manifest };
  if (manifest.version !== o.version) return { ok: false, code: 'bad-signature', message: `the desktop manifest is for ${manifest.version}, not ${o.version}` };
  const order = compareVersions(manifest.version, o.running);
  if (order < 0 || (order === 0 && !o.allowSame)) return { ok: false, code: 'bad-signature', message: `${manifest.version} is not newer than the running ${o.running}` };
  const name = packageFileName(o.version, o.kind);
  const want = manifest.files[name];
  if (!want) return { ok: false, code: 'bad-signature', message: `the desktop manifest does not list ${name}` };
  let got: Awaited<ReturnType<typeof hashFile>>;
  try {
    got = await hashFile(o.file);
  } catch (err) {
    return { ok: false, code: 'other', message: `could not read ${o.file}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (got.size !== want.size || got.sha256 !== want.sha256 || got.sha512 !== want.sha512) {
    return { ok: false, code: 'bad-signature', message: `${name} does not match the signed desktop manifest` };
  }
  return { ok: true, sha256: got.sha256 };
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The root-owned copy apt installs: `_apt` can read it, and nothing running as the person can change it */
export const debCachePath = (version: string): string => `/var/cache/claudio/claudio_${version}_amd64.deb`;

/**
 * The command the person copies to install a downloaded `.deb` (D3). Never `apt install` on the
 * download itself: it sits in the person's cache, and anything running as them (an agent) could
 * swap it between this check and their `sudo`. So it is first copied to a root-owned path, that
 * copy is checked against the sha256 from the signed manifest, and only then given to apt. Absolute
 * paths to the system's binaries, `--` before every path, single quotes, and no `-y`: apt shows
 * what it will change and asks.
 */
export function debInstallCommand(downloaded: string, version: string, sha256: string): string {
  if (!VERSION.test(version)) throw new Error(`not a version: ${version}`);
  if (!HEX64.test(sha256)) throw new Error('not a sha256');
  // A newline or another control character would end the command the person pastes
  if (!downloaded.startsWith('/') || /[\u0000-\u001f\u007f]/.test(downloaded)) throw new Error(`not a plain absolute path: ${JSON.stringify(downloaded)}`);
  const target = debCachePath(version);
  return [
    `/usr/bin/sudo /usr/bin/install -D -m 0644 -o root -g root -- ${quote(downloaded)} ${quote(target)}`,
    `echo ${quote(`${sha256}  ${target}`)} | /usr/bin/sha256sum -c -`,
    `/usr/bin/sudo /usr/bin/apt install -- ${quote(target)}`,
  ].join(' && ');
}
