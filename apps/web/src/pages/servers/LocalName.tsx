import { MAX_LOCAL_SERVER_NAME } from '@claudio/shared';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@claudio/ui/components/Toast';
import { Card } from '@claudio/ui/components/ui';
import { serversApi, useLocalServerName, useServersMutation } from '../../lib/api/servers';

/**
 * The form that renames this Claudio, drawn from what is saved and what is typed so a test needs no
 * queries. Saving an empty name goes back to "This server", which the placeholder shows.
 */
export function LocalNameForm({ saved, pending, onSave }: { saved: string | null; pending: boolean; onSave: (name: string | null) => void }) {
  const { t } = useTranslation(['serversPage', 'shell']);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved ?? '';
  const next = value.trim() || null;
  const changed = next !== saved;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    // The draft stays: emptied now, the field would show the old name until the hub answers
    onSave(next);
    // Save hides once the name is saved: focus goes back to the field, never to the page's body
    input.current?.focus();
  };
  return (
    // One row: the label, a field sized for 60 characters and Save, which keeps its place while it is
    // hidden (nothing to save), so typing never moves the hint under it
    <form className="server-local-name" onSubmit={submit}>
      <label className="field-label" htmlFor={id}>
        {t('serversPage:localName.label')}
      </label>
      <span className="server-local-row">
        <input ref={input} id={id} value={value} onChange={(event) => setDraft(event.target.value)} placeholder={t('shell:servers.local')} maxLength={MAX_LOCAL_SERVER_NAME} autoComplete="off" aria-describedby={`${id}-hint`} data-testid="server-local-name" />
        <button type="submit" className={`btn server-local-save${changed ? '' : ' is-idle'}`} disabled={pending} inert={!changed} aria-hidden={!changed}>
          {t('serversPage:localName.save')}
        </button>
      </span>
      <span className="field-hint" id={`${id}-hint`}>
        {t('serversPage:localName.hint')}
      </span>
    </form>
  );
}

/** This Claudio's own name, beside the card that lets another Claudio connect to it */
export function LocalNameCard() {
  const { t } = useTranslation('serversPage');
  const toast = useToast();
  const saved = useLocalServerName();
  const rename = useServersMutation((name: string | null) => serversApi.setLocalName(name));
  return (
    <Card title={t('localName.title')} className="server-local-card">
      <LocalNameForm
        saved={saved}
        pending={rename.isPending}
        onSave={(name) =>
          rename.mutate(name, {
            onSuccess: () => toast.success(t('localName.saved')),
            onError: (error) => toast.error(t('localName.failed'), error),
          })
        }
      />
    </Card>
  );
}
