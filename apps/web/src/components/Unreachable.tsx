import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useTranslation } from 'react-i18next';
import { formatNumber } from '@claudio/ui/lib/format';
import { Empty } from '@claudio/ui/components/ui';
import { reachability, useReachability } from '../lib/reachability';

/** Seconds until `at`, rounded up so the line never reads "0 s" while a wait is still on. */
export const secondsUntil = (at: number, now: number): number => Math.max(1, Math.ceil((at - now) / 1000));

const KEY_EVENTS = ['keydown', 'keypress', 'keyup'] as const;

/**
 * The screen in the browser's top layer, as a modal `<dialog>` on `<body>`: above every menu, sheet
 * or dialog the page had open when the server went (they portal to `<body>` too, so hiding the shell
 * does not hide them), and with the whole rest of the document inert, so none of them acts or keeps
 * the focus. They are not closed: whatever was half done in them is still there when the server is,
 * so nothing that would dismiss them gets past the screen (a key, a press outside them; leaving the
 * window still closes a menu, as it does with no screen). Focus goes back to what had it once the
 * screen goes, or to the page.
 */
function TopLayer({ label, describedBy, children }: { label: string; describedBy: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Read while rendering, before the commit hides the shell and the browser lets go of its focus
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || typeof dialog.showModal !== 'function') return;
    let leaving = false;
    const show = () => {
      if (!dialog.open) dialog.showModal();
      // The dialog itself, not Retry: a screen reader hears the title and the text once, not the countdown
      dialog.focus({ preventScroll: true });
    };
    // The screen goes only when the server answers. Browsers ignore a `cancel` that is prevented
    // without a user activation since the last one, so Escape or a phone's back gesture can still
    // close a modal dialog: it is opened again at once, or the window would be left blank
    dialog.setAttribute('closedby', 'none');
    const keep = (event: Event) => event.preventDefault();
    const reopen = () => {
      if (!leaving) show();
    };
    // The page behind keeps its keyboard shortcuts on the window and the document (a list's Enter
    // and `x`, a dialog's Escape in the capture phase): no key gets to them, since the window's
    // capture comes first. Only the propagation stops, so Tab and Enter or Space on Retry still do
    // what they do; Escape's default is stopped too, as it would close this dialog
    const swallowKeys = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') event.preventDefault();
    };
    // A press on the screen is outside every menu and sheet behind it, which they take as "close"
    const stayInside = (event: Event) => event.stopPropagation();
    dialog.addEventListener('cancel', keep);
    dialog.addEventListener('close', reopen);
    dialog.addEventListener('pointerdown', stayInside);
    dialog.addEventListener('focusin', stayInside);
    for (const type of KEY_EVENTS) window.addEventListener(type, swallowKeys, true);
    show();
    return () => {
      leaving = true;
      for (const type of KEY_EVENTS) window.removeEventListener(type, swallowKeys, true);
      dialog.removeEventListener('cancel', keep);
      dialog.removeEventListener('close', reopen);
      dialog.removeEventListener('pointerdown', stayInside);
      dialog.removeEventListener('focusin', stayInside);
      if (dialog.open) dialog.close();
      const back = previous?.isConnected ? previous : document.getElementById('main');
      back?.focus({ preventScroll: true });
      // A layer that took its focus element with it leaves focus on <body>: the page is the next best place
      if (document.activeElement === document.body) document.getElementById('main')?.focus({ preventScroll: true });
    };
  }, [previous]);
  return createPortal(
    <dialog ref={ref} className="unreachable-layer" aria-label={label} aria-describedby={describedBy} tabIndex={-1} data-testid="unreachable">
      {children}
    </dialog>,
    document.body,
  );
}

/**
 * What a server that cannot be reached looks like (docs/plans/remote-updates.md, D9): not a reload
 * offer, because reloading cannot help, but a screen that says what is wrong in the words of the
 * cause (no connection at all, or this address not answering), retries by itself and goes on
 * without a reload when the server answers. `standalone` stands in for the whole app (this
 * server's own outage: the shell is held out of sight, and the screen is in the top layer); without
 * it, it fills the area it is given (the servers feature, for a remote while the hub answers).
 * `address` is what the person typed to get here; the servers feature will pass a remote's.
 */
export function Unreachable({ address = window.location.host, standalone = false }: { address?: string; standalone?: boolean }) {
  const { t } = useTranslation('shell');
  const { offline, nextAttemptAt, probing } = useReachability();
  const [now, setNow] = useState(() => Date.now());
  const textId = useId();
  useEffect(() => {
    if (nextAttemptAt === null) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [nextAttemptAt]);

  const title = offline ? t('unreachable.offlineTitle') : t('unreachable.title');
  // The tab says what the screen says while it shows. The page behind it (one opened during the
  // outage mounts after this screen) still writes its own title, so each write is remembered and
  // answered with the screen's, and the last one written is what comes back when the screen goes.
  useEffect(() => {
    const own = `${title} · Claudio`;
    let theirs = document.title;
    const claim = () => {
      if (document.title === own) return;
      theirs = document.title;
      document.title = own;
    };
    claim();
    const watch = new MutationObserver(claim);
    watch.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => {
      watch.disconnect();
      document.title = theirs;
    };
  }, [title]);

  const wait = probing || nextAttemptAt === null ? t('unreachable.retrying') : t('unreachable.retryIn', { seconds: formatNumber(secondsUntil(nextAttemptAt, now)) });
  const screen = (
    <Empty
      illustration="offline"
      size="lg"
      heading
      title={title}
      action={
        // Neutral, as in the reference's error state: trying again fixes nothing by itself
        <button type="button" className="btn" onClick={() => reachability.retryNow()}>
          {t('unreachable.retryNow')}
        </button>
      }
    >
      <p className="unreachable-text" id={textId} data-testid="unreachable-text">
        {offline ? t('unreachable.offlineBody') : <Trans t={t} i18nKey="unreachable.body" values={{ address }} components={{ mono: <span className="mono" /> }} />}
      </p>
      {/* Not a live region: a count that changes every second would be read out every second */}
      <p className="unreachable-wait tnum">{wait}</p>
    </Empty>
  );
  return standalone ? (
    <TopLayer label={title} describedBy={textId}>
      <main className="unreachable-standalone">{screen}</main>
    </TopLayer>
  ) : (
    <div className="unreachable" role="region" aria-label={title} aria-describedby={textId} data-testid="unreachable">
      {screen}
    </div>
  );
}
