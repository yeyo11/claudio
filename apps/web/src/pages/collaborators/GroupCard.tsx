import type { Group, GroupMember, JoinRequest } from '@claudio/shared';
import { CircleCheck, Clock, Crown, LogOut, TriangleAlert, UserMinus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MoreActions } from '@claudio/ui/components/controls/MoreActions';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { StatusDot } from '@claudio/ui/components/motion';
import { Card, Tag } from '@claudio/ui/components/ui';
import { formatDateTime, timeAgo } from '@claudio/ui/lib/format';
import { useJoinRequests } from '../../lib/api/collaborators';
import { initialOf, presenceWord, shortId, sortMembers } from './model';

export interface GroupActions {
  onRemove: (group: Group, member: GroupMember) => void;
  onMakeOwner: (group: Group, member: GroupMember) => void;
  onLeave: (group: Group) => void;
  onCreateNew: () => void;
  onAccept: (group: Group, request: JoinRequest) => void;
  onDeny: (group: Group, request: JoinRequest) => void;
}

/**
 * One group: its members with their presence, the owner's "⋯" on each other member (a sheet on a
 * phone), a member's "Leave the group", and the owner's pending join requests. A frozen group can
 * no longer change, so it offers nothing but a new group.
 */
export function GroupCard({ group, busy, actions }: { group: Group; busy: boolean; actions: GroupActions }) {
  const { t } = useTranslation('collaborators');
  const requests = useJoinRequests(group.id, group.isOwner && group.joinRequestCount > 0);
  const members = sortMembers(group.members);
  const canChange = group.isOwner && !group.frozen;

  return (
    <Card
      className="collab-group"
      title={
        <span className="collab-group-title">
          <span className="ellipsis">{group.name}</span>
          <span className="collab-count mono">{t('groups.members', { count: group.members.length })}</span>
        </span>
      }
      actions={
        !group.isOwner && (
          <MoreActions
            label={t('groups.groupActions', { name: group.name })}
            entries={[{ id: 'leave', label: t('groups.leave'), icon: LogOut, destructive: true, onSelect: () => actions.onLeave(group) }]}
          />
        )
      }
    >
      {group.frozen && (
        <div className="alert alert-warn collab-line" role="status">
          <TriangleAlert {...ICON} className="alert-icon" />
          <div className="alert-body collab-line-body">
            <span>{t('groups.frozen')}</span>
            <button type="button" className="link-btn" onClick={actions.onCreateNew}>
              {t('groups.createNew')}
            </button>
          </div>
        </div>
      )}
      {group.conflict && (
        <div className="alert alert-bad collab-line" role="alert">
          <TriangleAlert {...ICON} className="alert-icon" />
          <div className="alert-body">{t('groups.conflict', { version: group.conflict.version })}</div>
        </div>
      )}

      <ul className="collab-members">
        {members.map((member) => {
          const presence = presenceWord(member.presence);
          return (
            <li key={member.endpointId} className="collab-member" data-testid="collab-member">
              <span className="collab-avatar" aria-hidden>
                {initialOf(member.name)}
              </span>
              <span className="collab-member-names">
                <span className="collab-member-name">
                  <strong className="ellipsis">{member.name}</strong>
                  {member.role === 'owner' && (
                    <Tag tone="info" icon={Crown}>
                      {t('groups.owner')}
                    </Tag>
                  )}
                  {member.self && <Tag>{t('groups.you')}</Tag>}
                </span>
                <span className="small muted mono ellipsis" title={member.endpointId}>
                  {[member.label, shortId(member.endpointId)].filter(Boolean).join(' · ')}
                </span>
              </span>
              {presence && (
                <span className="collab-presence small">
                  <StatusDot tone={presence.tone} />
                  <span className={presence.tone === 'idle' ? 'muted' : undefined}>{t(presence.key, { ago: presence.ago ? timeAgo(presence.ago) : '' })}</span>
                </span>
              )}
              {canChange && !member.self && (
                <MoreActions
                  label={t('groups.memberActions', { name: member.name })}
                  entries={[
                    { id: 'make-owner', label: t('groups.makeOwner'), icon: Crown, onSelect: () => actions.onMakeOwner(group, member) },
                    { id: 'remove', label: t('groups.remove'), icon: UserMinus, destructive: true, onSelect: () => actions.onRemove(group, member) },
                  ]}
                />
              )}
            </li>
          );
        })}
      </ul>

      {canChange && (requests.data?.length ?? 0) > 0 && (
        <section className="collab-requests" aria-labelledby={`collab-requests-${group.id}`}>
          <h3 id={`collab-requests-${group.id}`} className="section-label">
            {t('joinRequests.title')}
          </h3>
          <ul className="collab-members">
            {(requests.data ?? []).map((request) => (
              <li key={request.from} className="collab-member collab-request" data-testid="collab-join-request">
                <span className="collab-avatar" aria-hidden>
                  {initialOf(request.name)}
                </span>
                <span className="collab-member-names">
                  <strong className="ellipsis">{request.name}</strong>
                  <span className="small muted">
                    {[request.label, request.relayedBy ? t('joinRequests.relayedBy', { name: request.relayedBy.name }) : t('joinRequests.direct')].filter(Boolean).join(' · ')}
                    {' · '}
                    <span className="mono" title={request.from}>
                      {shortId(request.from)}
                    </span>
                    {' · '}
                    <span title={formatDateTime(request.receivedAt)}>
                      <Clock {...ICON_SM} aria-hidden className="collab-inline-icon" /> {timeAgo(request.receivedAt)}
                    </span>
                  </span>
                </span>
                <span className="collab-request-actions">
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => actions.onDeny(group, request)}>
                    {t('joinRequests.deny')}
                  </button>
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => actions.onAccept(group, request)}>
                    <CircleCheck {...ICON_SM} /> {t('joinRequests.accept')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
}
