// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { AuthMode, LanState, LanStatus } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { keys } from '../src/api';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import i18n from '../src/i18n';
import { patchSettings, targetsFor } from '../src/lib/events';
import { LAN_TONE, LanPanel, type LanFromEnv } from '../src/pages/config/RemoteAccessTab';
import { SETTINGS_INDEX } from '../src/pages/config/settingsIndex';

// Settings → Access & safety → Remote access, the card "On the local network" (docs/plans/lan-access.md,
// task `lan-web`): its five states each in a word beside a colour, the addresses with their Copy and QR,
// the notice about plain HTTP that is never behind a click, and a Changed · Reset slot per setting.

const ADDRESSES = [
  { ip: '192.168.0.30', host: null, url: 'http://192.168.0.30:8791' },
  { ip: '192.168.0.30', host: 'yeyo-pc.local', url: 'http://yeyo-pc.local:8791' },
];

const status = (state: LanState, extra: Partial<LanStatus> = {}): LanStatus => ({
  state,
  reason: null,
  port: 8791,
  addresses: state === 'listening' ? ADDRESSES : [],
  interfaces: [
    { name: 'wlp2s0', ip: '192.168.0.30' },
    { name: 'eth0', ip: '10.0.0.4' },
  ],
  settings: { enabled: state !== 'off', port: 8791, bind: 'all' },
  available: true,
  portTaken: null,
  ...extra,
});

function wrap(children: ReactNode, client = new QueryClient()) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
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

const card = (lan: LanStatus, authMode: AuthMode = 'token', fromEnv: LanFromEnv = {}) =>
  wrap(<LanPanel status={lan} authMode={authMode} fromEnv={fromEnv} onSettings={() => {}} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.before(async () => {
  await i18n.changeLanguage('en');
});

test('every state is a word beside its colour: ok listening, warn waiting for a sign-in method, bad what must be fixed, idle off', () => {
  assert.deepEqual(LAN_TONE, { listening: 'ok', off: 'idle', refused: 'warn', 'port-in-use': 'bad', failed: 'bad' });
  const words: Record<LanState, string> = { listening: 'Listening', off: 'Off', refused: 'Needs a sign-in method', 'port-in-use': 'Port in use', failed: 'Failed' };
  for (const state of Object.keys(LAN_TONE) as LanState[]) {
    const html = card(status(state, state === 'port-in-use' ? { portTaken: { port: 8791, holder: '0.0.0.0:8791', nextFree: 8792 } } : {}));
    assert.match(html, new RegExp(`class="badge badge-${LAN_TONE[state]}"`), state);
    assert.ok(text(html).includes(words[state]), state);
    assert.ok(text(html).includes('On the local network'), state);
  }
});

test('a listening card lists each address in mono with Copy and QR, and draws no QR until one is opened', () => {
  const html = card(status('listening'));
  assert.equal((html.match(/data-testid="lan-url"/g) ?? []).length, 2);
  assert.match(html, /<a class="lan-address-url mono break" href="http:\/\/192\.168\.0\.30:8791"/);
  assert.match(html, /<a class="lan-address-url mono break" href="http:\/\/yeyo-pc\.local:8791"/);
  assert.match(html, /aria-label="Copy http:\/\/192\.168\.0\.30:8791"/);
  assert.equal((html.match(/data-testid="lan-qr-toggle"/g) ?? []).length, 2);
  assert.match(html, /aria-pressed="false"/);
  // One QR at a time, and none before the person asks for it
  assert.doesNotMatch(html, /class="qr"|data-testid="lan-qr"/);
  assert.match(html, /role="switch"[^>]*aria-checked="true"/);
  assert.ok(text(html).includes('Devices on your network open Claudio at:'));
  // Not a gradient surface: the tunnel's address is the one that takes it
  assert.doesNotMatch(html, /grad-border/);
});

test('the notice about plain HTTP is on screen while the card listens, and never behind a click', () => {
  for (const state of ['listening', 'port-in-use', 'failed'] as const) {
    const html = card(status(state));
    assert.match(html, /data-testid="lan-http-notice"/, state);
    assert.ok(text(html).includes('Plain HTTP'), state);
    assert.ok(text(html).includes('use Tailscale below'), state);
    assert.doesNotMatch(html, /<details|collapsible/, state);
  }
  // Nothing travels while it is off or refused
  for (const state of ['off', 'refused'] as const) assert.doesNotMatch(card(status(state)), /lan-http-notice/, state);
});

test('an off card offers the switch and the settings, and no address', () => {
  const html = card(status('off'));
  assert.match(html, /role="switch"[^>]*aria-checked="false"/);
  assert.doesNotMatch(html, /lan-addresses|lan-url|class="qr"/);
  assert.match(html, /data-testid="lan-port"/);
  assert.match(html, /data-testid="lan-bind"/);
});

test('under authentication none the switch is disabled and the card sends the person to Access', () => {
  const html = card(status('refused', { reason: { code: 'lan.authRequired', text: 'x' }, settings: { enabled: true, port: 8791, bind: 'all' } }), 'none');
  assert.match(html, /data-testid="lan-auth-required"/);
  assert.match(html, /href="\/settings\/access#access"/);
  assert.match(html, /role="switch"[^>]*disabled=""/);
  // The mode can read none before the server has moved the state: the switch is disabled either way
  assert.match(card(status('off'), 'none'), /role="switch"[^>]*disabled=""/);
  assert.doesNotMatch(card(status('off'), 'token'), /role="switch"[^>]*disabled=""/);
});

test('port in use names the port and what holds it, and offers the next free one unless the environment fixes the port', () => {
  const taken = status('port-in-use', { portTaken: { port: 8791, holder: '0.0.0.0:8791', nextFree: 8792 } });
  const html = card(taken);
  assert.match(html, /data-testid="lan-port-in-use"/);
  assert.ok(text(html).includes('Another program holds port 8791'));
  assert.match(html, /data-testid="lan-port-holder"[^>]*>What holds it: <code class="mono break">0\.0\.0\.0:8791<\/code>/);
  assert.match(html, /data-testid="lan-use-next-port"[^>]*>Use the next free port \(8792\)</);
  assert.doesNotMatch(card(taken, 'token', { port: true }), /lan-use-next-port/);
  assert.doesNotMatch(card(status('port-in-use')), /lan-use-next-port/);
});

test('a failed listener shows the system error in mono, with a retry', () => {
  const html = card(status('failed', { reason: { code: 'lan.listenFailed', params: { detail: 'EACCES: permission denied' }, text: 'x' } }));
  assert.match(html, /data-testid="lan-failed"/);
  assert.match(html, /<code class="mono break">EACCES: permission denied<\/code>/);
  assert.match(html, /data-testid="lan-retry"/);
  // Another reason is said in the person's language, not in mono
  const other = card(status('failed', { reason: { code: 'lan.addressMissing', params: { address: '10.0.0.4' }, text: 'x' } }));
  assert.ok(text(other).includes('no address 10.0.0.4'));
  assert.doesNotMatch(other, /<code class="mono break">/);
});

test('where the deploy turns it off the card says so, with the variable, and offers no switch', () => {
  const html = card(status('off', { available: false }));
  assert.match(html, /data-testid="lan-disabled"/);
  assert.ok(text(html).includes('CLAUDIO_LAN=on'));
  assert.doesNotMatch(html, /role="switch"|lan-port|lan-bind/);
});

test('each setting has its own Changed · Reset slot, and what the environment sets is shown and never sent', () => {
  const html = card(status('listening'));
  for (const id of ['lan.enabled', 'lan.port', 'lan.bind']) {
    const row = html.split(`data-setting="${id}"`)[1] ?? '';
    assert.match(row, /class="pref-row-change"/, id);
  }
  const fixed = card(status('listening'), 'token', { enabled: true, port: true, bind: true });
  assert.ok(text(fixed).includes('Set by CLAUDIO_LAN_PORT'));
  assert.ok(text(fixed).includes('Set by CLAUDIO_LAN_BIND'));
  assert.match(fixed, /role="switch"[^>]*disabled=""/);
  assert.doesNotMatch(fixed, /Save port/);
});

test('interfaces are All or a chosen few, and the last one chosen cannot be cleared', () => {
  const all = card(status('listening'));
  assert.match(all, /role="radiogroup"[^>]*aria-label="Interfaces"/);
  assert.doesNotMatch(all, /lan-interfaces/);
  const one = card(status('listening', { settings: { enabled: true, port: 8791, bind: ['192.168.0.30'] } }));
  assert.match(one, /data-testid="lan-interfaces"/);
  assert.match(one, /role="checkbox" aria-checked="true"[^>]*disabled=""[^>]*aria-label="192\.168\.0\.30 \(wlp2s0\)"/);
  assert.match(one, /role="checkbox" aria-checked="false"[^>]*aria-label="10\.0\.0\.4 \(eth0\)"/);
  assert.doesNotMatch(one.match(/<button[^>]*aria-label="10\.0\.0\.4 \(eth0\)"/)?.[0] ?? '', /disabled/);
  // An address the settings keep that the machine no longer has stays, ticked, so the person sees it
  const gone = card(status('failed', { settings: { enabled: true, port: 8791, bind: ['192.168.0.30', '172.16.0.9'] } }));
  assert.match(gone, /aria-checked="true"[^>]*aria-label="172\.16\.0\.9"/);
});

test('the status is written whole from lan.changed, and the event asks for no refetch', () => {
  const client = new QueryClient();
  const lan = status('listening');
  const event = { id: 1, at: '', type: 'lan.changed', lan } as Parameters<typeof patchSettings>[1];
  patchSettings(client, event);
  assert.deepEqual(client.getQueryData(keys.lan), lan);
  assert.deepEqual(targetsFor(event as Parameters<typeof targetsFor>[0]), []);
});

test('settings search finds the three settings of the card, in the Remote access section', () => {
  for (const row of ['enabled', 'port', 'bind']) {
    const entry = SETTINGS_INDEX.find((each) => each.id === `lan.${row}`);
    assert.ok(entry, `lan.${row}`);
    assert.equal(entry.group, 'access');
    assert.equal(entry.section, 'remote');
    for (const lang of ['en', 'es']) {
      assert.ok(i18n.exists(entry.label, { lng: lang }), `${lang}: ${entry.label}`);
      assert.ok(i18n.exists(entry.keywords, { lng: lang }), `${lang}: ${entry.keywords}`);
    }
  }
});

test('every reason the listener gives is worded in both languages', () => {
  const source = readFileSync(new URL('../../../packages/core/src/lan.ts', import.meta.url), 'utf8');
  const codes = [...source.matchAll(/reason\('lan\.(\w+)'/g)].map((m) => m[1]);
  assert.ok(codes.length >= 9);
  for (const code of codes) {
    for (const lang of ['en', 'es']) assert.ok(i18n.exists(`server:lan.${code}`, { lng: lang }), `${lang}: lan.${code}`);
  }
});
