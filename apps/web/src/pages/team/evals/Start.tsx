import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Loader, Play, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EVAL_LIMITS, type EvalDefinition, type EvalPressure, type EvalEstimate, type EvalFileDetail, type EvalRunRequest, type EvalRunSummary, type EvalVariant } from '@claudio/shared';
import { Checkbox, NumberInput, Select, Sheet } from '@claudio/ui/components/controls';
import { Dialog } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { formatCost } from '@claudio/ui/lib/format';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { api, ApiRequestError, keys, useAccounts, useEvalFile, useEvalsPhase2 } from '../../../api';
import { CodeEditor } from '../../../components/CodeEditor';
import { PRESSURE_LIST, resourceKindOf, targetPath } from './model';
import { canStart, clearProposed, estimateKey, levelsAvailable, proposedState, refusalOf, startRequest, type StartForm } from './run-model';

const VARIANTS: readonly EvalVariant[] = ['pinned', 'current', 'proposed'];

/** Holds a value back until it has stopped changing: the estimate follows the text, not each key. */
function useSettled<T>(value: T, key: string, ms: number): T {
  const [settled, setSettled] = useState({ key, value });
  useEffect(() => {
    if (settled.key === key) return;
    const timer = setTimeout(() => setSettled({ key, value }), ms);
    return () => clearTimeout(timer);
  }, [key, value, ms, settled.key]);
  return settled.value;
}

/** The target as it is in the checkout now, to prefill the proposal and to tell an unchanged one; null when there is no file. */
function useCurrentText(projectId: string, target: EvalDefinition['target']) {
  const kind = resourceKindOf(target.kind);
  return useQuery({
    queryKey: ['evals', projectId, 'target-text', target.kind, target.scope, target.name],
    queryFn: async () => {
      try {
        if (kind === null) {
          const doc = await api.getInstructions({ projectId }, target.name === 'CLAUDE.local.md' ? 'local' : 'shared');
          return doc.exists ? doc.content : null;
        }
        return (await api.resource({ projectId }, kind, target.name)).content;
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: target.scope === 'project',
    retry: false,
  });
}

function Warning({ code }: { code: EvalEstimate['warnings'][number] }) {
  const { t } = useTranslation('evals');
  return (
    <li className="evals-warning">
      <TriangleAlert size={14} strokeWidth={2} aria-hidden />
      <span>{t(`start.warning.${code}`)}</span>
    </li>
  );
}

/** A refusal of the estimate or the start, in words, with the fix that is in the person's hands. */
export function Refusal({ error, onEditor }: { error: unknown; onEditor: () => void }) {
  const { t } = useTranslation('evals');
  const refusal = error instanceof ApiRequestError ? refusalOf(error.code) : null;
  if (!refusal) return <ErrorBox error={error} title={t('start.failed')} />;
  return (
    <div className="alert alert-warn" role="alert">
      <CircleAlert size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
      <div className="alert-body">
        <strong>{t(`start.refused.${refusal.code}.title`)}</strong>
        <div>{t(`start.refused.${refusal.code}.fix`, { detail: error instanceof ApiRequestError ? (error.detail ?? '') : '' })}</div>
        {refusal.fix === 'editor' && (
          <div className="evals-actions">
            <button type="button" className="btn" onClick={onEditor}>
              {t('start.openEditor')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * What the start dialog says and does, as a body and a footer: the dialog and the phone's sheet
 * each place them. Nothing is started but by the person's click, and the click repeats the ceiling
 * the estimate showed, so the run cannot cost what they never saw.
 */
function useStart({
  projectId,
  name,
  file,
  initialProposed,
  onClose,
  onStarted,
  onEditor,
}: {
  projectId: string;
  name: string;
  file: EvalFileDetail & { definition: EvalDefinition };
  initialProposed: string | null;
  onClose: () => void;
  onStarted: (run: EvalRunSummary) => void;
  onEditor: () => void;
}): { body: ReactNode; footer: ReactNode } {
  const { t } = useTranslation('evals');
  const queryClient = useQueryClient();
  const def = file.definition;
  const userScope = def.target.scope === 'user';
  const current = useCurrentText(projectId, def.target);
  const accounts = useAccounts();

  const [form, setForm] = useState<StartForm>(() => ({
    variants: new Set<EvalVariant>(userScope ? ['current'] : initialProposed !== null ? ['current', 'proposed'] : ['pinned', 'current']),
    proposed: initialProposed ?? '',
    skipped: new Set<string>(),
    samples: undefined,
    account: '',
    pressures: new Set<EvalPressure>(['neutral']),
  }));
  const phase2 = useEvalsPhase2();
  const levels = phase2 ? levelsAvailable(def) : (['neutral'] as EvalPressure[]);
  const [accepted, setAccepted] = useState(false);

  const currentText = current.data ?? null;
  const state = proposedState(form.proposed, currentText);
  const draft: EvalRunRequest = startRequest(form, def, currentText, 0);
  const draftKey = estimateKey(draft);
  const settled = useSettled(draft, draftKey, 400);
  const settledKey = estimateKey(settled);
  const asked = canStart(settled) && (!settled.variants.includes('proposed') || settled.proposed !== undefined);
  const estimate = useQuery({
    queryKey: keys.evalEstimate(projectId, name, settledKey),
    queryFn: ({ signal }) => api.estimateEval(projectId, name, settled, { signal }),
    enabled: asked && (initialProposed === null || !current.isLoading),
    retry: false,
    staleTime: 60_000,
    gcTime: 60_000,
  });

  const toggle = (variant: EvalVariant, on: boolean) =>
    setForm((f) => {
      const variants = new Set(f.variants);
      if (on) variants.add(variant);
      else variants.delete(variant);
      // The proposal starts from the file as it is, so what the person changes is what is compared
      const proposed = variant === 'proposed' && on && f.proposed === '' ? (currentText ?? '') : f.proposed;
      return { ...f, variants, proposed };
    });
  const toggleCase = (id: string, on: boolean) =>
    setForm((f) => {
      const skipped = new Set(f.skipped);
      if (on) skipped.delete(id);
      else skipped.add(id);
      return { ...f, skipped };
    });

  const data = estimate.data;
  const fresh = !!data && settledKey === draftKey;
  const consentNeeded = !!data?.consentNeeded;

  const start = useMutation({
    mutationFn: async () => {
      if (!data) throw new Error(t('start.notReady'));
      if (data.consentNeeded) await api.consentEval(projectId, name, file.sha);
      return api.startEval(projectId, name, startRequest(form, def, currentText, data.ceilingUsd));
    },
    onSuccess: (run) => {
      clearProposed(sessionStorage, projectId, def.target.name);
      void queryClient.invalidateQueries({ queryKey: keys.evals(projectId) });
      onStarted(run);
    },
    onError: (error) => {
      // The ceiling or the file moved under the dialog: ask again, and show what is true now
      if (error instanceof ApiRequestError && (error.code === 'cost-not-confirmed' || error.code === 'consent-needed')) void queryClient.invalidateQueries({ queryKey: ['eval-estimate', projectId, name] });
    },
  });

  const accountOptions = [
    { value: '', label: t('start.accountAuto') },
    ...(accounts.data ?? []).filter((a) => a.enabled && a.signedIn).map((a) => ({ value: a.id, label: a.alias ?? a.email ?? a.id })),
  ];
  const samples = form.samples ?? def.samples ?? EVAL_LIMITS.samples.default;
  const refusal = start.error ?? (estimate.error && !estimate.isFetching ? estimate.error : null);

  const body = (
    <div className="evals-start">
      <fieldset className="evals-start-group">
        <legend className="field-label">{t('start.variants')}</legend>
        {VARIANTS.map((variant) => {
          const blocked = userScope && variant !== 'current';
          return (
            <Checkbox key={variant} checked={form.variants.has(variant) && !blocked} disabled={blocked} onChange={(on) => toggle(variant, on)} className="check evals-start-check">
              <span className="evals-start-variant">
                <span>{t(`start.variant.${variant}`)}</span>
                <span className="field-hint">{blocked ? t('start.userScopeHint') : t(`start.variantHint.${variant}`)}</span>
              </span>
            </Checkbox>
          );
        })}
      </fieldset>

      {form.variants.has('proposed') && !userScope && (
        <div className="field">
          <span className="field-label">{t('start.proposedLabel', { path: targetPath(def.target) })}</span>
          <CodeEditor value={form.proposed} onChange={(proposed) => setForm((f) => ({ ...f, proposed }))} language="markdown" ariaLabel={t('start.proposedAria')} minHeight="180px" maxHeight="320px" />
          {initialProposed !== null && form.proposed === initialProposed && <span className="field-hint">{t('start.proposedFromMember')}</span>}
          {state === 'same' && <span className="field-hint evals-warn">{t('start.proposedSame')}</span>}
          {state === 'empty' && <span className="field-hint evals-warn">{t('start.proposedEmpty')}</span>}
        </div>
      )}

      {def.cases.length > 1 && (
        <fieldset className="evals-start-group">
          <legend className="field-label">{t('start.cases')}</legend>
          {def.cases.map((c) => (
            <Checkbox key={c.id} checked={!form.skipped.has(c.id)} onChange={(on) => toggleCase(c.id, on)} className="check evals-start-check">
              <span className="mono">{c.id}</span>
              {c.title && <span className="evals-start-gist">{c.title}</span>}
            </Checkbox>
          ))}
        </fieldset>
      )}

      {levels.length > 1 && (
        <fieldset className="evals-start-group">
          <legend className="field-label">{t('start.pressures')}</legend>
          {PRESSURE_LIST.filter((level) => levels.includes(level)).map((level) => (
            <Checkbox
              key={level}
              checked={form.pressures.has(level)}
              onChange={(on) =>
                setForm((f) => {
                  const next = new Set(f.pressures);
                  if (on) next.add(level);
                  else if (next.size > 1) next.delete(level);
                  return { ...f, pressures: next };
                })
              }
              className="check evals-start-check"
            >
              <span className="evals-start-variant">
                <span>{t(`pressure.${level}`)}</span>
                <span className="field-hint">{t(`start.pressureHint.${level}`)}</span>
              </span>
            </Checkbox>
          ))}
        </fieldset>
      )}

      <div className="evals-grid">
        <div className="field">
          <span className="field-label">{t('start.samples')}</span>
          <NumberInput
            value={samples}
            onChange={(n) => setForm((f) => ({ ...f, samples: n }))}
            min={EVAL_LIMITS.samples.min}
            max={phase2 || def.version === 2 ? EVAL_LIMITS.metricSamples.max : EVAL_LIMITS.samples.max}
            aria-label={t('start.samples')}
          />
        </div>
        <div className="field">
          <span className="field-label">{t('start.account')}</span>
          <Select value={form.account} onChange={(account) => setForm((f) => ({ ...f, account }))} options={accountOptions} aria-label={t('start.account')} />
          <span className="field-hint">{t('start.accountHint')}</span>
        </div>
      </div>

      <section className="evals-estimate" aria-live="polite" aria-label={t('start.estimate.title')}>
        {!asked ? (
          <span className="field-hint">{t('start.nothing')}</span>
        ) : estimate.isFetching && !fresh ? (
          <span className="evals-estimating">
            <Loader {...ICON_SM} aria-hidden />
            {t('start.estimating')}
          </span>
        ) : data ? (
          <>
            <span className="mono evals-estimate-line">
              {t('start.estimate.line', { count: data.samples, cost: formatCost(data.ceilingUsd) })}
              {data.typicalUsd !== null && ` · ${t('start.estimate.typical', { cost: formatCost(data.typicalUsd) })}`}
            </span>
            {data.perLevel && Object.keys(data.perLevel).length > 1 && (
              <ul className="evals-estimate-levels mono" aria-label={t('start.estimate.perLevel')}>
                {PRESSURE_LIST.flatMap((level) => {
                  const line = data.perLevel?.[level];
                  return line ? [<li key={level}>{t('start.estimate.level', { level: t(`pressure.${level}`), count: line.samples, cost: formatCost(line.ceilingUsd) })}</li>] : [];
                })}
              </ul>
            )}
            {data.warnings.length > 0 && (
              <ul className="evals-warnings">
                {data.warnings.map((code) => (
                  <Warning key={code} code={code} />
                ))}
              </ul>
            )}
          </>
        ) : null}
      </section>

      {consentNeeded && data && (
        <section className="evals-consent alert alert-warn" aria-labelledby="evals-consent-title">
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
          <div className="alert-body">
            <strong id="evals-consent-title">{t('start.consent.title')}</strong>
            <p className="field-hint">{t('start.consent.body')}</p>
            <span className="field-label">{t('start.consent.prompts', { count: data.prompts.length })}</span>
            <ul className="evals-consent-list mono">
              {data.prompts.map((prompt, i) => (
                <li key={i}>{prompt}</li>
              ))}
            </ul>
            {data.commands.length > 0 && (
              <>
                <span className="field-label">{t('start.consent.commands', { count: data.commands.length })}</span>
                <ul className="evals-consent-list mono">
                  {data.commands.map((command, i) => (
                    <li key={i}>{command}</li>
                  ))}
                </ul>
              </>
            )}
            <Checkbox checked={accepted} onChange={setAccepted} className="check evals-start-check">
              {t('start.consent.accept')}
            </Checkbox>
          </div>
        </section>
      )}

      {refusal !== null && <Refusal error={refusal} onEditor={onEditor} />}
    </div>
  );

  const ready = fresh && !estimate.isFetching && (!consentNeeded || accepted) && !start.isPending;
  const footer = (
    <>
      <button type="button" className="btn" onClick={onClose}>
        {t('start.cancel')}
      </button>
      <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => start.mutate()}>
        <Play {...ICON_SM} />
        {start.isPending ? t('start.starting') : t('start.run', { cost: data ? formatCost(data.ceilingUsd) : '…' })}
      </button>
    </>
  );
  return { body, footer };
}

/** The dialog's content once the file is read; exported so the screens can be drawn without a portal. */
export function StartPanel(props: Parameters<typeof useStart>[0]) {
  const { body, footer } = useStart(props);
  return (
    <>
      {body}
      <div className="evals-start-foot">{footer}</div>
    </>
  );
}

function Shell({ phone, title, onClose, body, footer }: { phone: boolean; title: string; onClose: () => void; body: ReactNode; footer: ReactNode }) {
  if (phone)
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()} title={title} side="bottom" className="evals-start-sheet" footer={<div className="evals-start-foot">{footer}</div>}>
        {body}
      </Sheet>
    );
  return (
    <Dialog title={title} onClose={onClose} width={620} footer={<div className="evals-start-foot">{footer}</div>}>
      {body}
    </Dialog>
  );
}

function Loaded(props: Parameters<typeof useStart>[0] & { phone: boolean }) {
  const { t } = useTranslation('evals');
  const { body, footer } = useStart(props);
  return <Shell phone={props.phone} title={t('start.title', { title: props.file.definition.title })} onClose={props.onClose} body={body} footer={footer} />;
}

/**
 * "Run eval": a `Dialog`, and a `Sheet` on a phone. `initialProposed` is the unsaved text handed
 * over from the member's page, which the dialog uses once and then clears.
 */
export function StartEval({
  projectId,
  name,
  initialProposed,
  onClose,
  onStarted,
  onEditor,
}: {
  projectId: string;
  name: string;
  initialProposed: string | null;
  onClose: () => void;
  onStarted: (run: EvalRunSummary) => void;
  onEditor: () => void;
}) {
  const { t } = useTranslation('evals');
  const phone = useMediaQuery(NARROW);
  const file = useEvalFile(projectId, name);
  const def = file.data?.definition;
  if (file.data && def && file.data.problems.length === 0)
    return <Loaded projectId={projectId} name={name} file={{ ...file.data, definition: def }} initialProposed={initialProposed} onClose={onClose} onStarted={onStarted} onEditor={onEditor} phone={phone} />;
  const state = file.error ? <ErrorBox error={file.error} /> : file.data ? <p>{t('invalid.body')}</p> : <Skeleton rows={4} height={18} />;
  return <Shell phone={phone} title={t('start.titleBare')} onClose={onClose} body={state} footer={<button type="button" className="btn" onClick={onClose}>{t('start.cancel')}</button>} />;
}
