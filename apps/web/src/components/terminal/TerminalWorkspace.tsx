import { ChevronDown, Plus, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { CreateTerminalRequest, ProjectWorktree, Terminal } from '@claudio/shared';
import { Menu, type MenuEntry } from '@claudio/ui/components/controls/Menu';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Skeleton } from '@claudio/ui/components/ui';
import { keys } from '../../api';
import { TerminalPanel } from './TerminalPanel';
import { TerminalStatus } from './TerminalStatus';
import { baseName, type LinkState } from './terminal-model';
import { scopeKey, useCloseTerminal, useOpenTerminal, useTerminalList, type TerminalScopeKey } from './use-terminals';

/** What a tab is called: the directory's name, numbered when two share it. */
function tabNames(terminals: readonly Terminal[]): Map<string, string> {
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  for (const terminal of terminals) {
    const base = baseName(terminal.cwd);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    names.set(terminal.id, n === 1 ? base : `${base} ${n}`);
  }
  return names;
}

/**
 * The terminals of one scope: tabs, a "New terminal" button and the open terminal in its frame. The
 * project page, the chat's dock and the phone's screen are this, in different clothes. Only the open
 * tab is attached; the others keep running in the server and attach again when opened.
 */
export function TerminalWorkspace({
  scope,
  request,
  worktrees,
  compact,
  autoOpen = false,
  onToggle,
  selectedId,
  onSelect,
}: {
  scope: TerminalScopeKey;
  /** The body that opens a terminal here; `worktree` is a path of the project's list, when it offers some */
  request: (worktree?: string) => CreateTerminalRequest;
  worktrees?: readonly ProjectWorktree[];
  compact: boolean;
  /** Opens one when the scope has none running: the dock does, the project page lets the person choose */
  autoOpen?: boolean;
  onToggle?: () => void;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const { t } = useTranslation('terminal');
  const queryClient = useQueryClient();
  const { terminals, isLoading, error } = useTerminalList(scope);
  const [picked, setPicked] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, LinkState>>({});
  const choice = selectedId !== undefined ? selectedId : picked;
  const current = terminals.find((terminal) => terminal.id === choice) ?? terminals[0] ?? null;
  const select = (id: string) => (onSelect ? onSelect(id) : setPicked(id));
  const open = useOpenTerminal((terminal) => select(terminal.id));
  const close = useCloseTerminal();
  const names = tabNames(terminals);

  // The dock opens a shell on first use; once, so a slow answer does not open two
  const asked = useRef(false);
  const idle = !isLoading && !error && !terminals.some((terminal) => terminal.state === 'running');
  useEffect(() => {
    if (!autoOpen || !idle || asked.current || open.isPending) return;
    asked.current = true;
    open.mutate(request());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, idle]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.terminalList(scopeKey(scope)) });
  };
  const reopen = (from: Terminal) => {
    const worktree = from.scope.kind === 'project' ? (from.scope.worktree ?? undefined) : undefined;
    open.mutate(request(worktree));
  };
  const closeCurrent = (terminal: Terminal) => close.mutate(terminal.id);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = terminals.findIndex((terminal) => terminal.id === current?.id);
    const next = terminals[(index + (event.key === 'ArrowRight' ? 1 : terminals.length - 1)) % terminals.length];
    if (!next) return;
    event.preventDefault();
    select(next.id);
    requestAnimationFrame(() => document.getElementById(`term-tab-${next.id}`)?.focus());
  };

  const entries: MenuEntry[] = worktrees?.length
    ? [
        { id: 'checkout', label: t('new.checkout'), onSelect: () => open.mutate(request()) },
        ...worktrees.map((worktree) => ({
          id: worktree.path,
          label: <span className="mono">{worktree.name ?? worktree.branch ?? baseName(worktree.path)}</span>,
          onSelect: () => open.mutate(request(worktree.path)),
        })),
      ]
    : [];

  const newButton = (
    <div className="term-new">
      <button type="button" className="btn btn-primary" disabled={open.isPending} onClick={() => open.mutate(request())}>
        <Plus {...ICON_SM} /> {t('new.button')}
      </button>
      {entries.length > 0 && (
        <Menu
          entries={entries}
          label={t('new.choose')}
          trigger={
            <button type="button" className="btn btn-primary term-new-more" aria-label={t('new.choose')}>
              <ChevronDown {...ICON_SM} />
            </button>
          }
        />
      )}
    </div>
  );

  if (isLoading) return <Skeleton rows={4} height={14} />;

  return (
    <div className="term-space">
      <div className="term-bar">
        <div className="term-tabs" role="tablist" aria-label={t('tabs.label')} onKeyDown={onKeyDown}>
          {terminals.map((terminal) => {
            const on = terminal.id === current?.id;
            return (
              <div key={terminal.id} className={`term-tab${on ? ' on' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  id={`term-tab-${terminal.id}`}
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  className="term-tab-main"
                  onClick={() => select(terminal.id)}
                >
                  <SquareTerminal {...ICON_SM} aria-hidden />
                  <span className="ellipsis">{names.get(terminal.id)}</span>
                  {!compact && <TerminalStatus terminal={terminal} link={on ? (links[terminal.id] ?? 'connecting') : 'ended'} />}
                </button>
                {on && (
                  <button type="button" className="x" aria-label={t('tabs.close', { name: names.get(terminal.id) ?? '' })} onClick={() => closeCurrent(terminal)}>
                    <X {...ICON_SM} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {newButton}
      </div>
      {current ? (
        <TerminalPanel
          // Another terminal is another xterm: nothing of the last one's screen may stay
          key={current.id}
          terminal={current}
          compact={compact}
          onToggle={onToggle}
          onLink={(link) => setLinks((all) => ({ ...all, [current.id]: link }))}
          onEnded={refresh}
          onReopen={() => reopen(current)}
          onClose={() => closeCurrent(current)}
        />
      ) : (
        <div className="term term-empty">
          <p className="muted small">{error ? t('list.failed') : t('list.none')}</p>
        </div>
      )}
    </div>
  );
}
