import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { TerminalWorkspace } from './TerminalWorkspace';
import { DOCK_KEY, readPref, writePref } from './terminal-prefs';

const MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 280;
/** What the transcript keeps above the dock, as a share of the window */
const MAX_SHARE = 0.7;
const KEY_STEP = 24;

const limit = () => Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * MAX_SHARE));
const clamp = (height: number) => Math.min(limit(), Math.max(MIN_HEIGHT, Math.round(height)));

function storedHeight(): number {
  const value = Number(readPref(DOCK_KEY));
  return Number.isFinite(value) && value > 0 ? clamp(value) : DEFAULT_HEIGHT;
}

/**
 * The chat page's terminal: a dock under the transcript, opened in the chat's directory. Its height
 * is dragged by the handle (or moved with the arrow keys) and remembered in this browser.
 */
export function TerminalDock({ chatId, onToggle }: { chatId: string; onToggle: () => void }) {
  const { t } = useTranslation('terminal');
  const [height, setHeight] = useState(storedHeight);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const latest = useRef(height);
  latest.current = height;

  // A window that shrinks must not leave a dock taller than the room
  useEffect(() => {
    const onResize = () => setHeight((now) => clamp(now));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current) setHeight(clamp(drag.current.height + drag.current.y - event.clientY));
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    writePref(DOCK_KEY, String(latest.current));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const next = clamp(height + (event.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP));
    setHeight(next);
    writePref(DOCK_KEY, String(next));
  };

  return (
    <section className="term-dock" style={{ height }} aria-label={t('dock.label')}>
      <div
        className="term-dock-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('dock.resize')}
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={limit()}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { y: event.clientY, height };
        }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onKey}
      />
      <TerminalWorkspace scope={{ chat: chatId }} request={() => ({ chatId })} compact={false} autoOpen onToggle={onToggle} />
    </section>
  );
}
