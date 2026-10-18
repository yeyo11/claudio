import { ExternalLink, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@claudio/ui/components/Toast';
import type { CreateTerminalRequest, Terminal } from '@claudio/shared';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Skeleton } from '@claudio/ui/components/ui';
import { keys } from '../../api';
import { TerminalPanel } from './TerminalPanel';
import { TerminalStatus } from './TerminalStatus';
import { openTerminalWindow, useDetachedTerminals } from './terminal-window';
import { baseName, requestFor, type LinkState } from './terminal-model';
import { scopeKey, useCloseTerminal, useOpenTerminal, useTerminalList, type TerminalScopeKey } from './use-terminals';

/** What a tab is called when the caller does not say: the directory's name, numbered when two share it. */
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
 * status bar's panel is this. Only the open
 * tab is attached; the others keep running in the server and attach again when opened.
 */
export function TerminalWorkspace({
  scope,
  request,
  renderNew,
  labels,
  trailing,
  emptyText,
  autoOpen = false,
  onAutoOpened,
  focusFront = false,
  onFocused,
  onToggle,
  selectedId,
  onSelect,
}: {
  scope: TerminalScopeKey;
  /** The body that opens a terminal on its own (`autoOpen`) */
  request?: () => CreateTerminalRequest;
  /** The control that opens one: the page's button, the panel's "+" */
  renderNew: (control: { open: (request: CreateTerminalRequest) => void; pending: boolean }) => ReactNode;
  /** Names the tabs; the directory's name when absent */
  labels?: (terminals: readonly Terminal[]) => Map<string, string>;
  /** After the new control, at the end of the bar */
  trailing?: ReactNode;
  emptyText?: string;
  /** Opens one when the scope has none running: the panel does after the person opened it */
  autoOpen?: boolean;
  onAutoOpened?: () => void;
  /** The person just opened the panel: the terminal in front takes the keyboard when it attaches */
  focusFront?: boolean;
  onFocused?: () => void;
  onToggle?: () => void;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const { t } = useTranslation('terminal');
  const queryClient = useQueryClient();
  const toast = useToast();
  const listed = useTerminalList(scope);
  const { isLoading, error } = listed;
  // Ids being closed, or that the server said were closed: out of the tabs at once, so no panel stays to reconnect to them
  const [forgotten, setForgotten] = useState<ReadonlySet<string>>(() => new Set());
  const forget = (id: string, gone: boolean) =>
    setForgotten((now) => {
      const next = new Set(now);
      if (gone) next.add(id);
      else next.delete(id);
      return next;
    });
  const terminals = listed.terminals.filter((terminal) => !forgotten.has(terminal.id));
  const [picked, setPicked] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, LinkState>>({});
  const choice = selectedId !== undefined ? selectedId : picked;
  const current = terminals.find((terminal) => terminal.id === choice) ?? terminals[0] ?? null;
  const select = (id: string) => (onSelect ? onSelect(id) : setPicked(id));
  // A terminal the person just opened takes the keyboard; switching tabs does not, so the arrows keep moving along them
  const [fresh, setFresh] = useState<string | null>(null);
  const open = useOpenTerminal((terminal) => {
    setFresh(terminal.id);
    select(terminal.id);
  });
  const close = useCloseTerminal();
  const names = (labels ?? tabNames)(terminals);
  const windows = useDetachedTerminals();
  const detached = current !== null && windows.detached.has(current.id) && current.state === 'running';
  const detach = (terminal: Terminal) => {
    // A popup the browser blocked leaves the terminal where it is
    if (openTerminalWindow(terminal.id)) windows.markOpened(terminal.id);
    else toast.info(t('window.blocked'));
  };

  // The dock opens a shell on first use; once, so a slow answer does not open two
  const asked = useRef(false);
  const idle = !isLoading && !error && !terminals.some((terminal) => terminal.state === 'running');
  useEffect(() => {
    if (!autoOpen || !idle || asked.current || open.isPending || !request) return;
    asked.current = true;
    onAutoOpened?.();
    open.mutate(request());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, idle]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.terminalList(scopeKey(scope)) });
  };
  const reopen = (from: Terminal) => {
    open.mutate(requestFor(from));
  };
  const closeCurrent = (terminal: Terminal) => {
    forget(terminal.id, true);
    // A close that failed brings the tab back, attached again
    close.mutate(terminal.id, { onError: () => forget(terminal.id, false) });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = terminals.findIndex((terminal) => terminal.id === current?.id);
    const next = terminals[(index + (event.key === 'ArrowRight' ? 1 : terminals.length - 1)) % terminals.length];
    if (!next) return;
    event.preventDefault();
    select(next.id);
    requestAnimationFrame(() => document.getElementById(`term-tab-${next.id}`)?.focus());
  };

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
                  <TerminalStatus terminal={terminal} link={windows.detached.has(terminal.id) ? 'window' : on ? (links[terminal.id] ?? 'connecting') : 'ended'} />
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
        {renderNew({ open: (body) => open.mutate(body), pending: open.isPending })}
        {trailing}
      </div>
      {current && detached ? (
        <section className="term term-detached" aria-label={t('panel.label', { name: baseName(current.cwd) })}>
          <div className="term-detached-body">
            <ExternalLink {...ICON_SM} aria-hidden />
            <p className="term-detached-title">{t('window.elsewhere')}</p>
            <p className="muted small">{t('window.elsewhereHint')}</p>
            <button type="button" className="btn btn-small" onClick={() => windows.bringBack(current.id)}>
              {t('window.bringBack')}
            </button>
          </div>
        </section>
      ) : current ? (
        <TerminalPanel
          // Another terminal is another xterm: nothing of the last one's screen may stay
          key={current.id}
          terminal={current}
          compact={false}
          onToggle={onToggle}
          onDetach={() => detach(current)}
          autoFocus={focusFront || fresh === current.id}
          onFocused={() => {
            setFresh(null);
            onFocused?.();
          }}
          onLink={(link) => setLinks((all) => ({ ...all, [current.id]: link }))}
          onEnded={(reason) => {
            if (reason === 'closed') forget(current.id, true);
            refresh();
          }}
          onReopen={() => reopen(current)}
          onClose={() => closeCurrent(current)}
        />
      ) : (
        <div className="term term-empty">
          <p className="muted small">{error ? t('list.failed') : (emptyText ?? t('list.none'))}</p>
        </div>
      )}
    </div>
  );
}
