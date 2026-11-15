import type { AccountLoginSession, RotationPolicy } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogIn } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Dialog } from '@claudio/ui/components/Dialog';
import { Switch } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { live, SignInSession } from '../../components/setup/SignInSession';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Field, Segmented } from '@claudio/ui/components/ui';
import { requestOf, withAccount } from './ProjectRuleCard';

// The OAuth token (`claude setup-token`) is no longer offered; accounts already added keep working
type Kind = 'login' | 'api-key';
const KINDS: readonly Kind[] = ['login', 'api-key'];

/** The rules a new account would be left out of: those that list their accounts (no list allows every account) */
export const rulesWithList = (policies: readonly RotationPolicy[] | undefined): RotationPolicy[] => (policies ?? []).filter((policy) => policy.order !== undefined);

/**
 * Puts a new account on every rule that lists its accounts (D7 of
 * docs/plans/account-configuration-and-project-rules.md), each written back whole so no field of the
 * rule is dropped. A rule with no list already allows it and is left alone.
 */
export async function joinRules(policies: readonly RotationPolicy[], accountId: string): Promise<void> {
  for (const policy of rulesWithList(policies)) await api.updateAccountPolicy(policy.id, withAccount(requestOf(policy), [], accountId, true));
}

/**
 * Adds an account: a `login` one signs in through the CLI in a config dir of its own, an API key is
 * pasted once and never comes back from the API. A key has no identity of its own, so it needs an alias.
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
  const queryClient = useQueryClient();
  // The rules that would leave the new account out: the dialog asks whether it joins them (D7)
  const policies = useQuery({ queryKey: keys.accountPolicies, queryFn: () => api.accountPolicies() });
  const ruled = rulesWithList(policies.data);
  const [join, setJoin] = useState(false);
  const joining = useRef(false);
  joining.current = join;
  const settleRules = (accountId: string) => {
    if (!joining.current || ruled.length === 0) return;
    joinRules(ruled, accountId)
      .catch((err: unknown) => toast.error(t('dialog.joinFailed'), err))
      .finally(() => void queryClient.invalidateQueries({ queryKey: keys.accountPolicies }));
  };
  const settle = useRef(settleRules);
  settle.current = settleRules;

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
    mutationFn: () => api.addTokenAccount({ kind: 'api-key', alias: alias.trim(), secret: secret.trim() }),
    onSuccess: (account) => {
      settle.current(account.id);
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
      settle.current(session.accountId);
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
        <SignInSession
          session={session}
          onCode={(value) => code.mutate(value)}
          sending={code.isPending}
          error={code.error}
          onRetry={() => {
            setStarted(null);
            start.reset();
          }}
        />
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
          <Segmented<Kind> label={t('dialog.kind')} value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: t(`dialog.kinds.${k}`) }))} />
          <p className="muted small">{t(`dialog.hint.${kind}`)}</p>
          <Field label={t('dialog.alias')} hint={kind === 'login' ? t('dialog.aliasOptional') : t('dialog.aliasRequired')}>
            <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={t('dialog.aliasPlaceholder')} autoComplete="off" data-autofocus />
          </Field>
          {kind === 'login' ? (
            <Field label={t('dialog.email')} hint={t('dialog.emailHint')}>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="work@example.com" autoComplete="off" />
            </Field>
          ) : (
            <Field label={t('dialog.apiKey')} hint={t('dialog.secretHint')}>
              <input type="password" className="mono" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="sk-ant-api03-…" autoComplete="off" spellCheck={false} />
            </Field>
          )}
          {/* A bare switch with its consequence beside it, not inside a Field: a label inside a label
              would make a tap on the explanation flip the choice */}
          {ruled.length > 0 && (
            <div className="add-account-rules">
              <Switch checked={join} onChange={setJoin}>
                {t('dialog.rules.join', { count: ruled.length })}
              </Switch>
              <p className="muted small">{t(join ? 'dialog.rules.on' : 'dialog.rules.off', { count: ruled.length })}</p>
            </div>
          )}
          <ErrorBox error={start.error} title={t('dialog.startFailed')} />
        </form>
      )}
    </Dialog>
  );
}
