import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Braces, Check, FileWarning, Pin, Plus, TriangleAlert, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EVAL_LIMITS, type EvalDefinition, type EvalFileDetail, type EvalTargetKind, type Team } from '@claudio/shared';
import { Collapsible, Combobox, NumberInput, Select } from '@claudio/ui/components/controls';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Segmented, Skeleton, Tag } from '@claudio/ui/components/ui';
import { api, ApiRequestError, keys, useEvalFile, useEvalHead } from '../../../api';
import { useDirty } from '../../../lib/dirty';
import { ExpectRow } from './Expect';
import {
  blankCase,
  blankDefinition,
  blankExpect,
  caseForm,
  definitionFromForm,
  definitionFromJson,
  EFFORTS,
  formFromDefinition,
  INSTRUCTION_NAMES,
  jsonOf,
  nameFromTitle,
  problemsAt,
  resourceKindOf,
  sameDefinition,
  shortSha,
  validName,
  type EvalForm,
} from './model';

const KINDS: readonly EvalTargetKind[] = ['agent', 'skill', 'rule', 'instructions'];
const STAGES = ['refine', 'work', 'verify'] as const;

function Row({ label, hint, errors, children }: { label: string; hint?: ReactNode; errors?: string[]; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {errors?.map((error) => (
        <span key={error} className="field-error mono" role="alert">
          {error}
        </span>
      ))}
    </div>
  );
}

/** Reads the number a field holds; an unreadable one is shown empty and the server says what it thinks. */
const asNumber = (text: string): number | undefined => {
  const n = Number(text.replace(',', '.'));
  return text.trim() === '' || !Number.isFinite(n) ? undefined : n;
};

/**
 * One eval, as a form or as its JSON. Saving writes the file with the SHA that was read, so a file
 * changed on disk meanwhile (a `git pull`, another editor) is offered as "reload" or "overwrite",
 * never overwritten silently. What the server finds wrong with a field is shown under the field.
 */
export function EvalEditor({
  projectId,
  team,
  name,
  existing,
  onBack,
  onSaved,
}: {
  projectId: string;
  team: Team;
  /** The eval being edited; null for a new one */
  name: string | null;
  /** The names already taken, for the new one's */
  existing: readonly string[];
  onBack: () => void;
  onSaved: (name: string) => void;
}) {
  const { t } = useTranslation(['evals', 'config']);
  const file = useEvalFile(projectId, name);
  const head = useEvalHead(projectId);
  if (name !== null && file.error && !file.data) return <ErrorBox error={file.error} />;
  if ((name !== null && !file.data) || !head.data) return <Skeleton rows={8} height={20} />;
  const loaded = name !== null ? (file.data ?? null) : null;
  if (loaded && (loaded.definition === null || loaded.problems.length > 0)) return <InvalidFile file={loaded} projectId={projectId} onBack={onBack} />;
  return (
    <Form
      key={`${name ?? 'new'}:${loaded?.sha ?? ''}`}
      projectId={projectId}
      team={team}
      name={name}
      existing={existing}
      loaded={loaded}
      headSha={head.data.sha}
      headSubject={head.data.subject}
      onBack={onBack}
      onSaved={onSaved}
    />
  );
}

/** A file that does not parse: its problems, and the way to remove it. Never run, never edited here. */
function InvalidFile({ file, projectId, onBack }: { file: EvalFileDetail; projectId: string; onBack: () => void }) {
  const { t } = useTranslation('evals');
  const confirm = useConfirm();
  const toast = useToast();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteEvalFile(projectId, file.name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.evals(projectId) });
      onBack();
    },
    onError: (error) => toast.error(t('editor.deleteFailed'), error),
  });
  return (
    <div className="evals-editor">
      <div className="evals-editor-head">
        <button type="button" className="btn" onClick={onBack}>
          <ArrowLeft {...ICON_SM} />
          {t('editor.back')}
        </button>
        <h2 className="evals-editor-title mono">{file.name}</h2>
        <Tag tone="bad" icon={FileWarning}>
          {t('list.invalid')}
        </Tag>
      </div>
      <section className="card evals-invalid" aria-labelledby="evals-invalid-title">
        <h3 id="evals-invalid-title">{t('invalid.title')}</h3>
        <p>{t('invalid.body')}</p>
        <ul className="evals-problems mono">
          {file.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
        <span className="field-hint mono">{file.path}</span>
        <div className="evals-actions">
          <button
            type="button"
            className="btn btn-danger"
            disabled={remove.isPending}
            onClick={() =>
              void confirm({ title: t('editor.deleteTitle', { name: file.name }), body: t('editor.deleteBody'), confirmLabel: t('editor.delete'), danger: true }).then((ok) => ok && remove.mutate())
            }
          >
            <Trash2 {...ICON_SM} />
            {t('editor.delete')}
          </button>
        </div>
      </section>
    </div>
  );
}

function Form({
  projectId,
  team,
  name,
  existing,
  loaded,
  headSha,
  headSubject,
  onBack,
  onSaved,
}: {
  projectId: string;
  team: Team;
  name: string | null;
  existing: readonly string[];
  loaded: EvalFileDetail | null;
  headSha: string | null;
  headSubject: string | null;
  onBack: () => void;
  onSaved: (name: string) => void;
}) {
  const { t } = useTranslation(['evals', 'config']);
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const base: EvalDefinition = loaded?.definition ?? blankDefinition(headSha ?? '');
  const [baseline, setBaseline] = useState<{ sha: string | null; def: EvalDefinition }>({ sha: loaded?.sha ?? null, def: base });
  const [form, setForm] = useState<EvalForm>(() => formFromDefinition(base));
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [text, setText] = useState('');
  const [newName, setNewName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [conflict, setConflict] = useState<EvalFileDetail | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);

  const parsed = mode === 'json' ? definitionFromJson(text) : null;
  const current: EvalDefinition | null = mode === 'form' ? definitionFromForm(form) : parsed?.ok ? parsed.definition : null;
  const fileName = name ?? newName;
  const nameProblem = name !== null ? null : newName === '' ? 'empty' : !validName(newName) ? 'pattern' : existing.includes(newName) ? 'taken' : null;
  const dirty = name === null ? newName !== '' || current === null || !sameDefinition(current, base) : current === null || !sameDefinition(current, baseline.def);
  useDirty('evals-editor', dirty);

  // The file's name follows the title until the person writes their own
  useEffect(() => {
    if (name === null && !nameTouched) setNewName(nameFromTitle(form.title));
  }, [name, nameTouched, form.title]);

  const kind = resourceKindOf(form.targetKind);
  const names = useQuery({
    queryKey: keys.resources(form.targetScope === 'project' ? { projectId } : {}, kind ?? 'agents'),
    queryFn: () => api.resources(form.targetScope === 'project' ? { projectId } : {}, kind ?? 'agents'),
    enabled: kind !== null,
  });
  const nameOptions = useMemo(() => (names.data ?? []).map((resource) => ({ value: resource.name })), [names.data]);

  const set = (patch: Partial<EvalForm>) => setForm((f) => ({ ...f, ...patch }));
  const err = (path: string) => problemsAt(problems, path);

  const switchMode = (next: 'form' | 'json') => {
    if (next === mode) return;
    if (next === 'json') {
      setText(jsonOf(definitionFromForm(form)));
      setMode('json');
      return;
    }
    const read = definitionFromJson(text);
    if (!read.ok) return;
    setForm(formFromDefinition(read.definition));
    setMode('form');
  };

  const discard = () => {
    setForm(formFromDefinition(name === null ? base : baseline.def));
    setNewName('');
    setNameTouched(false);
    setProblems([]);
    setConflict(null);
    setSaveError(null);
    if (mode === 'json') setText(jsonOf(name === null ? base : baseline.def));
  };

  const save = useMutation({
    mutationFn: (sha: string | null) => {
      if (!current) throw new Error(t('editor.jsonInvalid'));
      return api.putEvalFile(projectId, fileName, { definition: current, ifMatch: sha });
    },
    onSuccess: (saved) => {
      setProblems([]);
      setConflict(null);
      setSaveError(null);
      setBaseline({ sha: saved.sha, def: saved.definition ?? current ?? base });
      toast.success(t('editor.saved'));
      void queryClient.invalidateQueries({ queryKey: keys.evals(projectId) });
      void queryClient.invalidateQueries({ queryKey: keys.evalHead(projectId) });
      if (name === null) onSaved(saved.name);
    },
    onError: (error) => {
      setSaveError(null);
      if (error instanceof ApiRequestError && error.code === 'changed-on-disk') {
        // The file as it is on disk now, to show both SHAs and to offer reload or overwrite
        void api.evalFile(projectId, fileName).then(setConflict, () => setSaveError(error));
        return;
      }
      if (error instanceof ApiRequestError && error.problems?.length) {
        setProblems(error.problems);
        return;
      }
      setSaveError(error);
    },
  });

  const reload = () => {
    if (!conflict?.definition) return;
    setBaseline({ sha: conflict.sha, def: conflict.definition });
    setForm(formFromDefinition(conflict.definition));
    if (mode === 'json') setText(jsonOf(conflict.definition));
    setConflict(null);
    setProblems([]);
  };

  const remove = useMutation({
    mutationFn: () => api.deleteEvalFile(projectId, fileName),
    onSuccess: () => {
      setBaseline({ sha: null, def: current ?? base });
      void queryClient.invalidateQueries({ queryKey: keys.evals(projectId) });
      onBack();
    },
    onError: (error) => toast.error(t('editor.deleteFailed'), error),
  });

  const back = () => {
    // The leave guard already asks about what is unsaved when the section changes; going back to the list asks the same
    if (!dirty) return onBack();
    void confirm({ title: t('config:shared.unsaved'), body: t('editor.discardBody'), confirmLabel: t('config:shared.discard'), danger: true }).then((ok) => ok && onBack());
  };

  const pinSubject = headSha !== null && form.pin === headSha ? headSubject : null;
  const agents = team.members.map((member) => ({ value: member.agent, label: member.agent }));
  const canSave = dirty && !save.isPending && current !== null && (name !== null || nameProblem === null);

  return (
    <div className="evals-editor">
      <div className="evals-editor-head">
        <button type="button" className="btn" onClick={back}>
          <ArrowLeft {...ICON_SM} />
          {t('editor.back')}
        </button>
        <h2 className="evals-editor-title">{name === null ? t('editor.newTitle') : form.title || fileName}</h2>
        {dirty && <Tag tone="warn">{t('config:shared.unsaved')}</Tag>}
        <span className="grow" />
        <Segmented<'form' | 'json'>
          value={mode}
          label={t('editor.view')}
          onChange={switchMode}
          options={[
            { value: 'form', label: t('editor.form'), disabled: mode === 'json' && parsed !== null && !parsed.ok, title: mode === 'json' && parsed && !parsed.ok ? t('editor.jsonInvalid') : '' },
            { value: 'json', label: <><Braces size={13} strokeWidth={2} aria-hidden /> JSON</> },
          ]}
        />
      </div>

      {mode === 'json' && parsed && !parsed.ok && (
        <div className="alert alert-bad" role="alert">
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
          <div className="alert-body">
            <strong>{t('editor.jsonInvalid')}</strong>
            <div className="mono">{parsed.error}</div>
          </div>
        </div>
      )}
      {conflict && (
        <div className="alert alert-warn" role="alert">
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
          <div className="alert-body">
            <strong>{t('editor.changedOnDisk')}</strong>
            <div>{t('editor.changedBody')}</div>
            <div className="mono evals-shas">
              {t('editor.shaYours')} {baseline.sha ? shortSha(baseline.sha) : '—'} · {t('editor.shaDisk')} {shortSha(conflict.sha)}
            </div>
            <div className="evals-actions">
              <button type="button" className="btn" disabled={!conflict.definition} onClick={reload}>
                <Undo2 {...ICON_SM} />
                {t('editor.reload')}
              </button>
              <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(conflict.sha)}>
                {t('editor.overwrite')}
              </button>
            </div>
          </div>
        </div>
      )}
      {saveError !== null && <ErrorBox error={saveError} title={t('editor.saveFailed')} />}
      {problems.length > 0 && mode === 'json' && (
        <div className="alert alert-bad" role="alert">
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
          <div className="alert-body">
            <strong>{t('editor.problems')}</strong>
            <ul className="evals-problems mono">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {mode === 'json' ? (
        <section className="card">
          <textarea
            className="mono evals-json"
            value={text}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            rows={28}
            aria-label={t('editor.jsonLabel')}
          />
        </section>
      ) : (
        <>
          <section className="card evals-section" aria-labelledby="evals-sec-eval">
            <h3 id="evals-sec-eval">{t('editor.sections.eval')}</h3>
            <Row label={t('editor.title')} errors={err('title')} hint={t('editor.english')}>
              <input value={form.title} onChange={(event) => set({ title: event.target.value })} maxLength={EVAL_LIMITS.titleChars.max} aria-label={t('editor.title')} />
            </Row>
            {name === null && (
              <Row
                label={t('editor.fileName')}
                hint={<span className="mono">.claude/claudio-evals/{newName || '…'}.json</span>}
                errors={nameTouched || newName !== '' ? (nameProblem && nameProblem !== 'empty' ? [t(`editor.name.${nameProblem}`)] : []) : []}
              >
                <input
                  className="mono"
                  value={newName}
                  onChange={(event) => {
                    setNameTouched(true);
                    setNewName(event.target.value);
                  }}
                  spellCheck={false}
                  aria-label={t('editor.fileName')}
                />
              </Row>
            )}
          </section>

          <section className="card evals-section" aria-labelledby="evals-sec-target">
            <h3 id="evals-sec-target">{t('editor.sections.target')}</h3>
            <div className="evals-grid">
              <Row label={t('editor.targetKind')} errors={err('target.kind')}>
                <Select<EvalTargetKind>
                  value={form.targetKind}
                  onChange={(targetKind) => set({ targetKind, targetName: targetKind === 'instructions' ? 'CLAUDE.md' : '' })}
                  options={KINDS.map((k) => ({ value: k, label: t(`editor.kind.${k}`) }))}
                  aria-label={t('editor.targetKind')}
                />
              </Row>
              <Row label={t('editor.targetScope')} errors={err('target.scope')} hint={form.targetScope === 'user' ? t('editor.userScope') : undefined}>
                <Select<'project' | 'user'>
                  value={form.targetScope}
                  onChange={(targetScope) => set({ targetScope })}
                  options={[
                    { value: 'project', label: t('editor.scope.project') },
                    { value: 'user', label: t('editor.scope.user') },
                  ]}
                  aria-label={t('editor.targetScope')}
                />
              </Row>
              <Row label={t('editor.targetName')} errors={err('target.name')}>
                {form.targetKind === 'instructions' ? (
                  <Select value={form.targetName} onChange={(targetName) => set({ targetName })} options={INSTRUCTION_NAMES.map((n) => ({ value: n, label: n }))} aria-label={t('editor.targetName')} />
                ) : (
                  <Combobox value={form.targetName} onChange={(targetName) => set({ targetName })} options={nameOptions} placeholder={t('editor.targetNamePlaceholder')} aria-label={t('editor.targetName')} />
                )}
              </Row>
            </div>
          </section>

          <section className="card evals-section" aria-labelledby="evals-sec-runas">
            <h3 id="evals-sec-runas">{t('editor.sections.runAs')}</h3>
            <p className="evals-note">{t('editor.runAsNote')}</p>
            <div className="evals-grid">
              <Row label={t('editor.runAsAgent')} errors={err('runAs.agent')}>
                <Select
                  value={form.runAsAgent}
                  onChange={(runAsAgent) => set({ runAsAgent })}
                  options={[{ value: '', label: t('editor.runAsNobody') }, ...agents]}
                  aria-label={t('editor.runAsAgent')}
                />
              </Row>
              <Row label={t('editor.runAsStage')} errors={err('runAs.stage')}>
                <Select
                  value={form.runAsStage}
                  onChange={(runAsStage) => set({ runAsStage })}
                  options={[{ value: '', label: t('editor.stageDefault') }, ...STAGES.map((s) => ({ value: s, label: t(`editor.stage.${s}`) }))]}
                  aria-label={t('editor.runAsStage')}
                />
              </Row>
              <Row label={t('editor.runAsModel')} errors={err('runAs.model')}>
                <input className="mono" value={form.runAsModel} onChange={(event) => set({ runAsModel: event.target.value })} placeholder="claude-sonnet-5-5" spellCheck={false} aria-label={t('editor.runAsModel')} />
              </Row>
              <Row label={t('editor.runAsEffort')} errors={err('runAs.effort')}>
                <Select
                  value={form.runAsEffort}
                  onChange={(runAsEffort) => set({ runAsEffort })}
                  options={[{ value: '', label: t('editor.effortDefault') }, ...EFFORTS.map((e) => ({ value: e, label: e }))]}
                  aria-label={t('editor.runAsEffort')}
                />
              </Row>
            </div>
          </section>

          <section className="card evals-section" aria-labelledby="evals-sec-pin">
            <h3 id="evals-sec-pin">{t('editor.sections.pin')}</h3>
            <Row label={t('editor.pin')} hint={t('editor.pinHint')} errors={err('pin')}>
              <div className="evals-pin">
                <input className={`mono${err('pin').length ? ' is-invalid' : ''}`} value={form.pin} onChange={(event) => set({ pin: event.target.value.trim() })} spellCheck={false} aria-label={t('editor.pin')} />
                <button type="button" className="btn" disabled={headSha === null || form.pin === headSha} onClick={() => headSha && set({ pin: headSha })}>
                  <Pin {...ICON_SM} />
                  {t('editor.pinHead')}
                </button>
              </div>
              {form.pin && (
                <span className="evals-pin-line mono">
                  {shortSha(form.pin)}
                  {pinSubject ? ` · ${pinSubject}` : ''}
                </span>
              )}
            </Row>
          </section>

          <section className="card evals-section" aria-labelledby="evals-sec-limits">
            <h3 id="evals-sec-limits">{t('editor.sections.limits')}</h3>
            <div className="evals-grid">
              <Row label={t('editor.samples')} errors={err('samples')} hint={t('editor.samplesHint')}>
                <NumberInput
                  value={asNumber(form.samples)}
                  onChange={(n) => set({ samples: n === undefined ? '' : String(n) })}
                  min={EVAL_LIMITS.samples.min}
                  max={EVAL_LIMITS.samples.max}
                  placeholder={String(EVAL_LIMITS.samples.default)}
                  aria-label={t('editor.samples')}
                />
              </Row>
              <Row label={t('editor.perSample')} errors={err('limits.maxCostUsdPerSample')}>
                <NumberInput
                  decimal
                  step={0.1}
                  value={asNumber(form.maxCostUsdPerSample)}
                  onChange={(n) => set({ maxCostUsdPerSample: n === undefined ? '' : String(n) })}
                  min={EVAL_LIMITS.maxCostUsdPerSample.min}
                  max={EVAL_LIMITS.maxCostUsdPerSample.max}
                  placeholder={String(EVAL_LIMITS.maxCostUsdPerSample.default)}
                  aria-label={t('editor.perSample')}
                />
              </Row>
              <Row label={t('editor.timeout')} errors={err('limits.timeoutMinutes')}>
                <NumberInput
                  value={asNumber(form.timeoutMinutes)}
                  onChange={(n) => set({ timeoutMinutes: n === undefined ? '' : String(n) })}
                  min={EVAL_LIMITS.timeoutMinutes.min}
                  max={EVAL_LIMITS.timeoutMinutes.max}
                  placeholder={String(EVAL_LIMITS.timeoutMinutes.default)}
                  aria-label={t('editor.timeout')}
                />
              </Row>
              <Row label={t('editor.ceiling')} errors={err('limits.maxCostUsd')} hint={t('editor.ceilingHint')}>
                <NumberInput
                  decimal
                  step={1}
                  value={asNumber(form.maxCostUsd)}
                  onChange={(n) => set({ maxCostUsd: n === undefined ? '' : String(n) })}
                  min={EVAL_LIMITS.maxCostUsd.min}
                  max={EVAL_LIMITS.maxCostUsd.max}
                  aria-label={t('editor.ceiling')}
                />
              </Row>
            </div>
            <Row label={t('editor.setup')} errors={err('setup')}>
              <textarea className="mono" rows={2} value={form.setup} onChange={(event) => set({ setup: event.target.value })} spellCheck={false} aria-label={t('editor.setup')} />
              <span className="evals-warn">
                <TriangleAlert size={13} strokeWidth={2} aria-hidden />
                {t('editor.setupWarn')}
              </span>
            </Row>
            {form.policy && <span className="field-hint">{t('editor.policyKept')}</span>}
          </section>

          <section className="evals-cases" aria-labelledby="evals-sec-cases">
            <div className="evals-cases-head">
              <h3 id="evals-sec-cases">{t('editor.sections.cases', { count: form.cases.length })}</h3>
              <button
                type="button"
                className="btn"
                disabled={form.cases.length >= EVAL_LIMITS.cases.max}
                onClick={() => set({ cases: [...form.cases, caseForm(blankCase(form.cases.map((c) => c.id)))] })}
              >
                <Plus {...ICON_SM} />
                {t('editor.addCase')}
              </button>
            </div>
            {form.cases.map((c, i) => {
              const at = `cases[${i}]`;
              const setCase = (patch: Partial<typeof c>) => set({ cases: form.cases.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              const caseErrors = problemsAt(problems, at).length;
              return (
                <Collapsible
                  key={i}
                  className="card evals-case"
                  defaultOpen={i === 0 || caseErrors > 0}
                  title={
                    <span className="evals-case-title">
                      <span className="mono">{c.id || t('editor.caseUntitled')}</span>
                      <span className="evals-case-gist">{c.title || c.prompt.split('\n')[0]}</span>
                      <span className="mono evals-case-count">{t('editor.expectCount', { count: c.expect.length })}</span>
                      {caseErrors > 0 && <Tag tone="bad">{t('editor.caseProblems', { count: caseErrors })}</Tag>}
                    </span>
                  }
                >
                  <div className="evals-case-body">
                    <div className="evals-grid">
                      <Row label={t('editor.caseId')} errors={err(`${at}.id`)}>
                        <input className="mono" value={c.id} onChange={(event) => setCase({ id: event.target.value })} spellCheck={false} aria-label={t('editor.caseId')} />
                      </Row>
                      <Row label={t('editor.caseTitle')} errors={err(`${at}.title`)}>
                        <input value={c.title} onChange={(event) => setCase({ title: event.target.value })} aria-label={t('editor.caseTitle')} />
                      </Row>
                      <Row label={t('editor.casePin')} errors={err(`${at}.pin`)} hint={t('editor.casePinHint')}>
                        <input className="mono" value={c.pin} onChange={(event) => setCase({ pin: event.target.value.trim() })} spellCheck={false} aria-label={t('editor.casePin')} />
                      </Row>
                    </div>
                    <Row label={t('editor.prompt')} errors={err(`${at}.prompt`)} hint={t('editor.promptHint', { max: EVAL_LIMITS.promptChars.max })}>
                      <textarea rows={4} value={c.prompt} onChange={(event) => setCase({ prompt: event.target.value })} aria-label={t('editor.prompt')} />
                    </Row>
                    <h4 className="evals-expect-heading">{t('editor.expectations')}</h4>
                    <ol className="evals-expects">
                      {c.expect.map((e, k) => (
                        <ExpectRow
                          key={k}
                          index={k}
                          value={e}
                          errors={problemsAt(problems, `${at}.expect[${k}]`)}
                          onChange={(next) => setCase({ expect: c.expect.map((x, m) => (m === k ? next : x)) })}
                          onRemove={() => setCase({ expect: c.expect.filter((_, m) => m !== k) })}
                        />
                      ))}
                    </ol>
                    {err(`${at}.expect`).length > 0 && c.expect.length === 0 && <span className="field-error mono">{err(`${at}.expect`).join(' · ')}</span>}
                    <div className="evals-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={c.expect.length >= EVAL_LIMITS.expectPerCase.max}
                        onClick={() => setCase({ expect: [...c.expect, blankExpect()] })}
                      >
                        <Plus {...ICON_SM} />
                        {t('editor.addExpectation')}
                      </button>
                      <button type="button" className="btn btn-danger" disabled={form.cases.length <= 1} onClick={() => set({ cases: form.cases.filter((_, j) => j !== i) })}>
                        <Trash2 {...ICON_SM} />
                        {t('editor.removeCase')}
                      </button>
                    </div>
                  </div>
                </Collapsible>
              );
            })}
          </section>
        </>
      )}

      <div className="evals-footer">
        {name !== null && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={remove.isPending}
            onClick={() =>
              void confirm({ title: t('editor.deleteTitle', { name: fileName }), body: t('editor.deleteBody'), confirmLabel: t('editor.delete'), danger: true }).then((ok) => ok && remove.mutate())
            }
          >
            <Trash2 {...ICON_SM} />
            {t('editor.delete')}
          </button>
        )}
        <span className="grow" />
        <button type="button" className="btn" disabled={!dirty || save.isPending} onClick={discard}>
          <Undo2 {...ICON_SM} />
          {t('config:shared.discard')}
        </button>
        <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => save.mutate(baseline.sha)}>
          <Check {...ICON_SM} />
          {save.isPending ? t('editor.saving') : t('editor.save')}
        </button>
      </div>
    </div>
  );
}
