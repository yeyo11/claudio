import type { Chat, ChatSessionNote, CompactRefusal, ContextBreakdown, ContextCategory } from '@claudio/shared';

/** More servers than this and the rest fold away: a chat can carry fifty of them (E29) */
export const MCP_SERVERS_SHOWN = 12;
/** The journal refuses a longer entry (`JOURNAL_ENTRY_MAX` in core); the counter and the save button follow it */
export const JOURNAL_ENTRY_MAX = 8_000;
const PATH_MAX = 52;

export interface CompactState {
  available: boolean;
  refusal: CompactRefusal | null;
  /** A compaction (or the note turn that shares its slot) is running now */
  running: boolean;
}

/**
 * What the chat says about Compact now. A chat read without the flag (a list row) is treated as
 * not offered; one that never answered has nothing to compact.
 */
export function compactState(chat: Pick<Chat, 'compact' | 'context'>): CompactState {
  const { compact } = chat;
  const running = compact?.open ? compact.open.state === 'requested' || compact.open.state === 'running' : false;
  if (!compact) return { available: false, refusal: chat.context ? null : 'no-history', running };
  return { available: compact.available, refusal: compact.refusal, running };
}

export interface CategoryGroups {
  /** The rows that fill the window, in the order the CLI gave them */
  used: ContextCategory[];
  /** Free space and the compaction reserve: last, and muted */
  spare: ContextCategory[];
  /** Tool schemas kept out of the window: outside every sum */
  deferred: ContextCategory[];
}

/** Rows are told apart by `kind`, never by their English name (D11). */
export function categoryGroups(categories: ContextCategory[]): CategoryGroups {
  return {
    used: categories.filter((c) => c.kind === 'used'),
    spare: categories.filter((c) => c.kind === 'free' || c.kind === 'buffer'),
    deferred: categories.filter((c) => c.kind === 'deferred'),
  };
}

/** A share as the panel writes it: whole percent, and "<1 %" for what is there but small. `null` when the window is unknown. */
export function shareText(tokens: number, window: number | null, lessThanOne: string): string | null {
  if (window === null || window <= 0) return null;
  const share = tokens / window;
  if (tokens > 0 && share < 0.01) return lessThanOne;
  return `${Math.round(share * 100)} %`;
}

/** The window the share is measured against, or null when the CLI gave none. */
export function windowOf(breakdown: Pick<ContextBreakdown, 'rawMaxTokens' | 'maxTokens'>): number | null {
  if (breakdown.rawMaxTokens > 0) return breakdown.rawMaxTokens;
  return breakdown.maxTokens > 0 ? breakdown.maxTokens : null;
}

/** A path cut in the middle, so its start and its file name both stay readable. */
export function middleCut(path: string, max = PATH_MAX): string {
  if (path.length <= max) return path;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - (keep - head))}`;
}

/** The first line of a note that says something, without its Markdown heading marks. */
export function noteHeadline(note: Pick<ChatSessionNote, 'text'>, fallback: string): string {
  for (const line of (note.text ?? '').split('\n')) {
    const text = line.replace(/^[#>\-*\s]+/, '').trim();
    if (text) return text.length > 90 ? `${text.slice(0, 89)}…` : text;
  }
  return fallback;
}

const MASK = '[redacted]';
// The patterns of core's `decisions/redact.ts`: the browser cannot import core, and what Claudio
// itself holds (its own tokens) is masked by the server before anything reaches a prefill
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bagc_[A-Za-z0-9_-]{20,}/g,
];
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)[^\s"',;}]{4,}/gi;

/** A note is the model's text, which may carry what a page or a server said: a secret never goes into the journal by the prefill. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, MASK);
  out = out.replace(BEARER, (_match, scheme: string) => `${scheme} ${MASK}`);
  return out.replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}${MASK}`);
}
