import type { CliCanaryState } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { timeAgo } from '@claudio/ui/lib/format';

/** One tone per outcome: ok passed, bad failed, warn when it could not say (a sign-in is needed, or it did not run) */
const LOOK: Record<CliCanaryState, { tone: 'ok' | 'bad' | 'warn'; icon: LucideIcon }> = {
  pass: { tone: 'ok', icon: CircleCheck },
  fail: { tone: 'bad', icon: TriangleAlert },
  'needs-sign-in': { tone: 'warn', icon: CircleHelp },
  error: { tone: 'warn', icon: CircleHelp },
};

/**
 * What the installed CLI did under the canary of the account-configuration plan: the checks that
 * shared accounts stand on, re-run by Claudio when a CLI version is new. A line, with the checks
 * that did not pass listed under it; it only reports, and says so when something failed.
 */
export function CliCanaryLine() {
  const { t } = useTranslation('accountsConfig');
  const toast = useToast();
  const queryClient = useQueryClient();
  // No poll: `accounts.changed` refetches it when a run starts and when it ends
  const { data } = useQuery({ queryKey: keys.cliCanary, queryFn: ({ signal }) => api.cliCanary({ signal }) });
  const again = useMutation({
    mutationFn: () => api.runCliCanary(),
    onSuccess: (status) => queryClient.setQueryData(keys.cliCanary, status),
    onError: (err) => toast.error(t('canary.againFailed'), err),
  });
  // No CLI read yet: there is nothing to say about a version
  if (!data?.version) return null;
  const result = data.result;
  const look = result ? LOOK[result.state] : null;
  const unsettled = result?.checks.filter((c) => c.state !== 'pass') ?? [];

  return (
    <section className="card canary-line" aria-label={t('canary.heading')}>
      <div className="canary-row">
        <span className="canary-what">
          <span className="canary-heading">{t('canary.heading')}</span>
          <span className="muted small">{t('canary.label', { version: data.version })}</span>
        </span>
        <span className="canary-state">
          {data.running ? (
            <>
              <Spinner />
              <span role="status">{t('canary.running')}</span>
            </>
          ) : look && result ? (
            <>
              <span className={`badge badge-${look.tone}`}>
                <look.icon {...ICON_SM} aria-hidden />
                <span className="badge-text">{t(`canary.state.${result.state}`)}</span>
              </span>
              <span className="muted small">{timeAgo(result.checkedAt)}</span>
            </>
          ) : (
            <span className="muted small">{t('canary.notChecked')}</span>
          )}
          <button type="button" className="btn btn-small" disabled={data.running || again.isPending} onClick={() => again.mutate()}>
            {t('canary.again')}
          </button>
        </span>
      </div>
      {!data.running && unsettled.length > 0 && (
        <div className="canary-detail small">
          <p className="muted">{result?.state === 'fail' ? t('canary.failed') : result?.state === 'needs-sign-in' ? t('canary.needsSignIn') : t('canary.couldNotRun')}</p>
          <ul>
            {unsettled.map((c) => (
              <li key={c.id}>
                <strong>{t(`canary.checks.${c.id}`)}</strong> <span className="muted">{c.observed}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
