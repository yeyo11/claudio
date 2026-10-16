/*
 * Path resolution for the guard. Pure apart from reading the file system to find real paths. Only
 * `node:` imports: this file is bundled into the guard program.
 */
import { realpathSync } from 'node:fs';
import { posix } from 'node:path';

/** Symlinks the command line itself creates (`ln -s TARGET NAME`), which are not on disk yet */
export type Links = readonly (readonly [string, string])[];

/** An absolute path with `.` and `..` folded and no trailing slash (except the root itself) */
export function normalizeAbs(path: string): string {
  const normal = posix.normalize(path);
  return normal.length > 1 && normal.endsWith('/') ? normal.slice(0, -1) : normal;
}

/** The absolute path of `path` seen from `cwd`; null when it is relative and the directory is unknown */
export function resolveLexical(path: string, cwd: string | null): string | null {
  if (path.startsWith('/')) return normalizeAbs(path);
  if (cwd === null) return null;
  return normalizeAbs(posix.join(cwd, path === '' ? '.' : path));
}

export function isInside(path: string, dir: string): boolean {
  if (dir === '/') return true;
  return path === dir || path.startsWith(`${dir}/`);
}

export function insideAny(path: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => isInside(path, dir));
}

function applyLinks(abs: string, links: Links, followLast: boolean): string {
  let path = abs;
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const [name, target] of links) {
      if (path === name && followLast) {
        path = target;
        changed = true;
      } else if (path.startsWith(`${name}/`)) {
        path = normalizeAbs(target + path.slice(name.length));
        changed = true;
      }
    }
    if (!changed) break;
  }
  return path;
}

/**
 * The real path of an absolute one: the longest prefix that exists is resolved with `realpath` and
 * the rest is appended as written. `followLast` false keeps a final symlink as it is, as `rm` does
 * for a name without a trailing slash.
 */
export function realResolve(abs: string, followLast: boolean, links: Links = []): string {
  const start = applyLinks(normalizeAbs(abs), links, followLast);
  const base = followLast || start === '/' ? '' : posix.basename(start);
  let current = base === '' ? start : posix.dirname(start);
  const rest: string[] = base === '' ? [] : [base];
  for (;;) {
    try {
      const real = realpathSync(current);
      return normalizeAbs(posix.join(real, ...rest));
    } catch {
      if (current === '/') return normalizeAbs(posix.join('/', ...rest));
      rest.unshift(posix.basename(current));
      current = posix.dirname(current);
    }
  }
}

/** The part of a glob word that is literal, cut back to its last `/`: `node_modules/*` → `node_modules/` */
export function staticPrefix(text: string): string {
  const at = text.search(/[*?[{]/);
  if (at < 0) return text;
  return text.slice(0, text.lastIndexOf('/', at) + 1);
}

/** Expands literal `{a,b}` groups; null when a group is not a plain list or there are too many results */
export function expandBraces(text: string, limit = 64): string[] | null {
  const open = text.indexOf('{');
  if (open < 0) return [text];
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return [text];
  const body = text.slice(open + 1, close);
  if (!body.includes(',')) return body.includes('..') ? null : [text];
  const parts: string[] = [];
  let level = 0;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i);
    if (ch === '{') level++;
    else if (ch === '}') level--;
    else if (ch === ',' && level === 0) {
      parts.push(body.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(body.slice(from));
  const out: string[] = [];
  for (const part of parts) {
    const inner = expandBraces(text.slice(0, open) + part + text.slice(close + 1), limit);
    if (inner === null) return null;
    out.push(...inner);
    if (out.length > limit) return null;
  }
  return out;
}

const globCache = new Map<string, RegExp>();

/** `*` stays inside a path segment, `**` crosses them, `?` is one character; the match is anchored */
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === '*') {
      if (glob.charAt(i + 1) === '*') {
        i++;
        if (glob.charAt(i + 1) === '/') {
          i++;
          source += '(?:.*/)?';
        } else source += '.*';
      } else source += '[^/]*';
    } else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  const regex = new RegExp(`^${source}$`);
  globCache.set(glob, regex);
  return regex;
}

/** A glob without a slash matches a file name at any depth, like a `.gitignore` line; one with a slash is anchored at the root */
export function matchesGlob(relative: string, glob: string): boolean {
  if (glob.includes('/')) return globToRegExp(glob).test(relative);
  return globToRegExp(glob).test(posix.basename(relative));
}

/** The segments of a path, without empty ones */
export function segments(path: string): string[] {
  return path.split('/').filter((part) => part !== '');
}
