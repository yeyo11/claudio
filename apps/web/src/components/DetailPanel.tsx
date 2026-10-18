import { useQueryClient } from '@tanstack/react-query';
import { runsElapsedMs, type AgentTranscript, type ChatActivity, type ChatBackgroundTask, type ChatDetail, type ChatSubagentEntry } from '@claudio/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AgentScope } from '@claudio/chat-ui/lib/agent';
import { displayTitle } from '@claudio/chat-ui/lib/chat-model';
import { branchLive, chatBusy, effectiveBranch } from '@claudio/chat-ui/lib/liveness';
import { useAgentDetail, useChatTasks, useChatTranscript, useTaskOutput, type AgentRef } from '@claudio/chat-ui/lib/chats';
import { keys } from '../api';
import { useDetailPanel, type DetailRef } from '../lib/detail';
import { durationBetween, formatCost, formatDateTime, formatDuration, formatNumber } from '@claudio/ui/lib/format';
import { ActivityTicker } from '@claudio/ui/components/ActivityTicker';
import { CodeBlock } from '@claudio/ui/components/CodeBlock';
import { Collapsible } from '@claudio/ui/components/controls/Collapsible';
import { Dialog } from '@claudio/ui/components/Dialog';
import { ScrollJump } from '@claudio/ui/components/ScrollJump';
import { RichText, Transcript } from '@claudio/chat-ui/components/Transcript';
import { BranchStatus, StateBadge } from '@claudio/chat-ui/components/ChatBadges';
import { ErrorBox, Loading, Tag } from '@claudio/ui/components/ui';

/** A transcript can run to thousands of entries; the newest are what a panel is opened for. */
const RENDERED_ENTRIES = 300;

// Ungrouped, as before: 1234.5k, never 1,234.5k
const tokens = (n: number) =>
  n >= 1000 ? `${formatNumber(n / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })}k` : formatNumber(n, { useGrouping: false });

/** Re-renders every second while `active`, so a running duration ticks. */
function useTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}

/**
 * Keeps a scroller pinned to its end while `enabled` and the reader has not scrolled away from it:
 * the same contract as the run's own transcript, so reading upwards is never fought.
 */
function useFollow<T extends HTMLElement>(dependency: unknown, enabled: boolean) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (enabled && pinned.current && el) el.scrollTop = el.scrollHeight;
  }, [dependency, enabled]);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  return { ref, onScroll };
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="kv kv-narrow detail-facts">{children}</dl>;
}

// ---------- background task ----------

/**
 * A task as the chat it belongs to lets it be read: running only while a process holds that chat.
 * A chat not read yet is assumed held, which is what the task's own record says.
 */
function useTask(chatId: string, taskId: string): { task: ChatBackgroundTask | undefined; running: boolean; loading: boolean } {
  const tasks = useChatTasks(chatId);
  const { chat } = useChatTranscript(chatId);
  const found = tasks.data?.find((t) => t.id === taskId);
  const task = found && chat ? effectiveBranch(chat, found) : found;
  const running = task ? (chat ? branchLive(chat, task) : task.status === 'running') : false;
  return { task, running, loading: tasks.isLoading };
}

function TaskBody({ chatId, taskId }: { chatId: string; taskId: string }) {
  const { t } = useTranslation('components');
  const { open } = useDetailPanel();
  const { task, running, loading } = useTask(chatId, taskId);
  const output = useTaskOutput(chatId, taskId, running);
  useTick(running);
  const follow = useFollow<HTMLDivElement>(output.data?.text, true);

  if (loading) return <Loading />;
  return (
    <>
      {task ? (
        <Facts>
          <dt>{t('detail.status')}</dt>
          <dd>
            <BranchStatus status={task.status} />
            {task.byPerson && (
              <>
                {' '}
                <Tag tone="muted">{t('detail.byYou')}</Tag>
              </>
            )}
          </dd>
          <dt>{t('detail.type')}</dt>
          <dd>{task.kind}</dd>
          <dt>{t('detail.duration')}</dt>
          <dd>{durationBetween(task.startedAt, task.endedAt)}</dd>
          <dt>{t('detail.started')}</dt>
          <dd>{formatDateTime(task.startedAt)}</dd>
          <dt>{t('detail.startedBy')}</dt>
          <dd>
            {task.ownerId ? (
              <>
                <Tag tone="info">{t('detail.fromSubagent')}</Tag>{' '}
                <button type="button" className="link-btn" onClick={() => open({ kind: 'subagent', chatId, agentId: task.ownerId ?? '' })}>
                  {t('detail.openSubagent')}
                </button>
              </>
            ) : (
              <Link to={`/chats/${chatId}`}>{t('detail.theChat')}</Link>
            )}
          </dd>
        </Facts>
      ) : (
        <div className="muted small">{t('detail.taskGone')}</div>
      )}
      {task?.description && <div>{task.description}</div>}
      {task?.command && task.command !== task.description && <CodeBlock code={task.command} lang="bash" />}
      {task?.summary && <div className="muted small">{task.summary}</div>}

      <section className="detail-section detail-section-fill">
        <h3 className="dialog-section">
          {t('detail.output')} {running && <span className="detail-live">{t('detail.live')}</span>}
        </h3>
        {output.isLoading ? (
          <Loading />
        ) : output.error ? (
          <ErrorBox error={output.error} title={t('detail.noOutput')} />
        ) : (
          <div className="detail-output" ref={follow.ref} onScroll={follow.onScroll} data-scroll-root role="region" aria-label={t('detail.taskOutput')} tabIndex={0}>
            {output.data?.cutHead && <div className="muted small">{t('detail.outputCut', { size: Math.round((output.data.bytes ?? 0) / 1024) })}</div>}
            <pre className="task-output">{output.data?.text.trim() || t('detail.noOutputYet')}</pre>
            <ScrollJump screens={1} label="output" />
          </div>
        )}
      </section>
    </>
  );
}

// ---------- subagent and workflow agent ----------

/** The strip's clock: the current run while it works, the active time over every run once it ended. */
function agentDuration(agent: AgentTranscript): string {
  if (agent.runs.length > 0 && (agent.status === 'running' || agent.status === 'waiting')) return formatDuration(runsElapsedMs(agent.runs, Date.now()));
  if (agent.status === 'running') return durationBetween(agent.startedAt, null);
  if (agent.durationMs !== null) return formatDuration(agent.durationMs);
  return durationBetween(agent.startedAt, agent.endedAt);
}

type AgentTarget = Extract<DetailRef, { kind: 'subagent' | 'workflow-agent' }>;

/**
 * What a subagent is doing, as the event feed patches it into whatever already holds the subagent
 * (its chat's page, a subagents list): read from those caches, never fetched for itself. A running
 * one with no open call reads as working, from when it started.
 */
function useSubagentActivity(chatId: string, agentId: string, startedAt: string | null): ChatActivity {
  const client = useQueryClient();
  const find = useCallback((): ChatActivity | null => {
    const held = client.getQueryData<ChatDetail>(keys.chat(chatId))?.chat.children.subagents.find((sub) => sub.id === agentId);
    if (held) return held.activity ?? null;
    for (const [, list] of client.getQueriesData<ChatSubagentEntry[]>({ queryKey: keys.subagents })) {
      const found = Array.isArray(list) ? list.find((sub) => sub.sessionId === chatId && sub.id === agentId) : undefined;
      if (found) return found.activity ?? null;
    }
    return null;
  }, [client, chatId, agentId]);
  const subscribe = useCallback((listener: () => void) => client.getQueryCache().subscribe(listener), [client]);
  const activity = useSyncExternalStore(subscribe, find, () => null);
  return useMemo(() => activity ?? { kind: 'tool', since: startedAt ?? '' }, [activity, startedAt]);
}

/** The panel's first line while a subagent runs: what it is doing now, beside its state. */
function SubagentNow({ chatId, agentId, startedAt }: { chatId: string; agentId: string; startedAt: string | null }) {
  const activity = useSubagentActivity(chatId, agentId, startedAt);
  return <ActivityTicker activity={activity} />;
}

const agentRef = (target: AgentTarget): AgentRef =>
  target.kind === 'subagent'
    ? { chatId: target.chatId, agentId: target.agentId }
    : { chatId: target.chatId, agentId: target.agentId, workflowId: target.workflowId };

function AgentBody({ target }: { target: AgentTarget }) {
  const { t } = useTranslation('components');
  const { open } = useDetailPanel();
  const { chat } = useChatTranscript(target.chatId);
  // A chat not read yet is assumed held; once it is read, nothing runs in one nothing holds
  const alive = chat?.alive ?? true;
  const { data, error, isLoading } = useAgentDetail(agentRef(target), false, alive);
  const running = alive && data?.status === 'running';
  useTick(running);
  const follow = useFollow<HTMLDivElement>(data?.total, running);
  const [showAll, setShowAll] = useState(false);
  const hidden = data && !showAll ? Math.max(0, data.entries.length - RENDERED_ENTRIES) : 0;
  // Held across the tick above: a new array every second would fold the whole transcript again
  const shown = useMemo(() => (data ? (hidden > 0 ? data.entries.slice(hidden) : data.entries) : []), [data, hidden]);

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} title={t('detail.agentFailed')} />;

  const { usage } = data;
  return (
    <div className="detail-scroll" ref={follow.ref} onScroll={follow.onScroll} data-scroll-root>
      <Facts>
        <dt>{t('detail.status')}</dt>
        <dd>
          <BranchStatus status={alive || (data.status !== 'running' && data.status !== 'waiting') ? data.status : 'stopped'} />
          {running && target.kind === 'subagent' && (
            <>
              {' '}
              {/* The open run's start, not the first launch: the gaps between runs never count (one clock with the strip) */}
              <SubagentNow chatId={target.chatId} agentId={target.agentId} startedAt={data.runs.at(-1)?.startedAt ?? data.startedAt} />
            </>
          )}
          {data.background && (
            <>
              {' '}
              <Tag tone="muted">{t('detail.background')}</Tag>
            </>
          )}
        </dd>
        <dt>{t('detail.type')}</dt>
        <dd>{data.subagentType ?? (data.kind === 'workflow' ? t('detail.workflowAgentType') : '—')}</dd>
        {data.kind === 'workflow' && (
          <>
            <dt>{t('detail.workflow')}</dt>
            <dd className="mono">{data.workflowRunId}</dd>
            {data.workflowPhase && (
              <>
                <dt>{t('detail.phase')}</dt>
                <dd>{data.workflowPhase}</dd>
              </>
            )}
          </>
        )}
        <dt>{t('detail.duration')}</dt>
        <dd>{agentDuration(data)}</dd>
        <dt>{t('detail.tokens')}</dt>
        <dd>
          {tokens(usage.total)}
          <span className="muted small">
            {' '}
            {t('detail.tokenBreakdown', {
              input: tokens(usage.input),
              output: tokens(usage.output),
              cacheRead: tokens(usage.cacheRead),
              cacheWrite: tokens(usage.cacheCreation),
            })}
          </span>
        </dd>
        <dt>{t('detail.toolCalls')}</dt>
        <dd>{data.toolCalls}</dd>
        {data.model && (
          <>
            <dt>{t('detail.model')}</dt>
            <dd>{data.model}</dd>
          </>
        )}
        {data.cwd && (
          <>
            <dt>{t('detail.directory')}</dt>
            <dd className="mono break">{data.cwd}</dd>
          </>
        )}
        <dt>{t('detail.started')}</dt>
        <dd>{formatDateTime(data.startedAt)}</dd>
        {data.runs.length > 1 && (
          <>
            <dt>{t('detail.runs')}</dt>
            <dd>{t('detail.runsCount', { count: data.runs.length })}</dd>
          </>
        )}
        <dt>{t('detail.chat')}</dt>
        <dd className="mono break">
          <Link to={`/chats/${data.sessionId}`}>{data.sessionId}</Link>
        </dd>
      </Facts>

      {alive && data.status === 'waiting' && (
        <p className="muted small" role="status">
          {t('detail.waitingBackground')}
        </p>
      )}

      {data.prompt && (
        <section className="detail-section">
          <Collapsible className="fold" defaultOpen title={<span className="tool-name">{t('detail.prompt')}</span>}>
            <RichText text={data.prompt} />
          </Collapsible>
        </section>
      )}

      {data.tasks.length > 0 && (
        <section className="detail-section">
          <h3 className="dialog-section">{t('detail.tasksLaunched', { count: data.tasks.length })}</h3>
          <div className="stack-tight">
            {data.tasks.map((task) => (
              <div key={task.id} className="side-item">
                <div className="side-item-head">
                  <BranchStatus status={task.status} />
                  <span className="muted small">
                    {task.kind} · {durationBetween(task.startedAt, task.endedAt)}
                  </span>
                </div>
                <button type="button" className="link-btn detail-task-link" onClick={() => open({ kind: 'task', chatId: data.sessionId, taskId: task.id })}>
                  {task.description || task.id}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.result && (
        <section className="detail-section">
          <h3 className="dialog-section">{t('detail.result')}</h3>
          <RichText text={data.result} />
        </section>
      )}

      <section className="detail-section">
        <h3 className="dialog-section">
          {t('detail.transcript', { total: data.total })} {running && <span className="detail-live">{t('detail.live')}</span>}
        </h3>
        {data.entries.length === 0 ? (
          <div className="muted small">{t('detail.nothingYet')}</div>
        ) : (
          <div className="detail-transcript">
            {hidden > 0 && (
              <button type="button" className="btn btn-small" onClick={() => setShowAll(true)}>
                {t('detail.showEarlier', { count: hidden })}
              </button>
            )}
            <Transcript entries={shown} />
          </div>
        )}
      </section>
      <ScrollJump screens={1} label="transcript" />
    </div>
  );
}

// ---------- a whole chat ----------

/**
 * A chat read beside the page that links to it, so following an orchestration's worker does not
 * mean leaving the orchestration. The newest entries only: the chat's own page is one link away.
 */
function ChatBody({ chatId }: { chatId: string }) {
  const { t } = useTranslation('components');
  const { query, chat } = useChatTranscript(chatId);
  const working = chat ? chatBusy(chat) : false;
  const follow = useFollow<HTMLDivElement>(query.data?.total, working);
  const held = query.data?.entries;
  const entries = useMemo(() => (held ? held.slice(-RENDERED_ENTRIES) : []), [held]);

  if (query.isLoading) return <Loading />;
  if (!chat || !query.data) return <ErrorBox error={query.error} title={t('detail.chatFailed')} />;

  const path = `/chats/${encodeURIComponent(chat.id)}`;
  return (
    <div className="detail-scroll" ref={follow.ref} onScroll={follow.onScroll} data-scroll-root>
      <Facts>
        <dt>{t('detail.status')}</dt>
        <dd>
          <StateBadge state={chat.state} />
        </dd>
        {chat.model && (
          <>
            <dt>{t('detail.model')}</dt>
            <dd className="mono">{chat.model}</dd>
          </>
        )}
        {chat.executions.at(-1)?.effort && (
          <>
            <dt>{t('detail.effort')}</dt>
            <dd className="mono">{chat.executions.at(-1)?.effort}</dd>
          </>
        )}
        <dt>{t('detail.directory')}</dt>
        <dd className="mono break">{chat.cwd}</dd>
        {chat.cost.usd !== null && chat.cost.usd > 0 && (
          <>
            <dt>{t('detail.cost')}</dt>
            <dd className="tnum">{formatCost(chat.cost.usd)}</dd>
          </>
        )}
        <dt>{t('detail.chat')}</dt>
        <dd>
          <Link to={path}>{t('detail.openChat')}</Link>
        </dd>
      </Facts>
      {chat.activity && <ActivityTicker activity={chat.activity} className="detail-ticker" />}

      <section className="detail-section">
        <h3 className="dialog-section">
          {t('detail.transcript', { total: query.data.total })} {working && <span className="detail-live">{t('detail.live')}</span>}
        </h3>
        {entries.length === 0 ? (
          <div className="muted small">{t('detail.nothingYet')}</div>
        ) : (
          <div className="detail-transcript">
            {query.data.total > entries.length && (
              <Link className="btn btn-small" to={path}>
                {t('detail.earlierInChat', { count: query.data.total - entries.length })}
              </Link>
            )}
            <AgentScope chat={chat}>
              <Transcript entries={entries} />
            </AgentScope>
          </div>
        )}
      </section>
      <ScrollJump screens={1} label="transcript" />
    </div>
  );
}

// ---------- the panel ----------

function ChatTitle({ chatId }: { chatId: string }) {
  const { t } = useTranslation('components');
  const { chat } = useChatTranscript(chatId);
  const title = (chat && displayTitle(chat)) || t('detail.chat');
  return (
    <span className="ellipsis" title={title}>
      {title}
    </span>
  );
}

function TaskTitle({ chatId, taskId }: { chatId: string; taskId: string }) {
  const { t } = useTranslation('components');
  const { task } = useTask(chatId, taskId);
  const title = task?.description || t('detail.backgroundTask');
  return (
    <span className="ellipsis" title={title}>
      {title}
    </span>
  );
}

function AgentTitle({ target }: { target: AgentTarget }) {
  const { t } = useTranslation('components');
  const { data } = useAgentDetail(agentRef(target), false);
  const title = `${target.kind === 'subagent' ? t('detail.subagent') : t('detail.workflowAgent')}${data?.description ? ` · ${data.description}` : ''}`;
  // The panel is narrow on a phone and the description can be a paragraph: the title ends in an
  // ellipsis, and carries the whole of it
  return (
    <span className="ellipsis" title={title}>
      {title}
    </span>
  );
}

/**
 * The side panel for one chat, subagent, background task or workflow agent. One dialog serves them
 * all, so opening a task from a subagent's list swaps the content instead of stacking a second panel.
 */
export default function DetailPanel({ target, onClose }: { target: DetailRef; onClose: () => void }) {
  if (target.kind === 'chat') {
    return (
      <Dialog title={<ChatTitle chatId={target.chatId} />} onClose={onClose} variant="drawer" width={760}>
        <ChatBody key={target.chatId} chatId={target.chatId} />
      </Dialog>
    );
  }
  return (
    <Dialog title={target.kind === 'task' ? <TaskTitle chatId={target.chatId} taskId={target.taskId} /> : <AgentTitle target={target} />} onClose={onClose} variant="drawer" width={760}>
      {target.kind === 'task' ? (
        <TaskBody key={`${target.chatId}:${target.taskId}`} chatId={target.chatId} taskId={target.taskId} />
      ) : (
        <AgentBody key={`${target.chatId}:${target.agentId}`} target={target} />
      )}
    </Dialog>
  );
}
