import type { Account, AccountLoginSession } from '@claudio/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Dialog } from '@claudio/ui/components/Dialog';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox } from '@claudio/ui/components/ui';
import { accountName } from '../../lib/accounts';
import { live, SignInSession } from '../../components/setup/SignInSession';

/**
 * Signs an account that already exists in again, in the same panel an added account uses: the link,
 * the code field and the waiting line. The sign-in starts as the dialog opens, since opening it is
 * the person asking, and closing it while the CLI waits stops the CLI.
 */
export function SignInAgainDialog({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(['accountsConfig', 'common']);
  const toast = useToast();
  const name = accountName(account);

  const start = useMutation({ mutationFn: () => api.signInAccountAgain(account.id) });
  const asked = useRef(false);
  const { mutate } = start;
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    mutate();
  }, [mutate]);

  const started = start.data ?? null;
  const reading = useQuery({
    queryKey: keys.accountLogin(started?.id ?? ''),
    queryFn: ({ signal }) => api.accountLogin(started?.id ?? '', { signal }),
    enabled: live(started),
    refetchInterval: 1500,
  });
  const code = useMutation({ mutationFn: (value: string) => api.accountLoginCode(started?.id ?? '', { code: value }) });
  const session: AccountLoginSession | null = reading.data ?? code.data ?? started;

  // The end of a sign-in is handled once, whichever read brings it
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!session || session.endedAt === null || handled.current === session.id) return;
    handled.current = session.id;
    onDone();
    if (session.state === 'succeeded') {
      toast.success(t('toast.signedInAgain', { name }));
      onClose();
    }
  }, [session, onDone, onClose, name, t, toast]);

  // Closing while the CLI waits stops it, instead of leaving it waiting for nobody
  const pending = useRef<AccountLoginSession | null>(null);
  pending.current = live(session) ? session : null;
  useEffect(
    () => () => {
      if (pending.current) void api.cancelAccountLogin(pending.current.id).catch(() => undefined);
    },
    [],
  );

  return (
    <Dialog
      title={t('card.signInAgainFor', { name })}
      onClose={onClose}
      width={520}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          {t('common:actions.cancel')}
        </button>
      }
    >
      {session ? (
        <SignInSession session={session} onCode={(value) => code.mutate(value)} sending={code.isPending} error={code.error} onRetry={() => {
            code.reset();
            start.mutate();
          }} />
      ) : start.error ? (
        <ErrorBox error={start.error} title={t('dialog.startFailed')} />
      ) : (
        <div className="signin-wait" role="status">
          <Spinner />
          {t('signIn.starting')}
        </div>
      )}
    </Dialog>
  );
}
