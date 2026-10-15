import type { SetupTool } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { READINESS_KEYS } from '../../lib/setup';

/**
 * Sign out of a tool, after asking: it is destructive (the tool stops working for Claudio until
 * someone signs in again), so the confirmation is the danger one. A code host signs out of one host.
 * The vendor's own command does it where there is one (`DELETE /setup/credentials/:tool`).
 */
export function SignOutButton({ tool, label, host, small = false, keyOnly = false }: { tool: SetupTool; label: string; host?: string; small?: boolean; keyOnly?: boolean }) {
  const { t } = useTranslation('setup');
  const confirm = useConfirm();
  const toast = useToast();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: () => api.signOut(tool, host),
    onSuccess: (result) => {
      for (const key of READINESS_KEYS) void queryClient.invalidateQueries({ queryKey: key });
      if (result.signedOut) toast.success(t('signOut.done', { label }));
      else if (result.reason === 'unsupported') toast.error(t('signOut.failed', { label }), new Error(t('signOut.unsupported', { label })));
      else toast.error(t('signOut.failed', { label }), new Error(result.reason ?? ''));
    },
    onError: (err) => toast.error(t('signOut.failed', { label }), err),
  });

  const ask = async () => {
    const ok = await confirm({
      title: t('signOut.title', { label: host ?? label }),
      // A sign-out that only forgets the kept key says so: the tool may go on working on its own sign-in
      body: host ? t('signOut.bodyHost', { cli: tool, host }) : keyOnly ? t('signOut.bodyKey', { label }) : t('signOut.body', { label }),
      confirmLabel: t('signOut.action'),
      danger: true,
    });
    if (ok) signOut.mutate();
  };

  return (
    <button
      type="button"
      className={`btn prov-quiet${small ? ' btn-small' : ''}`}
      data-action="sign-out"
      aria-label={t('signOut.aria', { label: host ?? label })}
      disabled={signOut.isPending}
      onClick={() => void ask()}
    >
      {signOut.isPending && <Spinner />}
      {t('signOut.action')}
    </button>
  );
}
