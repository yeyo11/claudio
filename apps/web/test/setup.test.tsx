// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodeHostStatus, LoginSession, ProviderReadinessState, ProviderStatus, SetupState, SetupToolMethods } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { keys } from '../src/api';
import { DeviceCode, SignInPanel } from '../src/components/setup/SignInPanel';
import i18n from '../src/i18n';
import {
  advance,
  agentsReady,
  codeReady,
  failureOf,
  isPanelTool,
  keyLink,
  loginMethods,
  newerSession,
  offersChoice,
  offersSignIn,
  offersSignOut,
  retreat,
  START,
  stepMarks,
  summaryRows,
  tailscaleActions,
  timeLeft,
  variableChoices,
  variableLabel,
} from '../src/lib/setup';

// The methods table as GET /setup serves it (packages/core/src/setup/methods.ts)
const row = (tool: SetupToolMethods['tool'], methods: Partial<Omit<SetupToolMethods, 'tool'>>): SetupToolMethods => ({
  tool,
  key: 'env',
  variables: [],
  exclusive: false,
  device: false,
  accountLogin: false,
  deviceVia: null,
  needsHost: false,
  defaultHost: null,
  signOut: true,
  signOutKeyOnly: false,
  ...methods,
});
const METHODS: SetupToolMethods[] = [
  row('claude-code', { variables: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], exclusive: true }),
  row('gh', { key: 'stdin', device: true, needsHost: true, defaultHost: 'github.com' }),
  row('glab', { key: 'stdin', device: true, needsHost: true, defaultHost: 'gitlab.com' }),
  row('youtrack', { variables: ['YOUTRACK_TOKEN'], needsHost: true }),
  row('tailscale', { key: 'file', device: true }),
];
const methods = (tool: SetupToolMethods['tool']) => METHODS.find((m) => m.tool === tool) as SetupToolMethods;

const SETUP: SetupState = {
  seen: false,
  access: { mode: 'none', tokenSet: false, readOnly: false },
  providers: [],
  hosts: [],
  youtrack: { configured: false, state: null, reason: null },
  tailscale: { enabled: true, managed: true, state: 'loggedOut', host: null },
  methods: METHODS,
  secrets: { sealed: true, keyBeside: true },
};

const session = (patch: Partial<LoginSession> = {}): LoginSession => ({
  id: 's1',
  tool: 'gh',
  method: 'device',
  host: null,
  state: 'waiting-for-person',
  url: 'https://github.com/login/device',
  code: 'K7QM-4XPD',
  startedAt: '2026-10-08T10:00:00Z',
  expiresAt: '2026-10-08T10:15:00Z',
  endedAt: null,
  error: null,
  ready: null,
  ...patch,
});

const provider = (id: string, label: string, state: ProviderReadinessState, account: string | null = null): ProviderStatus => ({
  id,
  label,
  state,
  reason: null,
  version: null,
  compatibleRange: '^1.0.0',
  binaryPath: null,
  configHome: null,
  account,
  capabilities: [],
  checkedAt: '2026-10-08T10:00:00Z',
});

const host = (id: 'github' | 'gitlab', state: CodeHostStatus['state'], user: string | null): CodeHostStatus =>
  ({
    id,
    label: id === 'github' ? 'GitHub' : 'GitLab',
    cli: id === 'github' ? 'gh' : 'glab',
    state,
    reason: null,
    hosts: user ? [{ hostname: id === 'github' ? 'github.com' : 'gitlab.com', default: true, signedIn: true, user }] : [],
  }) as unknown as CodeHostStatus;

async function render(node: React.ReactNode): Promise<string> {
  await i18n.changeLanguage('en');
  const client = new QueryClient();
  client.setQueryData(keys.setup, SETUP);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <MemoryRouter>{node}</MemoryRouter>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('a tool with a device code offers it first, then the key; one without offers the key alone', () => {
  assert.deepEqual(loginMethods(methods('gh')), ['device', 'key']);
  assert.deepEqual(loginMethods(methods('glab')), ['device', 'key']);
  assert.deepEqual(loginMethods(methods('claude-code')), ['key']);
  assert.equal(offersChoice(methods('gh')), true, 'Code / Key heads the panel');
  assert.equal(offersChoice(methods('claude-code')), false, 'no choice where there is one way');
});

test('only an env tool with several variables asks which one the key goes in', () => {
  assert.deepEqual(variableChoices(methods('claude-code')), ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  assert.deepEqual(variableChoices(methods('youtrack')), [], 'one variable: nothing to choose');
  assert.deepEqual(variableChoices(methods('gh')), [], 'a stdin key has no variable');
  assert.deepEqual(variableLabel('claude-code', 'ANTHROPIC_API_KEY'), { kind: 'copy', key: 'apiKey' });
  assert.deepEqual(variableLabel('youtrack', 'YOUTRACK_TOKEN'), { kind: 'name', name: 'YOUTRACK_TOKEN' });
});

test('YouTrack keeps its own access form; every other tool uses the shared panel', () => {
  assert.equal(isPanelTool('youtrack'), false);
  assert.equal(isPanelTool('gh'), true);
  assert.equal(isPanelTool('claude-code'), true);
  assert.equal(isPanelTool('nope'), false);
});

test('a host CLI\'s key is made on the host the person signs in to', () => {
  assert.equal(keyLink('gh', null), 'https://github.com/settings/tokens');
  assert.equal(keyLink('gh', 'https://ghe.acme.io/'), 'https://ghe.acme.io/settings/tokens');
  assert.equal(keyLink('glab', 'gitlab.acme.io'), 'https://gitlab.acme.io/-/user_settings/personal_access_tokens');
  assert.equal(keyLink('youtrack', null), null);
});

test('a failure says why by its code: expired is warn and asks for another code, the rest are bad', () => {
  assert.deepEqual(failureOf(session({ state: 'expired' })), { tone: 'warn', code: 'expired', action: 'new-code' });
  assert.deepEqual(failureOf(session({ state: 'failed', error: 'no-code' })), { tone: 'bad', code: 'no-code', action: 'use-key' });
  assert.deepEqual(failureOf(session({ state: 'failed', error: 'cli-missing' })), { tone: 'bad', code: 'cli-missing', action: 'install' });
  for (const code of ['cli-refused', 'not-signed-in', 'spawn-failed', 'timeout'] as const) {
    assert.deepEqual(failureOf(session({ state: 'failed', error: code })), { tone: 'bad', code, action: 'retry' }, code);
  }
  assert.equal(failureOf(session({ state: 'cancelled' })), null, 'cancelled says nothing: the panel closes');
  assert.equal(failureOf(session({ state: 'succeeded' })), null);
  assert.equal(failureOf(session()), null);
});

test('an ended session is never replaced by a copy that has not ended', () => {
  const ended = session({ state: 'succeeded', endedAt: '2026-10-08T10:01:00Z' });
  assert.equal(newerSession(ended, session()), ended, 'a late read of the waiting session');
  assert.equal(newerSession(session(), ended), ended);
  const other = session({ id: 's2' });
  assert.equal(newerSession(ended, other), other, 'another session replaces it');
});

test('the time left counts down in m:ss and stops at zero', () => {
  const at = Date.parse('2026-10-08T10:00:48Z');
  assert.equal(timeLeft('2026-10-08T10:15:00Z', at), '14:12');
  assert.equal(timeLeft('2026-10-08T10:15:00Z', Date.parse('2026-10-08T10:20:00Z')), '0:00');
});

test('a row offers Sign in when signed out, and Sign out only where the vendor documents one', () => {
  assert.equal(offersSignIn('signed-out'), true);
  assert.equal(offersSignIn('not-installed'), false);
  assert.equal(offersSignOut(methods('gh'), 'ready'), true);
  assert.equal(offersSignOut({ ...methods('gh'), signOutKeyOnly: true }, 'ready', null, false), false, 'a tool that works on its own login has no key here to forget');
  assert.equal(offersSignOut({ ...methods('gh'), signOutKeyOnly: true }, 'ready', null, true), true, 'with a key kept, Sign out forgets it');
  assert.equal(offersSignOut(methods('gh'), 'unknown', 'no-probe', true), true, 'a key kept is all there is');
  assert.equal(offersSignIn('unknown', 'no-probe', false), true, 'a tool with nothing to ask and no key kept offers Sign in');
  assert.equal(offersSignIn('unknown', 'no-probe', true), false);
  assert.equal(offersSignIn('unknown', 'probe-timeout'), false);
  assert.equal(offersSignOut(methods('gh'), 'signed-out'), false);
  assert.equal(offersSignOut(null, 'ready'), false);
});

test('the steps go on with Continue or Skip, back with Back, and remember what was skipped', () => {
  let state = advance(START);
  assert.equal(state.step, 'agents');
  state = advance(state, true);
  assert.deepEqual(state, { step: 'code', skipped: ['agents'] });
  state = advance(state);
  assert.equal(state.step, 'done');
  assert.equal(advance(state).step, 'done', 'the last step stays');
  assert.deepEqual(
    stepMarks(state).map((m) => m.mark),
    ['done', 'skipped', 'done', 'current'],
  );
  state = retreat(retreat(state));
  assert.equal(state.step, 'agents');
  assert.deepEqual(state.skipped, ['agents'], 'Back keeps the mark');
  assert.deepEqual(advance(state).skipped, [], 'continuing through a skipped step clears it');
  assert.equal(retreat(START).step, 'access');
});

test('the ready counts leave out what is not installed', () => {
  assert.deepEqual(agentsReady([{ state: 'ready' }, { state: 'degraded' }, { state: 'signed-out' }, { state: 'not-installed' }, { state: 'used-before' }]), { ready: 2, total: 3 });
  assert.deepEqual(codeReady([{ state: 'ready' }, { state: 'signed-out' }], true), { ready: 2, total: 3 });
});

test('the summary marks what was skipped plainly, what is not signed in as signed out, and leaves out what is missing', () => {
  const rows = summaryRows({
    access: { mode: 'token', tokenSet: true, readOnly: false },
    providers: [provider('claude-code', 'Claude Code', 'signed-out'), provider('claude-code', 'Claude Code', 'not-installed')],
    hosts: [host('github', 'ready', 'yeyo'), host('gitlab', 'signed-out', null)],
    youtrack: { state: 'signed-out', host: null, user: null },
    skipped: ['code'],
  });
  assert.deepEqual(
    rows.map((r) => [r.id, r.badge, r.where]),
    [
      ['access', 'ready', 'security'],
      ['claude-code', 'signed-out', 'providers'],
      ['github', 'ready', 'integrations'],
      ['gitlab', 'skipped', 'integrations'],
      ['youtrack', 'skipped', 'integrations'],
    ],
  );
  assert.equal(rows.find((r) => r.id === 'github')?.host, 'github.com');
  const open = summaryRows({ access: { mode: 'none', tokenSet: false, readOnly: false }, providers: [], hosts: [], youtrack: null, skipped: [] });
  assert.equal(open[0]?.badge, 'open', 'no guard is plain, not a failure');
});

test('Claude Code\'s panel names claude setup-token inside the sentence, with no copy button, and a write-only field', async () => {
  const html = await render(<SignInPanel tool="claude-code" label="Claude Code" onClose={() => undefined} />);
  assert.match(html, /<code>claude setup-token<\/code>/);
  assert.match(html, /<strong>your own computer<\/strong>/);
  assert.doesNotMatch(html, /Copy/, 'it reads as an explanation, not a command to paste');
  assert.match(html, /type="password"/);
  assert.match(words(html), /OAuth token/);
  assert.match(words(html), /API key/, 'the token or the API key');
  assert.match(html, /prov-bin signin-panel/);
});

test('GitHub\'s panel heads with Code / Key and asks for the host first', async () => {
  const html = await render(<SignInPanel tool="gh" label="GitHub" onClose={() => undefined} />);
  assert.match(words(html), /Code Key/);
  assert.doesNotMatch(html, /type="password"/, 'no key field until Key is chosen');
});

test('a code that waits is the one live surface: the link, the code with Copy, the spinner and the time left', async () => {
  const html = await render(<DeviceCode session={session({ expiresAt: new Date(Date.now() + 14 * 60_000 + 30_000).toISOString() })} label="GitHub" />);
  assert.match(html, /signin-device live-energy/);
  assert.match(html, /href="https:\/\/github\.com\/login\/device"/);
  assert.match(html, /K7QM-4XPD/);
  assert.match(words(html), /Copy/);
  assert.match(words(html), /Waiting for you to approve/);
  assert.match(words(html), /expires in 14:/);
});

// ---------- Tailscale ----------

test('Tailscale is signed in and out only where Claudio runs it, and Sign in also reconnects a stopped node', () => {
  assert.deepEqual(tailscaleActions({ enabled: true, managed: true, state: 'loggedOut' }), { signIn: true, signOut: false });
  assert.deepEqual(tailscaleActions({ enabled: true, managed: true, state: 'stopped' }), { signIn: true, signOut: false });
  assert.deepEqual(tailscaleActions({ enabled: true, managed: true, state: 'ready' }), { signIn: false, signOut: true });
  assert.deepEqual(tailscaleActions({ enabled: true, managed: true, state: 'daemonDown' }), { signIn: false, signOut: false });
  // A machine's own Tailscale is the person's
  assert.deepEqual(tailscaleActions({ enabled: true, managed: false, state: 'loggedOut' }), { signIn: false, signOut: false });
  assert.deepEqual(tailscaleActions({ enabled: false, managed: true, state: 'loggedOut' }), { signIn: false, signOut: false });
  assert.match(keyLink('tailscale', null) ?? '', /^https:\/\/login\.tailscale\.com\/admin\/settings\/keys$/);
});

test('the summary lists Tailscale where the tunnel is offered and there is a Tailscale, under the Access step', () => {
  const base = { access: { mode: 'token' as const, tokenSet: true, readOnly: false }, providers: [], hosts: [], youtrack: null };
  const signed = summaryRows({ ...base, tailscale: { enabled: true, managed: true, state: 'ready', host: 'claudio.tail0000.ts.net' }, skipped: [] });
  assert.deepEqual(signed.find((r) => r.id === 'tailscale'), { id: 'tailscale', kind: 'tailscale', label: 'Tailscale', detail: 'claudio.tail0000.ts.net', badge: 'ready', where: 'remote' });
  const skipped = summaryRows({ ...base, tailscale: { enabled: true, managed: true, state: 'loggedOut', host: null }, skipped: ['access'] });
  assert.equal(skipped.find((r) => r.id === 'tailscale')?.badge, 'skipped');
  assert.equal(summaryRows({ ...base, tailscale: { enabled: false, managed: true, state: 'loggedOut', host: null }, skipped: [] }).length, 1, 'no tunnel, no row');
  assert.equal(summaryRows({ ...base, tailscale: { enabled: true, managed: false, state: 'missing', host: null }, skipped: [] }).length, 1, 'no Tailscale on the machine, no row');
});

test('Tailscale\'s panel offers Link / Key and asks for a sign-in link at once', async () => {
  const html = await render(<SignInPanel tool="tailscale" label="Tailscale" onClose={() => undefined} />);
  assert.match(words(html), /Link Key/);
  assert.match(words(html), /Asking Tailscale for a sign-in link/);
  assert.doesNotMatch(words(html), /\bCode\b/);
});

test('a Tailscale login URL that waits shows the link with Copy and no code, as the one live surface', async () => {
  const url = 'https://login.tailscale.com/a/12c7b6a0132b3';
  const html = await render(<DeviceCode session={session({ tool: 'tailscale', url, code: null, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() })} label="Tailscale" />);
  assert.match(html, /signin-device live-energy/);
  assert.match(html, new RegExp(`href="${url.replace(/[./]/g, '\\$&')}"`));
  assert.doesNotMatch(html, /data-testid="signin-code"/, 'there is no code to type');
  assert.match(html, /aria-label="Copy the link"/);
  assert.match(words(html), /Waiting for you to approve/);
});
