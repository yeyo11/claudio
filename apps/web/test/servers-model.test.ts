import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClaudioServer, ServerStatus } from '@claudio/shared';
import { nameHue } from '@claudio/ui/components/icons';
import { RECENT_SERVERS, recentServers, SERVER_COLORS, SERVER_STATUS, serverHue, serverLetters, serverStatus } from '../src/lib/servers-model';

// What the shell draws of a server (docs/plans/claudio-servers.md §12.1): who is listed in the
// selector, its mark and its status in words.

const server = (id: string, extra: Partial<ClaudioServer> = {}): ClaudioServer => ({
  id,
  name: `Server ${id}`,
  color: null,
  monogram: null,
  addresses: [],
  identity: { instanceId: `inst-${id}`, tlsFingerprint: null },
  createdAt: '2026-11-01T10:00:00Z',
  lastUsedAt: null,
  health: null,
  ...extra,
});

test('the selector lists the three servers used last, newest first', () => {
  const list = [
    server('a', { lastUsedAt: '2026-11-02T10:00:00Z' }),
    server('b', { lastUsedAt: '2026-11-05T10:00:00Z' }),
    server('c', { lastUsedAt: '2026-11-04T10:00:00Z' }),
    server('d', { lastUsedAt: '2026-11-03T10:00:00Z' }),
    server('e', { lastUsedAt: '2026-11-01T10:00:00Z' }),
  ];
  assert.equal(RECENT_SERVERS, 3);
  assert.deepEqual(recentServers(list).map((s) => s.id), ['b', 'c', 'd']);
  assert.deepEqual(list.map((s) => s.id), ['a', 'b', 'c', 'd', 'e'], 'the list it was given is not reordered');
});

test('a server never used comes after the used ones, newest added first, so a new one is in the menu', () => {
  const list = [
    server('old', { createdAt: '2026-10-01T10:00:00Z' }),
    server('fresh', { createdAt: '2026-11-08T10:00:00Z' }),
    server('used', { lastUsedAt: '2026-11-02T10:00:00Z' }),
  ];
  assert.deepEqual(recentServers(list).map((s) => s.id), ['used', 'fresh', 'old']);
  assert.deepEqual(recentServers([]), []);
});

test('a mark takes its colour token’s hue, else one worked out from the name, and its own letters else the initials', () => {
  assert.equal(serverHue({ name: 'Studio', color: 'violet' }), SERVER_COLORS.violet);
  assert.equal(serverHue({ name: 'Studio', color: null }), nameHue('Studio'));
  assert.equal(serverHue({ name: 'Studio', color: 'chartreuse' }), nameHue('chartreuse'), 'a token this build does not know still gets a stable hue');
  assert.ok(Object.values(SERVER_COLORS).every((hue) => hue < 130 || hue > 160), 'no colour a server wears is the ok green, which would read as a state');
  assert.equal(serverLetters({ name: 'Mac studio', monogram: null }), 'MS');
  assert.equal(serverLetters({ name: 'Mac studio', monogram: 'jg' }), 'JG');
  assert.equal(serverLetters({ name: 'Mac studio', monogram: '  ' }), 'MS', 'a blank monogram is no monogram');
  assert.equal(serverLetters({ name: 'Mac studio', monogram: 'abc' }), 'AB', 'two letters at most');
});

test('every status has a word and a colour that means one thing; a server not read yet says nothing', () => {
  const tones: Record<ServerStatus, string> = {
    connected: 'ok',
    reconnecting: 'warn',
    offline: 'bad',
    'needs-update': 'warn',
    'needs-pairing': 'warn',
    'identity-changed': 'bad',
  };
  for (const [status, tone] of Object.entries(tones)) assert.equal(SERVER_STATUS[status as ServerStatus].tone, tone, status);
  const health = (status: ServerStatus) => ({ status, address: null, version: null, apiVersion: null, latencyMs: null, checkedAt: '2026-11-09T10:00:00Z' });
  assert.deepEqual(serverStatus(server('a', { health: health('offline') })), { key: 'offline', tone: 'bad' });
  assert.equal(serverStatus(server('a')), null);
});
