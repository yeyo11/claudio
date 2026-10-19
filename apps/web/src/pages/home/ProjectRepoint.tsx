import type { Project } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GitBranch, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, ApiRequestError, keys, useProjects } from '../../api';
import { Dialog } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';

const REFUSALS = ['not-a-repository', 'not-a-directory', 'linked-worktree', 'other-repository', 'already-a-project'] as const;

const baseName = (path: string): string => path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path;

/** The linked worktree the project's path lies in: the deepest one that holds it. */
function worktreeOf(project: Project): string {
  const inside = project.worktrees
    .filter((w) => !w.main && (project.path === w.path || project.path.startsWith(`${w.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return inside?.path ?? project.path;
}

/**
 * A project imported inside a linked worktree keeps pointing there until the person moves it. This
 * says so on Resumen and Ajustes and offers the one action, "Point at the main repository", behind
 * a confirmation that names both paths. Neutral on purpose: nothing failed and nothing is near a
 * limit. Renders nothing for a project on its repository's main checkout.
 */
export function ProjectRepoint({ project }: { project: Project }) {
  const { t } = useTranslation(['projects', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const projects = useProjects(false).data;
  const [open, setOpen] = useState(false);
  const target = project.insideWorktreeOf;

  const repoint = useMutation({
    mutationFn: (path: string) => api.updateProject(project.id, { path }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      void queryClient.invalidateQueries({ queryKey: keys.chats });
      setOpen(false);
      toast.success(t('repoint.done', { name: updated.name, path: updated.path }));
    },
  });

  if (!target) return null;
  const repoName = baseName(project.repo?.mainCheckout ?? target);

  const close = () => {
    if (repoint.isPending) return;
    repoint.reset();
    setOpen(false);
  };
  // The refusal is said in the dialog, where the person is looking, with what to do about it
  const refusal = repoint.error;
  const code = refusal instanceof ApiRequestError ? refusal.code : undefined;
  const known = REFUSALS.find((r) => r === code) ?? 'other';
  const other = code === 'already-a-project' && refusal instanceof ApiRequestError ? projects?.find((p) => p.id === refusal.detail) : undefined;

  return (
    <>
      <section className="callout repoint-callout" aria-label={t('repoint.title')}>
        <GitBranch {...ICON_SM} className="repoint-icon" aria-hidden />
        <div className="repoint-text">
          <h2 className="repoint-title">{t('repoint.title')}</h2>
          <p className="repoint-body">
            <Trans t={t} i18nKey="repoint.body" values={{ worktree: worktreeOf(project), repo: repoName }} components={{ mono: <span className="mono break" /> }} />
          </p>
        </div>
        <button type="button" className="btn btn-small repoint-action" onClick={() => setOpen(true)}>
          {t('repoint.action')}
        </button>
      </section>
      {open && (
        <Dialog
          title={t('repoint.confirmTitle', { name: project.name })}
          onClose={close}
          footer={
            <>
              <button type="button" className="btn" disabled={repoint.isPending} onClick={close}>
                {t('common:actions.cancel')}
              </button>
              <button type="button" className="btn btn-primary repoint-confirm" data-autofocus disabled={repoint.isPending} onClick={() => repoint.mutate(target)}>
                {repoint.isPending ? (
                  <>
                    <Spinner /> {t('repoint.running')}
                  </>
                ) : (
                  t('repoint.confirm')
                )}
              </button>
            </>
          }
        >
          <p>
            <Trans t={t} i18nKey="repoint.confirmBody" values={{ from: project.path, to: target }} components={{ mono: <span className="mono break" /> }} />
          </p>
          {refusal && (
            <div className="callout callout-warn repoint-refusal" role="alert">
              <TriangleAlert {...ICON_SM} aria-hidden />
              <span>
                {t(`repoint.error.${known}`, { name: other?.name ?? '' })}
                {other && (
                  <>
                    {' '}
                    <Link to={`/?project=${encodeURIComponent(other.id)}`}>{t('common:actions.open')}</Link>
                  </>
                )}
              </span>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
