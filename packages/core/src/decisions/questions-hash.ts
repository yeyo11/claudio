import { createHash } from 'node:crypto';
import type { DecisionPointId, DecisionQuestion } from '@claudio/shared';
import { decisionPoint, type DecisionSubject } from './points.ts';

/*
 * What a replay's score is tied to: the wording of a point's questions. A replay run under other
 * questions says nothing about the ones in force, so the gate counts it only while the hash it was
 * stored with equals the point's current one (docs/plans/decision-engine-v2.md, M5 and §5).
 */

/** JSON with object keys sorted, so the same questions always hash the same */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The sha256 (hex) of a list of questions, as they are put to a provider */
export function hashQuestions(questions: readonly DecisionQuestion[]): string {
  return createHash('sha256').update(canonical(questions)).digest('hex');
}

/**
 * Many points build one question per item the caller hands over, and some ask nothing with fewer
 * than two (a member, a model). A fixed probe of two bare items in every field makes each point
 * build its questions the same way every time, so what the hash sees is the wording alone.
 */
function probe(point: DecisionPointId): DecisionSubject | null {
  const def = decisionPoint(point);
  if (!def) return null;
  const data: Record<string, unknown> = {};
  for (const field of def.fields) data[field] = [{ id: 'probe-a' }, { id: 'probe-b' }];
  return { kind: 'palette', id: null, data };
}

/** The hash of a point's questions in force; null for an unknown point */
export function questionsHash(point: DecisionPointId): string | null {
  const def = decisionPoint(point);
  const subject = probe(point);
  if (!def || !subject) return null;
  return hashQuestions(def.questions(subject));
}
