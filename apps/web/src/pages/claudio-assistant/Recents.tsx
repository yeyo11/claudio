import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { displayTitle, STATE_LABEL } from '@claudio/chat-ui/lib/chat-model';
import { timeAgo } from '@claudio/ui/lib/format';
import { api } from '../../api';
import { chatStateWord } from '../../lib/chat-state-word';
import { useFallbackInterval } from '../../lib/feed';
import { useMinute } from '../../lib/minute';

/** What the page asks for, and the most it ever shows: a phone shows fewer of the same list */
const LIMIT = 5;
const LIMIT_NARROW = 3;

/**
 * "Recientes", last on the entry: the assistant's own chats, newest first, each with its title, its
 * state as a word and how long ago it moved. The word stands still (no spinner, ticker or rail): the
 * page shows no live figures, and what is running is on Home. It renders nothing while the first read
 * is pending and when there are no chats yet, so nothing above it moves when it arrives.
 */
export function Recents({ narrow }: { narrow: boolean }) {
  const { t } = useTranslation('assistant');
  const fallback = useFallbackInterval();
  // Under `['chats', …]`, so the events that refresh the chat lists refresh this one too
  const recent = useQuery({
    queryKey: ['chats', { assistant: true, limit: LIMIT }],
    queryFn: ({ signal }) => api.chats({ assistant: true, limit: LIMIT }, { signal }),
    refetchInterval: fallback,
  });
  useMinute();
  if (recent.isPending) return null;
  const heading = (
    <div className="as-recents-head">
      <h2 id="as-recents-label" className="section-label">
        {t('claudio.recent.title')}
      </h2>
      {!recent.isError && (
        <Link className="as-recents-all" to="/chats?assistant=1" aria-label={t('claudio.recent.allLabel')}>
          {t('claudio.recent.all')}
        </Link>
      )}
    </div>
  );
  if (recent.isError) {
    return (
      <section className="as-recents-section" aria-labelledby="as-recents-label">
        {heading}
        <p className="as-recents-error">
          {t('claudio.recent.error')}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void recent.refetch()}>
            {t('claudio.recent.retry')}
          </button>
        </p>
      </section>
    );
  }
  const chats = recent.data.slice(0, narrow ? LIMIT_NARROW : LIMIT);
  if (chats.length === 0) return null;
  return (
    <section className="as-recents-section" aria-labelledby="as-recents-label">
      {heading}
      <ul className="as-recents">
        {chats.map((chat) => {
          const state = chatStateWord(chat);
          // The title is the prompt cut at a hundred characters; the tooltip has its whole first line
          const full = chat.firstPrompt?.split('\n')[0]?.trim() || displayTitle(chat);
          return (
            <li key={chat.id}>
              {/* The title is cut to one line; the tooltip holds the whole of it (a link cannot carry `title=`) */}
              <Tooltip content={full}>
                <Link className="as-recent" to={`/chats/${chat.id}`}>
                  <span className="as-recent-title ellipsis">{displayTitle(chat)}</span>
                  <span className="as-recent-meta">
                    {state ? (
                      <>
                        <span className={`as-recent-word is-${state.tone}`}>{state.word}</span>
                        <span className="as-recent-sep" aria-hidden>
                          {' · '}
                        </span>
                      </>
                    ) : (
                      <span className="sr-only">{STATE_LABEL.idle}</span>
                    )}
                    <span className="as-recent-time">{timeAgo(chat.updatedAt)}</span>
                  </span>
                </Link>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
