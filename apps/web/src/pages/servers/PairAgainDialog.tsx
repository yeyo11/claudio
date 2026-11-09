import type { ClaudioServer } from '@claudio/shared';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@claudio/ui/components/Dialog';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox } from '@claudio/ui/components/ui';
import { serversApi, useServersMutation } from '../../lib/api/servers';
import { emptyPairing, FingerprintConfirm, mayPair, pairingOf, PairingFields, usePairingFlow, type PairingDraft } from './pairing';
import { ServerMark, ServerStatusWord } from './ServerMark';
import { localizedError } from './words';

/**
 * Pair again, in place (plan §12.2 E3): for a server whose identity changed or whose token was
 * revoked. Its id, name, colour and addresses stay; only the pairing is new. The same two ways and the
 * same certificate round trip as Add, and a line on why it is asked.
 */
export function PairAgainDialog({ server, onClose }: { server: ClaudioServer; onClose: () => void }) {
  const { t } = useTranslation('serversPage');
  const toast = useToast();
  const formId = useId();
  const group = useId();
  const [draft, setDraft] = useState<PairingDraft>(emptyPairing);
  const run = useServersMutation((pairing: Parameters<typeof serversApi.pairAgain>[1]) => serversApi.pairAgain(server.id, pairing));
  const flow = usePairingFlow(async (pairing) => {
    const result = await run.mutateAsync(pairing);
    // The earlier token could not be given back (the old machine is gone, or unreachable): said, not hidden (R8)
    if (result.previousToken.revoked) toast.success(t('pairAgain.done', { name: server.name }));
    else toast.info(t('pairAgain.doneOldKept', { name: server.name }));
  }, onClose);
  const pairing = pairingOf(draft);
  const confirming = flow.confirming;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pairing) flow.start(pairing);
  };

  return (
    <Dialog
      title={t('pairAgain.title', { name: server.name })}
      onClose={onClose}
      width={560}
      footer={
        confirming ? (
          <>
            <button type="button" className="btn" onClick={flow.back} disabled={flow.pending}>
              {t('confirm.cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={flow.confirm} disabled={flow.pending || !mayPair(confirming.fingerprint, flow.typed)} data-testid="server-confirm-pair">
              {t('confirm.pair')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              {t('confirm.cancel')}
            </button>
            <button type="submit" form={formId} className="btn btn-primary server-submit" disabled={!pairing || flow.pending} data-testid="server-pair-again-submit">
              {flow.pending ? t('add.pairing') : t('pairAgain.submit')}
            </button>
          </>
        )
      }
    >
      <form id={formId} className="stack" onSubmit={submit}>
        {confirming ? (
          <FingerprintConfirm fingerprint={confirming.fingerprint} address={confirming.address} typed={flow.typed} onTyped={flow.setTyped} />
        ) : (
          <>
            <div className="server-pair-head">
              <ServerMark server={server} size={36} />
              <div className="server-pair-who">
                <span className="server-pair-name">{server.name}</span>
                <ServerStatusWord status={server.health?.status ?? null} />
              </div>
            </div>
            <p>{t(server.health?.status === 'identity-changed' ? 'pairAgain.bodyIdentity' : server.health?.status === 'needs-pairing' ? 'pairAgain.bodyToken' : 'pairAgain.body')}</p>
            <PairingFields draft={draft} onChange={setDraft} group={group} />
          </>
        )}
        {flow.error ? <ErrorBox error={localizedError(flow.error)} title={t('pairAgain.failed', { name: server.name })} /> : null}
      </form>
    </Dialog>
  );
}
