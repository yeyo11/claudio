import type { Account, NoRoomRule, RunEvent } from '@claudio/shared';

/**
 * The messages nobody typed.
 *
 * Claude Code writes a few things into the transcript as if they came from the person: a background
 * task that finished, a reminder the harness injected, the output of a slash command, the note left
 * when a turn was interrupted. They arrive as `user` entries full of tags, and shown as a message
 * they read like the person suddenly speaking XML. Read here into what they actually say, so the
 * page can show them as what they are — something the system said, next to the conversation.
 */

export type NoticeKind = 'task' | 'reminder' | 'command' | 'output' | 'interrupt' | 'compaction-failed' | 'account' | 'credits' | 'credits-stopped' | 'guard' | 'no-room';

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
  /** For `account`: the chat moved to an account of another configuration group, and which it now uses */
  config?: 'own' | 'shared';
  /** For `account`: the rotation moved it at a limit, not a person */
  rotated?: boolean;
  /** For `no-room`: when the first allowed account is back (ISO), whether one turn elsewhere is offered, and the rule is that of chats of no project */
  until?: string | null;
  once?: boolean;
  loose?: boolean;
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

/**
 * The text of the transcript line "Switched to X": a notice of the page's own, not a message of the
 * CLI. `config` says the chat crossed into another configuration (docs/plans/account-configuration-and-project-rules.md
 * §6.5): its next turns run with the new account's own configuration, or with the shared one.
 * `rotated`: the rotation moved it at a limit, not a person.
 */
export const accountSwitchText = (name: string, config?: 'own' | 'shared', rotated = false): string =>
  `<${ACCOUNT_SWITCH_TAG}>${rotated ? 'rotated:' : ''}${config ? `${config}-config:` : ''}${name}</${ACCOUNT_SWITCH_TAG}>`;

/**
 * An account's configuration group as the rotation reads it (`configGroupOf` in @claudio/accounts):
 * every shared account and the default one are one group, each independent account its own. An
 * account the list does not describe counts as shared.
 */
export const configGroup = (account: Pick<Account, 'id' | 'config'> | undefined): string => (account?.config?.mode === 'independent' ? account.id : 'shared');

/** Whether moving from one account to another changes the configuration the chat runs with, and to which */
export function configCrossing(from: Pick<Account, 'id' | 'config'> | undefined, to: Pick<Account, 'id' | 'config'> | undefined): 'own' | 'shared' | undefined {
  if (!from || !to || configGroup(from) === configGroup(to)) return undefined;
  return to.config?.mode === 'independent' ? 'own' : 'shared';
}

/** A switch the transcript tells: a person's, or the rotation's own at a limit (`rotation`) */
const switchOf = (e: RunEvent): Record<string, unknown> | undefined => {
  const data = e.kind === 'notice' ? e.data : undefined;
  return data?.reason === 'person' || data?.reason === 'rotation' ? data : undefined;
};

/** The account a switch left, when the event says so */
export function switchedFrom(e: RunEvent): string | null {
  const data = switchOf(e);
  return typeof data?.from === 'string' ? data.from : null;
}

/**
 * The account a person, or the rotation at a limit, switched the chat to, when the event says so.
 * The `data` of a notice is Claudio's own words (never a provider's), which is why it may be read here.
 */
export function switchedAccount(e: RunEvent): string | null {
  const data = switchOf(e);
  return typeof data?.account === 'string' ? data.account : null;
}

/** Whether the switch was the rotation's, at a limit, rather than a person's */
export const switchedByRotation = (e: RunEvent): boolean => switchOf(e)?.reason === 'rotation';

/** The tag Claudio's own line for a project rule that left no account with room travels in; the CLI never writes it. */
export const NO_ROOM_TAG = 'claudio-no-room';

/** The project rule a notice says left the chat with no account with room (`data.reason: 'no-room'`) */
export function noRoomNotice(e: RunEvent): NoRoomRule | null {
  const data = e.kind === 'notice' ? e.data : undefined;
  if (data?.reason !== 'no-room' || !data.rule || typeof data.rule !== 'object') return null;
  const rule = data.rule as Partial<NoRoomRule>;
  return {
    project: typeof rule.project === 'string' ? rule.project : null,
    resetsAt: typeof rule.resetsAt === 'string' ? rule.resetsAt : null,
    choices: Array.isArray(rule.choices) ? rule.choices.filter((c) => c === 'wait' || c === 'once') : ['wait'],
  };
}

/**
 * The text of the transcript line for it, as JSON inside the tag: the project's name (null when the
 * page does not know it, and for the rule of chats of no project, which `loose` says), the reset and
 * whether one turn on another account is offered.
 */
export const noRoomText = (projectName: string | null, rule: NoRoomRule): string =>
  `<${NO_ROOM_TAG}>${JSON.stringify({ project: rule.project === null ? null : projectName, loose: rule.project === null, until: rule.resetsAt, once: rule.choices.includes('once') })}</${NO_ROOM_TAG}>`;

function noRoomOf(raw: string): Notice {
  try {
    const value = JSON.parse(raw) as { project?: unknown; loose?: unknown; until?: unknown; once?: unknown };
    return {
      kind: 'no-room',
      detail: typeof value.project === 'string' ? value.project : '',
      body: '',
      until: typeof value.until === 'string' ? value.until : null,
      once: value.once === true,
      loose: value.loose === true,
    };
  } catch {
    return { kind: 'no-room', detail: '', body: '', until: null, once: false, loose: false };
  }
}

/** The tag Claudio's own line for a turn on an account's usage credits travels in; the CLI never writes it. */
export const CREDITS_TAG = 'claudio-credits';

/**
 * A turn that runs on its account's usage credits (`paid`), or was stopped because the account's
 * credits setting does not let them pay (`stopped`): what Claudio's own notice says, from its `data`.
 */
export function creditsNotice(e: RunEvent): { account: string; stopped: boolean } | null {
  const data = e.kind === 'notice' ? e.data : undefined;
  return data?.reason === 'credits' && typeof data.account === 'string' ? { account: data.account, stopped: typeof data.stopped === 'string' } : null;
}

/** The text of the transcript line for it: the account's name, and whether the turn was stopped. */
export const creditsText = (name: string, stopped: boolean): string => `<${CREDITS_TAG}>${stopped ? 'stopped' : 'paid'}:${name}</${CREDITS_TAG}>`;

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
  take(ACCOUNT_SWITCH_TAG, (raw) => {
    const rotated = raw.startsWith('rotated:');
    const rest = rotated ? raw.slice('rotated:'.length) : raw;
    const crossed = /^(own|shared)-config:/.exec(rest);
    const notice: Notice = crossed ? { kind: 'account', detail: rest.slice(crossed[0].length), body: '', config: crossed[1] === 'own' ? 'own' : 'shared' } : { kind: 'account', detail: rest, body: '' };
    return rotated ? { ...notice, rotated: true } : notice;
  });
  take(NO_ROOM_TAG, noRoomOf);
  take(CREDITS_TAG, (raw) => ({ kind: raw.startsWith('stopped:') ? 'credits-stopped' : 'credits', detail: raw.replace(/^(stopped|paid):/, ''), body: '' }));
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
