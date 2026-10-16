import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { parseUnified } from '../../lib/diff';
import { DiffView } from './DiffView';

/** The rows `.call-diff` shows before its own scroll: 360 px of 20 px rows */
const ROWS_SHOWN = 18;

/**
 * The patch of one tool call, as the chat package's `Diff` slot: the comparator in Unified with the
 * gaps around it left out, wrapping on a phone, held to a height until the reader asks for all of it.
 */
export function DiffSlot({ path, patch }: { path: string; patch: string }) {
  const { t } = useTranslation('chat');
  const narrow = useMediaQuery(NARROW);
  const diff = useMemo(() => parseUnified(patch), [patch]);
  const [all, setAll] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const rows = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  const long = rows > ROWS_SHOWN;
  return (
    <>
      <div ref={scroller} className={`call-diff ${all ? 'is-all' : ''}`.trimEnd()}>
        <DiffView diff={diff} mode="unified" path={path} wrap={narrow} trimEdges scrollRef={scroller} />
      </div>
      {long && !all && (
        <button type="button" className="btn btn-ghost btn-small call-more" onClick={() => setAll(true)}>
          {t('transcript.call.showAll', { count: rows })}
        </button>
      )}
    </>
  );
}
