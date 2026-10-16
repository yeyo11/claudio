import type { Group, GroupInvite, JoinGroupResult, PendingJoin, Project, SharedProject } from '@claudio/shared';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@claudio/ui/components/controls/Select';
import { Dialog } from '@claudio/ui/components/Dialog';
import { ICON } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { CopyButton, ErrorBox, Field } from '@claudio/ui/components/ui';
import { formatDateTime } from '@claudio/ui/lib/format';
import { MAX_QR_VERSION } from '@claudio/ui/lib/qr';
import { QrCode } from '../../components/QrCode';
import { collaboratorsApi, useCollaboratorsMutation } from '../../lib/api/collaborators';

/**
 * What an invite shows once made: the text and its QR code, the expiry, the owner's presence rule
 * and the standing warning of a single signer (§3.3). Rendered on its own so it is tested without
 * making one.
 */
export function InviteView({ invite }: { invite: GroupInvite }) {
  const { t } = useTranslation('collaborators');
  return (
    <div className="collab-invite" data-testid="collab-invite">
      <div className="collab-invite-code">
        <QrCode text={invite.text} label={t('invite.qr', { group: invite.groupName })} maxVersion={MAX_QR_VERSION} />
      </div>
      <div className="collab-invite-text">
        <span className="section-label">{t('invite.text')}</span>
        <div className="collab-invite-copy">
          <textarea className="mono collab-invite-area" value={invite.text} readOnly rows={4} spellCheck={false} aria-label={t('invite.text')} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton text={invite.text} label={t('invite.copy')} shown />
        </div>
        <span className="small muted">{t('invite.expires', { when: formatDateTime(invite.expiresAt) })}</span>
        <span className="small">{t('invite.presence')}</span>
      </div>
      <div className="alert alert-warn collab-invite-warn" role="note">
        <TriangleAlert {...ICON} className="alert-icon" />
        <div className="alert-body">{t('invite.standing')}</div>
      </div>
    </div>
  );
}

/**
 * Invite to one of the groups this install owns. With one group the invite is made as the dialog
 * opens; with several it asks which first, so no secret is made for a group nobody chose.
 */
export function InviteDialog({ groups, onClose }: { groups: readonly Group[]; onClose: () => void }) {
  const { t } = useTranslation('collaborators');
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '');
  const make = useCollaboratorsMutation((id: string) => collaboratorsApi.invite(id));
  const single = groups.length === 1;
  const asked = useRef(false);
  useEffect(() => {
    if (!single || asked.current || !groupId) return;
    asked.current = true;
    make.mutate(groupId);
  }, [single, groupId, make]);
  const group = groups.find((g) => g.id === groupId);
  const invite = make.data?.groupId === groupId ? make.data : null;

  return (
    <Dialog
      title={t('invite.title', { group: group?.name ?? '' })}
      onClose={onClose}
      width={620}
      footer={
        !single &&
        !invite && (
          <button type="button" className="btn" disabled={!groupId || make.isPending} onClick={() => make.mutate(groupId)} data-testid="collab-make-invite">
            {t('invite.make')}
          </button>
        )
      }
    >
      <div className="stack">
        {!single && (
          <Field label={t('invite.group')}>
            <Select value={groupId} onChange={setGroupId} options={groups.map((g) => ({ value: g.id, label: g.name }))} aria-label={t('invite.group')} />
          </Field>
        )}
        {make.error ? <ErrorBox error={make.error} title={t('toast.inviteFailed')} /> : null}
        {invite && <InviteView invite={invite} />}
      </div>
    </Dialog>
  );
}

/** The words of a join that has to wait: who holds the request until the owner is back. */
export function JoinWaiting({ pending }: { pending: PendingJoin }) {
  const { t } = useTranslation('collaborators');
  return (
    <p className="collab-join-waiting" role="status">
      {pending.relayedBy ? t('pending.waiting', { owner: pending.owner.name, member: pending.relayedBy.name }) : t('pending.connecting', { owner: pending.owner.name })}
    </p>
  );
}

/** Paste an invite. The owner answers at once, or a member keeps the request until the owner is back. */
export function JoinDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('collaborators');
  const toast = useToast();
  const formId = useId();
  const [text, setText] = useState('');
  const join = useCollaboratorsMutation((invite: string) => collaboratorsApi.join(invite));
  const cancel = useCollaboratorsMutation((groupId: string) => collaboratorsApi.cancelJoin(groupId));
  const result: JoinGroupResult | undefined = join.data;
  const pending = result?.state === 'pending' ? result.pending : null;

  useEffect(() => {
    if (result?.state !== 'joined') return;
    toast.success(t('join.joined', { group: result.group.name }));
    onClose();
  }, [result, toast, t, onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) join.mutate(text.trim());
  };

  return (
    <Dialog
      title={t('join.title')}
      onClose={onClose}
      width={560}
      footer={
        pending ? (
          <>
            <button
              type="button"
              className="btn"
              disabled={cancel.isPending}
              onClick={() =>
                cancel.mutate(pending.groupId, {
                  onSuccess: () => {
                    toast.success(t('toast.cancelled'));
                    onClose();
                  },
                  onError: (err) => toast.error(t('toast.cancelFailed'), err),
                })
              }
            >
              {t('pending.cancel')}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              {t('you.cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              {t('you.cancel')}
            </button>
            <button type="submit" form={formId} className="btn" disabled={!text.trim() || join.isPending} data-testid="collab-join-submit">
              {t('join.submit')}
            </button>
          </>
        )
      }
    >
      {pending ? (
        <JoinWaiting pending={pending} />
      ) : (
        <form id={formId} className="stack" onSubmit={submit}>
          <Field label={t('join.paste')} hint={t('join.pasteHint')}>
            <textarea className="mono collab-invite-area" value={text} onChange={(e) => setText(e.target.value)} rows={5} spellCheck={false} required data-autofocus data-testid="collab-join-invite" />
          </Field>
          {join.isPending && (
            <p className="small muted" role="status">
              {t('join.connecting')}
            </p>
          )}
          {join.error ? <ErrorBox error={join.error} title={t('toast.joinFailed')} /> : null}
        </form>
      )}
    </Dialog>
  );
}

/** A new group, with this install as its owner. */
export function CreateGroupDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('collaborators');
  const toast = useToast();
  const formId = useId();
  const [name, setName] = useState('');
  const create = useCollaboratorsMutation((groupName: string) => collaboratorsApi.createGroup({ name: groupName }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const groupName = name.trim();
    if (!groupName) return;
    create.mutate(groupName, {
      onSuccess: (group) => {
        toast.success(t('create.created', { group: group.name }));
        onClose();
      },
    });
  };
  return (
    <Dialog
      title={t('create.title')}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('you.cancel')}
          </button>
          <button type="submit" form={formId} className="btn" disabled={!name.trim() || create.isPending} data-testid="collab-create-submit">
            {t('create.submit')}
          </button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit}>
        <Field label={t('create.name')} hint={t('create.hint')}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('create.namePlaceholder')} maxLength={80} required data-autofocus data-testid="collab-group-name" />
        </Field>
        {create.error ? <ErrorBox error={create.error} title={t('toast.createFailed')} /> : null}
      </form>
    </Dialog>
  );
}

/** Pairs a shared project the key did not match with a local one, so it shows in that project's Shared tab. */
export function LinkDialog({ project, projects, onClose }: { project: SharedProject; projects: readonly Project[]; onClose: () => void }) {
  const { t } = useTranslation('collaborators');
  const toast = useToast();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const link = useCollaboratorsMutation((id: string) => collaboratorsApi.link({ owner: project.owner, shareId: project.shareId }, id));
  const chosen = projects.find((p) => p.id === projectId);
  return (
    <Dialog
      title={t('sharedWithYou.linkTitle', { project: project.name })}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('you.cancel')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!projectId || link.isPending}
            onClick={() =>
              link.mutate(projectId, {
                onSuccess: () => {
                  toast.success(t('toast.linked', { project: chosen?.name ?? projectId }));
                  onClose();
                },
              })
            }
          >
            {t('sharedWithYou.linkSubmit')}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">{t('sharedWithYou.linkHint')}</p>
        <Field label={t('sharedWithYou.linkProject')}>
          <Select value={projectId} onChange={setProjectId} options={projects.map((p) => ({ value: p.id, label: p.name, hint: p.path }))} aria-label={t('sharedWithYou.linkProject')} />
        </Field>
        {link.error ? <ErrorBox error={link.error} title={t('toast.linkFailed')} /> : null}
      </div>
    </Dialog>
  );
}
