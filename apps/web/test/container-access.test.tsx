// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostRefusal, TerminalUnavailableReason } from '@claudio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { api, ApiRequestError } from '../src/api';
import { HostRefused } from '../src/components/HostRefused';
import { SignIn } from '../src/components/SignIn';
import { terminalRefusal } from '../src/components/terminal/terminal-model';
import i18n from '../src/i18n';
import { en, es } from '../src/i18n/resources';
import { claimHost, probeAuth, setChallenge, setHostRefusal, useFirstRunToken, useHostRefusal } from '../src/lib/auth';

// The container's access screens (docs/plans/container-polish.md, D3 and D5): the terminal says why
// it was refused in the person's words, the first run says where the token is, and an unlisted host
// gets a screen that can add it.

const realFetch = globalThis.fetch;
const reply = (status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch => async () => new Response(JSON.stringify(body), { status, headers });
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const refusal = (over: Partial<HostRefusal> = {}): HostRefusal => ({
  error: 'this wrapper does not answer to that host',
  code: 'host-not-allowed',
  host: '192.168.0.30',
  mode: 'token',
  canClaim: true,
  firstRunToken: false,
  ...over,
});

test.afterEach(async () => {
  globalThis.fetch = realFetch;
  setChallenge(null);
  setHostRefusal(null);
  await i18n.changeLanguage('en');
});

// ---------- the terminal's refusals ----------

test('every reason the status carries has a sentence of its own and the fix that fits it', () => {
  const reasons: TerminalUnavailableReason[] = ['off', 'disabled-by-env', 'pty-missing', 'host-failed', 'read-only', 'needs-auth', 'remote-off', 'needs-tunnel', 'from-agent', 'chat-token'];
  for (const reason of reasons) {
    const found = terminalRefusal(reason);
    assert.ok(found, reason);
    assert.equal(found.sentence, `unavailable.${reason}`);
    assert.ok(i18n.exists(`terminal:${found.sentence}`), found.sentence);
  }
  assert.deepEqual(terminalRefusal('needs-auth')?.actions, [{ kind: 'link', label: 'protect', section: 'access' }]);
  // Only a link: a change of `remote` made from the device that was refused is refused again
  assert.deepEqual(terminalRefusal('needs-tunnel')?.actions, [{ kind: 'link', label: 'tunnel', section: 'remote' }]);
  assert.deepEqual(terminalRefusal('remote-off')?.actions, []);
  assert.deepEqual(terminalRefusal('chat-token')?.actions, []);
  assert.equal(terminalRefusal('host-failed')?.tone, 'bad');
  assert.equal(terminalRefusal('needs-auth')?.tone, 'warn');
});

test('a refused request is read by its code, and its raw sentence is never the answer', () => {
  const error = new ApiRequestError('the terminal opens from another device only through the tunnel: …', 403, undefined, 'terminal.needs-tunnel');
  const found = terminalRefusal(error);
  assert.equal(found?.reason, 'needs-tunnel');
  assert.equal(found?.sentence, 'unavailable.needs-tunnel');
  // Anything else keeps the generic message: a network failure, a 500, a code of another feature
  assert.equal(terminalRefusal(new ApiRequestError('boom', 500)), null);
  assert.equal(terminalRefusal(new ApiRequestError('no', 403, undefined, 'terminal.refused')), null);
  assert.equal(terminalRefusal(new ApiRequestError('no', 403, undefined, 'accounts.nope')), null);
  assert.equal(terminalRefusal(null), null);
});

test('the refusal sentences have the same words in both languages', () => {
  const unavailable = (lang: typeof en) => (lang.terminal as { unavailable: Record<string, string> }).unavailable;
  assert.deepEqual(Object.keys(unavailable(en)).sort(), Object.keys(unavailable(es)).sort());
  const actions = (lang: typeof en) => Object.keys((lang.terminal as { refusal: Record<string, string> }).refusal).sort();
  assert.deepEqual(actions(en), actions(es));
});

// ---------- the 401 and the 421 ----------

test('a 401 that names the first-run token brings the sign-in that says where it is', async () => {
  globalThis.fetch = reply(401, { error: 'authentication required', mode: 'token', firstRunToken: true });
  await probeAuth();
  const seen: boolean[] = [];
  const Probe = () => {
    seen.push(useFirstRunToken());
    return null;
  };
  renderToStaticMarkup(<Probe />);
  assert.deepEqual(seen, [true]);

  const html = words(renderToStaticMarkup(<SignIn mode="token" />));
  assert.match(html, /Sign in with the owner token/);
  assert.match(html, /docker logs/);
  assert.match(html, /\/data\/first-run-token/);
  assert.match(html, /kubectl logs/);
  assert.match(html, /<code>|docker logs/);
});

test('without the flag the sign-in is the one it always was', () => {
  setChallenge('token');
  const html = words(renderToStaticMarkup(<SignIn mode="token" />));
  assert.match(html, /This wrapper asks for a credential/);
  assert.doesNotMatch(html, /first-run-token/);
});

test('the first-run copy is in Spanish too, with the same command named', async () => {
  setChallenge('token', true);
  await i18n.changeLanguage('es');
  const html = words(renderToStaticMarkup(<SignIn mode="token" />));
  assert.match(html, /Inicia sesión con el token de propietario/);
  assert.match(html, /docker logs/);
  assert.match(html, /kubectl logs/);
});

test('the 421 of a request sets the store the app draws Host refused from', async () => {
  globalThis.fetch = reply(421, refusal());
  await assert.rejects(api.stopTunnel(), ApiRequestError);
  const seen: Array<HostRefusal | null> = [];
  const Probe = () => {
    seen.push(useHostRefusal());
    return null;
  };
  renderToStaticMarkup(<Probe />);
  assert.equal(seen[0]?.host, '192.168.0.30');
});

test('a 421 a proxy wrote, with no code of ours, does not take the app over', async () => {
  globalThis.fetch = reply(421, { error: 'misdirected request' });
  await assert.rejects(api.stopTunnel(), ApiRequestError);
  const seen: Array<HostRefusal | null> = [];
  const Probe = () => {
    seen.push(useHostRefusal());
    return null;
  };
  renderToStaticMarkup(<Probe />);
  assert.equal(seen[0], null);
});

test('the first probe reads a 421 too, so the shell is never drawn for a host it cannot reach', async () => {
  await probeAuth(reply(421, refusal({ canClaim: false, mode: 'none' })));
  const seen: Array<HostRefusal | null> = [];
  const Probe = () => {
    seen.push(useHostRefusal());
    return null;
  };
  renderToStaticMarkup(<Probe />);
  assert.equal(seen[0]?.canClaim, false);
});

// ---------- Host refused ----------

test('Host refused names the host and asks for the owner token when it can be claimed', () => {
  const html = words(renderToStaticMarkup(<HostRefused refusal={refusal()} />));
  assert.match(html, /This Claudio does not answer to/);
  assert.match(html, /192\.168\.0\.30/);
  assert.match(html, /Owner token/);
  assert.match(html, /Add 192\.168\.0\.30 and sign in/);
  assert.doesNotMatch(html, /first-run-token/);
});

test('the host is the one literal on the screen: mono', () => {
  const html = renderToStaticMarkup(<HostRefused refusal={refusal()} />);
  assert.match(html, /<span class="mono">192\.168\.0\.30<\/span>/);
});

test('Host refused says where the first-run token is while it is unused', () => {
  const html = words(renderToStaticMarkup(<HostRefused refusal={refusal({ firstRunToken: true })} />));
  assert.match(html, /\/data\/first-run-token/);
  // The path and the command are literals the machine reads
  assert.match(renderToStaticMarkup(<HostRefused refusal={refusal({ firstRunToken: true })} />), /<code>\/data\/first-run-token<\/code>/);
});

test('without a way to claim there is no field, and the text says where to add the host', () => {
  for (const over of [{ mode: 'none' as const, canClaim: false }, { canClaim: false }]) {
    const html = renderToStaticMarkup(<HostRefused refusal={refusal(over)} />);
    assert.doesNotMatch(html, /type="password"/);
    assert.doesNotMatch(html, /<button/);
    assert.match(words(html), /CLAUDIO_ALLOWED_HOSTS/);
    assert.match(words(html), /Allowed hosts/);
  }
});

test('Host refused is in Spanish with the same fields', async () => {
  await i18n.changeLanguage('es');
  const html = words(renderToStaticMarkup(<HostRefused refusal={refusal()} />));
  assert.match(html, /Este Claudio aún no responde a/);
  assert.match(html, /Token de propietario/);
  assert.match(html, /Añadir 192\.168\.0\.30 y entrar/);
});

test('the claim keeps the token only when the wrapper accepted it', async () => {
  const { getToken } = await import('../src/lib/auth');
  const before = getToken();

  globalThis.fetch = reply(401, { error: 'authentication required' });
  assert.deepEqual(await claimHost('wrong'), { status: 'rejected' });
  assert.equal(getToken(), before);

  globalThis.fetch = reply(429, { error: 'too many' }, { 'retry-after': '90' });
  assert.deepEqual(await claimHost('wrong'), { status: 'rate-limited', waitMs: 90_000 });
  assert.equal(getToken(), before);

  globalThis.fetch = reply(403, { error: 'only the owner may add a host', code: 'host.not-owner' });
  assert.deepEqual(await claimHost('desktop'), { status: 'refused', code: 'host.not-owner' });

  globalThis.fetch = reply(200, { host: '192.168.0.30', allowedHosts: ['192.168.0.30'] });
  const claimed = await claimHost(' owner-token ');
  assert.equal(claimed.status, 'claimed');
  assert.equal(getToken(), 'owner-token');
});
