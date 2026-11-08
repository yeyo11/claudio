import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SecretVault } from '../src/secret-vault.ts';
import { isLoopbackName, parseAddress, parseAddresses, refusedIp } from '../src/servers/addresses.ts';
import { ServersError } from '../src/servers/errors.ts';
import { SERVERS_FILE, SERVERS_VAULT_TOOL, ServerRegistry, type StoredServer } from '../src/servers/registry.ts';
import { apiCompatibility } from '../src/servers/service.ts';
import { dial, type Lookup } from '../src/servers/transport.ts';

// The hub's own rules, below the API (docs/plans/claudio-servers.md, §4.2, R2): which addresses it
// dials, how it keeps the list and the tokens, and when a remote's API is one its web can drive.
// apps/api/test/servers.test.ts drives two whole Claudios against each other.

const reason = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof ServersError ? error.reason : `not a ServersError: ${String(error)}`;
  }
};

const scratch = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-servers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('an address is an https origin, http only on loopback, and never link-local, multicast or a metadata address', () => {
  assert.deepEqual(parseAddress({ url: 'https://192.168.0.29:8791/', kind: 'lan' }), { url: 'https://192.168.0.29:8791', kind: 'lan' });
  assert.deepEqual(parseAddress({ url: 'https://box.tailnet.ts.net', kind: 'tailscale' }), { url: 'https://box.tailnet.ts.net', kind: 'tailscale' });
  assert.equal(parseAddress({ url: 'https://100.64.3.4:8444', kind: 'tailscale' }).url, 'https://100.64.3.4:8444', 'the tailnet range is not refused');
  assert.equal(parseAddress({ url: 'http://localhost:8787', kind: 'other' }).url, 'http://localhost:8787');
  assert.equal(parseAddress({ url: 'http://127.0.0.1:8787', kind: 'other' }).url, 'http://127.0.0.1:8787');

  assert.equal(reason(() => parseAddress({ url: 'http://192.168.0.29:8791', kind: 'lan' })), 'servers.address-insecure');
  for (const url of [
    'https://169.254.169.254',
    'https://169.254.10.1:8791',
    'https://[fe80::1]:8791',
    'https://[::ffff:169.254.169.254]',
    'https://100.100.100.200',
    'https://[fd00:ec2::254]',
    'https://224.0.0.1',
    'https://255.255.255.255',
    'https://0.0.0.0:8791',
    'https://[::]:8791',
  ]) {
    assert.equal(reason(() => parseAddress({ url, kind: 'other' })), 'servers.address-refused', url);
  }
  for (const url of ['ftp://192.168.0.29', 'https://user:pw@192.168.0.29', 'https://192.168.0.29/api', 'https://192.168.0.29/?x=1', 'https://192.168.0.29/#a', 'not a url', '']) {
    assert.equal(reason(() => parseAddress({ url, kind: 'lan' })), 'servers.address-invalid', url);
  }
  assert.equal(reason(() => parseAddress({ url: 'https://192.168.0.29', kind: 'vpn' })), 'servers.address-invalid');
  assert.equal(reason(() => parseAddresses([])), 'servers.addresses-missing');
  assert.equal(reason(() => parseAddresses([{ url: 'https://a.example', kind: 'lan' }, { url: 'https://a.example/', kind: 'tunnel' }])), 'servers.address-invalid', 'the same origin twice');
  assert.equal(reason(() => parseAddresses(Array.from({ length: 9 }, (_, i) => ({ url: `https://h${String(i)}.example`, kind: 'other' })))), 'servers.address-invalid');
});

test('loopback is dialled only for an address recorded as loopback', () => {
  assert.equal(isLoopbackName('localhost'), true);
  assert.equal(isLoopbackName('127.0.0.1'), true);
  assert.equal(isLoopbackName('127.8.9.10'), true);
  assert.equal(isLoopbackName('[::1]'), true);
  assert.equal(isLoopbackName('box.local'), false);
  assert.equal(isLoopbackName('192.168.0.29'), false);
  assert.equal(refusedIp('127.0.0.1', true), null);
  assert.notEqual(refusedIp('127.0.0.1', false), null);
  assert.notEqual(refusedIp('::1', false), null);
  assert.notEqual(refusedIp('::ffff:127.0.0.1', false), null, 'an IPv4-mapped address is its IPv4 one');
  assert.notEqual(refusedIp('64:ff9b::a9fe:a9fe', true), null, 'metadata through NAT64');
  assert.equal(refusedIp('10.1.2.3', false), null);
  assert.equal(refusedIp('fd12:3456::1', false), null, 'a unique-local address is a LAN');
});

test('a name is dialled on an IP it resolved to only after that IP is checked: no rebinding to metadata or loopback', async (t) => {
  // A real port on loopback, so a refusal cannot be the connection failing
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const resolving =
    (table: Record<string, string[]>): Lookup =>
    (name) =>
      Promise.resolve((table[name] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  const lookup = resolving({ 'metadata.test': ['169.254.169.254'], 'sneaky.test': ['127.0.0.1'], 'mixed.test': ['169.254.1.1', '127.0.0.1'] });
  const trust = { kind: 'first-use' as const, seen: null };
  const refusedFor = async (hostname: string, protocol = 'https:'): Promise<string | null> => {
    try {
      const socket = await dial({ protocol, hostname, port }, trust, { lookup, timeoutMs: 2_000 });
      socket.destroy();
      return null;
    } catch (error) {
      return error instanceof ServersError ? error.reason : 'connection failed';
    }
  };
  assert.equal(await refusedFor('metadata.test'), 'servers.address-refused');
  assert.equal(await refusedFor('sneaky.test'), 'servers.address-refused', 'a name that resolves to loopback was not recorded as loopback');
  assert.equal(await refusedFor('mixed.test'), 'servers.address-refused');
  assert.equal(await refusedFor('nowhere.test'), 'servers.unreachable');
  assert.equal(await refusedFor('sneaky.test', 'http:'), 'servers.address-insecure', 'plain TCP only to an address recorded as loopback');
  assert.equal(await refusedFor('127.0.0.1', 'http:'), null, 'loopback recorded as such connects');
});

test('the API range decides whether the hub can drive a remote', () => {
  const meta = (current: number, min: number) => ({ instanceId: 'x', version: '1', capabilities: [], apiVersion: { current, min } });
  assert.equal(apiCompatibility(meta(1, 1)), null);
  assert.equal(apiCompatibility(meta(5, 1)), null, 'a newer remote that still answers this version');
  assert.equal(apiCompatibility(meta(0, 0)), 'servers.remote-too-old');
  assert.equal(apiCompatibility(meta(9, 5)), 'servers.hub-too-old');
});

const SERVER: StoredServer = {
  id: '0123456789ab',
  name: 'Studio',
  color: null,
  monogram: 'S',
  addresses: [{ url: 'https://192.168.0.29:8791', kind: 'lan' }],
  identity: { instanceId: 'remote-1', tlsFingerprint: 'AA:BB', publicKey: null },
  tokenId: 'tok-1',
  createdAt: '2026-11-08T10:00:00.000Z',
  lastUsedAt: null,
};

test('the list is settings-shaped JSON with no token in it; the token is in the vault', async (t) => {
  const dataDir = scratch(t);
  const vault = new SecretVault({ dataDir });
  const registry = new ServerRegistry(dataDir, vault);
  assert.deepEqual(registry.settings, { enabled: false }, 'off by default');
  await registry.put(SERVER, 'the-server-token');
  const onDisk = readFileSync(join(dataDir, SERVERS_FILE), 'utf8');
  assert.equal(onDisk.includes('the-server-token'), false);
  assert.equal((JSON.parse(onDisk) as { servers: StoredServer[] }).servers[0]?.name, 'Studio');
  assert.equal(vault.get(SERVERS_VAULT_TOOL)[SERVER.id], 'the-server-token');

  // Two changes that race both land
  await Promise.all([registry.change(SERVER.id, (each) => ({ ...each, lastUsedAt: '2026-11-08T11:00:00.000Z' })), registry.change(SERVER.id, (each) => ({ ...each, name: 'Studio 2' }))]);
  const again = new ServerRegistry(dataDir, new SecretVault({ dataDir }));
  assert.equal(again.get(SERVER.id)?.name, 'Studio 2');
  assert.equal(again.get(SERVER.id)?.lastUsedAt, '2026-11-08T11:00:00.000Z');
  assert.equal(again.tokenOf(SERVER.id), 'the-server-token');

  await again.setEnabled(true);
  assert.deepEqual(new ServerRegistry(dataDir, vault).settings, { enabled: true });
  await again.remove(SERVER.id);
  assert.equal(again.get(SERVER.id), null);
  assert.equal(new SecretVault({ dataDir }).get(SERVERS_VAULT_TOOL)[SERVER.id], undefined, 'the token goes with it');
});

test('a list that cannot be read is never written over', async (t) => {
  const dataDir = scratch(t);
  writeFileSync(join(dataDir, SERVERS_FILE), '{ "servers": [ broken');
  const registry = new ServerRegistry(dataDir, new SecretVault({ dataDir }));
  assert.deepEqual(registry.list(), []);
  await assert.rejects(registry.put(SERVER, 'x'), (error: unknown) => error instanceof ServersError && error.reason === 'servers.file-unreadable');
  assert.equal(readFileSync(join(dataDir, SERVERS_FILE), 'utf8'), '{ "servers": [ broken');
});
