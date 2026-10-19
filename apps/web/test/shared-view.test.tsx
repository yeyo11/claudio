// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollaboratorsStatus, GroupList, JournalEntry, Project, ProjectSharing, SharedArtifact, SharedBoard, SharedChat, SharedDocument, SharedProject, SharedTranscriptPage, TranscriptEntry } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ReadOnlyBar } from '@claudio/chat-ui/components/ReadOnlyBar';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ToastProvider } from '@claudio/ui/components/Toast';
import i18n from '../src/i18n';
import { projectViews, sharedWith } from '../src/pages/dashboard/views';
import { collaboratorsKeys } from '../src/pages/project/shared-data';
import { ApiRequestError } from '../src/api';
import { sharedProjectPath } from '../src/pages/collaborators/model';
import { SharedProjectPage, SharedProjectView } from '../src/pages/collaborators/SharedProjectPage';
import { SharedWithYou } from '../src/pages/collaborators/SharedWithYou';
import { artifactValue, contiguousTail, journalAuthor, memberValue, sharedSections, sharedSubagentLink, SharedView, sortMembers } from '../src/pages/project/SharedView';
import { SHARE_KEY_RE, SharingSection } from '../src/pages/project/SharingSection';

// §5.2 and §5.3 of docs/plans/collaborators.md: the Sharing section of a project's settings and the
// Shared tab, where teammates' copies are read and never continued, and never mixed with the
// person's own chats.

const project: Project = { id: 'p1', name: 'api', path: '/tmp/api', worktrees: [], repo: null, removedWorktrees: 0, insideWorktreeOf: null, exists: true, chatCount: 3, lastActivity: null, key: 'API', modules: ['board', 'memory'] };

const status = (enabled: boolean, unavailable = false): CollaboratorsStatus => ({
  unavailable: unavailable ? { code: 'platform', reason: { code: 'platform', text: 'Not available on this platform' } as never } : null,
  settings: { enabled, displayName: 'Me', label: 'desktop', relayUrl: null, assistantReads: true },
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
  agentsMayRead: true,
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

test('the Shared tab is there while a teammate shares this project, whether or not Collaborators is on', () => {
  const catalog = [sharedProject()];
  assert.equal(sharedWith('p1', status(false), catalog).length, 1);
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
  assert.deepEqual(sharedSections(sharedProject({ kinds: ['board', 'journal', 'chats'] })), ['chats', 'journal', 'board']);
  assert.deepEqual(sharedSections(sharedProject()), ['chats', 'memory', 'journal', 'documents', 'artifacts', 'board']);
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

test("a delegation opens the subagent copied with the chat, matched as a local chat matches its own", () => {
  const listed = chat({ subagents: [{ agentId: 'a1b2', workflowRunId: null, subagentType: 'Explore', description: 'Find the bug', workflowPhase: null, size: 120, updatedAt: null }] });
  // Matched on what the call asked for, as a local chat matches; a workflow agent is not a delegation's
  const opened: string[] = [];
  const link = sharedSubagentLink(listed.subagents, (id) => opened.push(id));
  assert.equal(link?.find({ description: 'Find the bug', subagent_type: 'Explore' }), 'a1b2');
  assert.equal(link?.find({ description: 'Find the bug', subagent_type: 'Plan' }), null);
  assert.equal(link?.find({ description: 'Read the docs' }), null);
  link?.open('a1b2');
  assert.deepEqual(opened, ['a1b2']);
  assert.equal(sharedSubagentLink([{ agentId: 'w1', workflowRunId: 'wf_1', subagentType: null, description: 'Find the bug', workflowPhase: null, size: 1, updatedAt: null }], () => undefined), undefined);
  assert.equal(sharedSubagentLink(undefined, () => undefined), undefined);
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

const journalEntry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  id: 'j1',
  projectId: 'remote',
  kind: 'decision',
  text: 'Use iroh for the transport',
  itemId: null,
  item: null,
  author: { kind: 'person' },
  approvedBy: null,
  proposalId: null,
  documentPath: null,
  sources: [],
  createdAt: new Date().toISOString(),
  ...over,
});

test("a teammate's journal reads as the person's own, by day, written by the teammate, with nothing to delete", () => {
  const source = sharedProject();
  const qc = client((q) => {
    q.setQueryData(collaboratorsKeys.status, status(true));
    q.setQueryData(collaboratorsKeys.catalog, [source]);
    q.setQueryData(collaboratorsKeys.records(source, 'journal'), [
      journalEntry(),
      journalEntry({ id: 'j2', kind: 'closed', text: 'Rate limits', item: { id: 'w1', key: 'API-1', title: 'Rate limits', type: 'task', status: 'done' } }),
    ]);
  });
  const html = render(qc, <SharedView project={project} />, '/?project=p1&view=shared&section=journal');
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>.*?Diario/);
  assert.match(html, /Decisión: Use iroh for the transport/);
  assert.match(html, /Decisión · Ana/);
  assert.match(html, /API-1/);
  // The teammate's tasks are not this install's: no link into them, and no delete or add
  assert.doesNotMatch(html, /href="\/tasks|journal-delete|Tú/);
  assert.equal(journalAuthor({ author: { kind: 'agent', role: null } }, 'Ana', (r) => r, 'Un agente'), 'Un agente');
  assert.equal(journalAuthor({ author: { kind: 'agent', role: 'qa' } }, 'Ana', (r) => `role:${r}`, 'Un agente'), 'role:qa');
});

test("a teammate's artifacts: results and plan objectives are read, an attachment is downloaded, nothing is launched", () => {
  const source = sharedProject();
  const older = new Date(Date.now() - 3_600_000).toISOString();
  const artifacts: SharedArtifact[] = [
    { kind: 'plan', id: 'p1', name: 'Rate limits plan', objective: 'Limit **every** route', taskCount: 3, createdAt: older },
    { kind: 'orchestration', id: 'o1', name: 'Rate limits', finalResult: '## Done\nAll routes are limited.', updatedAt: new Date().toISOString() },
    { kind: 'upload', id: 'u1', name: 'trace.log', mediaType: 'text/plain', sizeBytes: 2048, sha256: 'e'.repeat(64), chatId: 'c-quiet-000', createdAt: older },
  ];
  const qc = client((q) => {
    q.setQueryData(collaboratorsKeys.status, status(true));
    q.setQueryData(collaboratorsKeys.catalog, [source]);
    q.setQueryData(collaboratorsKeys.records(source, 'artifacts'), artifacts);
  });
  // Newest first, and the newest opens: the orchestration's result
  const html = render(qc, <SharedView project={project} />, '/?project=p1&view=shared&section=artifacts');
  const order = [...html.matchAll(/class="strong break">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(order, ['Rate limits', 'Rate limits plan', 'trace.log']);
  assert.match(html, /Orquestación/);
  assert.match(html, /All routes are limited/);
  assert.doesNotMatch(html, /Descargar|href="\/orchestration/);

  const plan = render(qc, <SharedView project={project} />, `/?project=p1&view=shared&section=artifacts&file=${encodeURIComponent(artifactValue(artifacts[0] as SharedArtifact))}`);
  assert.match(plan, /3 tareas/);
  assert.match(plan, /Limit (\*\*every\*\*|<strong>every<\/strong>) route/);

  const upload = render(qc, <SharedView project={project} />, `/?project=p1&view=shared&section=artifacts&file=${encodeURIComponent('upload:u1')}`);
  assert.match(upload, /text\/plain/);
  assert.match(upload, /2(,|\.)0 KB|2 KB/);
  assert.match(upload, /Descargar/);
});

test('a project not cloned here opens its own read-only view from the Collaborators page, beside the link', () => {
  const uncloned = sharedProject({ matches: [] });
  const html = render(new QueryClient(), <SharedWithYou shared={[uncloned]} projects={[project]} busy={false} onLink={() => undefined} onUnlink={() => undefined} />);
  assert.match(html, /No clonado aquí/);
  assert.match(html, /Vincular con un proyecto local/);
  assert.match(html, new RegExp(`href="/collaborators/shared/ana-laptop/${'a'.repeat(32)}"`));
  assert.match(html, /aria-label="Abrir api en solo lectura"/);
  assert.equal(sharedProjectPath({ owner: 'a b', shareId: 'c/d' }), '/collaborators/shared/a%20b/c%2Fd');
});

test('the read-only view of a project not cloned here: its tabs from the copy, and Link to a local project as its action', () => {
  const uncloned = sharedProject({ matches: [] });
  const qc = client((q) => {
    q.setQueryData(collaboratorsKeys.project(uncloned), uncloned);
    q.setQueryData(collaboratorsKeys.records(uncloned, 'chats'), [chat()]);
  });
  const path = sharedProjectPath(uncloned);
  const html = render(
    qc,
    <Routes>
      <Route path="/collaborators/shared/:owner/:shareId" element={<SharedProjectPage />} />
    </Routes>,
    path,
  );
  assert.match(html, /<h1>api<\/h1>/);
  assert.match(html, /Compartido por Ana · laptop · solo lectura/);
  assert.match(html, /github\.com\/acme\/api/);
  assert.match(html, /No clonado aquí/);
  assert.match(html, /data-testid="collab-link"/);
  assert.match(html, /Vincular con un proyecto local/);
  // Every kind the copy carries is a tab, the journal and artifacts included
  for (const tab of ['Chats', 'Memoria', 'Diario', 'Documentos', 'Artefactos', 'Tablero']) assert.match(html, new RegExp(`role="tab"[^>]*>(?:(?!</button>).)*${tab}`), tab);
  // Chats open inside this view, never the person's own chat page; nothing here is the person's work
  assert.match(html, new RegExp(`href="${path}\\?chat=c-quiet-000"`));
  assert.doesNotMatch(html, /href="\/chats\/|live-energy|composer|btn-primary/);
});

test('once linked, the read-only view leads into the local project, and a project no longer shared says so', () => {
  const linked = sharedProject({ matches: [], linkedProjectId: 'p1' });
  const html = render(new QueryClient(), <SharedProjectView shared={linked} projects={[project]} />);
  assert.match(html, /Abrir en api/);
  assert.match(html, /href="\/\?project=p1&amp;view=shared"/);
  assert.doesNotMatch(html, /data-testid="collab-link"|No clonado aquí/);

  const gone = render(new QueryClient(), <SharedProjectView shared={null} error={new ApiRequestError('No such shared project', 404)} projects={[]} />);
  assert.match(gone, /Este proyecto ya no se comparte contigo/);
  assert.match(gone, /href="\/collaborators"/);
  const failed = render(new QueryClient(), <SharedProjectView shared={null} error={new ApiRequestError('boom', 500)} projects={[]} />);
  assert.match(failed, /boom/);
  assert.doesNotMatch(failed, /ya no se comparte/);
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
  agentsMayRead: true,
  agentReads: false,
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
