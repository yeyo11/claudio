import type { AppSettings, AppSettingValues, PermissionMode, UpdateAppSettingsRequest } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, useSpend } from '../../api';
import { NumberInput, Select, Switch } from '@claudio/ui/components/controls';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, ErrorBox, Field, Skeleton, Tag } from '@claudio/ui/components/ui';
import { formatCost } from '@claudio/ui/lib/format';
import { PERMISSION_MODES } from '../../components/ui';

/** The variable that sets each one, named where the UI says it cannot change it. */
export const APP_SETTING_ENV: Record<keyof AppSettingValues, string> = {
  allowedHosts: 'CLAUDIO_ALLOWED_HOSTS',
  maxConcurrentRuns: 'CLAUDIO_MAX_CONCURRENT_RUNS',
  defaultPermissionMode: 'CLAUDIO_DEFAULT_PERMISSION_MODE',
  setupSeen: 'CLAUDIO_SETUP_SEEN',
  dailySpendCapUsd: 'CLAUDIO_DAILY_SPEND_CAP_USD',
};

// The server's own bounds; a value outside them is refused with a 400
const MIN_RUNS = 1;
const MAX_RUNS = 64;
/** The daily cap's bounds, in USD, rounded to cents: the server's own (`MAX_DAILY_SPEND_CAP_USD`) */
const MIN_CAP = 0.01;
const MAX_CAP = 100_000;

/** The amount as the server keeps it, or null when it is not one it accepts. */
export function validCap(amount: number | undefined): number | null {
  if (amount === undefined || !Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100) / 100;
  return cents >= MIN_CAP && cents <= MAX_CAP ? cents : null;
}

/** One name per line, as the person wrote them, without the blanks. */
export const parseHosts = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

/**
 * What a `PUT` carries: only the keys the draft names whose value moved, and never one the
 * environment set. The server refuses a key the environment owns even when its value is unchanged,
 * because writing it to the file would do nothing until the variable goes away, and then change
 * behaviour by surprise. `allowedHosts` is the exception: the draft holds only the hosts added here,
 * which add to the environment's, so it is compared with that layer and always sendable.
 */
export function changedSettings(saved: AppSettings, draft: Partial<AppSettingValues>): UpdateAppSettingsRequest {
  const out: UpdateAppSettingsRequest = {};
  if (draft.allowedHosts !== undefined && draft.allowedHosts.join('\n') !== saved.allowedHostLayers.file.join('\n')) out.allowedHosts = draft.allowedHosts;
  if (draft.maxConcurrentRuns !== undefined && saved.sources.maxConcurrentRuns !== 'env' && draft.maxConcurrentRuns !== saved.maxConcurrentRuns) {
    out.maxConcurrentRuns = draft.maxConcurrentRuns;
  }
  if (draft.defaultPermissionMode !== undefined && saved.sources.defaultPermissionMode !== 'env' && draft.defaultPermissionMode !== saved.defaultPermissionMode) {
    out.defaultPermissionMode = draft.defaultPermissionMode;
  }
  if (draft.dailySpendCapUsd !== undefined && saved.sources.dailySpendCapUsd !== 'env' && draft.dailySpendCapUsd !== saved.dailySpendCapUsd) {
    out.dailySpendCapUsd = draft.dailySpendCapUsd;
  }
  return out;
}

/** "Set by the environment", with the variable to change instead. */
export function EnvNote({ setting }: { setting: keyof AppSettingValues }) {
  const { t } = useTranslation('config');
  return <p className="small muted">{t('appSettings.envHint', { variable: APP_SETTING_ENV[setting] })}</p>;
}

function useSaveAppSettings(onSaved: (next: AppSettings) => void, savedText: string) {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: api.updateAppSettings,
    onSuccess: (next) => {
      queryClient.setQueryData(keys.appSettings, next);
      onSaved(next);
      toast.success(savedText);
    },
    onError: (err) => toast.error(t('appSettings.saveFailed'), err),
  });
}

/**
 * The layered settings the Security tab holds: the hosts this wrapper answers to, and what a new
 * run gets by default. Each one the environment set is shown, read-only, with the variable to change.
 */
export function AppSettingsCards() {
  const { data, error, isLoading } = useQuery({ queryKey: keys.appSettings, queryFn: api.appSettings });
  return (
    <>
      <ErrorBox error={error} />
      {isLoading && (
        <Card>
          <Skeleton rows={4} />
        </Card>
      )}
      {data && (
        <>
          {/* Remounted from the server's copy, so a draft never outlives a change made elsewhere; the
              tunnel's host coming or going is not such a change, and the draft stays */}
          <HostsCard key={`hosts:${data.allowedHostLayers.file.join(',')}`} saved={data} />
          <RunsCard key={`runs:${data.maxConcurrentRuns}:${data.defaultPermissionMode}:${data.sources.maxConcurrentRuns}:${data.sources.defaultPermissionMode}`} saved={data} />
          <SpendCard key={`spend:${String(data.dailySpendCapUsd)}:${data.sources.dailySpendCapUsd}`} saved={data} />
        </>
      )}
    </>
  );
}

function SourceTag({ settings, keys: owned }: { settings: AppSettings; keys: ReadonlyArray<keyof AppSettingValues> }) {
  const { t } = useTranslation('config');
  return owned.some((key) => settings.sources[key] === 'env') ? <Tag>{t('appSettings.fromEnv')}</Tag> : null;
}

/**
 * The environment's hosts and the tunnel's are listed, each tagged with who put it there, because
 * nobody may edit them here; the field holds only the hosts added here, which answer beside them.
 */
function HostsCard({ saved }: { saved: AppSettings }) {
  const { t } = useTranslation(['config', 'common']);
  const layers = saved.allowedHostLayers;
  const [text, setText] = useState(layers.file.join('\n'));
  const change = changedSettings(saved, { allowedHosts: parseHosts(text) });
  const dirty = Object.keys(change).length > 0;
  const save = useSaveAppSettings((next) => setText(next.allowedHostLayers.file.join('\n')), t('appSettings.hosts.saved'));
  const fixed = [...layers.env.map((host) => ({ host, tag: t('appSettings.fromEnv') })), ...layers.runtime.map((host) => ({ host, tag: t('appSettings.hosts.fromTunnel') }))];

  return (
    <Card title={t('appSettings.hosts.title')}>
      <p className="small muted">{t('appSettings.hosts.intro')}</p>
      {fixed.length > 0 && (
        <>
          <ul className="app-settings-hosts" data-testid="fixed-hosts">
            {fixed.map(({ host, tag }) => (
              <li key={host} className="app-settings-host">
                <span className="mono">{host}</span>
                <Tag>{tag}</Tag>
              </li>
            ))}
          </ul>
          {layers.env.length > 0 && <EnvNote setting="allowedHosts" />}
        </>
      )}
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty) save.mutate(change);
        }}
      >
        <Field label={t('appSettings.hosts.label')} hint={layers.env.length > 0 ? t('appSettings.hosts.hintBesideEnv') : t('appSettings.hosts.hint')}>
          <textarea
            className="mono"
            rows={4}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            placeholder={t('appSettings.hosts.placeholder')}
            value={text}
            onChange={(event) => setText(event.target.value)}
            data-testid="allowed-hosts"
          />
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending}>
            {save.isPending ? t('shared.saving') : t('shared.save')}
          </button>
          {dirty && (
            <button type="button" className="btn" onClick={() => setText(layers.file.join('\n'))}>
              {t('shared.discard')}
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

function RunsCard({ saved }: { saved: AppSettings }) {
  const { t } = useTranslation(['config', 'common']);
  const [mode, setMode] = useState<PermissionMode>(saved.defaultPermissionMode);
  const [runs, setRuns] = useState<number | undefined>(saved.maxConcurrentRuns);
  const modeFromEnv = saved.sources.defaultPermissionMode === 'env';
  const runsFromEnv = saved.sources.maxConcurrentRuns === 'env';
  const runsValid = runs !== undefined && Number.isInteger(runs) && runs >= MIN_RUNS && runs <= MAX_RUNS;
  const change = changedSettings(saved, { defaultPermissionMode: mode, maxConcurrentRuns: runsValid ? runs : saved.maxConcurrentRuns });
  const save = useSaveAppSettings(
    (next) => {
      setMode(next.defaultPermissionMode);
      setRuns(next.maxConcurrentRuns);
    },
    t('appSettings.runs.saved'),
  );

  return (
    <Card title={t('appSettings.runs.title')} actions={<SourceTag settings={saved} keys={['defaultPermissionMode', 'maxConcurrentRuns']} />}>
      <p className="small muted">{t('appSettings.runs.intro')}</p>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (runsValid && Object.keys(change).length > 0) save.mutate(change);
        }}
      >
        <div className="form-grid">
          <Field label={t('appSettings.runs.mode')} hint={modeFromEnv ? t('appSettings.envHint', { variable: APP_SETTING_ENV.defaultPermissionMode }) : t('appSettings.runs.modeHint')}>
            <Select
              aria-label={t('appSettings.runs.mode')}
              value={mode}
              onChange={setMode}
              disabled={modeFromEnv}
              options={PERMISSION_MODES.map((value) => ({ value, label: value }))}
            />
          </Field>
          <Field
            label={t('appSettings.runs.concurrent')}
            hint={runsFromEnv ? t('appSettings.envHint', { variable: APP_SETTING_ENV.maxConcurrentRuns }) : t('appSettings.runs.concurrentHint', { min: MIN_RUNS, max: MAX_RUNS })}
          >
            <NumberInput aria-label={t('appSettings.runs.concurrent')} value={runs} onChange={setRuns} min={MIN_RUNS} max={MAX_RUNS} disabled={runsFromEnv} />
          </Field>
        </div>
        {!(modeFromEnv && runsFromEnv) && (
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={!runsValid || Object.keys(change).length === 0 || save.isPending}>
              {save.isPending ? t('shared.saving') : t('shared.save')}
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}

/** What the cap's card shows for a state: the switch, the amount while it is on, and the hints. */
export function SpendFields({
  on,
  amount,
  fromEnv,
  invalid,
  spentUsd,
  onToggle,
  onAmount,
}: {
  on: boolean;
  amount: number | undefined;
  fromEnv: boolean;
  invalid: boolean;
  /** Today's spend as the CLI reported it; null while the reading is missing */
  spentUsd: number | null;
  onToggle: (on: boolean) => void;
  onAmount: (amount: number | undefined) => void;
}) {
  const { t } = useTranslation('config');
  return (
    <>
      <Switch checked={on} onChange={onToggle} disabled={fromEnv}>
        {t('appSettings.spend.switch')}
      </Switch>
      {on && (
        <Field
          label={t('appSettings.spend.amount')}
          hint={
            invalid ? (
              <span className="field-error" role="alert">
                {t('appSettings.spend.invalid', { max: formatCost(MAX_CAP) })}
              </span>
            ) : undefined
          }
        >
          <NumberInput aria-label={t('appSettings.spend.amount')} value={amount} onChange={onAmount} min={MIN_CAP} max={MAX_CAP} step={1} decimal disabled={fromEnv} />
        </Field>
      )}
      <p className="small muted">{spentUsd !== null ? t('appSettings.spend.hintToday', { spent: formatCost(spentUsd) }) : t('appSettings.spend.hintOff')}</p>
      <p className="small muted">{t('appSettings.spend.hintApi')}</p>
    </>
  );
}

/**
 * The daily spend cap: one number for what all of Claudio's automation may spend in a day. Off, on,
 * set by the environment (read-only, with its variable), or an amount that cannot be one. What it
 * counts is the cost the CLI reports, and the card says what that means on a subscription.
 */
export function SpendCard({ saved }: { saved: AppSettings }) {
  const { t } = useTranslation(['config', 'common']);
  const spend = useSpend().data;
  const [on, setOn] = useState(saved.dailySpendCapUsd !== null);
  const [amount, setAmount] = useState<number | undefined>(saved.dailySpendCapUsd ?? undefined);
  const fromEnv = saved.sources.dailySpendCapUsd === 'env';
  const cap = on ? validCap(amount) : null;
  const invalid = on && amount !== undefined && cap === null;
  const change = on && cap === null ? {} : changedSettings(saved, { dailySpendCapUsd: cap });
  const dirty = Object.keys(change).length > 0;
  const save = useSaveAppSettings(
    (next) => {
      setOn(next.dailySpendCapUsd !== null);
      setAmount(next.dailySpendCapUsd ?? undefined);
    },
    cap === null ? t('appSettings.spend.savedOff') : t('appSettings.spend.saved'),
  );

  return (
    <Card title={t('appSettings.spend.title')} actions={<SourceTag settings={saved} keys={['dailySpendCapUsd']} />}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty) save.mutate(change);
        }}
      >
        <SpendFields on={on} amount={amount} fromEnv={fromEnv} invalid={invalid} spentUsd={spend?.spentUsd ?? null} onToggle={setOn} onAmount={setAmount} />
        {fromEnv ? (
          <EnvNote setting="dailySpendCapUsd" />
        ) : (
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending}>
              {save.isPending ? t('shared.saving') : t('shared.save')}
            </button>
            {dirty && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setOn(saved.dailySpendCapUsd !== null);
                  setAmount(saved.dailySpendCapUsd ?? undefined);
                }}
              >
                {t('shared.discard')}
              </button>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}
