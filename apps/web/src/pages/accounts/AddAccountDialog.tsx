import type { AccountLoginSession } from '@claudio/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ExternalLink, KeyRound, LogIn } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Dialog } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { CopyButton, ErrorBox, Field, Segmented } from '@claudio/ui/components/ui';

type Kind = 'login' | 'token' | 'api-key';
const KINDS: readonly Kind[] = ['login', 'token', 'api-key'];

/** A sign-in that still waits for the CLI or the person. */
const live = (session: AccountLoginSession | null): boolean => session !== null && session.endedAt === null;

/**
 * The sign-in panel of a `login` account, in the shape of the setup flow's: where to go, the link
 * with Copy, a field for the code the page shows when the CLI's browser could not open, and the
 * braille spinner beside "Waiting for you to approve". The box carries the energy border: it is the
 * one live surface of the dialog while it waits. Only the URL the CLI printed reaches this panel.
 */
function SignInSession({ session, onCode, sending, error }: { session: AccountLoginSession; onCode: (code: string) => void; sending: boolean; error: unknown }) {
  const { t } = useTranslation('accountsConfig');
  const [code, setCode] = useState('');
  const failed = session.state === 'failed' || session.state === 'cancelled';
  if (failed) {
    return (
      <div className="signin-result" role="alert">
        <span className="signin-result-text">{t(session.state === 'failed' ? 'signIn.failed' : 'signIn.cancelled')}</span>
      </div>
    );
  }
  const url = session.url;
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
            <a className="c-accent signin-link signin-url" href={url} target="_blank" rel="noopener noreferrer">
              {url.replace(/^https:\/\//, '')}
              <ExternalLink {...ICON_SM} />
              <span className="sr-only"> ({t('signIn.opensNewTab')})</span>
            </a>
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
      </div>
    </div>
  );
}

/**
 * Adds an account: a `login` one signs in through the CLI in a config dir of its own, a `token`
 * (`claude setup-token`) or an API key is pasted once and never comes back from the API. The last
 * two have no identity of their own, so they need an alias.
 */
export function AddAccountDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { t } = useTranslation(['accountsConfig', 'common']);
  const toast = useToast();
  const formId = useId();
  const [kind, setKind] = useState<Kind>('login');
  const [alias, setAlias] = useState('');
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [started, setStarted] = useState<AccountLoginSession | null>(null);

  const start = useMutation({
    mutationFn: () => api.addLoginAccount({ ...(alias.trim() ? { alias: alias.trim() } : {}), ...(email.trim() ? { email: email.trim() } : {}) }),
    onSuccess: (session) => setStarted(session),
  });
  const reading = useQuery({
    queryKey: keys.accountLogin(started?.id ?? ''),
    queryFn: ({ signal }) => api.accountLogin(started?.id ?? '', { signal }),
    enabled: live(started),
    refetchInterval: 1500,
  });
  const session = reading.data ?? started;
  const code = useMutation({ mutationFn: (value: string) => api.accountLoginCode(session?.id ?? '', { code: value }), onSuccess: (next) => setStarted(next) });
  const token = useMutation({
    mutationFn: () => api.addTokenAccount({ kind: kind === 'api-key' ? 'api-key' : 'token', alias: alias.trim(), secret: secret.trim() }),
    onSuccess: () => {
      toast.success(t('dialog.added'));
      onAdded();
      onClose();
    },
    onError: (err) => toast.error(t('dialog.addFailed'), err),
  });

  // The end of a sign-in is handled once, whichever read brings it
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!session || session.endedAt === null || handled.current === session.id) return;
    handled.current = session.id;
    if (session.state === 'succeeded') {
      toast.success(t('dialog.signedIn'));
      onAdded();
      onClose();
    } else {
      onAdded();
    }
  }, [session, onAdded, onClose, t, toast]);

  // Closing while the CLI waits stops it, instead of leaving it waiting for nobody
  const pending = useRef<AccountLoginSession | null>(null);
  pending.current = live(session) ? session : null;
  useEffect(
    () => () => {
      if (pending.current) void api.cancelAccountLogin(pending.current.id).catch(() => undefined);
    },
    [],
  );

  const signingIn = session !== null;
  const canSubmit = kind === 'login' ? !start.isPending : alias.trim() !== '' && secret.trim() !== '' && !token.isPending;

  return (
    <Dialog
      title={t('dialog.title')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
          {!signingIn && (
            <button type="submit" form={formId} className="btn btn-primary" disabled={!canSubmit}>
              {kind === 'login' ? <LogIn {...ICON_SM} /> : <KeyRound {...ICON_SM} />}{' '}
              {kind === 'login' ? (start.isPending ? t('dialog.starting') : t('dialog.signIn')) : token.isPending ? t('dialog.adding') : t('dialog.add')}
            </button>
          )}
        </>
      }
    >
      {signingIn && session ? (
        <SignInSession session={session} onCode={(value) => code.mutate(value)} sending={code.isPending} error={code.error} />
      ) : (
        <form
          id={formId}
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            if (kind === 'login') start.mutate();
            else token.mutate();
          }}
        >
          <Segmented<Kind> label={t('dialog.kind')} value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) }))} />
          <p className="muted small">{t(`dialog.hint.${kind}`)}</p>
          <Field label={t('dialog.alias')} hint={kind === 'login' ? t('dialog.aliasOptional') : t('dialog.aliasRequired')}>
            <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={t('dialog.aliasPlaceholder')} autoComplete="off" data-autofocus />
          </Field>
          {kind === 'login' ? (
            <Field label={t('dialog.email')} hint={t('dialog.emailHint')}>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="work@example.com" autoComplete="off" />
            </Field>
          ) : (
            <Field label={kind === 'api-key' ? t('dialog.apiKey') : t('dialog.token')} hint={t('dialog.secretHint')}>
              <input type="password" className="mono" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={kind === 'api-key' ? 'sk-ant-api03-…' : 'sk-ant-oat01-…'} autoComplete="off" spellCheck={false} />
            </Field>
          )}
          <ErrorBox error={start.error} title={t('dialog.startFailed')} />
        </form>
      )}
    </Dialog>
  );
}
