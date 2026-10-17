// What the designer hooks share (docs/plans/claudio-designer.md §2). Claude Code hands a hook a JSON
// object on stdin (tool_name, tool_input, cwd, session_id, transcript_path…); exit 0 lets the turn go
// on, exit 2 blocks and gives stderr back to Claude, which then fixes what it was told.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function readHookInput() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function editedPath(input) {
  const ti = input.tool_input ?? {};
  const path = ti.file_path ?? ti.path ?? ti.notebook_path ?? null;
  return path ? resolve(input.cwd ?? process.cwd(), path) : null;
}

/**
 * The checkout a file belongs to: the nearest folder above it that holds scripts/design-lint.mjs.
 * Not the hook's own: a session can edit a file in another worktree, and that worktree's rules are
 * the ones its file answers to.
 */
export function checkoutOf(file) {
  let dir = dirname(file);
  for (;;) {
    if (existsSync(join(dir, 'scripts', 'design-lint.mjs'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export async function lintModule(root) {
  return import(pathToFileURL(join(root, 'scripts', 'design-lint.mjs')).href);
}

const toPosix = (path) => path.split(sep).join('/');

/** The screen a file renders, from .claude/designer/route-map.json: the longest key that matches */
export function routeFor(root, file) {
  const mapPath = join(root, '.claude', 'designer', 'route-map.json');
  if (!existsSync(mapPath)) return null;
  try {
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    const rel = toPosix(relative(root, file));
    const keys = Object.keys(map).filter((k) => !k.startsWith('$') && (k === rel || (k.endsWith('/') && rel.startsWith(k))));
    keys.sort((a, b) => b.length - a.length);
    return keys[0] ? map[keys[0]] : null;
  } catch {
    return null;
  }
}

function stateFile(root, session) {
  const dir = join(root, '.claude', '.designer-state');
  mkdirSync(dir, { recursive: true });
  return join(dir, `dirty-${String(session ?? 'session').replace(/[^\w-]/g, '')}.json`);
}

/** Remembers, per session, the UI files edited since the last review */
export function markDirty(root, session, file) {
  const path = stateFile(root, session);
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { files: [] };
  const rel = toPosix(relative(root, file));
  if (!current.files.includes(rel)) current.files.push(rel);
  writeFileSync(path, JSON.stringify(current));
}

export function dirtyFiles(root, session) {
  const path = stateFile(root, session);
  if (!existsSync(path)) return { path, files: [] };
  try {
    return { path, files: JSON.parse(readFileSync(path, 'utf8')).files ?? [] };
  } catch {
    return { path, files: [] };
  }
}

export function block(message) {
  process.stderr.write(`${message.trim()}\n`);
  process.exit(2);
}
