import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { AuthStore } from '../src/security/auth.ts';
import { TerminalSettingsStore, terminalDefaults } from '../src/terminals/settings.ts';
import { tempConfig } from './helpers.ts';

/** A docker install: the distribution is what makes the store generate, the variables what stops it */
function dockerConfig(env: Record<string, string> = {}) {
  const config = { ...tempConfig(), distribution: 'docker' };
  const printed: string[] = [];
  const open = (): AuthStore => new AuthStore(config, env, undefined, undefined, (text) => printed.push(text));
  return { config, printed, open, file: join(config.dataDir, 'first-run-token'), authFile: join(config.dataDir, 'auth.json') };
}

/** The token as the block prints it: alone on an indented line */
const tokenIn = (printed: string[]): string => {
  const line = printed.join('').split('\n').find((each) => /^\|\s{3}\S{43}\s*\|$/.test(each));
  assert.ok(line, printed.join(''));
  return line.replace(/[|\s]/g, '');
};

test('a fresh container makes an owner token, prints it once and keeps it until it is used', async () => {
  const { open, printed, file } = dockerConfig();
  const auth = open();

  assert.equal(auth.mode, 'token');
  assert.equal(auth.firstRunPending, true);
  assert.equal(auth.config.firstRunPending, true);
  assert.ok(auth.firstRunGenerated);
  const token = tokenIn(printed);
  assert.match(printed.join(''), /owner token/);
  assert.equal(readFileSync(file, 'utf8').trim(), token);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  assert.equal(await auth.actorFor('wrong'), null);
  assert.equal(auth.firstRunPending, true, 'a wrong token settles nothing');
  const used: string[] = [];
  auth.onFirstRunUsed = (at) => used.push(at);
  assert.equal(await auth.actorFor(token), 'token:first-run');
  assert.equal(auth.firstRunPending, false);
  assert.equal(auth.config.firstRunToken, true, 'the setup assistant still says where the token came from');
  assert.equal(existsSync(file), false, 'the file goes at first use');
  assert.equal(used.length, 1);
  assert.equal(await auth.actorFor(token), 'token:first-run');
  assert.equal(used.length, 1, 'only the first use is announced');
});

test('the token survives a restart until used, and the second start prints no new one', () => {
  const { open, printed, file } = dockerConfig();
  open();
  const token = tokenIn(printed);
  printed.length = 0;
  const again = open();
  assert.equal(again.firstRunGenerated, null);
  assert.equal(again.firstRunPending, true);
  assert.doesNotMatch(printed.join(''), new RegExp(token));
  assert.match(printed.join(''), /first-run-token/);
  assert.equal(readFileSync(file, 'utf8').trim(), token);
});

test('nothing is generated outside a container, or when any authentication variable is set', () => {
  assert.equal(new AuthStore(tempConfig(), {}, undefined, undefined, () => undefined).mode, 'none');
  const variants: Array<Record<string, string>> = [{ CLAUDIO_AUTH_MODE: 'none' }, { CLAUDIO_AUTH_TOKEN: 'x'.repeat(32) }, { CLAUDIO_OIDC_ISSUER: 'https://issuer.test', CLAUDIO_OIDC_AUDIENCE: 'claudio' }];
  for (const env of variants) {
    const { open, file } = dockerConfig(env);
    const auth = open();
    assert.equal(auth.firstRunGenerated, null, JSON.stringify(env));
    assert.equal(auth.firstRunPending, false);
    assert.equal(existsSync(file), false);
  }
});

test('CLAUDIO_AUTH_MODE=none is respected and the start says what it costs', () => {
  const { open, printed } = dockerConfig({ CLAUDIO_AUTH_MODE: 'none' });
  assert.equal(open().mode, 'none');
  assert.match(printed.join(''), /terminal and in-app updates/);
});

test('an install from before migrates once, and never over a choice of none', async () => {
  const old = dockerConfig();
  writeFileSync(old.authFile, `${JSON.stringify({ mode: 'none', readOnly: false })}\n`);
  const migrated = old.open();
  assert.equal(migrated.mode, 'token');
  assert.equal(migrated.firstRunPending, true);
  const token = tokenIn(old.printed);

  // Used, then the person chooses none: the next start leaves it alone
  assert.equal(await migrated.actorFor(token), 'token:first-run');
  await migrated.update({ mode: 'none' });
  old.printed.length = 0;
  const after = old.open();
  assert.equal(after.mode, 'none');
  assert.equal(after.firstRunGenerated, null);
  assert.deepEqual(old.printed, []);

  // An old document that says none with the choice recorded is not touched either
  const chosen = dockerConfig();
  writeFileSync(chosen.authFile, `${JSON.stringify({ mode: 'none', readOnly: false, noneChosenAt: '2026-10-01T00:00:00.000Z' })}\n`);
  assert.equal(chosen.open().mode, 'none');
});

test('rotating the token ends the first run and deletes the file', async () => {
  const rotated = dockerConfig();
  const auth = rotated.open();
  assert.equal(existsSync(rotated.file), true);
  assert.equal(auth.config.firstRunToken, true);
  await auth.setToken({});
  assert.equal(auth.firstRunPending, false);
  assert.equal(auth.config.firstRunToken, false, 'a rotated token is the owner\'s own');
  assert.equal(existsSync(rotated.file), false);
  assert.equal(rotated.open().firstRunGenerated, null, 'a rotation is not a reason to generate again');
});

test('the terminal opens to other devices by default in a container, and a saved value wins', async () => {
  assert.equal(terminalDefaults('docker').remote, 'any');
  assert.equal(terminalDefaults(undefined).remote, 'tunnel');
  const config = { ...tempConfig(), distribution: 'docker' };
  const store = new TerminalSettingsStore(config, {});
  assert.equal(store.get().remote, 'any');
  assert.equal(store.sources().remote, 'default');
  await store.update({ remote: 'tunnel' });
  assert.equal(new TerminalSettingsStore(config, {}).get().remote, 'tunnel');
  assert.equal(new TerminalSettingsStore(tempConfig(), {}).get().remote, 'tunnel');
});
