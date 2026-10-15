import { SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { CreateTerminalRequest, Terminal } from '@claudio/shared';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Skeleton } from '@claudio/ui/components/ui';
import { keys } from '../../api';
import { TerminalPanel } from './TerminalPanel';
import { TerminalStatus } from './TerminalStatus';
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
 * project page, the chat's dock and the phone's screen are this, in different clothes. Only the open
 * tab is attached; the others keep running in the server and attach again when opened.
 */
export function TerminalWorkspace({
  scope,
  request,
  renderNew,
  labels,
  trailing,
  emptyText,
  compact,
  autoOpen = false,
  onAutoOpened,
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
  compact: boolean;
  /** Opens one when the scope has none running: the panel does after the person opened it, the project page lets the person choose */
  autoOpen?: boolean;
  onAutoOpened?: () => void;
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
  const names = (labels ?? tabNames)(terminals);

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
        {renderNew({ open: (body) => open.mutate(body), pending: open.isPending })}
        {trailing}
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
          <p className="muted small">{error ? t('list.failed') : (emptyText ?? t('list.none'))}</p>
        </div>
      )}
    </div>
  );
}
