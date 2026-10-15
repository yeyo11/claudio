import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TerminalRemote, TerminalSettings, TerminalStatus, UpdateTerminalSettingsRequest } from '@claudio/shared';
import { NumberInput, Select, Switch, type SelectOption } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, Empty, ErrorBox, Field, Skeleton, Tag } from '@claudio/ui/components/ui';
import { formatDateTime, formatNumber } from '@claudio/ui/lib/format';
import { api, keys } from '../../../api';
import { useScreenReaderMode } from '../../../components/terminal/terminal-prefs';
import { unavailableKey } from '../../../components/terminal/terminal-model';
import { useTerminalStatus } from '../../../components/terminal/use-terminals';

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

function useSaveTerminal(saved: string) {
  const { t } = useTranslation('terminal');
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: UpdateTerminalSettingsRequest) => api.updateTerminalSettings(body),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.terminalStatus, next);
      toast.success(saved);
    },
    onError: (error) => toast.error(t('settings.saveFailed'), error),
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
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={3} />
      ) : entries.length === 0 ? (
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
                      <td className="small">
                        {entry.endReason ? t(`history.ended.${entry.endReason}`) : entry.id ? t('history.running') : ''}
                        {refused.length > 0 && (
                          <Tag tone="warn">
                            {t('history.refused', { count: refused.length, reasons: [...new Set(refused.map((attachment) => attachment.refused))].join(', ') })}
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
  const { t } = useTranslation('terminal');
  const { settings, sources } = status;
  const [draft, setDraft] = useState<Numbers>({ maxTerminals: settings.maxTerminals, idleMinutes: settings.idleMinutes, scrollbackLines: settings.scrollbackLines });
  const [number, setNumber] = useState<Partial<Numbers>>({});
  const [screenReader, setScreenReader] = useScreenReaderMode();
  const toggle = useSaveTerminal(t('settings.saved'));
  const numbers = useSaveTerminal(t('settings.saved'));
  const merged = { ...draft, ...number };
  const change = changedNumbers(status, merged);
  const dirty = Object.keys(change).length > 0;
  const fromEnv = (key: keyof TerminalSettings) => sources[key] === 'env';
  const options: SelectOption<TerminalRemote>[] = REMOTE.map((value) => ({ value, label: t(`settings.remote.${value}`) }));

  const field = (key: keyof Numbers) => {
    const [min, max] = BOUNDS[key];
    return (
      <Field label={t(`settings.${key}`)} hint={fromEnv(key) ? t('settings.fromEnv') : t('settings.range', { min: formatNumber(min), max: formatNumber(max) })}>
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
      {!status.available && status.reason && (
        <p className="term-note">
          <TriangleAlert {...ICON_SM} aria-hidden />
          {t(unavailableKey(status.reason))}
        </p>
      )}

      <Field label={t('settings.remoteLabel')} hint={fromEnv('remote') ? t('settings.fromEnv') : t('settings.remoteHint')}>
        <Select<TerminalRemote>
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

      <div className="form-grid">
        {field('maxTerminals')}
        {field('idleMinutes')}
        {field('scrollbackLines')}
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={!dirty || numbers.isPending} onClick={() => numbers.mutate(change, { onSuccess: () => setNumber({}) })}>
          {t('settings.save')}
        </button>
      </div>

      <Field label={t('settings.shell')} hint={t('settings.shellHint')}>
        <span className="mono">{settings.shell ?? t('settings.loginShell')}</span>
      </Field>
      <p className="small muted">{status.peerCheck === 'on' ? t('settings.peerOn') : t('settings.peerUnknown')}</p>
      <Switch checked={screenReader} onChange={setScreenReader} aria-label={t('settings.screenReader')}>
        <span>{t('settings.screenReader')}</span>
      </Switch>
      <p className="small muted">{t('settings.screenReaderHint')}</p>
    </>
  );
}

/**
 * The person's own terminal: whether it exists, who may open it beyond this machine, its limits and
 * what it has done. The one place that says why it may be unavailable, since everywhere else a
 * terminal that cannot be opened has no button.
 */
export function TerminalCard() {
  const { t } = useTranslation('terminal');
  const { data, error, isLoading } = useTerminalStatus();
  return (
    <Card title={t('settings.title')}>
      <ErrorBox error={error} />
      {isLoading && <Skeleton rows={4} />}
      {data && (
        <>
          <Form key={JSON.stringify(data.settings)} status={data} />
          <History />
        </>
      )}
    </Card>
  );
}
