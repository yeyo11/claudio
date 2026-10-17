import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys, type Scope } from '../../../api';
import { formatNumber } from '@claudio/ui/lib/format';
import { InstructionsTab } from '../InstructionsTab';
import { GlobalLessons, LessonSettingsRows, useGlobalLessons } from '../LessonsTab';
import { MemoryOverview, useMemoryProjects } from '../MemoryOverview';
import { ResourcesTab } from '../ResourcesTab';
import { detailLabel, sectionLabel, settingsHref } from '../settingsGroups';
import { ResourceRow } from './ResourceRow';
import { SettingsDetailRow, SettingsSection, type GroupScreenProps } from './Section';

const USER_SCOPE: Scope = {};

/** The account's CLAUDE.md: its file name, and whether it has been written yet. */
function InstructionsRow() {
  const { t } = useTranslation(['config']);
  const { data } = useQuery({ queryKey: keys.instructions(USER_SCOPE, 'shared'), queryFn: () => api.getInstructions(USER_SCOPE, 'shared') });
  return (
    <SettingsDetailRow
      to={settingsHref('instructions', { detail: 'claude-md' })}
      label={t('instructions.row')}
      note={
        <>
          <span className="mono">CLAUDE.md</span>
          {data && !data.exists && ` · ${t('instructions.notWritten')}`}
        </>
      }
      setting="instructions.claude-md"
    />
  );
}

/** Memory is a line: how many projects keep one, opening the table of them. */
function MemoryRow() {
  const { t } = useTranslation(['config']);
  const { data } = useMemoryProjects();
  const keeping = (data ?? []).filter((project) => project.fileCount > 0).length;
  return (
    <SettingsDetailRow
      to={settingsHref('instructions', { detail: 'memory' })}
      label={!data ? t(detailLabel('memory')) : keeping === 0 ? t('settings.memory.none') : t('settings.memory.line', { count: keeping })}
      setting="memory.projects"
    />
  );
}

function GlobalLessonsRow() {
  const { t } = useTranslation(['config']);
  const { data, lessons } = useGlobalLessons();
  return (
    <SettingsDetailRow
      to={settingsHref('instructions', { detail: 'lessons' })}
      label={t('lessons.globalRow')}
      note={data ? formatNumber(lessons.filter((lesson) => lesson.status === 'active').length) : undefined}
      setting="lessons.global"
    />
  );
}

/**
 * Settings → Instructions & memory (docs/plans/settings-ia.md §6.4): what Claude reads before it
 * starts. Each editor and list is a detail; only the lessons' own settings are rows on the screen.
 */
export function Instructions({ detail }: GroupScreenProps<'instructions'>) {
  const { t } = useTranslation(['config']);
  if (detail === 'claude-md') return <InstructionsTab scope={USER_SCOPE} scopeKey="user" />;
  if (detail === 'memory') return <MemoryOverview />;
  if (detail === 'lessons') return <GlobalLessons />;
  if (detail) return <ResourcesTab scope={USER_SCOPE} kind={detail} />;
  return (
    <div className="settings-group">
      <SettingsSection id="instructions" title={t(sectionLabel('instructions'))}>
        <InstructionsRow />
      </SettingsSection>
      <SettingsSection id="memory" title={t(sectionLabel('memory'))}>
        <MemoryRow />
      </SettingsSection>
      <SettingsSection id="lessons" title={t(sectionLabel('lessons'))}>
        <GlobalLessonsRow />
        <LessonSettingsRows />
      </SettingsSection>
      <SettingsSection id="rules" title={t(sectionLabel('rules'))}>
        <ResourceRow kind="rules" />
      </SettingsSection>
      <SettingsSection id="output-styles" title={t(sectionLabel('output-styles'))}>
        <ResourceRow kind="output-styles" />
      </SettingsSection>
    </div>
  );
}
