import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

// The desktop release's minShell notice (desktop.yml, "Notice when minShell rises") and the Dependabot
// grouping that keeps Electron bumps apart (D7, docs/plans/remote-updates.md). Both are read from the
// files, not restated here, so the test fails when the workflow or the config drifts.
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, '../../..', path), 'utf8');
const desktop = read('.github/workflows/desktop.yml');
const dependabot = read('.github/dependabot.yml');

/** The `run:` script of a step, dedented: its lines are indented deeper than the step's `- name:` */
function stepScript(name: string): string {
  const lines = desktop.split('\n');
  const at = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.ok(at >= 0, `step "${name}" exists`);
  const run = lines.findIndex((line, i) => i > at && line === '        run: |');
  assert.ok(run > at, `step "${name}" has a run script`);
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the step's script the way the runner does (bash -e) in a directory holding the new desktop
 * manifest, with `previous` as the previous release's server manifest (or none).
 */
function runNotice(newMinShell: string, previous: string | null | 'missing'): { out: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'release-notice-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'apps/desktop/release'), { recursive: true });
  writeFileSync(join(dir, 'apps/desktop/release/claudio-desktop-0.0.0-linux-x64.json'), JSON.stringify({ minShell: newMinShell }));
  let url = '';
  if (previous === 'missing') url = pathToFileURL(join(dir, 'absent.json')).href;
  else if (previous !== null) {
    writeFileSync(join(dir, 'previous.json'), JSON.stringify({ minShell: previous }));
    url = pathToFileURL(join(dir, 'previous.json')).href;
  }
  const res = spawnSync('bash', ['-e', '-c', stepScript('Notice when minShell rises')], {
    cwd: dir,
    env: { ...process.env, PREVIOUS: url },
    encoding: 'utf8',
  });
  return { out: `${res.stdout}${res.stderr}`, status: res.status };
}

test('the notice fires when the release raises minShell over the previous release', () => {
  assert.match(runNotice('0.14.2', '0.13.0').out, /::notice title=minShell raised::This release raises minShell from 0\.13\.0 to 0\.14\.2/);
  // Compared as versions, not strings: 0.10.0 is above 0.9.0
  assert.match(runNotice('0.10.0', '0.9.0').out, /from 0\.9\.0 to 0\.10\.0/);
});

test('no notice when minShell stays or drops, even where a string comparison would disagree', () => {
  assert.doesNotMatch(runNotice('0.14.2', '0.14.2').out, /::notice/);
  assert.doesNotMatch(runNotice('0.9.0', '0.14.0').out, /::notice/);
});

test('a release with no previous manifest, or an unreadable one, never fails the job', () => {
  const first = runNotice('0.14.2', null);
  assert.equal(first.status, 0);
  assert.match(first.out, /nothing to compare/);
  const unreadable = runNotice('0.14.2', 'missing');
  assert.equal(unreadable.status, 0);
  assert.match(unreadable.out, /::warning::Could not read minShell/);
});

test('Electron and node-pty are grouped apart and kept out of the broad groups', () => {
  const groupAt = dependabot.indexOf('      electron-and-native:');
  assert.ok(groupAt > 0, 'the electron-and-native group exists');
  assert.ok(groupAt < dependabot.indexOf('      dev-dependencies:'), 'it is listed first, before the broad groups');
  for (const pattern of ['electron', 'electron-*', '"@electron/*"', 'node-pty']) {
    assert.ok(dependabot.includes(`          - ${pattern}`), `${pattern} is grouped`);
  }
  // Each broad group excludes the same packages, so one PR never mixes them with routine updates
  assert.equal(dependabot.split('        exclude-patterns:').length - 1, 2);
});

test('Electron majors are never proposed automatically', () => {
  assert.match(
    dependabot,
    /ignore:\n\s+# [^\n]*\n\s+- dependency-name: electron\n\s+update-types: \["version-update:semver-major"\]/,
  );
});
