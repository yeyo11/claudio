import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useAccounts } from '../../api';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import { formatNumber, timeAgo } from '@claudio/ui/lib/format';
import { SignInPanel } from '../../components/setup/SignInPanel';
import { SignOutButton } from '../../components/setup/SignOutButton';
import { CLAUDE_CODE_ID } from '../../lib/provider-state';
import { useProviders } from '../../lib/providers';
import { methodsOf, offersSignOut } from '../../lib/setup';
import { SettingsDetailRow } from './groups/Section';
import { PrefRow, PrefRows, ReservedLabel } from './PrefRow';

/** A product name, never translated */
const CLAUDE_CODE_LABEL = 'Claude Code';

/**
 * Settings → Claude Code → Sign-in (docs/plans/settings-ia.md §6.2): the account Claude Code runs on,
 * the way to test it and to drop it, the sign-in panel, and the way to the other accounts. It is the
 * only place the panel lives in Settings: the Provider section links here.
 */
export function SignInSection() {
  const { t } = useTranslation('config');
  const { t: tSetup } = useTranslation('setup');
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: auth, error, isLoading } = useQuery({ queryKey: keys.auth, queryFn: api.auth });
  const setup = useQuery({ queryKey: keys.setup, queryFn: ({ signal }) => api.setup({ signal }) });
  const accounts = useAccounts().data;
  const status = useProviders().data?.find((s) => s.id === CLAUDE_CODE_ID);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.auth });
    void queryClient.invalidateQueries({ queryKey: keys.overview });
  };
  const clear = useMutation({
    mutationFn: api.clearCredentials,
    onSuccess: () => {
      refresh();
      toast.success(t('account.removed'));
    },
    onError: (err) => toast.error(t('account.removeFailed'), err),
  });
  const verify = useMutation({
    mutationFn: api.verifyAuth,
    onSuccess: (result) => {
      refresh();
      if (result.ok) toast.success(t('account.works'), t('account.worksDetail'));
      else toast.error(t('account.verifyFailed'), new Error(result.detail));
    },
    onError: (err) => toast.error(t('account.verifyFailed'), err),
  });
  const fromWrapper = auth?.tokenSource.startsWith('wrapper-') ?? false;
  const keyStored = setup.data?.providers.find((p) => p.id === CLAUDE_CODE_ID)?.keyStored ?? false;
  const methods = methodsOf(setup.data, CLAUDE_CODE_ID);
  // A credential kept here is dropped by Remove; Sign out is the vendor's own way, for the rest
  const signOut = !fromWrapper && status && offersSignOut(methods, status.state, status.reason, keyStored);

  const inUse = auth?.inUse ?? null;
  const expired = inUse?.signInState === 'expired';
  const account = accounts?.find((a) => a.id === inUse?.id);
  const envSource = auth?.tokenSource === 'env-oauth-token' || auth?.tokenSource === 'env-api-key';
  // The panel is open when there is nothing to keep (no account, or its sign-in expired); otherwise a click opens it
  const [asked, setAsked] = useState(false);
  const panelOpen = asked || (auth !== undefined && (inUse === null || expired));

  const facts = auth && (
    <span className="account-facts">
      <span className="account-facts-line">
        {inUse === null ? <Tag tone="warn">{t('account.notSignedIn')}</Tag> : expired ? <Tag tone="warn">{t('account.expired')}</Tag> : <Tag tone="ok">{t('account.loggedIn')}</Tag>}
        <span className="break">{inUse?.label ?? t('account.noAccount')}</span>
      </span>
      {inUse && (
        <span className="account-facts-line">
          {[account?.plan ?? (inUse.id === 'default' ? auth.subscriptionType : null), t(`account.kindWord.${inUse.kind}`), inUse.id === 'default' && envSource ? t('account.fromEnvironment') : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      )}
      {inUse && <span className="account-facts-line">{inUse.checkedAt ? t('account.checked', { ago: timeAgo(inUse.checkedAt) }) : t('account.neverChecked')}</span>}
      {inUse && inUse.id !== 'default' && (
        <span>
          <Trans t={t} i18nKey="account.runsOn" values={{ name: inUse.label }} components={{ link: <Link to="/accounts" className="c-accent" /> }} />
        </span>
      )}
    </span>
  );

  return (
    <PrefRows>
      <PrefRow id="sign-in-account" setting="sign-in.account" title={t('account.inUse')} hint={isLoading ? <Skeleton rows={4} /> : facts}>
        <div className="pref-actions">
          {inUse !== null && (
            <button className="btn" disabled={verify.isPending} onClick={() => verify.mutate()}>
              <ReservedLabel states={[t('account.testMessage'), t('account.testing')]} shown={verify.isPending ? 1 : 0} />
            </button>
          )}
          {expired && !panelOpen && (
            <button className="btn" onClick={() => setAsked(true)}>
              {t('account.signInAgain')}
            </button>
          )}
          {fromWrapper && (
            <button className="btn btn-danger" disabled={clear.isPending} onClick={() => clear.mutate()}>
              {t('account.remove')}
            </button>
          )}
          {signOut && <SignOutButton tool={CLAUDE_CODE_ID} label={CLAUDE_CODE_LABEL} keyOnly={methods?.signOutKeyOnly ?? false} />}
        </div>
        {inUse !== null && <span className="small muted">{t('account.testHint')}</span>}
        {/* Always rendered so a screen reader is told when the result lands */}
        <span className="small" role="status">
          {verify.data && (
            <span className={`meta-icon ${verify.data.ok ? 'text-ok' : 'text-err'}`}>
              {verify.data.ok ? <CircleCheck {...ICON_SM} /> : <CircleX {...ICON_SM} />}
              {verify.data.ok ? t('account.working') : t('account.failed', { detail: verify.data.detail })}
            </span>
          )}
        </span>
      </PrefRow>
      <ErrorBox error={error} />

      {/* The same panel as the setup assistant: a Claude account, or an API key. No illustration: it sits beside other content */}
      {panelOpen ? (
        <PrefRow id="sign-in-panel" setting="sign-in.panel" title={tSetup('panel.title', { label: CLAUDE_CODE_LABEL })} stacked>
          <SignInPanel tool={CLAUDE_CODE_ID} label={CLAUDE_CODE_LABEL} layout="card" closable={asked} onClose={() => setAsked(false)} />
        </PrefRow>
      ) : (
        <PrefRow id="sign-in-panel" setting="sign-in.panel" title={tSetup('panel.title', { label: CLAUDE_CODE_LABEL })}>
          <button className="btn" onClick={() => setAsked(true)}>
            {t('account.signInOther')}
          </button>
        </PrefRow>
      )}

      <AccountsRow />
    </PrefRows>
  );
}

/** "Accounts · 3 · rotation on": the other accounts live on their own page, one row away. */
function AccountsRow() {
  const { t } = useTranslation('config');
  const accounts = useAccounts().data;
  const settings = useQuery({ queryKey: keys.accountsSettings, queryFn: ({ signal }) => api.accountsSettings({ signal }) });
  const note =
    accounts === undefined
      ? undefined
      : [formatNumber(accounts.length), settings.data ? t(settings.data.rotateOnLimit ? 'account.rotationOn' : 'account.rotationOff') : null].filter(Boolean).join(' · ');
  return <SettingsDetailRow to="/accounts" label={t('account.accounts')} note={note} setting="sign-in.accounts" />;
}
