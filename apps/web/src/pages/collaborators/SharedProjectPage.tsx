import type { Project, SharedProject } from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CircleSlash, Link2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ApiRequestError, useProjects } from '../../api';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Empty, ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { PageHeader } from '../../components/PageHeader';
import { collaboratorsApi, collaboratorsKeys, type SharedRef } from '../project/shared-data';
import { SharedSections, SyncLine } from '../project/SharedView';
import { LinkDialog } from './dialogs';
import { localProjectOf, sharedTabPath } from './model';

/**
 * `/collaborators/shared/:owner/:shareId`: a teammate's project that is not cloned here, read from
 * the copy this install holds (docs/plans/collaborators.md §5.1). The same sub-tabs as a cloned
 * project's Shared tab, read only, with **Link to a local project** as the page's one action. Once it
 * is linked (or a clone appears), the action opens that project's Shared tab instead.
 */
export function SharedProjectPage() {
  const { owner = '', shareId = '' } = useParams();
  const ref: SharedRef = { owner, shareId };
  const shared = useQuery({
    queryKey: collaboratorsKeys.project(ref),
    queryFn: ({ signal }) => collaboratorsApi.project(ref, { signal }),
    // A project no longer shared is 404: said at once, not retried
    retry: (count, error) => !(error instanceof ApiRequestError && error.status === 404) && count < 2,
  });
  const projects = useProjects(false);
  if (shared.error) return <SharedProjectView shared={null} error={shared.error} projects={[]} />;
  if (!shared.data) return <Skeleton rows={6} height={20} />;
  return <SharedProjectView shared={shared.data} projects={projects.data ?? []} />;
}

/** The page from its data, so each state renders in a test without a server. */
export function SharedProjectView({ shared, error, projects }: { shared: SharedProject | null; error?: unknown; projects: readonly Project[] }) {
  const { t } = useTranslation('collaborators');
  const [linking, setLinking] = useState(false);
  // A dialog refocuses whenever its onClose changes, so it gets the same function every render
  const close = useCallback(() => setLinking(false), []);

  if (!shared) {
    const gone = error instanceof ApiRequestError && error.status === 404;
    return (
      <div className="stack shared-project">
        <PageHeader title={t('readOnly.title')} />
        {gone || !error ? (
          <Empty
            icon={CircleSlash}
            title={t('readOnly.gone')}
            action={
              <Link to="/collaborators" className="btn">
                <ArrowLeft {...ICON_SM} /> {t('readOnly.back')}
              </Link>
            }
          >
            {t('readOnly.goneHint')}
          </Empty>
        ) : (
          <ErrorBox error={error} />
        )}
      </div>
    );
  }

  const local = localProjectOf(shared);
  const localName = local ? (projects.find((p) => p.id === local)?.name ?? local) : null;
  const from = shared.ownerLabel ? `${shared.ownerName} · ${shared.ownerLabel}` : shared.ownerName;

  return (
    <div className="stack shared-view shared-project">
      <PageHeader
        title={shared.name}
        subtitle={t('readOnly.from', { name: from })}
        actions={
          local ? (
            <Link to={sharedTabPath(local)} className="btn" data-testid="collab-open-local">
              {t('sharedWithYou.openIn', { project: localName })} <ArrowRight {...ICON_SM} />
            </Link>
          ) : (
            <button type="button" className="btn" disabled={projects.length === 0} onClick={() => setLinking(true)} data-testid="collab-link">
              <Link2 {...ICON_SM} /> {t('sharedWithYou.link')}
            </button>
          )
        }
      />
      <div className="toolbar shared-head">
        <Link to="/collaborators" className="btn btn-small btn-quiet">
          <ArrowLeft {...ICON_SM} /> {t('nav')}
        </Link>
        <span className="mono small muted collab-share-key">{shared.shareKey}</span>
        {!local && (
          <span className="small muted collab-share-where">
            <CircleSlash {...ICON_SM} aria-hidden /> {t('sharedWithYou.notCloned')}
          </span>
        )}
        <SyncLine sync={shared.sync} />
      </div>
      <p className="small muted">{local ? t('readOnly.hintLinked', { project: localName }) : t('readOnly.hint')}</p>
      <SharedSections shared={shared} />
      {linking && <LinkDialog project={shared} projects={projects} onClose={close} />}
    </div>
  );
}
