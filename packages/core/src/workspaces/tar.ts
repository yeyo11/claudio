import { mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { refuse } from './refusal.ts';

/**
 * A tar reader of Claudio's own over the gunzipped stream, rather than the `tar` package with its
 * filters: the archive comes from outside, and every entry has to be judged on its final name (after
 * PAX and GNU long names) before a byte of it is written. Here that is one loop with nothing behind
 * it that writes on its own; it reads ustar, PAX (`x`, `g`) and GNU long names (`L`, `K`), which is
 * what GitHub and `git archive` produce, and refuses everything else.
 */

export interface ExtractOptions {
  maxBytes: number;
  maxEntries: number;
  /** Told the size of every chunk before it is written; throws to stop (the total under the root) */
  onBytes?: (bytes: number) => void;
}

export interface ExtractResult {
  bytes: number;
  files: number;
  /** The single top-level directory, when that is all the archive holds (GitHub's `owner-repo-sha/`) */
  topDir: string | null;
}

const BLOCK = 512;
/** A PAX or GNU long-name header holds names, not data: anything bigger is an attack on the memory */
const MAX_META_BYTES = 1024 * 1024;
/** Extension headers in a row before an entry: a real archive has one or two */
const MAX_METAS_IN_A_ROW = 8;

const bad = (message: string) => refuse('workspace-bad-archive', message);

/** A name for a message: short, and with nothing that could pass for a line of its own */
const shown = (name: string): string => {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '?');
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
};

/** Reads exact runs of bytes from the decompressed stream, keeping what is left of the last chunk. */
class Bytes {
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(private readonly chunks: AsyncIterator<Buffer>) {}

  private async more(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.chunks.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    this.buf = this.buf.length === 0 ? next.value : Buffer.concat([this.buf, next.value]);
    return true;
  }

  /** Exactly `n` bytes; null when the stream ended before the first of them */
  async exact(n: number): Promise<Buffer | null> {
    while (this.buf.length < n) {
      if (!(await this.more())) {
        if (this.buf.length === 0) return null;
        throw bad('the archive ends in the middle of an entry');
      }
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** `n` bytes as they come, without holding them all */
  async *take(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.more())) throw bad('the archive ends in the middle of an entry');
      const part = this.buf.subarray(0, Math.min(left, this.buf.length));
      this.buf = this.buf.subarray(part.length);
      left -= part.length;
      yield part;
    }
  }

  async skip(n: number): Promise<void> {
    for await (const part of this.take(n)) void part;
  }

  /** What follows the end marker, read and dropped; `count` bounds it like the entries were */
  async drain(count: (bytes: number) => void): Promise<void> {
    count(this.buf.length);
    this.buf = Buffer.alloc(0);
    while (await this.more()) {
      count(this.buf.length);
      this.buf = Buffer.alloc(0);
    }
  }
}

function text(b: Buffer, offset: number, length: number): string {
  const end = b.indexOf(0, offset);
  return b.toString('utf8', offset, end === -1 || end > offset + length ? offset + length : end);
}

/** A numeric field: octal text, or GNU's base-256 for values octal cannot hold */
function number(b: Buffer, offset: number, length: number): number {
  const first = b[offset] ?? 0;
  if (first & 0x80) {
    if (first & 0x40) throw bad('an entry has a negative size');
    let value = first & 0x3f;
    for (let i = offset + 1; i < offset + length; i++) value = value * 256 + (b[i] ?? 0);
    if (!Number.isSafeInteger(value)) throw bad('an entry has a size too large to read');
    return value;
  }
  const digits = text(b, offset, length).trim();
  if (digits === '') return 0;
  if (!/^[0-7]+$/.test(digits)) throw bad('an entry header is not a tar header');
  return parseInt(digits, 8);
}

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0);
  return number(h, 148, 8) === sum;
}

/** `length key=value\n` records; only the keys that change what is extracted are kept */
function paxRecords(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    if (space === -1) throw bad('a PAX header is malformed');
    const length = Number(body.toString('latin1', pos, space));
    if (!Number.isSafeInteger(length) || length <= space - pos || pos + length > body.length || body[pos + length - 1] !== 0x0a) throw bad('a PAX header is malformed');
    const record = body.toString('utf8', space + 1, pos + length - 1);
    const eq = record.indexOf('=');
    if (eq === -1) throw bad('a PAX header is malformed');
    out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += length;
  }
  return out;
}

const KINDS: Record<string, string> = {
  '1': 'hard link',
  '2': 'symbolic link',
  '3': 'character device',
  '4': 'block device',
  '6': 'FIFO',
};

/**
 * The entry's path relative to the workspace, or null for the archive's own root (`./`). Refuses an
 * absolute path, a `..`, a `.git` component and anything that would leave the folder: the name is
 * judged whole, after every extension header was applied.
 */
export function entryPath(name: string, dest: string): string | null {
  if (name.includes('\0') || name.includes('\\')) throw bad(`'${shown(name)}' is not a file name the archive may hold`);
  if (name.startsWith('/')) throw bad(`'${shown(name)}' is an absolute path`);
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) return null;
  if (parts.includes('..')) throw bad(`'${shown(name)}' climbs out with '..'`);
  // A hostile `.git/config` makes git run the programs it names; the workspace needs no history
  if (parts.some((p) => p.toLowerCase() === '.git')) throw bad(`'${shown(name)}' is inside a .git folder; send the tree without its history`);
  const rel = parts.join('/');
  const inside = relative(dest, resolve(dest, rel));
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw bad(`'${shown(name)}' leaves the workspace`);
  return rel;
}

/**
 * Extracts a tar stream into `dest`, an empty folder, entry by entry. Regular files are written
 * `0444`; directories stay writable until the caller seals them, since their entries come later.
 */
export async function extractTar(source: AsyncIterable<Buffer>, dest: string, opts: ExtractOptions): Promise<ExtractResult> {
  const input = new Bytes(source[Symbol.asyncIterator]());
  let bytes = 0;
  let files = 0;
  let entries = 0;
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let metas = 0;
  const count = (n: number): void => {
    if (bytes + n > opts.maxBytes) throw refuse('workspace-too-large', `the archive holds more than ${String(Math.floor(opts.maxBytes / (1024 * 1024)))} MB`);
    opts.onBytes?.(n);
    bytes += n;
  };

  for (;;) {
    const header = await input.exact(BLOCK);
    // An archive without its end marker ends at a header boundary all the same
    if (!header) break;
    if (header.every((byte) => byte === 0)) {
      // Records are padded with zeros past the marker; anything more is still decompressed, so it
      // is bounded like the entries, without counting as extracted
      let trailing = 0;
      await input.drain((n) => {
        trailing += n;
        if (trailing > opts.maxBytes) throw refuse('workspace-too-large', 'the archive goes on far past its end');
      });
      break;
    }
    if (!checksumOk(header)) throw bad('this is not a tar archive, or it is damaged');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156] ?? 0x30);
    let size = number(header, 124, 12);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;

    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      if (++metas > MAX_METAS_IN_A_ROW || size > MAX_META_BYTES) throw bad('the archive has an extension header too large to be a name');
      const body = size === 0 ? Buffer.alloc(0) : await input.exact(size);
      if (!body) throw bad('the archive ends in the middle of an entry');
      await input.skip(padding);
      if (type === 'x') pax = { ...pax, ...paxRecords(body) };
      else if (type === 'L') longName = text(body, 0, body.length);
      // `g` sets defaults for the archive (GitHub's carries the commit) and `K` a link's target: a
      // link is refused when its entry comes, and no default changes what is extracted
      continue;
    }
    metas = 0;

    const ustar = header.toString('latin1', 257, 263) === 'ustar\0';
    const prefix = ustar ? text(header, 345, 155) : '';
    const plain = text(header, 0, 100);
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${plain}` : plain);
    if (pax.size !== undefined) {
      if (!/^\d+$/.test(pax.size) || !Number.isSafeInteger(Number(pax.size))) throw bad('a PAX header is malformed');
      size = Number(pax.size);
    }
    pax = {};
    longName = null;

    const kind = KINDS[type];
    if (kind) throw bad(`'${shown(name)}' is a ${kind}: only regular files and directories are extracted`);
    if (type !== '0' && type !== '7' && type !== '5') throw bad(`'${shown(name)}' is an entry of a kind Claudio does not extract`);
    const rel = entryPath(name, dest);
    if (++entries > opts.maxEntries) throw refuse('workspace-too-large', `the archive holds more than ${String(opts.maxEntries)} entries`);
    const bodyPadding = (BLOCK - (size % BLOCK)) % BLOCK;

    if (type === '5') {
      if (rel) await mkdir(join(dest, rel), { recursive: true, mode: 0o755 });
      await input.skip(size + bodyPadding);
      continue;
    }
    if (!rel || name.endsWith('/')) throw bad(`'${shown(name)}' is a file without a name`);
    // Refused before anything is read, and again as each chunk is written
    if (bytes + size > opts.maxBytes) throw refuse('workspace-too-large', `the archive holds more than ${String(Math.floor(opts.maxBytes / (1024 * 1024)))} MB`);
    const target = join(dest, rel);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    // `wx`: a name the archive holds twice, or a file where a folder already is, is refused, never overwritten
    const file = await open(target, 'wx', 0o444).catch((err: NodeJS.ErrnoException) => {
      throw bad(err.code === 'EEXIST' ? `'${shown(name)}' appears twice in the archive` : `'${shown(name)}' cannot be written where the archive puts it`);
    });
    try {
      for await (const part of input.take(size)) {
        count(part.length);
        await file.write(part);
      }
    } finally {
      await file.close();
    }
    files++;
    await input.skip(bodyPadding);
  }

  const top = await readdir(dest, { withFileTypes: true });
  const only = top.length === 1 ? top[0] : undefined;
  return { bytes, files, topDir: only?.isDirectory() ? only.name : null };
}

/** Whether `path` is `root` or inside it, by name: the caller has resolved both */
export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
