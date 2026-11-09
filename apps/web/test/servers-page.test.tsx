// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { afterEach } from 'node:test';
import type { ClaudioServer, ServerLink, ServerStatus, ServerTestResult } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { ApiRequestError, keys } from '../src/api';
import { ServerStatusWord } from '../src/components/ServerMark';
import { Unreachable } from '../src/components/Unreachable';
import i18n from '../src/i18n';
import { serversApi } from '../src/lib/api/servers';
import {
  addressesOf,
  canUpdateServer,
  certificateIsFromAuthority,
  cleanCode,
  defaultMonogram,
  defaultServerName,
  draftsOf,
  freeColor,
  groupCode,
  groupFingerprint,
  guessAddressKind,
  moveItem,
  newDraft,
  normalizeAddress,
  sameFingerprint,
  secondsLeft,
  SERVER_COLOR_NAMES,
  SERVER_TONE,
  shownAddress,
  sortServers,
} from '../src/lib/servers-model';
import { ServersView } from '../src/pages/Servers';
import { addRequestOf, AddServerForm, monogramOf, nameOf, type AddFormState } from '../src/pages/servers/AddDialog';
import { AddressesEditor, ColourPicker } from '../src/pages/servers/AddressesEditor';
import { CodeView, ConnectCard, HubsCard, HubsList } from '../src/pages/servers/Connect';
import { changesOf, EditServerForm, editStateOf } from '../src/pages/servers/EditDialog';
import { emptyPairing, FingerprintConfirm, mayPair, pairingOf, seenCertificateOf } from '../src/pages/servers/pairing';
import { TestResultView } from '../src/pages/servers/TestDialog';
import { localizedError } from '../src/pages/servers/words';

// The Servers page (docs/plans/claudio-servers.md §12.1): every state of the list, the dialogs' bodies
// drawn from data, D13's certificate comparison, and the remote that is offline. The Dialog shells
// (focus, Escape) and the round trips that need a server belong to the e2e spec.

const FINGERPRINT = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const server = (extra: Partial<ClaudioServer> & { status?: ServerStatus | null } = {}): ClaudioServer => {
  const { status = 'connected', ...rest } = extra;
  return {
    id: 'srv1',
    name: 'Studio',
    color: 'violet',
    monogram: null,
    addresses: [{ url: 'https://192.168.0.29:8791', kind: 'lan' }],
    identity: { instanceId: 'i'.repeat(16), tlsFingerprint: FINGERPRINT },
    createdAt: ago(86_400_000),
    lastUsedAt: ago(3_600_000),
    health:
      status === null
        ? null
        : { status, address: 'https://192.168.0.29:8791', version: '0.15.0', apiVersion: 1, latencyMs: 12, checkedAt: ago(1000), ...(status === 'offline' ? { reason: { code: 'servers.unreachable' } } : {}) },
    ...rest,
  };
};

function wrap(children: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>{children}</ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const view = (servers: readonly ClaudioServer[] | undefined, enabled = true) =>
  wrap(<ServersView settings={{ enabled }} servers={servers} busy={false} onTurnOn={() => {}} onOpen={() => {}} />);

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------- the model ----------

test('an address typed any way becomes an origin, and its kind is guessed from the name', () => {
  assert.equal(normalizeAddress('192.168.0.29:8791'), 'https://192.168.0.29:8791');
  assert.equal(normalizeAddress('  https://studio.tail1234.ts.net/ '), 'https://studio.tail1234.ts.net');
  assert.equal(normalizeAddress('http://localhost:8791'), 'http://localhost:8791');
  assert.equal(normalizeAddress('ftp://x'), null);
  assert.equal(normalizeAddress('not an address'), null);
  assert.equal(guessAddressKind('https://192.168.0.29:8791'), 'lan');
  assert.equal(guessAddressKind('https://studio.local'), 'lan');
  assert.equal(guessAddressKind('https://studio.tail1234.ts.net'), 'tailscale');
  assert.equal(guessAddressKind('https://100.101.102.103:8791'), 'tailscale');
  assert.equal(guessAddressKind('https://claudio.example.com'), 'tunnel');
});

test('the name, the initials and the colour are offered from what is known, and never a colour another server wears while one is free', () => {
  assert.equal(defaultServerName('https://studio.local:8791'), 'studio');
  assert.equal(defaultServerName('https://192.168.0.29:8791'), '192.168.0.29');
  assert.equal(defaultServerName('https://studio.tail1234.ts.net'), 'studio');
  assert.equal(defaultMonogram('Studio Pc'), 'SP');
  assert.equal(defaultMonogram('studio'), 'ST');
  assert.equal(defaultMonogram(''), '');
  const used = SERVER_COLOR_NAMES.slice(0, 3).map((color) => ({ color }));
  assert.equal(freeColor(used), SERVER_COLOR_NAMES[3]);
  assert.equal(freeColor(SERVER_COLOR_NAMES.map((color) => ({ color }))), SERVER_COLOR_NAMES[0]);
});

test('a fingerprint is compared by its digits, whatever the separators or case', () => {
  assert.deepEqual(groupFingerprint(FINGERPRINT), ['ABCD', 'EF01', '2345', '6789', 'ABCD', 'EF01', '2345', '6789']);
  assert.ok(sameFingerprint(FINGERPRINT, 'abcd ef01 2345 6789 abcd ef01 2345 6789'));
  assert.ok(!sameFingerprint(FINGERPRINT, 'ABCD EF01 2345 6789 ABCD EF01 2345 678A'));
  assert.ok(certificateIsFromAuthority('https://studio.tail1234.ts.net'));
  assert.ok(!certificateIsFromAuthority('https://192.168.0.29:8791'));
  assert.ok(!certificateIsFromAuthority('https://studio.local'));
});

test('a code is shown 4+4 and read back from however it was typed or pasted', () => {
  assert.equal(groupCode('ABCDEFGH'), 'ABCD EFGH');
  assert.equal(cleanCode('abcd-efgh '), 'ABCDEFGH');
  assert.equal(cleanCode('ABCDEFGHIJ'), 'ABCDEFGH');
  assert.equal(pairingOf({ ...emptyPairing, code: 'abcd efg' }), null);
  assert.deepEqual(pairingOf({ ...emptyPairing, code: 'abcd efgh' }), { kind: 'code', code: 'ABCDEFGH' });
  assert.equal(pairingOf({ way: 'token', code: '', token: '  ' }), null);
  assert.deepEqual(pairingOf({ way: 'token', code: '', token: ' tok ' }), { kind: 'token', token: 'tok' });
  const expires = new Date(Date.now() + 61_500).toISOString();
  assert.equal(secondsLeft(expires, Date.now()), 62);
  assert.equal(secondsLeft(ago(1000), Date.now()), 0);
});

test('every status has one tone, and Update is offered only when a release is out and the unit can install it', () => {
  assert.deepEqual(SERVER_TONE, { connected: 'ok', reconnecting: 'warn', offline: 'bad', 'needs-update': 'warn', 'needs-pairing': 'warn', 'identity-changed': 'bad' });
  assert.ok(canUpdateServer({ updateAvailable: true }, { state: 'idle' }));
  assert.ok(canUpdateServer({ updateAvailable: true }, { state: 'up-to-date' }));
  for (const state of ['installing', 'installed', 'failed', 'unavailable', 'needs-login'] as const) assert.ok(!canUpdateServer({ updateAvailable: true }, { state }), state);
  assert.ok(!canUpdateServer({ updateAvailable: false }, { state: 'idle' }));
  assert.ok(!canUpdateServer(undefined, undefined));
});

test('the list shows the last used first, and the addresses keep their order when one moves', () => {
  const a = server({ id: 'a', name: 'B', lastUsedAt: ago(5000) });
  const b = server({ id: 'b', name: 'A', lastUsedAt: ago(1000) });
  const c = server({ id: 'c', name: 'C', lastUsedAt: null });
  assert.deepEqual(sortServers([c, a, b]).map((s) => s.id), ['b', 'a', 'c']);
  assert.deepEqual(moveItem([1, 2, 3], 2, 0), [3, 1, 2]);
  assert.deepEqual(moveItem([1, 2, 3], 0, 5), [1, 2, 3]);
  const drafts = draftsOf([{ url: 'https://a.local', kind: 'lan' }, { url: 'https://b.example.com', kind: 'tunnel' }]);
  const parsed = addressesOf([...drafts, { key: 99, url: 'not an address', kind: null }, { key: 100, url: '  ', kind: null }]);
  assert.deepEqual(parsed.addresses.map((address) => address.url), ['https://a.local', 'https://b.example.com']);
  assert.deepEqual(parsed.invalid, [99]);
});

// ---------- the page ----------

test('off, the page is an Empty with one way to turn Servers on, and nothing else', () => {
  const html = view(undefined, false);
  assert.match(html, /data-testid="servers-turn-on"/);
  assert.ok(text(html).includes('Servers are off'));
  assert.equal((html.match(/btn-primary/g) ?? []).length, 1);
  assert.doesNotMatch(html, /servers-add|server-rows|server-link/);
});

test('with no server yet it explains both ways to pair and offers Add a server, and the page has the other Claudio sections', () => {
  const html = view([]);
  assert.ok(text(html).includes('No other server yet'));
  assert.ok(text(html).includes('owner token'));
  assert.match(html, /data-testid="servers-add-empty"/);
  assert.match(html, /data-testid="servers-add"/);
  // The gradient is the header's action only
  assert.equal((html.match(/btn-primary/g) ?? []).length, 1);
  assert.ok(text(html).includes('Let another Claudio connect to this one'));
  // Connected hubs waits for the auth mode, since nobody can connect to a Claudio that asks for no sign-in (tested below)
});

test('each server row says its status in a word, its version, latency and the address in mono', () => {
  const words: Record<ServerStatus, string> = {
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    offline: 'Offline',
    'needs-update': 'Needs an update',
    'needs-pairing': 'Pair again',
    'identity-changed': 'Identity changed',
  };
  for (const status of Object.keys(words) as ServerStatus[]) {
    const html = view([server({ status })]);
    assert.match(html, new RegExp(`data-status="${status}"`), status);
    assert.ok(text(html).includes(words[status]), status);
    assert.ok(text(html).includes('Version 0.15.0'), status);
    assert.ok(text(html).includes('12 ms'), status);
    assert.match(html, /<code class="mono server-row-url" title="https:\/\/192\.168\.0\.29:8791">192\.168\.0\.29:8791<\/code>/, status);
  }
  assert.match(view([server({ status: 'reconnecting' })]), /spinner/);
  assert.match(view([server({ status: 'offline' })]), /No address answers\./);
  assert.ok(text(view([server({ status: null })])).includes('Not checked'));
});

test('a server that must be paired again offers Pair again instead of Open, and every other one offers Open and Test connection', () => {
  for (const status of ['identity-changed', 'needs-pairing'] as const) {
    const html = view([server({ status })]);
    assert.match(html, /data-testid="server-pair-again"/, status);
    assert.doesNotMatch(html, /data-testid="server-open"/, status);
  }
  for (const status of ['connected', 'offline', 'needs-update', 'reconnecting'] as const) {
    const html = view([server({ status })]);
    assert.match(html, /data-testid="server-open"/, status);
    assert.match(html, /data-testid="server-test-open"/, status);
    assert.doesNotMatch(html, /data-testid="server-pair-again"/, status);
  }
  // Edit and Remove are in the "⋯" menu, named for the server
  assert.match(view([server()]), /aria-label="Actions for Studio"/);
});

test('the page is in Spanish too, with the glossary words', async () => {
  await i18n.changeLanguage('es');
  const html = view([server({ status: 'needs-update' })]);
  assert.ok(text(html).includes('Servidores'));
  assert.ok(text(html).includes('Necesita actualizar'));
  assert.ok(text(html).includes('Añadir un servidor'));
  assert.ok(text(view(undefined, false)).includes('Activar los servidores'));
});

// ---------- the dialogs' bodies ----------

const addState = (extra: Partial<AddFormState> = {}): AddFormState => ({
  drafts: draftsOf([{ url: 'https://studio.local:8791', kind: 'lan' }]),
  pairing: emptyPairing,
  name: null,
  colour: 'blue',
  monogram: null,
  ...extra,
});

test('Add a server offers both ways to pair and defaults the name and the initials from the first address until the person types them', () => {
  const state = addState();
  assert.equal(nameOf(state), 'studio');
  assert.equal(monogramOf(state), 'ST');
  assert.equal(nameOf(addState({ name: 'Mac mini' })), 'Mac mini');
  assert.equal(monogramOf(addState({ name: 'Mac mini' })), 'MM');
  assert.equal(monogramOf(addState({ monogram: 'ZZ' })), 'ZZ');
  const html = wrap(<AddServerForm state={state} onChange={() => {}} group="g" />);
  assert.match(html, /role="tab"[^>]*>Pairing code</);
  assert.match(html, /role="tab"[^>]*>Owner token</);
  assert.match(html, /data-testid="server-code"/);
  assert.match(html, /value="studio"/);
  assert.match(html, /role="radiogroup" aria-label="Colour"/);
  assert.equal((html.match(/role="radio"/g) ?? []).length, SERVER_COLOR_NAMES.length);
  // The token tab holds the token field, hidden as a password
  const token = wrap(<AddServerForm state={addState({ pairing: { ...emptyPairing, way: 'token' } })} onChange={() => {}} group="g" />);
  assert.match(token, /type="password"[^>]*data-testid="server-token"|data-testid="server-token"/);
  assert.doesNotMatch(token, /data-testid="server-code"/);
});

test('an address typed but not valid says so under its row', () => {
  const state = addState({ drafts: [{ key: 7, url: 'not an address', kind: null }] });
  const html = wrap(<AddServerForm state={state} onChange={() => {}} invalid={[7]} group="g" />);
  assert.match(html, /aria-invalid="true"/);
  assert.ok(text(html).includes('Not an address Claudio can reach'));
});

test('the certificate comparison shows the fingerprint in groups, and warns that a name signed by an authority will not match the card', () => {
  const lan = wrap(<FingerprintConfirm fingerprint={FINGERPRINT} address="https://192.168.0.29:8791" typed="" onTyped={() => {}} />);
  assert.match(lan, /data-testid="server-fingerprint"/);
  assert.match(lan, /<span>ABCD<\/span><span>EF01<\/span>/);
  assert.ok(text(lan).includes('Settings, Access and safety'));
  assert.doesNotMatch(lan, /server-confirm-authority|server-compare/);

  const tailnet = wrap(<FingerprintConfirm fingerprint={FINGERPRINT} address="https://studio.tail1234.ts.net" typed="" onTyped={() => {}} />);
  assert.match(tailnet, /data-testid="server-confirm-authority"/);
  assert.ok(text(tailnet).includes('is not the one on the local network card'));
});

test('a fingerprint pasted to compare says whether it matches, and one that differs stops the pairing', () => {
  const same = wrap(<FingerprintConfirm fingerprint={FINGERPRINT} address="https://x.local" typed="abcd ef01 2345 6789 abcd ef01 2345 6789" onTyped={() => {}} />);
  assert.match(same, /server-compare tone-ok/);
  assert.ok(text(same).includes('They match'));
  const other = wrap(<FingerprintConfirm fingerprint={FINGERPRINT} address="https://x.local" typed="0000" onTyped={() => {}} />);
  assert.match(other, /server-compare tone-bad/);
  assert.ok(text(other).includes('They differ'));
  assert.ok(mayPair(FINGERPRINT, ''));
  assert.ok(mayPair(FINGERPRINT, 'abcd ef01 2345 6789 abcd ef01 2345 6789'));
  assert.ok(!mayPair(FINGERPRINT, '0000'));
});

test('the 409 that asks to confirm a certificate carries it to the dialog, and no other failure does', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'Confirm the certificate', code: 'servers.confirm-fingerprint', fingerprint: FINGERPRINT, address: 'https://192.168.0.29:8791' }), { status: 409 })) as typeof fetch;
  const error: unknown = await serversApi.add({ name: 'Studio', addresses: [{ url: 'https://192.168.0.29:8791', kind: 'lan' }], pairing: { kind: 'token', token: 't' } }).catch((err: unknown) => err);
  assert.ok(error instanceof ApiRequestError);
  assert.deepEqual(seenCertificateOf(error), { fingerprint: FINGERPRINT, address: 'https://192.168.0.29:8791' });
  assert.equal(seenCertificateOf(new ApiRequestError('boom', 409, undefined, 'servers.already-paired')), null);
  assert.equal(seenCertificateOf(new Error('x')), null);
});

test('the pairing goes to the hub with the token way carrying the confirmed fingerprint, and a forced remove says so in the query', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ revoked: false }), { status: 200 });
  }) as typeof fetch;
  await serversApi.pairAgain('s/1', { kind: 'token', token: 't', expectedFingerprint: FINGERPRINT });
  await serversApi.remove('srv1', true);
  await serversApi.remove('srv1');
  assert.deepEqual(calls[0], { url: '/api/servers/s%2F1/pair', method: 'POST', body: { kind: 'token', token: 't', expectedFingerprint: FINGERPRINT } });
  assert.equal(calls[1]?.url, '/api/servers/srv1?force=true');
  assert.equal(calls[1]?.method, 'DELETE');
  assert.equal(calls[2]?.url, '/api/servers/srv1');
});

test('Edit shows the addresses in their order with up, down and remove, and sends only what changed', () => {
  const s = server({
    addresses: [
      { url: 'https://192.168.0.29:8791', kind: 'lan' },
      { url: 'https://studio.tail1234.ts.net', kind: 'tailscale' },
    ],
  });
  const state = editStateOf(s);
  assert.deepEqual(changesOf(s, state), {});
  assert.deepEqual(changesOf(s, { ...state, name: 'Renamed' }), { name: 'Renamed' });
  assert.deepEqual(changesOf(s, { ...state, colour: 'rose' }), { color: 'rose' });
  const swapped = { ...state, drafts: moveItem(state.drafts, 1, 0) };
  assert.deepEqual(changesOf(s, swapped), {
    addresses: [
      { url: 'https://studio.tail1234.ts.net', kind: 'tailscale' },
      { url: 'https://192.168.0.29:8791', kind: 'lan' },
    ],
  });
  const html = wrap(<EditServerForm state={state} onChange={() => {}} addressesChanged={false} />);
  assert.equal((html.match(/data-testid="server-address-row"/g) ?? []).length, 2);
  assert.match(html, /disabled="" aria-label="Move address 1 up"/);
  assert.match(html, /disabled="" aria-label="Move address 2 down"/);
  assert.match(html, /aria-label="Remove address 1"/);
  assert.doesNotMatch(text(html), /has to prove it is the same server/);
  assert.ok(text(wrap(<EditServerForm state={state} onChange={() => {}} addressesChanged />)).includes('has to prove it is the same server'));
});

// ---------- Test connection ----------

test('the connection test shows its four checks apart, each with a word, an icon and its latency, and the reason of a failure', () => {
  const result: ServerTestResult = {
    address: 'https://192.168.0.29:8791',
    meta: { ok: true, latencyMs: 8 },
    rest: { ok: false, code: 'servers.needs-pairing' },
    events: { ok: true, latencyMs: 31 },
    socket: { ok: false, code: 'terminal.needs-tunnel' },
  };
  const html = wrap(<TestResultView result={result} />);
  for (const name of ['meta', 'rest', 'events', 'socket']) assert.match(html, new RegExp(`data-check="${name}"`));
  assert.match(html, /data-check="meta" data-ok="true"/);
  assert.match(html, /data-check="rest" data-ok="false"/);
  assert.ok(text(html).includes('Works'));
  assert.ok(text(html).includes('Fails'));
  assert.ok(text(html).includes('8 ms'));
  assert.ok(text(html).includes('Its token is no longer accepted.'));
  assert.ok(text(html).includes('Its terminal is closed to other Claudios'));
  assert.match(html, /<code class="mono break">https:\/\/192\.168\.0\.29:8791<\/code>/);
  assert.doesNotMatch(html, /server-test-running/);
  // A code this build does not know says nothing rather than showing a key
  const unknown = wrap(<TestResultView result={{ ...result, rest: { ok: false, code: 'servers.new-thing' } }} />);
  assert.doesNotMatch(unknown, /servers\.new-thing|serversPage/);
});

test('while it runs the test shows the verb with the braille spinner and no results, and a failed run says it could not run', () => {
  const running = wrap(<TestResultView result={null} />);
  assert.match(running, /data-testid="server-test-running"/);
  assert.ok(text(running).includes('Testing…'));
  assert.doesNotMatch(running, /data-ok=/);
  const failed = wrap(<TestResultView result={null} error={new Error('down')} />);
  assert.doesNotMatch(failed, /server-test-running/);
  assert.ok(text(failed).includes('Could not run the test'));
});

// ---------- Let another Claudio connect, and the hubs ----------

test('the pairing code is mono, large, in two groups, with its countdown; once it ends it says so and stops offering Copy', () => {
  const live = wrap(<CodeView code={{ code: 'ABCDEFGH', expiresAt: new Date(Date.now() + 125_000).toISOString() }} now={Date.now()} onNew={() => {}} pending={false} />);
  assert.match(live, /<code class="mono server-code-value "[^>]*>ABCD EFGH<\/code>/);
  assert.ok(text(live).includes('Valid for 2 min 5 s'));
  assert.ok(text(live).includes('It works once'));
  assert.match(live, /data-testid="server-link-new"/);
  const gone = wrap(<CodeView code={{ code: 'ABCDEFGH', expiresAt: ago(1000) }} now={Date.now()} onNew={() => {}} pending={false} />);
  assert.ok(text(gone).includes('This code has expired.'));
  assert.match(gone, /is-expired/);
  assert.doesNotMatch(gone, /aria-label="Pairing code"/);
});

test('connected hubs list who may drive this Claudio with Revoke, never a secret, and say so when none does', () => {
  const link: ServerLink = { tokenId: 't1', hubName: 'Laptop', hubInstanceId: 'h'.repeat(16), createdAt: ago(86_400_000), lastUsedAt: null };
  const html = wrap(<HubsList links={[link, { ...link, tokenId: 't2', hubName: 'Mac', lastUsedAt: ago(60_000) }]} busy={false} onRevoke={() => {}} />);
  assert.equal((html.match(/data-testid="server-hub-revoke"/g) ?? []).length, 2);
  assert.ok(text(html).includes('Laptop'));
  assert.ok(text(html).includes('Not used yet'));
  assert.ok(text(html).includes('Last used'));
  assert.doesNotMatch(html, /token/i);
  assert.ok(text(wrap(<HubsList links={[]} busy={false} onRevoke={() => {}} />)).includes('No other Claudio is connected to this one.'));
});

// ---------- A remote that is offline ----------

test('an offline remote is the in-page Unreachable, naming the server and its address, with Retry and the way back, never the hub-wide modal', () => {
  const html = wrap(
    <Unreachable remote={{ name: 'Studio', address: 'https://192.168.0.29:8791', retrying: false, onRetry: () => {}, actions: <a href="/">Back to this server</a> }} />,
  );
  assert.match(html, /data-testid="unreachable"/);
  assert.match(html, /data-remote/);
  assert.doesNotMatch(html, /<dialog|unreachable-layer/);
  assert.ok(text(html).includes('Studio cannot be reached'));
  assert.match(html, /<span class="mono">https:\/\/192\.168\.0\.29:8791<\/span>/);
  assert.match(html, /data-testid="remote-retry"/);
  assert.ok(text(html).includes('Retry'));
  assert.ok(text(html).includes('Back to this server'));
  // The hub's own countdown is not shown for a remote
  assert.doesNotMatch(html, /unreachable-wait/);
  const trying = wrap(<Unreachable remote={{ name: 'Studio', address: null, retrying: true, onRetry: () => {}, actions: null }} />);
  assert.match(trying, /data-testid="remote-retry"[^>]*disabled|disabled=""[^>]*data-testid="remote-retry"/);
  assert.ok(text(trying).includes('any of its addresses'));
});

// ---------- what the UI review found ----------

test('a server name is a span in the token weight, and every row action names its server', () => {
  const html = view([server()]);
  assert.match(html, /<span class="server-row-name">Studio<\/span>/);
  assert.doesNotMatch(html, /<strong[^>]*server-row-name/);
  assert.match(html, /aria-label="Open Studio"/);
  assert.match(html, /aria-label="Test connection Studio"/);
  // The status word is the Collaborators page's tone, not a second component
  assert.match(html, /class="collab-tone server-status tone-ok"/);
  // The same size for the buttons side by side
  assert.doesNotMatch(html, /btn-small[^>]*data-testid="server-test-open"/);
});

test('the empty list is the compact Empty beside the other cards, and the list heading is not said twice', () => {
  const html = view([]);
  assert.match(html, /state-icon/);
  assert.doesNotMatch(html, /state-illustrated/);
  assert.doesNotMatch(html, /<h2 id="servers-list-title"/);
  // Off, alone on the page, it keeps its illustration
  assert.match(view(undefined, false), /state-illustrated/);
});

test('a colour tile has a size of its own, since an empty monogram has no letters to give it one', () => {
  const css = readFileSync(new URL('../src/styles/servers.css', import.meta.url), 'utf8');
  assert.match(css, /\.server-colour-tile\s*\{[^}]*width: 28px;[^}]*height: 28px;/);
  assert.match(css, /\.server-row-name,[^{]*\{\s*font-weight: var\(--fw-strong\);/);
});

// ---------- what the review of everything Servers shows found ----------

test('a server named by its IPv4 address gets its last number as initials, so .28 and .29 can be told apart', () => {
  assert.equal(defaultMonogram('192.168.0.28'), '28');
  assert.equal(defaultMonogram('192.168.0.130'), '30');
  assert.equal(defaultMonogram('10.0.0.5'), '5');
  assert.equal(defaultMonogram('Mac studio'), 'MS');
  assert.equal(monogramOf(addState({ drafts: draftsOf([{ url: 'https://192.168.0.29:8791', kind: 'lan' }]) })), '29');
});

test('initials nobody typed are not stored, so they follow the name when it changes; typed ones are kept', () => {
  const pairing = { kind: 'code', code: 'ABCDEFGH' } as const;
  assert.equal(addRequestOf(addState(), pairing).monogram, null);
  assert.equal(addRequestOf(addState({ monogram: 'zz ' }), pairing).monogram, 'zz');
  assert.equal(addRequestOf(addState(), pairing).name, 'studio');

  const derived = server({ monogram: null });
  const state = editStateOf(derived);
  assert.equal(state.monogram, null);
  assert.deepEqual(changesOf(derived, { ...state, name: 'Mac mini' }), { name: 'Mac mini' }, 'a rename sends no initials');
  assert.match(wrap(<EditServerForm state={{ ...state, name: 'Mac mini' }} onChange={() => {}} addressesChanged={false} />), /value="MM"/);
  const own = server({ monogram: 'JG' });
  assert.deepEqual(changesOf(own, { ...editStateOf(own), monogram: null }), { monogram: null }, 'clearing typed initials hands them back to the name');
});

test('one address has nowhere to move and cannot go, so it shows no move or remove buttons; a second brings them', () => {
  const one = wrap(<AddressesEditor drafts={[newDraft('https://192.168.0.29:8791', 'lan')]} onChange={() => {}} />);
  assert.doesNotMatch(one, /Move address|Remove address/);
  const two = wrap(<AddressesEditor drafts={[newDraft('https://192.168.0.29:8791', 'lan'), newDraft('https://studio.tail1234.ts.net', 'tailscale')]} onChange={() => {}} />);
  assert.match(two, /aria-label="Move address 1 up"/);
  assert.match(two, /aria-label="Remove address 2"/);
});

test('each colour tile wears the server’s initials, and the chosen one its check', () => {
  const html = wrap(<ColourPicker value="blue" letters="MS" onChange={() => {}} />);
  assert.equal((html.match(/>MS</g) ?? []).length, SERVER_COLOR_NAMES.length - 1);
  assert.match(html, /aria-checked="true"[^>]*><span[^>]*><svg/);
});

test('the address that showed a certificate is a literal, in mono', () => {
  const html = wrap(<FingerprintConfirm fingerprint={FINGERPRINT} address="https://192.168.0.29:8791" typed="" onTyped={() => {}} />);
  assert.match(html, /Shown by <span class="mono">https:\/\/192\.168\.0\.29:8791<\/span>/);
});

test('a refusal Servers knows is said in the page’s language; any other error keeps the server’s sentence', async () => {
  const known = new ApiRequestError('that server is on the list already, as Studio', 409, undefined, 'servers.already-paired');
  assert.equal((localizedError(known) as Error).message, 'That server is on the list already.');
  assert.ok((localizedError(new ApiRequestError('wrong', 403, undefined, 'server-links.code-invalid')) as Error).message.startsWith('The other Claudio does not take that code'));
  await i18n.changeLanguage('es');
  assert.equal((localizedError(known) as Error).message, 'Ese servidor ya está en la lista.');
  const other = new ApiRequestError('boom', 500, undefined, 'servers.something-new');
  assert.equal(localizedError(other), other);
  const plain = new Error('x');
  assert.equal(localizedError(plain), plain);
});

/** The two sections under the list, with what they read already in the cache */
function sections(mode: 'none' | 'token', links: ServerLink[] = []) {
  const client = new QueryClient();
  client.setQueryData(keys.securityAuth, { mode, tokenSet: mode === 'token', readOnly: false, firstRunPending: false, firstRunToken: false });
  client.setQueryData(keys.lan, { state: 'off', fingerprint: null });
  client.setQueryData(['servers', 'links'], links);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>
              <ConnectCard />
              <HubsCard />
            </ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('while nobody can connect, the section says why with the way to Access, and there is no code, fingerprint or hubs card', () => {
  const open = sections('none');
  assert.match(open, /data-testid="server-link-auth-required"/);
  assert.match(open, /<a[^>]*href="\/settings\/access[^"]*"[^>]*>Go to Access<\/a>/);
  assert.doesNotMatch(open, /server-link-show|server-link-no-fingerprint|lan-fingerprint/);
  assert.doesNotMatch(open, /Connected hubs/);

  const guarded = sections('token');
  assert.match(guarded, /data-testid="server-link-show"/);
  assert.doesNotMatch(guarded, /server-link-auth-required/);
  assert.ok(text(guarded).includes('Connected hubs'));
  // No hub yet is one quiet line, not a second empty state on the page
  assert.match(guarded, /<p class="small muted" data-testid="server-hubs-none">No other Claudio is connected to this one\.<\/p>/);
  assert.doesNotMatch(guarded, /state-icon/);
});

test('the pairing code keeps its large size against the rule that gives every literal its line’s size', () => {
  const css = readFileSync(new URL('../src/styles/servers.css', import.meta.url), 'utf8');
  assert.match(css, /\.server-code-row \.server-code-value\s*\{[^}]*font-size: var\(--fs-title\);/);
  // An address in a row stays whole: an ellipsis, never a break inside the port
  assert.match(css, /\.server-row-url\s*\{[^}]*white-space: nowrap;/);
});

test('a row shows its address as it is typed, without the default https://, so it fits a phone whole; plain http stays written', () => {
  assert.equal(shownAddress('https://192.168.0.29:8791'), '192.168.0.29:8791');
  assert.equal(shownAddress('https://studio.tail1234.ts.net'), 'studio.tail1234.ts.net');
  assert.equal(shownAddress('http://127.0.0.1:8917'), 'http://127.0.0.1:8917');
});

test('the test keeps one status line in every state, so the dialog does not jump as a test starts and ends, and the end is announced', () => {
  const line = (html: string) => html.match(/<p class="small server-test-line" role="status"[^>]*>/g) ?? [];
  const done: ServerTestResult = { address: 'https://192.168.0.29:8791', meta: { ok: true }, rest: { ok: true }, events: { ok: true }, socket: { ok: true } };
  assert.equal(line(wrap(<TestResultView result={null} />)).length, 1);
  assert.equal(line(wrap(<TestResultView result={done} />)).length, 1);
  assert.equal(line(wrap(<TestResultView result={{ ...done, address: null }} />)).length, 1);
  assert.equal(line(wrap(<TestResultView result={null} error={new Error('down')} />)).length, 1);
  const css = readFileSync(new URL('../src/styles/servers.css', import.meta.url), 'utf8');
  assert.match(css, /\.server-test-line\s*\{[^}]*min-height: 26px;/);
});

test('Add a server opens on the code it asks for, not on its tabs', () => {
  const html = wrap(<AddServerForm state={addState()} onChange={() => {}} group="g" />);
  assert.match(html, /data-autofocus="true" data-testid="server-code"/);
});

test('a status reads the same on the page and in the shell: one component, a word, an icon and its tone; "Not checked" only where the page lists it', () => {
  const page = wrap(<ServerStatusWord status="offline" unchecked />);
  const shell = wrap(<ServerStatusWord status="offline" />);
  assert.equal(page, shell);
  assert.match(page, /class="collab-tone server-status tone-bad" data-status="offline"><svg/);
  assert.ok(text(wrap(<ServerStatusWord status={null} unchecked />)).includes('Not checked'));
  assert.equal(wrap(<ServerStatusWord status={null} />).replace(/<div class="toasts"[^>]*><\/div>/, ''), '');
});
