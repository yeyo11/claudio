import { Ban, CircleCheck, CircleX, Hourglass, TriangleAlert, type LucideIcon } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EvalCall, EvalSampleDetail } from '@claudio/shared';
import { Sheet } from '@claudio/ui/components/controls';
import { Spinner } from '@claudio/ui/components/Spinner';
import { ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { formatCost, formatDuration } from '@claudio/ui/lib/format';
import { useEvalSample } from '../../../api';
import { shortSha } from './model';
import { callSummary, cellState } from './run-model';

const Markdown = lazy(() => import('@claudio/ui/components/Markdown'));

const WHY = ['limit', 'interrupted', 'cancelled', 'skipped', 'infra', 'unjudged'] as const;
const whyOf = (outcome: string | null): (typeof WHY)[number] | null => WHY.find((why) => why === outcome) ?? null;

const CALL_ICON: Record<EvalCall['outcome'], LucideIcon> = { ok: CircleCheck, error: CircleX, denied: Ban, open: Hourglass };
const CALL_TONE: Record<EvalCall['outcome'], string> = { ok: 'ok', error: 'bad', denied: 'warn', open: 'muted' };

/** The calls the sample made, numbered; a subagent's sit under the `Task` that started them. */
function CallList({ calls, focus }: { calls: EvalCall[]; focus: number | null }) {
  const { t } = useTranslation('evals');
  if (calls.length === 0) return <p className="field-hint">{t('sample.noCalls')}</p>;
  return (
    <ol className="evals-calls mono" aria-label={t('sample.calls')}>
      {calls.map((call) => {
        const Icon = CALL_ICON[call.outcome];
        const summary = callSummary(call.name, call.input);
        return (
          <li key={call.seq} id={`sample-call-${call.seq}`} className={`evals-call-row${call.scope === 'sub' ? ' is-sub' : ''}${focus === call.seq ? ' is-focus' : ''}`}>
            <span className="evals-call-seq">#{call.seq}</span>
            <strong className="evals-call-name">{call.name}</strong>
            {call.scope === 'sub' && <span className="evals-call-scope">{t('sample.subagent')}</span>}
            <span className="evals-call-summary">{summary}</span>
            <span className={`evals-call-outcome tone-${CALL_TONE[call.outcome]}`}>
              <Icon size={13} strokeWidth={2} aria-hidden />
              {t(`sample.outcome.${call.outcome}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Footer({ sample }: { sample: EvalSampleDetail }) {
  const { t } = useTranslation('evals');
  const facts: ['cost' | 'duration' | 'turns' | 'account' | 'model' | 'cli' | 'pin', string | null][] = [
    ['cost', sample.costUsd === null ? null : formatCost(sample.costUsd)],
    ['duration', sample.durationMs === null ? null : formatDuration(sample.durationMs)],
    ['turns', sample.turns === null ? null : String(sample.turns)],
    ['account', sample.account],
    ['model', sample.model],
    ['cli', sample.cliVersion],
    ['pin', shortSha(sample.pin)],
  ];
  return (
    <dl className="evals-sample-facts mono">
      {facts
        .filter((fact): fact is [(typeof facts)[number][0], string] => fact[1] !== null)
        .map(([key, value]) => (
          <div key={key}>
            <dt>{t(`sample.fact.${key}`)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** One sample: what it called, what the checks found and what Claude finally said. */
export function SampleView({ sample }: { sample: EvalSampleDetail }) {
  const { t } = useTranslation('evals');
  const [focus, setFocus] = useState<number | null>(null);
  const state = cellState(sample);
  const goTo = (seq: number) => {
    setFocus(seq);
    document.getElementById(`sample-call-${seq}`)?.scrollIntoView({ block: 'center' });
  };
  return (
    <div className="evals-sample">
      {state === 'notScored' && whyOf(sample.outcome) && (
        <div className="alert alert-warn" role="status">
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
          <div className="alert-body">
            <strong>{t('sample.notScored')}</strong>
            <div>{t(`sample.why.${whyOf(sample.outcome) ?? 'infra'}`)}</div>
            {sample.reason && <div className="mono">{sample.reason}</div>}
          </div>
        </div>
      )}
      {state === 'running' && (
        <p className="evals-running-line" role="status">
          <Spinner />
          {t('run.running')}
        </p>
      )}
      {state === 'failed' && sample.reason && <p className="mono field-hint">{sample.reason}</p>}

      <section className="evals-sample-section" aria-labelledby="evals-sample-calls">
        <h3 id="evals-sample-calls">{t('sample.calls')}</h3>
        <CallList calls={sample.calls} focus={focus} />
        {sample.callsTruncated && <p className="field-hint">{t('sample.truncated')}</p>}
      </section>

      <section className="evals-sample-section" aria-labelledby="evals-sample-checks">
        <h3 id="evals-sample-checks">{t('sample.checks')}</h3>
        {sample.checks.length === 0 ? (
          <p className="field-hint">{t('sample.noChecks')}</p>
        ) : (
          <ul className="evals-checks">
            {sample.checks.map((check) => {
              // A judge that failed gives no verdict: not scored, and the gate fails closed on it
              const unjudged = check.judgement?.status === 'unjudged';
              const Icon = unjudged ? Hourglass : check.passed ? CircleCheck : CircleX;
              const tone = unjudged ? 'warn' : check.passed ? 'ok' : 'bad';
              return (
                <li key={check.idx} className={`evals-check tone-${tone}`}>
                  <Icon size={14} strokeWidth={2} aria-hidden />
                  <span className="evals-check-word">{unjudged ? t('sample.unjudged') : check.passed ? t('cell.passed') : t('cell.failed')}</span>
                  <span className="evals-check-detail">{check.detail}</span>
                  {check.judgement && (
                    <span className="evals-check-judge">
                      <span className="field-hint">{t('sample.judge', { model: check.judgement.model ?? '—' })}</span>
                      {check.judgement.reason && <q>{check.judgement.reason}</q>}
                      {check.judgement.evidence.map((seq) => (
                        <button key={seq} type="button" className="btn btn-small mono" onClick={() => goTo(seq)}>
                          {t('sample.evidence', { seq })}
                        </button>
                      ))}
                    </span>
                  )}
                  {check.evidenceSeq !== null && (
                    <button type="button" className="btn btn-small mono" onClick={() => goTo(check.evidenceSeq as number)}>
                      {t('sample.evidence', { seq: check.evidenceSeq })}
                    </button>
                  )}
                  {check.output && <pre className="evals-check-output mono">{check.output}</pre>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="evals-sample-section" aria-labelledby="evals-sample-text">
        <h3 id="evals-sample-text">{t('sample.finalText')}</h3>
        {sample.resultText ? (
          <div className="evals-final-text">
            <Suspense fallback={<Skeleton rows={3} height={14} />}>
              <Markdown text={sample.resultText} />
            </Suspense>
          </div>
        ) : (
          <p className="field-hint">{t('sample.noText')}</p>
        )}
      </section>

      <Footer sample={sample} />
    </div>
  );
}

/** A sample opened from the run's matrix: a side panel, and a bottom sheet on a phone. */
export function SampleSheet({ runId, sampleId, title, onClose }: { runId: string; sampleId: string; title: string; onClose: () => void }) {
  const { t } = useTranslation('evals');
  const sample = useEvalSample(runId, sampleId);
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()} title={title} description={t('sample.description')} className="evals-sample-sheet">
      {sample.error && !sample.data ? <ErrorBox error={sample.error} /> : sample.data ? <SampleView sample={sample.data} /> : <Skeleton rows={6} height={18} />}
    </Sheet>
  );
}
