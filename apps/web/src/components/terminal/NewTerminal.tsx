import { ChevronDown, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CreateTerminalRequest, Project } from '@claudio/shared';
import { Menu, type MenuEntry } from '@claudio/ui/components/controls/Menu';
import { MoreActions } from '@claudio/ui/components/controls/MoreActions';
import { ICON_SM } from '@claudio/ui/components/icons';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { baseName } from './terminal-model';

/**
 * Where a new terminal opens. With a project chosen it opens there at once (the checkout, or one of
 * its worktrees from the menu beside the button). With All projects it opens in the workspace, where
 * chats outside any project run: at once when there is no project, else from a menu that lists the
 * workspace first and then the projects (a sheet on a phone). `icon` draws the button as the panel's "+".
 */
export function NewTerminal({
  project,
  projects,
  icon = false,
  pending,
  onOpen,
}: {
  /** The project chosen in the top bar; null for All projects */
  project: Project | null;
  projects: readonly Project[];
  icon?: boolean;
  pending: boolean;
  onOpen: (request: CreateTerminalRequest) => void;
}) {
  const { t } = useTranslation('terminal');
  const narrow = useMediaQuery(NARROW);
  const label = t('new.button');

  if (!project) {
    const openWorkspace = () => onOpen({ workspace: true });
    const elsewhere: MenuEntry[] = projects
      .filter((each) => each.exists)
      .map((each) => ({ id: each.id, label: each.name, onSelect: () => onOpen({ projectId: each.id }) }));
    if (elsewhere.length === 0) {
      return icon ? (
        <button type="button" className="icon-btn term-plus" aria-label={t('new.inWorkspace')} disabled={pending} onClick={openWorkspace}>
          <Plus {...ICON_SM} />
        </button>
      ) : (
        <button type="button" className="btn btn-primary" disabled={pending} onClick={openWorkspace}>
          <Plus {...ICON_SM} /> {label}
        </button>
      );
    }
    // Disabled while one opens, so a second tap cannot open a second shell
    const choose: MenuEntry[] = [{ id: 'workspace', label: t('new.workspace'), onSelect: openWorkspace }, ...elsewhere].map((entry) => ({ ...entry, disabled: pending }));
    if (narrow || !icon) return <MoreActions entries={choose} label={t('bar.newIn')} text={label} />;
    return (
      <Menu
        entries={choose}
        label={t('bar.newIn')}
        trigger={
          <button type="button" className="icon-btn term-plus" aria-label={label} disabled={pending}>
            <Plus {...ICON_SM} />
          </button>
        }
      />
    );
  }

  const open = (worktree?: string) => onOpen({ projectId: project.id, ...(worktree ? { worktree } : {}) });
  // The main checkout is already the first entry
  const linked = project.worktrees.filter((w) => !w.main);
  const entries: MenuEntry[] = linked.length
    ? [
        { id: 'checkout', label: t('new.checkout'), onSelect: () => open() },
        ...linked.map((worktree) => ({
          id: worktree.path,
          label: <span className="mono">{worktree.name ?? worktree.branch ?? baseName(worktree.path)}</span>,
          onSelect: () => open(worktree.path),
        })),
      ]
    : [];

  return (
    <div className="term-new">
      {icon ? (
        <button type="button" className="icon-btn term-plus" aria-label={label} disabled={pending || !project.exists} onClick={() => open()}>
          <Plus {...ICON_SM} />
        </button>
      ) : (
        <button type="button" className="btn btn-primary" disabled={pending} onClick={() => open()}>
          <Plus {...ICON_SM} /> {label}
        </button>
      )}
      {entries.length > 0 && (
        <Menu
          entries={entries}
          label={t('new.choose')}
          trigger={
            <button type="button" className={icon ? 'icon-btn term-plus' : 'btn btn-primary term-new-more'} aria-label={t('new.choose')}>
              <ChevronDown {...ICON_SM} />
            </button>
          }
        />
      )}
    </div>
  );
}
