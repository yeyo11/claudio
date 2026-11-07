// The web has one Collaborators client (lib/api/collaborators.ts). A second one grew in
// pages/project/shared-data.ts with its own keys and freshness rules for the same routes, so the
// Collaborators page and a project's Shared tab cached the same reads twice and refreshed them
// differently. These checks keep it at one.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collaboratorsKeys, type SharedRef } from '../src/lib/api/collaborators';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const CLIENT = 'lib/api/collaborators.ts';

function sources(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, into);
    else if (/\.tsx?$/.test(name)) into.push(path);
  }
  return into;
}

test('only the one client calls the Collaborators routes or defines their keys', () => {
  // A request to a Collaborators route, or to a project's sharing, as `request`/`requestResponse` take them
  const call = /request(?:Response)?(?:<[^>]*>)?\(\s*[`'"](?:\/collaborators\b|\/projects\/\$\{[^}]*\}\/sharing\b)/;
  const definition = /export\s+const\s+collaborators(?:Api|Keys)\b/;
  const files = sources(SRC).map((path) => ({ file: relative(SRC, path), text: readFileSync(path, 'utf8') }));
  // The patterns still recognise the client itself, so they cannot rot into matching nothing
  const client = files.find(({ file }) => file === CLIENT)?.text ?? '';
  assert.match(client, call);
  assert.match(client, definition);
  const offenders = files
    .filter(({ file, text }) => file !== CLIENT && (call.test(text) || definition.test(text)))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test("every key sits under 'collaborators', so the collaborators.* events refresh them all", () => {
  const ref: SharedRef = { owner: 'peer', shareId: 'share' };
  const keys = [
    collaboratorsKeys.status,
    collaboratorsKeys.groups,
    collaboratorsKeys.catalog,
    collaboratorsKeys.sharing('p1'),
    collaboratorsKeys.joinRequests('g1'),
    collaboratorsKeys.project(ref),
    collaboratorsKeys.records(ref, 'chats'),
    collaboratorsKeys.transcript(ref, 'c1'),
    collaboratorsKeys.agentTranscript(ref, 'c1', { agentId: 'a1', workflowRunId: null }),
    collaboratorsKeys.blob(ref, 'abc'),
    collaboratorsKeys.agentReads({ owner: 'peer' }),
  ];
  for (const key of keys) assert.equal(key[0], 'collaborators', JSON.stringify(key));
  // A shared project's key is a prefix of its records', so removing a copy drops both
  const project = collaboratorsKeys.project(ref);
  for (const records of [collaboratorsKeys.records(ref, 'board'), collaboratorsKeys.transcript(ref, 'c1')]) {
    assert.deepEqual(records.slice(0, project.length), [...project]);
  }
});
