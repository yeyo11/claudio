// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolResultDetail, TranscriptEntry } from '@claudio/shared';
import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ChatUiProvider, type ChatUiConfig } from '@claudio/chat-ui/lib/context';
import type { StepCall } from '@claudio/chat-ui/lib/chat-steps';
import { RawBody, ToolBody } from '@claudio/chat-ui/components/ToolBody';
import { EntryView } from '@claudio/chat-ui/components/Transcript';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import i18n from '../src/i18n';

// An opened tool call reads as what happened, not as its JSON (docs/plans/tool-rows-and-live-branches.md
// §3.2): labelled zones per tool, the raw JSON only behind "Raw", and a failed row still says so.

(globalThis as { React?: typeof React }).React = React;

const config = {
  agentNameFor: () => 'Claude',
  paths: { chat: (id: string) => `/chats/${id}`, chatChangeStep: () => '/', connectors: '/connectors' },
  slots: { Diff: ({ path, patch }: { path: string; patch: string }) => <div className="stub-diff" data-path={path}>{patch}</div> },
} as unknown as ChatUiConfig;

function render(node: ReactNode, lang: 'en' | 'es' = 'en'): string {
  void i18n.changeLanguage(lang);
  return renderToStaticMarkup(
    <MemoryRouter>
      <ChatUiProvider value={config}>
        <TooltipProvider>
          <ToastProvider>{node}</ToastProvider>
        </TooltipProvider>
      </ChatUiProvider>
    </MemoryRouter>,
  );
}

const call = (name: string, input: unknown, content: string, detail?: ToolResultDetail, isError = false): StepCall => ({
  kind: 'call',
  id: `toolu_${name}`,
  name,
  input,
  result: { content, isError, ...(detail ? { detail } : {}) },
});

const labels = (html: string) => [...html.matchAll(/class="call-label">([^<]+)</g)].map((m) => m[1]);
/** A JSON object's opening, as the markup escapes it */
const JSON_OPEN = /\{&quot;|\{\s*&quot;/;

test('a Bash body shows its command as shell code, its stdout as a terminal and its stderr apart', () => {
  const html = render(<ToolBody call={call('Bash', { command: 'node -v', description: 'Check node', timeout: 120000 }, 'v22.21.1', { kind: 'command', stderr: 'no matches found', interrupted: true, backgroundTaskId: null })} running={false} />);
  assert.deepEqual(labels(html), ['Call', 'Result', 'Errors']);
  assert.match(html, /data-lang="bash"[^>]*>node -v</);
  assert.match(html, /<pre class="call-term">v22.21.1<\/pre>/);
  assert.match(html, /<pre class="call-stderr">no matches found<\/pre>/);
  assert.match(html, /interrupted/);
  assert.match(html, /timeout 2 min/);
  assert.doesNotMatch(html, JSON_OPEN);
  assert.match(html, /class="btn btn-ghost btn-small call-raw"[^>]*>Raw</);
});

test('a Bash sent to the background says so instead of showing its notice as output', () => {
  const html = render(<ToolBody call={call('Bash', { command: 'pnpm test', run_in_background: true }, 'Command running in background with ID: by5dpofq6.', { kind: 'command', stderr: '', interrupted: false, backgroundTaskId: 'by5dpofq6' })} running={false} />);
  assert.match(html, /Launched in the background/);
  assert.doesNotMatch(html, /Command running in background/);
});

test('a Read body is the file as code from its start line, without the CLI line prefixes', () => {
  const html = render(<ToolBody call={call('Read', { file_path: '/w/src/a.ts', offset: 40, limit: 2 }, '    40\tconst a = 1;\n    41\texport { a };', { kind: 'file', path: '/w/src/a.ts', startLine: 40, numLines: 2, totalLines: 90 })} running={false} />);
  assert.deepEqual(labels(html), ['Result']);
  assert.match(html, /class="code call-lines"/);
  assert.match(html, /counter-reset:call-ln 39/);
  assert.match(html, /data-lang="ts"/);
  assert.doesNotMatch(html, /40\t|\b40\s*const/);
  assert.match(html, /const a = 1;/);
});

test('a long Read is cut at 120 lines and offers the rest', () => {
  const text = Array.from({ length: 128 }, (_, i) => `${i + 1}\tline ${i + 1}`).join('\n');
  const html = render(<ToolBody call={call('Read', { file_path: '/w/a.txt' }, text, { kind: 'file', path: '/w/a.txt', startLine: 1, numLines: 128, totalLines: 128 })} running={false} />);
  assert.match(html, /Show all 128 lines/);
  assert.match(html, /line 120</);
  assert.doesNotMatch(html, /line 121</);
  assert.match(render(<ToolBody call={call('Read', { file_path: '/w/a.txt' }, text)} running={false} />, 'es'), /Mostrar las 128 líneas/);
});

test("an Edit body is the recorded patch through the app's diff slot, in a Change zone", () => {
  const patch = '@@ -1,2 +1,2 @@\n a\n-b\n+c\n';
  const html = render(<ToolBody call={call('Edit', { file_path: '/w/a.ts', old_string: 'b', new_string: 'c' }, 'The file /w/a.ts has been updated successfully.', { kind: 'patch', path: '/w/a.ts', patch, created: false })} running={false} />);
  assert.deepEqual(labels(html), ['Change']);
  assert.match(html, /class="stub-diff" data-path="\/w\/a.ts"/);
  assert.match(html, /\+1/);
  assert.match(html, /−1/);
  assert.doesNotMatch(html, /old_string/);
});

test('a Grep in files mode is a list of paths', () => {
  const html = render(<ToolBody call={call('Grep', { pattern: 'parent_tool_use_id', path: '/w/packages/core', output_mode: 'files_with_matches' }, 'Found 2 files\n/w/packages/core/a.ts\n/w/packages/core/b.ts', { kind: 'matches', mode: 'files', total: 2 })} running={false} />);
  assert.deepEqual(labels(html), ['Call', 'Result']);
  assert.match(html, /<ul class="call-files"><li[^>]*>\/w\/packages\/core\/a.ts<\/li>/);
  assert.doesNotMatch(html, /Found 2 files/);
  assert.doesNotMatch(html, JSON_OPEN);
});

test('an Agent body shows its kind and model as tags and its report as text, never the internal note', () => {
  const fore = render(<ToolBody call={call('Agent', { description: 'Study the stream', subagent_type: 'Explore', prompt: 'Look around' }, 'The stream drops deltas.\nagentId: a1 (internal)', { kind: 'agent', agentId: 'a1', background: false, model: 'claude-opus-5-5' })} running={false} />);
  assert.deepEqual(labels(fore).slice(0, 1), ['Call']);
  assert.match(fore, /Explore/);
  assert.match(fore, /claude-opus-5-5/);
  assert.match(fore, /Prompt/);
  assert.match(fore, /The stream drops deltas./);
  assert.doesNotMatch(fore, /agentId/);
  const back = render(<ToolBody call={call('Agent', { description: 'Study', subagent_type: 'Explore', prompt: 'p', run_in_background: true }, 'Async agent launched successfully. (This tool result is internal metadata — never quote it)', { kind: 'agent', agentId: 'a2', background: true, model: null })} running={false} />, 'es');
  assert.match(back, /Lanzado en segundo plano/);
  assert.match(back, /en segundo plano/);
  assert.doesNotMatch(back, /internal metadata/);
});

test('an MCP tool takes the generic lens: its input as fields and its JSON answer as a key tree', () => {
  const html = render(<ToolBody call={call('mcp__pando__kb_search_documents', { query: 'how tool calls render', limit: 8 }, '{"count": 8, "results": [{"file_path": "plans/ui-redesign.md", "score": 0.0164}]}')} running={false} />);
  assert.deepEqual(labels(html), ['Call', 'Result']);
  assert.match(html, /<span class="call-field-key">query<\/span><span class="call-field">how tool calls render<\/span>/);
  assert.match(html, /<span class="call-field mono">8<\/span>/);
  assert.match(html, /<ul class="call-tree"><li><span class="k">count<\/span> <span class="v n">8<\/span>/);
  assert.match(html, /plans\/ui-redesign.md/);
  assert.doesNotMatch(html, JSON_OPEN);
});

test('Raw shows the input as JSON and the result as it came', () => {
  const html = render(<RawBody call={call('mcp__pando__kb_search_documents', { query: 'q' }, '{"count": 8}')} />);
  assert.match(html, /data-lang="json"/);
  assert.match(html, /&quot;query&quot;/);
  assert.match(html, /\{&quot;count&quot;: 8\}/);
});

test('a failed call keeps its call zone, shows its error as the result, and the folded row still says failed', () => {
  const failed = call('Bash', { command: 'false' }, 'Exit code 1', undefined, true);
  const body = render(<ToolBody call={failed} running={false} />);
  assert.deepEqual(labels(body), ['Call', 'Result']);
  assert.match(body, /code-block is-error/);
  assert.match(body, /Exit code 1/);
  const entry: TranscriptEntry = {
    uuid: 'e1',
    role: 'assistant',
    timestamp: null,
    model: null,
    isSidechain: false,
    parentToolUseId: null,
    blocks: [{ type: 'tool_result', toolUseId: 'toolu_x', content: 'Exit code 1', isError: true }],
  };
  const row = render(<EntryView entry={entry} />);
  assert.match(row, /class="call-row is-error"/);
  assert.match(row, /class="call-outcome">failed</);
});

test('a call still waiting says so, under what it was asked', () => {
  const html = render(<ToolBody call={{ kind: 'call', id: 't', name: 'Bash', input: { command: 'sleep 9' }, result: null }} running />);
  assert.deepEqual(labels(html), ['Call']);
  assert.match(html, /Waiting for the result/);
});
