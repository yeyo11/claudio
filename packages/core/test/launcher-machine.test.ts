import assert from 'node:assert/strict';
import { createPublicKey, sign } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { KILL_AFTER_MS, NODE_FILES, run, type Boot, type Running, type RunOptions } from '../src/launcher/machine.ts';
import { EMPTY_STATE, checkOverlay, keyId, loadKeys, parseManifest, readState, writeState, type LauncherState, type PayloadBase } from '../src/launcher/protocol.ts';
import { signedManifest, signingKey, writeOverlay, writeTree, type SigningKey } from './bundle-helpers.ts';

// The launcher's machine as the desktop shell drives it (docs/plans/unified-updates.md, D1): no
// process, no network, a fixed clock. The container's host of it runs in launcher.test.ts.

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const SHELL: PayloadBase = { kind: 'shell', version: '0.6.0', shellInputs: 'shell' };
const FILES = { 'server.mjs': 'export {};\n', 'web/index.html': '<!doctype html>' };

interface Desk {
  baseDir: string;
  dataDir: string;
  keysDir: string;
  key: SigningKey;
}

function desk(): Desk {
  const root = mkdtempSync(join(tmpdir(), 'claudio-machine-'));
  roots.push(root);
  const key = signingKey();
  const keysDir = join(root, 'resources', 'keys');
  writeTree(keysDir, { 'release.pub': key.publicPem });
  mkdirSync(join(root, 'data'), { recursive: true });
  return { baseDir: join(root, 'resources', 'server'), dataDir: join(root, 'data'), keysDir, key };
}

const overlay = (d: Desk, v: string, extra: Parameters<typeof writeOverlay>[4] = {}, key = d.key) => {
  const dir = join(d.dataDir, 'app', v);
  writeOverlay(dir, v, FILES, key, extra);
  return dir;
};

const setState = (d: Desk, patch: Partial<LauncherState>) => {
  mkdirSync(join(d.dataDir, 'app'), { recursive: true });
  writeState(join(d.dataDir, 'app', 'state.json'), { ...EMPTY_STATE, bad: [], ...patch });
};
const stateOf = (d: Desk) => readState(join(d.dataDir, 'app', 'state.json'));

interface Script {
  /** What each boot does, in order: its exit code, and whether its trial proves itself */
  boots: { code: number; proves?: boolean }[];
  ignoreOverlays?: boolean;
}

/** Runs the machine with a fake server per boot; answers the boots it made and what the host saw */
async function drive(d: Desk, script: Script) {
  const booted: Boot[] = [];
  const stops: number[] = [];
  const kills: number[] = [];
  const timers: { ms: number; cancelled: boolean }[] = [];
  const logs: string[] = [];
  const options: RunOptions = {
    baseDir: d.baseDir,
    dataDir: d.dataDir,
    files: NODE_FILES,
    now: () => NOW,
    log: (line) => logs.push(line),
    ignoreOverlays: script.ignoreOverlays,
    base: () => ({ base: SHELL, keys: loadKeys(d.keysDir) }),
    start: (boot): Running => {
      const n = booted.push(boot) - 1;
      const step = script.boots[n] ?? { code: 0 };
      let end: (code: number) => void = () => undefined;
      const exited = new Promise<number>((resolve) => {
        end = resolve;
      });
      // A boot that proves itself exits on its own once the check passed; one that does not waits to be stopped
      if (!boot.trial || step.proves) setTimeout(() => end(step.code), 5);
      return {
        exited,
        stop: () => {
          stops.push(n);
          end(143);
        },
        kill: () => kills.push(n),
      };
    },
    trialCheck: async (_boot, until) => {
      assert.equal(until, NOW + 60_000, 'the trial gets its minute from the injected clock');
      return script.boots[booted.length - 1]?.proves === true;
    },
    stopping: () => false,
    after: (ms) => {
      const timer = { ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  const code = await run(options);
  return { code, booted, stops, kills, timers, logs };
}

test('a trial that proves itself (health and the page) becomes the active version', async () => {
  const d = desk();
  const dir = overlay(d, '0.7.0');
  setState(d, { trial: '0.7.0' });
  const result = await drive(d, { boots: [{ code: 0, proves: true }] });
  assert.equal(result.code, 0);
  assert.deepEqual(result.booted, [{ dir, version: '0.7.0', trial: true }]);
  const after = stateOf(d);
  assert.equal(after.active, '0.7.0');
  assert.equal(after.trial, null);
});

test('a trial whose page never renders is stopped, retried once, then rolled back to the shell at the injected time', async () => {
  const d = desk();
  overlay(d, '0.7.0');
  setState(d, { trial: '0.7.0' });
  const result = await drive(d, { boots: [{ code: 0 }, { code: 0 }, { code: 0 }] });
  assert.deepEqual(
    result.booted.map((b) => b.dir),
    [join(d.dataDir, 'app', '0.7.0'), join(d.dataDir, 'app', '0.7.0'), d.baseDir],
  );
  assert.deepEqual(result.stops, [0, 1], 'asked to stop, not killed, when it stops in time');
  assert.deepEqual(result.kills, []);
  assert.deepEqual(result.timers, [{ ms: KILL_AFTER_MS, cancelled: true }, { ms: KILL_AFTER_MS, cancelled: true }]);
  const after = stateOf(d);
  assert.deepEqual(after.bad, ['0.7.0']);
  assert.deepEqual(after.lastRollback, { from: '0.7.0', to: '0.6.0', at: '2026-10-18T12:00:00.000Z' });
});

test('exit 75 boots again onto what state.json says now', async () => {
  const d = desk();
  const result = await drive(d, { boots: [{ code: 75 }, { code: 0 }] });
  assert.equal(result.code, 0);
  assert.equal(result.booted.length, 2);
  assert.equal(result.booted[0]?.dir, d.baseDir);
  assert.equal(result.booted[0]?.version, '0.6.0', "the base's version is the shell's");
});

test('an overlay that needs a newer shell is refused before it boots; one built for another Node ABI is not', async () => {
  const d = desk();
  overlay(d, '0.7.0', { minShell: '0.7.0' });
  setState(d, { trial: '0.7.0' });
  const result = await drive(d, { boots: [{ code: 0 }] });
  assert.equal(result.booted[0]?.dir, d.baseDir);
  assert.deepEqual(stateOf(d).bad, ['0.7.0']);
  assert.match(result.logs.join('\n'), /0\.7\.0 needs the desktop app 0\.7\.0 or later/);

  const other = desk();
  overlay(other, '0.7.1', { nodeAbi: '1' });
  setState(other, { active: '0.7.1' });
  assert.equal((await drive(other, { boots: [{ code: 0 }] })).booted[0]?.version, '0.7.1');
});

test('a file changed after it was signed is refused at boot, marked bad, and the shell runs', async () => {
  const d = desk();
  const dir = overlay(d, '0.7.0');
  appendFileSync(join(dir, 'server.mjs'), '\n// changed by an agent running as the person\n');
  setState(d, { active: '0.7.0' });
  const result = await drive(d, { boots: [{ code: 0 }] });
  assert.equal(result.booted[0]?.dir, d.baseDir);
  assert.deepEqual(stateOf(d).bad, ['0.7.0']);
  assert.match(result.logs.join('\n'), /server\.mjs does not match/);
});

test('CLAUDIO_PAYLOAD=bundled boots the shell and changes nothing on disk', async () => {
  const d = desk();
  overlay(d, '0.7.0');
  overlay(d, '0.6.9');
  setState(d, { active: '0.7.0' });
  const result = await drive(d, { boots: [{ code: 0 }], ignoreOverlays: true });
  assert.equal(result.booted[0]?.dir, d.baseDir);
  assert.equal(stateOf(d).active, '0.7.0');
  assert.equal(existsSync(join(d.dataDir, 'app', '0.6.9')), true, 'not even collected');
});

test('overlays nobody points at, and staging left by a download, are collected', async () => {
  const d = desk();
  overlay(d, '0.7.0');
  overlay(d, '0.6.9');
  mkdirSync(join(d.dataDir, 'app', '.staging-0.8.0'), { recursive: true });
  setState(d, { active: '0.7.0' });
  await drive(d, { boots: [{ code: 0 }] });
  assert.equal(existsSync(join(d.dataDir, 'app', '0.7.0')), true);
  assert.equal(existsSync(join(d.dataDir, 'app', '0.6.9')), false);
  assert.equal(existsSync(join(d.dataDir, 'app', '.staging-0.8.0')), false);
});

test('a .sig may carry one line per key: a rotation verifies on either side, an unknown or forged line never does', () => {
  const d = desk();
  const next = signingKey();
  const stranger = signingKey();
  const { bytes } = signedManifest('0.7.0', FILES, d.key);
  const line = (key: SigningKey, id = keyId(createPublicKey(key.privateKey))) => `${id} ${sign(null, bytes, key.privateKey).toString('base64')}`;
  const dir = join(d.dataDir, 'app', '0.7.0');
  writeTree(dir, FILES);
  writeTree(dir, { 'manifest.json': bytes.toString() });
  const check = (signature: string, keysDir = d.keysDir) => {
    writeTree(dir, { 'manifest.json.sig': signature });
    return checkOverlay({ dir, version: '0.7.0', keys: loadKeys(keysDir), base: SHELL });
  };
  const refused = 'the manifest is not signed by an accepted key';

  assert.equal(check(`${sign(null, bytes, d.key.privateKey).toString('base64')}\n`), null, "phase 1's bare line");
  assert.equal(check(`${line(d.key)}\n`), null);
  // Signed by the old and the new key: a shell that trusts only the old one accepts it, and so does one that trusts only the new
  assert.equal(check(`${line(d.key)}\n${line(next)}\n`), null);
  const newOnly = join(d.dataDir, 'new-keys');
  writeTree(newOnly, { 'next.pub': next.publicPem });
  assert.equal(check(`${line(d.key)}\n${line(next)}\n`, newOnly), null);
  assert.equal(check(`${line(d.key)}\n`, newOnly), refused, 'the old key alone after it was dropped');

  assert.equal(check(`${line(stranger)}\n`), refused, 'a key the shell does not carry');
  assert.equal(check(`${line(d.key, keyId(createPublicKey(next.privateKey)))}\n`), refused, "a valid signature under another key's id");
  assert.equal(check(`${'0'.repeat(16)} ${sign(null, bytes, d.key.privateKey).toString('base64')}\n`), refused, 'an id no key has');
  assert.equal(check(`${line(stranger)} extra\n`), refused, 'three fields');
  assert.equal(check(`not-hex! ${sign(null, bytes, d.key.privateKey).toString('base64')}\n`), refused);
  assert.equal(check(`${Array.from({ length: 9 }, () => line(d.key)).join('\n')}\n`), refused, 'more lines than a rotation needs');
  assert.equal(check(''), refused);
});

test('a manifest without the desktop facts is not a manifest', () => {
  const k = signingKey();
  const { manifest } = signedManifest('0.7.0', FILES, k);
  const strip = (field: 'minShell' | 'shellInputs') => {
    const copy: Record<string, unknown> = { ...manifest };
    delete copy[field];
    return Buffer.from(JSON.stringify(copy));
  };
  assert.equal(parseManifest(strip('minShell')), 'the manifest has no desktop facts');
  assert.equal(parseManifest(strip('shellInputs')), 'the manifest has no desktop facts');
  assert.equal(parseManifest(Buffer.from(JSON.stringify({ ...manifest, minShell: '../x' }))), 'the manifest has no desktop facts');
  const parsed = parseManifest(Buffer.from(JSON.stringify(manifest)));
  assert.ok(typeof parsed !== 'string');
  assert.equal(parsed.minShell, '0.1.0');
});

test('in the container the image decides: minImage and the Node ABI, not minShell', () => {
  const d = desk();
  const image = (nodeAbi: string): PayloadBase => ({ kind: 'image', version: '0.6.0', imageInputs: 'x', nodeAbi });
  const dir = overlay(d, '0.7.0', { minShell: '9.0.0' });
  assert.equal(checkOverlay({ dir, version: '0.7.0', keys: loadKeys(d.keysDir), base: image(process.versions.modules) }), null);
  assert.match(checkOverlay({ dir, version: '0.7.0', keys: loadKeys(d.keysDir), base: image('1') }) ?? '', /Node ABI/);
  assert.match(checkOverlay({ dir, version: '0.7.0', keys: loadKeys(d.keysDir), base: { kind: 'shell', version: '0.7.0', shellInputs: '' } }) ?? '', /not newer than the desktop app's 0\.7\.0/);
});
