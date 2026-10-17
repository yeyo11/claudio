import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../api';
import { Card, Empty, ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { timeAgo } from '@claudio/ui/lib/format';

/** The projects Claude keeps memory for, read every 15 s: the overview's table and the group's line share it. */
export const useMemoryProjects = () => useQuery({ queryKey: keys.memoryProjects, queryFn: () => api.memoryProjects(), refetchInterval: 15_000 });

/**
 * Settings → Instructions & memory → Memory (docs/plans/settings-ia.md §6.4). Claude's memory is kept
 * per project, so the user scope only gets the way to each project's.
 */
export function MemoryOverview() {
  const { t } = useTranslation(['home', 'config', 'chat']);
  const { data, error, isLoading } = useMemoryProjects();
  const projects = data ?? [];

  return (
    // The detail's title names the screen: the card only holds the table
    <Card>
      <p className="small muted">{t('settings.memory.intro')}</p>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={4} />
      ) : projects.length === 0 ? (
        <Empty
          title={t('settings.memory.none')}
          action={
            <Link to="/projects" className="btn btn-primary">
              {t('settings.memory.goToProjects')}
            </Link>
          }
        >
          {t('settings.memory.noneHint')}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('chat:shared.project')}</th>
                <th scope="col">{t('config:config.tabs.files')}</th>
                <th scope="col">{t('settings.memory.lastUpdate')}</th>
                <th scope="col">
                  <span className="sr-only">{t('settings.memory.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.projectId}>
                  <td>
                    <div className="strong">{project.projectName}</div>
                    <div className="small muted mono break">{project.projectPath}</div>
                  </td>
                  <td>
                    <span className={`count ${project.fileCount > 0 ? 'count-on' : ''}`}>{project.fileCount}</span>
                  </td>
                  <td className="small muted">{project.lastUpdated ? timeAgo(project.lastUpdated) : '—'}</td>
                  <td>
                    <div className="row-actions">
                      <Link
                        className="btn btn-small"
                        to={`/?project=${encodeURIComponent(project.projectId)}&tab=memory`}
                        aria-label={t('settings.memory.openNamed', { name: project.projectName })}
                      >
                        {t('settings.memory.open')}
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
