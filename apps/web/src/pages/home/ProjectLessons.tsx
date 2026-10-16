import type { Project, ProjectLessonsSettings } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys, useProjectSettings } from '../../api';
import { Switch } from '@claudio/ui/components/controls';
import { useToast } from '@claudio/ui/components/Toast';

/** What the settings document holds when a field is missing */
const DEFAULTS: ProjectLessonsSettings = { deliverToChats: true, deliverToWorkers: true, useGlobal: true };

const FIELDS = ['deliverToChats', 'deliverToWorkers', 'useGlobal'] as const;

/**
 * Under Memory in the project's settings: who is handed the project's lessons. Each switch is saved
 * at once, from a fresh read of the document, since the document is replaced whole.
 */
export function ProjectLessons({ project }: { project: Project }) {
  const { t } = useTranslation('projects');
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useProjectSettings(project.id);
  const current = { ...DEFAULTS, ...settings.data?.lessons };
  const save = useMutation({
    mutationFn: async (patch: Partial<ProjectLessonsSettings>) => {
      const fresh = await api.projectSettings(project.id);
      return api.putProjectSettings(project.id, { ...fresh, lessons: { ...DEFAULTS, ...fresh.lessons, ...patch } });
    },
    onSuccess: (saved) => {
      qc.setQueryData(keys.projectSettings(project.id), saved);
      void qc.invalidateQueries({ queryKey: ['lessons'] });
    },
    onError: (error) => toast.error(t('lessons.saveFailed'), error),
  });
  if (!project.modules.includes('memory') || !settings.data) return null;
  return (
    <section className="settings-cells-group project-lessons">
      <h2 className="section-label settings-cells-label">{t('lessons.title')}</h2>
      <div className="card settings-cells project-lessons-cells">
        {FIELDS.map((field) => (
          <div key={field} className="settings-cell project-lessons-cell">
            <Switch checked={current[field]} disabled={save.isPending} onChange={(checked) => save.mutate({ [field]: checked })}>
              <span className="settings-cell-name">{t(`lessons.${field}`)}</span>
            </Switch>
          </div>
        ))}
      </div>
      <span className="field-hint">{t('lessons.hint')}</span>
    </section>
  );
}
