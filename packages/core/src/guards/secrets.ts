/*
 * High-confidence secret patterns for the `secrets` rule. A superset of the high-confidence part of
 * `decisions/redact.ts`; a test checks that. Every regex is linear: no nested quantifiers, and the
 * private-key pattern stops at the header. Only `node:` imports.
 */
import { createHash } from 'node:crypto';

export interface SecretPattern {
  id: string;
  regex: RegExp;
}

const GITLAB = 'gl(?:pat|oas|rt|dt|ptt|ft|imt|agent|cbt|soat|ffct|wt)-';

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'private-key', regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { id: 'anthropic-key', regex: /sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-like-key', regex: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { id: 'github-token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { id: 'gitlab-token', regex: new RegExp(`\\b${GITLAB}[A-Za-z0-9_-]{20,}|\\bGR1348941[A-Za-z0-9_-]{20,}`, 'g') },
  { id: 'slack-token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe-key', regex: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g },
  { id: 'npm-token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'claudio-chat-token', regex: /\bagc_[A-Za-z0-9_-]{20,}/g },
];

/** The same word shape as the masker's `TOKEN_WORD` */
const TOKEN_WORD = /[A-Za-z0-9_~+/=-][A-Za-z0-9._~+/=-]{22,}[A-Za-z0-9_~+/=-]/g;
const MAX_MATCHES = 64;

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
  for (const { id, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    for (let match = regex.exec(text); match !== null && out.length < MAX_MATCHES; match = regex.exec(text)) {
      const value = match[0];
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
