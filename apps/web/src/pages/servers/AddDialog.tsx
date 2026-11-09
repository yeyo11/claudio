import type { AddServerRequest, ClaudioServer, ServerPairing } from '@claudio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@claudio/ui/components/Dialog';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Field } from '@claudio/ui/components/ui';
import { serversApi, serversKeys } from '../../lib/api/servers';
import { addressesOf, defaultMonogram, defaultServerName, freeColor, MAX_SERVER_NAME, newDraft, type AddressDraft } from '../../lib/servers-model';
import { AddressesEditor, ColourPicker } from './AddressesEditor';
import { emptyPairing, FingerprintConfirm, mayPair, pairingOf, PairingFields, usePairingFlow, type PairingDraft } from './pairing';
import { ServerMark } from './ServerMark';
import { localizedError } from './words';

export interface AddFormState {
  drafts: AddressDraft[];
  pairing: PairingDraft;
  /** Typed by the person; until then the name follows the first address */
  name: string | null;
  colour: string;
  monogram: string | null;
}

/** What the name is: the person's, else the first address's host */
export const nameOf = (state: Pick<AddFormState, 'drafts' | 'name'>): string => state.name ?? defaultServerName(addressesOf(state.drafts).addresses[0]?.url ?? '');
export const monogramOf = (state: Pick<AddFormState, 'drafts' | 'name' | 'monogram'>): string => state.monogram ?? defaultMonogram(nameOf(state));

/**
 * What `POST /servers` is sent. Initials nobody typed are not stored, so they follow the name when
 * it is renamed later instead of keeping the letters of the address it was first given.
 */
export const addRequestOf = (state: AddFormState, pairing: ServerPairing): AddServerRequest => ({
  name: nameOf(state).trim(),
  color: state.colour,
  monogram: state.monogram?.trim() || null,
  addresses: addressesOf(state.drafts).addresses,
  pairing,
});

/** The fields of the dialog, drawn from the state so a test reads every default without a server */
export function AddServerForm({ state, onChange, invalid = [], group }: { state: AddFormState; onChange: (next: AddFormState) => void; invalid?: readonly number[]; group: string }) {
  const { t } = useTranslation('serversPage');
  const name = nameOf(state);
  const monogram = monogramOf(state);
  return (
    <div className="stack" data-testid="server-add-form">
      <PairingFields draft={state.pairing} onChange={(pairing) => onChange({ ...state, pairing })} group={group} />
      <div className="field">
        <span className="field-label">{t('add.addresses')}</span>
        <AddressesEditor drafts={state.drafts} onChange={(drafts) => onChange({ ...state, drafts })} invalid={invalid} />
        <span className="field-hint">{t('add.addressesHint')}</span>
      </div>
      <div className="server-identity">
        <ServerMark server={{ name, color: state.colour, monogram }} size={44} />
        <Field label={t('add.name')} hint={t('add.nameHint')}>
          <input value={name} onChange={(e) => onChange({ ...state, name: e.target.value })} maxLength={MAX_SERVER_NAME} autoComplete="off" data-testid="server-name" />
        </Field>
        <Field label={t('add.monogram')}>
          <input className="server-monogram-input" value={monogram} onChange={(e) => onChange({ ...state, monogram: e.target.value ? e.target.value.slice(0, 2).toUpperCase() : null })} maxLength={2} autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <div className="field">
        <span className="field-label">{t('add.colour')}</span>
        <ColourPicker value={state.colour} letters={monogram} onChange={(colour) => onChange({ ...state, colour })} />
      </div>
    </div>
  );
}

/**
 * Add a server (plan §12.1): the code or the owner token, the addresses, and its name, colour and
 * initials with defaults. A pasted token goes through D13's round trip: the first call is answered
 * with the certificate the address shows, which this dialog puts in front of the person, and only
 * their yes sends the token.
 */
export function AddServerDialog({ servers, onClose, onAdded }: { servers: readonly ClaudioServer[]; onClose: () => void; onAdded: (server: ClaudioServer) => void }) {
  const { t } = useTranslation('serversPage');
  const toast = useToast();
  const queryClient = useQueryClient();
  const formId = useId();
  const group = useId();
  const initialColour = useMemo(() => freeColor(servers), [servers]);
  const [state, setState] = useState<AddFormState>(() => ({ drafts: [newDraft()], pairing: emptyPairing, name: null, colour: initialColour, monogram: null }));
  const [invalid, setInvalid] = useState<number[]>([]);
  const parsed = addressesOf(state.drafts);
  const pairing = pairingOf(state.pairing);
  const name = nameOf(state).trim();

  const flow = usePairingFlow(
    async (chosen) => {
      const added = await serversApi.add(addRequestOf(state, chosen));
      void queryClient.invalidateQueries({ queryKey: serversKeys.all });
      toast.success(t('toast.added', { name: added.name }));
      onAdded(added);
    },
    onClose,
  );

  const ready = parsed.addresses.length > 0 && name.length > 0 && pairing !== null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setInvalid(parsed.invalid);
    if (parsed.invalid.length > 0 || !ready || !pairing) return;
    flow.start(pairing);
  };

  const confirming = flow.confirming;
  return (
    <Dialog
      title={t('add.title')}
      onClose={onClose}
      width={620}
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
            <button type="submit" form={formId} className="btn btn-primary server-submit" disabled={!ready || flow.pending} data-testid="server-add-submit">
              {flow.pending ? t('add.pairing') : t('add.submit')}
            </button>
          </>
        )
      }
    >
      <form id={formId} className="stack" onSubmit={submit}>
        {confirming ? (
          <FingerprintConfirm fingerprint={confirming.fingerprint} address={confirming.address} typed={flow.typed} onTyped={flow.setTyped} />
        ) : (
          <AddServerForm state={state} onChange={setState} invalid={invalid} group={group} />
        )}
        {flow.error ? <ErrorBox error={localizedError(flow.error)} title={t('add.failed')} /> : null}
      </form>
    </Dialog>
  );
}
