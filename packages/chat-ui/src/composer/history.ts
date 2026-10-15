/**
 * The messages already sent in a chat, recalled with the arrow keys the way a shell recalls commands.
 * Up only does it from an empty box, or from one still showing what it recalled, with the caret at
 * its start: anywhere else the arrows move the caret, as they always do.
 */

/** How far back the arrows reach. */
export const HISTORY_LIMIT = 20;

/** Where the walk through the history is: `null` when the box shows what the person typed. */
export type HistoryIndex = number | null;

export interface HistoryStep {
  index: HistoryIndex;
  text: string;
}

/**
 * What ArrowUp or ArrowDown does to the box, or null when the key is the caret's. `history` is
 * oldest first; `index` counts back from its end (0 is the last message sent).
 */
export function historyStep(
  key: 'ArrowUp' | 'ArrowDown',
  { history, index, text, caret }: { history: readonly string[]; index: HistoryIndex; text: string; caret: number },
): HistoryStep | null {
  const shown = index === null ? null : history[history.length - 1 - index];
  const recalled = shown !== undefined && shown !== null && text === shown;
  if (key === 'ArrowUp') {
    if (caret !== 0 || !(text === '' || recalled)) return null;
    const next = index === null ? 0 : index + 1;
    const message = history[history.length - 1 - next];
    return message === undefined ? null : { index: next, text: message };
  }
  // Down walks back towards what was typed, from either end of what is shown (Up leaves the caret at its start)
  if (!recalled || (caret !== 0 && caret !== text.length) || index === null) return null;
  if (index === 0) return { index: null, text: '' };
  const message = history[history.length - index];
  return message === undefined ? null : { index: index - 1, text: message };
}
