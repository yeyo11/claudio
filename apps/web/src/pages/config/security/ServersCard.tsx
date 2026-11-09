import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Switch } from '@claudio/ui/components/controls';
import { useToast } from '@claudio/ui/components/Toast';
import { useServersSettings, useUpdateServersSettings } from '../../../lib/api/servers';
import { PrefRow, PrefRows } from '../PrefRow';

/**
 * Settings → Access & safety → Servers (docs/plans/claudio-servers.md §12.1): the switch of the
 * feature and the way to its page. Off is the default and keeps the list: the page, the selector
 * and the gateway are closed and no credential is used until it is on again (D8), which is said
 * under the switch rather than behind a confirmation, since nothing is lost. The sentence and the
 * link are the same in both states, so turning it on moves nothing below the row.
 *
 * A Claudio that is never a hub (the headless one) does not serve the routes, so it has no card.
 */
export function ServersCard() {
  const { t } = useTranslation('config');
  const toast = useToast();
  const settings = useServersSettings();
  const update = useUpdateServersSettings();
  if (settings.isError) return null;
  // While the hub has not answered the row is already there with its switch held, so nothing moves when it does
  const loaded = settings.data !== undefined;
  const enabled = settings.data?.enabled === true;
  const change = (next: boolean) =>
    update.mutate(next, {
      onSuccess: () => toast.success(next ? t('servers.toast.on') : t('servers.toast.off')),
      onError: (error) => toast.error(t('servers.toast.saveFailed'), error),
    });
  return (
    <PrefRows>
      <PrefRow id="servers-enabled" setting="servers.enabled" title={t('servers.switch')} hint={t('servers.hint')}>
        <div className="servers-switch">
          <Switch checked={enabled} disabled={!loaded || update.isPending} aria-label={t('servers.switch')} onChange={change} />
          <Link className="btn btn-small" to="/servers">
            {t('servers.open')}
          </Link>
        </div>
      </PrefRow>
    </PrefRows>
  );
}
