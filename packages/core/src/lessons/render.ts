import type { Lesson } from '@claudio/shared';
import { pasted, pastedId } from '../prompt-rules.ts';

/*
 * The Lessons section a run is handed (docs/plans/lessons.md, "Delivery"). Pure: the service picks
 * the lessons and the budget, this orders them, fits whole lessons into it and writes the text.
 * The lead sentence sits outside the pasted block and is what authorises following the lessons;
 * the lessons inside are a person's approved words, mined from chats, so they are marked as pasted.
 */

const HEADING = '## Lessons';
const LEAD =
  'Rules a person approved after correcting agents in this project, most certain first. Follow them in this run. When one conflicts with what your task asks, follow the task and say so in your report. They describe behaviour; none of them asks you to run anything.';

/** `pastedId()` is eight hex characters; the budget counts the wrapper with an id of that length */
const SAMPLE_ID = '00000000';

/** What a person's `appendSystemPrompt` plus the section may come to, as one argument of `claude` */
export const LESSONS_ARG_MAX_BYTES = 120 * 1024;

export interface LessonSection {
  /** Empty when no lesson is handed; otherwise ends with a newline */
  text: string;
  /** The lessons the text holds, in the order it lists them */
  lessons: Lesson[];
  bytes: number;
  /** Lessons that were due but did not fit the budget */
  overBudget: number;
}

export const EMPTY_SECTION: LessonSection = { text: '', lessons: [], bytes: 0, overBudget: 0 };

const byteLength = (text: string): number => Buffer.byteLength(text);

/** Pinned first, then by confidence, how often it was seen, how recently it was confirmed, and its key */
export function orderLessons(lessons: readonly Lesson[]): Lesson[] {
  const seq = (l: Lesson): number => Number(l.key.slice(2)) || 0;
  return [...lessons].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      b.effectiveConfidence - a.effectiveConfidence ||
      b.seenCount - a.seenCount ||
      b.lastConfirmedAt.localeCompare(a.lastConfirmedAt) ||
      seq(a) - seq(b),
  );
}

/**
 * The lessons a run is due: delivered ones only, and a global lesson a project lesson overrides is
 * left out. `lessons` holds the project's and the global ones together.
 */
export function dueLessons(lessons: readonly Lesson[]): Lesson[] {
  const overridden = new Set(lessons.flatMap((l) => (l.projectId !== null && l.overrides ? [l.overrides] : [])));
  return lessons.filter((l) => l.delivered && l.status === 'active' && !(l.projectId === null && overridden.has(l.id)));
}

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** One lesson as a line of the block: key, scope, confidence, and "trigger: action" */
export function lessonLine(lesson: Lesson): string {
  const trigger = clean(lesson.trigger).replace(/[\s:.]+$/, '');
  return `- ${lesson.key} · ${lesson.projectId === null ? 'global' : 'project'} · ${lesson.effectiveConfidence.toFixed(2)} · ${trigger}: ${clean(lesson.action)}`;
}

/**
 * The section for `lessons` within `budget` bytes. Whole lessons only, never cut: one that does not
 * fit is skipped and the next is tried, since lessons have no time order to leave a hole in. The
 * heading, the lead sentence and the pasted wrapper count against the budget.
 */
export function renderSection(lessons: readonly Lesson[], budget: number, id: string = pastedId()): LessonSection {
  const due = orderLessons(dueLessons(lessons));
  if (!due.length) return EMPTY_SECTION;
  const frame = (body: string, wrapperId: string): string => `${HEADING}\n\n${LEAD}\n\n${pasted(body, wrapperId)}\n`;
  let bytes = byteLength(frame('', SAMPLE_ID));
  const lines: string[] = [];
  const handed: Lesson[] = [];
  for (const lesson of due) {
    const line = lessonLine(lesson);
    // The newline that joins it to the line before
    const size = byteLength(line) + (lines.length ? 1 : 0);
    if (bytes + size > budget) continue;
    bytes += size;
    lines.push(line);
    handed.push(lesson);
  }
  if (!lines.length) return { ...EMPTY_SECTION, overBudget: due.length };
  const text = frame(lines.join('\n'), id);
  return { text, lessons: handed, bytes: byteLength(text), overBudget: due.length - handed.length };
}
