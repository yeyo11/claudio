import type { MemoryProposal, MemoryProposalPreview } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiRequestError, keys } from '../../../api';
import { Sheet } from '@claudio/ui/components/controls';
import { Dialog } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { formatBytes } from '@claudio/ui/lib/format';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { DiffView } from '../../../components/changes/DiffView';
import { parseUnified } from '../../../lib/diff';

/** The heading a lesson goes under in `CLAUDE.md` unless the person picks another */
export const LESSONS_SECTION = 'Lessons';

/** How long the section field rests before the preview is read again */
const SECTION_DEBOUNCE_MS = 400;

/**
 * Approving an `instructions` proposal shows what it would do to `CLAUDE.md` first (design system
 * §5, Reading mode): the diff, where it lands, how big the file gets. Approve waits for the diff and
 * sends back the hash of the file it was drawn against, so a file that changed since is refused (409)
 * and the diff is read again. A lesson's proposal also lets the person pick the heading.
 */
export function InstructionsDiffDialog({ proposal, onClose }: { proposal: MemoryProposal; onClose: () => void }) {
  const { t } = useTranslation(['home', 'common']);
  const toast = useToast();
  const qc = useQueryClient();
  const narrow = useMediaQuery(NARROW);
  const fromLesson = proposal.lessonId !== null;
  const [section, setSection] = useState(proposal.target.section ?? (fromLesson ? LESSONS_SECTION : ''));
  const [preview, setPreview] = useState<MemoryProposalPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Only the newest read may land: a slow one from an earlier heading must not replace it
  const reads = useRef(0);

  const read = (heading: string) => {
    const mine = ++reads.current;
    setPreview(null);
    setError(null);
    api
      .previewMemoryProposal(proposal.id, { section: heading })
      .then((next) => mine === reads.current && setPreview(next))
      .catch((err: unknown) => mine === reads.current && setError(err));
  };
  useEffect(() => {
    const wait = setTimeout(() => read(section), preview === null && reads.current === 0 ? 0 : SECTION_DEBOUNCE_MS);
    return () => clearTimeout(wait);
    // The heading is the only input; `read` closes over the proposal, which does not change
  }, [section]);

  const diff = useMemo(() => (preview ? parseUnified(preview.diff) : null), [preview]);

  const approve = useMutation({
    mutationFn: (seen: MemoryProposalPreview) => api.approveMemoryProposal(proposal.id, { previewOf: seen.sha256, section }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.memoryProposalsOf(proposal.projectId) });
      void qc.invalidateQueries({ queryKey: ['lessons'] });
      toast.success(t('memoryTab.diff.approved'));
      onClose();
    },
    onError: (err) => {
      // 409: CLAUDE.md moved on since the diff was drawn, so the person reads the new one before approving
      if (err instanceof ApiRequestError && err.status === 409) {
        toast.info(t('memoryTab.diff.stale'));
        read(section);
      } else toast.error(t('memoryTab.diff.approveFailed'), err);
    },
  });

  const body = (
    <div className="instr-diff">
      <div className="instr-diff-head">
        <span className="mono instr-diff-path">{preview?.path ?? 'CLAUDE.md'}</span>
        {preview && (
          <span className="small muted tnum">
            {t('memoryTab.diff.bytesAfter', { size: formatBytes(preview.bytesAfter) })}
            {!preview.exists && ` · ${t('memoryTab.diff.created')}`}
          </span>
        )}
      </div>
      {fromLesson && (
        <label className="instr-diff-section">
          <span className="small muted">{t('memoryTab.diff.section')}</span>
          <input className="mono" value={section} maxLength={80} onChange={(event) => setSection(event.target.value)} />
        </label>
      )}
      {error ? (
        <ErrorBox error={error} />
      ) : diff ? (
        <div className="instr-diff-view">
          <DiffView diff={diff} mode="reading" path="CLAUDE.md" wrap={narrow} trimEdges />
        </div>
      ) : (
        <Skeleton rows={4} height={16} />
      )}
    </div>
  );

  const footer = (
    <div className={`instr-diff-foot ${narrow ? 'is-sheet' : ''}`.trim()}>
      <button type="button" className="btn btn-quiet" onClick={onClose}>
        {t('common:actions.cancel')}
      </button>
      <button type="button" className="btn btn-primary memory-approve" disabled={!preview || approve.isPending} onClick={() => preview && approve.mutate(preview)}>
        <Check {...ICON_SM} />
        {t('memoryTab.diff.approve')}
      </button>
    </div>
  );

  if (narrow) {
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()} title={t('memoryTab.diff.title')} side="bottom" className="instr-diff-sheet" footer={footer}>
        {body}
      </Sheet>
    );
  }
  return (
    <Dialog title={t('memoryTab.diff.title')} onClose={onClose} footer={footer} width={720}>
      {body}
    </Dialog>
  );
}
