import type { CollaboratorsStatus, Group, UpdateCollaboratorsRequest } from '@claudio/shared';
import { CircleCheck, CloudOff, Loader, Pencil, Radio, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Card, CopyButton, Field } from '@claudio/ui/components/ui';
import { connectionWord, initialOf, shortId, type CollabTone, type ConnectionKey } from './model';

const CONNECTION_ICON: Record<ConnectionKey, LucideIcon> = {
  'connection.online': CircleCheck,
  'connection.relay': Radio,
  'connection.starting': Loader,
  'connection.noRelay': TriangleAlert,
  'connection.offline': WifiOff,
  'connection.off': CloudOff,
};

/** A word in its tone, with the icon that says it without the colour. */
export function ToneText({ tone, icon: Icon, children }: { tone: CollabTone; icon?: LucideIcon; children: string }) {
  return (
    <span className={`collab-tone tone-${tone}`}>
      {Icon && <Icon {...ICON_SM} aria-hidden />}
      <span>{children}</span>
    </span>
  );
}

/**
 * This install as teammates see it: the display name and label (editable), the endpoint id, and the
 * connection in plain words, with who runs discovery and relays under it.
 */
export function YouCard({
  status,
  groups,
  busy,
  onSave,
  onTurnOff,
}: {
  status: CollaboratorsStatus;
  groups: readonly Group[];
  busy: boolean;
  onSave: (changes: UpdateCollaboratorsRequest) => Promise<boolean>;
  onTurnOff: () => void;
}) {
  const { t } = useTranslation('collaborators');
  const { settings, endpointId } = status;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(settings.displayName);
  const [label, setLabel] = useState(settings.label);
  const [relay, setRelay] = useState(settings.relayUrl ?? '');
  const connection = connectionWord(status, groups);

  const startEditing = () => {
    setName(settings.displayName);
    setLabel(settings.label);
    setRelay(settings.relayUrl ?? '');
    setEditing(true);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const changes: UpdateCollaboratorsRequest = {};
    if (name.trim() !== settings.displayName) changes.displayName = name.trim();
    if (label.trim() !== settings.label) changes.label = label.trim();
    const relayUrl = relay.trim() || null;
    if (relayUrl !== settings.relayUrl) changes.relayUrl = relayUrl;
    if (Object.keys(changes).length === 0) {
      setEditing(false);
      return;
    }
    void onSave(changes).then((saved) => saved && setEditing(false));
  };

  return (
    <Card
      className="collab-you"
      title={t('you.title')}
      actions={
        !editing && (
          <div className="collab-card-actions">
            <button type="button" className="btn btn-small" onClick={startEditing}>
              <Pencil {...ICON_SM} /> {t('you.edit')}
            </button>
            <button type="button" className="btn btn-small" onClick={onTurnOff} disabled={busy} data-testid="collab-turn-off">
              {t('you.turnOff')}
            </button>
          </div>
        )
      }
    >
      {editing ? (
        <form className="collab-you-form" onSubmit={submit}>
          <Field label={t('you.name')} hint={t('you.nameHint')}>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="name" data-autofocus />
          </Field>
          <Field label={t('you.label')} hint={t('you.labelHint')}>
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} />
          </Field>
          <Field label={t('you.relay')} hint={t('you.relayHint')}>
            <input className="mono" value={relay} onChange={(e) => setRelay(e.target.value)} type="url" inputMode="url" placeholder="https://" spellCheck={false} />
          </Field>
          <div className="collab-form-actions">
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              {t('you.cancel')}
            </button>
            <button type="submit" className="btn" disabled={busy || !name.trim()}>
              {t('you.save')}
            </button>
          </div>
        </form>
      ) : (
        <div className="collab-you-body">
          <div className="collab-you-who">
            <span className="collab-avatar" aria-hidden>
              {initialOf(settings.displayName)}
            </span>
            <div className="collab-you-names">
              <strong className="ellipsis">{settings.displayName}</strong>
              <span className="small muted ellipsis">{settings.label || t('you.noLabel')}</span>
            </div>
          </div>
          {endpointId && (
            <div className="collab-endpoint">
              <span className="section-label">{t('you.endpoint')}</span>
              <span className="collab-endpoint-id">
                <span className="mono small" title={endpointId}>
                  {shortId(endpointId)}
                </span>
                <CopyButton text={endpointId} label={t('you.copyEndpoint')} />
              </span>
            </div>
          )}
          <div className="collab-connection" data-testid="collab-connection">
            <ToneText tone={connection.tone} icon={CONNECTION_ICON[connection.key]}>
              {t(connection.key)}
            </ToneText>
            <span className="small muted">
              {settings.relayUrl ? (
                <>
                  {t('you.byN0Relay')} <span className="mono">{settings.relayUrl}</span>
                </>
              ) : (
                t('you.byN0')
              )}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
