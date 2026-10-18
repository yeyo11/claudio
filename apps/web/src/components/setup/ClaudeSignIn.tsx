import type { AccountLoginSession } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Segmented } from '@claudio/ui/components/ui';
import { CLAUDE_CODE_ID } from '../../lib/provider-state';
import { failureOf, keyLink, READINESS_KEYS } from '../../lib/setup';
import { ExternalText, FailureNote, PanelFrame, type PanelLayout } from './SignInFrame';
import { live, SignInSession } from './SignInSession';
import { useLogin } from './useLogin';

type Way = 'account' | 'key';
const WAYS: readonly Way[] = ['account', 'key'];

/** A product name, never translated */
const LABEL = 'Claude Code';

/** The variable the key goes in: the only one left, since the OAuth token is no longer offered. */
const API_KEY_VARIABLE = 'ANTHROPIC_API_KEY';

export interface ClaudeSignInProps {
  /** `inline` opens under a row, `sheet` fills a Sheet on a phone, `card` stays open in Settings */
  layout?: PanelLayout;
  /** A `card` that can be put away again offers Cancel like the other layouts */
  closable?: boolean;
  /** Whether the server keeps a key encrypted, for the hint under the key field */
  sealed: boolean;
  onClose: () => void;
}

/**
 * The one way to sign in to Claude Code, in the assistant, in Settings and (through its pieces) in
 * Accounts: the CLI's own `claude auth login` into the default account, relayed (open a link,
 * approve, paste the code if the page shows one), or an API key. The OAuth token is not offered.
 * Claudio never reads the credentials the CLI keeps.
 */
export function ClaudeSignIn({ layout = 'inline', closable = false, sealed, onClose }: ClaudeSignInProps) {
  const { t } = useTranslation('setup');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [way, setWay] = useState<Way>('account');
  const auth = useQuery({ queryKey: keys.auth, queryFn: ({ signal }) => api.auth({ signal }) });
  const closes = layout !== 'card' || closable;

  const refreshReadiness = useCallback(() => {
    for (const key of READINESS_KEYS) void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
  }, [queryClient]);
  const onSignedIn = useCallback(() => {
    refreshReadiness();
    if (layout === 'card') toast.success(t('panel.claudeSignedIn'));
    if (closes) onClose();
  }, [layout, closes, onClose, refreshReadiness, t, toast]);

  // The account sign-in: into the CLI's own config dir, so the `claude` a person runs works too
  const [started, setStarted] = useState<AccountLoginSession | null>(null);
  const start = useMutation({ mutationFn: () => api.signInAccountAgain('default'), onSuccess: (next) => setStarted(next) });
  const reading = useQuery({
    queryKey: keys.accountLogin(started?.id ?? ''),
    queryFn: ({ signal }) => api.accountLogin(started?.id ?? '', { signal }),
    enabled: live(started),
    refetchInterval: 1500,
  });
  const code = useMutation({ mutationFn: (value: string) => api.accountLoginCode(started?.id ?? '', { code: value }), onSuccess: (next) => setStarted(next) });
  const session = reading.data ?? started;

  // The end of a sign-in is handled once, whichever read brings it
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!session || session.endedAt === null || handled.current === session.id) return;
    handled.current = session.id;
    if (session.state === 'succeeded') onSignedIn();
    else if (session.state === 'cancelled') {
      refreshReadiness();
      if (closes) onClose();
      else setStarted(null);
    } else refreshReadiness();
  }, [session, closes, onClose, onSignedIn, refreshReadiness]);

  // A panel that closes while the CLI waits stops it, instead of leaving it waiting for nobody
  const pending = useRef<AccountLoginSession | null>(null);
  pending.current = live(session) ? session : null;
  useEffect(
    () => () => {
      if (pending.current) void api.cancelAccountLogin(pending.current.id).catch(() => undefined);
    },
    [],
  );

  const retry = () => {
    code.reset();
    setStarted(null);
    start.mutate();
  };
  const choose = (next: Way) => {
    if (next === way) return;
    if (pending.current) void api.cancelAccountLogin(pending.current.id).catch(() => undefined);
    code.reset();
    start.reset();
    setStarted(null);
    setWay(next);
  };

  const source = auth.data?.tokenSource;
  const fromEnvironment = source === 'env-oauth-token' || source === 'env-api-key';
  const notes = (
    <>
      {fromEnvironment && (
        <p className="signin-note warn" role="note">
          <TriangleAlert {...ICON_SM} />
          <span>{t('panel.envNote', { variable: source === 'env-api-key' ? API_KEY_VARIABLE : 'CLAUDE_CODE_OAUTH_TOKEN' })}</span>
        </p>
      )}
      {source === 'wrapper-oauth-token' && way === 'account' && (
        <p className="signin-note warn" role="note">
          <TriangleAlert {...ICON_SM} />
          <span>{t('panel.wrapperNote')}</span>
        </p>
      )}
    </>
  );

  const choice = (
    <Segmented<Way>
      label={t('panel.method')}
      value={way}
      onChange={choose}
      className={layout === 'sheet' ? 'signin-choice wide' : 'signin-choice'}
      options={WAYS.map((value) => ({ value, label: t(`panel.way.${value}`) }))}
    />
  );
  const cancelButton = closes && (
    <button type="button" className={layout === 'sheet' ? 'btn' : 'btn prov-quiet'} onClick={onClose}>
      {t('panel.cancel')}
    </button>
  );

  return (
    <PanelFrame label={LABEL} layout={layout} choice={choice}>
      {notes}
      {way === 'account' ? (
        session ? (
          <>
            <SignInSession session={session} onCode={(value) => code.mutate(value)} sending={code.isPending} error={code.error} onRetry={retry} />
            {live(session) && cancelButton && <div className={layout === 'sheet' ? 'prov-sheet-actions' : 'signin-actions'}>{cancelButton}</div>}
          </>
        ) : start.isPending ? (
          <div className="signin-wait signin-starting" role="status">
            <Spinner />
            {t('panel.starting', { label: LABEL })}
          </div>
        ) : (
          <>
            <p className="signin-note">{t('panel.account.intro')}</p>
            <ErrorBox error={start.error} title={t('panel.startFailed')} />
            <div className={layout === 'sheet' ? 'prov-sheet-actions' : 'signin-actions'}>
              <button type="button" className={layout === 'sheet' ? 'btn btn-primary' : 'btn'} onClick={() => start.mutate()}>
                {t('panel.account.signIn')}
              </button>
              {cancelButton}
            </div>
          </>
        )
      ) : (
        <ApiKeyForm layout={layout} sealed={sealed} onSucceeded={onSignedIn} cancel={cancelButton} />
      )}
    </PanelFrame>
  );
}

/** The key: a write-only field (never prefilled, cleared once sent), where to make one, and where it goes. */
function ApiKeyForm({ layout, sealed, onSucceeded, cancel }: { layout: PanelLayout; sealed: boolean; onSucceeded: () => void; cancel: ReactNode }) {
  const { t } = useTranslation('setup');
  const [secret, setSecret] = useState('');
  const login = useLogin({ onSucceeded, onCancelled: () => undefined });
  const typed = secret.trim();
  const busy = login.starting;
  const link = keyLink(CLAUDE_CODE_ID, null);
  const failure = failureOf(login.session);
  return (
    <form
      className="signin-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!typed || busy) return;
        login.start({ tool: CLAUDE_CODE_ID, method: 'key', secret: typed, variable: API_KEY_VARIABLE });
        setSecret('');
      }}
    >
      <p className="signin-note">{t('panel.claudeApiKey')}</p>
      <label className="field field-mono">
        <span className="field-label">{t('panel.variables.apiKey')}</span>
        <input
          className="mono"
          type="password"
          value={secret}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder="sk-ant-api03-…"
          onChange={(event) => setSecret(event.target.value)}
        />
      </label>
      {link && <ExternalText href={link}>{t('panel.link.apiKey')}</ExternalText>}
      <span className="form-hint">{t(sealed ? 'panel.hint.envSealed' : 'panel.hint.envPlain', { label: LABEL })}</span>
      <ErrorBox error={login.startError} title={t('panel.startFailed')} />
      {failure && <FailureNote failure={failure} label={LABEL} />}
      <div className={layout === 'sheet' ? 'prov-sheet-actions' : 'signin-actions'}>
        <button type="submit" className={layout === 'sheet' ? 'btn btn-primary' : 'btn'} disabled={!typed || busy}>
          {busy && <Spinner />}
          {busy ? t('panel.saving') : t('panel.save')}
        </button>
        {cancel}
      </div>
    </form>
  );
}
