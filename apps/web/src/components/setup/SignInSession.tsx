import type { AccountLoginSession } from '@claudio/shared';
import { Clock, ExternalLink, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { CopyButton, ErrorBox, Field } from '@claudio/ui/components/ui';
import { timeLeft } from '../../lib/setup';

/** How long the server keeps a sign-in open before it ends as `expired` (apps/api/src/account-logins.ts). */
const LOGIN_LIFETIME_MS = 15 * 60_000;

/** A sign-in that still waits for the CLI or the person. */
export const live = (session: AccountLoginSession | null): boolean => session !== null && session.endedAt === null;

/** Ticks once a second while a sign-in waits, so "expires in" counts down; nothing else on the panel moves. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * The sign-in panel of a Claude account, in the shape of the setup flow's: where to go, the link
 * with Copy, a field for the code the page shows when the CLI's browser could not open, and the
 * braille spinner beside "Waiting for you to approve". The box carries the energy border: it is the
 * one live surface of the screen while it waits. Only the URL the CLI printed reaches this panel.
 * A sign-in that ended badly says so and offers the one way forward (`onRetry`).
 */
export function SignInSession({
  session,
  onCode,
  sending,
  error,
  onRetry,
}: {
  session: AccountLoginSession;
  onCode: (code: string) => void;
  sending: boolean;
  error: unknown;
  onRetry?: () => void;
}) {
  const { t } = useTranslation('accountsConfig');
  const [code, setCode] = useState('');
  const now = useNow(session.endedAt === null);
  if (session.state === 'expired' || session.state === 'failed') {
    const expired = session.state === 'expired';
    const Icon = expired ? Clock : TriangleAlert;
    return (
      <>
        <div className={`signin-result${expired ? ' warn' : ''}`} role="alert">
          <Icon {...ICON} className="ico" />
          <div className="signin-result-text">
            <span>{t(expired ? 'signIn.expired' : 'signIn.failed')}</span>
          </div>
        </div>
        {onRetry && (
          <div className="signin-actions">
            <button type="button" className="btn" onClick={onRetry}>
              <RefreshCw {...ICON_SM} />
              {t(expired ? 'signIn.newLink' : 'signIn.tryAgain')}
            </button>
          </div>
        )}
      </>
    );
  }
  // A cancelled one closes silently; the owner of the panel reads it
  if (session.state === 'cancelled') return null;
  const url = session.url;
  const left = timeLeft(new Date(Date.parse(session.startedAt) + LOGIN_LIFETIME_MS).toISOString(), now);
  return (
    <div className={`signin-device live-energy${url ? ' is-link' : ''}`} role="group" aria-label={t('signIn.title')}>
      {url ? (
        <>
          <ol className="signin-steps">
            <li>
              <span className="n">1</span>
              <span>{t('signIn.open')}</span>
            </li>
            <li>
              <span className="n">2</span>
              <span>{t('signIn.approve')}</span>
            </li>
          </ol>
          <div className="signin-code-box">
            <Tooltip content={url}>
              <a className="c-accent signin-link signin-url" href={url} target="_blank" rel="noopener noreferrer">
                <span className="signin-url-text">{url.replace(/^https:\/\//, '')}</span>
                <ExternalLink {...ICON_SM} />
                <span className="sr-only"> ({t('signIn.opensNewTab')})</span>
              </a>
            </Tooltip>
            <CopyButton text={url} label={t('signIn.copyLink')} shown />
          </div>
          <form
            className="signin-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) {
                onCode(code.trim());
                setCode('');
              }
            }}
          >
            <Field label={t('signIn.codeLabel')} hint={t('signIn.codeHint')}>
              <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
            <div className="signin-actions">
              <button type="submit" className="btn" disabled={!code.trim() || sending}>
                {t('signIn.sendCode')}
              </button>
            </div>
          </form>
          <ErrorBox error={error} title={t('signIn.codeFailed')} />
        </>
      ) : null}
      <div className="signin-wait" role="status">
        <Spinner />
        {url ? t('signIn.waiting') : t('signIn.starting')}
        {url && <span className="left">{t('signIn.expiresIn', { left })}</span>}
      </div>
    </div>
  );
}
