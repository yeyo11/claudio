import type { ChatChildren, ContentBlock, EditStep, TranscriptEntry } from '@claudio/shared';
import { ArrowRightLeft, Brain, CircleAlert, CircleX, CircleStop, Check, Copy, Info, PanelRightOpen, ShieldAlert, SquareCheck, Terminal, User, Zap, type LucideIcon } from 'lucide-react';
import { lazy, memo, Suspense, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useChatUi } from '../lib/context';
import { upperFirst, useAgentName, useRiskContext } from '../lib/agent';
import { toolHint } from '../lib/tool-lens';
import { toolKindLabel } from '../lib/wire-words';
import { editChips } from '../lib/edit-chips';
import { readGuardResult, readNotices, type Notice, type NoticeKind } from '../lib/chat-notice';
import { useStreamFade } from '../lib/smooth-text';
import { justStreamed, streamedHeight } from '../lib/chat-stream';
import { callCount, callHint, isDelegation, rowOf, stepDuration, stepTools, transcriptRows, type StepCall, type StepPart, type TranscriptRow } from '../lib/chat-steps';
import { formatDuration, formatClock, formatDateTime, truncate } from '@claudio/ui/lib/format';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { CompactionDivider, type CompactionActions } from './CompactionDivider';
import { BranchCard } from './LiveBranches';
import { branchesOfStep, type Branch } from '../lib/chat-branches';
import { AttachedFiles, MediaBlock, splitAttached } from './Attachments';
import { RiskTag, useToolRisk } from './RiskTag';
import { ToolBody } from './ToolBody';
import { Collapsible } from '@claudio/ui/components/controls/Collapsible';
import type { MenuEntry } from '@claudio/ui/components/controls/Menu';
import { MoreActions } from '@claudio/ui/components/controls/MoreActions';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { BrandMark, ICON_SM, toolIcon } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { CopyButton } from '@claudio/ui/components/ui';
import { VirtualList } from '@claudio/ui/components/VirtualList';
import { copyText } from '@claudio/ui/lib/clipboard';

const loadMarkdown = () => import('@claudio/ui/components/Markdown');
const Markdown = lazy(loadMarkdown);
/** Starts loading the renderer, so the first answer on the page is never drawn as raw text first. */
export const preloadMarkdown = (): void => void loadMarkdown();

/**
 * Markdown the way chat apps show it: GFM tables and task lists, highlighted code, safe links. The
 * renderer loads on first use; until then the text shows as typed, so nothing waits on it.
 * `streaming` marks text that is still growing, so only its last block is parsed on every update.
 */
export const RichText = memo(function RichText({ text, className = '', streaming = false }: { text: string; className?: string; streaming?: boolean }) {
  return (
    <div className={`rich md ${className}`}>
      <Suspense fallback={<div className="prose">{text}</div>}>
        <Markdown text={text} streaming={streaming} />
      </Suspense>
    </div>
  );
});

function ThinkingFold({ text }: { text: string }) {
  const { t } = useTranslation('chat');
  return (
    <Collapsible
      className="fold fold-thinking"
      title={
        <>
          <Brain {...ICON_SM} className="fold-icon" />
          <span className="tool-name">{t('transcript.thinking')}</span>
        </>
      }
    >
      <div className="prose muted fold-body">{text}</div>
    </Collapsible>
  );
}

function Block({ block, role, streaming = false }: { block: ContentBlock; role: 'user' | 'assistant'; streaming?: boolean }) {
  const { t } = useTranslation('chat');
  switch (block.type) {
    case 'text': {
      const { text, files } = splitAttached(block.text);
      return (
        <>
          {/* What a person typed is shown as typed, the way chat apps do; Claude's answers are markdown */}
          {text.trim() && (role === 'user' ? <div className="prose">{text.trim()}</div> : <RichText text={text} streaming={streaming} />)}
          <AttachedFiles files={files} />
        </>
      );
    }
    case 'image':
    case 'document':
      return <MediaBlock kind={block.type} mediaType={block.mediaType} name={block.name} uploadId={block.uploadId} />;
    case 'thinking':
      return <ThinkingFold text={block.text} />;
    // A call or a result outside a step: what is left of a turn whose other half is not held
    case 'tool_use':
      return <CallRow call={{ kind: 'call', id: block.id, name: block.name, input: block.input, result: null }} settled />;
    case 'tool_result':
      return <CallRow call={{ kind: 'call', id: block.toolUseId, name: null, input: null, result: { content: block.content, isError: block.isError, ...(block.detail ? { detail: block.detail } : {}) } }} settled />;
  }
}

/**
 * A message sent through the wrapper names its files in a list, which shows each one; the image and
 * PDF blocks it also carries would show them twice.
 */
function withoutListedMedia(blocks: ContentBlock[]): ContentBlock[] {
  const listed = blocks.some((b) => b.type === 'text' && b.text.includes('<attached-files>'));
  return listed ? blocks.filter((b) => b.type !== 'image' && b.type !== 'document') : blocks;
}

/** The time a row was written: out of the way until the reader points at the row or moves into it. */
function RowTime({ at }: { at: string | null }) {
  if (!at) return null;
  return (
    <time className="msg-time" dateTime={at} title={formatDateTime(at)}>
      {formatClock(at)}
    </time>
  );
}

const NOTICE_ICONS: Record<NoticeKind, LucideIcon> = { task: Zap, reminder: Info, command: Terminal, output: Terminal, interrupt: CircleStop, 'compaction-failed': CircleX, account: ArrowRightLeft, guard: ShieldAlert };

/**
 * Something the system said, not the person: a strip in the machine's own voice — mono, in the
 * accent colour, with its payload behind a fold — so a reader never mistakes it for a message.
 */
function NoticeRow({ notice }: { notice: Notice }) {
  const { t } = useTranslation('chat');
  const Icon = NOTICE_ICONS[notice.kind];
  const failed = notice.kind === 'compaction-failed' || notice.missing === true || (Boolean(notice.status) && notice.status !== 'completed');
  const line = (
    <>
      <Icon {...ICON_SM} className="notice-icon" />
      <span className="notice-label">{t(notice.missing ? 'transcript.notice.guardMissing' : `transcript.notice.${notice.kind}`)}</span>
      {notice.rule && <span className="notice-rule">{notice.rule}</span>}
      {notice.status && <span className={`notice-status ${failed ? 'is-bad' : 'is-ok'}`}>{notice.status}</span>}
      {/* Two lines at most: what the system says is worth a glance, not a screen of the conversation */}
      <span className="notice-detail" title={notice.detail}>
        {notice.detail}
      </span>
    </>
  );
  const tone = `notice is-${notice.kind} ${failed ? 'is-bad' : ''}`.trim();
  if (!notice.body) return <div className={tone}>{line}</div>;
  return (
    <Collapsible className={`fold notice-fold ${tone}`} title={line}>
      {/* Behind the fold the whole of it, the line included: the line above may have been cut */}
      <div className="notice-body">{`${notice.detail}\n${notice.body}`}</div>
    </Collapsible>
  );
}

/**
 * What a `user` entry really holds: the prose a person typed, and the notices the harness wrote
 * into it. Only user entries carry them, and a message that is nothing but notices has no prose.
 */
function readEntry(entry: TranscriptEntry): { blocks: ContentBlock[]; notices: Notice[] } {
  if (entry.role !== 'user') return { blocks: entry.blocks, notices: [] };
  const notices: Notice[] = [];
  const blocks: ContentBlock[] = [];
  for (const block of entry.blocks) {
    if (block.type !== 'text') {
      blocks.push(block);
      continue;
    }
    const read = readNotices(block.text);
    notices.push(...read.notices);
    if (read.prose) blocks.push({ type: 'text', text: read.prose });
  }
  return { blocks, notices };
}

/** A compaction's summary as Markdown: the text blocks of its entry. */
function SummaryText({ entry }: { entry: TranscriptEntry }) {
  const text = entry.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n\n');
  return <RichText text={text} />;
}

/** What the chat page lets a person do with one message: where its menu comes from. */
export interface MessageActions {
  /** "Create a task from this message": in Backlog of the chat's project, linked to the chat */
  createTask: {
    run: (text: string) => void;
    /** Where the task will land, said under the item */
    hint: string;
    /** Why there is nowhere to put one now; the item stays, and says so */
    disabledReason?: string;
  };
}

/** A message's words as it was written, without the files listed after them: what copying it or making a task of it takes. */
function messageText(blocks: readonly ContentBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === 'text' ? [splitAttached(block.text).text.trim()] : []))
    .filter(Boolean)
    .join('\n\n');
}

const QUOTE_CHARS = 120;

/**
 * The `⋯` of a message: copy it, or make a task of it. It shows while the message is pointed at or
 * focused, beside a copy button on a desktop; on a phone it is always there and opens a sheet that
 * quotes the message it acts on.
 */
function MessageMenu({ text, actions }: { text: string; actions: MessageActions }) {
  const { t } = useTranslation('chat');
  const toast = useToast();
  const narrow = useMediaQuery(NARROW);
  const { createTask } = actions;
  const entries: MenuEntry[] = [
    {
      id: 'copy',
      icon: Copy,
      label: t('messageMenu.copy'),
      onSelect: () => void copyText(text).then((copied) => (copied ? toast.success(t('messageMenu.copied')) : toast.error(t('messageMenu.copyFailed')))),
    },
    { id: 'task-separator', separator: true },
    {
      id: 'task',
      icon: SquareCheck,
      label: createTask.disabledReason ? (
        t('messageMenu.createTask')
      ) : (
        <span className="msg-menu-task">
          {t('messageMenu.createTask')}
          <span className="msg-menu-hint">{createTask.hint}</span>
        </span>
      ),
      onSelect: () => createTask.run(text),
      disabled: Boolean(createTask.disabledReason),
      disabledReason: createTask.disabledReason,
    },
  ];
  return (
    <div className="msg-actions" data-find-ignore>
      {!narrow && <CopyButton text={text} label={t('messageMenu.copy')} />}
      <MoreActions entries={entries} label={t('messageMenu.label')} title={`«${truncate(text.replace(/\s+/g, ' '), QUOTE_CHARS)}»`} />
    </div>
  );
}

export const EntryView = memo(function EntryView({
  entry,
  continued = false,
  fresh = false,
  streamedCopy = false,
  actions,
}: {
  entry: TranscriptEntry;
  continued?: boolean;
  /** Said a moment ago: the row rises into place once */
  fresh?: boolean;
  /** An answer streamed a moment ago: drawn with the streaming markup, so the swap from the live copy changes nothing */
  streamedCopy?: boolean;
  /** The chat page's menu for a message; left out, a message has none (a subagent's transcript) */
  actions?: MessageActions;
}) {
  const { t } = useTranslation('chat');
  const agentName = useAgentName();
  const { blocks, notices } = useMemo(() => readEntry(entry), [entry]);
  // Whatever way it got here, a compaction marker or its summary is never drawn as the person's message
  if (entry.compaction) {
    const summary = entry.compaction.part === 'summary';
    return <CompactionDivider boundary={summary ? null : entry} summary={summary ? entry : null} summaryBody={summary ? <SummaryText entry={entry} /> : null} />;
  }
  const onlyToolResults = entry.role === 'user' && entry.blocks.every((b) => b.type === 'tool_result');
  const role = onlyToolResults ? 'tool' : entry.role;
  const head = !onlyToolResults && !continued;
  // Nothing but notices: they stand on their own, without an avatar and without a name on them
  if (notices.length > 0 && blocks.length === 0) {
    return (
      <div className="msg msg-notice">
        <span className="avatar-gap" aria-hidden />
        <div className="msg-body">
          {notices.map((notice, i) => (
            <NoticeRow key={i} notice={notice} />
          ))}
          <RowTime at={entry.timestamp} />
        </div>
      </div>
    );
  }
  return (
    <article data-entry-id={entry.uuid} className={`msg msg-${role} ${entry.isSidechain ? 'msg-sidechain' : ''} ${continued ? 'is-continued' : ''} ${fresh ? 'is-fresh' : ''}`.trimEnd()}>
      {head ? <Avatar role={entry.role} /> : <span className="avatar-gap" aria-hidden />}
      <div className="msg-body">
        <RowTime at={entry.timestamp} />
        {head && (
          <header className="msg-head">
            <span className="msg-role">{entry.role === 'user' ? t('transcript.user') : agentName}</span>
            {entry.isSidechain && <span className="badge badge-info">{t('transcript.subagent')}</span>}
            {entry.model && <span className="muted small msg-model">{entry.model}</span>}
          </header>
        )}
        {withoutListedMedia(blocks).map((block, i) => (
          <Block key={i} block={block} role={entry.role} streaming={streamedCopy} />
        ))}
        {notices.map((notice, i) => (
          <NoticeRow key={`notice-${i}`} notice={notice} />
        ))}
        {actions && !onlyToolResults && <EntryMenu blocks={blocks} actions={actions} />}
      </div>
    </article>
  );
});

function EntryMenu({ blocks, actions }: { blocks: ContentBlock[]; actions: MessageActions }) {
  const text = useMemo(() => messageText(blocks), [blocks]);
  return text ? <MessageMenu text={text} actions={actions} /> : null;
}

function Avatar({ role }: { role: 'user' | 'assistant' }) {
  return (
    <span className={`avatar avatar-${role}`} aria-hidden>
      {role === 'user' ? <User {...ICON_SM} /> : <BrandMark size={26} />}
    </span>
  );
}

/** A delegation whose subagent can be opened, and how. */
export interface SubagentLink {
  find: (input: unknown) => string | null;
  open: (agentId: string) => void;
}

/**
 * One tool call as one row: its name and what it was pointed at in mono, a rail coloured by how it
 * came back, and the input and result behind the fold. `settled` is a call that will not come back
 * any more as far as this page knows (the turn is over), so it is not shown as running.
 */
function CallRow({ call, settled, subagents }: { call: StepCall; settled: boolean; subagents?: SubagentLink }) {
  const { t } = useTranslation('chat');
  const running = call.result === null && !settled && call.name !== null;
  const outcome = call.result ? (call.result.isError ? 'error' : 'ok') : running ? 'running' : 'none';
  const Icon = call.name ? toolIcon(call.name) : CircleAlert;
  const agentId = subagents && isDelegation(call.name) ? subagents.find(call.input) : null;
  const { cwd } = useRiskContext();
  const hint = call.name ? toolHint(call.name, call.input, cwd, callHint) : { text: truncate((call.result?.content ?? '').replace(/\s+/g, ' '), 110) || t('transcript.empty') };
  // Scored from the input, so a call still waiting for its result already shows it
  const risk = useToolRisk(call.name, call.input);
  // A call the guard blocked is the guard's strip, not a failed call: the reason is the fold
  const blocked = call.result?.isError ? readGuardResult(call.result.content, hint.text) : null;
  if (blocked) return <NoticeRow notice={blocked} />;
  return (
    <div className={`call-row is-${outcome}`}>
      <Collapsible
        className="fold fold-call"
        title={
          <>
            {running ? <Spinner className="fold-icon" /> : <Icon {...ICON_SM} className="fold-icon" />}
            <span className="tool-name">{call.name !== null ? toolKindLabel(call.name) : (call.result?.isError ? t('transcript.toolError') : t('transcript.toolResult'))}</span>
            <span className="tool-hint">
              {hint.items !== undefined ? t('transcript.call.items', { count: hint.items }) : hint.text}
              {hint.aside && <span className="tool-hint-aside"> {hint.aside}</span>}
            </span>
            <RiskTag risk={risk} />
            {/* The rail's colour is not the only thing that says it failed */}
            {outcome === 'error' && <span className="call-outcome">{t('transcript.callFailed')}</span>}
            {outcome === 'running' && <span className="sr-only">{t('transcript.callRunning')}</span>}
          </>
        }
      >
        <ToolBody call={call} running={running} />
      </Collapsible>
      {agentId && subagents && (
        <Tooltip content={t('transcript.openSubagent')}>
          <button type="button" className="icon-btn call-open" aria-label={t('transcript.openSubagent')} onClick={() => subagents.open(agentId)}>
            <PanelRightOpen {...ICON_SM} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

function PartView({ part, settled, subagents }: { part: StepPart; settled: boolean; subagents?: SubagentLink }) {
  return part.kind === 'thinking' ? <ThinkingFold text={part.text} /> : <CallRow call={part} settled={settled} subagents={subagents} />;
}

/** Where a chat's edits lead: its review screen, on the step of each file. */
export interface TranscriptEdits {
  chatId: string;
  /** The chat's steps by id, once read: until then a chip has its name and no counts */
  steps: ReadonlyMap<string, EditStep> | null;
}

/** One chip per file a tool group edited, each opening its step in the review. */
function EditChips({ parts, edits }: { parts: StepPart[]; edits: TranscriptEdits }) {
  const { t } = useTranslation('chat');
  const { paths } = useChatUi();
  const chips = useMemo(() => editChips(parts, edits.steps), [parts, edits.steps]);
  if (chips.length === 0) return null;
  return (
    <div className="edit-chips" role="group" aria-label={t('edits.label')}>
      {chips.map((chip) => {
        const counted = chip.additions !== null && chip.deletions !== null;
        return (
          <Link
            key={chip.file}
            to={paths.chatChangeStep(edits.chatId, chip.stepId)}
            className="edit-chip"
            title={chip.file}
            aria-label={counted ? t('edits.chipCounts', { file: chip.name, additions: chip.additions, deletions: chip.deletions }) : t('edits.chip', { file: chip.name })}
          >
            <span>{chip.name}</span>
            {counted && (
              <span className="obs-counts" aria-hidden>
                {chip.additions ? <span className="obs-add">+{chip.additions}</span> : null}
                {chip.additions && chip.deletions ? ' ' : null}
                {chip.deletions ? <span className="obs-del">−{chip.deletions}</span> : null}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

/**
 * A turn's tool calls, folded into one block that says how many and how long. The step being worked
 * on right now is open and carries the live rail; once it is done it folds away, unless the reader
 * opened or closed it themselves.
 */
const StepView = memo(function StepView({
  row,
  current,
  subagents,
  fresh = false,
  branches,
  onOpenBranch,
  edits,
}: {
  row: Extract<TranscriptRow, { kind: 'step' }>;
  current: boolean;
  subagents?: SubagentLink;
  fresh?: boolean;
  /** The chat's edits, so the files this step edited show as chips; none where the transcript is not a chat's page */
  edits?: TranscriptEdits;
  /** The subagents, background commands and workflows its calls started, each a card under the step */
  branches?: Branch[];
  onOpenBranch?: (branch: Branch) => void;
}) {
  const { t } = useTranslation('chat');
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? current;
  const count = callCount(row.parts);
  const failed = row.parts.filter((p) => p.kind === 'call' && p.result?.isError).length;
  const duration = stepDuration(row);
  const tools = stepTools(row.parts);
  return (
    <article className={`msg msg-step ${row.isSidechain ? 'msg-sidechain' : ''} ${current ? 'is-current' : ''} ${fresh ? 'is-fresh' : ''}`.trimEnd()}>
      <span className="avatar-gap" aria-hidden />
      <div className="msg-body">
        <RowTime at={row.startedAt} />
        <Collapsible
          className={`fold tool-step ${current ? 'live-rail' : ''}`}
          open={open}
          onOpenChange={setChosen}
          title={
            <>
              {current ? <Spinner className="fold-icon step-icon" /> : failed > 0 ? <CircleAlert {...ICON_SM} className="fold-icon step-icon is-error" /> : <Check {...ICON_SM} className="fold-icon step-icon" />}
              <span className="step-count">
                {t('transcript.tools', { count })}
                {duration !== null && duration >= 1000 && ` · ${formatDuration(duration)}`}
                {failed > 0 && ` · ${t('transcript.failedCalls', { count: failed })}`}
              </span>
              <span className="step-tools">
                {tools.map((tool) => (
                  <span key={tool.name} className="badge step-tool">
                    {tool.count > 1 ? `${tool.name} ×${tool.count}` : tool.name}
                  </span>
                ))}
              </span>
              {current && <span className="sr-only">{t('transcript.stepCurrent')}</span>}
            </>
          }
        >
          <div className="step-parts">
            {row.parts.map((part, i) => (
              <PartView key={part.kind === 'call' ? part.id : `t${i}`} part={part} settled={!current} subagents={subagents} />
            ))}
          </div>
        </Collapsible>
        {edits && <EditChips parts={row.parts} edits={edits} />}
        {branches?.map((branch) => <BranchCard key={branch.key} branch={branch} onOpen={onOpenBranch} />)}
      </div>
    </article>
  );
});

/** What a chat delegated, and where to see each branch whole. */
export interface BranchLinks {
  children: ChatChildren;
  open: (branch: Branch) => void;
}

const sameBranches = (a: readonly Branch[], b: readonly Branch[]) => a.length === b.length && a.every((branch, i) => JSON.stringify(branch) === JSON.stringify(b[i]));

/** The line at the end of a chat that is working: the agent's name, with the tool it is on after it in mono. */
export function WorkingLine({ detail }: { detail?: string }) {
  const { t } = useTranslation('chat');
  const agent = useAgentName();
  return (
    <div className="working-line" role="status">
      <Spinner />
      <span className="shimmer">{t('runView.working', { agent: upperFirst(agent) })}</span>
      {detail && <span className="mono muted small">{detail}</span>}
    </div>
  );
}

/** The block the agent is generating right now, fed by ephemeral `partial` stream events. */
export function StreamingEntry({ block, text, continued = false, fade = false, onHeight }: { block: 'text' | 'thinking'; text: string; continued?: boolean; fade?: boolean; onHeight?: (height: number) => void }) {
  const { t } = useTranslation('chat');
  const agentName = useAgentName();
  const article = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const fading = useStreamFade(body, text, fade && block === 'text');
  const report = useRef(onHeight);
  report.current = onHeight;
  // The stored copy of this block takes this height as its first size
  useLayoutEffect(() => {
    const el = article.current;
    if (!el) return;
    report.current?.(el.offsetHeight);
    const watch = new ResizeObserver(() => report.current?.(el.offsetHeight));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return (
    <article ref={article} className={`msg msg-assistant msg-streaming ${continued ? 'is-continued' : ''}`} aria-live="off" data-find-ignore>
      {continued ? <span className="avatar-gap" aria-hidden /> : <Avatar role="assistant" />}
      <div className="msg-body" ref={body}>
        {!continued && (
          <header className="msg-head">
            <span className="msg-role">{agentName}</span>
          </header>
        )}
        {block === 'thinking' ? (
          <div className="streaming-thinking">
            <div className="streaming-thinking-label">
              <Brain {...ICON_SM} /> {t('transcript.thinkingNow')}
            </div>
            <div className="prose muted">{text.length > 1200 ? `…${text.slice(-1200)}` : text}</div>
          </div>
        ) : (
          <RichText text={text} className={fading ? 'streaming-text has-fade' : 'streaming-text'} streaming />
        )}
      </div>
    </article>
  );
}

/** Whether what comes after these rows is still Claude speaking, so it needs no author line. */
export function endsWithAssistant(entries: readonly TranscriptEntry[]): boolean {
  const last = entries.at(-1);
  return Boolean(last && !last.isSidechain && (last.role === 'assistant' || last.blocks.every((b) => b.type === 'tool_result')));
}

/**
 * How tall a row will be, before it has ever been drawn. A step is one folded line; a message is
 * its text at the width it will wrap to, plus what each block of another kind takes. Rough on
 * purpose and never exact — it only has to be closer than "every row is 140px", which is what the
 * list reserved before and had to take back, in front of the reader, the moment a row was measured.
 */
const sizeHint = (row: TranscriptRow): number | undefined => (row.kind === 'entry' ? streamedHeight.get(row.entry) : undefined);

function estimateRow(row: TranscriptRow, width: number): number {
  if (row.kind === 'step') return 40;
  if (row.kind === 'compaction') return row.boundary ? 36 : 40;
  const perLine = Math.max(20, Math.floor((width - 44) / 7.2));
  let lines = 0;
  let extra = 0;
  for (const block of row.entry.blocks) {
    if (block.type === 'text' || block.type === 'thinking') lines += Math.ceil(block.text.length / perLine) + (block.text.match(/\n/g)?.length ?? 0) / 2;
    else if (block.type === 'tool_result') extra += 44;
    else if (block.type === 'tool_use') extra += 44;
    else extra += 190; // an image or a document, shown as a thumbnail or a chip
  }
  const head = row.continued ? 0 : 24;
  return Math.min(1400, head + extra + Math.ceil(lines) * 21 + 12);
}

export function Transcript({
  rows,
  entries,
  pinToBottom = false,
  onReachTop,
  focus,
  working = false,
  subagents,
  branches,
  messages,
  edits,
  compactions,
}: {
  entries: TranscriptEntry[];
  /** The rows of `entries`, when the caller has already worked them out */
  rows?: TranscriptRow[];
  pinToBottom?: boolean;
  onReachTop?: () => void;
  focus?: { item: TranscriptEntry } | null;
  /** The chat is working: its last step is the one being worked on */
  working?: boolean;
  subagents?: SubagentLink;
  /** What the chat delegated: each subagent, background command and workflow is a card under the step that started it */
  branches?: BranchLinks;
  /** What a message's menu offers; stable across renders, or every message is drawn again */
  messages?: MessageActions;
  /** The chat's edits: each step that edited files shows a chip per file, into the review */
  edits?: TranscriptEdits;
  /** What a compaction's fold offers: saving its summary as a note, a callback of the app's */
  compactions?: CompactionActions;
}) {
  const own = useMemo(() => rows ?? transcriptRows(entries), [rows, entries]);
  const target = focus ? rowOf(own, focus.item) : undefined;
  const focused = useMemo(() => (target ? { item: target } : null), [target, focus]);
  const last = own.at(-1);
  // Worked out once per change of rows or branches; a step whose cards read the same keeps the very
  // array it had, so an activity line that moved in one card does not draw every step again
  const held = useRef(new Map<string, Branch[]>());
  const children = branches?.children;
  const cards = useMemo(() => {
    const byRow = new Map<string, Branch[]>();
    if (!children || children.subagents.length + children.backgroundTasks.length + children.workflows.length === 0) return byRow;
    for (const row of own) {
      if (row.kind !== 'step' || row.isSidechain) continue;
      const calls = row.parts.flatMap((part) => (part.kind === 'call' ? [part] : []));
      const found = branchesOfStep(calls, row, children);
      if (found.length === 0) continue;
      const before = held.current.get(row.key);
      byRow.set(row.key, before && sameBranches(before, found) ? before : found);
    }
    held.current = byRow;
    return byRow;
  }, [own, children]);
  return (
    <VirtualList className="transcript" items={own} itemKey={(row) => row.key} pinToBottom={pinToBottom} onReachTop={onReachTop} focus={focused} estimate={estimateRow} sizeHint={sizeHint}>
      {(row) =>
        row.kind === 'compaction' ? (
          <CompactionDivider
            boundary={row.boundary}
            summary={row.summary}
            summaryBody={row.summary ? <SummaryText entry={row.summary} /> : null}
            actions={compactions}
            focused={Boolean(focus && row.summary && focus.item === row.summary)}
          />
        ) : row.kind === 'entry' ? (
          // Only what a person sent: an answer of Claude's was already on screen as it was written
          <EntryView entry={row.entry} continued={row.continued} fresh={row.entry.role === 'user' && justStreamed(row.entry)} streamedCopy={row.entry.role === 'assistant' && justStreamed(row.entry)} actions={messages} />
        ) : (
          <StepView
            row={row}
            current={working && row === last}
            subagents={subagents}
            fresh={justStreamed(row.entries[row.entries.length - 1] ?? row.entries[0]!)}
            branches={cards.get(row.key)}
            onOpenBranch={branches?.open}
            edits={edits}
          />
        )
      }
    </VirtualList>
  );
}
