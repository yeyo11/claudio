import type { ClaudioServer } from '@claudio/shared';
import { useState, type FormEvent, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@claudio/ui/components/Dialog';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Field } from '@claudio/ui/components/ui';
import { serversApi, useServersMutation } from '../../lib/api/servers';
import { addressesOf, defaultMonogram, draftsOf, MAX_SERVER_NAME, sameAddresses, type AddressDraft } from '../../lib/servers-model';
import { AddressesEditor, ColourPicker } from './AddressesEditor';
import { ServerMark } from './ServerMark';

export interface EditState {
  name: string;
  colour: string | null;
  monogram: string;
  drafts: AddressDraft[];
}

export const editStateOf = (server: ClaudioServer): EditState => ({
  name: server.name,
  colour: server.color,
  monogram: server.monogram ?? defaultMonogram(server.name),
  drafts: draftsOf(server.addresses),
});

/** Only what changed, so an edit of the name never makes the server prove its addresses again */
export function changesOf(server: ClaudioServer, state: EditState) {
  const { addresses } = addressesOf(state.drafts);
  const monogram = state.monogram.trim();
  return {
    ...(state.name.trim() !== server.name ? { name: state.name.trim() } : {}),
    ...(state.colour !== server.color ? { color: state.colour } : {}),
    ...(monogram !== (server.monogram ?? defaultMonogram(server.name)) ? { monogram: monogram || null } : {}),
    ...(!sameAddresses(addresses, server.addresses) ? { addresses } : {}),
  };
}

/** The fields of Edit, drawn from the state */
export function EditServerForm({ state, onChange, invalid = [], addressesChanged }: { state: EditState; onChange: (next: EditState) => void; invalid?: readonly number[]; addressesChanged: boolean }) {
  const { t } = useTranslation('serversPage');
  return (
    <div className="stack" data-testid="server-edit-form">
      <div className="server-identity">
        <ServerMark server={{ name: state.name, color: state.colour, monogram: state.monogram }} size={44} />
        <Field label={t('add.name')}>
          <input value={state.name} onChange={(e) => onChange({ ...state, name: e.target.value })} maxLength={MAX_SERVER_NAME} autoComplete="off" required data-autofocus data-testid="server-name" />
        </Field>
        <Field label={t('add.monogram')}>
          <input className="server-monogram-input" value={state.monogram} onChange={(e) => onChange({ ...state, monogram: e.target.value.slice(0, 2).toUpperCase() })} maxLength={2} autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <div className="field">
        <span className="field-label">{t('add.colour')}</span>
        <ColourPicker value={state.colour} onChange={(colour) => onChange({ ...state, colour })} />
      </div>
      <div className="field">
        <span className="field-label">{t('add.addresses')}</span>
        <AddressesEditor drafts={state.drafts} onChange={(drafts) => onChange({ ...state, drafts })} invalid={invalid} />
        <span className="field-hint">{addressesChanged ? t('edit.newAddressNote') : t('add.addressesHint')}</span>
      </div>
    </div>
  );
}

/** Edit a server: name, colour, initials and its addresses (add, remove, reorder, kind) */
export function EditServerDialog({ server, onClose }: { server: ClaudioServer; onClose: () => void }) {
  const { t } = useTranslation('serversPage');
  const toast = useToast();
  const formId = useId();
  const [state, setState] = useState<EditState>(() => editStateOf(server));
  const [invalid, setInvalid] = useState<number[]>([]);
  const save = useServersMutation((body: ReturnType<typeof changesOf>) => serversApi.update(server.id, body));
  const changes = changesOf(server, state);
  const dirty = Object.keys(changes).length > 0;
  const parsed = addressesOf(state.drafts);
  const ready = dirty && state.name.trim().length > 0 && parsed.addresses.length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setInvalid(parsed.invalid);
    if (parsed.invalid.length > 0 || !ready) return;
    save.mutate(changes, {
      onSuccess: () => {
        toast.success(t('edit.saved', { name: state.name.trim() }));
        onClose();
      },
    });
  };

  return (
    <Dialog
      title={t('edit.title', { name: server.name })}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('confirm.cancel')}
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={!ready || save.isPending} data-testid="server-edit-save">
            {save.isPending ? t('edit.saving') : t('edit.save')}
          </button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit}>
        <EditServerForm state={state} onChange={setState} invalid={invalid} addressesChanged={'addresses' in changes} />
        {save.error ? <ErrorBox error={save.error} title={t('edit.failed', { name: server.name })} /> : null}
      </form>
    </Dialog>
  );
}
