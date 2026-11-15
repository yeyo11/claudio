import type { CliCanaryCheck, CliCanaryState } from '@claudio/shared';
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
 * that did not pass listed under it; it only reports, and says so when something failed. What the
 * server observed stays in its log and in the API: it is English text from the CLI's own side.
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
  const sentence = (c: CliCanaryCheck): string => (c.state === 'fail' ? t(`canary.whenFailed.${c.id}`) : c.state === 'pass' ? '' : t(`canary.checkState.${c.state}`));
  const busy = data.running || again.isPending;
  // A re-run cannot change "needs a signed-in account": only signing in can
  const canRerun = result?.state !== 'needs-sign-in';

  return (
    <section className="card canary-line" aria-label={t('canary.heading')}>
      <div className="canary-row">
        <span className="canary-what">
          <h2 className="canary-heading">{t('canary.heading')}</h2>
          <span className="muted small">{t('canary.label', { version: data.version })}</span>
        </span>
        <span className="canary-state">
          {/* Mounted all the time, so the outcome is read out when it replaces "Checking" */}
          <span role="status" className="canary-result">
            {data.running ? (
              <>
                <Spinner />
                {t('canary.running')}
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
          </span>
          {canRerun && (
            // aria-busy, not disabled: a disabled button drops the keyboard focus to the body
            <button type="button" className="btn btn-small" aria-busy={busy} onClick={() => !busy && again.mutate()}>
              {t(result ? 'canary.again' : 'canary.now')}
            </button>
          )}
        </span>
      </div>
      {/* Kept while a run goes on, so the page below does not jump */}
      {unsettled.length > 0 && (
        <div className="canary-detail small">
          <p className="muted">{result?.state === 'fail' ? t('canary.failed') : result?.state === 'needs-sign-in' ? t('canary.needsSignIn') : t('canary.couldNotRun')}</p>
          <ul>
            {unsettled.map((c) => (
              <li key={c.id}>
                <span className="canary-check">{t('canary.checkLine', { name: t(`canary.checks.${c.id}`) })}</span> <span className="muted">{sentence(c)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
