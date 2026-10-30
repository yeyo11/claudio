import { useQuery } from '@tanstack/react-query';
import { Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TranscriptEntry } from '@claudio/shared';
import { api } from '../../api';
import { useFallbackInterval } from '../../lib/events';
import { openCallInTurn } from '@claudio/chat-ui/lib/liveness';
import { describeCall, lastEventAt } from '../../lib/observe';
import { formatDuration, toMs } from '@claudio/ui/lib/format';
import { ICON_SM } from '@claudio/ui/components/icons';

/** A clock that re-renders its reader every second while `on`: an age on screen has to move. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!on) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

/** The newest part of a chat's transcript, for a chat the page does not already hold. */
export function useChatTail(chatId: string | null, live: boolean): TranscriptEntry[] | null {
  const fallback = useFallbackInterval();
  const { data } = useQuery({
    // Under the chat's own key: the events that say the chat moved refresh it, so it polls only while the feed is down
    queryKey: ['chat', chatId, 'tail'],
    queryFn: () => api.chat(chatId ?? '', { limit: 40 }),
    enabled: Boolean(chatId),
    refetchInterval: live ? fallback : false,
  });
  return data?.entries ?? null;
}

/**
 * What the agent is running right now, and how long since it last did anything. The second is the
 * one that says "stuck": a long command with a fresh last event is working, one with a stale last
 * event is not.
 */
export function ActivityLine({ entries, live }: { entries: TranscriptEntry[] | null; live: boolean }) {
  const { t } = useTranslation('observe');
  const now = useNow(live);
  if (!entries) return null;
  const running = openCallInTurn(entries);
  const last = toMs(lastEventAt(entries));
  const since = toMs(running?.at);
  return (
    <div className="stack-tight obs-now" aria-live="off">
      {live && running ? (
        <p className="obs-running">
          <Terminal {...ICON_SM} />
          <span>
            <span className="strong">{t('activity.runningNow', { tool: running.name })}</span> <span className="mono small break">{describeCall(running.name, running.input)}</span>
            {since !== null && <span className="muted small"> · {t('activity.for', { time: formatDuration(Math.max(0, now - since)) })}</span>}
          </span>
        </p>
      ) : (
        live && <p className="muted small">{t('activity.thinking')}</p>
      )}
      {last !== null && (
        <p className="muted small">{t('activity.lastEvent', { time: formatDuration(Math.max(0, now - last)) })}</p>
      )}
    </div>
  );
}
