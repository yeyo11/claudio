import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, GitFork, Hourglass, Lock, MessageSquare, TriangleAlert, Undo2, X } from 'lucide-react';
import { entryText, type Chat, type ChatDetail, type ChatPendingAttachment, type EditStep, type TranscriptEntry } from '@claudio/shared';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ActivityTicker } from '@claudio/ui/components/ActivityTicker';
import { activityTarget } from '@claudio/ui/lib/live';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { useDeleteChat } from '@claudio/chat-ui/components/ChatDelete';
import { PermissionPrompts } from '@claudio/chat-ui/components/PermissionPrompts';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { AnimatePresence, motion } from '@claudio/ui/components/motion';
import { useMotionLevel } from '@claudio/ui/lib/motion';
import { useSmoothText } from '@claudio/chat-ui/lib/smooth-text';
import { useToast } from '@claudio/ui/components/Toast';
import { endsWithAssistant, preloadMarkdown, StreamingEntry, Transcript, WorkingLine, type MessageActions, type BranchLinks, type SubagentLink, type TranscriptEdits } from '@claudio/chat-ui/components/Transcript';
import { LiveBranches } from '@claudio/chat-ui/components/LiveBranches';
import type { Branch } from '@claudio/chat-ui/lib/chat-branches';
import { FindBar, useFindFocus, useFindHighlight, useTranscriptFind, type FindTarget } from '@claudio/chat-ui/components/TranscriptSearch';
import { entryParam } from '../components/changes/steps/steps-model';
import { GUARD_NOTICE_TEXT } from '../lib/guards';
import '../components/changes/steps/at-jump.css';
import { Empty, ErrorBox, PageHeader, Skeleton, usePageTitle } from '@claudio/ui/components/ui';
import { api, ApiRequestError, keys, useProjects } from '../api';
import { tickerActivity } from '@claudio/chat-ui/lib/chat-live';
import { displayTitle } from '@claudio/chat-ui/lib/chat-model';
import { subagentFor, transcriptRows, type TranscriptRow } from '@claudio/chat-ui/lib/chat-steps';
import { appendStreamed, dropOptimistic, optimisticEntry, type ChatStreamStore } from '@claudio/chat-ui/lib/chat-stream';
import { useChatStream, useChatTranscript, useStreamSnapshot } from '@claudio/chat-ui/lib/chats';
import { useDetailPanel } from '../lib/detail';
import { taskPath } from '../lib/work-items';
import { AgentScope } from '@claudio/chat-ui/lib/agent';
import { useChatUi } from '@claudio/chat-ui/lib/context';
import { Composer, type ComposerKind } from '@claudio/chat-ui/composer/Composer';
import { AssistantGreeting } from './claudio-assistant/Greeting';
import { ChatLoading } from './chat/ChatLoading';
import { ChatHeader, type HeaderActions } from './chat/Header';
import { LimitStopped } from './chat/LimitStopped';
import { BlockedComposer, LimitBanner, useLimitState } from './chat/LimitBanner';
import { ContextControlProvider } from './chat/ContextPanel';
import { Inspector, useInspector } from './chat/Inspector';
import { PartOf } from './chat/PartOf';
import { useQueuedMessages } from '@claudio/chat-ui/composer/queued';
import { HISTORY_LIMIT } from '@claudio/chat-ui/composer/history';
import { useStickToBottom } from '@claudio/chat-ui/composer/stick-to-bottom';
import { useTurnSpacer } from '@claudio/chat-ui/composer/turn-spacer';
import { useChatItemLinks, WorkItemPartOf } from './chat/WorkItemLinks';

/** How long the entry a link opened the chat at stays marked */
const AT_MARK_MS = 2400;

/**
 * The end of the conversation that moves while the agent writes: the block being streamed and the
 * ticker under it. The only part of the page that reads the stream's text, so it is the only part
 * rendered again on every frame of it.
 */
const SmoothEntry = memo(function SmoothEntry({ stream, text, continued }: { stream: ChatStreamStore; text: string; continued: boolean }) {
  const level = useMotionLevel();
  const ending = useStreamSnapshot(stream, (snapshot) => snapshot.ending);
  const onRevealing = useCallback((revealing: boolean) => stream.setRevealing(revealing), [stream]);
  const shown = useSmoothText(text, level !== 'off', ending, onRevealing);
  const onHeight = useCallback((height: number) => void (stream.lastBlockHeight = height), [stream]);
  return shown ? <StreamingEntry block="text" text={shown} continued={continued} fade={level === 'full'} onHeight={onHeight} /> : null;
});

const LiveTail = memo(function LiveTail({ stream, chat, continued }: { stream: ChatStreamStore; chat: Chat; continued: boolean }) {
  const partial = useStreamSnapshot(stream, (snapshot) => snapshot.partial);
  const block = partial?.block;
  const since = partial?.since;
  // The ticker only changes with the block, not with each character of it
  const activity = useMemo(() => tickerActivity(chat, block && since !== undefined ? { block, since } : null), [chat, block, since]);
  return (
    <>
      {partial && partial.text && (partial.block === 'text' ? (
        // Keyed by the block, so a new one starts a new reveal; thinking shows raw (already truncated)
        <SmoothEntry key={partial.since} stream={stream} text={partial.text} continued={continued} />
      ) : (
        <StreamingEntry block={partial.block} text={partial.text} continued={continued} />
      ))}
      {activity && (
        <div className="chat-now" data-find-ignore>
          {chat.state === 'working' ? <WorkingLine detail={activityTarget(activity)} /> : <ActivityTicker activity={activity} showElapsed={Boolean(activity.since)} />}
        </div>
      )}
    </>
  );
});

/** One chat: its conversation, what it has cost, what it has run and delegated, and what can be done with it now. */
export function ChatView() {
  useEffect(() => preloadMarkdown(), []);
  const { t } = useTranslation(['chat', 'work', 'common', 'chats']);
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detail = useDetailPanel();
  const [sidechains, setSidechains] = useState(false);
  const [forking, setForking] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const inspector = useInspector();

  const transcript = useChatTranscript(id, sidechains);
  const { chat } = transcript;
  const { agentNameFor } = useChatUi();
  const stream = useChatStream(id, Boolean(chat?.execution));
  const connected = useStreamSnapshot(stream, (snapshot) => snapshot.connected);
  const writing = useStreamSnapshot(stream, (snapshot) => snapshot.partial?.block === 'text');
  const { follow, setFollow, jumpToLatest, hold } = useStickToBottom(scroller, Boolean(chat));
  const { queued, add: queueMessage, drop: dropQueued, pending: isPending } = useQueuedMessages(chat, transcript.items, stream, transcript.query.dataUpdatedAt);
  // Words and files handed back to the composer: a message the agent never read
  const [restore, setRestore] = useState<{ text: string; attachments: ChatPendingAttachment[]; at: number } | null>(null);
  // A message still waiting for the turn is a card over the box, so it is not also a row here
  const pendingless = useMemo(() => (queued.length === 0 ? transcript.items : transcript.items.filter((entry) => !isPending(entry))), [transcript.items, queued.length, isPending]);
  const items = pendingless;
  // The person's words are drawn at the end of the conversation the moment Send is pressed; the undo takes them out again if the send fails
  // The question the view is scrolled to the top for (CHAT-14); a resume's guess is replaced by the stored entry under another id
  const [sentAnchor, setAnchor] = useState<string | null>(null);
  const anchor = useMemo(() => {
    if (!sentAnchor || !sentAnchor.startsWith('optimistic-') || items.some((entry) => entry.uuid === sentAnchor)) return sentAnchor;
    return items.findLast((entry) => entry.role === 'user' && !entry.isSidechain)?.uuid ?? sentAnchor;
  }, [sentAnchor, items]);
  const spacerRef = useTurnSpacer(scroller, anchor);
  const onSending = useCallback(
    ({ id: messageId, text }: { id: string | null; text: string }) => {
      const uuid = messageId ?? `optimistic-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
      const entry = optimisticEntry(uuid, text);
      const cached = [keys.chat(id, false), keys.chat(id, true)];
      for (const key of cached) queryClient.setQueryData<ChatDetail>(key, (page) => (page ? appendStreamed(page, entry).page : page));
      setAnchor(uuid);
      setFollow(true);
      return () => {
        setAnchor(null);
        for (const key of cached) queryClient.setQueryData<ChatDetail>(key, (page) => (page ? dropOptimistic(page, uuid) : page));
      };
    },
    [id, queryClient, setFollow],
  );
  const limit = useLimitState(chat);
  usePageTitle(chat ? t('view.pageTitle', { title: displayTitle(chat) }) : t('view.pageTitleFallback'));

  // Another chat starts at its end, with nothing half-typed for a copy of the last one
  useEffect(() => {
    setFollow(true);
    setAnchor(null);
    setForking(false);
  }, [id, setFollow]);

  // A block that has been stored leaves the stream once the transcript shows it, in the same
  // frame, so it neither blinks out nor shows twice; one that went quiet goes with it. By the
  // entry's id, not its object: every read of the transcript hands back new objects for the same
  // entries, and a pause in a block's text is not its end
  const last = transcript.items.at(-1);
  const lastKey = last ? last.uuid || `#${transcript.from + transcript.items.length}` : '';
  useLayoutEffect(() => stream.settle(), [lastKey, stream]);

  const find = useTranscriptFind({
    scope: ['chat', id, sidechains],
    search: useCallback((q: string) => api.searchChat(id, sidechains, q), [id, sidechains]),
  });
  // `?at=` (a step's "See it in the conversation"): the entry to open the chat at. It is read once
  // the chat is here, then dropped from the address, so a reload opens the chat at its end
  const [search, setSearch] = useSearchParams();
  const atParam = search.get('at');
  const [jump, setJump] = useState<FindTarget | null>(null);
  const loaded = Boolean(chat);
  useEffect(() => {
    if (!loaded || atParam === null) return;
    const at = entryParam(atParam);
    // From the address as it is now: `setSearch` would start from this render's, and drop what was
    // opened since (a `?detail=` panel) while the chat loaded
    const now = new URLSearchParams(window.location.search);
    if (now.has('at')) {
      now.delete('at');
      setSearch(now, { replace: true });
    }
    if (at === null) return;
    // A step's entry counts the main view: with the subagents' turns shown it would land elsewhere
    setSidechains(false);
    setJump({ index: at });
  }, [loaded, atParam, setSearch]);

  // `?guard=1` (a task's "N blocked" chip): the first guard notice, found the way a search finds
  // it, so it is reached even when it is on a page the view has not read yet
  const guardParam = search.get('guard');
  useEffect(() => {
    if (!loaded || guardParam === null) return;
    const now = new URLSearchParams(window.location.search);
    now.delete('guard');
    setSearch(now, { replace: true });
    // Not cancelled by the effect's cleanup: dropping the param above re-runs it before the answer is here
    void api
      .searchChat(id, false, GUARD_NOTICE_TEXT)
      .then((found) => {
        const first = found.hits[0];
        if (!first) return;
        setSidechains(false);
        setJump({ index: first.index });
      })
      .catch(() => undefined);
  }, [loaded, guardParam, id, setSearch]);

  // Reached the way a search hit is, reading back to its page when needed; a hit wins over the link
  const focus = useFindFocus(find.target ?? jump, transcript.items, transcript.from, transcript.reach);
  useFindHighlight(scroller, find);
  // Jumping to a hit is the reader moving: the bottom must not pull them back
  const steered = Boolean(find.target || jump);
  useEffect(() => {
    hold(steered);
    if (steered) setFollow(false);
  }, [find.target, jump, steered, hold, setFollow]);
  // The entry stays marked for a moment once it is on screen, then reads like any other
  const jumpShown = Boolean(jump && focus);
  useEffect(() => {
    if (!jumpShown) return;
    const timer = setTimeout(() => setJump(null), AT_MARK_MS);
    return () => clearTimeout(timer);
  }, [jumpShown]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: keys.chatScope(id) });
    void queryClient.invalidateQueries({ queryKey: keys.chats });
  };
  const { mutate: stopChat, isPending: stopping, error: stopError } = useMutation({ mutationFn: () => api.stopChat(id), onSuccess: invalidate });
  const { mutate: interruptChat, isPending: interrupting, error: interruptError } = useMutation({
    mutationFn: () => api.interruptChat(id),
    onSuccess: invalidate,
  });
  // "Send now" names the message it is for: once the agent has read it the server refuses (409) and
  // interrupts nothing, which is no error to show, only a card about to clear
  const { mutate: sendNow, isPending: sendingNow, error: sendNowError } = useMutation({
    mutationFn: (messageId: string) => api.interruptChat(id, { messageId }),
    onSettled: invalidate,
  });
  const sendNowFailed = sendNowError instanceof ApiRequestError && sendNowError.status === 409 ? null : sendNowError;
  const remove = useDeleteChat(() => navigate('/chats'));
  // Read when pressed, not when the header's actions are built: both change on every render
  const toDelete = useRef({ request: remove.requestDelete, chat });
  useLayoutEffect(() => {
    toDelete.current = { request: remove.requestDelete, chat };
  });

  // Rows built again from the same entries stay the same objects, so what renders them does not
  const lastRows = useRef<readonly TranscriptRow[]>([]);
  const rows = useMemo(() => (lastRows.current = transcriptRows(items, lastRows.current)), [items]);
  // What the person sent here, for the box's ArrowUp: their own words, the newest last
  const sentHistory = useMemo(
    () =>
      transcript.items
        .filter((entry) => entry.role === 'user' && !entry.isSidechain)
        .map((entry) => entryText(entry).trim())
        .filter(Boolean)
        .slice(-HISTORY_LIMIT),
    [transcript.items],
  );
  const subagentList = chat?.children.subagents;
  const openDetail = detail.open;
  const subagents = useMemo<SubagentLink | undefined>(
    () =>
      subagentList && subagentList.length > 0
        ? { find: (input) => subagentFor(input, subagentList)?.id ?? null, open: (agentId) => openDetail({ kind: 'subagent', chatId: id, agentId }) }
        : undefined,
    [subagentList, openDetail, id],
  );

  // What the chat delegated is a card under its step and a row of the strip over the composer: a
  // subagent and a command open their panel, a workflow its whole card in the inspector
  const children = chat?.children;
  const showInspector = inspector.show;
  const openBranch = useCallback(
    (branch: Branch) => {
      if (branch.kind === 'agent') openDetail({ kind: 'subagent', chatId: id, agentId: branch.id });
      else if (branch.kind === 'task') openDetail({ kind: 'task', chatId: id, taskId: branch.id });
      else showInspector('environment');
    },
    [openDetail, id, showInspector],
  );
  const branches = useMemo<BranchLinks | undefined>(() => (children ? { children, open: openBranch } : undefined), [children, openBranch]);

  // "Create a task from this message": in Backlog of the chat's project, then offered to open
  const toast = useToast();
  const projects = useProjects(false);
  const itemLinks = useChatItemLinks(id);
  const chatProject = chat?.project ?? null;
  const project = chatProject ? projects.data?.find((p) => p.id === chatProject.id) : undefined;
  const { mutate: createTask } = useMutation({
    mutationFn: (text: string) => api.workItemFromMessage(id, { text }),
    onSuccess: (item) => {
      void queryClient.invalidateQueries({ queryKey: keys.chatWorkItems(id) });
      toast.show({
        tone: 'ok',
        title: t('messageMenu.created', { key: item.key }),
        detail: t('messageMenu.createdDetail'),
        action: { label: t('messageMenu.openTask'), onClick: () => navigate(taskPath(item.key)) },
      });
    },
    onError: (error) => toast.error(t('messageMenu.createFailed'), error),
  });
  // Read before the project list arrives, the item is offered: the server has the last word
  const noBoard = project && !project.modules.includes('board');
  const taskDisabled = !chatProject ? t('messageMenu.noProject') : noBoard ? t('messageMenu.noBoard', { project: chatProject.name }) : undefined;
  const taskHint = chatProject ? t('messageMenu.createTaskHint', { project: chatProject.name }) : '';
  const messages = useMemo<MessageActions>(
    () => ({ createTask: { run: (text) => createTask(text), hint: taskHint, disabledReason: taskDisabled } }),
    [createTask, taskHint, taskDisabled],
  );
  // The steps give the edit chips their counts. They are read once the conversation has painted,
  // never in its way, and again whenever a call comes back: an edit's result is what makes a step
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPainted(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const steps = useQuery({ queryKey: keys.chatSteps(id), queryFn: () => api.chatSteps(id), enabled: painted && Boolean(chat) });
  const answered = Boolean(last && last.role === 'user' && last.blocks.length > 0 && last.blocks.every((b) => b.type === 'tool_result'));
  useEffect(() => {
    if (answered) void queryClient.invalidateQueries({ queryKey: keys.chatSteps(id), exact: true });
  }, [answered, lastKey, id, queryClient]);
  const stepList = steps.data;
  const edits = useMemo<TranscriptEdits>(
    () => ({ chatId: id, steps: stepList ? new Map<string, EditStep>(stepList.map((step) => [step.id, step])) : null }),
    [id, stepList],
  );

  // A summary the person keeps as a note: the divider offers the button and hides it once it is one
  const notes = useQuery({ queryKey: keys.chatNotes(id), queryFn: () => api.chatNotes(id), enabled: painted && Boolean(chat) });
  const noted = useMemo(() => new Set((notes.data ?? []).flatMap((note) => (note.entryUuid ? [note.entryUuid] : []))), [notes.data]);
  const saveSummary = useCallback(
    (summary: TranscriptEntry) =>
      void api
        .createChatNote(id, { from: 'summary', entryUuid: summary.uuid })
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: keys.chatNotes(id) });
          toast.success(t('chats:context.notes.saved'));
        })
        .catch((error: unknown) => toast.error(t('chats:context.notes.saveFailed'), error)),
    [id, queryClient, toast, t],
  );
  const compactions = useMemo(() => ({ saveAsNote: saveSummary, noted }), [saveSummary, noted]);

  const { open: findOpen, show: findShow, close: findClose } = find;
  const actions = useMemo<HeaderActions>(
    () => ({
      find: { open: findOpen, show: findShow, close: findClose },
      sidechains,
      setSidechains,
      forking,
      setForking,
      stop: { run: () => stopChat(), pending: stopping },
      interrupt: { run: () => interruptChat(), pending: interrupting },
      remove: {
        run: () => {
          const { request, chat: current } = toDelete.current;
          if (current) request(current);
        },
        pending: remove.isPending,
      },
      inspector,
    }),
    [findOpen, findShow, findClose, sidechains, forking, stopChat, stopping, interruptChat, interrupting, remove.isPending, inspector],
  );

  if (transcript.query.isLoading) return <ChatLoading label={t('view.loading')} />;
  if (!chat) {
    return (
      <>
        <PageHeader title={t('view.pageTitleFallback')} />
        {/* A chat that is not there is what the illustration says; any other failure is said too */}
        {!(transcript.query.error instanceof ApiRequestError && transcript.query.error.status === 404) && <ErrorBox error={transcript.query.error} />}
        <Empty illustration="not-found" title={t('view.notFound')}>
          <Trans t={t} i18nKey="view.notFoundHint" components={{ anchor: <Link to="/chats" /> }} />
        </Empty>
      </>
    );
  }

  const { control } = chat;
  const agent = agentNameFor(chat);
  const working = chat.state === 'working';
  const live = Boolean(chat.execution);
  const composer: ComposerKind | null = forking ? 'fork' : control.mode === 'interactive' ? 'send' : control.mode === 'resumable' ? 'resume' : null;
  // While the agent writes the answer after its calls, the step above is done, not current
  const stepCurrent = working && !writing;
  // "Send now" is for the oldest message still in the agent's queue: ending the turn has it read
  // whatever else waits with it, and one held for the next process is read once that one starts
  const waiting = queued.find((message) => message.state === 'waiting');

  return (
    <AgentScope chat={chat}>
    <ContextControlProvider chat={chat}>
    <div className={`run-layout ${inspector.rail ? 'has-inspector' : ''}`.trim()}>
      <section className="run-main" aria-label={t('view.conversation')}>
        <ChatHeader chat={chat} connected={connected} actions={actions} limitPhase={limit.phase} limitResetsAt={limit.resetsAt} />
        <ErrorBox error={stopError ?? interruptError ?? sendNowFailed} />
        {control.mode === 'readOnly' && (
          <div className="alert alert-warn chat-banner" role="status">
            <Lock {...ICON} className="alert-icon" />
            <div className="alert-body">
              <strong>{t('badges.control.readOnly')}</strong>
              <div>{control.reason}</div>
            </div>
            {control.action === 'hint' && chat.orchestration ? (
              <Link to={`/orchestration/${chat.orchestration.id}`} className="btn btn-small">
                {t('view.sendHint')}
              </Link>
            ) : (
              !forking && (
                <button className="btn btn-small" onClick={() => setForking(true)}>
                  <GitFork {...ICON_SM} /> {t('chat:sessionView.continueCopy')}
                </button>
              )
            )}
          </div>
        )}
        {chat.orchestration && <PartOf link={chat.orchestration} />}
        {itemLinks.map((link) => (
          <WorkItemPartOf key={link.item.id} link={link} chatId={chat.id} />
        ))}
        <FindBar find={find} />

        <div className="run-stage">
          {/* Focusable so the keyboard can scroll a transcript that holds nothing else to focus */}
          <div
            className={`run-scroll${jump && !find.target ? ' is-at-jump' : ''}`}
            role="region"
            aria-label={t('view.transcript')}
            tabIndex={0}
            data-scroll-root
            ref={scroller}
          >
            {transcript.more && (
              <div className="transcript-earlier">
                <ErrorBox error={transcript.loadError} />
                {/* While the page before this one is on its way, lines where it will land: the list
                    reserves the room for it either way, and blank room reads as a page that broke */}
                {transcript.loadingMore ? (
                  <Skeleton rows={3} height={5} />
                ) : (
                  <button type="button" className="btn btn-small" onClick={transcript.loadEarlier}>
                    {t('chat:sessionView.loadEarlier', { n: transcript.from })}
                  </button>
                )}
              </div>
            )}
            {/* The first message of the assistant's chats, so only where the transcript starts */}
            {chat.claudioAssistant && !transcript.more && <AssistantGreeting />}
            {items.length === 0 ? (
              !working && <Empty icon={MessageSquare} title={t('view.nothingWritten')} />
            ) : (
              <Transcript
                entries={items}
                rows={rows}
                pinToBottom={follow}
                onReachTop={transcript.loadEarlier}
                focus={focus}
                working={stepCurrent}
                subagents={subagents}
                branches={branches}
                messages={messages}
                edits={edits}
                compactions={compactions}
              />
            )}
            {/* Pinned under the transcript: a chat waiting on a decision is stuck until it gets one */}
            <PermissionPrompts chatId={id} live={live} />
            <LiveTail stream={stream} chat={chat} continued={endsWithAssistant(items)} />
            {limit.phase !== 'none' && <LimitStopped chat={chat} at={chat.executions.at(-1)?.endedAt ?? chat.updatedAt} waiting={limit.phase === 'waiting'} />}
            {/* Its height is written by useTurnSpacer; the negative margin takes back the column's gap, as this is not a row */}
            <div ref={spacerRef} aria-hidden style={{ flex: 'none', height: 0, marginTop: -14 }} />
          </div>
          <AnimatePresence>
            {!follow && (
              <motion.button
                type="button"
                className="jump-latest"
                onClick={jumpToLatest}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.16 }}
              >
                <ArrowDown {...ICON_SM} /> {t('chat:runView.jumpToLatest')}
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {children && <LiveBranches branches={children} onOpen={openBranch} />}
        {composer === 'fork' && (
          <div className="chat-fork" role="group" aria-label={t('chat:sessionView.continueCopy')}>
            <div className="chat-fork-head">
              <GitFork {...ICON_SM} aria-hidden />
              <span className="small">{t('view.forkIntro')}</span>
              <button type="button" className="icon-btn" aria-label={t('view.cancelFork')} onClick={() => setForking(false)}>
                <X {...ICON_SM} />
              </button>
            </div>
            <Composer key={chat.id} chat={chat} kind="fork" onSent={() => setFollow(true)} />
          </div>
        )}
        {queued.length > 0 && (
          <div className={`chat-queued ${queued.every((message) => message.state === 'lost') ? 'is-lost' : ''}`.trimEnd()} role="status" aria-label={t('view.queued.title')}>
            <ul className="chat-queued-list">
              {queued.map((message) => (
                <li key={message.id} className={`chat-queued-item ${message.state === 'lost' ? 'is-lost' : ''}`.trimEnd()}>
                  {message.state === 'lost' ? <TriangleAlert {...ICON_SM} aria-hidden /> : <Hourglass {...ICON_SM} aria-hidden />}
                  <span className="chat-queued-text">{message.text || t('view.queued.files', { count: message.attachments.length })}</span>
                  {message.state === 'lost' && (
                    <Tooltip content={t('view.queued.restore')}>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={t('view.queued.restore')}
                        onClick={() => {
                          setRestore({ text: message.text, attachments: message.attachments, at: Date.now() });
                          dropQueued(message.id);
                        }}
                      >
                        <Undo2 {...ICON_SM} />
                      </button>
                    </Tooltip>
                  )}
                </li>
              ))}
            </ul>
            <div className="chat-queued-foot">
              <span className="small muted">
                {queued.some((message) => message.state === 'lost')
                  ? t('view.queued.undelivered', { agent })
                  : waiting
                    ? t('view.queued.hint', { count: queued.length })
                    : t('view.queued.held', { count: queued.length, agent })}
              </span>
              {waiting && (
                <Tooltip content={t('view.queued.sendNowHint', { agent })}>
                  <button type="button" className="btn btn-small" onClick={() => sendNow(waiting.id)} disabled={sendingNow}>
                    {sendingNow ? t('view.queued.sending') : t('view.queued.sendNow')}
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
        )}
        {limit.phase !== 'none' && composer !== 'fork' && (
          <div className="lim-zone">
            <LimitBanner chat={chat} state={limit} />
            <BlockedComposer chat={chat} state={limit} />
          </div>
        )}
        {composer && composer !== 'fork' && limit.phase === 'none' && (
          // Keyed by the chat: a draft and its files belong to the chat they were written in
          <Composer
            key={chat.id}
            chat={chat}
            kind={composer}
            restore={restore}
            history={sentHistory}
            onSending={onSending}
            writing={writing}
            onSent={(sent) => {
              setFollow(true);
              // The server says whether it waits: a resume or a fork, or a message that starts a turn, does not
              if (sent.receipt) queueMessage(sent.receipt, sent.text, sent.attachments);
            }}
            interrupt={composer === 'send' ? { run: () => interruptChat(), pending: interrupting } : undefined}
          />
        )}
      </section>

      <Inspector chat={chat} entries={transcript.items} state={inspector} />
    </div>
    </ContextControlProvider>
    </AgentScope>
  );
}
