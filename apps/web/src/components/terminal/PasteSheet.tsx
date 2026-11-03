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
  onSend: (text: string) => void;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const { t } = useTranslation('terminal');
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  // Every terminal view can open its own sheet (the dock and a page side by side)
  const helpId = useId();

  // The sheet gives its own panel the focus once it has slid in, after the field mounted: the field
  // takes it back a frame later, so the keyboard is up where the person is about to paste
  useEffect(() => {
    if (!compact) return;
    const frame = requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [compact]);

  const send = () => {
    if (!text) return;
    onSend(text);
    onClose();
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
