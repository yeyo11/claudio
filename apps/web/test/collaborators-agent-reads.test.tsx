// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentReadEntry, CollaboratorsSettings, CollaboratorsStatus, GroupList, Project, ProjectSharing, SharedProject } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ToastProvider } from '@claudio/ui/components/Toast';
import i18n from '../src/i18n';
import { teammateLabel } from '../src/components/TeammateName';
import { chatsThatRead, startOfToday } from '../src/lib/api/collaborators';
import { AgentsCard } from '../src/pages/collaborators/AgentsCard';
import { TeammateReadsTag } from '../src/pages/chat/TeammateReadsTag';
import { AgentReadsView } from '../src/pages/config/security/AgentReadsCard';
import { AgentReadsLineView } from '../src/pages/project/SharedView';
import { SharingSection } from '../src/pages/project/SharingSection';
import { collaboratorsKeys } from '../src/pages/project/shared-data';

// docs/plans/collaborators-agent-access.md on the web: the assistant's switch, the project's switch
// and the sharer's flag, the chat's chip, the copy's "read by" line and the audit in Security.

(globalThis as { React?: typeof React }).React = React;

const render = (children: ReactNode, qc = new QueryClient()) =>
  renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <TooltipProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </TooltipProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );

/** What the providers alone draw (the toast region), so a component that draws nothing compares to it */
const empty = () => render(null);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

const settings = (over: Partial<CollaboratorsSettings> = {}): CollaboratorsSettings => ({ enabled: true, displayName: 'Jose', label: 'desktop', relayUrl: null, assistantReads: true, ...over });

const copy = (over: Partial<SharedProject> = {}): SharedProject =>
  ({
    owner: 'ana-endpoint-0123456789',
    ownerName: 'Ana',
    ownerLabel: 'laptop',
    shareKey: 'github.com/acme/api',
    shareId: 's1',
    name: 'api',
    agentsMayRead: true,
    matches: ['p1'],
    linkedProjectId: null,
    ...over,
  }) as SharedProject;

const read = (over: Partial<AgentReadEntry> = {}): AgentReadEntry => ({
  id: 1,
  at: '2026-10-17T09:30:00.000Z',
  chatId: 'chat-aaaaaaaa-1111',
  tool: 'collab_read_transcript',
  owner: 'ana-endpoint-0123456789',
  shareKey: 'github.com/acme/api',
  shareId: 's1',
  kind: 'chats',
  recordIds: ['c1'],
  ...over,
});

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test.after(async () => {
  await i18n.changeLanguage('es');
});

test('Collaborators: the assistant switch follows assistantReads and leads to the audit', () => {
  const on = render(<AgentsCard settings={settings()} busy={false} onSave={async () => true} />);
  assert.match(on, /role="switch" aria-checked="true"/);
  assert.ok(text(on).includes('The assistant reads what is shared with you'));
  assert.match(on, /href="\/settings\/access\/agent-reads"/);
  const off = render(<AgentsCard settings={settings({ assistantReads: false })} busy={false} onSave={async () => true} />);
  assert.match(off, /role="switch" aria-checked="false"/);
});

const project: Project = { id: 'p1', name: 'api', path: '/tmp/api', worktrees: [], repo: null, removedWorktrees: 0, insideWorktreeOf: null, exists: true, chatCount: 3, lastActivity: null, key: 'API', modules: [] };

const status = {
  unavailable: null,
  settings: settings(),
  endpointId: 'me',
  connection: 'online',
  connectionError: null,
  homeRelay: null,
} as unknown as CollaboratorsStatus;

const sharing = (over: Partial<ProjectSharing> = {}): ProjectSharing =>
  ({
    groups: [],
    shareKey: 'github.com/acme/api',
    defaultShareKey: 'github.com/acme/api',
    edited: false,
    remote: null,
    remotes: [],
    subpath: null,
    keyInUse: null,
    kinds: ['chats'],
    seenAs: { name: 'api', remote: null },
    agentsMayRead: true,
    agentReads: false,
    ...over,
  }) as ProjectSharing;

const sharingHtml = (value: ProjectSharing) => {
  const qc = new QueryClient();
  qc.setQueryData(collaboratorsKeys.status, status);
  qc.setQueryData(collaboratorsKeys.groups, { groups: [], pendingJoins: [] } satisfies GroupList);
  qc.setQueryData(collaboratorsKeys.sharing('p1'), value);
  return render(<SharingSection project={project} />, qc);
};

/** The switch whose label says `label`: its `aria-checked` */
const switchFor = (html: string, label: string): string | null => {
  const at = html.indexOf(label);
  if (at < 0) return null;
  const before = html.slice(0, at);
  const found = [...before.matchAll(/role="switch" aria-checked="(true|false)"/g)].at(-1);
  return found?.[1] ?? null;
};

test("the Sharing section: the sharer's flag on by default, the project's agent reads off by default", () => {
  const defaults = text(sharingHtml(sharing()));
  const html = sharingHtml(sharing());
  assert.ok(defaults.includes("Teammates' agents may read this"));
  assert.ok(defaults.includes('Agents in this project can read what teammates share here'));
  assert.ok(defaults.includes('Skip permission checks'), 'the hint says bypassPermissions chats never read');
  assert.equal(switchFor(html, 'Teammates&#x27; agents may read this'), 'true');
  assert.equal(switchFor(html, 'Agents in this project can read'), 'false');
  const flipped = sharingHtml(sharing({ agentsMayRead: false, agentReads: true }));
  assert.equal(switchFor(flipped, 'Teammates&#x27; agents may read this'), 'false');
  assert.equal(switchFor(flipped, 'Agents in this project can read'), 'true');
});

test('the chat chip: shown with a scope, in words, never animated; nothing without one', () => {
  assert.equal(render(<TeammateReadsTag scope={null} />), empty());
  assert.equal(render(<TeammateReadsTag scope={undefined} />), empty());
  const html = render(<TeammateReadsTag scope={{ kind: 'project', projectId: 'p1' }} />);
  assert.ok(text(html).includes("Reads teammates' shares"));
  assert.match(html, /data-testid="chat-teammate-reads"/);
  assert.match(html, /badge badge-muted/);
  assert.doesNotMatch(html, /is-live|live-rail|energy|spinner/);
});

test("the copy's line: chats that read it today, the sharer's refusal, and nothing at zero", () => {
  assert.equal(render(<AgentReadsLineView agentsMayRead chats={0} />), empty());
  const three = render(<AgentReadsLineView agentsMayRead chats={3} />);
  assert.ok(text(three).includes('Read by 3 chats today'));
  assert.match(three, /href="\/settings\/access\/agent-reads"/);
  assert.ok(text(render(<AgentReadsLineView agentsMayRead chats={1} />)).includes('Read by 1 chat today'));
  const forbidden = render(<AgentReadsLineView agentsMayRead={false} chats={0} />);
  assert.ok(text(forbidden).includes('The sharer does not let agents read this'));
});

test('read by N chats counts chats, not reads; today starts at local midnight', () => {
  assert.equal(chatsThatRead([{ chatId: 'a' }, { chatId: 'a' }, { chatId: 'b' }]), 2);
  assert.equal(chatsThatRead([]), 0);
  const since = new Date(startOfToday(new Date(2026, 9, 17, 15, 42)));
  assert.deepEqual([since.getFullYear(), since.getMonth(), since.getDate(), since.getHours(), since.getMinutes()], [2026, 9, 17, 0, 0]);
});

test('whose copy: person, install and project from the catalog, the person alone for another share, null when unknown', () => {
  const shared = [copy()];
  assert.equal(teammateLabel(shared, 'ana-endpoint-0123456789', 's1'), 'Ana · laptop · api');
  assert.equal(teammateLabel(shared, 'ana-endpoint-0123456789', null), 'Ana · laptop');
  assert.equal(teammateLabel([copy({ ownerLabel: '' })], 'ana-endpoint-0123456789', 'other'), 'Ana');
  assert.equal(teammateLabel(shared, 'someone-else', 's1'), null);
});

test('Access & safety → Agent reads: a row per read with the chat, tool, copy and what; empty and loading states', () => {
  const html = render(
    <AgentReadsView
      reads={[read(), read({ id: 2, tool: 'collab_list_shared', kind: null, recordIds: [], owner: 'gone', shareKey: 'local/zz', shareId: 'zz' })]}
      shared={[copy()]}
      onRefresh={() => {}}
    />,
  );
  const words = text(html);
  // The section's heading or the detail's title names it; the table keeps the name for a reader
  assert.match(html, /<table class="table" aria-label="Read by agents">/);
  assert.match(html, /href="\/chats\/chat-aaaaaaaa-1111"/);
  assert.ok(words.includes('collab_read_transcript'));
  assert.ok(words.includes('Ana · laptop · api'));
  assert.ok(words.includes('1 record'));
  assert.ok(words.includes('List of shared projects'));
  assert.ok(words.includes('No longer shared'));
  assert.equal((html.match(/<tr>/g) ?? []).length, 3);

  const empty = text(render(<AgentReadsView reads={[]} shared={[]} />));
  assert.ok(empty.includes('No agent has read what teammates share'));
  assert.doesNotMatch(render(<AgentReadsView reads={undefined} shared={[]} />), /<table/);
});

test('Spanish: the switches, the chip and the line in the glossary words', async () => {
  await i18n.changeLanguage('es');
  assert.ok(text(render(<TeammateReadsTag scope={{ kind: 'assistant' }} />)).includes('Lee lo que comparten tus compañeros'));
  assert.ok(text(render(<AgentReadsLineView agentsMayRead chats={2} />)).includes('Lo han leído 2 chats hoy'));
  const html = text(sharingHtml(sharing()));
  assert.ok(html.includes('Los agentes de tus compañeros pueden leerlo'));
  assert.ok(html.includes('Sin comprobar permisos'));
});
