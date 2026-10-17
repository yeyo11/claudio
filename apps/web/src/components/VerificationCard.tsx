import type { FixStopKind, Orchestration, VerificationFix, VerificationStatus } from '@claudio/shared';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatCost, formatDateTime, formatDuration } from '@claudio/ui/lib/format';
import { CodeBlock } from '@claudio/ui/components/CodeBlock';
import { Collapsible } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Card, StatusBadge, Tag } from '@claudio/ui/components/ui';
import { ReviewGateSection } from './ReviewGateSection';

/** Passed and fixed are both good news but not the same news, so each says its own word. */
function VerificationBadge({ status }: { status: VerificationStatus }) {
  const { t } = useTranslation('orchestrationV2');
  if (status === 'passed' || status === 'fixed') return <Tag tone="ok">{t(`verification.status.${status}`)}</Tag>;
  // running, pending and failed have a shape and a word of their own already
  return <StatusBadge status={status} />;
}

/**
 * Said at the top of the page, not only in the card: the graph's status is otherwise about its
 * tasks, and here every task finished and it still failed.
 */
export function FailedByChecksNotice({ orch }: { orch: Orchestration }) {
  const { t } = useTranslation('orchestrationV2');
  // A workflow runs no checks: its `error` says why the run did not finish (`WorkflowEndedNotice`)
  if (orch.status !== 'failed' || !orch.error || orch.engine === 'workflow') return null;
  return (
    <div className="alert alert-bad" role="alert">
      <ShieldAlert className="alert-icon" {...ICON_SM} />
      <div className="alert-body stack-tight">
        <div className="strong">{t('verification.failedGraphTitle')}</div>
        <div className="small">{t('verification.failedGraphBody')}</div>
      </div>
    </div>
  );
}

/** A list of fixed locations longer than this folds, so a fixer that touched many files does not push the commits away. */
const FOLD_AFTER = 8;

/** Why a fixer's loop ended early, in words: warn, never an animation, and always with the word "Stopped". */
export function FixStopLine({ kind, note }: { kind: FixStopKind; note: string }) {
  const { t } = useTranslation('orchestrationV2');
  return (
    <div className="vfix-stop list-row list-row-flow small">
      <Tag tone="warn">{t('verification.stopped')}</Tag>
      <span className="strong">{t(`verification.stop.${kind}`)}</span>
      {note && <span className="break muted">{note}</span>}
    </div>
  );
}

/**
 * What each fixer attempt fixed, as `path:line` and a note. A path is text: Claudio never links to
 * an editor, and what the fixer wrote is never resolved to a file.
 */
export function VerificationFixes({ fixes }: { fixes: readonly VerificationFix[] }) {
  const { t } = useTranslation('orchestrationV2');
  if (fixes.length === 0) return null;
  return (
    <div className="stack-tight vfixes">
      <div className="strong small">{t('verification.fixes')}</div>
      {fixes.map((fix) => {
        const rows = fix.fixed ?? [];
        const list = (
          <ul className="vfix-rows">
            {rows.map((row, i) => (
              <li key={`${row.path}:${String(row.line)}:${String(i)}`} className="vfix-row small">
                <code className="mono break">{row.line === null ? row.path : `${row.path}:${String(row.line)}`}</code>
                <span className="break">{row.note}</span>
              </li>
            ))}
          </ul>
        );
        return (
          <div key={fix.attempt} className="vfix stack-tight">
            <div className="small muted">{t('verification.fixAttempt', { number: fix.attempt })}</div>
            {rows.length > FOLD_AFTER ? (
              <Collapsible className="fold" title={t('verification.fixRows', { count: rows.length })}>
                {list}
              </Collapsible>
            ) : (
              rows.length > 0 && list
            )}
            {fix.stop && <FixStopLine kind={fix.stop.kind} note={fix.stop.note} />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * What the checks on the integration branch did. It sits before the pull request is offered on
 * purpose: this is what a person should read first.
 */
export function VerificationCard({ orch }: { orch: Orchestration }) {
  const { t } = useTranslation('orchestrationV2');
  const state = orch.verification;
  if (!state) return null;
  const spec = orch.verificationSpec;
  // Stored before the fixer had a cost of its own, a state may come without one
  const cost = state.costUsd ?? 0;

  return (
    <Card
      title={
        <span className="title-icon">
          <ShieldCheck {...ICON_SM} /> {t('verification.title')}
        </span>
      }
      actions={<VerificationBadge status={state.status} />}
    >
      <p className="small" role="status">
        {state.status === 'failed' && state.gate === 'review' ? t('verification.summaryReview') : t(`verification.summary.${state.status}`)}
        {state.attempts > 0 && ` ${t('verification.attemptsSpent', { count: state.attempts })}`}
      </p>
      {(cost > 0 || spec?.maxCostUsd !== undefined) && (
        <p className="small muted">
          {spec?.maxCostUsd !== undefined
            ? t('verification.costOf', { cost: formatCost(cost), limit: formatCost(spec.maxCostUsd) })
            : t('verification.cost', { cost: formatCost(cost) })}
        </p>
      )}
      {spec?.failGraph && <p className="small muted">{t('verification.failGraphOn')}</p>}
      {state.report && <p className="small break">{state.report}</p>}

      <ul className="list">
        {state.commands.map((command) => (
          <li key={command.command} className="stack-tight">
            <div className="list-row list-row-flow small">
              <VerificationBadge status={command.status} />
              {command.install && <Tag>{t('verification.installTag')}</Tag>}
              <code className="mono break">{command.command}</code>
              {command.durationMs > 0 && <span className="muted nowrap">{formatDuration(command.durationMs)}</span>}
            </div>
            {command.output && (
              <Collapsible className="fold" title={t('verification.output')}>
                <CodeBlock code={command.output} tone={command.status === 'failed' ? 'error' : undefined} />
              </Collapsible>
            )}
          </li>
        ))}
      </ul>

      <VerificationFixes fixes={state.fixes ?? []} />

      {state.review && <ReviewGateSection orch={orch} />}

      {state.commits.length > 0 && (
        <div className="stack-tight">
          <div className="strong small">{t('verification.commits', { count: state.commits.length })}</div>
          <ul className="list">
            {state.commits.map((commit) => (
              <li key={commit.hash} className="list-row list-row-flow small">
                <span className="mono">{commit.hash.slice(0, 8)}</span>
                <span className="break">{commit.subject}</span>
                <span className="muted nowrap">{formatDateTime(commit.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
