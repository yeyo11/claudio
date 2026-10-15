import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { KEY_BAR, REPEAT_AFTER_MS, REPEAT_EVERY_MS, withModifiers, type KeyDef } from './terminal-model';

export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
}

/**
 * The keys a phone's keyboard lacks, above it. Ctrl and Alt are sticky for one key; the arrows
 * repeat while held. Pressing a key must not take the focus from the terminal, or the on-screen
 * keyboard would close with every tap.
 */
export function KeyBar({ mods, onMods, onSend }: { mods: Modifiers; onMods: (next: Modifiers) => void; onSend: (data: string) => void }) {
  const { t } = useTranslation('terminal');
  const timers = useRef<{ wait?: number; every?: number }>({});
  const stop = () => {
    window.clearTimeout(timers.current.wait);
    window.clearInterval(timers.current.every);
    timers.current = {};
  };
  useEffect(() => stop, []);

  const press = (key: KeyDef) => {
    onSend(withModifiers(key.send, mods));
    if (mods.ctrl || mods.alt) onMods({ ctrl: false, alt: false });
  };

  const down = (key: KeyDef) => (event: ReactPointerEvent) => {
    event.preventDefault();
    press(key);
    if (!key.repeat) return;
    stop();
    // The first press has gone; a held key repeats after a pause, then steadily
    timers.current.wait = window.setTimeout(() => {
      timers.current.every = window.setInterval(() => onSend(key.send), REPEAT_EVERY_MS);
    }, REPEAT_AFTER_MS);
  };

  const label = (key: KeyDef) => key.name ?? key.label;
  return (
    <div className="term-keys" role="toolbar" aria-label={t('keys.label')}>
      {KEY_BAR.slice(0, 3).map((key) => (
        <button
          key={key.id}
          type="button"
          className="term-key"
          aria-label={label(key)}
          onPointerDown={down(key)}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
          // A keyboard's Enter or Space reaches here with no pointer; a tap was sent on press
          onClick={(event) => event.detail === 0 && press(key)}
        >
          {key.label}
        </button>
      ))}
      {(['ctrl', 'alt'] as const).map((name) => (
        <button
          key={name}
          type="button"
          className={`term-key${mods[name] ? ' on' : ''}`}
          aria-pressed={mods[name]}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onMods({ ...mods, [name]: !mods[name] })}
        >
          {name === 'ctrl' ? 'Ctrl' : 'Alt'}
        </button>
      ))}
      {KEY_BAR.slice(3).map((key) => (
        <button
          key={key.id}
          type="button"
          className="term-key"
          aria-label={label(key)}
          onPointerDown={down(key)}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
          // A keyboard's Enter or Space reaches here with no pointer; a tap was sent on press
          onClick={(event) => event.detail === 0 && press(key)}
        >
          {key.label}
        </button>
      ))}
    </div>
  );
}
