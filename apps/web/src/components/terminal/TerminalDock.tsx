import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Terminal } from '@claudio/shared';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { useProjectScope } from '../../lib/project-scope';
import { NewTerminal } from './NewTerminal';
import { TerminalWorkspace } from './TerminalWorkspace';
import { escapeClosesPanel, tabLabels } from './terminal-model';
import { MIN_HEIGHT, heightLimit, useTerminalBar } from './terminal-bar';

const KEY_STEP = 24;

/**
 * The terminal panel above the status bar, on every page: the tabs of every terminal, the open one
 * in its frame and a "+" that opens a new one in the project chosen in the top bar (with All
 * projects, in the workspace, or a menu of the workspace and the projects). Its height is dragged by the handle, or moved with the arrow
 * keys, and remembered in this browser. Esc hides it unless focus is in a terminal or a field.
 */
export function TerminalDock() {
  const { t } = useTranslation('terminal');
  const bar = useTerminalBar();
  const { project, projects } = useProjectScope();
  const drag = useRef<{ y: number; height: number } | null>(null);
  // The dock mounts when it is shown, so this is where the keyboard was before: the page
  const before = useRef<Element | null>(document.activeElement);

  const { hide } = bar;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (escapeClosesPanel(event)) hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hide]);

  // The last terminal is gone: the dock hides and the keyboard goes back to the page, not to a panel that no longer exists
  const emptied = () => {
    // The server's `closed` can come while the person types elsewhere on the page: only a keyboard that
    // was on the dock (or nowhere) is moved
    const active = document.activeElement;
    const onDock = !active || active === document.body || (active instanceof HTMLElement && active.closest('#terminal-bar') !== null);
    hide();
    if (!onDock) return;
    // What had the keyboard when the dock opened, when that was something that can keep it; otherwise (a
    // click that gave the button no focus, an element drawn again since) the status bar item that opens it
    const was = before.current;
    const target =
      was instanceof HTMLElement && was !== document.body && was.isConnected && !was.closest('#terminal-bar') ? was : document.getElementById('terminal-bar-toggle');
    if (target instanceof HTMLElement) target.focus();
    if (document.activeElement instanceof HTMLElement && document.activeElement.closest('#terminal-bar')) document.activeElement.blur();
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current) bar.setHeight(drag.current.height + drag.current.y - event.clientY);
  };
  const end = () => {
    drag.current = null;
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    bar.setHeight(bar.height + (event.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP));
  };
  const labels = (terminals: readonly Terminal[]) => tabLabels(terminals, (id) => projects.find((each) => each.id === id)?.name, t('new.workspace'));

  return (
    <section id="terminal-bar" className="term-dock term-bar-panel" style={{ height: bar.height }} aria-label={t('dock.label')}>
      <div
        className="term-dock-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('dock.resize')}
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={heightLimit()}
        aria-valuenow={bar.height}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { y: event.clientY, height: bar.height };
        }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onKey}
      />
      <TerminalWorkspace
        scope={{ all: true }}
        labels={labels}
        autoOpen={bar.wantsShell}
        onAutoOpened={bar.shellOpened}
        focusFront={bar.wantsFocus}
        onFocused={bar.focused}
        // With All projects, or none at all, the first shell opens in the workspace, as a chat outside any project does
        request={() => (project ? { projectId: project.id } : { workspace: true })}
        selectedId={bar.selectedId}
        onSelect={bar.select}
        onToggle={bar.toggle}
        onEmptied={emptied}
        renderNew={({ open, pending }) => <NewTerminal icon project={project} projects={projects} pending={pending} onOpen={open} />}
        trailing={
          <Tooltip content={t('bar.hide')}>
            <button type="button" className="icon-btn" aria-label={t('bar.hide')} onClick={bar.hide}>
              <ChevronDown {...ICON_SM} />
            </button>
          </Tooltip>
        }
      />
    </section>
  );
}
