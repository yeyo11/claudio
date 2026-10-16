import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { agentsFileFor } from '../src/agents-file.ts';
import { DEFAULT_ROLE_BODIES, deliverRole, readRole, REVIEW_ROLES, ROLE_MAX_BYTES, roleFileName } from '../src/review-roles.ts';

function project(files: Record<string, string> = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'claudio-roles-'));
  for (const [name, content] of Object.entries(files)) {
    const file = join(home, '.claude', 'agents', name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return home;
}

test('every role has a built-in body in English', () => {
  assert.deepEqual([...REVIEW_ROLES], ['correctness', 'tests', 'security', 'conventions', 'verifier']);
  for (const role of REVIEW_ROLES) {
    const body = DEFAULT_ROLE_BODIES[role];
    assert.ok(body.length > 200, role);
    assert.doesNotMatch(body, /[áéíóúñ¿¡]/i, role);
  }
});

test('the built-in body runs when the project has no file', async () => {
  const role = await readRole(project(), 'tests');
  assert.equal(role.source, 'builtin');
  assert.equal(role.body, DEFAULT_ROLE_BODIES.tests);
  assert.equal(role.problem, null);
  assert.equal(role.sha, createHash('sha256').update(DEFAULT_ROLE_BODIES.tests).digest('hex'));
});

test('the project file runs, with its sha recorded', async () => {
  const home = project({ [roleFileName('security')]: 'Look at our webhooks first.\n' });
  const role = await readRole(home, 'security');
  assert.equal(role.source, 'project');
  assert.equal(role.body, 'Look at our webhooks first.');
  assert.equal(role.sha, createHash('sha256').update('Look at our webhooks first.').digest('hex'));
});

test('front matter is stripped and its tools and model are ignored', async () => {
  const home = project({
    [roleFileName('correctness')]: '---\nname: x\ntools: Bash, Write\nmodel: opus\n---\nOnly look at the parser.\n',
  });
  const role = await readRole(home, 'correctness');
  assert.equal(role.body, 'Only look at the parser.');
  const launch = await deliverRole('agents', { dataDir: mkdtempSync(join(tmpdir(), 'claudio-data-')), role: 'correctness', body: role.body, model: 'sonnet' });
  const definition = JSON.parse(readFileSync(launch.agentsFile ?? '', 'utf8')) as Record<string, { tools: string[]; model: string }>;
  assert.deepEqual(definition['claudio-review-correctness']?.tools, ['Read', 'Grep', 'Glob']);
  assert.equal(definition['claudio-review-correctness']?.model, 'sonnet');
});

test('an empty file or one over 16 KB falls back to the built-in body with a problem', async () => {
  const home = project({
    [roleFileName('tests')]: '---\nname: x\n---\n\n',
    [roleFileName('conventions')]: 'x'.repeat(ROLE_MAX_BYTES + 1),
    [roleFileName('security')]: 'x'.repeat(ROLE_MAX_BYTES),
  });
  const empty = await readRole(home, 'tests');
  assert.equal(empty.source, 'builtin');
  assert.match(empty.problem ?? '', /claudio-review-tests\.md has no text/);
  const big = await readRole(home, 'conventions');
  assert.equal(big.source, 'builtin');
  assert.match(big.problem ?? '', /claudio-review-conventions\.md is over 16 KB; the built-in role ran/);
  assert.equal((await readRole(home, 'security')).source, 'project');
});

test('an unreadable file (a directory) falls back with a problem', async () => {
  const home = project();
  mkdirSync(join(home, '.claude', 'agents', roleFileName('verifier')), { recursive: true });
  const role = await readRole(home, 'verifier');
  assert.equal(role.source, 'builtin');
  assert.match(role.problem ?? '', /could not be read/);
});

test('deliverRole: system-prompt mode passes the body and writes no file', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'claudio-data-'));
  assert.deepEqual(await deliverRole('system-prompt', { dataDir, role: 'tests', body: 'b', model: 'sonnet' }), { appendSystemPrompt: 'b' });
});

test('agentsFileFor writes under flow-agents, named by content, in the order the flow wrote it', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'claudio-data-'));
  const def = { description: 'Dev', prompt: 'Do the work', model: 'sonnet', tools: ['Read'], disallowedTools: [] as string[] };
  const file = await agentsFileFor(dataDir, 'dev', def);
  // What flowAgentsFile wrote before the extraction
  const body = `${JSON.stringify({ dev: { description: 'Dev', prompt: 'Do the work', model: 'sonnet', tools: ['Read'] } }, null, 2)}\n`;
  assert.equal(file, join(dataDir, 'flow-agents', `${createHash('sha256').update(body).digest('hex').slice(0, 16)}.json`));
  assert.equal(readFileSync(file, 'utf8'), body);
  assert.equal(await agentsFileFor(dataDir, 'dev', def), file);
});
