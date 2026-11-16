import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveWork } from '@claudio/shared';
import { Dialog } from '@claudio/ui/components/Dialog';
import { parseLiveWork } from '../lib/updates';

/** What the page answers the desktop shell; `apps/desktop/src/quit.ts` reads it with `parseQuitAnswer` */
export interface QuitReply {
  answer: 'keep' | 'stop' | 'cancel';
  /** The system notice the shell shows once the window has gone and the work goes on, in the person's language */
  notice?: { title: string; body: string };
}

interface Asking {
  live: LiveWork;
  reply: (reply: QuitReply) => void;
}

/** "2 chats are working, 1 orchestration is running": what goes on, or stops, after the window */
export function useQuitLiveSentence(): (live: LiveWork) => string {
  const { t } = useTranslation('shell');
  return (live) =>
    [
      live.working ? t('quit.live.working', { count: live.working }) : null,
      live.waiting ? t('quit.live.waiting', { count: live.waiting }) : null,
      live.running ? t('quit.live.running', { count: live.running }) : null,
      live.terminals ? t('quit.live.terminals', { count: live.terminals }) : null,
    ]
      .filter(Boolean)
      .join(', ');
}

/**
 * The quit question of the desktop app (docs/plans/survive-restarts.md, D1). Quitting with work live
 * asks whether it goes on in the background, which is the default and the focused answer, or stops
 * with the app. Mounted once in the shell; in a browser, or under a shell that asks natively, it
 * registers nothing and draws nothing.
 */
export function QuitQuestion() {
  const { t } = useTranslation('shell');
  const sentence = useQuitLiveSentence();
  const [asking, setAsking] = useState<Asking | null>(null);
  // The open question, so a new one (or the page going) settles the old one instead of leaving the shell waiting
  const open = useRef<Asking | null>(null);
  // Read when the answer is given: the notice follows the language on screen then
  const notice = useRef({ title: '', body: '' });
  notice.current = { title: t('quit.noticeTitle'), body: t('quit.noticeBody') };

  useEffect(() => {
    const subscribe = typeof window !== 'undefined' ? window.claudioDesktop?.onQuitAsk : undefined;
    if (!subscribe) return;
    const unsubscribe = subscribe(
      (raw) =>
        new Promise<QuitReply>((resolve) => {
          const live = parseLiveWork(raw);
          open.current?.reply({ answer: 'cancel' });
          // Nothing readable to show: a cancel loses nothing, and the shell can ask again
          if (!live) return resolve({ answer: 'cancel' });
          const next: Asking = {
            live,
            reply: (reply) => {
              if (open.current === next) open.current = null;
              setAsking((current) => (current === next ? null : current));
              resolve(reply);
            },
          };
          open.current = next;
          setAsking(next);
        }),
    );
    return () => {
      unsubscribe();
      open.current?.reply({ answer: 'cancel' });
    };
  }, []);

  if (!asking) return null;
  const cancel = () => asking.reply({ answer: 'cancel' });
  return (
    <Dialog
      title={t('quit.title')}
      onClose={cancel}
      // Wide enough for the three answers on one line in both languages
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={cancel}>
            {t('quit.cancel')}
          </button>
          <button type="button" className="btn btn-danger" data-quit="stop" onClick={() => asking.reply({ answer: 'stop' })}>
            {t('quit.stop')}
          </button>
          <button type="button" className="btn btn-primary" data-quit="keep" data-autofocus onClick={() => asking.reply({ answer: 'keep', notice: notice.current })}>
            {t('quit.keep')}
          </button>
        </>
      }
    >
      <p>{t('quit.body', { live: sentence(asking.live) })}</p>
    </Dialog>
  );
}
