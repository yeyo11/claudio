import type { ProviderStatus, ProvidersSettings } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Sheet } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ProviderRow, useProviderReason } from '../../components/ProviderRow';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import { timeAgo } from '@claudio/ui/lib/format';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { actionsFor, CLAUDE_CODE_ID, providerLink, STATE_TONE, stateLabelKey } from '../../lib/provider-state';
import { entryOf, latestCheck, orderedIds, withEntry } from '../../lib/provider-settings';
import { useProviders, useRefreshProviders } from '../../lib/providers';
import { LimitBars } from './providers/LimitBars';
import { Overridden, ServerSettingChange } from './SettingChange';

/**
 * Claude Code: its state, the account it signs in with, the binary Claudio runs and the usage
 * limit. A change of binary is one PUT of the whole document; the status comes from the detector
 * and is read again when `providers.changed` arrives.
 */
export function ProvidersTab() {
  const { t } = useTranslation('providers');
  const toast = useToast();
  const queryClient = useQueryClient();
  const narrow = useMediaQuery(NARROW);
  const statuses = useProviders();
  const settings = useQuery({
    queryKey: keys.providerSettings,
    queryFn: () => api.providerSettings(),
  });
  const refresh = useRefreshProviders();
  const [checking, setChecking] = useState(false);
  const [binaryOpen, setBinaryOpen] = useState(false);

  const save = useMutation({
    mutationFn: (next: ProvidersSettings) => api.putProviderSettings(next),
    onSuccess: (saved) => queryClient.setQueryData(keys.providerSettings, saved),
    onError: (err) => {
      toast.error(t('saveFailed'), err);
      void queryClient.invalidateQueries({ queryKey: keys.providerSettings });
    },
  });

  if (statuses.error || settings.error) {
    return <ErrorBox error={statuses.error ?? settings.error} />;
  }
  if (!statuses.data || !settings.data) return <Skeleton rows={3} />;

  const list = statuses.data;
  const current = settings.data;
  const status = list.find((s) => s.id === CLAUDE_CODE_ID);
  if (!status) return <Skeleton rows={3} />;
  const order = orderedIds(list, current);
  const checkedAt = latestCheck(list);

  const recheck = async (): Promise<ProviderStatus[] | null> => {
    // The row keeps its Retry while a read runs: a second press waits for the first
    if (checking) return null;
    setChecking(true);
    try {
      return await refresh.mutateAsync();
    } catch (err) {
      toast.error(t('refreshFailed'), err);
      return null;
    } finally {
      setChecking(false);
    }
  };

  /**
   * Point Claude Code at a binary (or back at the PATH) and read it. A binary the detector rejects
   * is not kept: the previous choice is put back, so "Check and save" never leaves a broken
   * program in the settings.
   */
  const useBinary = async (binaryPath: string | null): Promise<ProviderStatus | null> => {
    const previous = entryOf(current, status.id).binaryPath;
    setChecking(true);
    try {
      await save.mutateAsync(withEntry(current, order, status.id, { binaryPath }));
      const fresh = await refresh.mutateAsync();
      const found = fresh.find((s) => s.id === status.id) ?? null;
      if (binaryPath !== null && found && !WORKS.has(found.state)) {
        await save.mutateAsync(withEntry(current, order, status.id, { binaryPath: previous }));
        void refresh.mutateAsync().catch(() => undefined);
      }
      return found;
    } catch (err) {
      toast.error(t('refreshFailed'), err);
      return null;
    } finally {
      setChecking(false);
    }
  };

  // The row's own "Check again", unless its state already offers Retry, which is the same read
  const offersRetry = actionsFor(status.state, status.reason).some((action) => action.kind === 'retry');
  const checkAgain = !offersRetry && (
    <button type="button" className="btn prov-quiet" data-setting="provider.check" aria-busy={checking} onClick={() => !checking && void recheck()}>
      {checking ? <Spinner /> : <RefreshCw {...ICON_SM} />}
      {t('refresh')}
    </button>
  );
  const limit = (
    <>
      <div className="prov-limit-wrap" data-setting="provider.limits">
        <LimitBars status={status} />
        <span className="small muted">
          <Overridden id="provider.limits" bare />
        </span>
      </div>
      <span className="prov-checked tnum">{checkedAt ? t('checkedAgo', { time: timeAgo(checkedAt) }) : t('notChecked')}</span>
    </>
  );
  const editor = (sheet: boolean) => (
    <BinaryEditor
      key={status.id}
      status={status}
      saved={entryOf(current, status.id).binaryPath}
      busy={checking}
      onUse={useBinary}
      onDone={() => setBinaryOpen(false)}
      sheet={sheet}
    />
  );
  const row = (
    <ProviderRow
      status={status}
      variant={narrow ? 'cell' : 'row'}
      compact
      limit={limit}
      // Not `checking`: the row keeps its state while the button spins, so nothing below it moves
      onRetry={() => void recheck()}
      onChooseBinary={() => setBinaryOpen((now) => !now)}
      more={checkAgain}
      open={!narrow && binaryOpen}
    />
  );

  // Signing in is the Sign-in section's: the row's Sign in links there (ProviderRow), so the panel lives in one place
  return (
    <div className="prov-page prov-bare">
      <div className="prov-item" data-setting="provider.binary" aria-busy={checking}>
        {row}
        {!narrow && binaryOpen && editor(false)}
        <ServerSettingChange
          id="provider.binary"
          label={t('bin.title', { name: status.label })}
          wording={() => t('bin.usePath')}
          invalidate={[keys.providerSettings]}
          onReset={() => void refresh.mutateAsync().catch(() => undefined)}
        />
      </div>
      {narrow && binaryOpen && (
        <Sheet open onOpenChange={setBinaryOpen} title={status.label} className="prov-sheet">
          {editor(true)}
        </Sheet>
      )}
    </div>
  );
}

/** States in which the program runs; anything else after "Check and save" means the path is refused. */
const WORKS: ReadonlySet<ProviderStatus['state']> = new Set(['ready', 'degraded', 'signed-out']);

/**
 * The binary override: the path Claudio runs instead of searching the PATH. On desktop it opens
 * under the row; on a phone it fills a sheet.
 */
function BinaryEditor({
  status,
  saved,
  busy,
  onUse,
  onDone,
  sheet = false,
}: {
  status: ProviderStatus;
  saved: string | null;
  busy: boolean;
  onUse: (path: string | null) => Promise<ProviderStatus | null>;
  onDone: () => void;
  sheet?: boolean;
}) {
  const { t } = useTranslation('providers');
  const toast = useToast();
  const [path, setPath] = useState(saved ?? status.binaryPath ?? '');
  const [refused, setRefused] = useState<ProviderStatus | null>(null);
  const trimmed = path.trim();
  const own = useProviderReason(status);
  const reason = useProviderReason(refused ?? status);
  const install = providerLink(status.id, 'install');

  const check = async () => {
    setRefused(null);
    const found = await onUse(trimmed);
    if (!found) return;
    if (WORKS.has(found.state)) {
      toast.success(t('bin.saved', { name: status.label }));
      onDone();
    } else {
      setRefused(found);
    }
  };
  const usePath = async () => {
    setRefused(null);
    const found = await onUse(null);
    if (!found) return;
    toast.success(t('bin.cleared', { name: status.label }));
    onDone();
  };

  const field = (
    <label className="field field-mono">
      {sheet && <span className="field-label">{t('bin.title', { name: status.label })}</span>}
      <input
        className="mono"
        value={path}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder={t('bin.placeholder', { id: status.id })}
        aria-label={t('bin.path', { name: status.label })}
        onChange={(event) => setPath(event.target.value)}
      />
    </label>
  );
  const hint = (
    <span className="form-hint">{status.compatibleRange ? t('bin.hint', { range: status.compatibleRange }) : t('bin.hintNoRange')}</span>
  );
  const problem = refused && (
    <p className="field-error" role="alert">
      {t('bin.rejected', { reason })}
    </p>
  );
  const submit = (
    <button type="button" className={sheet ? 'btn btn-primary' : 'btn'} disabled={busy || trimmed === ''} onClick={() => void check()}>
      {busy && <Spinner />}
      {busy ? t('bin.checking') : t('bin.check')}
    </button>
  );

  if (sheet) {
    return (
      <div className="prov-sheet-body">
        <div className="prov-cell-head">
          <div className="prov-id">
            <span className="prov-meta">{status.configHome ?? status.binaryPath ?? ''}</span>
          </div>
          <Tag tone={STATE_TONE[status.state]}>{t(stateLabelKey(status.state))}</Tag>
        </div>
        <p className="prov-reason">{own}</p>
        {field}
        {hint}
        {problem}
        <div className="prov-sheet-actions">
          {submit}
          <div className="prov-sheet-row">
            <button type="button" className="btn prov-quiet" disabled={busy} onClick={() => void usePath()}>
              {t('bin.usePath')}
            </button>
            {install && (
              <a className="btn prov-quiet" href={install} target="_blank" rel="noopener noreferrer">
                {t('row.install')}
                <span className="sr-only"> ({t('row.opensNewTab')})</span>
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="prov-bin" role="group" aria-label={t('bin.title', { name: status.label })}>
      <span className="section-label">{t('bin.title', { name: status.label })}</span>
      {field}
      {hint}
      {problem}
      <div className="prov-bin-actions">
        {submit}
        <button type="button" className="btn prov-quiet" onClick={onDone}>
          {t('bin.cancel')}
        </button>
        <span className="grow" />
        <button type="button" className="btn btn-small prov-quiet" disabled={busy} onClick={() => void usePath()}>
          {t('bin.usePath')}
        </button>
      </div>
    </div>
  );
}
