import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { API_VERSION, API_VERSION_MIN } from '@claudio/shared';
import { INSTANCE_FILE, ServerIdentity, lanTlsFingerprint, readInstanceId } from '../src/meta.ts';
import { SERVER_LINK_CODE_ALPHABET, SERVER_LINK_CODE_MAX_WRONG, SERVER_LINK_CODE_TTL_MS, ServerLinkCodes } from '../src/security/server-links.ts';

const scratch = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-server-links-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('a pairing code is 8 characters nobody misreads, and lives five minutes', () => {
  let now = 1_000_000;
  const codes = new ServerLinkCodes(() => now);
  const { code, expiresAt } = codes.issue();
  assert.equal(code.length, 8);
  for (const char of code) assert.ok(SERVER_LINK_CODE_ALPHABET.includes(char), char);
  assert.doesNotMatch(SERVER_LINK_CODE_ALPHABET, /[01OIL]/);
  assert.equal(Date.parse(expiresAt), now + SERVER_LINK_CODE_TTL_MS);

  now += SERVER_LINK_CODE_TTL_MS - 1;
  assert.equal(codes.pending, true);
  now += 1;
  assert.equal(codes.pending, false);
  assert.equal(codes.redeem(code), false, 'an expired code is a wrong one');
});

test('a pairing code is spent by its first use, and typed in any case with the dash a display adds', () => {
  const codes = new ServerLinkCodes();
  const { code } = codes.issue();
  assert.equal(codes.redeem(`${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`), true);
  assert.equal(codes.redeem(code), false);
});

test('a new code replaces the unused one: one is live at a time', () => {
  const codes = new ServerLinkCodes();
  const first = codes.issue().code;
  const second = codes.issue().code;
  assert.equal(codes.redeem(first), first === second);
  if (first !== second) assert.equal(codes.redeem(second), true);
});

test('a code is voided after enough wrong guesses, whoever sent them', () => {
  const codes = new ServerLinkCodes();
  const { code } = codes.issue();
  const wrong = code === 'ZZZZZZZZ' ? 'YYYYYYYY' : 'ZZZZZZZZ';
  for (let i = 0; i < SERVER_LINK_CODE_MAX_WRONG - 1; i += 1) assert.equal(codes.redeem(wrong), false);
  assert.equal(codes.pending, true, 'one guess short of the limit, the code still waits');
  assert.equal(codes.redeem(wrong), false);
  assert.equal(codes.pending, false);
  assert.equal(codes.redeem(code), false, 'the right code no longer works once voided');
});

test('the instance id is made once and kept, so a restart is the same server to every hub', (t) => {
  const dir = scratch(t);
  const id = readInstanceId(dir);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(readInstanceId(dir), id);
  assert.equal((JSON.parse(readFileSync(join(dir, INSTANCE_FILE), 'utf8')) as { instanceId: string }).instanceId, id);
});

test('an unreadable instance file stops the start instead of minting a new identity', (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, INSTANCE_FILE), '{ not json');
  assert.throws(() => readInstanceId(dir), /instance\.json is not readable/);
  writeFileSync(join(dir, INSTANCE_FILE), '{}');
  assert.throws(() => readInstanceId(dir), /no instanceId/);
});

test('meta says who the server is and what it speaks, and later stages declare their capabilities', (t) => {
  const identity = new ServerIdentity({ dataDir: scratch(t), version: '9.9.9', tlsFingerprint: () => null });
  assert.deepEqual(identity.meta, { instanceId: identity.instanceId, version: '9.9.9', apiVersion: { current: API_VERSION, min: API_VERSION_MIN }, capabilities: ['server-links'] });
  identity.declare('lan-tls');
  identity.declare('lan-tls');
  assert.deepEqual(identity.meta.capabilities, ['lan-tls', 'server-links']);
});

test('the LAN fingerprint is null until the listener offers one', () => {
  assert.equal(lanTlsFingerprint({}), null);
  assert.equal(lanTlsFingerprint({ tlsFingerprint: () => null }), null);
  assert.equal(lanTlsFingerprint({ tlsFingerprint: () => 'AB:CD' }), 'AB:CD');
});
