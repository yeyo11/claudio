import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EVAL_LIMITS } from '@claudio/shared';
import { Combobox, Select, Switch } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import {
  blankExpect,
  EXPECTATION_KIND_LIST,
  EXPECTATION_KIND_LIST_V2,
  KNOWN_TOOLS,
  type CallForm,
  type ExpectForm,
  type MatcherForm,
  type MatcherMode,
} from './model';

const MODES: readonly MatcherMode[] = ['glob', 'equals', 'contains', 'regex'];
const TOOL_OPTIONS = KNOWN_TOOLS.map((tool) => ({ value: tool }));

/** A string matcher: how it compares, and what with. A bare glob is the default, as in the file. */
export function MatcherField({
  value,
  onChange,
  label,
  invalid,
}: {
  value: MatcherForm;
  onChange: (next: MatcherForm) => void;
  label: string;
  invalid?: boolean;
}) {
  const { t } = useTranslation('evals');
  return (
    <div className="evals-matcher" role="group" aria-label={label}>
      <Select<MatcherMode>
        value={value.mode}
        onChange={(mode) => onChange({ ...value, mode })}
        options={MODES.map((mode) => ({ value: mode, label: t(`matcher.${mode}`) }))}
        aria-label={t('matcher.mode', { field: label })}
        className="evals-matcher-mode"
      />
      <input
        className={`mono${invalid ? ' is-invalid' : ''}`}
        value={value.value}
        onChange={(event) => onChange({ ...value, value: event.target.value })}
        placeholder={label}
        aria-label={label}
        aria-invalid={invalid || undefined}
        spellCheck={false}
      />
      {value.mode === 'regex' && (
        <input
          className="mono evals-matcher-flags"
          value={value.flags}
          onChange={(event) => onChange({ ...value, flags: event.target.value })}
          placeholder={t('matcher.flags')}
          aria-label={t('matcher.flagsLabel', { field: label })}
          spellCheck={false}
        />
      )}
    </div>
  );
}

/** One call matcher: the tool, then what the call must carry, then how it ended and who made it. */
export function CallFields({ value, onChange, label, invalid }: { value: CallForm; onChange: (next: CallForm) => void; label: string; invalid?: boolean }) {
  const { t } = useTranslation('evals');
  return (
    <div className="evals-call" role="group" aria-label={label}>
      <span className="evals-call-label">{label}</span>
      <div className="evals-call-fields">
        <Combobox value={value.tool} onChange={(tool) => onChange({ ...value, tool })} options={TOOL_OPTIONS} placeholder={t('call.tool')} aria-label={t('call.toolLabel', { call: label })} />
        <MatcherField value={value.command} onChange={(command) => onChange({ ...value, command })} label={t('call.command')} {...(invalid ? { invalid } : {})} />
        <MatcherField value={value.path} onChange={(path) => onChange({ ...value, path })} label={t('call.path')} />
        <div className="evals-call-ends">
          <Select
            value={value.outcome}
            onChange={(outcome) => onChange({ ...value, outcome })}
            options={[
              { value: '', label: t('call.outcome.default') },
              { value: 'ok', label: t('call.outcome.ok') },
              { value: 'error', label: t('call.outcome.error') },
              { value: 'denied', label: t('call.outcome.denied') },
              { value: 'any', label: t('call.outcome.any') },
            ]}
            aria-label={t('call.outcomeLabel', { call: label })}
          />
          <Select
            value={value.scope}
            onChange={(scope) => onChange({ ...value, scope })}
            options={[
              { value: '', label: t('call.scope.default') },
              { value: 'main', label: t('call.scope.main') },
              { value: 'sub', label: t('call.scope.sub') },
              { value: 'any', label: t('call.scope.any') },
            ]}
            aria-label={t('call.scopeLabel', { call: label })}
          />
        </div>
        {value.input && <span className="field-hint mono">{t('call.inputKept', { count: Object.keys(value.input).length })}</span>}
      </div>
    </div>
  );
}

/** One expectation: its kind, the fields of that kind, and a way to take it out. */
export function ExpectRow({
  value,
  onChange,
  onRemove,
  errors,
  index,
  phase2 = false,
}: {
  value: ExpectForm;
  onChange: (next: ExpectForm) => void;
  onRemove: () => void;
  errors: string[];
  index: number;
  /** Offers the judged expectation; a file that already has one always shows it */
  phase2?: boolean;
}) {
  const { t } = useTranslation('evals');
  const set = (patch: Partial<ExpectForm>) => onChange({ ...value, ...patch });
  const invalid = errors.length > 0;
  return (
    <li className="evals-expect" aria-label={t('expect.row', { n: index + 1 })}>
      <div className="evals-expect-head">
        <Select
          value={value.kind}
          // Switching the kind keeps what the person typed for the others: a slip is undone by switching back
          onChange={(kind) => onChange({ ...value, kind })}
          options={(phase2 || value.kind === 'judged' ? EXPECTATION_KIND_LIST_V2 : EXPECTATION_KIND_LIST).map((kind) => ({ value: kind, label: t(`expect.kind.${kind}`), hint: t(`expect.hint.${kind}`) }))}
          aria-label={t('expect.kindLabel', { n: index + 1 })}
          className="evals-expect-kind"
        />
        <span className="grow" />
        <button type="button" className="btn btn-ghost btn-icon" onClick={onRemove} aria-label={t('expect.remove', { n: index + 1 })}>
          <Trash2 {...ICON_SM} />
        </button>
      </div>
      <div className="evals-expect-body">
        {(value.kind === 'called' || value.kind === 'not-called' || value.kind === 'before' || value.kind === 'after') && (
          <CallFields value={value.call} onChange={(call) => set({ call })} label={t('expect.call')} invalid={invalid} />
        )}
        {value.kind === 'called' && (
          <div className="evals-expect-count">
            <label className="field">
              <span className="field-label">{t('expect.min')}</span>
              <input className="mono" inputMode="numeric" value={value.min} onChange={(event) => set({ min: event.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">{t('expect.max')}</span>
              <input className="mono" inputMode="numeric" value={value.max} onChange={(event) => set({ max: event.target.value })} />
            </label>
          </div>
        )}
        {(value.kind === 'before' || value.kind === 'after') && (
          <>
            <CallFields value={value.anchor} onChange={(anchor) => set({ anchor })} label={t('expect.anchor')} />
            <Switch checked={value.ifAnchor} onChange={(ifAnchor) => set({ ifAnchor })} aria-label={t('expect.ifAnchor')} className="check">
              <span>{t('expect.ifAnchor')}</span>
            </Switch>
          </>
        )}
        {value.kind === 'sequence' && (
          <>
            {value.calls.map((call, i) => (
              <CallFields
                key={i}
                value={call}
                onChange={(next) => set({ calls: value.calls.map((c, j) => (j === i ? next : c)) })}
                label={t('expect.step', { n: i + 1 })}
              />
            ))}
            <div className="evals-expect-steps">
              <button type="button" className="btn" onClick={() => set({ calls: [...value.calls, blankExpect().call] })}>
                {t('expect.addStep')}
              </button>
              {value.calls.length > 2 && (
                <button type="button" className="btn" onClick={() => set({ calls: value.calls.slice(0, -1) })}>
                  {t('expect.removeStep')}
                </button>
              )}
            </div>
            <Switch checked={value.strict} onChange={(strict) => set({ strict })} aria-label={t('expect.strict')} className="check">
              <span>{t('expect.strict')}</span>
            </Switch>
          </>
        )}
        {value.kind === 'text' && <MatcherField value={value.match} onChange={(match) => set({ match })} label={t('expect.text')} invalid={invalid} />}
        {value.kind === 'file' && (
          <>
            <label className="field">
              <span className="field-label">{t('expect.file')}</span>
              <input className={`mono${invalid ? ' is-invalid' : ''}`} value={value.file} onChange={(event) => set({ file: event.target.value })} spellCheck={false} />
            </label>
            <Select
              value={value.exists}
              onChange={(exists) => set({ exists })}
              options={[
                { value: '', label: t('expect.exists.default') },
                { value: 'true', label: t('expect.exists.true') },
                { value: 'false', label: t('expect.exists.false') },
              ]}
              aria-label={t('expect.existsLabel')}
            />
            <MatcherField value={value.contains} onChange={(contains) => set({ contains })} label={t('expect.contains')} />
          </>
        )}
        {value.kind === 'touched' && (
          <>
            <MatcherField value={value.touchedPath} onChange={(touchedPath) => set({ touchedPath })} label={t('expect.touchedPath')} invalid={invalid} />
            <Select
              value={value.touched ? 'true' : 'false'}
              onChange={(touched) => set({ touched: touched === 'true' })}
              options={[
                { value: 'true', label: t('expect.touched.true') },
                { value: 'false', label: t('expect.touched.false') },
              ]}
              aria-label={t('expect.touchedLabel')}
            />
          </>
        )}
        {value.kind === 'command' && (
          <>
            <label className="field">
              <span className="field-label">{t('expect.run')}</span>
              <input className={`mono${invalid ? ' is-invalid' : ''}`} value={value.run} onChange={(event) => set({ run: event.target.value })} spellCheck={false} />
              <span className="field-hint">{t('expect.runHint')}</span>
            </label>
            <div className="evals-expect-count">
              <label className="field">
                <span className="field-label">{t('expect.exitCode')}</span>
                <input className="mono" inputMode="numeric" value={value.exitCode} onChange={(event) => set({ exitCode: event.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">{t('expect.timeoutSeconds')}</span>
                <input className="mono" inputMode="numeric" value={value.timeoutSeconds} onChange={(event) => set({ timeoutSeconds: event.target.value })} />
              </label>
            </div>
          </>
        )}
        {value.kind === 'judged' && (
          <>
            <label className="field">
              <span className="field-label">{t('expect.statement')}</span>
              <textarea
                rows={2}
                className={invalid ? 'is-invalid' : ''}
                value={value.statement}
                maxLength={EVAL_LIMITS.judgeStatementChars.max}
                onChange={(event) => set({ statement: event.target.value })}
                aria-label={t('expect.statement')}
              />
              <span className="field-hint">{t('expect.statementHint')}</span>
            </label>
            <label className="field">
              <span className="field-label">{t('expect.judgeModel')}</span>
              <input className="mono" value={value.judgeModel} onChange={(event) => set({ judgeModel: event.target.value })} placeholder="haiku" spellCheck={false} />
            </label>
            {value.examples && <span className="field-hint mono">{t('expect.examplesKept', { count: value.examples.length })}</span>}
          </>
        )}
        {errors.map((error) => (
          <span key={error} className="field-error mono" role="alert">
            {error}
          </span>
        ))}
      </div>
    </li>
  );
}
