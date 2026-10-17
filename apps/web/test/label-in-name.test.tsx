// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import type { ChatChildren, ChatSubagent, IssueRef, ProviderLimit, ProviderStatus } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import type { ReactNode } from 'react';
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { BRANCHES_STORAGE_KEY, LiveBranches } from '@claudio/chat-ui/components/LiveBranches';
import { StatusChips } from '@claudio/chat-ui/composer/Composer';
import { ChatUiProvider, type ChatUiConfig } from '@claudio/chat-ui/lib/context';
import { nameFromContent } from '@claudio/ui/components/controls/Select';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { keys } from '../src/api';
import { FileMap, type MapFile } from '../src/components/changes/FileMap';
import { ProviderDots } from '../src/components/shell/ProviderDots';
import i18n, { setLanguage } from '../src/i18n';
import { AssigneeMark } from '../src/pages/tasks/item/fields';
import { IssueChips } from '../src/pages/tasks/item/Issues';
import { Value } from '../src/pages/tasks/item/Properties';
import { controls, holdsWords, labelMismatches } from './accessible-name';

// WCAG 2.5.3, Label in Name, as axe-core 4.14 checks it (`label-content-name-mismatch`): a control
// named in words of its own must hold the words it shows, so a voice user can say what they see.
// Each test covers a control the e2e accessibility scans found breaking it.

// tsx compiles the packages' files with the classic runtime too, and they do not import React
(globalThis as { React?: typeof React }).React = React;

afterEach(() => setLanguage('en'));

const config = { agentNameFor: () => 'Claude', paths: { chat: (id: string) => `/chats/${id}`, chatChangeStep: () => '/', connectors: '/connectors' } } as unknown as ChatUiConfig;

function render(node: ReactNode, lang: 'en' | 'es' = 'en'): string {
  setLanguage(lang);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ChatUiProvider value={config}>
          <TooltipProvider>
            <ToastProvider>{node}</ToastProvider>
          </TooltipProvider>
        </ChatUiProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('the composer status line is named by the chips it shows, read apart, after what it opens', () => {
  for (const lang of ['en', 'es'] as const) {
    setLanguage(lang);
    const words = ['workspace', 'default model', 'default mode (Accept edits)'];
    const label = i18n.t('chats:new.options');
    const html = render(
      <button type="button" className="composer-status">
        <StatusChips label={label} words={words} accent={-1} />
      </button>,
      lang,
    );
    assert.deepEqual(labelMismatches(html), [], lang);
    const [button] = controls(html);
    // A name of its own words would still say a chip a phone hides; the chips themselves do not
    assert.doesNotMatch(html, /class="composer-status" aria-label=/, lang);
    assert.equal(button?.name, `${label}: workspace default model default mode (Accept edits)`, lang);
    assert.equal(button?.visible, 'workspace default model default mode (Accept edits)', lang);
  }
});

test('an issue chip is named by its key and sync word, then where it leads', () => {
  const issue: IssueRef = {
    tracker: 'github-issues', key: '14', scope: 'acme/shop', externalId: null, title: 'Project templates', state: 'open', url: 'https://github.com/acme/shop/issues/14',
    importedAt: '2026-10-01T09:00:00Z', syncedAt: null, syncState: 'failed', syncReason: null,
  };
  for (const lang of ['en', 'es'] as const) {
    const html = render(<IssueChips item={{ issues: [issue] }} />, lang);
    assert.deepEqual(labelMismatches(html), [], lang);
    const [link] = controls(html).filter((c) => c.role === 'link');
    assert.ok(link, lang);
    assert.match(link.name, /^#14 \S+ \(.+\)$/, `${lang}: ${link.name}`);
    assert.ok(holdsWords(link.name, link.visible), `${lang}: "${link.name}" holds "${link.visible}"`);
  }
});

test("a file map row is named by its file's name, its status letter and counts said in words", () => {
  const files: MapFile[] = [
    { file: { path: 'src/greet.ts', status: 'modified', additions: 3, deletions: 1 }, uncommitted: false, seen: true, live: false },
    { file: { path: 'fresh.ts', status: 'added', additions: 9, deletions: 0 }, uncommitted: true, seen: false, live: false },
  ];
  const html = render(
    <FileMap
      files={files}
      current="fresh.ts"
      to={(path) => `/changes?file=${path}`}
      filter=""
      onFilter={() => {}}
      filterRef={createRef<HTMLInputElement>()}
      folded={false}
      seenCount={1}
      total={2}
      onPointer={() => {}}
    />,
  );
  assert.deepEqual(labelMismatches(html), []);
  const rows = controls(html).filter((c) => c.className.startsWith('changes-file'));
  assert.deepEqual(
    rows.map((r) => r.name),
    ['greet.ts · modified · seen', 'fresh.ts · added · Not committed yet'],
  );
  assert.doesNotMatch(html, /class="changes-file[^"]*"[^>]*aria-label=/, 'a row is named by what it shows, not by a label of its own');
});

test('a property is named by its field and then the value it shows, the avatar left out', () => {
  for (const lang of ['en', 'es'] as const) {
    setLanguage(lang);
    const field = i18n.t('workItem:fields.assignee');
    const html = render(
      <Value field={field}>
        <AssigneeMark assignee={{ kind: 'role', role: 'developer' }} person="Ana" />
        <span>Developer</span>
      </Value>,
      lang,
    );
    assert.deepEqual(labelMismatches(html), [], lang);
    const [button] = controls(html);
    assert.equal(button?.name, `${field}: Developer`, lang);
  }
});

test('a running branch row is named by what it shows, and a nested one says whose it is', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const sub = (over: Partial<ChatSubagent>): ChatSubagent => ({
    id: 'agent-1', sessionId: 'chat-1', kind: 'Explore', description: 'Survey the build scripts', status: 'running', startedAt: ago(42_000), endedAt: null,
    lastActivityAt: null, cwd: null, tasks: [], activity: null, ...over,
  });
  const branches: ChatChildren = {
    subagents: [
      sub({
        tasks: [{ id: 'n', kind: 'local_bash', description: 'Watch the build', command: 'pnpm build --watch', status: 'running', startedAt: ago(9000), endedAt: null, summary: null, byPerson: false, ownerId: 'agent-1' }],
      }),
    ],
    backgroundTasks: [],
    workflows: [],
  };
  const holder = globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem'> };
  const before = holder.localStorage;
  holder.localStorage = { getItem: (key) => (key === BRANCHES_STORAGE_KEY ? 'open' : null), setItem: () => {} };
  try {
    for (const lang of ['en', 'es'] as const) {
      const html = render(<LiveBranches branches={branches} onOpen={() => {}} />, lang);
      assert.deepEqual(labelMismatches(html), [], lang);
      assert.doesNotMatch(html, /class="chat-branch-row[^"]*" aria-label=/, lang);
      const rows = controls(html).filter((c) => c.className.startsWith('chat-branch-row'));
      assert.equal(rows.length, 2, lang);
      const [owner, nested] = rows;
      assert.match(owner?.name ?? '', /Survey the build scripts/, lang);
      assert.match(nested?.name ?? '', new RegExp(`${i18n.t('chat:branches.nested', { owner: 'Survey the build scripts' })}$`), lang);
    }
  } finally {
    holder.localStorage = before;
  }
});

test('an option with a hint is named by all it shows, not by its label alone', () => {
  assert.deepEqual(nameFromContent('/tmp/workspace/shop'), { 'aria-labelledby': undefined });
  assert.deepEqual(nameFromContent(undefined), {}, 'without a hint Radix names it by the label it shows');
});

test("a provider's status bar item is named by what it shows: state, percent and when it resumes", () => {
  const status = (over: Partial<ProviderStatus>): ProviderStatus => ({
    id: 'claude-code', label: 'Claude Code', state: 'degraded', reason: 'limit-reached', version: '2.1.282', compatibleRange: '>=2.1 <3', binaryPath: '/usr/local/bin/x',
    configHome: null, account: null, capabilities: ['rateLimitWindows'], checkedAt: '2026-10-02T10:00:00Z', ...over,
  });
  const limit = (over: Partial<ProviderLimit>): ProviderLimit => ({
    provider: 'claude-code', state: 'exhausted', window: '5h', utilization: 1, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(), windows: {},
    observedAt: new Date(Date.now() - 120_000).toISOString(), source: 'stream', ...over,
  });
  for (const lang of ['en', 'es'] as const) {
    for (const [s, l] of [
      [status({}), limit({})],
      [status({ reason: 'limit-near' }), limit({ state: 'near', utilization: 0.72 })],
    ] as const) {
      setLanguage(lang);
      const client = new QueryClient();
      client.setQueryData(keys.providers, [s]);
      client.setQueryData(keys.providerSettings, { providers: { 'claude-code': { enabled: true, binaryPath: null } }, order: ['claude-code'], defaultProvider: null });
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <TooltipProvider>
              <ProviderDots limits={[l]} />
            </TooltipProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      assert.deepEqual(labelMismatches(html), [], lang);
      const [item] = controls(html).filter((c) => c.className.startsWith('statusbar-item'));
      assert.ok(item, lang);
      assert.equal(item.name, item.visible, `${lang}: named by what it shows`);
      assert.doesNotMatch(item.name, /Claude Code ·\S/, `${lang}: words stay apart`);
    }
  }
});

test('a name given in words of its own holds the words the control shows, in both languages', () => {
  // [what names it, what the control shows, its values]: every button and link in the app whose
  // aria-label goes beside a visible word of its own
  const pairs: Array<[string, string, Record<string, unknown>?]> = [
    ['projects:worktrees.newChatIn', 'projects:worktrees.newChatHere'],
    ['home:settings.memory.openNamed', 'home:settings.memory.open'],
    ['schedules:card.runNowNamed', 'schedules:card.runNow'],
    ['config:mcp.editInUserNamed', 'config:mcp.editInUser'],
    ['assistant:proposal.undoNamed', 'assistant:proposal.undo'],
    ['orchestrationV2:templates.launchNamed', 'orchestrationV2:templates.launch'],
    ['setup:row.signInAria', 'setup:row.signIn'],
    ['setup:signOut.aria', 'setup:signOut.action'],
    ['chats:bulk.clear', 'chats:bulk.cancel'],
    ['chats:new.start', 'chat:newChat.start'],
    ['connectors:ask.named', 'connectors:ask.try', { action: 'Summarise the inbox', connector: 'Gmail' }],
    ['connectors:authorise.named', 'connectors:authorise.action', { connector: 'Gmail' }],
    ['projects:candidates.importNamed', 'projects:importForm.import'],
    ['projects:card.openNamed', 'common:actions.open'],
    ['projects:head.assistantOf', 'projects:head.assistant'],
    ['accountsConfig:card.signInAgainFor', 'accountsConfig:card.signInAgain'],
    ['assistant:proposal.discardNamed', 'assistant:proposal.discard'],
    ['assistant:proposal.acceptNamed', 'assistant:proposal.accept'],
    ['assistant:resources.reviewNamed', 'assistant:resources.review'],
    ['chat:side.workItem.openLabel', 'chat:side.workItem.open', { key: 'AGN-1' }],
    ['collaborators:sharedWithYou.openIn', 'collaborators:sharedWithYou.open', { project: 'shop' }],
    ['collaborators:sharedWithYou.openReadOnly', 'collaborators:sharedWithYou.open', { project: 'shop' }],
    ['decisions:consent.withdrawPoint', 'decisions:consent.withdrawAction', { point: 'triage' }],
    ['config:mcp.editNamed', 'config:shared.edit'],
    ['config:mcp.removeNamed', 'common:actions.remove'],
    ['config:notifications.devices.testNamed', 'config:notifications.devices.test'],
    ['config:notifications.devices.removeNamed', 'config:notifications.devices.remove'],
    ['config:plugins.detailsOf', 'config:plugins.details'],
    ['config:plugins.uninstallNamed', 'config:plugins.uninstall'],
    ['config:plugins.updateNamed', 'config:plugins.update'],
    ['config:plugins.removeNamed', 'common:actions.remove'],
    ['config:plugins.installNamed', 'config:plugins.install'],
    ['config:plugins.installedNamed', 'config:plugins.installedButton'],
    ['config:toolPresets.editNamed', 'config:shared.edit'],
    ['config:toolPresets.removeNamed', 'common:actions.remove'],
    ['config:resourcesAi.discardName', 'config:resourcesAi.discard'],
    ['config:resourcesAi.reviewName', 'config:resourcesAi.review'],
    ['home:edit.addNamed', 'home:edit.addShort', { title: 'Usage' }],
    ['tasks:suggest.discardTitle', 'tasks:suggest.discard', { title: 'Fix the cart' }],
    ['chat:attachments.attachFiles', 'chat:attachments.attach'],
    ['chat:branches.open', 'chat:branches.openButton', { what: 'Survey the build' }],
  ];
  // The keys are listed as plain strings, which the typed `t` does not take
  const t = i18n.t.bind(i18n) as unknown as (key: string, values?: Record<string, unknown>) => string;
  for (const lang of ['en', 'es'] as const) {
    setLanguage(lang);
    for (const [named, shown, values] of pairs) {
      assert.ok(i18n.exists(named) && i18n.exists(shown), `${named} and ${shown} exist`);
      const visible = t(shown, values);
      const name = t(named, { name: 'shop', ...values });
      assert.ok(holdsWords(name, visible), `${lang}: "${name}" should hold "${visible}"`);
    }
    // Words drawn beside a count: the Terminal item, the checklist in a chat's head, the live rail
    assert.ok(holdsWords(t('terminal:bar.item', { count: 2 }), `${t('terminal:bar.label')} 2`), lang);
    assert.ok(holdsWords(t('chat:head.checklist', { progress: '1/3 · x' }), '1/3'), lang);
    assert.ok(holdsWords(t('shell:live.chipLabel', { count: 12, summary: 'x' }), '12'), lang);
  }
});
