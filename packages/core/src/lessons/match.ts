import type { Lesson, LessonStatus } from '@claudio/shared';

/*
 * When two lessons say the same (docs/plans/lessons.md, "Matching, duplicates and contradictions").
 * Pure: a normal form, a similarity, and the table that says what a checked candidate becomes
 * against the lessons of its project.
 */

/** At or above this two lessons are the same lesson */
export const SAME_AT = 0.75;
/** At or above this, and below {@link SAME_AT}, two lessons are similar */
export const SIMILAR_AT = 0.45;
/** Two lessons with code tokens and none in common, or only one of them negated, are never above this: "use `pnpm`" is not "use `yarn`", nor "never sign" "sign" */
const DIFFERENT_CODE_CAP = 0.44;
const NEGATIONS: ReadonlySet<string> = new Set(['not', 'no', 'never', 'dont', 'doesnt', 'shouldnt', 'cant', 'cannot', 'avoid', 'without', 'stop']);

/** Words that carry no rule: dropped before the sets are compared. Negations stay: "sign commits" and "never sign commits" are opposites. */
export const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an the and or but if then else of to in on at by for from with without into onto over under as is are was were be been being ' +
    'it its this that these those there here when whenever while where which who whom what how why do does did done doing have has had ' +
    'should would could can will shall may might must so than too very also just only any all each every some such you your ' +
    'we our they them their he she his her i me my one'
  ).split(' '),
);

const CODE_SPAN = /`([^`\n]*)`/g;

/** Light stem: a final `ing`, `ed`, `es` or `s` goes from a word longer than four letters */
function stem(word: string): string {
  // A path, a flag or a version is a name, not a word
  if (word.length <= 4 || /[\d._/-]/.test(word)) return word;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

/** The normal form of a text: its words, stemmed, and its inline code spans as code tokens */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  // Apostrophes go, so that "don't" is one word
  const folded = text.normalize('NFC').toLowerCase().replace(/['’]/g, '');
  const prose = folded.replace(CODE_SPAN, (_span, code: string) => {
    const t = code.trim();
    if (t) out.add(`\`${t}\``);
    return ' ';
  });
  // Punctuation becomes a space, except inside a run of the characters a path or a flag is made of
  const words = prose.replace(/[^\p{L}\p{N}._/-]+/gu, ' ').split(' ');
  for (const raw of words) {
    const word = raw.replace(/^[._/-]+|[._/-]+$/g, '');
    if (!word || ENGLISH_STOPWORDS.has(word)) continue;
    out.add(stem(word));
  }
  return out;
}

const isCode = (token: string): boolean => token.startsWith('`');

export interface Worded {
  trigger: string;
  action: string;
}

/** Jaccard index of the token sets of `trigger + ' ' + action`, with the code cap */
export function similarity(a: Worded, b: Worded): number {
  const x = tokens(`${a.trigger} ${a.action}`);
  const y = tokens(`${b.trigger} ${b.action}`);
  if (x.size === 0 && y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  const sim = shared / (x.size + y.size - shared);
  if ([...x].some((t) => NEGATIONS.has(t)) !== [...y].some((t) => NEGATIONS.has(t))) return Math.min(sim, DIFFERENT_CODE_CAP);
  const codeX = [...x].filter(isCode);
  const codeY = [...y].filter(isCode);
  if (codeX.length > 0 && codeY.length > 0 && !codeX.some((t) => y.has(t))) return Math.min(sim, DIFFERENT_CODE_CAP);
  return sim;
}

/** What a candidate becomes against its project's lessons */
export type MatchKind =
  /** Same as an active lesson: it is confirmed again, no proposal */
  | 'merge'
  /** Same as a proposal that waits: the evidence joins it */
  | 'append'
  /** Same as a lesson the person rejected: dropped */
  | 'duplicate-rejected'
  /** Same as a retired or superseded lesson: a proposal that brings it back */
  | 'revive'
  /** Similar to an active lesson: a proposal that offers "Merge into" or "Keep both" */
  | 'similar'
  /** The model says it goes against an active lesson: a proposal that needs a decision about it */
  | 'contradicts'
  | 'new';

export interface Match {
  kind: MatchKind;
  /** The lesson the result is about; null for `new` */
  lesson: Lesson | null;
  sim: number;
}

export interface MatchCandidate extends Worded {
  /** The model's claim, as `L-<seq>`; only a claim */
  restates: string | null;
  contradicts: string | null;
}

/** Active first, then a waiting proposal, then what was refused, then what is gone: on a tie the live one wins */
const RANK: Record<LessonStatus, number> = { active: 0, proposed: 1, rejected: 2, retired: 3, superseded: 3 };

function best(candidate: Worded, lessons: readonly Lesson[]): { lesson: Lesson; sim: number } | null {
  let found: { lesson: Lesson; sim: number } | null = null;
  for (const lesson of lessons) {
    const sim = similarity(candidate, lesson);
    if (!found || sim > found.sim || (sim === found.sim && RANK[lesson.status] < RANK[found.lesson.status])) found = { lesson, sim };
  }
  return found;
}

/**
 * Matches one checked candidate. `lessons` are the project's own and the global ones; a lesson of
 * another project must not be in it. The model's `restates` and `contradicts` are claims about
 * text it was shown, so `restates` only counts with a similarity of its own, and `contradicts` only
 * when it names an active lesson of the list.
 */
export function matchCandidate(candidate: MatchCandidate, lessons: readonly Lesson[]): Match {
  // Asked first: a rule that goes against an active lesson must reach the person, however alike the words are
  const claimed = candidate.contradicts ? lessons.find((l) => l.key === candidate.contradicts && l.status === 'active') : undefined;
  if (claimed) return { kind: 'contradicts', lesson: claimed, sim: similarity(candidate, claimed) };
  const top = best(candidate, lessons);
  if (top && top.sim >= SAME_AT) {
    const { lesson, sim } = top;
    switch (lesson.status) {
      case 'active':
        return { kind: 'merge', lesson, sim };
      case 'proposed':
        return { kind: 'append', lesson, sim };
      case 'rejected':
        return { kind: 'duplicate-rejected', lesson, sim };
      default:
        return { kind: 'revive', lesson, sim };
    }
  }
  if (top && top.sim >= SIMILAR_AT && top.lesson.status === 'active') return { kind: 'similar', lesson: top.lesson, sim: top.sim };
  const restated = candidate.restates ? lessons.find((l) => l.key === candidate.restates && l.status === 'active') : undefined;
  if (restated) {
    const sim = similarity(candidate, restated);
    // The model's claim is not enough on its own
    if (sim >= SIMILAR_AT) return { kind: 'similar', lesson: restated, sim };
  }
  return { kind: 'new', lesson: null, sim: top?.sim ?? 0 };
}

/** Active lessons of other projects that say the same as `lesson`, for the "Make global" hint */
export function alsoInProjects(lesson: Worded, others: readonly Pick<Lesson, 'trigger' | 'action' | 'status'>[]): number {
  return others.filter((o) => o.status === 'active' && similarity(lesson, o) >= SAME_AT).length;
}
