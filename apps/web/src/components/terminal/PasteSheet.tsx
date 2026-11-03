import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@claudio/ui/components/Dialog';
import { Sheet } from '@claudio/ui/components/controls/Sheet';

/** How long after opening a late focus return (the `⋯` menu's, Radix's) is taken back for the field */
const FOCUS_GUARD_MS = 500;

/**
 * Where a paste goes when the page cannot read the clipboard itself: plain HTTP on a LAN address has
 * no `navigator.clipboard`, and a browser may refuse it. The person pastes into a field with their
 * own keyboard or long press, which every browser allows, and sends it from there. A bottom sheet on
 * a phone, which the on-screen keyboard pushes up (lib/viewport.ts); a small dialog on a desktop.
 */
export function PasteSheet({
  compact,
  refused,
  onSend,
  onClose,
  returnFocus,
}: {
  compact: boolean;
  /** The browser refused to hand over the clipboard: said here, where a toast would sit under the scrim */
  refused: boolean;
  /** Whether the text was taken; false (too large) keeps the sheet open with the text in it */
  onSend: (text: string) => boolean;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const { t } = useTranslation('terminal');
  const [text, setText] = useState('');
  const [tooLarge, setTooLarge] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const helpId = useId();

  // The panel that opened this (the `⋯` menu, the sheet of actions) hands the focus back to its own
  // button a tick after it closes, which is after the field took it: for a moment the field gets it
  // back, so the keyboard is where the person is about to paste
  useEffect(() => {
    const take = () => field.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(take);
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Node && !target.parentElement?.closest('[role="dialog"]')) take();
    };
    document.addEventListener('focusin', onFocusIn);
    const done = window.setTimeout(() => document.removeEventListener('focusin', onFocusIn), FOCUS_GUARD_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(done);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  const send = () => {
    if (!text) return;
    if (!onSend(text)) {
      setTooLarge(true);
      return;
    }
    onClose();
  };

  const body = (
    <div className="term-paste">
      {refused && <p className="small">{t('notices.pasteBlocked')}</p>}
      <textarea
        ref={field}
        // A phone's keyboard takes half the screen: fewer rows keep the sheet's actions in view
        rows={compact ? 4 : 6}
        value={text}
        data-autofocus
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label={t('paste.field')}
        aria-describedby={helpId}
        aria-invalid={tooLarge || undefined}
        onChange={(event) => {
          setText(event.target.value);
          setTooLarge(false);
        }}
      />
      {tooLarge && (
        <p className="small term-paste-error" role="alert">
          {t('notices.pasteTooLarge')}
        </p>
      )}
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
