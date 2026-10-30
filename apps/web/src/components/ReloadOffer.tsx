import { RefreshCw, X } from 'lucide-react';
import { lazy, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { dismissReloadOffer, isChunkLoadError, noticeStaleChunk, reloadApp, useReloadOffer } from '../lib/reload';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { Empty } from '@claudio/ui/components/ui';

export function ReloadButton() {
  const { t } = useTranslation('shell');
  const [reloading, setReloading] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-primary btn-small"
      disabled={reloading}
      onClick={() => {
        setReloading(true);
        void reloadApp();
      }}
    >
      {reloading ? <span className="spinner" aria-hidden /> : <RefreshCw {...ICON_SM} />}
      {reloading ? t('reload.reloading') : t('reload.action')}
    </button>
  );
}

/**
 * The offer to reload once the server runs another build. It sits above the page and blocks
 * nothing: whoever is halfway through a message finishes it first.
 */
export function ReloadBanner() {
  const { t } = useTranslation('shell');
  const offer = useReloadOffer();
  if (!offer) return null;
  return (
    <div className="alert alert-info reload-banner" role="status" data-testid="reload-banner">
      <RefreshCw className="alert-icon" {...ICON_SM} />
      <span className="alert-body reload-banner-text">
        {offer.reason === 'updated' ? t('reload.updated', { version: offer.version }) : t('reload.stale')}
      </span>
      <ReloadButton />
      <button type="button" className="icon-btn" aria-label={t('reload.dismiss')} onClick={dismissReloadOffer}>
        <X {...ICON} />
      </button>
    </div>
  );
}

/** What a route whose code is gone shows instead of an error: the same way out as the banner. */
function StalePage() {
  const { t } = useTranslation('shell');
  return (
    <Empty icon={RefreshCw} title={t('reload.stalePage')} action={<ReloadButton />}>
      {t('reload.stalePageHint')}
    </Empty>
  );
}

/** How long a chunk that failed to load is given before it is asked for again. */
export const CHUNK_RETRY_MS = 600;

/**
 * Loads a chunk, asking once more after a moment when it fails as a chunk does: a network blip or a
 * server restarting fails the first request of a chunk that is still there. Resolves to null when
 * the second answer is the same, which is when the chunk is gone; any other failure is thrown.
 */
export async function loadChunk<T>(load: () => Promise<T>, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    if (!isChunkLoadError(error)) throw error;
  }
  await wait(CHUNK_RETRY_MS);
  try {
    return await load();
  } catch (error) {
    if (!isChunkLoadError(error)) throw error;
    return null;
  }
}

/**
 * `React.lazy`, for code that may have been deployed away. A chunk that fails to load is asked for
 * once more; when it is gone, the reload offer is raised and `fallback` (a page that says so) is
 * rendered instead of taking the app down with it. `React.lazy` keeps whatever it resolved for good,
 * so after a fallback the next visit to the route starts a load of its own rather than finding the
 * fallback cached for the session. Any other failure is thrown as before.
 */
export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ComponentType<P> = StalePage): ComponentType<P> {
  const attempt = (): ComponentType<P> =>
    lazy(async () => {
      const page = await loadChunk(load);
      if (page) return { default: page };
      noticeStaleChunk();
      current = attempt();
      return { default: fallback };
    });
  let current = attempt();
  return function LazyPage(props: P) {
    // Read once per mount: a remount after a fallback picks up the fresh attempt
    const [Page] = useState(() => current);
    return <Page {...props} />;
  };
}
