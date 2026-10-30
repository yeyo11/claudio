// What a payload's launcher and the server agree on about in-app updates (docs/plans/container-polish.md,
// D4; docs/plans/unified-updates.md, D1, D2, D7). The container's launcher is bundled alone from this
// file, `machine.ts` and `main.ts`, and the desktop shell runs the same files: both are the part of
// Claudio an update cannot replace, so everything here imports `node:*` only.
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '@claudio/shared';

/** The server exits with it to be started again by the launcher, onto whatever `state.json` says now */
export const RESTART_EXIT_CODE = 75;

/**
 * The server exits with it when another server holds its data directory (EX_CANTCREAT). It says
 * nothing about the payload: a trial that ends with it is not a failed one, and it is not restarted.
 */
export const DATA_DIR_LOCKED_EXIT_CODE = 73;

/**
 * libuv's thread pool for the server, unless its environment names one: every file read, DNS lookup
 * and hash of the server queues on it, and the default of four held a listing of the machine's
 * transcripts behind itself and every request behind that (docs/plans/regression-fixes-2026-10-29.md,
 * C7). libuv reads the variable once, when the pool is first used, so whoever starts the server
 * puts it in the server's environment, and the server's entry sets it before anything else runs.
 */
export const SERVER_THREADPOOL_SIZE = '16';

/** `env` with the server's thread pool, unless it already names one. */
export function withServerThreadpool(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env.UV_THREADPOOL_SIZE ? env : { ...env, UV_THREADPOOL_SIZE: SERVER_THREADPOOL_SIZE };
}

/** `2.1.278` and nothing looser: `latest` or `stable` mean the image does not pin */
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The version without its build metadata (`+…`), which SemVer says never takes part in precedence */
const core = (v: string) => {
  const plus = v.indexOf('+');
  return plus < 0 ? v : v.slice(0, plus);
};

const parts = (v: string) => core(v).split('-')[0]!.split('.').map(Number);

/** The dot-separated identifiers after the first `-`, or null for a release */
const prerelease = (v: string): string[] | null => {
  const c = core(v);
  const dash = c.indexOf('-');
  return dash < 0 ? null : c.slice(dash + 1).split('.');
};

const NUMERIC = /^\d+$/;

/** SemVer 2.0 §11.4: numeric identifiers numerically, alphanumeric ones in ASCII order, numeric below alphanumeric */
function compareIdentifiers(a: string, b: string): number {
  const [na, nb] = [NUMERIC.test(a), NUMERIC.test(b)];
  if (na && nb) {
    // Compared as digit strings, so an identifier beyond 2^53 still orders right
    const [ta, tb] = [a.replace(/^0+(?=\d)/, ''), b.replace(/^0+(?=\d)/, '')];
    return ta.length !== tb.length ? ta.length - tb.length : ta < tb ? -1 : ta > tb ? 1 : 0;
  }
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Positive when `a` is newer than `b`, negative when older, 0 when they rank the same. SemVer 2.0
 * precedence: `major.minor.patch` numerically (a missing part counts as 0), then any pre-release
 * below its release, and two pre-releases of the same version by their identifiers (`beta.2` <
 * `beta.10` < `rc.1`; fewer identifiers first when the rest are equal). Build metadata is ignored.
 */
export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  const [ra, rb] = [prerelease(a), prerelease(b)];
  if (ra === null || rb === null) return Number(ra === null) - Number(rb === null);
  for (let i = 0; i < Math.min(ra.length, rb.length); i += 1) {
    const diff = compareIdentifiers(ra[i] ?? '', rb[i] ?? '');
    if (diff !== 0) return diff;
  }
  return ra.length - rb.length;
}

/** `/app/image.json`: what the image was built with, root-owned like the launcher that reads it */
export interface ImageInfo {
  version: string;
  /** sha256 over what only a new image can change (the runtime stage, the launcher, the guard, the keys, Node, the native modules) */
  imageInputs: string;
  /** `process.versions.modules` of the image's Node: the native modules of a bundle are built for it */
  nodeAbi: string;
  /** The Claude Code version the image pins, when it pins one */
  claudeCode: string | null;
}

/** `claudio-server-<v>-linux-x64.json`, signed byte for byte by CI */
export interface BundleManifest {
  schema: 1;
  version: string;
  platform: 'linux-x64';
  nodeAbi: string;
  /** The oldest image this bundle runs on */
  minImage: string;
  imageInputs: string;
  /** The oldest desktop shell this bundle runs on */
  minShell: string;
  /** sha256 over what only a new desktop shell can change (Electron, the native modules, the launcher, the guard, the keys, the IPC) */
  shellInputs: string;
  commit: string;
  builtAt: string;
  tarball: { name: string; sha256: string; size: number };
  /** Every file of the unpacked bundle, by its `/`-separated path, with its sha256 */
  files: Record<string, string>;
}

/** `/data/app/state.json`, written by the launcher and the server, never at the same time on purpose */
export interface LauncherState {
  /** The overlay that booted and answered `/api/health`; null runs the image's `/app` */
  active: string | null;
  /** The good overlay before `active`, the first fallback */
  previous: string | null;
  /** The overlay to boot next, on trial */
  trial: string | null;
  /** Failed boots of `trial` so far */
  attempts: number;
  /** Versions that failed their trial or their checks: never booted or offered again */
  bad: string[];
  lastRollback: { from: string; to: string; at: string } | null;
  /** The version a restart waits for idleness to apply */
  scheduled: string | null;
  /** The `at` of the rollback the server already wrote an audit row for */
  rollbackAudited: string | null;
}

export const EMPTY_STATE: LauncherState = {
  active: null,
  previous: null,
  trial: null,
  attempts: 0,
  bad: [],
  lastRollback: null,
  scheduled: null,
  rollbackAudited: null,
};

/** The manifest and its signature inside an unpacked bundle; the only files `files` does not list */
export const MANIFEST_FILE = 'manifest.json';
export const SIGNATURE_FILE = 'manifest.json.sig';

const version = (value: unknown): string | null => (typeof value === 'string' && VERSION.test(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The agents' user can write `state.json`, so nothing in it is a path: every version is checked
 * against `VERSION` here, and a directory is only ever built from one (`overlayDir`).
 */
export function parseState(raw: unknown): LauncherState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_STATE, bad: [] };
  const r = raw as Record<string, unknown>;
  const rollback = r.lastRollback && typeof r.lastRollback === 'object' ? (r.lastRollback as Record<string, unknown>) : null;
  const from = version(rollback?.from);
  const to = version(rollback?.to);
  const at = text(rollback?.at);
  return {
    active: version(r.active),
    previous: version(r.previous),
    trial: version(r.trial),
    attempts: typeof r.attempts === 'number' && Number.isInteger(r.attempts) && r.attempts >= 0 ? r.attempts : 0,
    bad: Array.isArray(r.bad) ? r.bad.map(version).filter((v): v is string => v !== null) : [],
    lastRollback: from && to && at ? { from, to, at } : null,
    scheduled: version(r.scheduled),
    rollbackAudited: text(r.rollbackAudited),
  };
}

export function readState(file: string): LauncherState {
  try {
    return parseState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return parseState(null);
  }
}

/** Through a temp file and a rename, so the other process never reads half of it */
export function writeState(file: string, state: LauncherState): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** `<root>/<version>`, from a version string that was validated, never from a path read off disk */
export function overlayDir(root: string, v: string): string {
  if (!VERSION.test(v)) throw new Error(`not a version: ${v}`);
  return join(root, v);
}

export function readImageInfo(file: string): ImageInfo | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const v = version(raw.version);
    if (!v) return null;
    return { version: v, imageInputs: text(raw.imageInputs) ?? '', nodeAbi: text(raw.nodeAbi) ?? process.versions.modules, claudeCode: version(raw.claudeCode) };
  } catch {
    return null;
  }
}

/** Every Ed25519 public key (PEM, SPKI) in `dir/*.pub`; one that does not parse is left out */
export function loadKeys(dir: string): KeyObject[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.pub')).sort();
  } catch {
    return [];
  }
  const keys: KeyObject[] = [];
  for (const name of names) {
    try {
      const key = createPublicKey(readFileSync(join(dir, name)));
      if (key.asymmetricKeyType === 'ed25519') keys.push(key);
    } catch {
      // A stray file in the folder is not a key
    }
  }
  return keys;
}

/** The first 16 hex characters of the sha256 of the public key's DER (SPKI): how a `.sig` line names its key */
export function keyId(key: KeyObject): string {
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/** More lines than a rotation ever needs is not a signature file */
const MAX_SIGNATURE_LINES = 8;
const KEY_ID = /^[0-9a-f]{16}$/;

/**
 * Whether one of `keys` signed exactly these bytes. The `.sig` file holds one line per signing key,
 * `<keyId> <base64>`, so a key rotation can overlap: a bundle signed by the old and the new key
 * verifies on a shell or an image that trusts either. A bare base64 line (phase 1's format) is tried
 * against every key. A line that names a key is only tried against that key, so an unknown id never
 * verifies, and one valid line is enough.
 */
export function verifyManifest(bytes: Buffer, signature: string, keys: readonly KeyObject[]): boolean {
  const lines = signature.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_SIGNATURE_LINES) return false;
  const ids = new Map(keys.map((key) => [key, keyId(key)]));
  return lines.some((line) => {
    const fields = line.split(/\s+/);
    if (fields.length > 2) return false;
    const id = fields.length === 2 ? (fields[0] ?? '') : null;
    if (id !== null && !KEY_ID.test(id)) return false;
    const sig = Buffer.from(fields.at(-1) ?? '', 'base64');
    if (sig.length !== 64) return false;
    return keys.some((key) => {
      if (id !== null && ids.get(key) !== id) return false;
      try {
        return verify(null, bytes, key, sig);
      } catch {
        return false;
      }
    });
  });
}

/** The manifest's fields, or why they are not a manifest */
export function parseManifest(bytes: Buffer): BundleManifest | string {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    return 'the manifest is not JSON';
  }
  const tarball = raw.tarball && typeof raw.tarball === 'object' ? (raw.tarball as Record<string, unknown>) : null;
  const files = raw.files && typeof raw.files === 'object' && !Array.isArray(raw.files) ? (raw.files as Record<string, unknown>) : null;
  if (raw.schema !== 1) return 'unknown manifest schema';
  if (!version(raw.version) || !version(raw.minImage)) return 'the manifest has no version';
  if (raw.platform !== 'linux-x64') return 'the bundle is for another platform';
  if (typeof raw.nodeAbi !== 'string' || typeof raw.imageInputs !== 'string') return 'the manifest has no image facts';
  // No launcher of phase 1 ever shipped, so every manifest a launcher reads carries the shell's facts
  if (!version(raw.minShell) || typeof raw.shellInputs !== 'string') return 'the manifest has no desktop facts';
  if (!tarball || typeof tarball.name !== 'string' || typeof tarball.sha256 !== 'string' || typeof tarball.size !== 'number') return 'the manifest names no tarball';
  if (!files || !Object.values(files).every((hash) => typeof hash === 'string')) return 'the manifest lists no files';
  return {
    schema: 1,
    version: raw.version as string,
    platform: 'linux-x64',
    nodeAbi: raw.nodeAbi,
    minImage: raw.minImage as string,
    imageInputs: raw.imageInputs,
    minShell: raw.minShell as string,
    shellInputs: raw.shellInputs,
    commit: text(raw.commit) ?? '',
    builtAt: text(raw.builtAt) ?? '',
    tarball: { name: tarball.name, sha256: tarball.sha256, size: tarball.size },
    files: files as Record<string, string>,
  };
}

export const sha256File = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Whether `dir` holds exactly the files the manifest lists, each with its hash. A file it does not
 * list fails too: `api.mjs` resolves `node_modules` beside itself, so a planted package would run.
 * A symlink fails, because it could point anywhere.
 */
export function verifyFiles(dir: string, manifest: BundleManifest): string | null {
  const seen = new Set<string>();
  const walk = (rel: string): string | null => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(dir, path));
      if (stat.isSymbolicLink()) return `${path} is a symlink`;
      if (stat.isDirectory()) {
        const failed = walk(path);
        if (failed) return failed;
        continue;
      }
      if (!rel && (name === MANIFEST_FILE || name === SIGNATURE_FILE)) continue;
      const expected = manifest.files[path];
      if (expected === undefined) return `${path} is not in the manifest`;
      if (!stat.isFile() || sha256File(join(dir, path)) !== expected) return `${path} does not match the manifest`;
      seen.add(path);
    }
    return null;
  };
  try {
    const failed = walk('');
    if (failed) return failed;
  } catch (err) {
    return errorMessage(err);
  }
  const missing = Object.keys(manifest.files).find((path) => !seen.has(path));
  return missing ? `${missing} is missing` : null;
}

/**
 * What an overlay is judged against: the base payload it would replace. In the container that is
 * the image (`/app`), whose Node runs the bundle, so its native modules must match the ABI. On the
 * desktop it is the shell (`<resources>/server`): Electron's Node never has the ABI of the Node the
 * bundle was built on, and both native modules are N-API, so only `minShell` decides.
 */
export type PayloadBase =
  | { kind: 'image'; version: string; imageInputs: string; /** The ABI of the Node that will run it */ nodeAbi: string }
  | { kind: 'shell'; version: string; shellInputs: string };

export const imageBase = (image: ImageInfo, nodeAbi: string): PayloadBase => ({ kind: 'image', version: image.version, imageInputs: image.imageInputs, nodeAbi });

/** Why a bundle's manifest does not fit this base, or null when it does */
export function baseRefusal(manifest: Pick<BundleManifest, 'version' | 'minImage' | 'minShell' | 'nodeAbi'>, base: PayloadBase): string | null {
  if (base.kind === 'shell') {
    return compareVersions(manifest.minShell, base.version) > 0 ? `${manifest.version} needs the desktop app ${manifest.minShell} or later` : null;
  }
  if (compareVersions(manifest.minImage, base.version) > 0) return `${manifest.version} needs the image ${manifest.minImage} or later`;
  if (manifest.nodeAbi !== base.nodeAbi) return `${manifest.version} was built for Node ABI ${manifest.nodeAbi}, not ${base.nodeAbi}`;
  return null;
}

export interface OverlayCheck {
  /** `<dataDir>/app/<version>` */
  dir: string;
  version: string;
  keys: readonly KeyObject[];
  base: PayloadBase;
}

/**
 * Why the unpacked overlay must not boot, or null when it may: signed by an accepted key, the
 * version its directory says, newer than the base payload, made for this base, and every file as
 * signed. A launcher runs it before every boot, the server after every download: it is what stops a
 * bundle that an agent running as the person changed in the user-writable data dir.
 */
export function checkOverlay({ dir, version: v, keys, base }: OverlayCheck): string | null {
  let bytes: Buffer;
  let signature: string;
  try {
    bytes = readFileSync(join(dir, MANIFEST_FILE));
    signature = readFileSync(join(dir, SIGNATURE_FILE), 'utf8');
  } catch {
    return 'the overlay has no signed manifest';
  }
  if (!verifyManifest(bytes, signature, keys)) return 'the manifest is not signed by an accepted key';
  const manifest = parseManifest(bytes);
  if (typeof manifest === 'string') return manifest;
  if (manifest.version !== v) return `the manifest is for ${manifest.version}, not ${v}`;
  if (compareVersions(v, base.version) <= 0) return `${v} is not newer than the ${base.kind === 'image' ? "image's" : "desktop app's"} ${base.version}`;
  return baseRefusal(manifest, base) ?? verifyFiles(dir, manifest);
}
