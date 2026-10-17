import { displayTitle, WORK_ITEM_STATUSES, type CollaboratorsKind, type JournalEntry, type JournalEntryKind, type SharedArtifact, type Project, type SharedChat, type SharedProject, type SharedSubagent, type SharedTranscriptPage, type SyncState, type TranscriptEntry, type WorkItemDetail } from '@claudio/shared';
import { FullText } from '@claudio/ui/components/FullText';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, BookText, Bot, BotOff, Check, Download, FileText, GitCommitVertical, ListTodo, MessagesSquare, NotebookText, Package, Paperclip, SquareKanban, StickyNote, Workflow, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { ReadOnlyBar } from '@claudio/chat-ui/components/ReadOnlyBar';
import { Transcript, type SubagentLink } from '@claudio/chat-ui/components/Transcript';
import { subagentFor } from '@claudio/chat-ui/lib/chat-steps';
import { ActivityTicker } from '@claudio/ui/components/ActivityTicker';
import { Dialog } from '@claudio/ui/components/Dialog';
import { Select } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { Empty, ErrorBox, Skeleton, TabPanel, Tabs, Tag, useTabGroup } from '@claudio/ui/components/ui';
import { formatBytes, formatDate, formatDateTime, formatNumber, timeAgo } from '@claudio/ui/lib/format';
import { PriorityMark, WorkItemKey, WorkItemStatusIcon, WorkItemTypeIcon } from '../../components/work-item-icons';
import { columnMeta, workItemLiveState } from '../../lib/work-items';
import { DocumentView } from '../documents/Pane';
import { dayGroups } from '../home/memory/model';
import { useRoleName } from '../team/RoleAvatar';
import { chatsThatRead, useCopyReadsToday } from '../../lib/api/collaborators';
import { collaboratorsApi, collaboratorsKeys, useSharedWith, type SharedRef } from './shared-data';
import { settingsHref } from '../config/settingsGroups';

/**
 * The Shared tab's sub-tabs, each a kind a teammate's project may carry: the four of §5.3, and the
 * journal and artifacts the copy also holds, in the order the catalog counts them.
 */
export const SHARED_SECTIONS = ['chats', 'memory', 'journal', 'documents', 'artifacts', 'board'] as const satisfies readonly CollaboratorsKind[];

export type SharedSection = (typeof SHARED_SECTIONS)[number];

const SECTION_ICON = { chats: MessagesSquare, memory: BookText, journal: NotebookText, documents: FileText, artifacts: Package, board: SquareKanban } as const;

/** A teammate's project in the address: one person may share two projects that land in this one. */
export const memberValue = (shared: Pick<SharedProject, 'owner' | 'shareId'>): string => `${shared.owner}:${shared.shareId}`;

/** By person, then by install, so the switcher reads as one group per person. */
export function sortMembers(list: readonly SharedProject[]): SharedProject[] {
  return [...list].sort((a, b) => a.ownerName.localeCompare(b.ownerName) || (a.ownerLabel ?? '').localeCompare(b.ownerLabel ?? '') || a.name.localeCompare(b.name));
}

/** The sub-tabs a teammate's project has: the kinds it carries, in the tab's order. */
export const sharedSections = (shared: Pick<SharedProject, 'kinds'>): SharedSection[] => SHARED_SECTIONS.filter((kind) => shared.kinds.includes(kind));

/**
 * The window a transcript is drawn from: every entry fetched so far by its place in the copied
 * transcript, read back as the run that ends at the newest one. A newer latest window that leaves
 * a gap after the pages loaded earlier drops those pages instead of drawing a hole.
 */
export function contiguousTail(byIndex: ReadonlyMap<number, TranscriptEntry>): { from: number; entries: TranscriptEntry[] } {
  if (byIndex.size === 0) return { from: 0, entries: [] };
  let at = Math.max(...byIndex.keys());
  const entries: TranscriptEntry[] = [];
  while (byIndex.has(at)) {
    entries.push(byIndex.get(at) as TranscriptEntry);
    at -= 1;
  }
  return { from: at + 1, entries: entries.reverse() };
}

/** A change to the address: each key set, or dropped when null. The history keeps the one before it. */
function usePatchParams(): (patch: Record<string, string | null>) => void {
  const [, setParams] = useSearchParams();
  return (patch) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
}

/**
 * A project's Shared tab: what teammates who share this project's key (or were linked to it by
 * hand) let this install read. A member switcher and the sync state head it; the sub-tabs reuse
 * the project's own views, read only. Nothing here is the person's own work, so nothing here
 * carries the energy border, and nothing read here joins the person's own chat list or counts.
 */
export function SharedView({ project }: { project: Project }) {
  const { t } = useTranslation(['collaborators', 'home']);
  const { projects: shared } = useSharedWith(project.id);
  const members = useMemo(() => sortMembers(shared), [shared]);
  const [params] = useSearchParams();
  const change = usePatchParams();
  const current = members.find((member) => memberValue(member) === params.get('from')) ?? members[0];

  if (!current) return <Empty title={t('shared.gone')} />;

  return (
    <div className="stack shared-view">
      <div className="toolbar shared-head">
        {members.length > 1 ? (
          <Select
            aria-label={t('shared.member')}
            value={memberValue(current)}
            options={members.map((member) => ({ value: memberValue(member), label: memberLabel(member), hint: <span className="mono">{member.shareKey}</span> }))}
            onChange={(value) => change({ from: value, section: null, chat: null, file: null, agent: null })}
          />
        ) : (
          <strong>{memberLabel(current)}</strong>
        )}
        <SyncLine sync={current.sync} />
        <AgentReadsLine shared={current} />
      </div>
      <SharedSections shared={current} />
    </div>
  );
}

/**
 * A teammate's project read from the copy this install holds: one sub-tab per kind it carries, each
 * the project's own view with nothing to change. The Shared tab of a cloned project and the
 * read-only view of one not cloned here (`/collaborators/shared/:owner/:shareId`) both draw it; what
 * is open lives in the address (`section`, `chat`, `file`, `agent`), so a link reopens it.
 */
export function SharedSections({ shared }: { shared: SharedProject }) {
  const { t } = useTranslation('collaborators');
  const [params] = useSearchParams();
  const change = usePatchParams();
  const group = useTabGroup();
  const sections = sharedSections(shared);
  const section = sections.find((id) => id === params.get('section')) ?? sections[0];
  const ref: SharedRef = { owner: shared.owner, shareId: shared.shareId };

  if (section === undefined) return <Empty title={t('shared.nothing', { name: shared.ownerName })} />;
  return (
    <>
      <Tabs
        label={t('shared.sections')}
        group={group}
        value={section}
        tabs={sections.map((id) => {
          const Icon = SECTION_ICON[id];
          const count = shared.counts[id];
          return {
            id,
            label: (
              <>
                <Icon {...ICON_SM} />
                {t(`shared.tabs.${id}`)}
                {count ? <span className="count">{formatNumber(count)}</span> : null}
              </>
            ),
          };
        })}
        onChange={(id) => change({ section: id, chat: null, file: null, agent: null })}
      />
      <TabPanel group={group} tab={section} className="tab-panel" key={`${memberValue(shared)}:${section}`}>
        {section === 'chats' && <SharedChats source={ref} from={shared.ownerName} />}
        {section === 'memory' && <SharedMemory source={ref} />}
        {section === 'journal' && <SharedJournal source={ref} from={shared.ownerName} />}
        {section === 'documents' && <SharedDocuments source={ref} from={shared.ownerName} />}
        {section === 'artifacts' && <SharedArtifacts source={ref} />}
        {section === 'board' && <SharedBoardView source={ref} />}
      </TabPanel>
    </>
  );
}

const memberLabel = (member: Pick<SharedProject, 'ownerName' | 'ownerLabel'>): string => (member.ownerLabel ? `${member.ownerName} · ${member.ownerLabel}` : member.ownerName);

/**
 * How current this copy is, in the words of the Collaborators page: `ok` while the owner streams
 * it, `idle` while the owner is away, and neutral between pulls. Always a word with the colour.
 */
export function SyncLine({ sync }: { sync: SyncState }) {
  const { t } = useTranslation('collaborators');
  const ago = sync.lastSyncedAt ? timeAgo(sync.lastSyncedAt) : null;
  return (
    <span className="inline-form small">
      {sync.state === 'live' && <Tag tone="ok">{t('shared.sync.live')}</Tag>}
      {sync.state === 'synced' && <span className="muted">{ago ? t('shared.sync.synced', { ago }) : t('shared.sync.pending')}</span>}
      {sync.state === 'offline' && <Tag tone="idle">{ago ? t('shared.sync.offline', { ago }) : t('shared.sync.offlineNever')}</Tag>}
      {sync.state === 'pending' && <span className="muted">{t('shared.sync.pending')}</span>}
      {sync.error && <Tag tone="bad">{t('shared.sync.failed')}</Tag>}
    </span>
  );
}

/**
 * What agents of this install did with the copy today (docs/plans/collaborators-agent-access.md):
 * how many chats read it, linked to the full list in Settings → Security, or that its sharer lets no
 * agent read it. Nothing while no agent has read it today: a zero is not news.
 */
export function AgentReadsLine({ shared }: { shared: SharedProject }) {
  const reads = useCopyReadsToday(shared, shared.agentsMayRead);
  return <AgentReadsLineView agentsMayRead={shared.agentsMayRead} chats={reads.data ? chatsThatRead(reads.data.reads) : 0} />;
}

/** The line from its numbers, so a test draws each case without a server. */
export function AgentReadsLineView({ agentsMayRead, chats }: { agentsMayRead: boolean; chats: number }) {
  const { t } = useTranslation('collaborators');
  if (!agentsMayRead) {
    return (
      <span className="small muted collab-share-where" data-testid="collab-agents-forbidden">
        <BotOff {...ICON_SM} aria-hidden /> {t('agentReads.forbidden')}
      </span>
    );
  }
  if (chats === 0) return null;
  return (
    <Link to={settingsHref('access', { detail: 'agent-reads' })} className="small muted collab-share-where" data-testid="collab-agent-reads">
      <Bot {...ICON_SM} aria-hidden /> {t('agentReads.today', { count: chats })}
    </Link>
  );
}

/** An address on this tab with one more thing open, so a link opens it and a middle click opens a tab. */
function useHref(): (key: string, value: string | null, ...drop: string[]) => string {
  const [params] = useSearchParams();
  return (key, value, ...drop) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    for (const other of drop) next.delete(other);
    return `?${next.toString()}`;
  };
}

function SharedChats({ source, from }: { source: SharedRef; from: string }) {
  const { t } = useTranslation('collaborators');
  const [params] = useSearchParams();
  const chats = useQuery({ queryKey: collaboratorsKeys.records(source, 'chats'), queryFn: ({ signal }) => collaboratorsApi.chats(source, { signal }) });
  const open = params.get('chat');
  if (chats.error) return <ErrorBox error={chats.error} />;
  if (!chats.data) return <Skeleton rows={4} height={18} />;
  const chat = open ? chats.data.find((c) => c.id === open) : undefined;
  if (chat) return <SharedChatView source={source} chat={chat} from={from} />;
  if (chats.data.length === 0) return <Empty icon={MessagesSquare} title={t('shared.empty.chats', { name: from })} />;
  return (
    <div className="card scard crow-list shared-chats">
      <ul className="list-plain" aria-label={t('shared.tabs.chats')}>
        {chats.data.map((c) => (
          <SharedChatRow key={c.id} chat={c} />
        ))}
      </ul>
    </div>
  );
}

/** A chat's title is its first prompt while its name is the one Claudio generated, as in the person's own list */
const sharedChatTitle = (chat: Pick<SharedChat, 'id' | 'title' | 'firstPrompt'>): string =>
  (chat.title ? displayTitle({ id: chat.id, title: chat.title, firstPrompt: chat.firstPrompt }) : chat.firstPrompt) || chat.id.slice(0, 8);

/** A teammate's chat in the list. One an agent is working in now carries the live rail and the braille spinner by its verb. */
function SharedChatRow({ chat }: { chat: SharedChat }) {
  const { t } = useTranslation('collaborators');
  const href = useHref();
  const title = sharedChatTitle(chat);
  return (
    <li className={`crow ${chat.live ? 'live-rail' : ''}`.trimEnd()} data-id={chat.id}>
      <Link to={href('chat', chat.id)} className="crow-link">
        <span className="crow-mark">{chat.live ? <Spinner className="crow-spinner" /> : <span className="dot crow-dot-rest" aria-hidden />}</span>
        <span className="crow-main">
          <span className="crow-title-row">
            <FullText className="crow-title-text">{title}</FullText>
          </span>
          <span className="crow-sub">
            {chat.live && chat.activity ? (
              <ActivityTicker activity={chat.activity} className="crow-ticker" />
            ) : chat.live ? (
              <span className="crow-word is-live">{t('shared.live')}</span>
            ) : null}
            <span className="crow-sub-wide">
              <span className="crow-id">{chat.id.slice(0, 6)}</span>
              {chat.branch && <span>{chat.branch}</span>}
              {chat.model && <span>{chat.model}</span>}
              <span>{t('shared.messages', { count: chat.messageCount, n: formatNumber(chat.messageCount) })}</span>
            </span>
          </span>
        </span>
        <span className="crow-cell crow-project" />
        <span className="crow-cell crow-origin" />
        <span className="crow-cell crow-context" />
        <span className="crow-cell crow-cost" />
        <time className={`crow-time ${chat.live ? 'is-live' : ''}`.trim()} dateTime={chat.updatedAt ?? undefined}>
          {timeAgo(chat.updatedAt)}
        </time>
      </Link>
    </li>
  );
}

/**
 * A copied transcript as it is drawn: the latest window, kept fresh by the `collaborators.*` events,
 * and earlier windows loaded as the reader scrolls up, joined by their place in the transcript.
 */
function useCopiedTranscript(queryKey: readonly unknown[], page: (before: number | null, signal?: AbortSignal) => Promise<SharedTranscriptPage>) {
  const latest = useQuery({ queryKey, queryFn: ({ signal }) => page(null, signal) });
  const [byIndex, setByIndex] = useState<ReadonlyMap<number, TranscriptEntry>>(new Map());
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const merge = useCallback(
    (next: SharedTranscriptPage) =>
      setByIndex((before) => {
        const map = new Map(before);
        next.entries.forEach((entry, i) => map.set(next.from + i, entry));
        return map;
      }),
    [],
  );
  useEffect(() => {
    if (latest.data) merge(latest.data);
  }, [latest.data, merge]);
  const tail = useMemo(() => contiguousTail(byIndex), [byIndex]);

  const earlier = () => {
    if (loadingEarlier || tail.from === 0 || tail.entries.length === 0) return;
    setLoadingEarlier(true);
    void page(tail.from)
      .then(merge)
      .catch(() => undefined)
      .finally(() => setLoadingEarlier(false));
  };
  return { latest, tail, earlier };
}

/**
 * One teammate's chat: its transcript as it was copied, with no composer and the read-only bar in
 * its place. A chat still running on their machine keeps growing here, its last step carrying the
 * live rail; earlier pages load as the reader scrolls up. A delegation whose subagent was copied
 * with the chat opens it in the side panel, as a local chat's does.
 */
function SharedChatView({ source, chat, from }: { source: SharedRef; chat: SharedChat; from: string }) {
  const { t } = useTranslation('collaborators');
  const href = useHref();
  const [params, setParams] = useSearchParams();
  const { latest, tail, earlier } = useCopiedTranscript(collaboratorsKeys.transcript(source, chat.id), (before, signal) => collaboratorsApi.transcript(source, chat.id, before, { signal }));
  const live = latest.data?.live ?? chat.live;

  const agents = chat.subagents;
  const setAgent = useCallback(
    (agentId: string | null) =>
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (agentId === null) next.delete('agent');
          else next.set('agent', agentId);
          return next;
        },
        { replace: agentId === null },
      ),
    [setParams],
  );
  const subagents = useMemo<SubagentLink | undefined>(() => sharedSubagentLink(agents, setAgent), [agents, setAgent]);
  const openAgent = agents?.find((agent) => agent.workflowRunId === null && agent.agentId === params.get('agent'));

  return (
    <section className="stack shared-chat" aria-label={sharedChatTitle(chat)}>
      <div className="toolbar">
        <Link to={href('chat', null, 'agent')} className="btn btn-small btn-quiet">
          <ArrowLeft {...ICON_SM} />
          {t('shared.allChats')}
        </Link>
        <strong className="grow break">{sharedChatTitle(chat)}</strong>
        {live && chat.activity ? <ActivityTicker activity={chat.activity} /> : live ? <span className="crow-word is-live">{t('shared.live')}</span> : null}
        <span className="mono small muted">{chat.id.slice(0, 8)}</span>
      </div>
      {latest.error ? (
        <ErrorBox error={latest.error} />
      ) : !latest.data ? (
        <Skeleton rows={6} height={18} />
      ) : (
        <Transcript entries={tail.entries} working={live} pinToBottom={live} onReachTop={earlier} subagents={subagents} readOnly />
      )}
      <ReadOnlyBar from={from} />
      {openAgent && <SharedAgentPanel source={source} chatId={chat.id} agent={openAgent} onClose={() => setAgent(null)} />}
    </section>
  );
}

/**
 * Which copied subagent a delegation started, matched as a local chat matches its own (on what the
 * call asked for); none when the copy lists no subagent, so no call offers to open one.
 */
export function sharedSubagentLink(agents: readonly SharedSubagent[] | undefined, open: (agentId: string) => void): SubagentLink | undefined {
  const list = (agents ?? []).filter((agent) => agent.workflowRunId === null).map((agent) => ({ id: agent.agentId, description: agent.description ?? '', kind: agent.subagentType ?? 'agent' }));
  return list.length > 0 ? { find: (input) => subagentFor(input, list)?.id ?? null, open } : undefined;
}

/**
 * A teammate's subagent, read in the side panel a local one opens in: what it was, then its
 * transcript as copied. The copy does not say whether it is still working, so nothing here moves.
 */
function SharedAgentPanel({ source, chatId, agent, onClose }: { source: SharedRef; chatId: string; agent: SharedSubagent; onClose: () => void }) {
  const { t } = useTranslation('components');
  const { latest, tail, earlier } = useCopiedTranscript(collaboratorsKeys.agentTranscript(source, chatId, agent), (before, signal) =>
    collaboratorsApi.agentTranscript(source, chatId, agent, before, { signal }),
  );
  return (
    <Dialog
      title={
        <span className="ellipsis">
          {agent.workflowRunId ? t('detail.workflowAgent') : t('detail.subagent')}
          {agent.description ? ` · ${agent.description}` : ''}
        </span>
      }
      onClose={onClose}
      variant="drawer"
      width={760}
    >
      <div className="detail-scroll" data-scroll-root>
        <dl className="kv kv-narrow detail-facts">
          <dt>{t('detail.type')}</dt>
          <dd>{agent.subagentType ?? (agent.workflowRunId ? t('detail.workflowAgentType') : '—')}</dd>
          {agent.workflowRunId && (
            <>
              <dt>{t('detail.workflow')}</dt>
              <dd className="mono">{agent.workflowRunId}</dd>
            </>
          )}
          {agent.workflowPhase && (
            <>
              <dt>{t('detail.phase')}</dt>
              <dd>{agent.workflowPhase}</dd>
            </>
          )}
        </dl>
        <section className="detail-section">
          <h3 className="dialog-section">{t('detail.transcript', { total: latest.data?.total ?? 0 })}</h3>
          {latest.error ? (
            <ErrorBox error={latest.error} title={t('detail.agentFailed')} />
          ) : !latest.data ? (
            <Skeleton rows={6} height={18} />
          ) : tail.entries.length === 0 ? (
            <div className="muted small">{t('detail.nothingYet')}</div>
          ) : (
            <div className="detail-transcript">
              <Transcript entries={tail.entries} onReachTop={earlier} readOnly />
            </div>
          )}
        </section>
      </div>
    </Dialog>
  );
}

function SharedMemory({ source }: { source: SharedRef }) {
  const { t } = useTranslation('collaborators');
  const [params] = useSearchParams();
  const href = useHref();
  const files = useQuery({ queryKey: collaboratorsKeys.records(source, 'memory'), queryFn: ({ signal }) => collaboratorsApi.memory(source, { signal }) });
  if (files.error) return <ErrorBox error={files.error} />;
  if (!files.data) return <Skeleton rows={4} height={18} />;
  if (files.data.length === 0) return <Empty icon={BookText} title={t('shared.empty.memory')} />;
  const open = files.data.find((file) => file.name === params.get('file')) ?? files.data.find((file) => file.isIndex) ?? files.data[0];
  return (
    <div className="master-detail">
      <div className="master">
        <ul className="master-list" aria-label={t('shared.tabs.memory')}>
          {files.data.map((file) => {
            const on = file.name === open?.name;
            return (
              <li key={file.name}>
                <Link to={href('file', file.name)} replace aria-current={on ? 'true' : undefined} className={`master-item ${on ? 'master-item-on' : ''}`.trimEnd()}>
                  <span className="master-item-head">
                    <span className="strong break mono">{file.name}</span>
                    {file.isIndex ? <Tag tone="active">{t('shared.index')}</Tag> : file.type && <Tag>{file.type}</Tag>}
                  </span>
                  {file.description && <span className="small muted break">{file.description}</span>}
                  {file.updatedAt && <span className="small muted">{timeAgo(file.updatedAt)}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="detail">{open && <DocumentView content={open.content} />}</div>
    </div>
  );
}

function SharedDocuments({ source, from }: { source: SharedRef; from: string }) {
  const { t } = useTranslation('collaborators');
  const [params] = useSearchParams();
  const href = useHref();
  const docs = useQuery({ queryKey: collaboratorsKeys.records(source, 'documents'), queryFn: ({ signal }) => collaboratorsApi.documents(source, { signal }) });
  const open = docs.data?.find((doc) => doc.path === params.get('file')) ?? docs.data?.[0];
  // The content is fetched from the owner on first open, then kept by its hash: it never changes
  const content = useQuery({
    queryKey: collaboratorsKeys.blob(source, open?.sha256 ?? ''),
    queryFn: ({ signal }) => collaboratorsApi.blob(source, open?.sha256 ?? '', { signal }),
    enabled: Boolean(open),
    staleTime: Infinity,
  });
  if (docs.error) return <ErrorBox error={docs.error} />;
  if (!docs.data) return <Skeleton rows={4} height={18} />;
  if (docs.data.length === 0) return <Empty icon={FileText} title={t('shared.empty.documents')} />;
  return (
    <div className="master-detail master-detail-files">
      <div className="master">
        <ul className="master-list" aria-label={t('shared.tabs.documents')}>
          {docs.data.map((doc) => {
            const on = doc.path === open?.path;
            return (
              <li key={doc.path}>
                <Link to={href('file', doc.path)} replace aria-current={on ? 'true' : undefined} className={`master-item ${on ? 'master-item-on' : ''}`.trimEnd()}>
                  <span className="strong break">{doc.title ?? doc.path}</span>
                  {doc.title && <span className="small muted mono break">{doc.path}</span>}
                  {doc.updatedAt && <span className="small muted">{timeAgo(doc.updatedAt)}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="detail stack">
        <ReadOnlyBar from={from}>{t('shared.workingCopy', { name: from })}</ReadOnlyBar>
        {content.error ? <ErrorBox error={content.error} /> : content.data === undefined ? <Skeleton rows={6} height={14} /> : <DocumentView content={content.data} />}
      </div>
    </div>
  );
}

/** The teammate's board as a picture of it: the same columns and cards, with nothing to drag, create or edit. */
function SharedBoardView({ source }: { source: SharedRef }) {
  const { t } = useTranslation('collaborators');
  const { t: tt } = useTranslation('tasks');
  const board = useQuery({ queryKey: collaboratorsKeys.records(source, 'board'), queryFn: ({ signal }) => collaboratorsApi.board(source, { signal }) });
  if (board.error) return <ErrorBox error={board.error} />;
  if (!board.data) return <Skeleton rows={4} height={18} />;
  if (board.data.items.length === 0) return <Empty icon={SquareKanban} title={t('shared.empty.board')} />;
  const items = board.data.items;
  return (
    <div className="workitem-board shared-board">
      {WORK_ITEM_STATUSES.map((status) => {
        const column = items.filter((item) => item.status === status);
        const label = tt(columnMeta(status).label);
        return (
          <section key={status} className="workitem-col" aria-label={label} data-status={status}>
            <div className="workitem-col-head">
              <WorkItemStatusIcon status={status} decorative />
              <FullText className="workitem-col-name">{label}</FullText>
              <span className="workitem-col-count">
                <b>{formatNumber(column.length)}</b>
              </span>
            </div>
            <div className="workitem-col-body">
              {column.map((item) => (
                <SharedCard key={item.id} item={item} />
              ))}
              {column.length === 0 && <div className="workitem-col-slot">{tt('column.empty')}</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function SharedCard({ item }: { item: WorkItemDetail }) {
  const working = item.status !== 'done' && workItemLiveState(item) === 'working';
  return (
    <div className={`workitem-card ${item.status === 'done' ? 'is-done' : ''} ${working ? 'live-rail' : ''}`.trim()} role="article" aria-label={`${item.key} · ${item.title}`} data-status={item.status}>
      <div className="workitem-card-top">
        <WorkItemTypeIcon type={item.type} />
        <WorkItemKey value={item.key} />
        <span className="grow" />
        {item.status !== 'done' && <PriorityMark priority={item.priority} />}
      </div>
      <p className="workitem-card-title">{item.title}</p>
    </div>
  );
}

const JOURNAL_ICON: Record<JournalEntryKind, LucideIcon> = { closed: Check, decision: GitCommitVertical, memory: BookText, note: StickyNote };

/**
 * Who wrote a teammate's journal entry: their agent's role, an agent, or the teammate. Never "you":
 * nothing in the copy is the reader's.
 */
export function journalAuthor(entry: Pick<JournalEntry, 'author'>, from: string, roleName: (role: string) => string, agent: string): string {
  if (entry.author.kind === 'person') return from;
  return entry.author.role ? roleName(entry.author.role) : agent;
}

/** The teammate's journal, newest first and by day, as the person's own reads; nothing to add or delete, and no link into their tasks. */
function SharedJournal({ source, from }: { source: SharedRef; from: string }) {
  const { t } = useTranslation(['collaborators', 'home']);
  const roleName = useRoleName();
  const journal = useQuery({ queryKey: collaboratorsKeys.records(source, 'journal'), queryFn: ({ signal }) => collaboratorsApi.journal(source, { signal }) });
  if (journal.error) return <ErrorBox error={journal.error} />;
  if (!journal.data) return <Skeleton rows={4} height={16} />;
  if (journal.data.length === 0) return <Empty icon={NotebookText} title={t('shared.empty.journal')} />;
  const groups = dayGroups([...journal.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), new Date());
  const dayLabel = (day: string) => (day === 'today' ? t('home:memoryTab.journal.today') : day === 'yesterday' ? t('home:memoryTab.journal.yesterday') : formatDate(day));
  return (
    <div className="card memory-card shared-journal">
      <div className="journal-list">
        {groups.map((group) => (
          <section key={group.day} className="journal-day" aria-label={dayLabel(group.day)}>
            <h3 className="section-label journal-day-label">{dayLabel(group.day)}</h3>
            <ul className="journal-entries">
              {group.entries.map((entry) => {
                const Icon = JOURNAL_ICON[entry.kind];
                return (
                  <li key={entry.id} className="history-entry journal-entry" data-kind={entry.kind}>
                    <span className="history-icon" aria-hidden>
                      <span>
                        <Icon size={11} strokeWidth={2} />
                      </span>
                    </span>
                    <span className="history-text">
                      <span>
                        {entry.kind === 'closed' && entry.item ? <span className="journal-key">{entry.item.key}</span> : null}
                        {entry.kind === 'closed' && entry.item ? ' ' : null}
                        {entry.kind === 'closed'
                          ? `${t('home:memoryTab.journal.closed')} · ${entry.text}`
                          : entry.kind === 'decision'
                            ? t('home:memoryTab.journal.decision', { text: entry.text })
                            : entry.kind === 'memory'
                              ? t('home:memoryTab.journal.memory', { text: entry.text })
                              : entry.text}
                      </span>
                      <span className="history-cause">
                        {[t(`home:memoryTab.journal.kind.${entry.kind}`), journalAuthor(entry, from, roleName, t('home:memoryTab.journal.agent')), entry.documentPath].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>
                      {timeAgo(entry.createdAt)}
                    </time>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

const ARTIFACT_ICON: Record<SharedArtifact['kind'], LucideIcon> = { orchestration: Workflow, upload: Paperclip, plan: ListTodo };

/** Where an artifact is named in the address: its kind and id, since an upload and a plan may share an id. */
export const artifactValue = (artifact: Pick<SharedArtifact, 'kind' | 'id'>): string => `${artifact.kind}:${artifact.id}`;

/** When an artifact last changed: an orchestration when it ended, an upload and a plan when they were made. */
const artifactTime = (artifact: SharedArtifact): string => (artifact.kind === 'orchestration' ? artifact.updatedAt : artifact.createdAt);

/**
 * The teammate's artifacts: orchestration results, the uploads of their shared chats and plan
 * drafts, newest first. A result or an objective is read as Markdown; an upload is saved from the
 * owner (fetched on first open). Nothing here launches, edits or continues anything.
 */
function SharedArtifacts({ source }: { source: SharedRef }) {
  const { t } = useTranslation('collaborators');
  const [params] = useSearchParams();
  const href = useHref();
  const artifacts = useQuery({ queryKey: collaboratorsKeys.records(source, 'artifacts'), queryFn: ({ signal }) => collaboratorsApi.artifacts(source, { signal }) });
  if (artifacts.error) return <ErrorBox error={artifacts.error} />;
  if (!artifacts.data) return <Skeleton rows={4} height={18} />;
  if (artifacts.data.length === 0) return <Empty icon={Package} title={t('shared.empty.artifacts')} />;
  const list = [...artifacts.data].sort((a, b) => artifactTime(b).localeCompare(artifactTime(a)));
  const open = list.find((artifact) => artifactValue(artifact) === params.get('file')) ?? list[0];
  return (
    <div className="master-detail shared-artifacts">
      <div className="master">
        <ul className="master-list" aria-label={t('shared.tabs.artifacts')}>
          {list.map((artifact) => {
            const on = open !== undefined && artifactValue(artifact) === artifactValue(open);
            const Icon = ARTIFACT_ICON[artifact.kind];
            return (
              <li key={artifactValue(artifact)}>
                <Link to={href('file', artifactValue(artifact))} replace aria-current={on ? 'true' : undefined} className={`master-item ${on ? 'master-item-on' : ''}`.trimEnd()}>
                  <span className="master-item-head">
                    <span className="strong break">{artifact.name}</span>
                    <Tag>
                      <Icon {...ICON_SM} aria-hidden /> {t(`shared.artifacts.${artifact.kind}`)}
                    </Tag>
                  </span>
                  <span className="small muted">{timeAgo(artifactTime(artifact))}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="detail stack">{open && <ArtifactDetail source={source} artifact={open} />}</div>
    </div>
  );
}

function ArtifactDetail({ source, artifact }: { source: SharedRef; artifact: SharedArtifact }) {
  const { t } = useTranslation('collaborators');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  if (artifact.kind === 'orchestration') {
    return artifact.finalResult.trim() ? <DocumentView content={artifact.finalResult} /> : <p className="small muted">{t('shared.artifacts.noResult')}</p>;
  }
  if (artifact.kind === 'plan') {
    return (
      <>
        <p className="small muted tnum">{t('shared.artifacts.tasks', { count: artifact.taskCount, n: formatNumber(artifact.taskCount) })}</p>
        {artifact.objective ? <DocumentView content={artifact.objective} /> : <p className="small muted">{t('shared.artifacts.noObjective')}</p>}
      </>
    );
  }
  const save = () => {
    setSaving(true);
    setFailed(null);
    void collaboratorsApi
      .blobFile(source, artifact.sha256)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = artifact.name;
        a.click();
        // The click has handed the file to the browser; the address is not needed after it
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }, setFailed)
      .finally(() => setSaving(false));
  };
  return (
    <>
      <dl className="kv kv-narrow">
        <dt>{t('shared.artifacts.type')}</dt>
        <dd className="mono">{artifact.mediaType}</dd>
        <dt>{t('shared.artifacts.size')}</dt>
        <dd className="tnum">{formatBytes(artifact.sizeBytes)}</dd>
        <dt>{t('shared.artifacts.chat')}</dt>
        <dd className="mono">{artifact.chatId.slice(0, 8)}</dd>
      </dl>
      <div>
        <button type="button" className="btn" disabled={saving} onClick={save}>
          <Download {...ICON_SM} /> {t('shared.artifacts.download')}
        </button>
      </div>
      {failed ? <ErrorBox error={failed} title={t('shared.artifacts.downloadFailed')} /> : null}
    </>
  );
}
