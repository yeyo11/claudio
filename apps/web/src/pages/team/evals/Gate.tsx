import { CircleAlert, CircleCheck, CircleX, RotateCw, Save, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EvalGate, EvalGateVerdictKind } from '@claudio/shared';
import { ICON_SM } from '@claudio/ui/components/icons';
import { percent } from './run-model';
import { RateBar } from './Metrics';

const VERDICT_ICON: Record<EvalGateVerdictKind, LucideIcon> = { promotable: CircleCheck, regressed: CircleX, incomplete: CircleAlert };
const VERDICT_TONE: Record<EvalGateVerdictKind, string> = { promotable: 'ok', regressed: 'bad', incomplete: 'warn' };

/**
 * The promotion gate of a run that holds `current` and `proposed`: a verdict, and what makes it.
 * It writes nothing. "Save proposed" hands the proposed text to the member's editor, where the
 * person still presses Save; the gate never applies a change.
 */
export function GateCard({
  gate,
  busy,
  onRejudge,
  onAcceptJudge,
  onSaveProposed,
}: {
  gate: EvalGate;
  busy: boolean;
  onRejudge: () => void;
  onAcceptJudge: (caseId: string, idx: number) => void;
  /** Absent when the proposed text cannot be handed to an editor (not an agent file, or not kept) */
  onSaveProposed?: () => void;
}) {
  const { t } = useTranslation('evals');
  const Icon = VERDICT_ICON[gate.verdict];
  const tone = VERDICT_TONE[gate.verdict];
  const { current, proposed, interval } = gate.meanRate;
  const unjudged = gate.incomplete.some((i) => i.reason === 'unjudged');
  return (
    <section className={`card evals-gate tone-${tone}`} aria-labelledby="evals-gate-title">
      <div className="evals-gate-head">
        <Icon size={18} strokeWidth={2} aria-hidden className={`evals-gate-icon tone-${tone}`} />
        <h3 id="evals-gate-title">{t('gate.title')}</h3>
        <strong className={`evals-gate-verdict tone-${tone}`}>{t(`gate.verdict.${gate.verdict}`)}</strong>
      </div>
      <p className="evals-note">{t(`gate.explain.${gate.verdict}`)}</p>

      {gate.regressed.length > 0 && (
        <ul className="evals-gate-list tnum" aria-label={t('gate.regressedList')}>
          {gate.regressed.map((r) => (
            <li key={`${r.caseId}:${r.pressure}`} className="tone-bad">
              {t('gate.regressedLine', { case: r.caseId, pressure: t(`pressure.${r.pressure}`), from: percent(r.from), to: percent(r.to) })}
            </li>
          ))}
        </ul>
      )}

      {gate.incomplete.length > 0 && (
        <ul className="evals-gate-list" aria-label={t('gate.incompleteList')}>
          {gate.incomplete.map((i, n) => (
            <li key={n} className="tone-warn">
              <span className="mono">{i.caseId ?? '—'}</span>
              {i.pressure && <span> · {t(`pressure.${i.pressure}`)}</span>} — {t(`gate.reason.${i.reason}`, { min: 3 })}
            </li>
          ))}
        </ul>
      )}

      {gate.unreliableJudges.length > 0 && (
        <div className="alert alert-warn" role="status">
          <CircleAlert size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
          <div className="alert-body">
            <strong>{t('gate.unreliable.title')}</strong>
            <div>{t('gate.unreliable.body')}</div>
            <ul className="evals-gate-list">
              {gate.unreliableJudges.map((j) => (
                <li key={`${j.caseId}:${j.idx}`}>
                  <span className="tnum">{t('gate.unreliable.which', { case: j.caseId, n: j.idx + 1 })}</span>{' '}
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => onAcceptJudge(j.caseId, j.idx)}>
                    {t('gate.unreliable.accept')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {current !== null && proposed !== null && (
        <dl className="evals-gate-means evals-num">
          <div>
            <dt>{t('variant.current')}</dt>
            <dd>
              {percent(current)}
              {interval && <span className="evals-metric-interval">{t('metrics.interval', { confidence: percent(0.95), range: `${percent(interval.low)}–${percent(interval.high)}` })}</span>}
            </dd>
          </div>
          <div>
            <dt>{t('variant.proposed')}</dt>
            <dd>
              {percent(proposed)}
              {interval && <RateBar rate={proposed} interval={interval} label={t('gate.meanBar', { rate: percent(proposed), range: `${percent(interval.low)}–${percent(interval.high)}` })} />}
            </dd>
          </div>
        </dl>
      )}
      <p className="field-hint">{gate.account ? t('gate.accountPinned', { account: gate.account }) : t('gate.accountRotation')}</p>

      <div className="evals-actions">
        {unjudged && (
          <button type="button" className="btn" disabled={busy} onClick={onRejudge}>
            <RotateCw {...ICON_SM} />
            {t('gate.rejudge')}
          </button>
        )}
        {onSaveProposed && (
          <button type="button" className={gate.verdict === 'promotable' ? 'btn btn-primary' : 'btn'} onClick={onSaveProposed}>
            <Save {...ICON_SM} />
            {t('gate.saveProposed')}
          </button>
        )}
      </div>
    </section>
  );
}
