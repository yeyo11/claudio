// Skew protection (docs/plans/remote-updates.md, D6): a page opened before an update keeps asking
// for the hashed files of the build it came from. Those hashes never change content, so the web
// builds the launcher still keeps next to the running one (`<dataDir>/app/<version>/web`) can
// answer for them, and everything else that names a file is a plain 404 instead of the shell.
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/** A kept payload version's directory name (the launcher's `VERSION`, packages/core/src/launcher/protocol.ts) */
const VERSION_DIR = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** A file name Vite emits under `/assets`: one flat segment, no separator, no leading dot. */
const ASSET_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** The path of a request URL, decoded; null for one that is not valid. */
export function requestPath(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url, 'http://claudio.invalid').pathname);
  } catch {
    return null;
  }
}

/**
 * Whether a path names a file: its last segment has an extension. A client route never does (ids
 * are uuids and slugs), and a stale file must read as missing, not as the app's shell with a 200.
 */
export function namesFile(pathname: string): boolean {
  return /\.[A-Za-z0-9]+$/.test(pathname.slice(pathname.lastIndexOf('/') + 1));
}

/** The asset file name a `/assets/<name>` path asks for, or null for anything else. */
export function assetName(pathname: string): string | null {
  if (!pathname.startsWith('/assets/')) return null;
  const name = pathname.slice('/assets/'.length);
  return ASSET_NAME.test(name) ? name : null;
}

/**
 * The `assets` folders of the web builds kept under `<dataDir>/app/<version>`, newest first, except
 * the one being served right now. A missing folder is not an error: most installs have no overlay.
 */
export async function previousAssetDirs(dataDir: string, webDist: string): Promise<string[]> {
  const root = join(dataDir, 'app');
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const current = join(resolve(webDist), 'assets');
  return names
    .filter((name) => VERSION_DIR.test(name))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .map((name) => join(root, name, 'web', 'assets'))
    .filter((dir) => dir !== current);
}

/**
 * The folder holding `name` among the kept builds, or null. Only a regular file whose real path is
 * inside that folder counts: the data directory is writable by the person's other processes, so a
 * link planted there must not turn this into a way to read anything else.
 */
export async function findPreviousAsset(dirs: readonly string[], name: string): Promise<string | null> {
  for (const dir of dirs) {
    const file = join(dir, name);
    try {
      if (!(await lstat(file)).isFile()) continue;
      if ((await realpath(file)).startsWith((await realpath(dir)) + sep)) return dir;
    } catch {
      // Not in this build
    }
  }
  return null;
}
