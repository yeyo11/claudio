import { KeyRound } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { HostRefusal } from '@claudio/shared';
import { BrandMark, ICON } from '@claudio/ui/components/icons';
import { Illustration } from '@claudio/ui/components/illustrations';
import { formatDuration } from '@claudio/ui/lib/format';
import { claimHost } from '../lib/auth';

/**
 * What a 421 looks like: the wrapper does not answer to the name this page was opened by. The shell
 * and its assets load for any host, so this screen takes the app's place, and when the owner's token
 * can add the host it asks for it here, where a person can act on it (docs/plans/container-polish.md, D5).
 */
export function HostRefused({ refusal }: { refusal: HostRefusal }) {
  const { t } = useTranslation('common');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const { host, canClaim, firstRunToken } = refusal;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await claimHost(token);
      if (outcome.status === 'claimed') {
        // The host is on the list now: every request this page makes is answered, so start over
        window.location.reload();
        return;
      }
      if (outcome.status === 'rejected') setError(t('signIn.rejected'));
      else if (outcome.status === 'rate-limited') setError(t('hostRefused.tooMany', { wait: formatDuration(outcome.waitMs) }));
      else setError(t('hostRefused.refused', { message: outcome.message }));
    } catch {
      setError(t('signIn.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <form className="card signin-card" onSubmit={submit}>
        <Illustration name="signed-out" tone="warn" size="sm" className="signin-illustration" />
        <div className="signin-head">
          <span className="signin-brand">
            <BrandMark size={22} />
            Claudio
          </span>
          <h1>
            <Trans t={t} i18nKey="hostRefused.title" values={{ host }} components={{ mono: <span className="mono" /> }} />
          </h1>
          <p className="muted">{t('hostRefused.body')}</p>
        </div>
        {canClaim ? (
          <>
            <label className="field">
              <span className="section-label">{t('hostRefused.label')}</span>
              <span className="signin-input">
                <KeyRound {...ICON} className="signin-input-icon" />
                <input
                  type="password"
                  autoComplete="off"
                  autoFocus
                  value={token}
                  placeholder={t('signIn.placeholder')}
                  aria-describedby={firstRunToken ? hintId : undefined}
                  onChange={(event) => setToken(event.target.value)}
                />
              </span>
            </label>
            {error && (
              <div className="alert alert-bad" role="alert">
                <div className="alert-body">{error}</div>
              </div>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy || !token.trim()}>
              {busy ? t('hostRefused.adding') : t('hostRefused.submit', { host })}
            </button>
            {firstRunToken && (
              <p id={hintId} className="signin-hint">
                {t('signIn.firstRun.hint')}
              </p>
            )}
          </>
        ) : (
          <p className="signin-hint">{t('hostRefused.manual')}</p>
        )}
      </form>
    </div>
  );
}
