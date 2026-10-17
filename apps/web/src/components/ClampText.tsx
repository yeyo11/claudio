import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A text cut at `lines` lines with the rest one click away. The toggle only shows when the text
 * really overflows, so a short one is just text. The clamp is `.clamp-text` with `clamp-2` or `clamp-3`.
 */
export function ClampText({ text, lines = 3, className = '' }: { text: string; lines?: 2 | 3; className?: string }) {
  const { t } = useTranslation('orchestrationDetail');
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, lines]);
  return (
    <>
      <div id={id} ref={ref} className={`clamp-text clamp-${lines} ${open ? '' : 'is-clamped'} ${className}`.trim()}>
        {text}
      </div>
      {(overflows || open) && (
        <button type="button" className="link-btn small" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
          {open ? t('showLess') : t('showMore')}
        </button>
      )}
    </>
  );
}
