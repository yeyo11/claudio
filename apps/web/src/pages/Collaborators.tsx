import type { CollaboratorsStatus, Group, GroupList, GroupMember, JoinRequest, PendingJoin, Project, SharedProject, UpdateCollaboratorsRequest } from '@claudio/shared';
import { FolderPlus, LogIn, Plus, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjects } from '../api';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, Empty, ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { PageHeader } from '../components/PageHeader';
import { collaboratorsApi, useCollaboratorGroups, useCollaboratorsMutation, useCollaboratorsStatus, useSharedProjects } from '../lib/api/collaborators';
import { settleJoinRequests } from '../lib/notifications';
import { localized } from '../lib/server-strings';
import { CreateGroupDialog, InviteDialog, JoinDialog, LinkDialog } from './collaborators/dialogs';
import { GroupCard, type GroupActions } from './collaborators/GroupCard';
import { ownedGroups, pageState } from './collaborators/model';
import { PendingJoinRow, SharedWithYou } from './collaborators/SharedWithYou';
import { YouCard } from './collaborators/YouCard';

type Open = { kind: 'invite' } | { kind: 'join' } | { kind: 'create' } | { kind: 'link'; project: SharedProject } | null;

/**
 * Collaborators (docs/plans/collaborators.md §5.1): teammates' Claudios share projects read only,
 * peer to peer. Off until the person turns it on; greyed out with its reason where the native
 * module cannot load. The page's one gradient is Turn on while off, and Invite while on.
 */
export function Collaborators() {
  const { t } = useTranslation('collaborators');
  const status = useCollaboratorsStatus();
  const on = status.data ? pageState(status.data) === 'on' : false;
  const groups = useCollaboratorGroups(on);
  const shared = useSharedProjects(on);
  const projects = useProjects(false);
  const update = useCollaboratorsMutation((body: UpdateCollaboratorsRequest) => collaboratorsApi.update(body));
  const toast = useToast();

  // A request answered from another device while this page was closed clears its notification here
  useEffect(() => {
    if (!groups.data) return;
    const holding = new Set(groups.data.groups.filter((g) => g.isOwner && g.joinRequestCount > 0).map((g) => g.id));
    settleJoinRequests((groupId) => holding.has(groupId), groups.dataUpdatedAt);
  }, [groups.data, groups.dataUpdatedAt]);

  if (status.isLoading) return <Skeleton rows={6} height={20} />;
  if (status.error) return <ErrorBox error={status.error} />;
  if (!status.data) return null;

  const turnOn = () =>
    update.mutate({ enabled: true }, { onSuccess: () => toast.success(t('toast.on')), onError: (err) => toast.error(t('toast.onFailed'), err) });

  return (
    <CollaboratorsView
      status={status.data}
      groups={groups.data}
      groupsError={groups.error}
      shared={shared.data}
      projects={projects.data ?? []}
      busy={update.isPending}
      onTurnOn={turnOn}
      onUpdate={(changes) =>
        update.mutateAsync(changes).then(
          () => {
            toast.success(changes.enabled === false ? t('toast.off') : t('toast.saved'));
            return true;
          },
          (err: unknown) => {
            toast.error(changes.enabled === false ? t('toast.offFailed') : t('toast.saveFailed'), err);
            return false;
          },
        )
      }
    />
  );
}

/** The page from its data, so every state renders in a test without a server. */
export function CollaboratorsView({
  status,
  groups,
  groupsError,
  shared,
  projects,
  busy,
  onTurnOn,
  onUpdate,
}: {
  status: CollaboratorsStatus;
  groups: GroupList | undefined;
  groupsError?: unknown;
  shared: SharedProject[] | undefined;
  projects: readonly Project[];
  busy: boolean;
  onTurnOn: () => void;
  onUpdate: (changes: UpdateCollaboratorsRequest) => Promise<boolean>;
}) {
  const { t } = useTranslation('collaborators');
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState<Open>(null);
  // A dialog refocuses whenever its onClose changes, so it gets the same function every render
  const close = useCallback(() => setOpen(null), []);
  const act = useCollaboratorsMutation((fn: () => Promise<unknown>) => fn());
  const state = pageState(status);

  const run = (done: string, failed: string, fn: () => Promise<unknown>) =>
    act.mutate(fn, { onSuccess: () => toast.success(done), onError: (err) => toast.error(failed, err) });

  if (state === 'unavailable' && status.unavailable) {
    return (
      <div className="stack collab-page">
        <PageHeader title={t('page.title')} />
        <Empty illustration="collaborators" tone="warn" title={t(`unavailable.${status.unavailable.code}`)}>
          <span className="collab-empty-text">
            {localized(status.unavailable.reason)} {t('unavailable.body')}
          </span>
        </Empty>
      </div>
    );
  }

  if (state === 'off') {
    return (
      <div className="stack collab-page">
        <PageHeader title={t('page.title')} />
        <Empty
          illustration="collaborators"
          size="lg"
          title={t('off.title')}
          action={
            <button type="button" className="btn btn-primary" onClick={onTurnOn} disabled={busy} data-testid="collab-turn-on">
              {t('off.turnOn')}
            </button>
          }
        >
          <span className="collab-empty-text">{t('off.body')}</span>
        </Empty>
      </div>
    );
  }

  const list = groups?.groups ?? [];
  const pendingJoins = groups?.pendingJoins ?? [];
  const owned = ownedGroups(list);

  const groupActions: GroupActions = {
    onRemove: (group: Group, member: GroupMember) => {
      void confirm({
        title: t('groups.removeTitle', { name: member.name, group: group.name }),
        body: (
          <>
            <p className="collab-confirm-warn">{t('groups.removeWarn', { name: member.name })}</p>
            <p>{t('groups.removeBody')}</p>
          </>
        ),
        confirmLabel: t('groups.remove'),
        danger: true,
      }).then((ok) => {
        if (ok) run(t('toast.removed', { name: member.name }), t('toast.removeFailed', { name: member.name }), () => collaboratorsApi.removeMember(group.id, member.endpointId));
      });
    },
    onMakeOwner: (group: Group, member: GroupMember) => {
      void confirm({
        title: t('groups.makeOwnerTitle', { name: member.name, group: group.name }),
        body: t('groups.makeOwnerBody', { name: member.name }),
        confirmLabel: t('groups.makeOwner'),
      }).then((ok) => {
        if (ok) run(t('toast.transferred', { name: member.name }), t('toast.transferFailed'), () => collaboratorsApi.transferOwnership(group.id, member.endpointId));
      });
    },
    onLeave: (group: Group) => {
      void confirm({ title: t('groups.leaveTitle', { group: group.name }), body: t('groups.leaveBody'), confirmLabel: t('groups.leave'), danger: true }).then((ok) => {
        if (ok) run(t('toast.left', { group: group.name }), t('toast.leaveFailed', { group: group.name }), () => collaboratorsApi.leaveGroup(group.id));
      });
    },
    onCreateNew: () => setOpen({ kind: 'create' }),
    onAccept: (group: Group, request: JoinRequest) =>
      run(t('toast.accepted', { name: request.name }), t('toast.acceptFailed', { name: request.name }), () => collaboratorsApi.acceptJoin(group.id, request.from)),
    onDeny: (group: Group, request: JoinRequest) =>
      run(t('toast.denied', { name: request.name }), t('toast.denyFailed', { name: request.name }), () => collaboratorsApi.denyJoin(group.id, request.from)),
  };
  const cancelJoin = (pending: PendingJoin) => run(t('toast.cancelled'), t('toast.cancelFailed'), () => collaboratorsApi.cancelJoin(pending.groupId));
  const unlink = (project: SharedProject) =>
    run(t('toast.unlinked'), t('toast.unlinkFailed'), () => collaboratorsApi.unlink({ owner: project.owner, shareId: project.shareId }));
  const working = busy || act.isPending;

  const subtitle = [t('page.groupCount', { count: list.length }), shared ? t('page.sharedCount', { count: shared.length }) : null].filter(Boolean).join(' · ');

  return (
    <div className="stack collab-page">
      <PageHeader
        title={t('page.title')}
        subtitle={subtitle}
        actions={
          <button type="button" className="btn btn-primary" disabled={owned.length === 0} onClick={() => setOpen({ kind: 'invite' })} data-testid="collab-invite">
            <UserPlus {...ICON_SM} /> {t('actions.invite')}
          </button>
        }
      />

      <YouCard status={status} groups={list} busy={working} onSave={onUpdate} onTurnOff={() => void onUpdate({ enabled: false })} />

      <section className="collab-groups" aria-labelledby="collab-groups-title">
        <div className="collab-section-head">
          <h2 id="collab-groups-title" className="section-label">
            {t('groups.title')}
          </h2>
          <div className="collab-section-actions">
            <button type="button" className="btn btn-small" onClick={() => setOpen({ kind: 'join' })} data-testid="collab-join">
              <LogIn {...ICON_SM} /> {t('actions.join')}
            </button>
            <button type="button" className="btn btn-small" onClick={() => setOpen({ kind: 'create' })} data-testid="collab-create">
              <Plus {...ICON_SM} /> {t('actions.create')}
            </button>
          </div>
        </div>
        {groupsError ? <ErrorBox error={groupsError} /> : null}
        {pendingJoins.length > 0 && (
          <Card className="collab-pending-card">
            <ul className="collab-pendings">
              {pendingJoins.map((pending) => (
                <PendingJoinRow key={pending.groupId} pending={pending} busy={working} onCancel={cancelJoin} />
              ))}
            </ul>
          </Card>
        )}
        {groups && list.length === 0 && pendingJoins.length === 0 ? (
          <Card className="collab-groups-empty">
            <Empty icon={FolderPlus} title={t('groups.none')}>
              {t('groups.noneHint')}
            </Empty>
          </Card>
        ) : (
          list.map((group) => <GroupCard key={group.id} group={group} busy={working} actions={groupActions} />)
        )}
        {!groups && !groupsError && <Skeleton rows={3} height={18} />}
      </section>

      {shared ? (
        <SharedWithYou shared={shared} projects={projects} busy={working} onLink={(project) => setOpen({ kind: 'link', project })} onUnlink={unlink} />
      ) : (
        <Skeleton rows={3} height={18} />
      )}

      {open?.kind === 'invite' && <InviteDialog groups={owned} onClose={close} />}
      {open?.kind === 'join' && <JoinDialog onClose={close} />}
      {open?.kind === 'create' && <CreateGroupDialog onClose={close} />}
      {open?.kind === 'link' && <LinkDialog project={open.project} projects={projects} onClose={close} />}
    </div>
  );
}
