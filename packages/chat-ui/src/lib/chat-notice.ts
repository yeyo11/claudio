import type { RunEvent, RunGuardEvent } from '@claudio/shared';

/**
 * The messages nobody typed.
 *
 * Claude Code writes a few things into the transcript as if they came from the person: a background
 * task that finished, a reminder the harness injected, the output of a slash command, the note left
 * when a turn was interrupted. They arrive as `user` entries full of tags, and shown as a message
 * they read like the person suddenly speaking XML. Read here into what they actually say, so the
 * page can show them as what they are — something the system said, next to the conversation.
 */

export type NoticeKind = 'task' | 'reminder' | 'command' | 'output' | 'interrupt' | 'compaction-failed' | 'account' | 'guard';

export interface Notice {
  kind: NoticeKind;
  /** The single line the row shows */
  detail: string;
  /** Everything else, kept behind a fold; empty when the line is the whole of it */
  body: string;
  /** How a background task ended (`completed`, `failed`, …) */
  status?: string;
  /** For `guard`: the rule that fired, and the guard never having run for the call (`missing`) */
  rule?: string;
  missing?: boolean;
}

const TAG = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'g');
const inner = (text: string, name: string): string => new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(text)?.[1]?.trim() ?? '';

/** `[Request interrupted by user]`, and the variants the CLI writes around it. */
const INTERRUPT = /^\[Request interrupted[^\]]*\]$/;

function taskNotice(raw: string): Notice {
  const status = inner(raw, 'status');
  const summary = inner(raw, 'summary');
  const file = inner(raw, 'output-file');
  return { kind: 'task', status: status || undefined, detail: summary || inner(raw, 'task-id'), body: file };
}

/** The tag Claudio's own line for a person's account switch travels in; the CLI never writes it. */
export const ACCOUNT_SWITCH_TAG = 'claudio-account-switch';

/** The text of the transcript line "Switched to X": a notice of the page's own, not a message of the CLI. */
export const accountSwitchText = (name: string): string => `<${ACCOUNT_SWITCH_TAG}>${name}</${ACCOUNT_SWITCH_TAG}>`;

/**
 * The account a person switched the chat to, when the event says so. The `data` of a notice is
 * Claudio's own words (never a provider's), which is why it may be read here.
 */
export function switchedAccount(e: RunEvent): string | null {
  const data = e.kind === 'notice' ? e.data : undefined;
  return data?.reason === 'person' && typeof data.account === 'string' ? data.account : null;
}

/**
 * The notices in one message and the prose left around them: a person's message that carries a
 * reminder is still their message, so only what they wrote stays in the bubble.
 */
export function readNotices(text: string): { prose: string; notices: Notice[] } {
  const notices: Notice[] = [];
  let prose = text;
  const take = (name: string, make: (raw: string) => Notice) => {
    prose = prose.replace(TAG(name), (_match, raw: string) => {
      notices.push(make(raw.trim()));
      return '';
    });
  };
  take(ACCOUNT_SWITCH_TAG, (raw) => ({ kind: 'account', detail: raw, body: '' }));
  take('task-notification', (raw) => taskNotice(raw));
  take('system-reminder', (raw) => ({ kind: 'reminder', detail: firstLine(raw), body: rest(raw) }));
  // The CLI's own error for a compaction that did not happen: the line says so, its words are the fold
  take('local-command-stderr', (raw) =>
    /compact/i.test(raw) ? { kind: 'compaction-failed', detail: firstLine(raw), body: rest(raw) } : { kind: 'output', detail: firstLine(raw), body: rest(raw) },
  );
  take('local-command-stdout', (raw) => ({ kind: 'output', detail: firstLine(raw), body: rest(raw) }));
  // A slash command: its name is the line, its arguments and the message it expanded to are the body
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(prose);
  if (command) {
    const args = inner(prose, 'command-args');
    const message = inner(prose, 'command-message');
    notices.push({ kind: 'command', detail: `${(command[1] ?? '').trim()}${args ? ` ${args}` : ''}`.trim(), body: message });
    prose = prose.replace(/<command-(name|args|message|contents)>[\s\S]*?<\/command-\1>/g, '');
  }
  prose = prose
    .split('\n')
    .filter((line) => {
      if (!INTERRUPT.test(line.trim())) return true;
      notices.push({ kind: 'interrupt', detail: line.trim().replace(/^\[|\]$/g, ''), body: '' });
      return false;
    })
    .join('\n');
  return { prose: prose.trim(), notices };
}

const firstLine = (text: string): string => text.split('\n').find((line) => line.trim())?.trim() ?? '';

const rest = (text: string): string => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim());
  return lines.slice(start + 1).join('\n').trim();
};

/** What the guard program writes first on a block (docs/plans/guards.md, output contract); the CLI wraps it as `PreToolUse:<tool> hook error: [<command>]: `. */
const GUARD_BLOCK = /Claudio guard blocked this \(([^)\n]+)\): ([^\n]*)/;

/**
 * A guard block as the CLI recorded it in a failed `tool_result`, or null for any other text.
 * `excerpt` is what the call was pointed at, which the result does not carry: the caller has the call.
 */
export function readGuardResult(content: string, excerpt: string): Notice | null {
  const hit = GUARD_BLOCK.exec(content);
  if (!hit) return null;
  return { kind: 'guard', rule: (hit[1] ?? '').trim(), detail: excerpt, body: (hit[2] ?? '').trim() };
}

/**
 * Whether any of a step's calls came back as a guard block. Such a step stays open once it is done:
 * the strip is what the reader must see, and a folded step would hide it behind "1 failed".
 */
export function holdsGuardBlock(parts: ReadonlyArray<{ kind: string; result?: { content: string; isError: boolean } | null }>): boolean {
  return parts.some((part) => part.kind === 'call' && part.result?.isError === true && GUARD_BLOCK.test(part.result.content));
}

/** The same strip from the live `guard` event, which already has the masked excerpt. Only a block and a guard that did not run are shown. */
export function guardEventNotice(guard: RunGuardEvent): Notice | null {
  if (guard.outcome !== 'blocked' && guard.outcome !== 'error' && guard.outcome !== 'missing') return null;
  return { kind: 'guard', rule: guard.rule, detail: guard.excerpt, body: guard.reason, ...(guard.outcome === 'missing' ? { missing: true } : {}) };
}
