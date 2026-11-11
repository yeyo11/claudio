/**
 * The texts Claudio writes into a chat itself, and how to read them back. They are defined once, here,
 * so the writers (core), the fold that tells a person's words from Claudio's (lessons' signals) and the
 * page that draws each kind its own way (chat-ui) cannot drift apart. The English wording is fixed: a
 * recorded transcript is read by these prefixes, so changing one breaks every chat written before.
 */

/** How Claudio begins a hint a person typed for the lead of a chat */
export const CHAT_HINT_PREFIX = 'A hint from the person following this chat:';
/** ...and the notice of a command the person cancelled */
export const CANCEL_NOTICE_PREFIX = 'A person cancelled the command';
/**
 * How Claudio begins a hint nobody typed (Claudio's own, before the Supervisor had a prefix of its
 * own): the agent must not take it for the person's word.
 */
export const AUTO_HINT_PREFIX = 'An automatic hint from Claudio, not from the person following this chat:';
/** ...and the notice of a command it cancelled on its own */
export const AUTO_CANCEL_NOTICE_PREFIX = 'Claudio cancelled the command on its own';
/** How the hint a person sends a worker of an orchestration begins */
export const ORCHESTRATION_HINT_PREFIX = 'A hint from the person following this orchestration:';
/** How Claudio's own note to a worker begins (the time warning) */
export const NOTE_PREFIX = 'A note from Claudio:';
/** How a continuation prompt begins: Claudio's nudge, not the person's words */
export const CONTINUATION_PREFIX = 'Your turn ended, but the work is not finished';
/** How the nudge to a run continued after a restart begins */
export const FLOW_RESTART_PREFIX = 'Claudio restarted while you were on this run.';
/** What a chat is told once its provider limit has reset and no turn of its own is left to replay */
export const LIMIT_CONTINUE_TEXT = "The provider's usage limit has reset. Continue the work you were doing where you left off.";
/** Told to a run's chat continued after Claudio restarted in the middle of it */
export const RESUME_PROMPT = 'Claudio restarted while you were working on this. Carry on from where you were, still read-only, and end with the structured result.';
/** How a person's message written straight to one subagent begins, which says the lead does not see it */
export const AGENT_MESSAGE_PERSON_PREFIX = 'A message from the person following this chat, written to you directly (the lead agent does not see it):';
/** How an automatic message to one subagent begins; the CLI wraps it as "The coordinator sent a message" */
export const AGENT_MESSAGE_AUTO_PREFIX = 'An automatic message from Claudio, not from the person following this chat:';
/** How the Supervisor's hint begins, so the page can say "Supervisor" and not "Claudio" */
export const SUPERVISOR_HINT_PREFIX = "An automatic hint from Claudio's Supervisor, not from the person following this chat:";
/**
 * How the Supervisor's message written straight to one subagent begins: D3's automatic prefix said
 * "Claudio", so the subagent's row could not say "Supervisor". Recorded ones still read as Claudio's.
 */
export const AGENT_MESSAGE_SUPERVISOR_PREFIX = "An automatic message from Claudio's Supervisor, not from the person following this chat:";
/**
 * How a message for one subagent that the lead must pass on begins, when it could not be written to
 * the subagent straight: the person's, or the Supervisor's. The subagent's name (and its agent id,
 * when known, which `SendMessage` takes) sits between the head and the tail, so the lead knows whom to
 * pass it to; `relayToSubagent` writes it and `readSystemMessage` reads it back.
 */
export const RELAY_PERSON_HEAD = 'A message from the person following this chat for your subagent ';
export const RELAY_PERSON_TAIL = '; pass it on verbatim with SendMessage:';
export const RELAY_SUPERVISOR_HEAD = "An automatic message from Claudio's Supervisor for your subagent ";
export const RELAY_SUPERVISOR_TAIL = ', which looks stuck; pass it on verbatim with SendMessage, or stop it if it cannot get past it:';

/** Whom a relay is for: the subagent's name as its launch described it, and its CLI agent id when known */
export interface RelayTarget {
  name: string;
  agentId?: string;
}

// A backtick would end the code span the name and the id travel in
const unticked = (value: string): string => value.replace(/`/g, "'").replace(/\s+/g, ' ').trim();

/** The text the lead reads for a message it must pass on to one of its subagents. */
export function relayToSubagent(source: 'person' | 'supervisor', target: RelayTarget, words: string): string {
  const head = source === 'person' ? RELAY_PERSON_HEAD : RELAY_SUPERVISOR_HEAD;
  const tail = source === 'person' ? RELAY_PERSON_TAIL : RELAY_SUPERVISOR_TAIL;
  const id = target.agentId ? ` (agent id \`${unticked(target.agentId)}\`)` : '';
  return `${head}\`${unticked(target.name) || 'unnamed'}\`${id}${tail}\n\n${words.trim()}`;
}

export type SystemMessageKind =
  | 'hint'
  | 'auto-hint'
  | 'cancel'
  | 'auto-cancel'
  | 'orchestration-hint'
  | 'note'
  | 'continuation'
  | 'flow-restart'
  | 'limit-continue'
  | 'assistant-resume'
  | 'agent-message-person'
  | 'agent-message-auto'
  | 'relay-person'
  | 'relay-supervisor';

/** `person`: typed by a person and framed by Claudio. `supervisor`: the Supervisor's hint. `claudio`: anything else Claudio wrote. */
export type SystemMessageSource = 'person' | 'supervisor' | 'claudio';

export interface SystemMessage {
  kind: SystemMessageKind;
  source: SystemMessageSource;
  /**
   * What follows the prefix, trimmed. A kind whose whole sentence is the prefix (`limit-continue`,
   * `assistant-resume`) or whose prefix is part of the sentence (`cancel`, `auto-cancel`, `continuation`,
   * `flow-restart`) keeps the sentence: `words` is what follows the prefix, trimmed, which is empty for
   * the two whole-sentence kinds, so a reader falls back to the full text there.
   */
  words: string;
  /** For a relay (`relay-person`, `relay-supervisor`): the subagent the lead was asked to pass it to */
  agent?: RelayTarget;
}

// Longest first within a family: a prefix must never shadow a longer one that starts the same way
const READERS: readonly { prefix: string; kind: SystemMessageKind; source: SystemMessageSource }[] = [
  { prefix: CHAT_HINT_PREFIX, kind: 'hint', source: 'person' },
  { prefix: ORCHESTRATION_HINT_PREFIX, kind: 'orchestration-hint', source: 'person' },
  { prefix: AGENT_MESSAGE_PERSON_PREFIX, kind: 'agent-message-person', source: 'person' },
  { prefix: CANCEL_NOTICE_PREFIX, kind: 'cancel', source: 'person' },
  { prefix: SUPERVISOR_HINT_PREFIX, kind: 'auto-hint', source: 'supervisor' },
  { prefix: AGENT_MESSAGE_SUPERVISOR_PREFIX, kind: 'agent-message-auto', source: 'supervisor' },
  { prefix: AUTO_HINT_PREFIX, kind: 'auto-hint', source: 'claudio' },
  { prefix: AGENT_MESSAGE_AUTO_PREFIX, kind: 'agent-message-auto', source: 'claudio' },
  { prefix: AUTO_CANCEL_NOTICE_PREFIX, kind: 'auto-cancel', source: 'claudio' },
  { prefix: NOTE_PREFIX, kind: 'note', source: 'claudio' },
  { prefix: CONTINUATION_PREFIX, kind: 'continuation', source: 'claudio' },
  { prefix: FLOW_RESTART_PREFIX, kind: 'flow-restart', source: 'claudio' },
  { prefix: LIMIT_CONTINUE_TEXT, kind: 'limit-continue', source: 'claudio' },
  { prefix: RESUME_PROMPT, kind: 'assistant-resume', source: 'claudio' },
];

const RELAYS: readonly { head: string; tail: string; kind: SystemMessageKind; source: SystemMessageSource }[] = [
  { head: RELAY_PERSON_HEAD, tail: RELAY_PERSON_TAIL, kind: 'relay-person', source: 'person' },
  { head: RELAY_SUPERVISOR_HEAD, tail: RELAY_SUPERVISOR_TAIL, kind: 'relay-supervisor', source: 'supervisor' },
];
const RELAY_TARGET = /^`([^`\n]*)`(?: \(agent id `([^`\n]*)`\))?/;

function readRelay(t: string): SystemMessage | null {
  for (const r of RELAYS) {
    if (!t.startsWith(r.head)) continue;
    const rest = t.slice(r.head.length);
    const target = RELAY_TARGET.exec(rest);
    if (!target || !rest.slice(target[0].length).startsWith(r.tail)) return null;
    const agent: RelayTarget = { name: target[1] ?? '', ...(target[2] ? { agentId: target[2] } : {}) };
    return { kind: r.kind, source: r.source, words: rest.slice(target[0].length + r.tail.length).trim(), agent };
  }
  return null;
}

/** What kind of Claudio-written message a text is, or null when it is not one (a person's own words, an agent's). */
export function readSystemMessage(text: string): SystemMessage | null {
  const t = text.trimStart();
  const relay = readRelay(t);
  if (relay) return relay;
  for (const r of READERS) {
    if (t.startsWith(r.prefix)) return { kind: r.kind, source: r.source, words: t.slice(r.prefix.length).trim() };
  }
  return null;
}

/** The prefixes of the messages a person's own words travel in, for the lessons' signals, which read the person's corrections */
export const PERSON_HINT_PREFIXES: readonly string[] = [CHAT_HINT_PREFIX, ORCHESTRATION_HINT_PREFIX];
/**
 * The prefixes of the nudges nobody typed, which the lessons' signals skip, and of the relays the lead
 * only passes on to a subagent: neither is the person correcting the lead.
 */
export const NUDGE_PREFIXES: readonly string[] = [CONTINUATION_PREFIX, FLOW_RESTART_PREFIX, RESUME_PROMPT, RELAY_PERSON_HEAD, RELAY_SUPERVISOR_HEAD];
