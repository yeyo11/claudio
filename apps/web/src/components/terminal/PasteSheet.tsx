import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@claudio/ui/components/Dialog';
import { Sheet } from '@claudio/ui/components/controls/Sheet';

/**
 * Where a paste goes when the page cannot read the clipboard itself: plain HTTP on a LAN address has
 * no `navigator.clipboard`, and a browser may refuse it. The person pastes into a field with their
 * own keyboard or long press, which every browser allows, and sends it from there. A bottom sheet on
 * a phone, which the on-screen keyboard pushes up (lib/viewport.ts); a small dialog on a desktop.
 */
export function PasteSheet({
  compact,
  onSend,
  onClose,
  returnFocus,
}: {
  compact: boolean;
  /** Whether the text was sent: a refused one (over the cap) keeps the sheet open with the text */
  onSend: (text: string) => boolean;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const { t } = useTranslation('terminal');
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  // Every terminal view can open its own sheet (the dock and a page side by side)
  const helpId = useId();

  // The field ends up with the keyboard, whoever moved it after the mount: the `⋯` menu that chose
  // Paste gives the focus back to its trigger a tick after it closes (a timeout of 0 runs after it),
  // and the phone's sheet gives its own panel the focus once it has slid in (a frame later)
  useEffect(() => {
    const take = () => field.current?.focus({ preventScroll: true });
    const timer = window.setTimeout(take, 0);
    const frame = compact ? requestAnimationFrame(take) : 0;
    return () => {
      window.clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [compact]);

  const send = () => {
    if (!text) return;
    if (onSend(text)) onClose();
  };

  const body = (
    <div className="term-paste">
      <textarea
        ref={field}
        rows={6}
        value={text}
        data-autofocus
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label={t('paste.field')}
        aria-describedby={helpId}
        onChange={(event) => setText(event.target.value)}
      />
      <p id={helpId} className="muted small">
        {compact ? t('paste.helpTouch') : t('paste.help')}
      </p>
    </div>
  );
  const footer = (
    <>
      <button type="button" className="btn" onClick={onClose}>
        {t('paste.cancel')}
      </button>
      <button type="button" className="btn btn-primary" disabled={!text} onClick={send}>
        {t('paste.send')}
      </button>
    </>
  );

  if (compact)
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()} side="bottom" title={t('paste.title')} footer={footer} returnFocus={returnFocus}>
        {body}
      </Sheet>
    );
  return (
    <Dialog title={t('paste.title')} onClose={onClose} width={480} footer={footer}>
      {body}
    </Dialog>
  );
}
