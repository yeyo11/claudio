import type { ReviewFinding, ReviewGateDetail, ReviewSeverity, ReviewSide } from '@claudio/shared';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { lineKey } from '../../lib/reviews';
import type { LineLayer } from './DiffView';
import { splitPath } from './review-model';

// The review gate's findings on the integration diff (design system §5, "Review threads in the
// diff", the finding variant of `.rt`). A finding is Claudio's record, not a conversation: no reply
// field, no avatar, and nothing here is live. Its text was written by a model and is English as
// stored: it is drawn as text, never as markup, and never translated.

const SEVERITY_TONE: Record<ReviewSeverity, 'bad' | 'warn' | null> = { critical: 'bad', high: 'bad', medium: 'warn', low: null };

/** The finding's `where`: `project-settings.ts:10`, the whole path where the card is not under its line */
export function findingWhere(finding: Pick<ReviewFinding, 'path' | 'line'>, full: boolean): string {
  if (!finding.path) return '';
  const name = full ? finding.path : splitPath(finding.path).name;
  return finding.line === null ? name : `${name}:${String(finding.line)}`;
}

export function FindingCard({ finding, full = false, phone = false }: { finding: ReviewFinding; full?: boolean; phone?: boolean }) {
  const { t } = useTranslation('orchestrationV2');
  const tone = SEVERITY_TONE[finding.severity];
  const where = findingWhere(finding, full);
  const verifier = finding.verdict !== 'not-asked';
  return (
    <article
      className={`rt finding ${finding.verdict === 'refuted' ? 'refuted' : 'open'}`}
      aria-label={t('review.finding.label', { where: where || t('review.finding.noPlace') })}
    >
      <div className="rt-head">
        <span className={`rt-sev${tone ? ` ${tone}` : ''}`}>
          {tone && <ShieldAlert {...ICON_SM} />}
          {t(`review.severity.${finding.severity}`)}
        </span>
        {finding.dimensions.map((dimension) => (
          <span key={dimension} className="rt-dim">
            {t(`review.dimension.${dimension}`)}
          </span>
        ))}
        {where && <span className="where">{where}</span>}
        <span className="grow" />
        {finding.source === 'claudio' ? (
          <span className="rt-verdict">{t('review.finding.claudio')}</span>
        ) : (
          !phone && verifier && <span className={`rt-verdict${finding.verdict === 'uncertain' || finding.verdict === 'unverified' ? ' warn' : ''}`}>{t(`review.verdict.${finding.verdict}`)}</span>
        )}
      </div>
      <div className="rt-finding-body">
        <h4 className="rt-title">{finding.title}</h4>
        {finding.failureScenario && (
          <div className="rt-fact">
            <span className="k">{t('review.finding.failure')}</span>
            <p>{finding.failureScenario}</p>
          </div>
        )}
        {finding.evidence && (
          <div className="rt-fact">
            <span className="k">{t('review.finding.evidence')}</span>
            <pre className="rt-evidence">{finding.evidence}</pre>
          </div>
        )}
        {finding.suggestion && (
          <div className="rt-fact">
            <span className="k">{t('review.finding.suggestion')}</span>
            <pre className="rt-evidence">{finding.suggestion}</pre>
          </div>
        )}
      </div>
      {(verifier || finding.source === 'claudio') && (
        <div className="rt-verifier">
          <span className="rt-dim">{t('review.finding.verifier')}</span>
          <span className="rt-verdict">{finding.source === 'claudio' ? t('review.finding.claudio') : t(`review.verdict.${finding.verdict}`)}</span>
          {finding.verdictReason && <span>{finding.verdictReason}</span>}
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------------------------
// Placing findings

/** What one file shows of the gate: findings by line, those with no line, and those of an older head */
export interface FileFindings {
  byLine: Map<string, ReviewFinding[]>;
  file: ReviewFinding[];
  outdated: ReviewFinding[];
  total: number;
}

/**
 * Findings of one file, placed. Refuted findings and those outside the diff have no line to stand
 * under, so the diff leaves them to the card. A finding of an earlier round whose head is not the
 * current one, or one a later round resolved, folds as outdated.
 */
export function groupFindings(detail: ReviewGateDetail | undefined, path: string): FileFindings {
  const out: FileFindings = { byLine: new Map(), file: [], outdated: [], total: 0 };
  if (!detail) return out;
  const head = detail.state?.head ?? null;
  const headOf = new Map(detail.rounds.map((round) => [round.id, round.head]));
  for (const finding of detail.findings) {
    if (finding.path !== path || finding.verdict === 'refuted' || finding.anchor === 'outside') continue;
    out.total += 1;
    const roundHead = headOf.get(finding.roundId);
    if (finding.resolvedInRound !== null || (head !== null && roundHead !== undefined && roundHead !== head)) {
      out.outdated.push(finding);
    } else if (finding.anchor === 'line' && finding.line !== null) {
      const key = lineKey(finding.side ?? 'right', finding.line);
      out.byLine.set(key, [...(out.byLine.get(key) ?? []), finding]);
    } else {
      out.file.push(finding);
    }
  }
  return out;
}

/** The finding count of every file, for the file map */
export function findingCounts(detail: ReviewGateDetail | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of detail?.findings ?? []) {
    if (!finding.path || finding.verdict === 'refuted' || finding.anchor === 'outside' || finding.resolvedInRound !== null) continue;
    counts.set(finding.path, (counts.get(finding.path) ?? 0) + 1);
  }
  return counts;
}

/** The gate's findings of an orchestration, read again when the card's own read is invalidated */
export function useReviewFindings(orchestrationId: string | undefined) {
  return useQuery({
    queryKey: [...keys.orchestrationReview(orchestrationId ?? ''), 'diff'],
    queryFn: ({ signal }) => api.orchestrationReview(orchestrationId!, { limit: 500 }, { signal }),
    enabled: !!orchestrationId,
    retry: false,
  });
}

export function useFileFindings(detail: ReviewGateDetail | undefined, path: string): FileFindings {
  return useMemo(() => groupFindings(detail, path), [detail, path]);
}

function Fold({ children, label }: { children: ReactNode; label: string }) {
  const { t } = useTranslation('orchestrationV2');
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="rt-fold">
        <span className="grow">{label}</span>
        <button type="button" className="btn btn-ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? t('review.finding.hide') : t('review.finding.show')}
        </button>
      </div>
      {open && children}
    </>
  );
}

/** File-level findings at the top of the file, and the outdated ones folded under them */
export function FileFindingsFold({ file, phone }: { file: FileFindings; phone: boolean }) {
  const { t } = useTranslation('orchestrationV2');
  if (file.file.length === 0 && file.outdated.length === 0) return null;
  return (
    <>
      {file.file.map((finding) => (
        <FindingCard key={finding.id} finding={finding} full phone={phone} />
      ))}
      {file.outdated.length > 0 && (
        <Fold label={t('review.finding.foldOutdated', { count: file.outdated.length })}>
          {file.outdated.map((finding) => (
            <FindingCard key={finding.id} finding={finding} full phone={phone} />
          ))}
        </Fold>
      )}
    </>
  );
}

/** What a file's header says of its findings: `2 findings` */
export function FindingsChip({ file }: { file: FileFindings | null }) {
  const { t } = useTranslation('orchestrationV2');
  if (!file || file.total === 0) return null;
  return (
    <span className="chip changes-findings-chip" title={t('review.finding.chipTitle')}>
      <ShieldCheck {...ICON_SM} />
      {t('review.finding.chip', { count: file.total })}
    </span>
  );
}

/**
 * The layer a file hands DiffView beside `threadLayer`: finding cards under their lines and the
 * pill with their count. On a phone the card says it, so there is no pill.
 */
export function findingLayer({ file, phone }: { file: FileFindings | null; phone: boolean }): LineLayer {
  const at = (side: ReviewSide, line: number) => file?.byLine.get(lineKey(side, line)) ?? [];
  return {
    after: (side, line) => {
      const here = at(side, line);
      if (here.length === 0) return null;
      return (
        <>
          {here.map((finding) => (
            <FindingCard key={finding.id} finding={finding} phone={phone} />
          ))}
        </>
      );
    },
    mark: phone
      ? undefined
      : (side, line) => {
          const here = at(side, line);
          return here.length === 0 ? null : <FindingPill count={here.length} />;
        },
  };
}

function FindingPill({ count }: { count: number }) {
  const { t } = useTranslation('orchestrationV2');
  return (
    <span className="diff-note-pill is-open" role="img" aria-label={t('review.finding.pill', { count })}>
      <ShieldAlert {...ICON_SM} />
      {count}
    </span>
  );
}

/** Two layers drawn as one: DiffView takes a single layer, and threads and findings share the lines */
export function mergeLayers(first: LineLayer | undefined, second: LineLayer | undefined): LineLayer | undefined {
  if (!first) return second;
  if (!second) return first;
  return {
    after: (side, line) => {
      const a = first.after(side, line);
      const b = second.after(side, line);
      return a || b ? (
        <>
          {b}
          {a}
        </>
      ) : null;
    },
    mark:
      first.mark || second.mark
        ? (side, line) => (
            <>
              {first.mark?.(side, line)}
              {second.mark?.(side, line)}
            </>
          )
        : undefined,
    gutter: first.gutter ?? second.gutter,
  };
}
