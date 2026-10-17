import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, type Scope } from '../../../api';
import { Card, Empty, ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { timeAgo } from '@claudio/ui/lib/format';
import { InstructionsTab } from '../InstructionsTab';
import { LessonsTab } from '../LessonsTab';
import { ResourcesTab } from '../ResourcesTab';
import { detailLabel, sectionLabel, settingsHref, type DetailOf, type SectionOf } from '../settingsGroups';
import { SettingsDetailRow, SettingsSection, type GroupScreenProps } from './Section';

const USER_SCOPE: Scope = {};

/** Claude's memory is kept per project, so the user scope only gets the way to each project's. */
function MemoryOverview() {
  const { t } = useTranslation(['home', 'config', 'chat']);
  const { data, error, isLoading } = useQuery({ queryKey: keys.memoryProjects, queryFn: api.memoryProjects, refetchInterval: 15_000 });
  const projects = data ?? [];

  return (
    <Card title={t('settings.memory.title')}>
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

// Each section of the group is, for now, one row opening the tab it was
const SECTIONS: ReadonlyArray<{ section: SectionOf<'instructions'>; detail: DetailOf<'instructions'>; setting: string }> = [
  { section: 'instructions', detail: 'claude-md', setting: 'instructions.claude-md' },
  { section: 'memory', detail: 'memory', setting: 'memory.projects' },
  { section: 'lessons', detail: 'lessons', setting: 'lessons.global' },
  { section: 'rules', detail: 'rules', setting: 'rules.list' },
  { section: 'output-styles', detail: 'output-styles', setting: 'output-styles.list' },
];

/** Settings → Instructions & memory (§6.4). A placeholder over today's tabs, until w3 builds the screen. */
export function Instructions({ detail }: GroupScreenProps<'instructions'>) {
  const { t } = useTranslation(['config']);
  if (detail === 'claude-md') return <InstructionsTab scope={USER_SCOPE} scopeKey="user" />;
  if (detail === 'memory') return <MemoryOverview />;
  if (detail === 'lessons') return <LessonsTab />;
  if (detail) return <ResourcesTab scope={USER_SCOPE} kind={detail} />;
  return (
    <div className="settings-group">
      {SECTIONS.map(({ section, detail: to, setting }) => (
        <SettingsSection key={section} id={section} title={t(sectionLabel(section))}>
          <SettingsDetailRow to={settingsHref('instructions', { detail: to })} label={t(detailLabel(to))} setting={setting} />
        </SettingsSection>
      ))}
    </div>
  );
}
