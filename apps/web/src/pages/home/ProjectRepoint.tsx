import type { Project } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, GitBranch, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, ApiRequestError, keys, useProjects } from '../../api';
import { Dialog } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { Sheet } from '@claudio/ui/components/controls';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';

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
  const projects = useProjects(false).data;
  const narrow = useMediaQuery(NARROW);
  const [open, setOpen] = useState(false);
  // Once pointed, the callout says so in the room it took until the page is left: taking it away
  // would pull the whole page up under the person's eyes
  const [done, setDone] = useState<{ id: string; path: string } | null>(null);
  const target = project.insideWorktreeOf;

  const repoint = useMutation({
    mutationFn: (path: string) => api.updateProject(project.id, { path }),
    onSuccess: (updated) => {
      setDone({ id: updated.id, path: updated.path });
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      void queryClient.invalidateQueries({ queryKey: keys.chats });
      setOpen(false);
    },
  });

  const pointed = done?.id === project.id ? done.path : null;
  if (!target && !pointed) return null;
  const repoName = baseName(project.repo?.mainCheckout ?? target ?? project.path);

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
  // Pointing again would hit the same project: the button waits until the dialog is opened afresh
  const blocked = code === 'already-a-project';

  const cancel = (
    <button type="button" className="btn" disabled={repoint.isPending} onClick={close}>
      {t('common:actions.cancel')}
    </button>
  );
  const confirm = (
    <button type="button" className="btn btn-primary repoint-confirm" data-autofocus disabled={repoint.isPending || blocked} onClick={() => target && repoint.mutate(target)}>
      <span className="repoint-confirm-state" style={repoint.isPending ? { visibility: 'hidden' } : undefined}>
        {t('repoint.confirm')}
      </span>
      <span className="repoint-confirm-state" style={repoint.isPending ? undefined : { visibility: 'hidden' }} aria-hidden={!repoint.isPending}>
        <Spinner /> {t('repoint.running')}
      </span>
    </button>
  );
  const content = (
    <>
      <p>
        <Trans t={t} i18nKey="repoint.confirmBody" values={{ from: project.path, to: target ?? '' }} components={{ mono: <span className="mono break" /> }} />
      </p>
      {refusal && (
        <div className="callout callout-warn repoint-refusal" role="alert">
          <TriangleAlert {...ICON_SM} aria-hidden />
          <div className="repoint-refusal-text">
            <span>{t(`repoint.error.${known}`, { name: other?.name ?? '' })}</span>
            {/* A button after the sentence, not a link inside it: told apart by more than colour, and big enough to hit */}
            {other && (
              <Link to={`/?project=${encodeURIComponent(other.id)}`} className="btn btn-small repoint-refusal-open">
                {t('repoint.openOther', { name: other.name })}
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  );
  const title = t('repoint.confirmTitle', { name: project.name });

  return (
    <>
      <section className="callout repoint-callout" aria-label={pointed ? t('repoint.doneLabel') : t('repoint.title')}>
        <div className="repoint-faces">
          <div className="repoint-face" inert={pointed !== null} style={pointed ? { visibility: 'hidden' } : undefined}>
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
          </div>
          {pointed && (
            <div className="repoint-face repoint-done" role="status">
              <Check {...ICON_SM} className="repoint-done-icon" aria-hidden />
              <p className="repoint-body">
                <Trans t={t} i18nKey="repoint.done" values={{ name: project.name, path: pointed }} components={{ mono: <span className="mono break" /> }} />
              </p>
            </div>
          )}
        </div>
      </section>
      {open &&
        (narrow ? (
          <Sheet open onOpenChange={(next) => !next && close()} side="bottom" title={title} footer={<div className="repoint-sheet-foot">{confirm}{cancel}</div>}>
            {content}
          </Sheet>
        ) : (
          <Dialog
            title={title}
            onClose={close}
            footer={
              <>
                {cancel}
                {confirm}
              </>
            }
          >
            {content}
          </Dialog>
        ))}
    </>
  );
}
