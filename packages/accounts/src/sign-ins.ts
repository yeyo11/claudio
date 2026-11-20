import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { errorMessage, isRecord, type AccountSignIns } from '@claudio/shared';
import { CREDENTIALS_FILE } from './identify.ts';

/**
 * MCP sign-ins of shared accounts (docs/plans/account-configuration-and-project-rules.md, "S6
 * follow-up"; decisions S6-D1 (c), S6-D2 (a), S6-D3 never).
 *
 * The overlay hands a shared account the default's MCP servers, but the OAuth token of a remote server
 * lives in each config dir's own `.credentials.json` (`mcpOAuth`), beside the account's login
 * (`claudeAiOauth`), so the file cannot be linked. The S6 spike measured that copying one `mcpOAuth`
 * entry is enough, and that its key does not depend on the dir (`mcpOAuthKey`). This copies the
 * default's entries into each shared account's file, one way only: the default's file is only read,
 * because a terminal `claude` outside Claudio may be writing it.
 *
 * What is copied: an entry with an access token and no refresh token, and an entry with a refresh token
 * only for a server Claudio has seen refresh without changing it. A server whose refresh token changed
 * rotates it: a stale copy there is a reuse, which revokes the grant in every dir that holds it, the
 * default's included (S6), so such an entry is never copied. Claudio makes no OAuth request of its own:
 * every entry it writes is one the CLI wrote (the one rule).
 */

/** What Claudio copied into the account, so that only that is ever removed: `<account dir>/.claudio-sign-ins.json` */
export const SIGN_INS_RECORD = '.claudio-sign-ins.json';

/** The CLI's auth-failure cache, per dir: `{"<server name>": {"timestamp": ms}}`, which holds a copy off for 15 minutes (S6-T1) */
export const NEEDS_AUTH_CACHE = 'mcp-needs-auth-cache.json';

/** How a server treats its refresh token, as Claudio saw it refresh. No entry: not seen yet. */
export type Rotation = 'rotating' | 'stable';

/** A token's fingerprint: enough to tell that it changed, never enough to recover it */
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 16);

type Entry = Record<string, unknown>;

/** One server's entry as this module reasons about it: hashes and times, the entry itself kept only to be copied as it is */
interface Held {
  name: string;
  /** Hash of the access token; null for the CLI's emptied entry */
  access: string | null;
  refresh: string | null;
  expiresAt: number | null;
  entry: Entry;
}

/** What the reconciler wrote at a key: the hashes of the entry it copied */
export interface Copied {
  a: string;
  r?: string;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The server's name: the entry's own, else the key without its hash */
const nameOf = (key: string, entry: Entry): string => (nonEmpty(entry.serverName) ? entry.serverName : key.includes('|') ? key.slice(0, key.lastIndexOf('|')) : key);

const held = (key: string, entry: Entry): Held => ({
  name: nameOf(key, entry),
  access: nonEmpty(entry.accessToken) ? tokenHash(entry.accessToken) : null,
  refresh: nonEmpty(entry.refreshToken) ? tokenHash(entry.refreshToken) : null,
  expiresAt: typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) ? entry.expiresAt : null,
  entry,
});

/** A dir's credentials as read: `absent` when there is no file, `unreadable` when it is not a JSON object (then nothing is written) */
type Read = { state: 'absent' } | { state: 'unreadable' } | { state: 'ok'; text: string; entries: Map<string, Held> };

function readCredentialsFile(dir: string): Read {
  let text: string;
  try {
    text = readFileSync(join(dir, CREDENTIALS_FILE), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable' };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { state: 'unreadable' };
  }
  if (!isRecord(doc)) return { state: 'unreadable' };
  const entries = new Map<string, Held>();
  if (isRecord(doc.mcpOAuth)) for (const [key, entry] of Object.entries(doc.mcpOAuth)) if (isRecord(entry)) entries.set(key, held(key, entry));
  return { state: 'ok', text, entries };
}

/** The entries of a dir, empty when its file is absent or unreadable: what the served state reads */
export function readMcpSignIns(dir: string): Map<string, Held> {
  const read = readCredentialsFile(dir);
  return read.state === 'ok' ? read.entries : new Map();
}

export function readSignInsRecord(dir: string): Map<string, Copied> {
  const record = new Map<string, Copied>();
  try {
    const doc: unknown = JSON.parse(readFileSync(join(dir, SIGN_INS_RECORD), 'utf8'));
    if (isRecord(doc) && isRecord(doc.copied)) {
      for (const [key, v] of Object.entries(doc.copied)) if (isRecord(v) && nonEmpty(v.a)) record.set(key, nonEmpty(v.r) ? { a: v.a, r: v.r } : { a: v.a });
    }
  } catch {
    // No record: nothing of the account's entries is Claudio's
  }
  return record;
}

export interface SignInPlan {
  /** Keys whose entry is copied from the default */
  copies: string[];
  /** Keys whose entry Claudio copied and now removes: the default dropped it, or the server turned out to rotate */
  removals: string[];
  /** Keys of the record whose entry is no longer Claudio's copy (the CLI or a person changed or removed it) */
  forget: string[];
  served: AccountSignIns;
}

/** Whether the account's entry at a key is still a copy of Claudio's: the same access token, or the same grant refreshed by the account's own CLI */
const isOurs = (t: Held | undefined, rec: Copied | undefined): boolean => !!t && !!rec && (t.access === rec.a || (rec.r !== undefined && t.refresh === rec.r));

const sortedNames = (names: Iterable<string>): string[] => [...new Set(names)].sort((a, b) => a.localeCompare(b));

/**
 * What would bring the account's `mcpOAuth` to the default's, from the two maps, the record of what
 * Claudio copied and the rotation learned per server. Pure: nothing is read or written.
 */
export function planSignIns(source: ReadonlyMap<string, Held>, target: ReadonlyMap<string, Held>, record: ReadonlyMap<string, Copied>, rotation: Readonly<Record<string, Rotation>>): SignInPlan {
  const copies: string[] = [];
  const removals: string[] = [];
  const forget: string[] = [];
  const missing: string[] = [];
  const rotating: string[] = [];
  const ownOnly: string[] = [];
  for (const [key, s] of source) {
    // The CLI's emptied entry is a failed sign-in: copying it would sign the account out too
    if (s.access === null) continue;
    const t = target.get(key);
    const rec = record.get(key);
    const copyable = s.refresh === null || rotation[key] === 'stable';
    if (!copyable) {
      // A server not proven to keep its refresh token needs a sign-in of the account's own; a copy of
      // Claudio's still untouched there is the stale grant a rotation revokes everything on, so it goes
      if (rotation[key] === 'rotating' && t && rec && t.access === rec.a) removals.push(key);
      if (!t || t.access === null || (rotation[key] === 'rotating' && rec && t.access === rec.a)) rotating.push(s.name);
      continue;
    }
    const untouched = !!t && !!rec && t.access === rec.a;
    const older = !!t && t.expiresAt !== null && s.expiresAt !== null && t.expiresAt < s.expiresAt;
    if (!t || t.access === null || older || (untouched && s.access !== rec?.a)) {
      copies.push(key);
      missing.push(s.name);
    }
  }
  for (const [key, rec] of record) {
    const t = target.get(key);
    if (removals.includes(key)) continue;
    if (!isOurs(t, rec)) {
      forget.push(key);
      continue;
    }
    if (!source.has(key)) removals.push(key);
  }
  for (const [key, t] of target) {
    if (t.access === null || isOurs(t, record.get(key)) || source.get(key)?.access) continue;
    ownOnly.push(t.name);
  }
  return { copies, removals, forget, served: { missing: sortedNames(missing), ownOnly: sortedNames(ownOnly), rotating: sortedNames(rotating) } };
}

/** What a dir's state was at the last look, per key: the hashes of its two tokens */
type Seen = Record<string, { a: string; r: string }>;

export interface SignInsState {
  servers: Record<string, Rotation>;
  /** Per account id (`default` for the source) */
  seen: Record<string, Seen>;
}

/**
 * Learns how each server treats its refresh token from what the CLI wrote since the last look: the
 * access token changed and the refresh token stayed means the server keeps it (`stable`); the refresh
 * token changed means it rotates. A fresh sign-in also changes both, and is read as rotating: a server
 * wrongly held rotating costs one sign-in per account, one wrongly held stable can sign out all of
 * them. So `rotating` is never undone. With `infer` false the hashes are only remembered: what Claudio
 * itself wrote is no refresh of the CLI's. Returns whether the state changed.
 */
export function learnRotation(state: SignInsState, account: string, entries: ReadonlyMap<string, Held>, infer = true): boolean {
  let changed = false;
  const before = state.seen[account] ?? {};
  const after: Seen = {};
  for (const [key, h] of entries) {
    if (h.access === null || h.refresh === null) continue;
    after[key] = { a: h.access, r: h.refresh };
    const prev = before[key];
    if (!prev || !infer) continue;
    if (prev.r !== h.refresh) {
      if (state.servers[key] !== 'rotating') {
        state.servers[key] = 'rotating';
        changed = true;
      }
    } else if (prev.a !== h.access && state.servers[key] === undefined) {
      state.servers[key] = 'stable';
      changed = true;
    }
  }
  if (JSON.stringify(after) !== JSON.stringify(before)) changed = true;
  if (Object.keys(after).length) state.seen[account] = after;
  else delete state.seen[account];
  return changed;
}

/** The byte range of each member's value in a JSON object's text, so one member can be replaced and every other kept as it was written */
function memberValueRange(text: string, member: string): { start: number; end: number; close: number; empty: boolean } | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i] ?? '')) i += 1;
  };
  const str = (): string => {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = () => {
    const c = text[i];
    if (c === '"') {
      str();
      return;
    }
    if (c === '{' || c === '[') {
      let depth = 0;
      while (i < text.length) {
        const d = text[i];
        if (d === '"') {
          str();
          continue;
        }
        if (d === '{' || d === '[') depth += 1;
        else if (d === '}' || d === ']') depth -= 1;
        i += 1;
        if (depth === 0) return;
      }
      return;
    }
    while (i < text.length && !/[\s,}\]]/.test(text[i] ?? '')) i += 1;
  };
  ws();
  if (text[i] !== '{') return null;
  i += 1;
  let found: { start: number; end: number } | null = null;
  let members = 0;
  for (;;) {
    ws();
    if (text[i] === '}') break;
    if (text[i] !== '"') return null;
    const name = str();
    ws();
    if (text[i] !== ':') return null;
    i += 1;
    ws();
    const start = i;
    value();
    members += 1;
    if (name === member) found = { start, end: i };
    ws();
    if (text[i] === ',') i += 1;
    else if (text[i] !== '}') return null;
  }
  return { start: found?.start ?? -1, end: found?.end ?? -1, close: i, empty: members === 0 };
}

/**
 * The credentials file's text with `mcpOAuth` set to `entries`, every other byte as it was: the login
 * (`claudeAiOauth`) is not parsed into anything and written back, it is left where it is.
 */
export function withMcpOAuth(text: string | null, entries: Record<string, unknown>): string {
  const value = JSON.stringify(entries);
  if (text === null) return JSON.stringify({ mcpOAuth: entries });
  const range = memberValueRange(text, 'mcpOAuth');
  if (!range) throw new Error('the credentials file is not a JSON object this can edit');
  if (range.start >= 0) return text.slice(0, range.start) + value + text.slice(range.end);
  return `${text.slice(0, range.close)}${range.empty ? '' : ','}"mcpOAuth":${value}${text.slice(range.close)}`;
}

/** A plain file or nothing: a link is someone else's file, which a rename would cut off and a write would reach through */
const isLink = (file: string): boolean => {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Written beside the target and renamed over it, so the CLI never reads half a file; the mode is set before the rename */
function writeAtomicSync(file: string, content: string, mode: number): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode });
    // The umask can only take bits away; this makes the mode exactly the one asked for
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never made
    }
    throw error;
  }
}

/** The mode a file has now, to keep it when it is rewritten; `fallback` for a file not there */
const modeOf = (file: string, fallback: number): number => {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return fallback;
  }
};

/**
 * Drops the lines of `names` from the dir's auth-failure cache, keeping every other: a line younger
 * than 15 minutes keeps the CLI from using a copied entry (S6-T1). No file, nothing to do.
 */
export function clearNeedsAuth(dir: string, names: readonly string[]): boolean {
  const file = join(dir, NEEDS_AUTH_CACHE);
  if (!names.length || !existsSync(file) || isLink(file)) return false;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (!isRecord(doc)) return false;
  const kept = Object.fromEntries(Object.entries(doc).filter(([name]) => !names.includes(name)));
  if (Object.keys(kept).length === Object.keys(doc).length) return false;
  writeAtomicSync(file, JSON.stringify(kept), modeOf(file, 0o600));
  return true;
}

export interface SignInTarget {
  id: string;
  dir: string;
}

export interface SignInReconcilerOptions {
  /** The default account's config dir: the source, only ever read */
  defaultDir: string;
  /** Where the rotation learned per server is kept (hashes, never a token) */
  stateFile: string;
  /** The shared accounts, not the default, none of them mid-switch */
  targets: () => SignInTarget[];
  /** Whether no live chat runs on the account; a running CLI never has its credentials file written under it */
  idle: (account: string) => boolean;
  /** Whether copies are stopped: the canary's `s6` check failed on the CLI in use, so the format is not the one this writes */
  stopped: () => boolean;
  log: (line: string) => void;
  /** An account's sign-ins changed: what is served reads them again */
  changed?: () => void;
  closed?: () => boolean;
  /** How long the default's file stays quiet before a pass; default 2 s */
  debounceMs?: number;
  /** How long a deferred account waits before it is looked at again; default 2 minutes */
  retryMs?: number;
}

const DEBOUNCE_MS = 2_000;
const RETRY_MS = 120_000;
const SOURCE_ID = 'default';

export type SignInOutcome = 'noop' | 'done' | 'deferred' | 'stopped' | 'skipped';

/**
 * Keeps the MCP sign-ins of every shared account at the default's. A pass runs before every spawn on a
 * shared account (`beforeSpawn`, from the store's `ref`), when the default's credentials file changes
 * (watched, debounced), after a CLI of a shared account exits (`nudge`), and on a slow timer that
 * exists only while an account waits for its live chat to end. Everything is synchronous: the files are
 * a few kilobytes, and the spawn that asked must find the copy in place.
 */
export class SignInReconciler {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;
  private state: SignInsState | null = null;
  private readonly said = new Set<string>();

  constructor(private readonly opts: SignInReconcilerOptions) {}

  /** Watches the default's credentials file and runs the first pass after the debounce */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const dir = this.opts.defaultDir;
    if (existsSync(dir)) {
      try {
        // The CLI writes the file by a rename, which a watch on the file itself would lose
        this.watcher = watch(dir, (_event, name) => {
          if (name && String(name) === CREDENTIALS_FILE) this.nudge();
        });
        this.watcher.on('error', () => undefined);
      } catch (error) {
        this.sayOnce(`watch:${dir}`, `sign-ins: cannot watch ${dir}: ${errorMessage(error)}`);
      }
    }
    this.nudge();
  }

  /** Something may have changed (a CLI of a shared account exited, the canary ran): a pass after the debounce */
  nudge(): void {
    if (!this.started || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, this.opts.debounceMs ?? DEBOUNCE_MS);
    this.timer.unref();
  }

  close(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = this.retry = null;
  }

  /** One pass over every shared account */
  run(): void {
    if (!this.started || this.stopped || this.opts.closed?.()) return;
    const source = this.observeSource();
    if (!source) return;
    let deferred = false;
    for (const target of this.opts.targets()) {
      if (this.stopped || this.opts.closed?.()) return;
      if (this.account(target, source) === 'deferred') deferred = true;
    }
    this.saveState();
    if (deferred && !this.retry && !this.stopped) {
      this.retry = setTimeout(() => {
        this.retry = null;
        this.run();
      }, this.opts.retryMs ?? RETRY_MS);
      this.retry.unref();
    }
  }

  /** The account a CLI is about to start on: its copies are made now, so the spawn finds them */
  beforeSpawn(target: SignInTarget): SignInOutcome {
    if (!this.started || this.stopped || this.opts.closed?.()) return 'skipped';
    const source = this.observeSource();
    if (!source) return 'skipped';
    const outcome = this.account(target, source);
    this.saveState();
    if (outcome === 'deferred' && !this.retry) {
      this.retry = setTimeout(() => {
        this.retry = null;
        this.run();
      }, this.opts.retryMs ?? RETRY_MS);
      this.retry.unref();
    }
    return outcome;
  }

  /** How the account's sign-ins stand against the default's, read from the files with nothing written */
  diff(dir: string): AccountSignIns {
    return planSignIns(readMcpSignIns(this.opts.defaultDir), readMcpSignIns(dir), readSignInsRecord(dir), this.loadState().servers).served;
  }

  /** The rotation learned so far, per `mcpOAuth` key */
  rotation(): Readonly<Record<string, Rotation>> {
    return this.loadState().servers;
  }

  private observeSource(): Map<string, Held> | null {
    const read = readCredentialsFile(this.opts.defaultDir);
    if (read.state === 'unreadable') {
      this.sayOnce('source/unreadable', `sign-ins: the default account's ${CREDENTIALS_FILE} is not a JSON object; no sign-in is copied until it is`);
      return null;
    }
    this.said.delete('source/unreadable');
    const entries = read.state === 'ok' ? read.entries : new Map<string, Held>();
    learnRotation(this.loadState(), SOURCE_ID, entries);
    return entries;
  }

  private account(target: SignInTarget, source: ReadonlyMap<string, Held>): SignInOutcome {
    try {
      return this.reconcile(target, source);
    } catch (error) {
      this.sayOnce(`${target.id}/failed/${errorMessage(error).slice(0, 120)}`, `sign-ins: ${target.id} could not be reconciled: ${errorMessage(error)}`);
      return 'noop';
    }
  }

  private reconcile(target: SignInTarget, source: ReadonlyMap<string, Held>): SignInOutcome {
    const file = join(target.dir, CREDENTIALS_FILE);
    if (isLink(file) || isLink(join(target.dir, SIGN_INS_RECORD))) {
      this.sayOnce(`${target.id}/link`, `sign-ins: ${target.id}'s ${CREDENTIALS_FILE} or ${SIGN_INS_RECORD} is a link; its MCP sign-ins are left as they are`);
      return 'noop';
    }
    const read = readCredentialsFile(target.dir);
    if (read.state === 'unreadable') {
      this.sayOnce(`${target.id}/unreadable`, `sign-ins: ${target.id}'s ${CREDENTIALS_FILE} is not a JSON object; its MCP sign-ins are left as they are`);
      return 'noop';
    }
    this.said.delete(`${target.id}/unreadable`);
    const entries = read.state === 'ok' ? read.entries : new Map<string, Held>();
    const state = this.loadState();
    learnRotation(state, target.id, entries);
    const record = readSignInsRecord(target.dir);
    const plan = planSignIns(source, entries, record, state.servers);
    if (!plan.copies.length && !plan.removals.length) {
      // Claudio's own record, not a file the CLI reads: kept true whatever runs on the account
      if (plan.forget.length) {
        for (const key of plan.forget) record.delete(key);
        this.writeRecord(target.dir, record);
      }
      return 'noop';
    }
    if (this.opts.stopped()) {
      this.sayOnce(`${target.id}/stopped`, `sign-ins: the CLI canary's s6 check failed; ${target.id}'s MCP sign-ins are not copied`);
      return 'stopped';
    }
    this.said.delete(`${target.id}/stopped`);
    if (!this.opts.idle(target.id)) {
      this.sayOnce(`${target.id}/deferred`, `sign-ins: ${target.id} has a live chat; its MCP sign-ins wait until it is idle`);
      return 'deferred';
    }
    this.said.delete(`${target.id}/deferred`);
    const next: Record<string, unknown> = {};
    for (const [key, h] of entries) next[key] = h.entry;
    for (const key of plan.removals) delete next[key];
    for (const key of plan.copies) {
      const s = source.get(key);
      if (s) next[key] = s.entry;
    }
    const text = withMcpOAuth(read.state === 'ok' ? read.text : null, next);
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error('the edited credentials file is not an object');
    writeAtomicSync(file, text, 0o600);
    for (const key of [...plan.removals, ...plan.forget]) record.delete(key);
    const names: string[] = [];
    for (const key of plan.copies) {
      const s = source.get(key);
      if (!s?.access) continue;
      record.set(key, s.refresh ? { a: s.access, r: s.refresh } : { a: s.access });
      names.push(s.name);
    }
    this.writeRecord(target.dir, record);
    clearNeedsAuth(target.dir, names);
    // What Claudio wrote is not the CLI refreshing: the next look must not read it as a rotation
    learnRotation(state, target.id, readMcpSignIns(target.dir), false);
    const what = [plan.copies.length ? `copied ${sortedNames(names).join(', ')}` : '', plan.removals.length ? `removed ${plan.removals.length} entr${plan.removals.length === 1 ? 'y' : 'ies'} Claudio had copied` : ''].filter(Boolean).join('; ');
    this.opts.log(`sign-ins: ${target.id}: ${what}`);
    this.opts.changed?.();
    return 'done';
  }

  private writeRecord(dir: string, record: ReadonlyMap<string, Copied>): void {
    const file = join(dir, SIGN_INS_RECORD);
    if (record.size === 0 && !existsSync(file)) return;
    writeAtomicSync(file, `${JSON.stringify({ copied: Object.fromEntries([...record].sort(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`, 0o600);
  }

  private loadState(): SignInsState {
    if (this.state) return this.state;
    const state: SignInsState = { servers: {}, seen: {} };
    try {
      const doc: unknown = JSON.parse(readFileSync(this.opts.stateFile, 'utf8'));
      if (isRecord(doc)) {
        if (isRecord(doc.servers)) for (const [key, v] of Object.entries(doc.servers)) if (v === 'rotating' || v === 'stable') state.servers[key] = v;
        if (isRecord(doc.seen)) {
          for (const [account, keys] of Object.entries(doc.seen)) {
            if (!isRecord(keys)) continue;
            const seen: Seen = {};
            for (const [key, v] of Object.entries(keys)) if (isRecord(v) && nonEmpty(v.a) && nonEmpty(v.r)) seen[key] = { a: v.a, r: v.r };
            state.seen[account] = seen;
          }
        }
      }
    } catch {
      // Nothing learned yet
    }
    this.state = state;
    this.savedAs = JSON.stringify(state);
    return state;
  }

  private savedAs = '';

  private saveState(): void {
    const state = this.loadState();
    const text = JSON.stringify(state);
    if (text === this.savedAs) return;
    try {
      if (!existsSync(dirname(this.opts.stateFile))) return;
      writeAtomicSync(this.opts.stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
      this.savedAs = text;
    } catch (error) {
      this.sayOnce(`state/${errorMessage(error).slice(0, 120)}`, `sign-ins: could not keep what was learned of MCP servers in ${this.opts.stateFile}: ${errorMessage(error)}`);
    }
  }

  private sayOnce(key: string, line: string): void {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.opts.log(line);
  }
}
