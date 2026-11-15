import type { OrchestrationSummary, Project, ProviderMove } from '@claudio/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { accountLabel } from '@claudio/chat-ui/lib/account-choice';
import { displayTitle } from '@claudio/chat-ui/lib/chat-model';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Skeleton } from '@claudio/ui/components/ui';
import { api, keys, useOrchestrations } from '../../../api';
import { WaitWhen } from '../../../components/WaitLine';
import { useAccountView } from '../../../lib/accounts';
import { useProviderLabel } from '../../../lib/provider-status';
import { resetWhen } from '../../../lib/reset-when';

/** The orchestration a task wait belongs to: its subject is `<orchestration>:<task>`. */
const orchestrationOf = (move: Pick<ProviderMove, 'subjectId'>): string => move.subjectId.slice(0, Math.max(move.subjectId.lastIndexOf(':'), 0));

/** Open waits are few and change slowly; a person's Stop or Run now refetches them at once (`WaitActions`). */
const POLL_MS = 30_000;

export interface OpenWait {
  move: ProviderMove;
  /** The orchestration it belongs to, for a task's wait; null for a chat's */
  orchestration: Pick<OrchestrationSummary, 'id' | 'name'> | null;
}

/**
 * Every wait for a usage limit that is open now, across chats, flow runs and orchestrations: the
 * rows of `GET /limits/waits` that are `waiting` or `resuming`, narrowed to the project a Home is
 * about. Oldest first, so the one that has waited longest leads.
 */
export function useOpenWaits(project: Project | null): { waits: OpenWait[]; loading: boolean } {
  const waiting = useQuery({ queryKey: keys.limitWaits('waiting'), queryFn: ({ signal }) => api.limitWaits({ state: 'waiting' }, { signal }), refetchInterval: POLL_MS });
  const resuming = useQuery({ queryKey: keys.limitWaits('resuming'), queryFn: ({ signal }) => api.limitWaits({ state: 'resuming' }, { signal }), refetchInterval: POLL_MS });
  const orchestrations = useOrchestrations();
  const moves = [...(waiting.data ?? []), ...(resuming.data ?? [])]
    .filter((move) => !project || move.projectId === project.id)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const waits = moves.map((move) => ({ move, orchestration: move.subjectKind === 'task' ? (orchestrations.data?.find((o) => o.id === orchestrationOf(move)) ?? null) : null }));
  return { waits, loading: waiting.isLoading || resuming.isLoading };
}

/** One open wait on Home: what is waiting, since when, when it goes on or looks again, and the way to it. */
function WaitRow({ wait: { move, orchestration } }: { wait: OpenWait }) {
  const { t } = useTranslation(['home', 'components', 'common']);
  const label = useProviderLabel();
  const accounts = useAccountView();
  // A task's wait is the graph's; the other kinds ran in a chat, whose title and account say the rest
  const chatId = move.subjectKind === 'task' ? null : move.fromChat;
  const [chat] = useQueries({ queries: [{ queryKey: ['home', 'wait-chat', chatId], queryFn: () => api.chat(chatId ?? '', { limit: 1 }), enabled: chatId !== null, staleTime: 60_000 }] });
  const account = chat.data?.chat.account ? accounts?.accounts.find((a) => a.id === chat.data?.chat.account) : undefined;
  const loading = chatId !== null && chat.isLoading;
  const title: ReactNode = orchestration ? orchestration.name : chat.data ? displayTitle(chat.data.chat) : t('home:widgets.waits.untitled');
  const to = move.subjectKind === 'task' ? `/orchestration/${encodeURIComponent(orchestrationOf(move))}` : `/chats/${encodeURIComponent(move.fromChat)}`;
  const view = { provider: move.fromProvider, resetsAt: move.resetsAt, nextLookAt: move.nextLookAt ?? null, state: move.state === 'resuming' ? ('resuming' as const) : ('waiting' as const) };
  return (
    <li className="inbox-row">
      <span className="inbox-icon" aria-hidden>
        <Clock {...ICON_SM} />
      </span>
      <div className="inbox-main">
        {/* A chat's title and account arrive with its read: a skeleton holds the two lines, so the row does not jump */}
        {loading ? (
          <Skeleton rows={2} height={14} />
        ) : (
          <>
            <div className="inbox-what">
              <strong>{title}</strong> <span className="faint">{t(`home:widgets.waits.kind.${move.subjectKind}`)}</span>
            </div>
            <div className="small muted wait-row-detail">
              {t('components:limitWait.title', { name: label(move.fromProvider) })}
              {' · '}
              <WaitWhen wait={view} />
              {` · ${t('home:widgets.waits.since', { when: resetWhen(move.at) })}`}
              {account && ` · ${t('components:limitWait.account', { account: accountLabel(account) })}`}
            </div>
          </>
        )}
      </div>
      <Link to={to} className="btn btn-small">
        {t('common:actions.open')}
      </Link>
    </li>
  );
}

/** The open waits as a list inside "In progress"; nothing at all when none is open. */
export function OpenWaitList({ waits }: { waits: OpenWait[] }) {
  const { t } = useTranslation('home');
  if (waits.length === 0) return null;
  return (
    <ul className="inbox-list attention-list wait-list" aria-label={t('widgets.waits.title')}>
      {waits.map((wait) => (
        <WaitRow key={wait.move.id} wait={wait} />
      ))}
    </ul>
  );
}
