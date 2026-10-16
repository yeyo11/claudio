// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Chat, ChatContextUsage, CompactRefusal, ContextBreakdown, LiveMcpServer } from '@claudio/shared';
import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { setLanguage } from '../src/i18n';
import { CompactButton, ContextPanelBody, type ContextPanelBodyProps } from '../src/pages/chat/ContextPanel';
import { categoryGroups, compactState, maskSecrets, middleCut, shareText } from '../src/pages/chat/context-model';

// The panel and the Compact now button, state by state (docs/plans/context-control.md, "States").
// The overlays' own states (Dialog / Sheet, the stack) belong to the e2e spec.

(globalThis as { React?: typeof React }).React = React;

function render(node: ReactNode, lang: 'en' | 'es' = 'en'): string {
  // Sets the number format as well as the words: lib/format follows the stored language, not i18next
  setLanguage(lang);
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

const chatWith = (over: Record<string, unknown> = {}): Chat =>
  ({
    id: 'c1',
    state: 'idle',
    execution: { pid: 1 },
    control: { mode: 'interactive' },
    context: { used: 142_000, window: 200_000 },
    compact: { available: true, refusal: null, open: null },
    ...over,
  }) as unknown as Chat;

const breakdown = (over: Partial<ContextBreakdown> = {}): ContextBreakdown => ({
  model: 'claude-sonnet-5-5',
  totalTokens: 142_000,
  rawMaxTokens: 200_000,
  maxTokens: 200_000,
  percentage: 71,
  autoCompact: { enabled: true, thresholdTokens: 184_000 },
  overBy: null,
  categories: [
    { name: 'System prompt', key: 'system-prompt', kind: 'used', tokens: 8_000 },
    { name: 'Messages', key: 'messages', kind: 'used', tokens: 120_000 },
    { name: 'Brand new category', key: null, kind: 'used', tokens: 14_000 },
    { name: 'Free space', key: 'free-space', kind: 'free', tokens: 58_000 },
    { name: 'MCP tools (deferred)', key: 'mcp-tools-deferred', kind: 'deferred', tokens: 9_000 },
  ],
  mcp: {
    servers: [
      { server: 'github', tools: 60, loadedTools: 60, tokens: 21_000 },
      { server: 'fs', tools: 33, loadedTools: 33, tokens: 9_000 },
    ],
    loadedTools: 93,
    tokens: 30_000,
    share: 0.27,
    warnings: ['many-tools', 'large-share'],
  },
  memoryFiles: [{ path: '/home/user/projects/claudio/docs/some/very/deeply/nested/directory/CLAUDE.md', type: 'Project', tokens: 2_100 }],
  agents: [{ name: 'reviewer', source: 'project', tokens: 300 }],
  skills: { total: 10, included: 8, tokens: 1_200 },
  slashCommands: { total: 40, included: 40, tokens: 900 },
  messages: { toolCalls: 10_000, toolResults: 50_000, attachments: 0, assistant: 30_000, user: 20_000, other: 10_000 },
  ...over,
});

const usage = (over: Partial<ChatContextUsage> = {}): ChatContextUsage => ({
  live: true,
  unreported: null,
  detail: 'summary',
  observedAt: '2026-10-16T10:00:00.000Z',
  snapshot: { used: 142_000, window: 200_000 },
  breakdown: breakdown(),
  ...over,
});

const body = (over: Partial<ContextPanelBodyProps> = {}, lang: 'en' | 'es' = 'en') =>
  render(
    <ContextPanelBody
      chat={chatWith()}
      usage={usage()}
      loading={false}
      error={null}
      detail="summary"
      servers={undefined}
      switching={false}
      onToggle={() => undefined}
      onExact={() => undefined}
      onRetry={() => undefined}
      {...over}
    />,
    lang,
  );

const live = (name: string, status: LiveMcpServer['status'] = 'connected'): LiveMcpServer =>
  ({ name, label: name, kind: 'server', status, scope: null, tools: [], error: null }) as LiveMcpServer;

test('loading: skeleton rows, nothing invented', () => {
  const html = body({ usage: undefined, loading: true });
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /ctx-table/);
});

test('a chat that never answered: no panel content, the words for it', () => {
  const html = body({ chat: chatWith({ context: null }), usage: usage({ snapshot: null, breakdown: null, unreported: 'no-process', live: false }) });
  assert.match(html, /No context yet/);
  assert.doesNotMatch(html, /ctx-table/);
});

test('idle with a live process: categories as a captioned table, shares, the exact count on offer', () => {
  const html = body();
  assert.match(html, /<caption class="sr-only">What fills the context window, by category<\/caption>/);
  assert.match(html, /System prompt/);
  assert.match(html, /142,000 of 200,000 tokens/);
  assert.match(html, /claude-sonnet-5-5/);
  // 120,000 / 200,000
  assert.match(html, /60 %/);
  assert.match(html, /Counted by estimate/);
  assert.match(html, /Count exactly/);
  assert.doesNotMatch(html, /aria-description="The exact count/);
});

test('a category Claudio has no key for is shown as the CLI wrote it, in mono; free space is last and muted', () => {
  const html = body();
  assert.match(html, /<span class="mono">Brand new category<\/span>/);
  assert.ok(html.indexOf('Free space') > html.indexOf('Brand new category'));
  assert.match(html, /<tr class="is-muted"><th scope="row">Free space/);
});

test('deferred rows sit in their own group, outside every share', () => {
  const html = body();
  const at = html.indexOf('Outside the window');
  assert.ok(at > 0);
  assert.match(html.slice(at), /MCP tools \(deferred\)/);
  // the deferred row carries no share
  assert.match(html.slice(at), /<td class="mono num">—<\/td>/);
  const groups = categoryGroups(breakdown().categories);
  assert.deepEqual(groups.deferred.map((c) => c.name), ['MCP tools (deferred)']);
  assert.equal(groups.used.length, 3);
});

test('MCP warnings are a tag with the triangle and the words', () => {
  const html = body();
  assert.match(html, /badge-warn/);
  assert.match(html, /<svg[^>]*aria-hidden/);
  assert.match(html, /Many MCP tools \(93\)/);
  assert.match(html, /MCP takes 27 % of the context/);
  assert.doesNotMatch(body({ usage: usage({ breakdown: breakdown({ mcp: { ...breakdown().mcp, warnings: [] } }) }) }), /Many MCP tools/);
});

test('servers: one row each, a switch for each when the chat is live, the rest of a long list folded', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ server: `s${i}`, tools: 2, loadedTools: 2, tokens: 100 - i }));
  const html = body({ servers: many.map((s) => live(s.server)), usage: usage({ breakdown: breakdown({ mcp: { ...breakdown().mcp, servers: many } }) }) });
  // Twelve in the list; the other three are behind the fold, which stays closed until opened
  assert.equal((html.match(/class="ctx-server"/g) ?? []).length, 12);
  assert.match(html, /3 more servers/);
  assert.equal((html.match(/role="switch"/g) ?? []).length, 12);
  assert.match(html, /new chats here start with it too/);
  // no live process behind the numbers: no switch
  assert.doesNotMatch(body(), /role="switch"/);
});

test('a switched-off server reads as off in its label', () => {
  const html = body({ servers: [live('github', 'disabled'), live('fs')] });
  assert.match(html, /aria-label="Turn github on"/);
  assert.match(html, /aria-label="Turn fs off"/);
});

test('memory paths are cut in the middle, whole in the title and in the copy label', () => {
  const html = body();
  const path = '/home/user/projects/claudio/docs/some/very/deeply/nested/directory/CLAUDE.md';
  assert.match(html, /\/home\/user\/projects[^<]*…[^<]*CLAUDE\.md/);
  assert.ok(html.includes(`title="${path}"`));
  assert.ok(html.includes(`aria-label="Copy ${path}"`));
  assert.equal(middleCut('/a/b'), '/a/b');
  assert.ok(middleCut(path).length <= 52);
});

test('working: the breakdown stays, the exact count is disabled with its reason', () => {
  const html = body({ chat: chatWith({ state: 'working' }) });
  assert.match(html, /aria-disabled="true"[^>]*aria-description="The exact count waits until the chat is idle\."/);
  assert.match(html, /System prompt/);
});

test('an exact count says so and offers no second one', () => {
  const html = body({ usage: usage({ detail: 'full' }) });
  assert.match(html, /Counted exactly/);
  assert.doesNotMatch(html, /Count exactly/);
});

test('no process: the snapshot and the sentence that says where the breakdown comes from', () => {
  const html = body({ usage: usage({ live: false, unreported: 'no-process', breakdown: null }) });
  assert.match(html, /142,000 of 200,000 tokens/);
  assert.match(html, /comes from the agent while the conversation is open/);
  assert.doesNotMatch(html, /ctx-table|Retry/);
});

test('unsupported and refused: the snapshot and one sentence, no retry; a timeout may retry', () => {
  for (const unreported of ['unsupported', 'refused'] as const) {
    const html = body({ usage: usage({ unreported, breakdown: null }) });
    assert.match(html, /last count from the transcript/);
    assert.doesNotMatch(html, /Retry/);
  }
  const timeout = body({ usage: usage({ unreported: 'timeout', breakdown: null }) });
  assert.match(timeout, /did not answer in time/);
  assert.match(timeout, /Retry/);
});

test('an HTTP error is an alert, with a retry', () => {
  const html = body({ usage: undefined, error: new Error('boom') });
  assert.match(html, /role="alert"/);
  assert.match(html, /boom/);
  assert.match(html, /Retry/);
});

test('auto-compaction is a tick on the bar and the same fact in words; off says so', () => {
  const html = body();
  assert.match(html, /class="bar-mark" aria-hidden="true" style="left:92%"/);
  assert.match(html, /compacts by itself at 92 %/);
  const off = body({ usage: usage({ breakdown: breakdown({ autoCompact: { enabled: false, thresholdTokens: null } }) }) });
  assert.doesNotMatch(off, /bar-mark/);
  assert.match(off, /Automatic compaction is off/);
});

test('over the window: a full, bad bar and the words for how far', () => {
  const html = body({ usage: usage({ breakdown: breakdown({ totalTokens: 215_000, overBy: 15_000 }) }) });
  assert.match(html, /meter-fill is-bad" style="width:100%"/);
  assert.match(html, /15,000 tokens over the window/);
});

test('tone follows the design system: neutral below 60 %, warn from 60, bad from 75', () => {
  const tone = (totalTokens: number) => body({ usage: usage({ breakdown: breakdown({ totalTokens }) }) });
  assert.match(tone(100_000), /class="meter-fill" style="width:50%"/);
  assert.match(tone(120_000), /meter-fill is-warn/);
  assert.match(tone(150_000), /meter-fill is-bad/);
});

test('an unknown window: tokens only, no bar, no share', () => {
  const html = body({ usage: usage({ breakdown: breakdown({ rawMaxTokens: 0, maxTokens: 0 }) }) });
  assert.match(html, /142,000 tokens/);
  assert.match(html, /no share to draw/);
  assert.doesNotMatch(html, /role="meter"/);
  assert.doesNotMatch(html, /bar-mark/);
});

test('a 1M window: grouped figures in the language, "<1 %" for what is small', () => {
  const big = usage({
    breakdown: breakdown({
      totalTokens: 967_248,
      rawMaxTokens: 1_000_000,
      categories: [{ name: 'System prompt', key: 'system-prompt', kind: 'used', tokens: 3_000 }],
    }),
  });
  assert.match(body({ usage: big }), /967,248 of 1,000,000 tokens/);
  assert.match(body({ usage: big }), /<td class="mono num">&lt;1 %<\/td>/);
  assert.match(body({ usage: big }, 'es'), /967\.248 de 1\.000\.000 tokens/);
  assert.equal(shareText(0, 1000, '<1 %'), '0 %');
  assert.equal(shareText(5, null, '<1 %'), null);
});

test('Spanish: translated names, the CLI threshold sentence, the unreported sentence', () => {
  const html = body({}, 'es');
  assert.match(html, /Mensajes/);
  assert.match(html, /compacta solo al 92 %/);
  assert.match(html, /Contado con estimación/);
  assert.match(html, /Contar con exactitud/);
  assert.match(body({ usage: usage({ live: false, unreported: 'no-process', breakdown: null }) }, 'es'), /El desglose lo da el agente mientras la conversación está abierta/);
});

// ---------- Compact now ----------

test('Compact now is offered when the chat says it is available, and never as the gradient', () => {
  const html = render(<CompactButton chat={chatWith()} onClick={() => undefined} />);
  assert.match(html, /Compact now/);
  assert.doesNotMatch(html, /aria-disabled/);
  assert.doesNotMatch(html, /btn-primary/);
});

test('every refusal disables the button, keeps it focusable and says why', () => {
  const codes: CompactRefusal[] = ['busy', 'waiting', 'open', 'read-only', 'housekeeping', 'at-limit', 'run', 'unsupported', 'no-history'];
  for (const refusal of codes) {
    const html = render(<CompactButton chat={chatWith({ compact: { available: false, refusal, open: null } })} onClick={() => undefined} />);
    assert.match(html, /aria-disabled="true"/, refusal);
    assert.match(html, /aria-description="[^"]{10,}"/, refusal);
    assert.doesNotMatch(html, /<button[^>]*disabled=""/, refusal);
  }
});

test('a read-only chat gives its own reason', () => {
  const chat = chatWith({ control: { mode: 'readOnly', reason: 'A terminal holds it', action: 'fork' }, compact: { available: false, refusal: 'read-only', open: null } });
  assert.match(render(<CompactButton chat={chat} onClick={() => undefined} />), /aria-description="A terminal holds it"/);
});

test('a compaction in progress: the braille spinner and "Compacting…", not clickable', () => {
  const open = { id: 'k', state: 'running' };
  const chat = chatWith({ compact: { available: false, refusal: 'open', open } });
  const html = render(<CompactButton chat={chat} onClick={() => undefined} />);
  assert.match(html, /Compacting…/);
  assert.match(html, /aria-disabled="true"/);
  assert.equal(compactState(chat).running, true);
  assert.match(render(<CompactButton chat={chat} onClick={() => undefined} />, 'es'), /Compactando…/);
});

test('a chat that never answered has nothing to compact', () => {
  const chat = chatWith({ context: null, compact: undefined });
  assert.deepEqual(compactState(chat), { available: false, refusal: 'no-history', running: false });
});

test('the journal prefill masks what looks like a secret', () => {
  const masked = maskSecrets('use sk-abcdefghijklmnopqrstuvwx and API_KEY=hunter2hunter2 with Bearer abcdefghijklmnop1234');
  assert.doesNotMatch(masked, /sk-abc|hunter2|abcdefghijklmnop1234/);
  assert.match(masked, /\[redacted\]/);
});
