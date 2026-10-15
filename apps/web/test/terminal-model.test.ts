import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseRenderer,
  escapeClosesPanel,
  requestFor,
  runningCount,
  tabLabels,
  cleanPaste,
  ctrlByte,
  KEY_BAR,
  MAX_PASTE_BYTES,
  orderTerminals,
  pasteChunks,
  pasteTooLarge,
  PASTE_CHUNK,
  statusOf,
  withModifiers,
  type RendererEnv,
} from '../src/components/terminal/terminal-model';
import type { Terminal } from '@claudio/shared';

const key = (id: string) => KEY_BAR.find((k) => k.id === id)?.send;

test('the key bar sends Esc, Tab and Shift+Tab as the bytes a terminal expects', () => {
  assert.equal(key('esc'), '\x1b');
  assert.equal(key('tab'), '\t');
  assert.equal(key('shift-tab'), '\x1b[Z');
  assert.equal(key('up'), '\x1b[A');
  assert.equal(key('down'), '\x1b[B');
  assert.equal(key('right'), '\x1b[C');
  assert.equal(key('left'), '\x1b[D');
});

test('the one-tap controls are the control bytes', () => {
  assert.equal(key('ctrl-c'), '\x03');
  assert.equal(key('ctrl-d'), '\x04');
  assert.equal(key('ctrl-l'), '\x0c');
  assert.equal(key('ctrl-r'), '\x12');
});

test('Ctrl plus a letter is the control byte, in either case', () => {
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    const expected = String.fromCharCode(letter.charCodeAt(0) - 96);
    assert.equal(ctrlByte(letter), expected, letter);
    assert.equal(ctrlByte(letter.toUpperCase()), expected, letter.toUpperCase());
  }
  assert.equal(ctrlByte('c'), '\x03');
  assert.equal(ctrlByte('1'), null);
  assert.equal(ctrlByte('ab'), null);
});

test('sticky Ctrl and Alt apply to the next key only through withModifiers', () => {
  assert.equal(withModifiers('c', { ctrl: true, alt: false }), '\x03');
  assert.equal(withModifiers('x', { ctrl: false, alt: true }), '\x1bx');
  assert.equal(withModifiers('b', { ctrl: true, alt: true }), '\x1b\x02');
  // An arrow is a sequence: Alt prefixes it, Ctrl has no single byte for it
  assert.equal(withModifiers('\x1b[A', { ctrl: true, alt: false }), '\x1b[A');
  assert.equal(withModifiers('\x1b[A', { ctrl: false, alt: true }), '\x1b\x1b[A');
  assert.equal(withModifiers('q', { ctrl: false, alt: false }), 'q');
});

test('a paste cannot end the bracketed paste early: every ESC becomes the symbol for escape', () => {
  const hostile = 'ls\x1b[201~; rm -rf ~';
  const cleaned = cleanPaste(hostile);
  assert.equal(cleaned.includes('\x1b'), false);
  assert.equal(cleaned, 'ls␛[201~; rm -rf ~');
});

test('lines of a paste end in CR, as Enter does', () => {
  assert.equal(cleanPaste('a\nb\r\nc'), 'a\rb\rc');
});

test('a paste is split into frames and joins back whole, never between the halves of a surrogate pair', () => {
  const text = `${'a'.repeat(PASTE_CHUNK - 1)}😀${'b'.repeat(40)}`;
  const chunks = pasteChunks(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= PASTE_CHUNK);
    const last = chunk.charCodeAt(chunk.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'no chunk ends on a high surrogate');
  }
  assert.deepEqual(pasteChunks(''), []);
});

test('a paste over 1 MiB is refused, counted in bytes', () => {
  assert.equal(pasteTooLarge('a'.repeat(MAX_PASTE_BYTES)), false);
  assert.equal(pasteTooLarge('a'.repeat(MAX_PASTE_BYTES + 1)), true);
  // 3 bytes each: well under a million characters is already over
  assert.equal(pasteTooLarge('€'.repeat(Math.ceil(MAX_PASTE_BYTES / 3) + 1)), true);
});

const env = (over: Partial<RendererEnv> = {}): RendererEnv => ({ flag: null, compact: false, linux: false, webgl2: true, gpu: 'ANGLE (Apple M2)', ...over });

test('the renderer: WebGL only with hardware WebGL2 on a desktop', () => {
  assert.equal(chooseRenderer(env()), 'webgl');
  assert.equal(chooseRenderer(env({ webgl2: false })), 'dom');
  assert.equal(chooseRenderer(env({ compact: true })), 'dom');
  assert.equal(chooseRenderer(env({ flag: 'dom' })), 'dom');
});

test('the renderer: a software GL is never used, and Linux needs the flag', () => {
  for (const gpu of ['Google SwiftShader', 'llvmpipe (LLVM 17)', 'virgl', 'Mesa softpipe']) assert.equal(chooseRenderer(env({ gpu })), 'dom', gpu);
  assert.equal(chooseRenderer(env({ linux: true })), 'dom');
  assert.equal(chooseRenderer(env({ linux: true, flag: 'webgl' })), 'webgl');
  assert.equal(chooseRenderer(env({ linux: true, flag: 'webgl', gpu: 'llvmpipe' })), 'dom');
});

const shell = (over: Partial<Pick<Terminal, 'state' | 'endReason' | 'exitCode'>>) => ({ state: 'running' as const, endReason: null, exitCode: null, ...over });

test('a status is a word and a tone: connected is ok, reconnecting warns, an exit code is neutral or bad', () => {
  assert.deepEqual(statusOf(shell({}), 'open'), { tone: 'ok', key: 'connected' });
  assert.deepEqual(statusOf(shell({}), 'reconnecting'), { tone: 'warn', key: 'reconnecting' });
  assert.deepEqual(statusOf(shell({}), 'connecting'), { tone: 'neutral', key: 'connecting' });
  assert.deepEqual(statusOf(shell({ state: 'exited', endReason: 'exit', exitCode: 0 }), 'ended'), { tone: 'neutral', key: 'exited', params: { code: 0 } });
  assert.deepEqual(statusOf(shell({ state: 'exited', endReason: 'exit', exitCode: 1 }), 'ended'), { tone: 'bad', key: 'exitedWith', params: { code: 1 } });
  assert.deepEqual(statusOf(shell({ state: 'closed', endReason: 'idle' }), 'ended'), { tone: 'warn', key: 'idle' });
});

test('terminals are ordered running first, newest first', () => {
  const t = (id: string, state: Terminal['state'], startedAt: string) => ({ id, state, startedAt }) as Terminal;
  const ordered = orderTerminals([t('old', 'running', '2026-01-01'), t('gone', 'exited', '2026-03-01'), t('new', 'running', '2026-02-01')]);
  assert.deepEqual(ordered.map((x) => x.id), ['new', 'old', 'gone']);
});


// ---------- the panel above the status bar ----------

const term = (id: string, cwd: string, scope: Terminal['scope'], state: Terminal['state'] = 'running'): Terminal => ({
  id, scope, cwd, shell: '/bin/zsh', state, cols: 80, rows: 24, clients: 0, startedAt: '2026-10-15T10:00:00Z', endedAt: null, endReason: null, exitCode: null,
});

test('a tab is named after its project, the folder when it is a worktree or a chat, and a repeat is numbered', () => {
  const names: Record<string, string> = { p1: 'Shop', p2: 'Docs' };
  const labels = tabLabels(
    [
      term('a', '/work/shop', { kind: 'project', projectId: 'p1', worktree: null }),
      term('b', '/work/shop', { kind: 'project', projectId: 'p1', worktree: null }),
      term('c', '/work/shop-wt/fix-cart', { kind: 'project', projectId: 'p1', worktree: '/work/shop-wt/fix-cart' }),
      term('d', '/work/docs', { kind: 'project', projectId: 'p2', worktree: null }),
      term('e', '/work/chat-9', { kind: 'chat', chatId: 'chat-9' }),
      term('f', '/work/gone', { kind: 'project', projectId: 'removed', worktree: null }),
    ],
    (id) => names[id],
  );
  assert.deepEqual([...labels.values()], ['Shop', 'Shop 2', 'Shop · fix-cart', 'Docs', 'chat-9', 'gone']);
});

test('the status bar counts only the terminals that are running', () => {
  const scope = { kind: 'chat', chatId: 'c' } as const;
  assert.equal(runningCount([term('a', '/x', scope), term('b', '/y', scope, 'exited'), term('c', '/z', scope, 'closed')]), 1);
  assert.equal(runningCount([]), 0);
});

test('opening again repeats where the terminal was: the chat, or the project and its worktree', () => {
  assert.deepEqual(requestFor({ scope: { kind: 'chat', chatId: 'c1' } }), { chatId: 'c1' });
  assert.deepEqual(requestFor({ scope: { kind: 'project', projectId: 'p1', worktree: null } }), { projectId: 'p1' });
  assert.deepEqual(requestFor({ scope: { kind: 'project', projectId: 'p1', worktree: '/wt' } }), { projectId: 'p1', worktree: '/wt' });
});

test('Esc hides the panel only when nobody else wanted it: not in xterm, a field of the panel, a menu or a dialog', () => {
  const at = (selectors: string[]) => ({ closest: (selector: string) => (selectors.some((s) => selector.includes(s)) ? {} : null) });
  assert.equal(escapeClosesPanel({ key: 'Escape', defaultPrevented: false, target: at([]) }), true);
  assert.equal(escapeClosesPanel({ key: 'Escape', defaultPrevented: false, target: null }), true);
  assert.equal(escapeClosesPanel({ key: 'Escape', defaultPrevented: false, target: at(['.xterm']) }), false);
  assert.equal(escapeClosesPanel({ key: 'Escape', defaultPrevented: false, target: at(['[role="menu"]']) }), false);
  assert.equal(escapeClosesPanel({ key: 'Escape', defaultPrevented: true, target: at([]) }), false);
  assert.equal(escapeClosesPanel({ key: 'a', defaultPrevented: false, target: at([]) }), false);
});
