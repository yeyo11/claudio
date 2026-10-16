// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectTeamRole, Team, TeamMember } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { ToastProvider } from '@claudio/ui/components/Toast';
import i18n, { setLanguage } from '../src/i18n';
import { MemberCells, MemberGrid, MoreRoles, TeamEmpty } from '../src/pages/team/Members';
import { isKnownRole, isReadOnlyMember, offeredRoles, roleInitials, TEMPLATE_RESPONSIBILITIES } from '../src/pages/team/model';

// Idea 10 of docs/plans/agent-run-improvements.md: four optional roles offered from a quiet "Más
// roles" menu, and the review roles tagged "solo lectura" because their agent file allows only tools
// that read.

const role = (name: string, over: Partial<ProjectTeamRole> = {}): ProjectTeamRole => ({ role: name, model: 'sonnet', responsibility: TEMPLATE_RESPONSIBILITIES[name as keyof typeof TEMPLATE_RESPONSIBILITIES] ?? name, ...over });
const HUNTER = role('silent-failure-hunter', { tools: ['Read', 'Grep', 'Glob', 'Bash'], writes: [] });
const MINER = role('spec-miner', { model: 'opus', tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'], writes: [] });
const RESOLVER = role('build-resolver');

const member = (over: Partial<TeamMember> & { role: string }): TeamMember => ({
  agent: over.role,
  model: 'sonnet',
  responsibility: TEMPLATE_RESPONSIBILITIES[over.role as keyof typeof TEMPLATE_RESPONSIBILITIES] ?? '',
  file: { path: `.claude/agents/${over.role}.md`, state: 'ok', drift: [], description: null, model: null, updatedAt: null },
  columns: [],
  running: [],
  queued: 0,
  lastRun: null,
  ...over,
});

const team = (members: TeamMember[]): Team => ({ projectId: 'p', enabled: true, members, unassignedAgents: [] });

function wrap(children: ReactNode) {
  const page = (
    <TooltipProvider>
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={createMemoryRouter([{ path: '*', element: page }])} />
    </QueryClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

for (const [lang, more, readOnly] of [
  ['en', 'More roles', 'read-only'],
  ['es', 'Más roles', 'solo lectura'],
] as const) {
  test(`${lang}: the "${more}" menu is offered beside the team, and only while the template has a role the team lacks`, async () => {
    setLanguage(lang);
    await i18n.changeLanguage(lang);
    const html = wrap(<MoreRoles projectId="p" optional={[HUNTER, MINER]} members={[member({ role: 'developer' })]} />);
    assert.match(text(html), new RegExp(`${more}`));
    assert.match(html, /class="btn btn-small team-more-roles"/);
    // Every optional role is already on the team: nothing to offer
    assert.equal(wrap(<MoreRoles projectId="p" optional={[HUNTER]} members={[member({ role: 'silent-failure-hunter' })]} />).includes('team-more-roles'), false);
    assert.equal(wrap(<MoreRoles projectId="p" optional={[]} members={[]} />).includes('team-more-roles'), false);
  });

  test(`${lang}: the empty team offers "${more}" beside the template's team, which does not include them`, async () => {
    setLanguage(lang);
    await i18n.changeLanguage(lang);
    const html = wrap(<TeamEmpty projectId="p" roles={[role('developer')]} optional={[HUNTER]} templateName="Professional software" phone={false} onAdd={() => undefined} />);
    assert.match(text(html), new RegExp(more));
    assert.doesNotMatch(wrap(<TeamEmpty projectId="p" roles={[role('developer')]} templateName={null} phone={false} onAdd={() => undefined} />), /team-more-roles/);
  });

  test(`${lang}: a review role carries a muted "${readOnly}" tag on its card and on the phone, and the spec miner and a free role do not`, async () => {
    setLanguage(lang);
    await i18n.changeLanguage(lang);
    const members = [
      member({ role: 'silent-failure-hunter', ...(HUNTER.tools ? { tools: HUNTER.tools } : {}) }),
      member({ role: 'spec-miner', ...(MINER.tools ? { tools: MINER.tools } : {}) }),
      member({ role: 'build-resolver' }),
    ];
    const grid = wrap(<MemberGrid team={team(members)} memberHref={(agent) => `?member=${agent}`} onAdd={() => undefined} />);
    const cards = grid.split('<article').slice(1);
    assert.equal(cards.length, 3);
    assert.match(cards[0] ?? '', new RegExp(`badge badge-muted[^>]*><span class="badge-text">${readOnly}<`));
    assert.doesNotMatch(cards[1] ?? '', new RegExp(readOnly));
    assert.doesNotMatch(cards[2] ?? '', new RegExp(readOnly));
    const cells = wrap(<MemberCells team={team(members)} memberHref={(agent) => `?member=${agent}`} />);
    assert.equal(cells.split(readOnly).length - 1, 1);
  });
}

test('only a member whose list of tools has none that writes is read-only', () => {
  assert.equal(isReadOnlyMember({ tools: ['Read', 'Grep', 'Glob', 'Bash'] }), true);
  assert.equal(isReadOnlyMember({ tools: ['Read', 'Bash(git diff:*)'] }), true);
  assert.equal(isReadOnlyMember({ tools: ['Read', 'Write', 'Edit'] }), false);
  assert.equal(isReadOnlyMember({ tools: ['Read', 'Edit(src/**)'] }), false);
  assert.equal(isReadOnlyMember({ tools: [] }), false, 'an empty list is no list');
  assert.equal(isReadOnlyMember({}), false, 'no list is every tool');
});

test('the optional roles are offered only when the team lacks them, in the order the template lists them', () => {
  assert.deepEqual(offeredRoles([HUNTER, MINER, RESOLVER], [{ role: 'spec-miner' }]).map((r) => r.role), ['silent-failure-hunter', 'build-resolver']);
  assert.deepEqual(offeredRoles([HUNTER], [{ role: 'silent-failure-hunter' }]), []);
});

test('the four roles are known to the screens: named, with initials, and with the responsibility core writes', () => {
  for (const name of ['silent-failure-hunter', 'type-design-analyst', 'build-resolver', 'spec-miner']) {
    assert.ok(isKnownRole(name), name);
    assert.ok(roleInitials(name).length > 0);
  }
});
