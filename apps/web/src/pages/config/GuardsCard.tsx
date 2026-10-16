import {
  DEFAULT_PROTECTED_CONFIGS,
  GUARD_RULES,
  MAX_PROTECTED_CONFIGS,
  type GuardCheckRequest,
  type GuardCheckResult,
  type GuardEvent,
  type GuardOutcome,
  type GuardRuleId,
  type GuardSettingsView,
  type GuardSwitchableRuleId,
  type UpdateGuardSettingsRequest,
} from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiRequestError, api, keys } from '../../api';
import { Select, Switch, type SelectOption } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Card, Field, Skeleton, Tag } from '@claudio/ui/components/ui';
import { errorMessage, formatDateTime } from '@claudio/ui/lib/format';

const RECENT_BLOCKS = 20;
const MAX_GLOB_LENGTH = 300;
const CHECK_TOOLS = ['Bash', 'Write', 'Edit'] as const;
export type CheckTool = (typeof CHECK_TOOLS)[number];

/** A reason the server would refuse `protectConfigs` for, with the glob it names; same checks as `parseProtectConfigs`. */
export interface GlobProblem {
  key: 'tooMany' | 'tooLong' | 'absolute' | 'parent';
  glob?: string;
}

/** The globs a textarea holds, one per line, blanks and repeats dropped, and what the server would say about them. */
export function parseGlobs(text: string): { globs: string[]; problems: GlobProblem[] } {
  const globs = [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))];
  const problems: GlobProblem[] = [];
  if (globs.length > MAX_PROTECTED_CONFIGS) problems.push({ key: 'tooMany' });
  for (const glob of globs) {
    if (glob.length > MAX_GLOB_LENGTH) problems.push({ key: 'tooLong', glob });
    else if (glob.startsWith('/') || /^[a-z]:[\\/]/i.test(glob)) problems.push({ key: 'absolute', glob });
    else if (glob.split(/[\\/]/).includes('..')) problems.push({ key: 'parent', glob });
  }
  return { globs, problems };
}

/** What "Try a command" sends: a command for Bash, a path and its content for a write tool. */
export function checkRequest(tool: CheckTool, target: string, content: string): GuardCheckRequest | null {
  const text = target.trim();
  if (!text) return null;
  if (tool === 'Bash') return { tool, input: { command: text } };
  return { tool, input: tool === 'Write' ? { file_path: text, content } : { file_path: text, old_string: '', new_string: content } };
}

const isForbidden = (error: unknown) => error instanceof ApiRequestError && error.status === 403;

const outcomeTone = (outcome: GuardOutcome): string => (outcome === 'blocked' ? 'warn' : outcome === 'observed' || outcome === 'allowed-once' ? 'muted' : 'bad');

export interface GuardsCardViewProps {
  /** Undefined while the first read is in flight */
  data: GuardSettingsView | undefined;
  loadError: unknown;
  onRetry: () => void;
  /** Writes are refused for everyone while the wrapper is read-only */
  readOnly: boolean;
  events: GuardEvent[] | undefined;
  eventsError: unknown;
  saving: boolean;
  saveError: unknown;
  onSave: (change: UpdateGuardSettingsRequest) => void;
  checking: boolean;
  checkResult: GuardCheckResult | undefined;
  checkError: unknown;
  onCheck: (request: GuardCheckRequest) => void;
}

/** The pure card: every state it can be in is a prop, so each one can be drawn on its own. */
export function GuardsCardView(props: GuardsCardViewProps) {
  const { t } = useTranslation('config');
  const { data, loadError } = props;
  return (
    <div id="guards">
      <Card title={t('security.guards.title')} actions={data && <StatusTag data={data} />}>
        <p className="small muted">{t('security.guards.intro')}</p>
        {loadError !== undefined && loadError !== null && !data && (
          <div className="alert alert-bad" role="alert">
            <div className="alert-body">
              <strong>{t('security.guards.loadFailed')}</strong>
              <div>{errorMessage(loadError)}</div>
            </div>
            <button type="button" className="btn btn-small" onClick={props.onRetry}>
              {t('security.guards.retry')}
            </button>
          </div>
        )}
        {!data && !loadError && <Skeleton rows={6} />}
        {data && <GuardsBody {...props} data={data} />}
      </Card>
    </div>
  );
}

function StatusTag({ data }: { data: GuardSettingsView }) {
  const { t } = useTranslation('config');
  const { status, settings } = data;
  if (!status.available) {
    return <Tag tone="bad" icon={ShieldCheck}>{t('security.guards.status.unavailable')}</Tag>;
  }
  if (settings.mode === 'observe') return <Tag tone="warn" icon={ShieldCheck}>{t('security.guards.status.observe')}</Tag>;
  return <Tag tone="ok" icon={ShieldCheck}>{t('security.guards.status.active')}</Tag>;
}

function StatusLine({ data }: { data: GuardSettingsView }) {
  const { t } = useTranslation('config');
  const { status, settings } = data;
  // `integrity` is always on, so it counts with the switchable rules that are
  const on = 1 + Object.values(settings.rules).filter(Boolean).length;
  if (!status.available) {
    const problem = status.problem ?? 'bad-path';
    return (
      <p className="guard-status is-bad" role="status">
        <ShieldCheck {...ICON_SM} aria-hidden />
        <span>{t('security.guards.status.notAvailable', { problem: t(`security.guards.problems.${problem}`) })}</span>
      </p>
    );
  }
  if (settings.mode === 'observe') {
    return (
      <p className="guard-status is-warn" role="status">
        <ShieldCheck {...ICON_SM} aria-hidden />
        <span>{t('security.guards.status.observeLine')}</span>
      </p>
    );
  }
  return (
    <p className="guard-status is-ok" role="status">
      <ShieldCheck {...ICON_SM} aria-hidden />
      <span>{t(settings.automated ? 'security.guards.status.activeLine' : 'security.guards.status.chatsOnlyLine', { count: on })}</span>
    </p>
  );
}

function GuardsBody(props: GuardsCardViewProps & { data: GuardSettingsView }) {
  const { t } = useTranslation('config');
  const { data, readOnly, saving, saveError, onSave } = props;
  const { settings } = data;
  const forbidden = isForbidden(saveError);
  const locked = readOnly || saving;

  return (
    <>
      <StatusLine data={data} />
      {readOnly && <p className="small muted">{t('security.guards.readOnlyNote')}</p>}
      {forbidden && (
        <div className="alert alert-warn" role="alert">
          <div className="alert-body">{t('security.guards.forbidden')}</div>
        </div>
      )}
      {!forbidden && saveError !== undefined && saveError !== null && !(saveError instanceof ApiRequestError && saveError.status === 400) && (
        <div className="alert alert-bad" role="alert">
          <div className="alert-body">
            <strong>{t('security.guards.saveFailed')}</strong>
            <div>{errorMessage(saveError)}</div>
          </div>
        </div>
      )}

      <div className="guard-switches">
        <div className="guard-row">
          <Switch checked={settings.automated} disabled={locked} onChange={(automated) => onSave({ automated })}>
            {t('security.guards.automated.label')}
          </Switch>
          <p className="small muted">{t('security.guards.automated.hint')}</p>
        </div>

        <ul className="guard-rules" aria-label={t('security.guards.rulesLabel')}>
          {GUARD_RULES.map((rule) => (
            <li key={rule.id} className={`guard-rule ${rule.switchable ? '' : 'is-locked'}`} data-rule={rule.id}>
              <div className="guard-rule-head">
                {rule.switchable ? (
                  <Switch
                    checked={settings.rules[rule.id as GuardSwitchableRuleId]}
                    disabled={locked}
                    onChange={(on) => onSave({ rules: { [rule.id]: on } })}
                  >
                    {t(`security.guards.rules.${rule.id}.name`)}
                  </Switch>
                ) : (
                  <span className="guard-rule-locked">
                    <Lock {...ICON_SM} aria-hidden />
                    <span className="strong">{t(`security.guards.rules.${rule.id}.name`)}</span>
                    <Tag>{t('security.guards.alwaysOn')}</Tag>
                  </span>
                )}
                <code className="mono small muted">{rule.id}</code>
              </div>
              <p className="small muted">{t(`security.guards.rules.${rule.id}.description`)}</p>
            </li>
          ))}
        </ul>

        <div className="guard-row">
          <Switch checked={settings.mode === 'observe'} disabled={locked} onChange={(observe) => onSave({ mode: observe ? 'observe' : 'enforce' })}>
            {t('security.guards.observe.label')}
          </Switch>
          <p className="small text-warn">{t('security.guards.observe.hint')}</p>
        </div>
      </div>

      {settings.rules['protect-configs'] && <ProtectConfigs {...props} />}
      <TryCommand {...props} />
      <RecentBlocks events={props.events} error={props.eventsError} />
    </>
  );
}

function ProtectConfigs({ data, readOnly, saving, saveError, onSave }: GuardsCardViewProps & { data: GuardSettingsView }) {
  const { t } = useTranslation('config');
  const saved = data.settings.protectConfigs;
  const [text, setText] = useState(saved.join('\n'));
  // A change made elsewhere replaces the draft, like the other cards that remount from the server's copy
  const savedText = saved.join('\n');
  const seen = useRef(savedText);
  useEffect(() => {
    if (seen.current !== savedText) {
      seen.current = savedText;
      setText(savedText);
    }
  }, [savedText]);

  const { globs, problems } = parseGlobs(text);
  const dirty = globs.join('\n') !== savedText;
  const serverReason = saveError instanceof ApiRequestError && saveError.status === 400 ? errorMessage(saveError) : null;
  const atDefaults = globs.join('\n') === DEFAULT_PROTECTED_CONFIGS.join('\n');

  return (
    <form
      className="form guard-configs"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && problems.length === 0) onSave({ protectConfigs: globs });
      }}
    >
      <Field label={t('security.guards.configs.label')} hint={t('security.guards.configs.hint')}>
        <textarea
          className="mono"
          rows={6}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          disabled={readOnly}
          aria-invalid={problems.length > 0 || serverReason !== null}
          value={text}
          onChange={(event) => setText(event.target.value)}
          data-testid="guard-configs"
        />
      </Field>
      {(problems.length > 0 || serverReason) && (
        <ul className="guard-problems field-hint text-err" role="status">
          {problems.map((problem) => (
            <li key={`${problem.key}:${problem.glob ?? ''}`}>
              {t(`security.guards.configs.problems.${problem.key}`, { glob: problem.glob, max: MAX_PROTECTED_CONFIGS, length: MAX_GLOB_LENGTH })}
            </li>
          ))}
          {serverReason && problems.length === 0 && <li>{serverReason}</li>}
        </ul>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={readOnly || saving || !dirty || problems.length > 0}>
          {saving ? t('shared.saving') : t('shared.save')}
        </button>
        <button type="button" className="btn" disabled={readOnly || atDefaults} onClick={() => setText(DEFAULT_PROTECTED_CONFIGS.join('\n'))}>
          {t('security.guards.configs.restore')}
        </button>
        {dirty && (
          <button type="button" className="btn" onClick={() => setText(savedText)}>
            {t('shared.discard')}
          </button>
        )}
      </div>
    </form>
  );
}

function TryCommand({ checking, checkResult, checkError, onCheck }: GuardsCardViewProps) {
  const { t } = useTranslation('config');
  const [tool, setTool] = useState<CheckTool>('Bash');
  const [target, setTarget] = useState('');
  const [content, setContent] = useState('');
  const request = checkRequest(tool, target, content);
  const options: SelectOption<CheckTool>[] = CHECK_TOOLS.map((value) => ({ value, label: value }));
  const writes = tool !== 'Bash';

  return (
    <form
      className="form guard-try"
      onSubmit={(event) => {
        event.preventDefault();
        if (request) onCheck(request);
      }}
    >
      <h3 className="guard-subtitle">{t('security.guards.try.title')}</h3>
      <p className="small muted">{t('security.guards.try.intro')}</p>
      <div className="guard-try-row">
        <Select aria-label={t('security.guards.try.toolLabel')} value={tool} options={options} onChange={setTool} />
        <input
          type="text"
          className="mono grow"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label={writes ? t('security.guards.try.pathLabel') : t('security.guards.try.commandLabel')}
          placeholder={writes ? t('security.guards.try.pathPlaceholder') : t('security.guards.try.commandPlaceholder')}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!request || checking}>
          {t('security.guards.try.action')}
        </button>
      </div>
      {writes && (
        <Field label={t('security.guards.try.contentLabel')}>
          <textarea className="mono" rows={4} spellCheck={false} value={content} onChange={(event) => setContent(event.target.value)} />
        </Field>
      )}
      <div className="guard-result" aria-live="polite" data-testid="guard-result">
        {checkError !== undefined && checkError !== null && <span className="text-err">{errorMessage(checkError)}</span>}
        {!checkError && checkResult && <CheckResultLine result={checkResult} />}
      </div>
    </form>
  );
}

export function CheckResultLine({ result }: { result: GuardCheckResult }) {
  const { t } = useTranslation('config');
  if (result.verdict === 'pass') {
    return <Tag tone="ok">{t('security.guards.try.pass')}</Tag>;
  }
  return (
    <>
      <Tag tone="warn" icon={ShieldCheck}>
        {t('security.guards.try.block')}
      </Tag>
      {result.rule && <code className="mono small">{result.rule}</code>}
      {result.reason && <span className="small">{result.reason}</span>}
    </>
  );
}

function RecentBlocks({ events, error }: { events: GuardEvent[] | undefined; error: unknown }) {
  const { t } = useTranslation('config');
  return (
    <div className="guard-recent">
      <h3 className="guard-subtitle">{t('security.guards.recent.title')}</h3>
      {error !== undefined && error !== null && <p className="small text-err">{errorMessage(error)}</p>}
      {!error && !events && <Skeleton rows={3} />}
      {!error && events && events.length === 0 && <p className="small muted">{t('security.guards.recent.none')}</p>}
      {events && events.length > 0 && (
        <ul className="guard-events">
          {events.map((event) => (
            <li key={event.seq} className="guard-event">
              <span className="mono small muted nowrap">{formatDateTime(event.at)}</span>
              <code className="mono small">{event.rule satisfies GuardRuleId}</code>
              <Tag tone={outcomeTone(event.outcome)}>{t(`security.guards.recent.outcome.${event.outcome}`)}</Tag>
              <span className="mono small guard-excerpt" title={event.excerpt}>
                {event.excerpt}
              </span>
              <Link className="small" to={`/chats/${event.chatId}`}>
                {t('security.guards.recent.chat')}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Settings → Security → Guards (docs/plans/guards.md, Web §1). */
export function GuardsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: keys.guardSettings, queryFn: ({ signal }) => api.guardSettings({ signal }) });
  const events = useQuery({
    queryKey: keys.guardEvents,
    queryFn: ({ signal }) => api.guardEvents({ limit: RECENT_BLOCKS }, { signal }),
    refetchInterval: 15_000,
  });
  const save = useMutation({
    mutationFn: api.updateGuardSettings,
    onSuccess: (next) => queryClient.setQueryData(keys.guardSettings, next),
  });
  const check = useMutation({ mutationFn: api.checkGuard });

  // `?tab=security#guards` lands on the card once the tab has drawn it
  useEffect(() => {
    if (window.location.hash === '#guards') document.getElementById('guards')?.scrollIntoView?.({ block: 'start' });
  }, [settings.isSuccess]);

  return (
    <GuardsCardView
      data={settings.data}
      loadError={settings.error}
      onRetry={() => void settings.refetch()}
      readOnly={readOnly}
      events={events.data?.events}
      eventsError={events.error}
      saving={save.isPending}
      saveError={save.error}
      onSave={(change) => save.mutate(change)}
      checking={check.isPending}
      checkResult={check.data}
      checkError={check.error}
      onCheck={(request) => check.mutate(request)}
    />
  );
}
