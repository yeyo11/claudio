import type { Chat, Execution } from '@claudio/shared';
import { FullText } from '@claudio/ui/components/FullText';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { agentBranch, branchElapsed } from '@claudio/chat-ui/lib/chat-branches';
import { branchLive, effectiveBranch } from '@claudio/chat-ui/lib/liveness';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ActivityTicker } from '@claudio/ui/components/ActivityTicker';
import { AnimatedNumber } from '@claudio/ui/components/AnimatedNumber';
import { BranchStatus, ControlBadge, LastOutcome, OriginBadge, OutcomeBadge, ProviderBadge, StateBadge } from '@claudio/chat-ui/components/ChatBadges';
import { upperFirst, useAgentName } from '@claudio/chat-ui/lib/agent';
import { modeLabel } from '@claudio/chat-ui/lib/wire-words';
import { Collapsible } from '@claudio/ui/components/controls/Collapsible';
import { HealthBadge, HealthPanel, InterruptButton, isStepIn } from '../../components/observe/Health';
import { EnvironmentBody } from '../../components/EnvironmentPanel';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ProgressRing } from '@claudio/ui/components/motion';
import { CopyButton, Tag } from '@claudio/ui/components/ui';
import { ClampText } from '../../components/ClampText';
import { WorkflowCard } from '../../components/WorkflowCard';
import { api } from '../../api';
import { contextLevel, contextShare, formatPercent, formatTokens, roleOf } from '@claudio/chat-ui/lib/chat-model';
import { useDetailPanel } from '../../lib/detail';
import { durationBetween, formatCost, formatDuration, formatDateTime, formatHour, formatNumber, shortPath, timeAgo, toMs } from '@claudio/ui/lib/format';
import { useLimitWindowName } from '../../lib/limit-words';
import { healthReason } from '../../lib/server-strings';
import { compactState } from './context-model';
import { CompactButton, useContextControls } from './ContextPanel';
import { Section } from './Section';
import { useLimitState } from './LimitBanner';

export { Section } from './Section';

/** Dollars, or the words for a cost nobody reported: it is never estimated, so it is never zero either. */
function useMoney(): (usd: number | null) => string {
  const { t } = useTranslation('chat');
  return (usd) => (usd === null ? t('side.notAvailable') : formatCost(usd));
}

// ---------- context, tokens and cost ----------

export function UsageCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['chat', 'work', 'common', 'chats']);
  const agent = useAgentName();
  const money = useMoney();
  const { context, cost } = chat;
  const controls = useContextControls();
  const compacted = context?.compactedSince;
  // A placeholder message carries no model and no tokens: nothing to show for it
  const rows = cost.tokens.filter((entry) => entry.total > 0);
  return (
    <>
      <Section title={t('badges.context.inUse')} className="insp-context">
        <div className="insp-context-body">
          <ContextGauge chat={chat} />
          {context ? (
            <div className="small">
              <AnimatedNumber className="tnum" value={context.used} format={formatNumber} />{' '}
              {context.window !== null
                ? t('side.usage.tokensOfWindow', { window: formatNumber(context.window) })
                : t('side.usage.tokensWindowUnknown')}
            </div>
          ) : (
            <div className="small muted">{t('badges.context.none')}</div>
          )}
          {/* A line the compaction leaves: when, and from what to what */}
          {compacted && (
            <div className="small muted insp-context-note tnum">
              {compacted.postTokens !== null
                ? t('chats:context.lastCompacted', { when: timeAgo(compacted.at), pre: formatTokens(compacted.preTokens), post: formatTokens(compacted.postTokens) })
                : t('chats:context.lastCompactedNoPost', { when: timeAgo(compacted.at), pre: formatTokens(compacted.preTokens) })}
            </div>
          )}
          {context && (
            <div className="insp-context-actions">
              <button type="button" className="btn btn-small" onClick={controls.openPanel}>
                {t('chats:context.actions.breakdown')}
              </button>
              <CompactButton chat={chat} onClick={controls.openCompact} />
            </div>
          )}
        </div>
      </Section>
      <Section
        title={t('chat:runView.cost')}
        actions={
          cost.usd === null ? (
            <span className="small muted">{money(null)}</span>
          ) : (
            <AnimatedNumber className="insp-cost grad-text" value={cost.usd} format={formatCost} />
          )
        }
      >
        {cost.usd === null && <div className="small muted">{t('side.usage.costNotReported', { agent: upperFirst(agent) })}</div>}
        {rows.length > 0 && (
          <table className="chat-tokens">
            <caption className="sr-only">{t('side.usage.tokensCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('chat:shared.model')}</th>
                <th scope="col">{t('side.usage.input')}</th>
                <th scope="col">{t('side.usage.output')}</th>
                <th scope="col">{t('side.usage.cache')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.model ?? 'unknown'}>
                  <th scope="row" className="mono">
                    {row.model ?? t('common:status.unknown')}
                  </th>
                  <td>{formatTokens(row.input)}</td>
                  <td>{formatTokens(row.output)}</td>
                  <td>{formatTokens(row.cacheRead + row.cacheCreation)}</td>
                </tr>
              ))}
            </tbody>
            {rows.length > 1 && (
              <tfoot>
                <tr>
                  <th scope="row">{t('side.usage.total')}</th>
                  <td>{formatTokens(cost.total.input)}</td>
                  <td>{formatTokens(cost.total.output)}</td>
                  <td>{formatTokens(cost.total.cacheRead + cost.total.cacheCreation)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
        <div className="small muted">{t('side.usage.subagentsNote')}</div>
      </Section>
    </>
  );
}

/**
 * The context window as a ring with the share in it: the brand's sweep while there is room, and
 * the warning colours as it fills, with the words for them in its accessible value.
 */
function ContextGauge({ chat }: { chat: Chat }) {
  const { t } = useTranslation('chat');
  const share = contextShare(chat);
  if (share === null || !chat.context) return null;
  const level = contextLevel(share);
  const clamped = Math.min(1, Math.max(0, share));
  const detail = t('badges.context.detail', { used: formatNumber(chat.context.used), window: chat.context.window === null ? '?' : formatNumber(chat.context.window) });
  const note = level === 'full' ? t('badges.context.aboutToCompact') : level === 'warn' ? t('badges.context.fillingUp') : '';
  return (
    <span
      className="insp-context-ring"
      role="meter"
      aria-label={t('badges.context.inUse')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuetext={note ? `${detail}, ${note}` : detail}
    >
      <ProgressRing value={clamped} size={60} stroke={5} tone={level === 'full' ? 'bad' : level === 'warn' ? 'warn' : 'accent'}>
        {formatPercent(share)}
      </ProgressRing>
    </span>
  );
}

// ---------- executions ----------

/** `previous` is the segment before it: a different model there is a switch the chat should say, whatever caused it. */
function ExecutionRow({ execution, previous }: { execution: Execution; previous: Execution | undefined }) {
  const { t } = useTranslation(['chat', 'work', 'common']);
  const money = useMoney();
  return (
    <li className="side-item exec">
      <div className="side-item-head">
        <OutcomeBadge outcome={execution.outcome} />
        <span className="small strong">{money(execution.costUsd)}</span>
      </div>
      <div className="meta">
        <span title={formatDateTime(execution.startedAt)}>{timeAgo(execution.startedAt)}</span>
        <span>{execution.endedAt
            ? t('side.executions.lasted', { duration: durationBetween(execution.startedAt, execution.endedAt) })
            : t('side.executions.up', { duration: durationBetween(execution.startedAt, null) })}</span>
        <span>{t('side.executions.turns', { count: execution.turns })}</span>
        <span>{modeLabel(execution.permissionMode)}</span>
        {execution.model && <span className="mono">{execution.model}</span>}
        {execution.effort && <span className="mono">{execution.effort}</span>}
        {execution.model && previous?.model && previous.model !== execution.model && (
          <span className="text-warn">{t('side.executions.switchedFrom', { model: previous.model })}</span>
        )}
        {execution.maxBudgetUsd !== null && <span>{t('side.executions.budget', { amount: money(execution.maxBudgetUsd) })}</span>}
      </div>
      {execution.error && (
        <div className="alert alert-bad small">
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden className="alert-icon" />
          <div className="alert-body">
            <span className="sr-only">{t('side.executions.errorPrefix')} </span>
            <ClampText text={execution.error} lines={3} className="break" />
          </div>
        </div>
      )}
    </li>
  );
}

export function ExecutionsCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation('chat');
  const newestFirst = [...chat.executions].reverse();
  // Newest first, so the segment before an execution is the next row
  return (
    <Section title={t('side.executions.title', { n: chat.executions.length })}>
      {newestFirst.length === 0 ? (
        <div className="muted small">{t('side.executions.empty')}</div>
      ) : (
        <ol className="stack-tight list-plain">
          {newestFirst.map((execution, i) => (
            <ExecutionRow key={execution.id} execution={execution} previous={newestFirst[i + 1]} />
          ))}
        </ol>
      )}
    </Section>
  );
}

// ---------- branches ----------

export function BranchesCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['chat', 'work', 'common']);
  const { open } = useDetailPanel();
  const { workflows } = chat.children;
  // A branch of a chat nothing holds reads stopped, whatever its record still says
  const subagents = chat.children.subagents.map((sub) => ({ ...effectiveBranch(chat, sub), tasks: sub.tasks.map((task) => effectiveBranch(chat, task)) }));
  const backgroundTasks = chat.children.backgroundTasks.map((task) => effectiveBranch(chat, task));
  const count = subagents.length + backgroundTasks.length + workflows.length;
  return (
    <Section title={t('side.branches.title', { n: count })}>
      {count === 0 ? (
        <div className="muted small">{t('side.branches.empty')}</div>
      ) : (
        <div className="stack">
          {subagents.length > 0 && (
            <section aria-label={t('side.branches.subagents')} className="stack-tight">
              <h3 className="dialog-section">{t('chat:runView.subagents', { n: subagents.length })}</h3>
              {subagents.map((sub) => (
                <div key={sub.id} className="side-item side-item-flat">
                  <div className="side-item-head">
                    <BranchStatus status={sub.status} />
                    <span className="muted small">
                      {sub.kind} · {formatDuration(branchElapsed(agentBranch(chat, sub), Date.now()))}
                    </span>
                  </div>
                  <button type="button" className="link-btn detail-task-link" onClick={() => open({ kind: 'subagent', chatId: chat.id, agentId: sub.id })}>
                    <span className="clamp-2 clamp-text is-clamped">{sub.description || sub.kind}</span>
                  </button>
                  {/* What it is doing now; one with no open call reads as working, from when it started */}
                  {branchLive(chat, sub) && <ActivityTicker activity={sub.activity ?? { kind: 'tool', since: sub.startedAt }} />}
                  {sub.cwd && (
                    <FullText className="mono small muted ellipsis side-literal" full={sub.cwd}>
                      {shortPath(sub.cwd, 40)}
                    </FullText>
                  )}
                  {/* What it launched hangs off it: the chat's own background tasks are only the ones the chat started */}
                  {sub.tasks.map((task) => (
                    <div key={task.id} className="side-item-head">
                      <BranchStatus status={task.status} />
                      <button type="button" className="link-btn detail-task-link" onClick={() => open({ kind: 'task', chatId: chat.id, taskId: task.id })}>
                        {task.description || task.id}
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )}
          {backgroundTasks.length > 0 && (
            <section aria-label={t('side.branches.backgroundTasks')} className="stack-tight">
              <h3 className="dialog-section">{t('chat:runView.backgroundTasks', { n: backgroundTasks.length })}</h3>
              {backgroundTasks.map((task) => (
                <div key={task.id} className="side-item side-item-flat">
                  <div className="side-item-head">
                    <BranchStatus status={task.status} />
                    <span className="muted small">
                      {task.kind} · {durationBetween(task.startedAt, task.endedAt)}
                      {task.ownerId ? ` · ${t('side.branches.fromSubagent')}` : ''}
                    </span>
                  </div>
                  <button type="button" className="link-btn detail-task-link" onClick={() => open({ kind: 'task', chatId: chat.id, taskId: task.id })}>
                    {task.description || task.id}
                  </button>
                  {task.summary && <div className="muted small clamp-text clamp-2 is-clamped">{task.summary}</div>}
                </div>
              ))}
            </section>
          )}
          {workflows.length > 0 && (
            <section aria-label={t('side.branches.workflows')} className="stack-tight">
              <h3 className="dialog-section">{t('chat:runView.workflows', { n: workflows.length })}</h3>
              {workflows.map((workflow) => (
                <WorkflowCard key={workflow.id} workflow={workflow} chatId={chat.id} alive={chat.alive} />
              ))}
            </section>
          )}
        </div>
      )}
    </Section>
  );
}

// ---------- health ----------

/**
 * What core says of the chat's health, in one list worst first: the signals a person can step in on
 * with their actions (cancel the command, send a written hint) and the facts of the chat itself.
 * Interrupt sits in the header, since it belongs to the section and not to a signal.
 */
export function HealthCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation('chat');
  const controls = useContextControls();
  const compact = compactState(chat);
  const { health } = chat;
  const live = Boolean(chat.execution);
  const stepIn = health.signals.some(isStepIn) || health.proposal?.status === 'proposed';
  return (
    <Section
      title={t('side.health.title')}
      actions={
        <div className="obs-health-actions">
          <HealthBadge health={health} />
          {live && stepIn && <InterruptButton chatId={chat.id} />}
        </div>
      }
    >
      {health.signals.length === 0 ? (
        <ul className="chat-notes">
          <li className="chat-note chat-note-ok">
            <CircleCheck {...ICON_SM} />
            <span>
              <span className="sr-only">{t('side.health.levelSaid', { level: t('side.health.level.ok') })} </span>
              {healthReason(health)}
            </span>
          </li>
        </ul>
      ) : null}
      <HealthPanel
        health={health}
        chatId={chat.id}
        live={live}
        badge={false}
        interrupt={false}
        all
        sendHint={(text) => api.hintChat(chat.id, { text })}
        // The context signal is the one a compaction answers
        extra={(signal) => (signal.kind === 'context' && compact.available ? <CompactButton chat={chat} onClick={controls.openCompact} /> : null)}
      />
    </Section>
  );
}

// ---------- facts ----------

/** The inspector's "Limit" row, only while the chat sits at its provider's limit or waits for the reset. */
function LimitRow({ chat }: { chat: Chat }) {
  const { t } = useTranslation('chats');
  const windowOf = useLimitWindowName();
  const state = useLimitState(chat);
  const at = toMs(state.resetsAt);
  if (state.phase === 'none') return null;
  const waiting = state.phase === 'waiting';
  return (
    <>
      <dt>{t('limit.row.title')}</dt>
      <dd>
        <Tag tone="warn">{waiting ? t('limit.row.waiting') : t('limit.row.reached')}</Tag> {windowOf(state.status?.limit?.window)}
        <div className="small muted tnum">{at === null ? t('limit.row.resetUnknown') : t(waiting ? 'limit.row.resumes' : 'limit.row.until', { at: formatHour(at) })}</div>
      </dd>
    </>
  );
}

export function FactsCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['chat', 'chats', 'work', 'common']);
  const agent = useAgentName();
  const live = chat.execution;
  const origin = chat.orchestration ? `${chat.orchestration.name} · ${chat.orchestration.taskName ?? t(`view.role.${roleOf(chat.orchestration)}`)}` : t(`badges.origin.${chat.origin}`);
  return (
    <Section title={t('side.facts.title')}>
      {/* What the header's pill merges, said one by one, with the outcome of the last execution */}
      <div className="chips">
        <StateBadge state={chat.state} />
        <ControlBadge control={chat.control} />
        <LastOutcome chat={chat} />
        <OriginBadge origin={chat.origin} label={origin} />
      </div>
      <dl className="insp-facts">
        <dt>{t('chats:provider.agent')}</dt>
        <dd>
          <ProviderBadge provider={chat.provider} label={agent} />
        </dd>
        <dt>{t('chat:runView.permissions')}</dt>
        <dd>
          <span className="badge insp-mode">{modeLabel(live?.permissionMode ?? chat.executions.at(-1)?.permissionMode ?? t('chat:shared.default'))}</span>
        </dd>
        <LimitRow chat={chat} />
        <dt>{t('chat:shared.model')}</dt>
        <dd className="mono">{live?.model ?? chat.model ?? t('chat:shared.default')}</dd>
        <dt>{t('chat:shared.project')}</dt>
        <dd>{chat.project ? chat.project.name : t('side.facts.noProject')}</dd>
        <dt>{t('chat:runView.directory')}</dt>
        <dd className="mono">{chat.cwd ? <FullText className="ellipsis side-literal" full={chat.cwd}>{shortPath(chat.cwd, 40)}</FullText> : '—'}</dd>
        {chat.worktree && (
          <>
            <dt>{t('side.facts.worktree')}</dt>
            <dd className="mono">
              <FullText className="ellipsis side-literal" full={chat.worktree.path}>
                {chat.worktree.branch ?? chat.worktree.name ?? shortPath(chat.worktree.path, 40)}
              </FullText>
            </dd>
          </>
        )}
        <dt>{t('chat:runView.session')}</dt>
        <dd className="mono insp-id">
          <FullText className="ellipsis">{chat.id}</FullText> <CopyButton text={chat.id} label={t('view.copyId')} />
        </dd>
        {chat.providerSessionId && chat.providerSessionId !== chat.id && (
          <>
            <dt>{t('chats:provider.nativeSession', { agent })}</dt>
            <dd className="mono insp-id">
              <FullText className="ellipsis">{chat.providerSessionId}</FullText> <CopyButton text={chat.providerSessionId} label={t('chats:provider.copyNativeSession')} />
            </dd>
          </>
        )}
        <dt>{t('side.facts.messages')}</dt>
        <dd>{t('view.messages', { count: chat.messageCount })}</dd>
        {live && (
          <>
            <dt>{t('chat:runView.prompts')}</dt>
            <dd>{t('chat:runView.promptsHost')}</dd>
          </>
        )}
        {chat.derivedFrom && (
          <>
            <dt>{t('side.facts.forkedFrom')}</dt>
            <dd>
              <Link to={`/chats/${chat.derivedFrom.chatId}`} className="mono">
                {chat.derivedFrom.chatId.slice(0, 8)}
              </Link>{' '}
              <span className="muted small">{timeAgo(chat.derivedFrom.at)}</span>
            </dd>
          </>
        )}
        {chat.orchestration && (
          <>
            <dt>{t('chat:runView.orchestration')}</dt>
            <dd>
              <Link to={`/orchestration/${chat.orchestration.id}`}>{chat.orchestration.name}</Link>
              <div className="small muted">{chat.orchestration.taskName ?? t(`view.role.${roleOf(chat.orchestration)}`)}</div>
            </dd>
          </>
        )}
        <dt>{t('chat:runView.started')}</dt>
        <dd>{formatDateTime(chat.startedAt)}</dd>
        <dt>{t('side.facts.updated')}</dt>
        <dd>{formatDateTime(chat.updatedAt)}</dd>
        {chat.cliVersion && (
          <>
            <dt>CLI</dt>
            <dd>{chat.cliVersion}</dd>
          </>
        )}
      </dl>
    </Section>
  );
}

export function EnvironmentCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['chat', 'work', 'common']);
  const agent = useAgentName();
  return (
    <Collapsible
      className="fold insp-fold"
      title={
        <>
          <span className="fold-card-title">{t('chat:runView.loadedByAgent', { agent })}</span>
          <span className="small muted">{t('chat:runView.loadedHint')}</span>
        </>
      }
    >
      {chat.environment ? <EnvironmentBody env={chat.environment} /> : <div className="small muted">{t('side.facts.environmentEmpty', { agent })}</div>}
    </Collapsible>
  );
}
