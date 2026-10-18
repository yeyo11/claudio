// What the image's launcher and the server agree on about in-app updates (docs/plans/container-polish.md,
// D4). The launcher is bundled alone from this file and `main.ts` and is the one part of Claudio an
// update cannot replace, so everything here imports `node:*` only.
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The server exits with it to be started again by the launcher, onto whatever `state.json` says now */
export const RESTART_EXIT_CODE = 75;

/** `2.1.278` and nothing looser: `latest` or `stable` mean the image does not pin */
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const parts = (v: string) => v.split('-')[0]!.split('.').map(Number);

/** Positive when `a` is newer than `b`; a pre-release sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return Number(!a.includes('-')) - Number(!b.includes('-'));
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

/** Whether one of `keys` signed exactly these bytes; `signature` is the `.sig` file's base64 */
export function verifyManifest(bytes: Buffer, signature: string, keys: readonly KeyObject[]): boolean {
  const sig = Buffer.from(signature.trim(), 'base64');
  if (sig.length !== 64) return false;
  return keys.some((key) => {
    try {
      return verify(null, bytes, key, sig);
    } catch {
      return false;
    }
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
  if (!tarball || typeof tarball.name !== 'string' || typeof tarball.sha256 !== 'string' || typeof tarball.size !== 'number') return 'the manifest names no tarball';
  if (!files || !Object.values(files).every((hash) => typeof hash === 'string')) return 'the manifest lists no files';
  return {
    schema: 1,
    version: raw.version as string,
    platform: 'linux-x64',
    nodeAbi: raw.nodeAbi,
    minImage: raw.minImage as string,
    imageInputs: raw.imageInputs,
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
    return err instanceof Error ? err.message : String(err);
  }
  const missing = Object.keys(manifest.files).find((path) => !seen.has(path));
  return missing ? `${missing} is missing` : null;
}

export interface OverlayCheck {
  /** `/data/app/<version>` */
  dir: string;
  version: string;
  keys: readonly KeyObject[];
  image: ImageInfo;
  /** The ABI of the Node that will run it */
  nodeAbi: string;
}

/**
 * Why the unpacked overlay must not boot, or null when it may: signed by an accepted key, the
 * version its directory says, newer than the image, made for this image and this Node, and every
 * file as signed. The launcher runs it before every boot, the server after every download.
 */
export function checkOverlay({ dir, version: v, keys, image, nodeAbi }: OverlayCheck): string | null {
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
  if (compareVersions(v, image.version) <= 0) return `${v} is not newer than the image's ${image.version}`;
  if (compareVersions(manifest.minImage, image.version) > 0) return `${v} needs the image ${manifest.minImage} or later`;
  if (manifest.nodeAbi !== nodeAbi) return `${v} was built for Node ABI ${manifest.nodeAbi}, not ${nodeAbi}`;
  return verifyFiles(dir, manifest);
}
