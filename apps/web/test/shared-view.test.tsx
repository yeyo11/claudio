// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollaboratorsStatus, GroupList, Project, ProjectSharing, SharedBoard, SharedChat, SharedDocument, SharedProject, SharedTranscriptPage, TranscriptEntry } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ReadOnlyBar } from '@claudio/chat-ui/components/ReadOnlyBar';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ToastProvider } from '@claudio/ui/components/Toast';
import i18n from '../src/i18n';
import { projectViews, sharedWith } from '../src/pages/dashboard/views';
import { collaboratorsKeys } from '../src/pages/project/shared-data';
import { contiguousTail, memberValue, sharedSections, SharedView, sortMembers } from '../src/pages/project/SharedView';
import { SHARE_KEY_RE, SharingSection } from '../src/pages/project/SharingSection';

// §5.2 and §5.3 of docs/plans/collaborators.md: the Sharing section of a project's settings and the
// Shared tab, where teammates' copies are read and never continued, and never mixed with the
// person's own chats.

const project: Project = { id: 'p1', name: 'api', path: '/tmp/api', worktrees: [], exists: true, chatCount: 3, lastActivity: null, key: 'API', modules: ['board', 'memory'] };

const status = (enabled: boolean, unavailable = false): CollaboratorsStatus => ({
  unavailable: unavailable ? { code: 'platform', reason: { code: 'platform', text: 'Not available on this platform' } as never } : null,
  settings: { enabled, displayName: 'Me', label: 'desktop', relayUrl: null },
  endpointId: enabled ? 'me' : null,
  connection: enabled ? 'online' : 'off',
  homeRelay: null,
});

const sharedProject = (over: Partial<SharedProject> = {}): SharedProject => ({
  owner: 'ana-laptop',
  ownerName: 'Ana',
  ownerLabel: 'laptop',
  groupIds: ['g1'],
  shareKey: 'github.com/acme/api',
  shareId: 'a'.repeat(32),
  name: 'api',
  remote: 'git@github.com:acme/api.git',
  subpath: null,
  kinds: ['chats', 'memory', 'journal', 'documents', 'artifacts', 'board'],
  counts: { chats: 2 },
  sync: { state: 'live', lastSyncedAt: new Date().toISOString(), path: 'direct', error: null },
  matches: ['p1'],
  linkedProjectId: null,
  ...over,
});

const chat = (over: Partial<SharedChat> = {}): SharedChat => ({
  id: 'c-quiet-000',
  title: 'Fix the login',
  firstPrompt: 'Fix the login',
  messageCount: 4,
  startedAt: null,
  updatedAt: new Date().toISOString(),
  model: 'opus',
  origin: 'claudio',
  branch: null,
  live: false,
  activity: null,
  ...over,
});

const entry = (uuid: string, role: 'user' | 'assistant', text: string): TranscriptEntry => ({ uuid, role, timestamp: new Date().toISOString(), blocks: [{ type: 'text', text }] }) as TranscriptEntry;

function client(fill: (qc: QueryClient) => void): QueryClient {
  const qc = new QueryClient();
  fill(qc);
  return qc;
}

const render = (qc: QueryClient, children: ReactNode, path = '/') =>
  renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
        </TooltipProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );

// tsx compiles the packages' files with the classic runtime too, and they do not import React
(globalThis as { React?: typeof React }).React = React;

test.beforeEach(async () => {
  await i18n.changeLanguage('es');
});

test('the Shared tab is there only while Collaborators is on and a teammate shares this project', () => {
  const catalog = [sharedProject()];
  assert.deepEqual(sharedWith('p1', status(false), catalog), []);
  assert.deepEqual(sharedWith('p1', status(true, true), catalog), []);
  assert.deepEqual(sharedWith('p1', status(true), undefined), []);
  assert.equal(sharedWith('p1', status(true), catalog).length, 1);
  assert.deepEqual(sharedWith('p2', status(true), catalog), []);
  // A project linked by hand shows where it was linked, and only there
  const linked = [sharedProject({ matches: ['p1'], linkedProjectId: 'p2' })];
  assert.deepEqual(sharedWith('p1', status(true), linked), []);
  assert.equal(sharedWith('p2', status(true), linked).length, 1);

  assert.deepEqual(projectViews(['board', 'memory']), ['board', 'memory', 'resources', 'worktrees', 'settings']);
  assert.deepEqual(projectViews(['board', 'memory'], true), ['board', 'memory', 'shared', 'resources', 'worktrees', 'settings']);
  assert.deepEqual(projectViews([], true), ['shared', 'resources', 'worktrees', 'settings']);
});

test('members are listed by person, then install, and each carries only the sub-tabs of its kinds', () => {
  const sorted = sortMembers([sharedProject({ owner: 'b', ownerName: 'Bea', ownerLabel: null }), sharedProject({ owner: 'a2', ownerLabel: 'laptop' }), sharedProject({ owner: 'a1', ownerLabel: 'desktop' })]);
  assert.deepEqual(sorted.map((m) => m.owner), ['a1', 'a2', 'b']);
  assert.deepEqual(sharedSections(sharedProject({ kinds: ['board', 'journal', 'chats'] })), ['chats', 'board']);
  assert.equal(memberValue(sharedProject()), `ana-laptop:${'a'.repeat(32)}`);
});

test("a transcript's window is the run that ends at the newest entry, without holes", () => {
  const a = entry('a', 'user', 'a');
  const b = entry('b', 'assistant', 'b');
  const c = entry('c', 'user', 'c');
  assert.deepEqual(contiguousTail(new Map()), { from: 0, entries: [] });
  assert.deepEqual(contiguousTail(new Map([[3, b], [4, c], [2, a]])), { from: 2, entries: [a, b, c] });
  // An older page that no longer touches the latest window is not drawn across the gap
  assert.deepEqual(contiguousTail(new Map([[0, a], [5, b], [6, c]])), { from: 5, entries: [b, c] });
});

test("a collaborator's running chat carries the live rail and its verb; a quiet one does not", () => {
  const source = sharedProject();
  const qc = client((q) => {
    q.setQueryData(collaboratorsKeys.status, status(true));
    q.setQueryData(collaboratorsKeys.catalog, [source, sharedProject({ owner: 'bea', ownerName: 'Bea', ownerLabel: null, sync: { state: 'offline', lastSyncedAt: null, path: null, error: null } })]);
    q.setQueryData(collaboratorsKeys.records(source, 'chats'), [
      chat(),
      chat({ id: 'c-live-0001', title: 'Add rate limits', live: true, activity: { kind: 'tool', tool: 'Edit', target: 'src/limits.ts', since: new Date().toISOString() } }),
    ]);
  });
  const html = render(qc, <SharedView project={project} />, '/?project=p1&view=shared');
  // The member switcher, by person, and the sync state in words
  assert.match(html, /aria-label="Colaborador"/);
  assert.match(html, /Al día · sincronizando/);
  const rows = [...html.matchAll(/<li class="(crow[^"]*)" data-id="([^"]+)"/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(rows, [
    ['c-quiet-000', 'crow'],
    ['c-live-0001', 'crow live-rail'],
  ]);
  assert.match(html, /class="ticker crow-ticker"/);
  assert.match(html, /src\/limits\.ts/);
  // Nothing here is the person's own work: no energy border, no composer
  assert.doesNotMatch(html, /live-energy|composer/);
  // Rows open the copy inside the tab, never the person's own chat page
  assert.match(html, /href="\/\?project=p1&amp;view=shared&amp;chat=c-live-0001"/);
  assert.doesNotMatch(html, /href="\/chats\//);
});

test("a teammate's records stay under the collaborators keys, apart from the person's own chats", () => {
  const source = sharedProject();
  const own = [{ id: 'mine' }];
  const qc = client((q) => {
    q.setQueryData(collaboratorsKeys.status, status(true));
    q.setQueryData(collaboratorsKeys.catalog, [source]);
    q.setQueryData(collaboratorsKeys.records(source, 'chats'), [chat()]);
    q.setQueryData(['chats', {}], own);
  });
  render(qc, <SharedView project={project} />, '/?project=p1&view=shared');
  const keys = qc.getQueryCache().getAll().map((query) => query.queryKey);
  for (const key of keys) assert.ok(key[0] === 'collaborators' || (key[0] === 'chats' && qc.getQueryData(key) === own), JSON.stringify(key));
  assert.equal(qc.getQueryData(['chats', {}]), own);
});

test("an open chat is read only: the bar says whose it is, and there is no composer or message menu", () => {
  const source = sharedProject();
  const page: SharedTranscriptPage = { chatId: 'c-quiet-000', entries: [entry('u1', 'user', 'Fix the login'), entry('a1', 'assistant', 'Done.')], from: 0, total: 2, live: false };
  const qc = client((q) => {
    q.setQueryData(collaboratorsKeys.status, status(true));
    q.setQueryData(collaboratorsKeys.catalog, [source]);
    q.setQueryData(collaboratorsKeys.records(source, 'chats'), [chat()]);
    q.setQueryData(collaboratorsKeys.transcript(source, 'c-quiet-000'), page);
  });
  const html = render(qc, <SharedView project={project} />, '/?project=p1&view=shared&section=chats&chat=c-quiet-000');
  assert.match(html, /class="alert chat-banner read-only-bar" role="note"/);
  assert.match(html, /Solo lectura · de Ana/);
  assert.match(html, /Todos los chats/);
  assert.doesNotMatch(html, /composer|msg-actions/);
});

test("a document is read from the teammate's working copy, and says so", () => {
  const source = sharedProject();
  const doc: SharedDocument = { path: 'docs/plan.md', title: 'Plan', size: 10, updatedAt: null, sha256: 'f'.repeat(64) };
  const qc = client((q) => {
    q.setQueryData(collaboratorsKeys.status, status(true));
    q.setQueryData(collaboratorsKeys.catalog, [source]);
    q.setQueryData(collaboratorsKeys.records(source, 'documents'), [doc]);
    q.setQueryData(collaboratorsKeys.blob(source, doc.sha256), '# Plan');
  });
  const html = render(qc, <SharedView project={project} />, '/?project=p1&view=shared&section=documents');
  assert.match(html, /Copia de trabajo en la máquina de Ana · puede diferir de tu copia/);
  assert.doesNotMatch(html, /contenteditable|<textarea/);
});

test("a teammate's board has its columns and cards, with nothing to drag, create or edit", () => {
  const source = sharedProject();
  const board = {
    items: [{ id: 'w1', key: 'API-1', title: 'Rate limits', status: 'in_progress', type: 'task', priority: 'high', projectId: 'remote', activeLink: null }],
    milestones: [],
  } as unknown as SharedBoard;
  const qc = client((q) => {
    q.setQueryData(collaboratorsKeys.status, status(true));
    q.setQueryData(collaboratorsKeys.catalog, [source]);
    q.setQueryData(collaboratorsKeys.records(source, 'board'), board);
  });
  const html = render(qc, <SharedView project={project} />, '/?project=p1&view=shared&section=board');
  assert.match(html, /class="workitem-board shared-board"/);
  assert.match(html, /Rate limits/);
  assert.doesNotMatch(html, /draggable="true"|workitem-col-add|href="\/tasks/);
});

test('the read-only bar names the teammate, or says what the caller tells it', () => {
  assert.match(renderToStaticMarkup(<ReadOnlyBar from="Ana" />), /Solo lectura · de Ana/);
  assert.match(renderToStaticMarkup(<ReadOnlyBar from="Ana">Otra cosa</ReadOnlyBar>), /Otra cosa/);
});

const sharing = (over: Partial<ProjectSharing> = {}): ProjectSharing => ({
  projectId: 'p1',
  groups: ['g1'],
  shareKey: 'github.com/acme/api',
  shareId: 'a'.repeat(32),
  defaultShareKey: 'github.com/acme/api',
  edited: false,
  remote: 'upstream',
  remotes: [
    { name: 'origin', url: 'git@github.com:me/api.git', shareKey: 'github.com/me/api' },
    { name: 'upstream', url: 'git@github.com:acme/api.git', shareKey: 'github.com/acme/api' },
  ],
  subpath: null,
  keyInUse: null,
  kinds: ['chats', 'memory', 'journal', 'documents', 'artifacts', 'board'],
  seenAs: { name: 'api', remote: 'github.com/acme/api' },
  ...over,
});

const groups: GroupList = {
  groups: [{ id: 'g1', name: 'Backend team', head: { version: 1, hash: 'h' }, owner: 'me', isOwner: true, members: [], frozen: false, conflict: null, joinRequestCount: 0 }],
  pendingJoins: [],
};

test('the Sharing section has a switch per group, the warning, the key and what a collaborator sees', () => {
  const qc = client((q) => {
    q.setQueryData(collaboratorsKeys.status, status(true));
    q.setQueryData(collaboratorsKeys.groups, groups);
    q.setQueryData(collaboratorsKeys.sharing('p1'), sharing());
  });
  const html = render(qc, <SharingSection project={project} />);
  assert.match(html, /Compartir con Backend team/);
  assert.match(html, /role="switch" aria-checked="true"/);
  assert.match(html, /class="alert alert-warn" role="note"/);
  assert.match(html, /no se puede recuperar/);
  assert.match(html, /github\.com\/acme\/api/);
  assert.match(html, /Del remoto upstream/);
  assert.match(html, /aria-label="Remoto"/);
  assert.match(html, /api · github\.com\/acme\/api/);
});

test('a key another project shares keeps the switches off and says which project', () => {
  const qc = client((q) => {
    q.setQueryData(collaboratorsKeys.status, status(true));
    q.setQueryData(collaboratorsKeys.groups, groups);
    q.setQueryData(collaboratorsKeys.sharing('p1'), sharing({ keyInUse: { projectId: 'p9', projectName: 'api-clone' }, remote: null, remotes: [] }));
  });
  const html = render(qc, <SharingSection project={project} />);
  assert.match(html, /role="switch" aria-checked="false"[^>]*disabled/);
  assert.match(html, /api-clone ya comparte esta clave/);
  assert.match(html, /Sin remoto de git: se comparte por su propio id/);
  assert.doesNotMatch(html, /aria-label="Remoto"/);
});

test('with Collaborators off the section leads there instead', () => {
  const qc = client((q) => q.setQueryData(collaboratorsKeys.status, status(false)));
  const html = render(qc, <SharingSection project={project} />);
  assert.match(html, /Activa Colaboradores/);
  assert.match(html, /href="\/collaborators"/);
});

test('an edited key is lower case, from 3 to 200 characters of the allowed set', () => {
  assert.ok(SHARE_KEY_RE.test('github.com/acme/mono#apps/web'));
  assert.ok(SHARE_KEY_RE.test('local/0a1b'));
  assert.ok(!SHARE_KEY_RE.test('GitHub.com/Acme'));
  assert.ok(!SHARE_KEY_RE.test('ab'));
  assert.ok(!SHARE_KEY_RE.test('has space'));
});
