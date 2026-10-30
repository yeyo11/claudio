import { TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouteError } from 'react-router-dom';
import { Empty } from '@claudio/ui/components/ui';
import { isChunkLoadError, noticeStaleChunk } from '../lib/reload';
import { ReloadButton } from './ReloadOffer';

/**
 * What the app shows when rendering it threw, in place of React Router's developer page: the
 * person's language, a way back in by reloading, and a way to Home. The data router renders it
 * outside the shell, so it brings its own page around the state.
 */
export function RouteError() {
  const { t } = useTranslation('shell');
  const error = useRouteError();
  const stale = isChunkLoadError(error);
  const title = t(stale ? 'reload.stalePage' : 'routeError.title');
  // The page that failed left its own title behind
  useEffect(() => {
    document.title = `${title} · Claudio`;
  }, [title]);
  useEffect(() => {
    // A chunk deployed away has its own story (the reload offer); anything else is a bug worth a trace
    if (stale) noticeStaleChunk();
    else console.error('[claudio] the page failed to render:', error);
  }, [error, stale]);
  return (
    <main className="route-error">
      {/* The compact icon version: no drawing of the set says "this page broke" (not-found is a 404) */}
      <Empty
        icon={TriangleAlert}
        heading
        title={title}
        action={
          <span className="route-error-actions">
            <ReloadButton />
            {/* A plain link: the router that failed is not trusted to navigate */}
            <a href="/" className="btn btn-small">
              {t('notFound.home')}
            </a>
          </span>
        }
      >
        {t(stale ? 'reload.stalePageHint' : 'routeError.body')}
      </Empty>
    </main>
  );
}
