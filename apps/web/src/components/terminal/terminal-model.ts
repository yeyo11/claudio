import type { CreateTerminalRequest, Terminal, TerminalEndReason, TerminalUnavailableReason } from '@claudio/shared';

/** The tone a status word is drawn in (`.term-status.<tone>`); each is also an icon and a word, never a colour alone. */
export type TerminalTone = 'ok' | 'warn' | 'bad' | 'neutral';

/**
 * How the page's socket stands, apart from what the terminal itself is doing. `window`: not attached
 * here because the terminal is open in a window of its own.
 */
export type LinkState = 'connecting' | 'open' | 'reconnecting' | 'ended' | 'window';

/** The words under `status.` in the `terminal` namespace */
export type StatusKey =
  | 'connected' | 'connecting' | 'reconnecting' | 'detached' | 'elsewhere' | 'exited' | 'exitedWith'
  | 'idle' | 'serverStopped' | 'hostFailed' | 'disabled' | 'readOnly' | 'closed';

export interface TerminalStatusWord {
  tone: TerminalTone;
  key: StatusKey;
  params?: { code: number };
}

/** How each way a shell ends that the person did not type `exit` for is worded. */
const ENDED_BY: Partial<Record<TerminalEndReason, StatusKey>> = {
  idle: 'idle',
  'server-stopping': 'serverStopped',
  'server-crashed': 'serverStopped',
  'host-failed': 'hostFailed',
  disabled: 'disabled',
  'read-only': 'readOnly',
  closed: 'closed',
};

/**
 * The one word a terminal wears in its tab and header. An ended terminal says how it ended; a live
 * one says whether this page is attached. Reconnecting is `warn` and does not loop: only an agent
 * working moves.
 */
export function statusOf(terminal: Pick<Terminal, 'state' | 'endReason' | 'exitCode'>, link: LinkState): TerminalStatusWord {
  if (terminal.state !== 'running') {
    const by = terminal.endReason ? ENDED_BY[terminal.endReason] : undefined;
    if (by) return { tone: 'warn', key: by };
    const code = terminal.exitCode ?? 0;
    return code === 0 ? { tone: 'neutral', key: 'exited', params: { code } } : { tone: 'bad', key: 'exitedWith', params: { code } };
  }
  if (link === 'reconnecting') return { tone: 'warn', key: 'reconnecting' };
  if (link === 'connecting') return { tone: 'neutral', key: 'connecting' };
  if (link === 'window') return { tone: 'neutral', key: 'elsewhere' };
  if (link === 'ended') return { tone: 'neutral', key: 'detached' };
  return { tone: 'ok', key: 'connected' };
}

/** The `terminal` key that words why the feature is not available here. */
export function unavailableKey(reason: TerminalUnavailableReason): `unavailable.${TerminalUnavailableReason}` {
  return `unavailable.${reason}`;
}

const REASONS: readonly TerminalUnavailableReason[] = [
  'off', 'disabled-by-env', 'pty-missing', 'host-failed', 'read-only', 'needs-auth', 'remote-off', 'needs-tunnel', 'from-agent', 'chat-token',
];

/** What a person can do about a refusal, when there is something */
export type TerminalRefusalAction =
  /**
   * Opens a section of Settings → Access & safety. The only kind there is: a refusal that comes
   * from another device is judged again on every change made from there, so a button that changed
   * `remote` here could only be refused once more (the gate does not let a remote caller widen its
   * own access).
   */
  { kind: 'link'; label: 'protect' | 'tunnel' | 'access'; section: 'access' | 'remote' };

export interface TerminalRefusal {
  reason: TerminalUnavailableReason;
  /** `warn` for what a setting fixes, `bad` for what is broken */
  tone: 'warn' | 'bad';
  /** The `terminal` key of the sentence: the server's own text is never shown */
  sentence: `unavailable.${TerminalUnavailableReason}`;
  /** The way out, first the one that fixes it here; empty when only the environment can */
  actions: TerminalRefusalAction[];
}

const ACTIONS: Partial<Record<TerminalUnavailableReason, TerminalRefusalAction[]>> = {
  'needs-auth': [{ kind: 'link', label: 'protect', section: 'access' }],
  'needs-tunnel': [{ kind: 'link', label: 'tunnel', section: 'remote' }],
  'read-only': [{ kind: 'link', label: 'access', section: 'access' }],
};

/**
 * A refusal in the person's words, from the reason a status carries or from the `terminal.<reason>`
 * code the terminal routes answer with. Null for anything else (a network failure, a 500), which
 * keeps the generic message.
 */
export function terminalRefusal(source: unknown): TerminalRefusal | null {
  const code = typeof source === 'object' && source !== null ? (source as { code?: unknown }).code : null;
  const reason = typeof source === 'string' ? source : typeof code === 'string' && code.startsWith('terminal.') ? code.slice('terminal.'.length) : null;
  const known = REASONS.find((candidate) => candidate === reason);
  if (!known) return null;
  return { reason: known, tone: known === 'pty-missing' || known === 'host-failed' ? 'bad' : 'warn', sentence: unavailableKey(known), actions: ACTIONS[known] ?? [] };
}

/** The last part of a path: what a tab can hold of a directory. */
export function baseName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

/** The request that opens a terminal like this one: what "Open again" sends. */
export function requestFor(terminal: Pick<Terminal, 'scope'>): CreateTerminalRequest {
  const { scope } = terminal;
  return scope.kind === 'chat' ? { chatId: scope.chatId } : { projectId: scope.projectId, ...(scope.worktree ? { worktree: scope.worktree } : {}) };
}

/**
 * What a tab of the status bar's panel is called: the project's name for a terminal in its checkout,
 * the project and the folder for one in a worktree, the folder alone for a chat's or a project that
 * is no longer in the list. Two with the same label are numbered, so a tab is never ambiguous.
 */
export function tabLabels(terminals: readonly Terminal[], projectName: (id: string) => string | undefined): Map<string, string> {
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const terminal of terminals) {
    const folder = baseName(terminal.cwd);
    const project = terminal.scope.kind === 'project' ? projectName(terminal.scope.projectId) : undefined;
    const base = !project ? folder : terminal.scope.kind === 'project' && terminal.scope.worktree ? `${project} · ${folder}` : project;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    labels.set(terminal.id, n === 1 ? base : `${base} ${String(n)}`);
  }
  return labels;
}

/** How many terminals are running: the number the status bar shows. */
export const runningCount = (terminals: readonly Pick<Terminal, 'state'>[]): number => terminals.filter((terminal) => terminal.state === 'running').length;

/**
 * Whether Esc may close the panel: not when the key was meant for the shell (focus is inside xterm,
 * where Esc is a byte vim and the readline need) and not when something already took it (a menu, a
 * dialog, the search field).
 */
export function escapeClosesPanel(event: { key: string; defaultPrevented: boolean; target: unknown }): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  return !(typeof target?.closest === 'function' && target.closest('.xterm, .term-find, [role="menu"], [role="dialog"]'));
}

/** The running ones before the ones that ended, newest first, so the tab that matters comes first. */
export function orderTerminals(list: readonly Terminal[]): Terminal[] {
  return [...list].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.startedAt.localeCompare(a.startedAt));
}

// ---------- the renderer ----------

export interface RendererEnv {
  /** The `claudio-terminal-renderer` flag: `dom` forces the DOM renderer, `webgl` allows it on Linux */
  flag: string | null;
  compact: boolean;
  linux: boolean;
  webgl2: boolean;
  /** `WEBGL_debug_renderer_info`'s renderer string, when the browser gives it */
  gpu: string | null;
}

const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|virgl|software/i;

/**
 * The `auto` policy: WebGL only with hardware WebGL2, never on a phone or a software GL. A page cannot
 * tell Wayland from X11, and under Wayland on Linux WebGL wedged input in the terminal the plan
 * studied, so Linux takes the DOM renderer unless the flag asks for WebGL.
 */
export function chooseRenderer(env: RendererEnv): 'webgl' | 'dom' {
  if (env.flag === 'dom' || env.compact || !env.webgl2) return 'dom';
  if (env.gpu && SOFTWARE_GL.test(env.gpu)) return 'dom';
  if (env.linux && env.flag !== 'webgl') return 'dom';
  return 'webgl';
}

// ---------- the key bar ----------

export interface KeyDef {
  id: string;
  label: string;
  /** What is sent as it is, before Ctrl and Alt apply */
  send: string;
  /** Held down, the key repeats: the arrows */
  repeat?: boolean;
  /** An accessible name where the label is a symbol */
  name?: string;
}

const ESC = '\x1b';

export const KEY_BAR: readonly KeyDef[] = [
  { id: 'esc', label: 'Esc', send: ESC },
  { id: 'tab', label: 'Tab', send: '\t' },
  { id: 'shift-tab', label: '⇧Tab', send: `${ESC}[Z`, name: 'Shift+Tab' },
  { id: 'up', label: '↑', send: `${ESC}[A`, repeat: true, name: 'Up' },
  { id: 'down', label: '↓', send: `${ESC}[B`, repeat: true, name: 'Down' },
  { id: 'left', label: '←', send: `${ESC}[D`, repeat: true, name: 'Left' },
  { id: 'right', label: '→', send: `${ESC}[C`, repeat: true, name: 'Right' },
  { id: 'pipe', label: '|', send: '|' },
  { id: 'tilde', label: '~', send: '~' },
  { id: 'slash', label: '/', send: '/' },
  { id: 'dash', label: '-', send: '-' },
  { id: 'ctrl-c', label: '^C', send: '\x03', name: 'Ctrl+C' },
  { id: 'ctrl-d', label: '^D', send: '\x04', name: 'Ctrl+D' },
  { id: 'ctrl-l', label: '^L', send: '\x0c', name: 'Ctrl+L' },
  { id: 'ctrl-r', label: '^R', send: '\x12', name: 'Ctrl+R' },
];

/** The control byte for a letter (and the few marks terminals map), or null. */
export function ctrlByte(char: string): string | null {
  if (char.length !== 1) return null;
  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40);
  if (char === '?') return '\x7f';
  return null;
}

/**
 * What a key sends once the sticky modifiers apply. Ctrl turns one character into its control byte;
 * Alt puts an ESC before what is sent. A sequence (an arrow) takes Alt but not Ctrl, which has no
 * single byte for it.
 */
export function withModifiers(send: string, mods: { ctrl: boolean; alt: boolean }): string {
  let out = send;
  if (mods.ctrl && send.length === 1) out = ctrlByte(send) ?? send;
  return mods.alt ? `${ESC}${out}` : out;
}

/** How long a held arrow waits before it repeats, and the gap between repeats. */
export const REPEAT_AFTER_MS = 400;
export const REPEAT_EVERY_MS = 45;

// ---------- paste ----------

/** A paste above this is refused with a toast, never cut short. */
export const MAX_PASTE_BYTES = 1024 * 1024;
/** Characters per input frame: the socket takes 64 KiB, and a character here is at most three bytes. */
export const PASTE_CHUNK = 16 * 1024;

const SYMBOL_FOR_ESCAPE = '␛';

/**
 * An ESC inside pasted text would let `ESC[201~` end the bracketed paste early and run what follows
 * as typed commands, so each becomes the symbol for escape. A line ends in CR, as a keyboard's Enter does.
 */
export function cleanPaste(text: string): string {
  return text.replace(/\x1b/g, SYMBOL_FOR_ESCAPE).replace(/\r\n|\n/g, '\r');
}

export function pasteTooLarge(text: string): boolean {
  return new TextEncoder().encode(text).length > MAX_PASTE_BYTES;
}

export function pasteChunks(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + PASTE_CHUNK);
    // Never between the halves of a surrogate pair
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}
