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
  | 'agent-message-auto';

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
}

// Longest first within a family: a prefix must never shadow a longer one that starts the same way
const READERS: readonly { prefix: string; kind: SystemMessageKind; source: SystemMessageSource }[] = [
  { prefix: CHAT_HINT_PREFIX, kind: 'hint', source: 'person' },
  { prefix: ORCHESTRATION_HINT_PREFIX, kind: 'orchestration-hint', source: 'person' },
  { prefix: AGENT_MESSAGE_PERSON_PREFIX, kind: 'agent-message-person', source: 'person' },
  { prefix: CANCEL_NOTICE_PREFIX, kind: 'cancel', source: 'person' },
  { prefix: SUPERVISOR_HINT_PREFIX, kind: 'auto-hint', source: 'supervisor' },
  { prefix: AUTO_HINT_PREFIX, kind: 'auto-hint', source: 'claudio' },
  { prefix: AGENT_MESSAGE_AUTO_PREFIX, kind: 'agent-message-auto', source: 'claudio' },
  { prefix: AUTO_CANCEL_NOTICE_PREFIX, kind: 'auto-cancel', source: 'claudio' },
  { prefix: NOTE_PREFIX, kind: 'note', source: 'claudio' },
  { prefix: CONTINUATION_PREFIX, kind: 'continuation', source: 'claudio' },
  { prefix: FLOW_RESTART_PREFIX, kind: 'flow-restart', source: 'claudio' },
  { prefix: LIMIT_CONTINUE_TEXT, kind: 'limit-continue', source: 'claudio' },
  { prefix: RESUME_PROMPT, kind: 'assistant-resume', source: 'claudio' },
];

/** What kind of Claudio-written message a text is, or null when it is not one (a person's own words, an agent's). */
export function readSystemMessage(text: string): SystemMessage | null {
  const t = text.trimStart();
  for (const r of READERS) {
    if (t.startsWith(r.prefix)) return { kind: r.kind, source: r.source, words: t.slice(r.prefix.length).trim() };
  }
  return null;
}

/** The prefixes of the messages a person's own words travel in, for the lessons' signals, which read the person's corrections */
export const PERSON_HINT_PREFIXES: readonly string[] = [CHAT_HINT_PREFIX, ORCHESTRATION_HINT_PREFIX];
/** The prefixes of the nudges nobody typed, which the lessons' signals skip */
export const NUDGE_PREFIXES: readonly string[] = [CONTINUATION_PREFIX, FLOW_RESTART_PREFIX, RESUME_PROMPT];
