import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { createServer as createTlsServer, getCACertificates, setDefaultCACertificates } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ensureLanCertificate } from '../src/lan-tls.ts';
import { SecretVault } from '../src/secret-vault.ts';
import { isLoopbackName, parseAddress, parseAddresses, refusedIp } from '../src/servers/addresses.ts';
import { ServersError } from '../src/servers/errors.ts';
import { SERVERS_FILE, SERVERS_VAULT_TOOL, ServerRegistry, type StoredServer } from '../src/servers/registry.ts';
import { apiCompatibility } from '../src/servers/service.ts';
import { accepts, caMayVouchFor, dial, peek, type Lookup, type PeerSeen, type Trust } from '../src/servers/transport.ts';

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

test("a CA's word stands in for the pin only on a DNS name off the LAN, never on an IP or a .local name (D15)", () => {
  for (const host of ['studio.tail1234.ts.net', 'STUDIO.tail1234.TS.NET.', 'claudio.example.com', 'local.example.com']) assert.equal(caMayVouchFor(host), true, host);
  for (const host of ['192.168.1.20', '100.101.102.103', '[fd7a:115c:a1e0::1]', 'fd7a:115c:a1e0::1', 'studio.local', 'Studio.Local.', 'local', 'nas', 'localhost', '']) {
    assert.equal(caMayVouchFor(host), false, host);
  }

  const pinned: Trust = { kind: 'pinned', pins: () => ({ fingerprint: 'AA:BB', publicKey: 'pinned-key' }) };
  const caSigned: PeerSeen = { fingerprint: 'CC:DD', publicKey: 'another-key', caValid: true };
  const refusal = (host: string, seen: PeerSeen = caSigned): string | null => accepts(pinned, seen, host)?.reason ?? null;
  assert.equal(refusal('studio.tail1234.ts.net'), null, 'a tailnet name may show the certificate Tailscale got for it');
  assert.equal(refusal('192.168.1.20'), 'servers.identity-changed', 'an IP must show the pinned certificate, whoever signed another');
  assert.equal(refusal('fd7a:115c:a1e0::1'), 'servers.identity-changed');
  assert.equal(refusal('studio.local'), 'servers.identity-changed', 'a .local name must show the pinned certificate');
  assert.equal(refusal('studio.tail1234.ts.net', { ...caSigned, caValid: false }), 'servers.identity-changed', 'off the LAN a certificate still needs a CA or the pin');
  // The pin holds anywhere, a renewal on the same key included
  assert.equal(refusal('192.168.1.20', { fingerprint: 'aa:bb', publicKey: 'x', caValid: false }), null);
  assert.equal(refusal('studio.local', { fingerprint: 'EE:FF', publicKey: 'pinned-key', caValid: false }), null);
});

test('a certificate the trust store vouches for is still refused on an IP and on a LAN name, over a real handshake (D15)', async (t) => {
  // The remote's certificate made a trusted root for this process only: Node then calls it CA-valid
  // for the names it carries, which is what a CA's certificate for a LAN address would look like
  const { certificate } = await ensureLanCertificate(scratch(t), { ips: ['127.0.0.1'], dns: ['localhost'] });
  const trusted = getCACertificates('default');
  setDefaultCACertificates([...trusted, certificate.cert]);
  t.after(() => setDefaultCACertificates(trusted));
  const server = createTlsServer({ key: certificate.key, cert: certificate.cert }, (socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const options = { lookup: (): Promise<Array<{ address: string; family: number }>> => Promise.resolve([{ address: '127.0.0.1', family: 4 }]), timeoutMs: 2_000 };
  const pinnedElsewhere: Trust = { kind: 'pinned', pins: () => ({ fingerprint: 'AA:BB', publicKey: 'another-key' }) };

  for (const hostname of ['127.0.0.1', 'localhost']) {
    const seen = await peek({ protocol: 'https:', hostname, port }, options);
    assert.equal(seen?.caValid, true, `${hostname}: the trust store vouches for it`);
    await assert.rejects(dial({ protocol: 'https:', hostname, port }, pinnedElsewhere, options), (error: unknown) => error instanceof ServersError && error.reason === 'servers.identity-changed', hostname);
  }
  // The pin is what lets it in
  const pinned: Trust = { kind: 'pinned', pins: () => ({ fingerprint: certificate.fingerprint, publicKey: null }) };
  const socket = await dial({ protocol: 'https:', hostname: '127.0.0.1', port }, pinned, options);
  socket.destroy();
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
