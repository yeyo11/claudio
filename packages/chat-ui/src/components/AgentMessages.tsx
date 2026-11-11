import { ArrowRight, Bot, CircleX } from 'lucide-react';
import { createContext, lazy, memo, Suspense, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import type { SystemMessage } from '@claudio/shared';
import { useTranslation } from 'react-i18next';
import { Collapsible } from '@claudio/ui/components/controls/Collapsible';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { ClaudioGlyph, ICON_SM } from '@claudio/ui/components/icons';
import { Tag } from '@claudio/ui/components/ui';
import { formatClock, formatDateTime } from '@claudio/ui/lib/format';
import { upperFirst } from '../lib/agent';
import { isLeadAddress } from '../lib/agent-messages';

/*
 * The messages agents send each other and the ones Claudio writes itself (docs/plans/agent-messages.md,
 * D5 and Design): an agent message card, `sender → receiver`, and a system row with Claudio's mark.
 * Neither is a bubble, because neither was typed by the person following the chat.
 */

const Markdown = lazy(() => import('@claudio/ui/components/Markdown'));

/**
 * Who the agents in a transcript are: the subagent whose transcript it is (none on the lead's), the
 * name of any other one by its id, and how to open it. A name the page cannot resolve falls back to
 * what the line itself says.
 */
export interface AgentDirectory {
  self?: { id: string; name: string };
  name: (agentId: string) => string | null;
  open?: (agentId: string) => void;
}

const DirectoryContext = createContext<AgentDirectory | null>(null);
export const AgentDirectoryScope = DirectoryContext.Provider;
export const useAgentDirectory = (): AgentDirectory | null => useContext(DirectoryContext);

/** One end of a message: the lead, the person, a subagent by id, or a name the line gave. */
export type AgentEnd = { kind: 'lead' } | { kind: 'you' } | { kind: 'self' } | { kind: 'agent'; id: string; fallback?: string | null } | { kind: 'named'; name: string };

/** The end a `to` or `from` address names, as seen from the transcript it is drawn in. */
export function endOf(address: string, directory: AgentDirectory | null, fallback?: string | null): AgentEnd {
  if (isLeadAddress(address)) return { kind: 'lead' };
  if (directory?.self && directory.self.id === address) return { kind: 'self' };
  return { kind: 'agent', id: address, fallback };
}

type T = TFunction<'chat'>;

/** The words an end is called by: the lead is "Lead", a subagent its description, else what the line said. */
export function endName(end: AgentEnd, directory: AgentDirectory | null, t: T): string {
  switch (end.kind) {
    case 'lead':
      return t('agentMessage.lead');
    case 'you':
      return t('agentMessage.you');
    case 'self':
      return directory?.self?.name ?? upperFirst(t('transcript.subagent'));
    case 'agent':
      return directory?.name(end.id) ?? end.fallback ?? end.id;
    case 'named':
      return end.name;
  }
}

/** A name in a head: a subagent another view is about opens it; the one this view is about, the lead and the person stay text. */
export function EndName({ end }: { end: AgentEnd }) {
  const { t } = useTranslation('chat');
  const directory = useAgentDirectory();
  const name = endName(end, directory, t);
  const open = end.kind === 'agent' && directory?.open && directory.name(end.id) !== null ? directory.open : null;
  if (open && end.kind === 'agent') {
    return (
      <Tooltip content={t('agentMessage.open', { agent: name })}>
        <button type="button" className="link-btn agent-msg-name" aria-label={t('agentMessage.open', { agent: name })} onClick={() => open(end.id)}>
          {name}
        </button>
      </Tooltip>
    );
  }
  return (
    <span className={`agent-msg-name ${end.kind === 'lead' || end.kind === 'you' ? 'is-short' : ''}`.trimEnd()} title={name}>
      {name}
    </span>
  );
}

function Time({ at }: { at: string | null }) {
  if (!at) return null;
  return (
    <time className="agent-msg-time" dateTime={at} title={formatDateTime(at)}>
      {formatClock(at)}
    </time>
  );
}

/**
 * The body, folded to three lines when it is longer. Measured, not guessed: Markdown lays out at the
 * card's width, and only the browser knows where its third line ends.
 */
function ClampedBody({ text }: { text: string }) {
  const { t } = useTranslation('chat');
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    for (const child of Array.from(el.children)) watch.observe(child);
    return () => watch.disconnect();
  }, [open, text]);
  return (
    <>
      <div ref={body} className={`agent-msg-body rich md ${open ? '' : 'is-clamped'}`.trimEnd()}>
        <Suspense fallback={<div className="prose">{text}</div>}>
          <Markdown text={text} />
        </Suspense>
      </div>
      {(long || open) && (
        <button type="button" className="link-btn agent-msg-more" aria-expanded={open} onClick={() => setOpen((on) => !on)}>
          {open ? t('agentMessage.less') : t('agentMessage.more')}
        </button>
      )}
    </>
  );
}

/**
 * A message one agent sent another. The same card for what the lead sends (`SendMessage`, under its
 * step) and what an agent receives, so a reader follows one conversation whichever side they read.
 */
export const AgentMessageCard = memo(function AgentMessageCard({
  from,
  to,
  body,
  at,
  handback = false,
  notSent,
}: {
  from: AgentEnd;
  to: AgentEnd;
  body: string;
  at: string | null;
  /** The sender's final report, handed back */
  handback?: boolean;
  /** It did not go out: the CLI's reason */
  notSent?: { reason: string };
}) {
  const { t } = useTranslation('chat');
  return (
    <div className={`agent-msg ${notSent ? 'is-not-sent' : ''}`.trimEnd()}>
      <div className="agent-msg-head">
        <Bot {...ICON_SM} className="agent-msg-glyph" aria-hidden />
        <EndName end={from} />
        <ArrowRight size={12} strokeWidth={2} className="agent-msg-arrow" aria-label={t('agentMessage.to')} />
        <EndName end={to} />
        {handback && <Tag tone="info">{t('agentMessage.report')}</Tag>}
        {notSent && (
          <span className="agent-msg-not-sent">
            <CircleX {...ICON_SM} aria-hidden />
            {t('agentMessage.notSent')}
          </span>
        )}
        <Time at={at} />
      </div>
      {body && <ClampedBody text={body} />}
      {notSent?.reason && <p className="agent-msg-reason">{notSent.reason}</p>}
    </div>
  );
});

/**
 * Something Claudio or its Supervisor wrote into the chat, or a record of what the person sent a
 * subagent: one line with Claudio's mark, outside the bubbles. `received` is the exact text the agent
 * read, prefix and all, behind a fold; without it the line is all there is.
 */
export function SystemRow({ label, words, at, received, labelText }: { label: ReactNode; words: string; at: string | null; received?: string | null; labelText?: string }) {
  const { t } = useTranslation('chat');
  const line = (
    <>
      <ClaudioGlyph {...ICON_SM} className="sys-msg-glyph" aria-hidden />
      <span className="sys-msg-label" title={labelText}>
        {label}
      </span>
      <span className="sys-msg-words" title={words}>
        {words}
      </span>
      <Time at={at} />
    </>
  );
  if (!received) return <div className="sys-msg">{line}</div>;
  return (
    <Collapsible className="fold sys-msg sys-msg-fold" title={line}>
      <div className="sys-msg-received">
        <span className="sys-msg-received-label">{t('system.received')}</span>
        <div className="sys-msg-text">{received}</div>
      </div>
    </Collapsible>
  );
}

/**
 * A message for one subagent the lead was asked to pass on, because the bridge could not carry it
 * straight: "You → E2 · through the lead", or the Supervisor's. The lead did read it, so the fold holds
 * the exact text. The name is plain text here: a fold's line is a button, and one cannot hold another.
 */
export function LeadRelayRow({ message, text, at }: { message: SystemMessage; text: string; at: string | null }) {
  const { t } = useTranslation('chat');
  const directory = useAgentDirectory();
  const fallback = message.agent?.name || null;
  const end: AgentEnd = message.agent?.agentId ? { kind: 'agent', id: message.agent.agentId, fallback } : { kind: 'named', name: fallback ?? upperFirst(t('transcript.subagent')) };
  const agent = endName(end, directory, t);
  const bySupervisor = message.kind === 'relay-supervisor';
  const first = message.words.split('\n').find((line) => line.trim())?.trim() ?? '';
  return (
    <SystemRow
      labelText={t(bySupervisor ? 'system.supervisorViaLead' : 'system.relayViaLead', { agent })}
      label={
        <span className="sys-msg-relay">
          {bySupervisor ? t('system.supervisor') : t('agentMessage.you')}
          <ArrowRight size={12} strokeWidth={2} className="agent-msg-arrow" aria-label={t('agentMessage.to')} />
          <span className="agent-msg-name" title={agent}>
            {agent}
          </span>
          {t('system.viaLead')}
        </span>
      }
      words={first}
      at={at}
      received={text.trim()}
    />
  );
}

/**
 * The lead's record of a message the person wrote straight to a subagent: "You → E2: <first line>".
 * The lead never saw it, so it is the system's line in the lead's transcript, not a bubble; the
 * subagent's name opens its view. It never folds: the name is a button, and a fold's line is one too.
 */
export function RelayRow({ agentId, words, at }: { agentId: string; words: string; at: string | null }) {
  const { t } = useTranslation('chat');
  const directory = useAgentDirectory();
  const end: AgentEnd = { kind: 'agent', id: agentId };
  const agent = endName(end, directory, t);
  const first = words.split('\n').find((line) => line.trim())?.trim() ?? '';
  return (
    <SystemRow
      labelText={t('system.relay', { agent })}
      label={
        <span className="sys-msg-relay">
          {t('agentMessage.you')}
          <ArrowRight size={12} strokeWidth={2} className="agent-msg-arrow" aria-label={t('agentMessage.to')} />
          <EndName end={end} />
        </span>
      }
      words={first}
      at={at}
    />
  );
}
