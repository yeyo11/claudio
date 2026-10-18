import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import type { CliVersionInfo } from '@claudio/shared';
import { api, keys } from '../../api';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import { timeAgo } from '@claudio/ui/lib/format';
import { CLAUDE_CODE_ID } from '../../lib/provider-state';
import { useProviders } from '../../lib/providers';
import { PrefRow, ReservedLabel } from './PrefRow';

/**
 * Which Claude Code this wrapper runs, where it lives and whether a newer one is out: one row under
 * Claudio's own updates. Reading is free; the registry is only asked by the button (and once a day
 * by the server), so opening the screen costs nothing.
 */
export function CliCard() {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const { data: info, error, isLoading } = useQuery({
    queryKey: keys.cliVersion,
    queryFn: api.cliVersion,
    // An install runs on the server for a while: ask again until it settles
    refetchInterval: (query) => (query.state.data?.install?.state === 'installing' ? 2000 : false),
  });
  const check = useMutation({
    mutationFn: api.checkCliVersion,
    onSuccess: (fresh) => queryClient.setQueryData(keys.cliVersion, fresh),
  });
  const take = (next: CliVersionInfo) => {
    check.reset();
    queryClient.setQueryData(keys.cliVersion, next);
  };
  const install = useMutation({ mutationFn: () => api.installCli(), onSuccess: take });
  const useImage = useMutation({ mutationFn: api.useImageCli, onSuccess: take });
  const shown = check.data ?? info;
  const installing = shown?.install?.state === 'installing';
  const failed = shown?.install?.state === 'failed' ? shown.install : null;
  // The path is the detector's: the version check reads the registry, not the disk
  const path = useProviders().data?.find((status) => status.id === CLAUDE_CODE_ID)?.binaryPath ?? null;

  const facts = shown && (
    <span className="update-facts">
      <span>
        {t('cli.version')} <span className="tnum">{shown.current ?? t('cli.notInstalled')}</span>
      </span>
      {shown.pinned && (
        <span>
          {t('cli.pinned')} <span className="tnum">{shown.pinned}</span>
        </span>
      )}
      <span>
        {t('cli.latest')} <span className="tnum">{shown.latest ?? t('cli.never')}</span>
      </span>
      {shown.latest && (shown.updateAvailable ? <Tag tone="warn">{t('updates.availableTag')}</Tag> : <Tag tone="ok">{t('updates.upToDateTag')}</Tag>)}
      {path && <span className="mono update-path">{path}</span>}
    </span>
  );

  return (
    <div className="stack" data-testid="cli-card">
      <PrefRow id="updates-cli" setting="updates.cli" title={t('cli.title')} hint={isLoading ? <Skeleton rows={1} /> : facts}>
        <div className="pref-actions">
          <button className="btn" disabled={check.isPending} onClick={() => check.mutate()}>
            <ReservedLabel states={[t('cli.check'), t('cli.checking')]} shown={check.isPending ? 1 : 0} />
          </button>
          {/* Always rendered so a screen reader is told when the answer lands */}
          <span className="small muted" role="status">
            {shown?.checkedAt && t('cli.checked', { when: timeAgo(shown.checkedAt) })}
          </span>
        </div>
      </PrefRow>
      <ErrorBox error={error} />
      <ErrorBox title={t('cli.checkFailed')} error={check.error ?? (shown?.error ? new Error(shown.error) : null)} />
      {shown?.updateAvailable && !shown.installable && <p className="small">{t('cli.updateHow', { latest: shown.latest })}</p>}
      {shown?.updateAvailable && shown.installable && !installing && (
        <div>
          {/* Neutral: the card's one primary is Claudio's own update */}
          <button type="button" className="btn" disabled={install.isPending} onClick={() => install.mutate()}>
            {t('cli.install', { version: shown.latest })}
          </button>
        </div>
      )}
      {installing && (
        <p className="small" role="status">
          <Spinner /> {t('cli.installing', { version: shown?.install?.version ?? shown?.latest })}
        </p>
      )}
      {failed?.error && (
        <div className="alert alert-bad" role="alert" data-testid="cli-install-failed">
          <AlertTriangle {...ICON_SM} className="alert-icon" aria-hidden />
          <div className="alert-body">
            <Trans t={t} i18nKey={`cli.installError.${failed.error}`} values={{ version: failed.version }} components={{ mono: <span className="mono" /> }} />
          </div>
        </div>
      )}
      <ErrorBox error={install.error ?? useImage.error} />
      {shown?.source === 'data' && (
        <div className="stack">
          <p className="small muted">{t('cli.newChats', { version: shown.current })}</p>
          <div>
            <button type="button" className="btn btn-small" disabled={useImage.isPending} onClick={() => useImage.mutate()}>
              {t('cli.useImage', { pinned: shown.pinned })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
