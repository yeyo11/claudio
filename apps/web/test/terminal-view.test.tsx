// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project, TerminalStatus as Status } from '@claudio/shared';
import { NewTerminal } from '../src/components/terminal/NewTerminal';
import { KeyBar } from '../src/components/terminal/KeyBar';
import { TerminalStatus } from '../src/components/terminal/TerminalStatus';
import { changedNumbers } from '../src/pages/config/security/TerminalCard';
import i18n from '../src/i18n';

test.beforeEach(async () => {
  await i18n.changeLanguage('es');
});

test('the key bar offers every key of the phone layout, with Ctrl and Alt as pressed-state buttons', () => {
  const html = renderToStaticMarkup(<KeyBar mods={{ ctrl: true, alt: false }} onMods={() => {}} onSend={() => {}} />);
  assert.match(html, /role="toolbar" aria-label="Teclas de la terminal"/);
  for (const label of ['Esc', 'Tab', '⇧Tab', '↑', '↓', '←', '→', '|', '~', '/', '-', '^C', '^D', '^L', '^R']) assert.ok(html.includes(`>${label}</button>`), label);
  assert.match(html, /<button type="button" class="term-key on" aria-pressed="true">Ctrl<\/button>/);
  assert.match(html, /<button type="button" class="term-key" aria-pressed="false">Alt<\/button>/);
  // A symbol alone is no name for a screen reader
  assert.match(html, /aria-label="Shift\+Tab"/);
  assert.match(html, /aria-label="Ctrl\+C"/);
});

test('a status is an icon and a word, in its tone', () => {
  const ok = renderToStaticMarkup(<TerminalStatus terminal={{ state: 'running', endReason: null, exitCode: null }} link="open" />);
  assert.match(ok, /class="term-status ok"/);
  assert.match(ok, /<svg[^>]*aria-hidden="true"/);
  assert.match(ok, /Conectado/);
  const failed = renderToStaticMarkup(<TerminalStatus terminal={{ state: 'exited', endReason: 'exit', exitCode: 1 }} link="ended" />);
  assert.match(failed, /class="term-status bad"/);
  assert.match(failed, /Terminó con 1/);
  const idle = renderToStaticMarkup(<TerminalStatus terminal={{ state: 'closed', endReason: 'idle', exitCode: null }} link="ended" />);
  assert.match(idle, /class="term-status warn"/);
  assert.match(idle, /Cerrado por inactividad/);
});

const status = (over: Partial<Status['settings']> = {}, env: Array<keyof Status['settings']> = []): Status => {
  const settings = { enabled: true, remote: 'off', maxTerminals: 8, idleMinutes: 30, scrollbackLines: 2000, replayLines: 1000, shell: null, loginShell: true, ...over } as Status['settings'];
  const sources = Object.fromEntries(Object.keys(settings).map((key) => [key, env.includes(key as keyof Status['settings']) ? 'env' : 'default'])) as Status['sources'];
  return { enabled: true, available: true, reason: null, settings, sources, peerCheck: 'on', running: 0 };
};

test('the settings card sends the numbers that moved, and never one the environment owns', () => {
  assert.deepEqual(changedNumbers(status(), { maxTerminals: 8, idleMinutes: 30, scrollbackLines: 2000 }), {});
  assert.deepEqual(changedNumbers(status(), { maxTerminals: 12, idleMinutes: 30 }), { maxTerminals: 12 });
  assert.deepEqual(changedNumbers(status({}, ['idleMinutes']), { idleMinutes: 60, scrollbackLines: 3000 }), { scrollbackLines: 3000 });
});

test('the new-terminal control opens in the chosen project at once, and offers a menu only when it has a worktree to choose', () => {
  const project = { id: 'p1', name: 'Shop', path: '/work/shop', exists: true, worktrees: [] } as unknown as Project;
  const plain = renderToStaticMarkup(<NewTerminal project={project} projects={[project]} icon pending={false} onOpen={() => {}} />);
  assert.match(plain, /<button type="button" class="icon-btn term-plus" aria-label="Nueva terminal">/);
  assert.equal(plain.includes('Elegir dónde abrir la terminal'), false);
  const withTrees = { ...project, worktrees: [{ path: '/work/shop-wt/fix', name: 'fix', branch: 'fix' }] } as unknown as Project;
  assert.match(renderToStaticMarkup(<NewTerminal project={withTrees} projects={[withTrees]} icon pending={false} onOpen={() => {}} />), /aria-label="Elegir dónde abrir la terminal"/);
  // With All projects the button is the menu's trigger, named for what it does
  assert.match(renderToStaticMarkup(<NewTerminal project={null} projects={[project]} icon pending={false} onOpen={() => {}} />), /aria-label="Nueva terminal"/);
});

test('with no project at all, the new-terminal control opens in the workspace at once, with no menu', () => {
  const html = renderToStaticMarkup(<NewTerminal project={null} projects={[]} icon pending={false} onOpen={() => {}} />);
  assert.match(html, /<button type="button" class="icon-btn term-plus" aria-label="Nueva terminal en el espacio de trabajo">/);
  assert.equal(html.includes('aria-haspopup'), false);
  assert.match(renderToStaticMarkup(<NewTerminal project={null} projects={[]} pending={false} onOpen={() => {}} />), /class="btn btn-primary"[^>]*>.*Nueva terminal/);
});
