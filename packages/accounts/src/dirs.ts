import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Settings an account's config directory borrows from the default one. Symlinks: Claude Code
 * writes through them, so editing from inside an account still lands in the one file.
 */
export const SHARED_SETTINGS = ['settings.json', 'CLAUDE.md', 'keybindings.json', 'agents', 'commands', 'skills'];

/**
 * Always linked: Claudio reads transcripts from one `projects/`, and a session started on one
 * account resumes on another with `--resume` only if they share it.
 */
export const HISTORY = 'projects';

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isLinkTo(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
}

/**
 * Creates an account's directory (0700) and links the shared items into it. Never over something
 * already there: an existing entry is the account's own. Returns the links it made.
 */
export function prepareAccountDir(dir: string, defaultDir: string, shareSettings = true): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The default account's own dir needs no links to itself
  if (dir === defaultDir) return [];
  const made: string[] = [];
  for (const item of [HISTORY, ...(shareSettings ? SHARED_SETTINGS : [])]) {
    const source = join(defaultDir, item);
    const dest = join(dir, item);
    // A fresh install has no projects/ yet, and the link must not dangle
    if (item === HISTORY && !exists(source)) mkdirSync(source, { recursive: true });
    if (!exists(source) || exists(dest)) continue;
    symlinkSync(source, dest);
    made.push(item);
  }
  return made;
}

/** Removes the links `prepareAccountDir` made, and only while they still point where it pointed them. */
export function removeLinks(dir: string, defaultDir: string, links: readonly string[]): void {
  for (const item of links) {
    const dest = join(dir, item);
    if (isLinkTo(dest, join(defaultDir, item))) unlinkSync(dest);
  }
}
