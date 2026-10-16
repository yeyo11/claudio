import type { ReviewSeverity, ReviewSide } from '@claudio/shared';
import { maskSecrets } from './decisions/redact.ts';

/**
 * What the reviewers and the verifier answer through `--json-schema`, and the parsers that read it
 * back. The schemas are the contract with the model; the parsers never trust that the CLI held it
 * (docs/plans/review-gate.md, "Findings and verdict schemas"). The reviewer's output has no verdict
 * field on purpose: it reports findings and Claudio decides, so an injected "approve" has nowhere to go.
 */

const SEVERITIES: readonly ReviewSeverity[] = ['critical', 'high', 'medium', 'low'];

/** Reviewer output */
export const REVIEW_FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'coverage'],
  properties: {
    findings: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'file', 'evidence', 'failureScenario', 'confidence'],
        properties: {
          title: { type: 'string', minLength: 8, maxLength: 160 },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string', minLength: 1, maxLength: 400 },
          line: { type: 'integer', minimum: 1 },
          side: { type: 'string', enum: ['new', 'old'] },
          evidence: { type: 'string', minLength: 1, maxLength: 1500, description: 'The lines that cause it, quoted, and what you read to be sure' },
          failureScenario: { type: 'string', minLength: 1, maxLength: 1000, description: 'The input or state, and what goes wrong' },
          suggestion: { type: 'string', maxLength: 1000 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    coverage: {
      type: 'object',
      additionalProperties: false,
      required: ['complete'],
      properties: {
        complete: { type: 'boolean' },
        notReviewed: { type: 'string', maxLength: 600 },
        filesRead: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 400 } },
      },
    },
  },
} as const;

/** Verifier output */
export const REVIEW_VERDICTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'reason'],
        properties: {
          id: { type: 'string', maxLength: 40 },
          status: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
          reason: { type: 'string', minLength: 1, maxLength: 1200 },
          evidence: { type: 'string', maxLength: 1200 },
        },
      },
    },
  },
} as const;

/** One finding as the reviewer gave it, normalised */
export interface ParsedFinding {
  title: string;
  severity: ReviewSeverity;
  /** Repository-relative POSIX path; null when the reviewer's path was refused (absolute or holding `..`) */
  path: string | null;
  line: number | null;
  /** `new` maps to `right` and `old` to `left`; a line without a side is on the new version */
  side: ReviewSide | null;
  evidence: string;
  failureScenario: string;
  suggestion: string | null;
  confidence: number;
}

export interface ParsedCoverage {
  complete: boolean;
  notReviewed: string | null;
  filesRead: string[];
}

export interface ParsedFindings {
  /** The output had the shape of the schema and, when it held findings, at least one survived */
  ok: boolean;
  findings: ParsedFinding[];
  coverage: ParsedCoverage;
  /** Findings dropped for a missing or invalid required field */
  dropped: number;
}

export type ParsedVerdictStatus = 'confirmed' | 'refuted' | 'uncertain' | 'unverified';

export interface ParsedVerdict {
  id: string;
  status: ParsedVerdictStatus;
  reason: string;
  evidence: string | null;
}

export interface ParsedVerdicts {
  ok: boolean;
  /** One per asked id, in the order asked */
  verdicts: ParsedVerdict[];
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Trimmed, masked, then cut to the schema's maximum: masking first so a cut cannot leave half a secret */
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? maskSecrets(value.trim()).slice(0, max).trim() : '';
}

/**
 * A path as the diff names it. Null for one that is absolute or climbs out (`..`): the finding keeps
 * its place in the list but has no file to anchor to.
 */
export function normalizeReviewPath(raw: string): string | null {
  let path = raw.trim().replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return null;
  while (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/^[ab]\//, '').replace(/\/{2,}/g, '/');
  const parts = path.split('/').filter((part) => part !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

function parseFinding(raw: unknown): ParsedFinding | null {
  const item = asRecord(raw);
  if (!item) return null;
  const title = text(item.title, 160);
  const evidence = text(item.evidence, 1500);
  const failureScenario = text(item.failureScenario, 1000);
  const file = text(item.file, 400);
  const severity = SEVERITIES.find((s) => s === item.severity);
  if (title.length < 8 || !evidence || !failureScenario || !file || !severity) return null;
  if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)) return null;
  const line = typeof item.line === 'number' && Number.isInteger(item.line) && item.line >= 1 ? item.line : null;
  // A side means nothing without a line
  const side: ReviewSide | null = line === null ? null : item.side === 'old' ? 'left' : 'right';
  const suggestion = text(item.suggestion, 1000);
  return {
    title,
    severity,
    path: normalizeReviewPath(file),
    line,
    side,
    evidence,
    failureScenario,
    suggestion: suggestion || null,
    confidence: Math.min(1, Math.max(0, item.confidence)),
  };
}

/** The reviewer's structured output, from the object or the string the CLI carried it in */
export function parseFindings(raw: unknown): ParsedFindings {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  const root = asRecord(value);
  const coverage = asRecord(root?.coverage);
  if (!root || !Array.isArray(root.findings) || !coverage || typeof coverage.complete !== 'boolean') {
    return { ok: false, findings: [], coverage: { complete: false, notReviewed: null, filesRead: [] }, dropped: 0 };
  }
  const findings: ParsedFinding[] = [];
  let dropped = 0;
  for (const item of root.findings.slice(0, 25)) {
    const parsed = parseFinding(item);
    if (parsed) findings.push(parsed);
    else dropped += 1;
  }
  dropped += Math.max(0, root.findings.length - 25);
  const notReviewed = text(coverage.notReviewed, 600);
  const filesRead = Array.isArray(coverage.filesRead)
    ? coverage.filesRead
        .slice(0, 200)
        .map((file) => text(file, 400))
        .filter(Boolean)
    : [];
  return {
    ok: root.findings.length === 0 || findings.length > 0,
    findings,
    coverage: { complete: coverage.complete, notReviewed: notReviewed || null, filesRead },
    dropped,
  };
}

/**
 * The verifier's structured output, against the ids that were asked. An id it did not answer, or
 * answered in a way that does not parse, is `unverified`, which blocks like `uncertain` (D9).
 */
export function parseVerdicts(raw: unknown, askedIds: readonly string[]): ParsedVerdicts {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  const root = asRecord(value);
  const list = root && Array.isArray(root.verdicts) ? root.verdicts : null;
  const byId = new Map<string, ParsedVerdict>();
  for (const entry of list ?? []) {
    const item = asRecord(entry);
    if (!item || typeof item.id !== 'string') continue;
    const id = item.id.trim();
    const status = (['confirmed', 'refuted', 'uncertain'] as const).find((s) => s === item.status);
    const reason = text(item.reason, 1200);
    if (!askedIds.includes(id) || byId.has(id) || !status || !reason) continue;
    byId.set(id, { id, status, reason, evidence: text(item.evidence, 1200) || null });
  }
  return {
    ok: list !== null,
    verdicts: askedIds.map(
      (id) => byId.get(id) ?? { id, status: 'unverified', reason: 'The verifier gave no usable verdict for this finding.', evidence: null },
    ),
  };
}
