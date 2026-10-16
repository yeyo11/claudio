import type { OrchestrationTaskSpec, TaskLimits } from '@claudio/shared';
import { Info } from 'lucide-react';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { graphShape } from '../lib/orchestration-steps';
import { limitsOf, type InstallMode, type ReviewDraft, type VerificationDraft } from '../lib/orchestration-v2';
import { Checkbox, NumberInput, Select, Switch } from '@claudio/ui/components/controls';
import { Field, Segmented } from '@claudio/ui/components/ui';
import { EffortField } from './EffortPicker';
import { ModelCombobox } from './ui';

const INSTALL_MODES: readonly InstallMode[] = ['detected', 'command', 'none'];

/** What every task may spend unless it says otherwise. A task's own limits win. */
export function DefaultLimits({ value, onChange }: { value: TaskLimits | undefined; onChange: (limits: TaskLimits | undefined) => void }) {
  const { t } = useTranslation('orchestrationV2');
  return (
    <div className="stack-tight">
      <div className="strong small">{t('limits.graphTitle')}</div>
      <div className="form-grid">
        <Field label={t('limits.maxMinutes')}>
          <NumberInput
            aria-label={t('limits.graphMinutes')}
            min={1}
            max={1440}
            step={5}
            placeholder={t('limits.none')}
            value={value?.maxMinutes}
            onChange={(maxMinutes) => onChange(limitsOf(maxMinutes, value?.maxCostUsd))}
          />
        </Field>
        <Field label={t('limits.maxCost')}>
          <NumberInput
            aria-label={t('limits.graphCost')}
            min={0.5}
            max={1000}
            step={0.5}
            placeholder={t('limits.none')}
            value={value?.maxCostUsd}
            onChange={(maxCostUsd) => onChange(limitsOf(value?.maxMinutes, maxCostUsd))}
          />
        </Field>
      </div>
      <p className="muted small">{t('limits.graphHint')}</p>
    </div>
  );
}

const SECURITY_MODES: readonly ReviewDraft['security'][] = ['auto', 'always', 'off'];

/**
 * The review of the merged branch (docs/plans/review-gate.md): off by default, because it spends
 * money on every graph and a blocked review holds the pull request.
 */
export function ReviewFields({ value, onChange }: { value: ReviewDraft; onChange: (next: ReviewDraft) => void }) {
  const { t } = useTranslation('orchestrationV2');
  const set = (patch: Partial<ReviewDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="stack-tight review-fields" data-testid="review-fields">
      <Switch checked={value.enabled} onChange={(enabled) => set({ enabled })}>
        {t('review.enable')}
      </Switch>
      <p className="muted small">{t('review.enableHint')}</p>
      {value.enabled && (
        <>
          <div className="stack-tight" role="group" aria-label={t('review.dimensions')}>
            <div className="strong small">{t('review.dimensions')}</div>
            <Checkbox checked disabled onChange={() => {}}>
              {t('review.dimension.correctness')} <span className="muted small">{t('review.always')}</span>
            </Checkbox>
            <Checkbox checked={value.tests} onChange={(tests) => set({ tests })}>
              {t('review.dimension.tests')}
            </Checkbox>
            <Checkbox checked={value.conventions} onChange={(conventions) => set({ conventions })}>
              {t('review.dimension.conventions')}
            </Checkbox>
          </div>
          <div className="form-grid">
            <Field label={t('review.security')} hint={t(`review.securityHint.${value.security}`)}>
              <Select<ReviewDraft['security']>
                aria-label={t('review.security')}
                value={value.security}
                onChange={(security) => set({ security })}
                options={SECURITY_MODES.map((mode) => ({ value: mode, label: t(`review.securityMode.${mode}`) }))}
              />
            </Field>
            <Field label={t('review.depth')} hint={t(`review.depthHint.${value.depth}`)}>
              <Segmented<ReviewDraft['depth']>
                label={t('review.depth')}
                value={value.depth}
                onChange={(depth) => set({ depth })}
                options={[
                  { value: 'full', label: t('review.depthFull') },
                  { value: 'light', label: t('review.depthLight') },
                ]}
              />
            </Field>
          </div>
          <Switch checked={value.fixer} onChange={(fixer) => set({ fixer })}>
            {t('review.fixer')}
          </Switch>
          <div className="form-grid">
            {value.fixer && (
              <Field label={t('review.fixRounds')} hint={t('review.fixRoundsHint')}>
                <NumberInput aria-label={t('review.fixRounds')} min={0} max={5} value={value.maxFixRounds} onChange={(v) => set({ maxFixRounds: v ?? 0 })} />
              </Field>
            )}
            <Field label={t('review.maxCost')} hint={t('review.maxCostHint')}>
              <NumberInput aria-label={t('review.maxCost')} min={0.1} max={1000} step={0.5} value={value.maxCostUsd} onChange={(v) => set({ maxCostUsd: v ?? 5 })} />
            </Field>
            <Field label={t('review.maxRunCost')} hint={t('review.maxRunCostHint')}>
              <NumberInput aria-label={t('review.maxRunCost')} min={0.1} max={1000} step={0.5} value={value.maxRunCostUsd} onChange={(v) => set({ maxRunCostUsd: v ?? 1 })} />
            </Field>
            <Field label={t('review.reviewerModel')}>
              <ModelCombobox aria-label={t('review.reviewerModel')} placeholder={t('review.modelDefault', { model: 'sonnet' })} value={value.reviewerModel} onChange={(reviewerModel) => set({ reviewerModel })} />
            </Field>
            <Field label={t('review.verifierModel')}>
              <ModelCombobox aria-label={t('review.verifierModel')} placeholder={t('review.modelDefault', { model: 'opus' })} value={value.verifierModel} onChange={(verifierModel) => set({ verifierModel })} />
            </Field>
          </div>
          <Field label={t('review.exclude')} hint={t('review.excludeHint')}>
            <textarea rows={3} className="mono" value={value.exclude} placeholder={t('review.excludePlaceholder')} onChange={(e) => set({ exclude: e.target.value })} />
          </Field>
          <p className="muted small">{t('review.cost')}</p>
        </>
      )}
    </div>
  );
}

/**
 * The checks that run once, on the integration branch, after the graph is merged. Workers run
 * typecheck and unit tests; this is where the slow suite goes, so it is not run in every worktree.
 */
export function VerificationFields({ value, onChange }: { value: VerificationDraft; onChange: (next: VerificationDraft) => void }) {
  const { t } = useTranslation('orchestrationV2');
  return (
    <div className="stack-tight">
      <Switch checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })}>
        {t('verification.enable')}
      </Switch>
      <p className="muted small">{t('verification.enableHint')}</p>
      {value.enabled && (
        <>
          <Field label={t('verification.commands')} hint={t('verification.commandsHint')}>
            <textarea
              rows={3}
              className="mono"
              value={value.commands}
              placeholder={t('verification.commandsPlaceholder')}
              onChange={(e) => onChange({ ...value, commands: e.target.value })}
            />
          </Field>
          <div className="form-grid">
            <Field label={t('verification.install')} hint={t(`verification.installHint.${value.install}`)}>
              <Select<InstallMode>
                aria-label={t('verification.install')}
                value={value.install}
                onChange={(install) => onChange({ ...value, install })}
                options={INSTALL_MODES.map((mode) => ({ value: mode, label: t(`verification.installMode.${mode}`) }))}
              />
            </Field>
            {value.install === 'command' && (
              <Field label={t('verification.installCommand')}>
                <input
                  className="mono"
                  value={value.installCommand}
                  placeholder={t('verification.installPlaceholder')}
                  onChange={(e) => onChange({ ...value, installCommand: e.target.value })}
                />
              </Field>
            )}
          </div>
          <Switch checked={value.fixer} onChange={(fixer) => onChange({ ...value, fixer })}>
            {t('verification.fixer')}
          </Switch>
          {value.fixer && (
            <div className="form-grid">
              <Field label={t('verification.attempts')} hint={t('verification.attemptsHint')}>
                <NumberInput min={1} max={5} value={value.maxAttempts} onChange={(v) => onChange({ ...value, maxAttempts: v || 1 })} />
              </Field>
              <Field label={t('verification.model')}>
                <ModelCombobox
                  aria-label={t('verification.model')}
                  placeholder={t('verification.modelDefault')}
                  value={value.model}
                  onChange={(model) => onChange({ ...value, model })}
                />
              </Field>
              <EffortField value={value.effort ?? ''} onChange={(effort) => onChange({ ...value, effort: effort || undefined })} model={value.model} use="fixer" />
              <Field label={t('verification.maxCost')} hint={t('verification.maxCostHint')}>
                <NumberInput
                  aria-label={t('verification.maxCost')}
                  min={0.1}
                  max={1000}
                  step={0.5}
                  placeholder={t('limits.none')}
                  value={value.maxCostUsd}
                  onChange={(maxCostUsd) => onChange({ ...value, maxCostUsd })}
                />
              </Field>
            </div>
          )}
          <Switch checked={value.failGraph} onChange={(failGraph) => onChange({ ...value, failGraph })}>
            {t('verification.failGraph')}
          </Switch>
          <p className="muted small">{t('verification.failGraphHint')}</p>
          <Switch checked={value.e2eSpecs} onChange={(e2eSpecs) => onChange({ ...value, e2eSpecs })}>
            {t('verification.e2eSpecs')}
          </Switch>
          <p className="muted small">{t('verification.e2eSpecsHint')}</p>
          <ReviewFields value={value.review} onChange={(review) => onChange({ ...value, review })} />
        </>
      )}
    </div>
  );
}

/** Above this many stages in series the graph is worth reshaping (docs/orchestrations.md). */
export const LONG_CHAIN_STAGES = 4;

/**
 * How many stages the graph being written runs in series, and its longest chain. A hint, never a
 * block: the task phase lasts as long as this chain, and the person decides whether that is fine.
 */
export function GraphShape({ tasks }: { tasks: ReadonlyArray<Pick<OrchestrationTaskSpec, 'id' | 'dependsOn'>> }) {
  const { t } = useTranslation('config');
  const shape = graphShape(tasks.map((task) => ({ id: task.id.trim(), dependsOn: task.dependsOn })));
  if (!shape) return null;
  return (
    <div className="graph-shape stack-tight" data-testid="graph-shape">
      <p className="form-hint graph-shape-line">
        <span className="mono">{t('orchestration.shape', { count: shape.stages })}</span>
        {shape.stages > 1 && (
          <>
            <span aria-hidden> · </span>
            <span className="graph-shape-chain mono" role="group" aria-label={t('orchestration.shapeLabel')}>
              {shape.chain.map((id, i) => (
                <Fragment key={`${i}-${id}`}>
                  {i > 0 && <span aria-hidden>{' → '}</span>}
                  <span className="graph-shape-id">{id}</span>
                </Fragment>
              ))}
            </span>
          </>
        )}
      </p>
      {shape.stages > LONG_CHAIN_STAGES && (
        <div className="alert alert-info graph-shape-note" role="note">
          <Info size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
          <div className="alert-body">{t('orchestration.shapeNote')}</div>
        </div>
      )}
    </div>
  );
}
