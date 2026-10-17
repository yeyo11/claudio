import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
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
  const { data: info, error, isLoading } = useQuery({ queryKey: keys.cliVersion, queryFn: api.cliVersion });
  const check = useMutation({
    mutationFn: api.checkCliVersion,
    onSuccess: (fresh) => queryClient.setQueryData(keys.cliVersion, fresh),
  });
  const shown = check.data ?? info;
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
      {shown?.updateAvailable && <p className="small">{t('cli.updateHow', { latest: shown.latest })}</p>}
    </div>
  );
}
