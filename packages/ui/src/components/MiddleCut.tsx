import { useFullTextTitle } from '../lib/full-text';

/** Below this the text is short enough that its start is as good as any part to keep */
const SPLIT_FROM = 16;
/** What stays whole at the end: the part of an id that tells two of them apart (a date, a suffix) */
const TAIL = 8;

/**
 * A literal on one line that, when the room is short, is cut in the middle so both its start and its
 * end stay (a model id, a hash). The end is a box of its own that never shrinks and the start takes
 * the ellipsis, so it is plain CSS: no measuring, no JS cut that goes stale when the box resizes.
 * The full text is the start's `title` while it is really cut (`FullText`'s rule, invariant I3).
 */
export function MiddleCut({ text, className = '' }: { text: string; className?: string }) {
  const ref = useFullTextTitle<HTMLElement>(text);
  const split = text.length > SPLIT_FROM;
  return (
    <span className={`middle-cut ${className}`.trimEnd()}>
      <span ref={ref} className="middle-cut-head">
        {split ? text.slice(0, -TAIL) : text}
      </span>
      {split && <span className="middle-cut-tail">{text.slice(-TAIL)}</span>}
    </span>
  );
}
