// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import type { ChatChildren, ChatSubagent, IssueRef } from '@claudio/shared';
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
import { FileMap, type MapFile } from '../src/components/changes/FileMap';
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

test('a name given in words of its own holds the words the control shows, in both languages', () => {
  // [what the control shows, what names it, its values]
  const pairs: Array<[string, string, Record<string, unknown>]> = [
    ['projects:worktrees.newChatHere', 'projects:worktrees.newChatIn', { name: 'e2e-a11y' }],
    ['home:settings.memory.open', 'home:settings.memory.openNamed', { name: 'e2e-a11y' }],
    ['schedules:card.runNow', 'schedules:card.runNowNamed', { name: 'e2e nightly check' }],
    ['config:mcp.editInUser', 'config:mcp.editInUserNamed', { name: 'github' }],
    ['assistant:proposal.undo', 'assistant:proposal.undoNamed', { name: 'qa.md' }],
    ['terminal:bar.label', 'terminal:bar.item', { count: 1 }],
  ];
  // The keys are listed as plain strings, which the typed `t` does not take
  const t = i18n.t.bind(i18n) as unknown as (key: string, values?: Record<string, unknown>) => string;
  for (const lang of ['en', 'es'] as const) {
    setLanguage(lang);
    for (const [shown, named, values] of pairs) {
      let visible = t(shown);
      // The Terminal item shows its count after its word
      if (named === 'terminal:bar.item') visible = `${visible} 1`;
      const name = t(named, values);
      assert.ok(holdsWords(name, visible), `${lang}: "${name}" should hold "${visible}"`);
    }
  }
});
