import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TerminalRemote, TerminalSettings, TerminalStatus, UpdateTerminalSettingsRequest } from '@claudio/shared';
import { NumberInput, Select, Switch, type SelectOption } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, Empty, ErrorBox, Field, Skeleton, Tag } from '@claudio/ui/components/ui';
import { formatDateTime, formatNumber } from '@claudio/ui/lib/format';
import { api, ApiRequestError, keys } from '../../../api';
import { useScreenReaderMode } from '../../../components/terminal/terminal-prefs';
import { terminalRefusal, type TerminalRefusal, type TerminalRefusalAction } from '../../../components/terminal/terminal-model';
import { useTerminalStatus } from '../../../components/terminal/use-terminals';
import { SaveButton, SettingsReveal } from '../groups/Block';
import { settingsHref } from '../settingsGroups';

const REMOTE_FIELD = 'terminal-remote';

const REMOTE: TerminalRemote[] = ['off', 'tunnel', 'any'];
// The server's own bounds (core's terminal settings); a value outside them is refused with a 400
const BOUNDS = { maxTerminals: [1, 32], idleMinutes: [5, 1440], scrollbackLines: [500, 10_000] } as const;
const PAGE = 10;

type Numbers = Pick<TerminalSettings, 'maxTerminals' | 'idleMinutes' | 'scrollbackLines'>;

/** The numbers that moved from what is saved, and nothing else: a key the environment owns is never sent. */
export function changedNumbers(status: TerminalStatus, draft: Partial<Numbers>): UpdateTerminalSettingsRequest {
  const out: UpdateTerminalSettingsRequest = {};
  for (const key of Object.keys(BOUNDS) as Array<keyof Numbers>) {
    const value = draft[key];
    if (value !== undefined && status.sources[key] !== 'env' && value !== status.settings[key]) out[key] = value;
  }
  return out;
}

/**
 * Why a change was refused, in the person's words and with what fixes it. The server's sentence is
 * never shown: it is English and says what the gate saw, not what to do.
 */
function RefusalAlert({ refusal }: { refusal: TerminalRefusal }) {
  const { t } = useTranslation('terminal');
  const action = (item: TerminalRefusalAction) => (
    <Link key={item.label} className="btn btn-small" to={settingsHref('access', { section: item.section })}>
      {t(`refusal.${item.label}`)}
    </Link>
  );
  return (
    <div className={refusal.tone === 'bad' ? 'alert alert-bad' : 'alert alert-warn'} role="alert" data-testid="terminal-refusal">
      <TriangleAlert {...ICON_SM} className="alert-icon" aria-hidden />
      <div className="alert-body stack">
        <span>{t(refusal.sentence)}</span>
        {refusal.actions.length > 0 && <div className="form-actions">{refusal.actions.map(action)}</div>}
      </div>
    </div>
  );
}

function useSaveTerminal(saved: string, onRefused?: (refusal: TerminalRefusal | null) => void) {
  const { t } = useTranslation('terminal');
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: UpdateTerminalSettingsRequest) => api.updateTerminalSettings(body),
    onMutate: () => onRefused?.(null),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.terminalStatus, next);
      toast.success(saved);
    },
    onError: (error) => {
      // A refusal is the gate working: it is said where the control is, and the control stays as it was
      const refusal = onRefused ? terminalRefusal(error) : null;
      if (refusal) onRefused?.(refusal);
      else toast.error(t('settings.saveFailed'), error);
    },
  });
}

function History() {
  const { t } = useTranslation('terminal');
  const [from, setFrom] = useState(0);
  const { data, error, isLoading } = useQuery({ queryKey: keys.terminalHistory(from), queryFn: ({ signal }) => api.terminalHistory(from, PAGE, { signal }) });
  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const last = Math.min(from + PAGE, total);
  return (
    <div className="term-history">
      <h3 className="small strong">{t('history.title')}</h3>
      {/* A refusal is said in words, as the card does; only a failure that is not one keeps the box */}
      {terminalRefusal(error) ? <RefusalAlert refusal={terminalRefusal(error) as TerminalRefusal} /> : <ErrorBox error={error} />}
      {isLoading ? (
        <Skeleton rows={3} />
      ) : error ? null : entries.length === 0 ? (
        <Empty title={t('history.none')}>{t('history.noneHint')}</Empty>
      ) : (
        <>
          <div className="table-wrap" role="group" aria-label={t('history.title')} tabIndex={0}>
            <table className="table" aria-label={t('history.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('history.when')}</th>
                  <th scope="col">{t('history.actor')}</th>
                  <th scope="col">{t('history.where')}</th>
                  <th scope="col">{t('history.how')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => {
                  const refused = entry.attachments.filter((attachment) => attachment.refused !== null);
                  return (
                    <tr key={`${entry.id}-${index}`}>
                      <td className="small muted nowrap">{formatDateTime(entry.startedAt)}</td>
                      <td className="small mono break">{entry.actor}</td>
                      <td className="small mono break">{entry.cwd || '—'}</td>
                      <td className="small term-history-how">
                        {entry.endReason ? t(`history.ended.${entry.endReason}`) : entry.id ? t('history.running') : ''}
                        {refused.length > 0 && (
                          <Tag tone="warn">
                            {t('history.refused', {
                              count: refused.length,
                              // A code the copy does not know yet still reads as words, never as the server's code
                              // Deduplicated as words, so two codes the copy does not know read once, not twice
                              reasons: [...new Set(refused.map((attachment) => t(`history.refusedReason.${attachment.refused}`, { defaultValue: t('history.refusedReason.unknown') })))].join(', '),
                            })}
                          </Tag>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-small" disabled={from === 0} onClick={() => setFrom(Math.max(0, from - PAGE))}>
              <ChevronLeft {...ICON_SM} aria-hidden />
              {t('history.newer')}
            </button>
            <span className="small muted" role="status">
              {t('history.range', { first: formatNumber(from + 1), last: formatNumber(last), total: formatNumber(total) })}
            </span>
            <button type="button" className="btn btn-small" disabled={last >= total} onClick={() => setFrom(from + PAGE)}>
              {t('history.older')}
              <ChevronRight {...ICON_SM} aria-hidden />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Form({ status }: { status: TerminalStatus }) {
  const { t } = useTranslation(['terminal', 'config']);
  const { settings, sources } = status;
  const [draft, setDraft] = useState<Numbers>({ maxTerminals: settings.maxTerminals, idleMinutes: settings.idleMinutes, scrollbackLines: settings.scrollbackLines });
  const [number, setNumber] = useState<Partial<Numbers>>({});
  const [screenReader, setScreenReader] = useScreenReaderMode();
  // A refusal belongs to the reason the status gave when it was made: once the status says another, it is stale
  const [refused, setRefused] = useState<{ refusal: TerminalRefusal; reason: TerminalStatus['reason'] } | null>(null);
  const refusal = refused && refused.reason === status.reason ? refused.refusal : null;
  const toggle = useSaveTerminal(t('settings.saved'), (next) => setRefused(next && { refusal: next, reason: status.reason }));
  const numbers = useSaveTerminal(t('settings.saved'));
  // The warning depends on the auth mode; until it is read, say nothing rather than guess
  const auth = useQuery({ queryKey: keys.securityAuth, queryFn: ({ signal }) => api.securityAuth({ signal }) });
  const merged = { ...draft, ...number };
  const change = changedNumbers(status, merged);
  const dirty = Object.keys(change).length > 0;
  const fromEnv = (key: keyof TerminalSettings) => sources[key] === 'env';
  const options: SelectOption<TerminalRemote>[] = REMOTE.map((value) => ({ value, label: t(`settings.remote.${value}`) }));

  // What the value does, live; the range only while it is not one the server takes
  const consequence = (key: keyof Numbers) => {
    const [min, max] = BOUNDS[key];
    const value = merged[key];
    return value !== undefined && Number.isInteger(value) && value >= min && value <= max
      ? t(`settings.consequence.${key}`, { count: value, formatted: formatNumber(value) })
      : t('settings.range', { min: formatNumber(min), max: formatNumber(max) });
  };

  const field = (key: keyof Numbers) => {
    const [min, max] = BOUNDS[key];
    return (
      <Field label={t(`settings.${key}`)} hint={fromEnv(key) ? t('settings.fromEnv') : consequence(key)}>
        <NumberInput
          aria-label={t(`settings.${key}`)}
          value={merged[key]}
          onChange={(value) => setNumber((now) => ({ ...now, [key]: value }))}
          min={min}
          max={max}
          disabled={fromEnv(key)}
        />
      </Field>
    );
  };

  return (
    <>
      <p className="small muted">{t('settings.intro')}</p>
      <Switch checked={settings.enabled} disabled={fromEnv('enabled') || toggle.isPending} onChange={(enabled) => toggle.mutate({ enabled })} aria-label={t('settings.enabled')}>
        <span>{t('settings.enabled')}</span>
      </Switch>
      {fromEnv('enabled') && <p className="small muted">{t('settings.fromEnv')}</p>}
      {settings.enabled && auth.data?.mode === 'none' && (
        <p className="term-note">
          <TriangleAlert {...ICON_SM} aria-hidden />
          {t('settings.agentReach')}
        </p>
      )}
      {/* A refused change wins over the status's standing reason: it is what the person just did */}
      {(refusal ?? (status.reason && status.reason !== 'off' ? terminalRefusal(status.reason) : null)) && (
        <RefusalAlert refusal={(refusal ?? (status.reason ? terminalRefusal(status.reason) : null)) as TerminalRefusal} />
      )}

      {/* Chosen before the switch is on: in a container it is the first thing a person may need to set */}
      <Field label={t('settings.remoteLabel')} hint={fromEnv('remote') ? t('settings.fromEnv') : t('settings.remoteHint')}>
        <Select<TerminalRemote>
          id={REMOTE_FIELD}
          aria-label={t('settings.remoteLabel')}
          value={settings.remote}
          options={options}
          disabled={fromEnv('remote') || toggle.isPending}
          onChange={(remote) => toggle.mutate({ remote })}
        />
      </Field>
      {settings.remote === 'any' && (
        <p className="term-note">
          <TriangleAlert {...ICON_SM} aria-hidden />
          {t('limits.any')}
        </p>
      )}

      {/* Off, nothing below applies: it waits, revealed, for the switch */}
      <SettingsReveal open={settings.enabled}>
        <div className="form-grid">
          {field('maxTerminals')}
          {field('idleMinutes')}
          {field('scrollbackLines')}
        </div>
        <div className="form-actions">
          <SaveButton
              type="button"
              label={t('settings.save')}
              savingLabel={t('config:shared.saving')}
              dirty={dirty}
              pending={numbers.isPending}
              onClick={() => numbers.mutate(change, { onSuccess: () => setNumber({}) })}
            />
        </div>

        <Field label={t('settings.shell')} hint={t('settings.shellHint')}>
          {/* Mono only for the path the machine reads; the fallback is words */}
          {settings.shell ? <span className="mono">{settings.shell}</span> : <span>{t('settings.loginShell')}</span>}
        </Field>
        <p className="small muted">{status.peerCheck === 'on' ? t('settings.peerOn') : t('settings.peerUnknown')}</p>
        <Switch checked={screenReader} onChange={setScreenReader} aria-label={t('settings.screenReader')}>
          <span>{t('settings.screenReader')}</span>
        </Switch>
        <p className="small muted">{t('settings.screenReaderHint')}</p>
      </SettingsReveal>
    </>
  );
}

/**
 * The person's own terminal: whether it exists, who may open it beyond this machine, its limits and
 * what it has done. The one place that says why it may be unavailable, since everywhere else a
 * terminal that cannot be opened has no button.
 */
export function TerminalCard() {
  const { data, error, isLoading } = useTerminalStatus();
  // Read-only mode closes the status route itself (405): said as the refusal it is, not as the server's English
  const closed = error instanceof ApiRequestError && error.status === 405 ? terminalRefusal('read-only') : null;
  return (
    <Card>
      {closed ? <RefusalAlert refusal={closed} /> : <ErrorBox error={error} />}
      {isLoading && <Skeleton rows={4} />}
      {data && (
        <>
          <Form key={`${data.settings.maxTerminals}:${data.settings.idleMinutes}:${data.settings.scrollbackLines}`} status={data} />
          <History />
        </>
      )}
    </Card>
  );
}
