import { KeyRound } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { AuthMode } from '@claudio/shared';
import { signIn, useFirstRunToken } from '../lib/auth';
import { BrandMark, ICON } from '@claudio/ui/components/icons';
import { Illustration } from '@claudio/ui/components/illustrations';

/**
 * What a 401 looks like: the whole app is replaced by this, so a guarded wrapper reached without a
 * credential is a screen that says what to do, and not the blank page a failed first request
 * leaves behind.
 */
export function SignIn({ mode }: { mode: AuthMode }) {
  const { t } = useTranslation('common');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  // A container made this token on its first start: say where it was printed, not where it was given
  const firstRun = useFirstRunToken();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await signIn(token))) setError(t('signIn.rejected'));
    } catch {
      setError(t('signIn.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <form className="card signin-card" onSubmit={submit}>
        <Illustration name="signed-out" tone="warn" size="sm" className="signin-illustration" />
        <div className="signin-head">
          <span className="signin-brand">
            <BrandMark size={22} />
            Claudio
          </span>
          <h1>{firstRun ? t('signIn.firstRun.title') : t('signIn.title')}</h1>
          <p className="muted">
            {firstRun ? <Trans t={t} i18nKey="signIn.firstRun.body" components={{ code: <code /> }} /> : mode === 'oidc' ? t('signIn.oidcBody') : t('signIn.tokenBody')}
          </p>
        </div>
        <label className="field">
          <span className="section-label">{t('signIn.label')}</span>
          <span className="signin-input">
            <KeyRound {...ICON} className="signin-input-icon" />
            <input
              type="password"
              autoComplete="off"
              autoFocus
              value={token}
              placeholder={t('signIn.placeholder')}
              aria-describedby={hintId}
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
          {t('signIn.submit')}
        </button>
        <p id={hintId} className="signin-hint">
          {firstRun ? <Trans t={t} i18nKey="signIn.firstRun.hint" components={{ code: <code /> }} /> : t('signIn.hint')}
        </p>
      </form>
    </main>
  );
}
