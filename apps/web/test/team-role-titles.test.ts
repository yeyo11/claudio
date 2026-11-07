import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ROLE_TITLES_ES } from '@claudio/shared';
import { KNOWN_ROLES } from '../src/pages/team/model';

// The Spanish role names live twice on purpose: in @claudio/shared, which core writes into the first
// line (the listed title) of a flow run's chat, and in the web's i18n, which the Team screens show.
// They must read the same, or a chat's title and the member it belongs to name the role differently
// (docs/plans/ci-and-regression-open.md, R2).

const esTeam = JSON.parse(readFileSync(new URL('../src/i18n/locales/es/team.json', import.meta.url), 'utf8')) as { roles: Record<string, string> };

test('the web and core name every built-in role the same in Spanish', () => {
  assert.deepEqual(esTeam.roles, ROLE_TITLES_ES);
});

test('the shared titles cover exactly the roles the web knows', () => {
  assert.deepEqual(Object.keys(ROLE_TITLES_ES).sort(), [...KNOWN_ROLES].sort());
});
