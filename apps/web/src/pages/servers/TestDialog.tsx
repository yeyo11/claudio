import type { ClaudioServer, ServerCheck, ServerTestResult } from '@claudio/shared';
import { CircleCheck, CircleDashed, CircleX } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { ErrorBox } from '@claudio/ui/components/ui';
import { formatNumber } from '@claudio/ui/lib/format';
import { serversApi, useServersMutation } from '../../lib/api/servers';
import { codeWords } from './words';

const CHECKS = ['meta', 'rest', 'events', 'socket'] as const;

/**
 * The four checks of a connection test, each on its own because one often breaks while the others
 * work (§4.2): a word and an icon beside the colour, the latency in tabular figures, and for a
 * failure the reason in words. `result` null is the test running.
 */
export function TestResultView({ result, error }: { result: ServerTestResult | null; error?: unknown }) {
  const { t } = useTranslation('serversPage');
  const reason = (check: ServerCheck): string | null => {
    return check.ok ? null : codeWords('test.code', check.code);
  };
  return (
    <div className="stack" data-testid="server-test">
      {/* One line in every state (testing, where it was reached, no address), so the dialog keeps its
          height as a test starts and ends; a live region, so the end of a test is announced too */}
      <p className="small server-test-line" role="status" data-testid={result === null && !error ? 'server-test-running' : 'server-test-line'}>
        {result === null && !error ? (
          <span className="server-test-running">
            <Spinner /> {t('test.running')}
          </span>
        ) : result?.address ? (
          <span className="muted">
            {t('test.reachedAt')} <code className="mono break">{result.address}</code>
          </span>
        ) : result ? (
          <span className="muted">{t('test.noAddress')}</span>
        ) : null}
      </p>
      <ul className="server-checks">
        {CHECKS.map((name) => {
          const check = result?.[name];
          const why = check ? reason(check) : null;
          return (
            <li key={name} className="server-check" data-check={name} data-ok={check ? String(check.ok) : undefined}>
              <span className="server-check-name">{t(`test.${name}`)}</span>
              {check ? (
                <span className={`collab-tone server-status ${check.ok ? 'tone-ok' : 'tone-bad'}`}>
                  {check.ok ? <CircleCheck {...ICON_SM} /> : <CircleX {...ICON_SM} />}
                  <span>{check.ok ? t('test.ok') : t('test.failed')}</span>
                </span>
              ) : (
                // The same shape as the word that replaces it (icon and word), so a row keeps its height
                <span className="collab-tone server-status muted" aria-hidden>
                  <CircleDashed {...ICON_SM} />
                  <span>…</span>
                </span>
              )}
              {check?.latencyMs !== undefined && <span className="small muted tnum">{t('test.latency', { ms: formatNumber(check.latencyMs) })}</span>}
              {why && <span className="small muted server-check-why">{why}</span>}
            </li>
          );
        })}
      </ul>
      {error ? <ErrorBox error={error} title={t('test.failedToRun')} /> : null}
    </div>
  );
}

/** Test connection: runs as the dialog opens, and again on request */
export function TestServerDialog({ server, onClose }: { server: ClaudioServer; onClose: () => void }) {
  const { t } = useTranslation('serversPage');
  const test = useServersMutation(() => serversApi.test(server.id));
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    test.mutate(undefined);
  }, [test]);
  return (
    <Dialog
      title={t('test.title', { name: server.name })}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn" disabled={test.isPending} onClick={() => test.mutate(undefined)} data-testid="server-test-again">
            {t('test.again')}
          </button>
          {/* The first focus: Test again is disabled while the test that opened the dialog runs */}
          <button type="button" className="btn" onClick={onClose} data-autofocus>
            {t('test.close')}
          </button>
        </>
      }
    >
      <TestResultView result={test.isPending ? null : (test.data ?? null)} error={test.error} />
    </Dialog>
  );
}
