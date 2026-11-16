// The quit question (D1 of docs/plans/survive-restarts.md): quitting with work live asks, and keeps
// working by default; with nothing live it stops the server as it always did. The page asks it as a
// dialog of the design system; a page that cannot (an older payload, the splash or error page, no
// window) gets the native dialog instead. Free of Electron, so the rules are tested alone.
import { workWords, type LiveWork } from './updater.ts';

export type QuitAnswer = 'keep' | 'stop' | 'cancel';

/** What a quit does before anything is asked */
export type QuitPlan =
  /** Work is live: the person chooses */
  | 'ask'
  /** Nothing is live: the server and the daemon stop, as before layer 1 */
  | 'stop-work'
  /** No daemon this window reached: there is nothing to stop or keep */
  | 'leave';

export function quitPlan(work: LiveWork | null): QuitPlan {
  if (work === null) return 'leave';
  return workWords(work) === null ? 'stop-work' : 'ask';
}

/** What the window does with the daemon once the person answered: keep it running, or stop it and its work */
export function quitAction(answer: QuitAnswer): 'keep' | 'stop-work' | null {
  if (answer === 'cancel') return null;
  return answer === 'keep' ? 'keep' : 'stop-work';
}

/** The notice the system shows once the window has gone and the work goes on; the page's copy when it asked */
export interface QuitNotice {
  title: string;
  body: string;
}

/** The page's answer, checked rather than trusted: anything unreadable is a cancel, which loses nothing */
export function parseQuitAnswer(raw: unknown): { answer: QuitAnswer; notice: QuitNotice | null } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const answer: QuitAnswer = r.answer === 'keep' || r.answer === 'stop' ? r.answer : 'cancel';
  const n = r.notice && typeof r.notice === 'object' ? (r.notice as Record<string, unknown>) : null;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() && v.length <= 300 ? v : null);
  const title = text(n?.title);
  const body = text(n?.body);
  return { answer, notice: title && body ? { title, body } : null };
}

/** The native dialog, for when the page cannot ask: the buttons in order of `QuitAnswer` */
export function nativeQuitDialog(work: LiveWork): { message: string; detail: string; buttons: string[]; answers: QuitAnswer[]; defaultId: number; cancelId: number } {
  return {
    message: 'Keep Claudio working after you quit?',
    detail: `${workWords(work) ?? 'Work is running'}. Claudio can keep it all running in the background, or stop it now.`,
    buttons: ['Keep working in the background', 'Stop all work and quit', 'Cancel'],
    answers: ['keep', 'stop', 'cancel'],
    defaultId: 0,
    cancelId: 2,
  };
}

export const NATIVE_NOTICE: QuitNotice = {
  title: 'Claudio keeps working',
  body: 'The work goes on in the background. Open Claudio to see it.',
};
