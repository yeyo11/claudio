/*
 * High-confidence secret patterns for the `secrets` rule. A superset of the high-confidence part of
 * `decisions/redact.ts`; a test checks that. Every regex is linear: no nested quantifiers, and every repeat is bounded (an unbounded one overflows the regexp stack on a 16 MiB run of word characters), and the
 * private-key pattern stops at the header. Only `node:` imports.
 */
import { createHash } from 'node:crypto';

export interface SecretPattern {
  id: string;
  regex: RegExp;
  /** Needles start with a rare letter on purpose: a text full of the needle's first letter is the slow case for a search.
   * One of these must be in the text for the pattern to match; checking them first is a fast skip on large input */
  needles: readonly string[];
}

const GITLAB = 'gl(?:pat|oas|rt|dt|ptt|ft|imt|agent|cbt|soat|ffct|wt)-';

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'private-key', regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, needles: ['-----BEGIN'] },
  { id: 'anthropic-key', regex: /sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,256}/g, needles: ['sk-ant-'] },
  { id: 'openai-like-key', regex: /sk-[A-Za-z0-9_-]{16,256}/g, needles: ['sk-'] },
  { id: 'github-token', regex: /gh[pousr]_[A-Za-z0-9]{16,256}/g, needles: ['hp_', 'ho_', 'hu_', 'hs_', 'hr_'] },
  { id: 'github-token', regex: /github_pat_[A-Za-z0-9_]{20,256}/g, needles: ['github_pat_'] },
  { id: 'gitlab-token', regex: new RegExp(`${GITLAB}[A-Za-z0-9_-]{20,256}|GR1348941[A-Za-z0-9_-]{20,256}`, 'g'), needles: ['gl', 'GR1348941'] },
  { id: 'slack-token', regex: /xox[abprs]-[A-Za-z0-9-]{10,256}/g, needles: ['xox'] },
  { id: 'aws-access-key', regex: /A[KS]IA[0-9A-Z]{16}/g, needles: ['KIA', 'SIA'] },
  { id: 'google-api-key', regex: /AIza[0-9A-Za-z_-]{35}/g, needles: ['Iza'] },
  { id: 'stripe-key', regex: /[sr]k_live_[0-9A-Za-z]{20,256}/g, needles: ['_live_'] },
  { id: 'npm-token', regex: /npm_[A-Za-z0-9]{36}/g, needles: ['npm_'] },
  { id: 'claudio-chat-token', regex: /agc_[A-Za-z0-9_-]{20,256}/g, needles: ['gc_'] },
];

/** The same word shape as the masker's `TOKEN_WORD` */
const TOKEN_WORD = /[A-Za-z0-9_~+/=-][A-Za-z0-9._~+/=-]{22,1024}[A-Za-z0-9_~+/=-]/g;
const MAX_MATCHES = 64;
const MAX_CANDIDATES = 2000;
const MAX_NEEDLE_HITS = 50_000;

export interface SecretMatch {
  /** The pattern id, or `known-secret` */
  id: string;
  /** The matched text. Never put it in a reason or a log. */
  value: string;
}

/** Documentation values, repeated characters and template slots */
export function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.includes('example') || lower.includes('xxxx') || lower.includes('your_') || lower.includes('${') || /<[^>]*>/.test(value)) return true;
  const body = value.slice(Math.max(value.lastIndexOf('-'), value.lastIndexOf('_')) + 1);
  return body.length > 0 && /^(.)\1*$/.test(body);
}

/** Text with `\xHH`, `\uHHHH` and `\u{…}` escapes decoded, for a literal written as an escape */
export function decodeCodeEscapes(text: string): string {
  return text.replace(/\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\u\{([0-9a-fA-F]{1,6})\}/g, (_m, a: string | undefined, b: string | undefined, c: string | undefined) => {
    const code = Number.parseInt(a ?? b ?? c ?? '0', 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function scan(text: string, known: ReadonlySet<string> | null, out: SecretMatch[]): void {
  for (const { id, regex, needles } of SECRET_PATTERNS) {
    let present = false;
    for (const needle of needles) {
      let at = text.indexOf(needle);
      for (let hits = 0; at >= 0; hits++) {
        present = true;
        // So many look-alikes cannot be told apart from one real secret hidden among them
        if (hits >= MAX_NEEDLE_HITS) {
          out.push({ id: 'scan-limit', value: '' });
          return;
        }
        at = text.indexOf(needle, at + needle.length);
      }
    }
    if (!present) continue;
    regex.lastIndex = 0;
    let candidates = 0;
    for (let match = regex.exec(text); match !== null && out.length < MAX_MATCHES; match = regex.exec(text)) {
      // A flood of look-alikes is a way to hide one real secret; past the cap the text is refused
      if (++candidates > MAX_CANDIDATES) {
        out.push({ id: 'scan-limit', value: '' });
        return;
      }
      const value = match[0];
      // `\b` before the prefix, checked here so the regex can start on a literal
      if (id !== 'private-key' && match.index > 0 && /[A-Za-z0-9_]/.test(text.charAt(match.index - 1)) && !value.startsWith('sk-ant-')) continue;
      // `\b` after a fixed-length key
      if ((id === 'aws-access-key' || id === 'google-api-key' || id === 'npm-token') && /[A-Za-z0-9_]/.test(text.charAt(match.index + value.length))) continue;
      if (isPlaceholder(value)) continue;
      // An OpenAI-style key has both a digit and a letter; plain words with a dash are not keys
      if (id === 'openai-like-key' && !(/\d/.test(value) && /[A-Za-z]/.test(value.slice(3)))) continue;
      out.push({ id, value });
    }
  }
  if (known && known.size > 0) {
    TOKEN_WORD.lastIndex = 0;
    for (let match = TOKEN_WORD.exec(text); match !== null && out.length < MAX_MATCHES; match = TOKEN_WORD.exec(text)) {
      const word = match[0];
      const hashed = (candidate: string): boolean => known.has(createHash('sha256').update(candidate).digest('hex'));
      // `KEY=value` is one token word, so the part after the first `=` is tried as well
      const eq = word.indexOf('=');
      const tail = eq >= 0 ? word.slice(eq + 1) : '';
      if (hashed(word)) out.push({ id: 'known-secret', value: word });
      else if (tail.length >= 24 && hashed(tail)) out.push({ id: 'known-secret', value: tail });
    }
  }
}

/** Every non-placeholder secret in `text`, also after decoding escapes; at most 64 */
export function findSecrets(text: string, known: ReadonlySet<string> | null = null): SecretMatch[] {
  const out: SecretMatch[] = [];
  scan(text, known, out);
  if (out.length === 0 && (text.includes('\\x') || text.includes('\\u'))) scan(decodeCodeEscapes(text), known, out);
  return out;
}
