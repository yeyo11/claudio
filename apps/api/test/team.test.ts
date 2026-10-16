import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Project, Team, TeamMember } from '@claudio/shared';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../src/app.ts';

// The team routes over a real core with scratch dirs and a missing CLI: nothing here spawns Claude
// or reads the real ~/.claude.
let app: FastifyInstance;
let core: Core;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

async function importProject(modules: string[]): Promise<Project> {
  const path = mkdtempSync(join(tmpdir(), 'claudio-api-team-'));
  const res = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path, name: 'Crew', template: 'software', modules }) });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<Project>();
}

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-api-team-root-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  await app.close();
  core.shutdown();
});

test('a team is built from the template, edited member by member and read back', async () => {
  const p = await importProject(['board', 'team']);
  const empty = await app.inject(`/api/projects/${p.id}/team`);
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json<Team>().members, []);

  const built = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/team/from-template`, ...json({ roles: ['developer', 'qa'] }) });
  assert.equal(built.statusCode, 201, built.body);
  assert.deepEqual(
    built.json<Team>().members.map((m) => [m.agent, m.file.state]),
    [
      ['developer', 'ok'],
      ['qa', 'ok'],
    ],
  );

  // Asked again, it adds nothing: the same team, as a 200
  const again = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/team/from-template`, ...json({ roles: ['developer', 'qa'] }) });
  assert.equal(again.statusCode, 200, again.body);
  assert.deepEqual(again.json<Team>().members.map((m) => m.agent), ['developer', 'qa']);

  const put = await app.inject({
    method: 'PUT',
    url: `/api/projects/${p.id}/team/developer`,
    ...json({ role: 'developer', model: 'opus', responsibility: 'Builds', writes: ['src/**'] }),
  });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal(put.json<TeamMember>().model, 'opus');
  assert.match(readFileSync(join(p.path, '.claude', 'agents', 'developer.md'), 'utf8'), /model: opus/);

  // A file a person edits through the resources route is theirs from then on
  const hand = '---\nname: qa\ndescription: My QA\n---\nMine.\n';
  const saved = await app.inject({ method: 'PUT', url: `/api/config/resources/agents/qa?project=${p.id}`, ...json({ content: hand }) });
  assert.equal(saved.statusCode, 200, saved.body);
  await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/team/qa`, ...json({ role: 'qa', model: 'opus', responsibility: 'Checks' }) });
  assert.equal(readFileSync(join(p.path, '.claude', 'agents', 'qa.md'), 'utf8'), hand);
  const qa = (await app.inject(`/api/projects/${p.id}/team`)).json<Team>().members.find((m) => m.agent === 'qa');
  assert.deepEqual([qa?.file.state, qa?.file.drift], ['drifted', ['description']]);

  const removed = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}/team/qa` });
  assert.deepEqual(removed.json(), { ok: true });
  assert.equal(existsSync(join(p.path, '.claude', 'agents', 'qa.md')), true);
  assert.deepEqual((await app.inject(`/api/projects/${p.id}/team`)).json<Team>().unassignedAgents, ['qa']);
});

test('from-template adds an optional role only when it is named, with its tools and no column', async () => {
  const p = await importProject(['board', 'team']);
  const url = `/api/projects/${p.id}/team/from-template`;
  const plain = await app.inject({ method: 'POST', url, ...json({}) });
  assert.equal(plain.statusCode, 201, plain.body);
  assert.deepEqual(plain.json<Team>().members.map((m) => m.role), ['product-owner', 'architect', 'developer', 'qa']);

  const hunter = await app.inject({ method: 'POST', url, ...json({ roles: ['silent-failure-hunter'] }) });
  assert.equal(hunter.statusCode, 201, hunter.body);
  const member = hunter.json<Team>().members.find((m) => m.role === 'silent-failure-hunter');
  assert.deepEqual(member?.tools, ['Read', 'Grep', 'Glob', 'Bash']);
  assert.deepEqual(member?.columns, []);
  assert.match(readFileSync(join(p.path, '.claude', 'agents', 'silent-failure-hunter.md'), 'utf8'), /^tools: Read, Grep, Glob, Bash$/m);

  const unknown = await app.inject({ method: 'POST', url, ...json({ roles: ['ceo'] }) });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.json<{ error: string }>().error, /optionally, silent-failure-hunter, type-design-analyst, build-resolver, spec-miner/);

  const put = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/team/reader`, ...json({ role: 'reader', model: 'sonnet', responsibility: 'Reads', tools: ['Read', 'bad tool'] }) });
  assert.equal(put.statusCode, 400);
  assert.match(put.json<{ error: string }>().error, /not a tool name/);
  const templates = (await app.inject('/api/projects/templates')).json<Array<{ id: string; optionalTeam: Array<{ role: string }> }>>();
  assert.deepEqual(templates.find((t) => t.id === 'research')?.optionalTeam.map((r) => r.role), ['spec-miner']);
  assert.deepEqual(templates.find((t) => t.id === 'simple')?.optionalTeam, []);
});

test('the routes answer 400, 404 and 409 where they should', async () => {
  assert.equal((await app.inject('/api/projects/nope/team')).statusCode, 404);
  const off = await importProject(['board']);
  const refused = await app.inject({ method: 'POST', url: `/api/projects/${off.id}/team/from-template`, ...json({}) });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json<{ error: string }>().error, /Team module is off/);
  assert.equal((await app.inject(`/api/projects/${off.id}/team`)).json<Team>().enabled, false);

  const on = await importProject(['team']);
  const member = (agent: string, body: unknown) => app.inject({ method: 'PUT', url: `/api/projects/${on.id}/team/${agent}`, ...json(body) });
  assert.equal((await member('a', { role: 'dev', model: 'sonnet', responsibility: 'x' })).statusCode, 200);
  assert.equal((await member('b', { role: 'dev', model: 'sonnet', responsibility: 'x' })).statusCode, 409);
  assert.equal((await member('c', { role: 'dev2' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${on.id}/team/zzz` })).statusCode, 404);
});
