import { MAX_LOCAL_SERVER_NAME } from '@claudio/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, Field } from '@claudio/ui/components/ui';
import { serversApi, useLocalServerName, useServersMutation } from '../../lib/api/servers';

/**
 * The form that renames this Claudio, drawn from what is saved and what is typed so a test needs no
 * queries. Saving an empty name goes back to "This server", which the placeholder shows.
 */
export function LocalNameForm({ saved, pending, onSave }: { saved: string | null; pending: boolean; onSave: (name: string | null) => void }) {
  const { t } = useTranslation(['serversPage', 'shell']);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved ?? '';
  const next = value.trim() || null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (next === saved) return;
    onSave(next);
    setDraft(null);
  };
  return (
    <form className="server-local-name" onSubmit={submit}>
      <Field label={t('serversPage:localName.label')} hint={t('serversPage:localName.hint')}>
        <input value={value} onChange={(event) => setDraft(event.target.value)} placeholder={t('shell:servers.local')} maxLength={MAX_LOCAL_SERVER_NAME} autoComplete="off" data-testid="server-local-name" />
      </Field>
      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending || next === saved}>
          {t('serversPage:localName.save')}
        </button>
      </div>
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
