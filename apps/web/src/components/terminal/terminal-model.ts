import type { Terminal, TerminalEndReason, TerminalUnavailableReason } from '@claudio/shared';

/** The tone a status word is drawn in (`.term-status.<tone>`); each is also an icon and a word, never a colour alone. */
export type TerminalTone = 'ok' | 'warn' | 'bad' | 'neutral';

/** How the page's socket stands, apart from what the terminal itself is doing. */
export type LinkState = 'connecting' | 'open' | 'reconnecting' | 'ended';

/** The words under `status.` in the `terminal` namespace */
export type StatusKey =
  | 'connected' | 'connecting' | 'reconnecting' | 'detached' | 'exited' | 'exitedWith'
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
  if (link === 'ended') return { tone: 'neutral', key: 'detached' };
  return { tone: 'ok', key: 'connected' };
}

/** The `terminal` key that words why the feature is not available here. */
export function unavailableKey(reason: TerminalUnavailableReason): `unavailable.${TerminalUnavailableReason}` {
  return `unavailable.${reason}`;
}

/** The last part of a path: what a tab can hold of a directory. */
export function baseName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
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
