import type { PendingJoin, Project, SharedProject } from '@claudio/shared';
import { ArrowRight, CircleCheck, CircleSlash, Link2, Moon, TriangleAlert, Unlink, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Card, Empty } from '@claudio/ui/components/ui';
import { formatDateTime, timeAgo } from '@claudio/ui/lib/format';
import { localized } from '../../lib/server-strings';
import { PendingWords } from './dialogs';
import { byPerson, kindCounts, localProjectOf, sharedProjectPath, sharedTabPath, syncWord, type SyncKey } from './model';
import { ToneText } from './YouCard';

const SYNC_ICON: Partial<Record<SyncKey, LucideIcon>> = {
  'sync.live': CircleCheck,
  'sync.offline': Moon,
  'sync.offlineNever': Moon,
};

/** A copy's sync state in plain words. No live rail: syncing is not an agent working (§5.1). */
export function SyncLine({ project }: { project: SharedProject }) {
  const { t } = useTranslation('collaborators');
  const word = syncWord(project.sync);
  return (
    <span className="collab-sync small" title={project.sync.lastSyncedAt ? formatDateTime(project.sync.lastSyncedAt) : undefined}>
      <ToneText tone={word.tone} icon={SYNC_ICON[word.key]}>
        {t(word.key, { ago: word.ago ? timeAgo(word.ago) : '' })}
      </ToneText>
      {project.sync.error && (
        <ToneText tone="bad" icon={TriangleAlert}>
          {t('sync.failed', { reason: localized(project.sync.error) })}
        </ToneText>
      )}
    </span>
  );
}

function SharedRow({
  project,
  projects,
  busy,
  onLink,
  onUnlink,
}: {
  project: SharedProject;
  projects: readonly Project[];
  busy: boolean;
  onLink: (project: SharedProject) => void;
  onUnlink: (project: SharedProject) => void;
}) {
  const { t } = useTranslation('collaborators');
  const local = localProjectOf(project);
  const localName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const counts = kindCounts(project);
  return (
    <li className="collab-share" data-testid="collab-shared-project">
      <div className="collab-share-main">
        <strong className="ellipsis">{project.name}</strong>
        <span className="mono small muted collab-share-key">{project.shareKey}</span>
        {counts.length > 0 && (
          <span className="small muted collab-share-counts">
            {counts.map(({ kind, count }) => t(`kinds.${kind}`, { count })).join(' · ')}
          </span>
        )}
        <SyncLine project={project} />
      </div>
      <div className="collab-share-actions">
        {local ? (
          <>
            {project.linkedProjectId && (
              <span className="small muted collab-share-where">
                <Link2 {...ICON_SM} aria-hidden /> {t('sharedWithYou.linkedTo', { project: localName(project.linkedProjectId) })}
              </span>
            )}
            {project.linkedProjectId && (
              <button type="button" className="link-btn" disabled={busy} onClick={() => onUnlink(project)}>
                <Unlink {...ICON_SM} /> {t('sharedWithYou.unlink')}
              </button>
            )}
            <Link to={sharedTabPath(local)} className="btn btn-small" aria-label={t('sharedWithYou.openIn', { project: localName(local) })}>
              {t('sharedWithYou.open')} <ArrowRight {...ICON_SM} />
            </Link>
          </>
        ) : (
          <>
            <span className="small muted collab-share-where">
              <CircleSlash {...ICON_SM} aria-hidden /> {t('sharedWithYou.notCloned')}
            </span>
            <button type="button" className="link-btn" disabled={busy || projects.length === 0} onClick={() => onLink(project)}>
              <Link2 {...ICON_SM} /> {t('sharedWithYou.link')}
            </button>
            <Link to={sharedProjectPath(project)} className="btn btn-small" aria-label={t('sharedWithYou.openReadOnly', { project: project.name })} data-testid="collab-open-read-only">
              {t('sharedWithYou.open')} <ArrowRight {...ICON_SM} />
            </Link>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * What teammates share with this install, by person and then by install (§3.1: one person's two
 * installs are two members). A project cloned here opens in its Shared tab; one that is not opens
 * its own read-only view and offers a link to a local project.
 */
export function SharedWithYou({
  shared,
  projects,
  busy,
  onLink,
  onUnlink,
}: {
  shared: readonly SharedProject[];
  projects: readonly Project[];
  busy: boolean;
  onLink: (project: SharedProject) => void;
  onUnlink: (project: SharedProject) => void;
}) {
  const { t } = useTranslation('collaborators');
  const people = byPerson(shared);
  return (
    <Card className="collab-shared" title={t('sharedWithYou.title')}>
      {people.length === 0 ? (
        <Empty icon={Link2} title={t('sharedWithYou.none')}>
          {t('sharedWithYou.noneHint')}
        </Empty>
      ) : (
        <div className="collab-people">
          {people.map((person) => (
            <section key={person.name} className="collab-person" aria-label={person.name}>
              <h3 className="collab-person-name">
                <span className="collab-avatar" aria-hidden>
                  {person.name.trim().charAt(0).toUpperCase() || '?'}
                </span>
                <span className="ellipsis">{person.name}</span>
              </h3>
              {person.installs.map((install) => (
                <div key={install.owner} className="collab-install">
                  <span className="section-label">{install.label ? t('sharedWithYou.install', { label: install.label }) : t('sharedWithYou.noInstallLabel')}</span>
                  <ul className="collab-shares">
                    {install.projects.map((project) => (
                      <SharedRow key={project.shareId} project={project} projects={projects} busy={busy} onLink={onLink} onUnlink={onUnlink} />
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * A join this install sent that waits for the owner: "Connecting…" while it is being delivered, the
 * member holding it once a member took it, and a way to take it back.
 */
export function PendingJoinRow({ pending, busy, onCancel }: { pending: PendingJoin; busy: boolean; onCancel: (pending: PendingJoin) => void }) {
  const { t } = useTranslation('collaborators');
  return (
    <li className="collab-pending" data-testid="collab-pending-join">
      <div className="collab-pending-text">
        <strong className="ellipsis">{pending.groupName}</strong>
        <span className="small">
          <PendingWords pending={pending} />
        </span>
        <span className="small muted" title={formatDateTime(pending.expiresAt)}>
          {t('pending.expires', { when: formatDateTime(pending.expiresAt) })}
        </span>
      </div>
      <button type="button" className="link-btn" disabled={busy} onClick={() => onCancel(pending)}>
        {t('pending.cancel')}
      </button>
    </li>
  );
}
