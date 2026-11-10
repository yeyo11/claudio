// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AUTO_CANCEL_NOTICE_PREFIX, AUTO_HINT_PREFIX, CANCEL_NOTICE_PREFIX, CHAT_HINT_PREFIX, LIMIT_CONTINUE_TEXT, normalizeMessage, SUPERVISOR_HINT_PREFIX, AGENT_MESSAGE_PERSON_PREFIX, type TranscriptEntry } from '@claudio/shared';
import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ChatUiProvider, type ChatUiConfig } from '@claudio/chat-ui/lib/context';
import { transcriptRows, type TranscriptRow } from '@claudio/chat-ui/lib/chat-steps';
import { AgentDirectoryScope, RelayRow, type AgentDirectory } from '@claudio/chat-ui/components/AgentMessages';
import { EntryView, StepView } from '@claudio/chat-ui/components/Transcript';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { setLanguage } from '../src/i18n';

// How the messages between agents and Claudio's own read in a transcript (docs/plans/agent-messages.md,
// D5 and "Design"), drawn from the lines the CLI 2.1.319 recorded.

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/core/test/fixtures/agent-messages');

function recorded(name: string): TranscriptEntry[] {
  return readFileSync(join(fixtures, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => normalizeMessage(JSON.parse(line) as Record<string, unknown>))
    .filter((entry): entry is TranscriptEntry => entry !== null);
}

(globalThis as { React?: typeof React }).React = React;

const config = { agentNameFor: () => 'Claude', client: { contentUrl: () => '' }, paths: { chat: (id: string) => `/chats/${id}`, chatChangeStep: () => '/', connectors: '/connectors' } } as unknown as ChatUiConfig;

/** The lead's view: its subagent is known by its description and opens */
const LEAD: AgentDirectory = { name: (id) => (id === 'a0000000000000001' ? 'Ping-pong subagent task' : null), open: () => undefined };
/** The subagent's own drawer */
const SUBAGENT: AgentDirectory = { self: { id: 'a0000000000000001', name: 'Ping-pong subagent task' }, name: () => null };

function render(node: ReactNode, directory: AgentDirectory | null = LEAD, lang: 'en' | 'es' = 'es'): string {
  setLanguage(lang);
  return renderToStaticMarkup(
    <MemoryRouter>
      <ChatUiProvider value={config}>
        <TooltipProvider>
          <ToastProvider>
            <AgentDirectoryScope value={directory}>{node}</AgentDirectoryScope>
          </ToastProvider>
        </TooltipProvider>
      </ChatUiProvider>
    </MemoryRouter>,
  );
}

const only = (name: string): TranscriptEntry => {
  const entry = recorded(name)[0];
  assert.ok(entry, name);
  return entry;
};

const typed = (text: string, over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: 'u1',
  role: 'user',
  timestamp: '2026-11-10T10:00:00.000Z',
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks: [{ type: 'text', text }],
  ...over,
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test("a subagent's message to the lead is a card, sender → Principal, without the frame and not a bubble", () => {
  const html = render(<EntryView entry={only('lead-peer-from-subagent')} />);
  assert.match(html, /class="agent-msg"/);
  assert.doesNotMatch(html, /msg-user/);
  assert.doesNotMatch(html, /agent-message|Another Claude session/);
  assert.match(text(html), /Ping-pong subagent task .*Principal/);
  assert.match(html, /<button[^>]*class="link-btn agent-msg-name"[^>]*>Ping-pong subagent task<\/button>/, "the subagent's name opens it");
  assert.match(html, /ping from subagent/);
});

test('a hand-back says "Informe final" and shows the report', () => {
  const html = render(<EntryView entry={only('lead-handback')} />);
  assert.match(html, /Informe final/);
  assert.match(html, /7 launches seeded/);
  assert.doesNotMatch(html, /Subagent hand-back/);
  // A subagent the page does not know keeps the name the line gave
  assert.match(text(html), /general-purpose .*Principal/);
});

test("in the subagent's drawer, the lead's SendMessage reads Principal → the subagent, its own name plain", () => {
  const html = render(<EntryView entry={only('subagent-coordinator-lead')} />, SUBAGENT);
  assert.match(html, /class="agent-msg"/);
  assert.match(text(html), /Principal .*Ping-pong subagent task/);
  assert.doesNotMatch(html, /<button[^>]*agent-msg-name/);
  assert.match(html, /hello from lead/);
});

test("the person's message to a subagent is their bubble, headed Tú → the subagent, without the prefix", () => {
  const entry = typed(`${AGENT_MESSAGE_PERSON_PREFIX}\n\nCheck the lockfile first.`, { isSidechain: true, origin: { kind: 'coordinator', plugin: 'claudio-bridge' } });
  const html = render(<EntryView entry={entry} />, SUBAGENT);
  assert.match(html, /msg-user/);
  assert.match(text(html), /Tú .*Ping-pong subagent task/);
  assert.match(html, /Check the lockfile first\./);
  assert.doesNotMatch(html, /written to you directly/);
});

test('a bridge message is a system row with Claudio\'s mark, labelled automatic', () => {
  const html = render(<EntryView entry={only('subagent-coordinator-bridge')} />, SUBAGENT);
  assert.match(html, /sys-msg/);
  assert.match(html, /Claudio · automático/);
  assert.doesNotMatch(html, /msg-user/);
});

test('each of Claudio\'s texts is a system row with its label, and a hint folds the exact text it sent', () => {
  const cases: Array<[string, string]> = [
    [`${AUTO_HINT_PREFIX}\n\nThe tests have been failing for ten minutes.`, 'Claudio · automático'],
    [`${SUPERVISOR_HINT_PREFIX}\n\nThe subagent is looping.`, 'Supervisor'],
    [`${CANCEL_NOTICE_PREFIX} \`pnpm test\`.`, 'Cancelaste un comando'],
    [`${AUTO_CANCEL_NOTICE_PREFIX}: \`sleep 600\`.`, 'Claudio canceló un comando'],
    [LIMIT_CONTINUE_TEXT, 'Claudio · automático'],
  ];
  for (const [said, label] of cases) {
    const html = render(<EntryView entry={typed(said)} />);
    assert.match(html, /class="[^"]*sys-msg/, said);
    assert.ok(html.includes(label), `${label} in ${said}`);
    assert.doesNotMatch(html, /msg-user/, said);
  }
  const hint = render(<EntryView entry={typed(`${SUPERVISOR_HINT_PREFIX}\n\nThe subagent is looping.`)} />);
  assert.match(hint, /sys-msg-fold/);
  // The fold's body (the exact text, prefix included) is not rendered until it opens
  assert.doesNotMatch(hint, /Supervisor, not from the person/, 'the line drops the prefix');
  assert.match(hint, /class="sys-msg-words"[^>]*>The subagent is looping\.</, 'the line does not');
  assert.doesNotMatch(render(<EntryView entry={typed(LIMIT_CONTINUE_TEXT)} />), /sys-msg-fold/, 'one line folds nothing');
});

test("a person's hint is their bubble with the Pista tag and without the prefix", () => {
  const html = render(<EntryView entry={typed(`${CHAT_HINT_PREFIX}\n\nUse the fake CLI.`)} />);
  assert.match(html, /msg-user/);
  assert.match(html, /msg-head is-shown/);
  assert.match(html, /badge badge-info[^>]*>.*Pista/);
  assert.match(html, /Use the fake CLI\./);
  assert.doesNotMatch(html, /A hint from the person/);
  assert.match(render(<EntryView entry={typed(`${CHAT_HINT_PREFIX}\n\nUse it.`)} />, LEAD, 'en'), /Hint/);
});

const stepOf = (entries: TranscriptEntry[]): Extract<TranscriptRow, { kind: 'step' }> => {
  const row = transcriptRows(entries).find((r) => r.kind === 'step');
  assert.ok(row && row.kind === 'step');
  return row;
};

// Rendered as the step being worked on, so its rows are open on the server too
test("the lead's SendMessage is a card under its step, Principal → the subagent, and its row says → who · what", () => {
  const html = render(<StepView row={stepOf(recorded('lead-sendmessage-to-subagent'))} current />);
  assert.match(html, /class="agent-msg"/);
  assert.match(text(html), /Principal .*Ping-pong subagent task/);
  assert.match(html, /hello from lead/);
  assert.match(html, /→ Ping-pong subagent task/);
  assert.match(html, /· Lead greets the background subagent/);
  assert.doesNotMatch(html, /No entregado/);
});

test('a SendMessage that did not go out says "No entregado" with the CLI reason', () => {
  const [call, result] = recorded('lead-sendmessage-to-subagent');
  assert.ok(call && result);
  const failed: TranscriptEntry = { ...result, blocks: [{ type: 'tool_result', toolUseId: 'toolu_01V2kkBoxcAtMZL3sM8UnRFr', content: "Not sent: no agent named 'x' is reachable.", isError: true }] };
  const html = render(<StepView row={stepOf([call, failed])} current />);
  assert.match(html, /agent-msg is-not-sent/);
  assert.match(html, /No entregado/);
  assert.match(html, /class="agent-msg-reason">Not sent: no agent named &#x27;x&#x27; is reachable\.</);
});

test('a ListAgents row reads "Agentes disponibles" with the count', () => {
  const entries: TranscriptEntry[] = [
    { ...typed(''), uuid: 'c', role: 'assistant', blocks: [{ type: 'tool_use', id: 'toolu_l', name: 'ListAgents', input: {} }] },
    { ...typed(''), uuid: 'r', blocks: [{ type: 'tool_result', toolUseId: 'toolu_l', content: 'Peer sessions (2):\n  a [1]  ·  busy\n  b [2]  ·  idle\n', isError: false }] },
  ];
  assert.match(render(<StepView row={stepOf(entries)} current />), /Agentes disponibles \(2\)/);
});

test('the relay row the composer draws in the lead reads Tú → the subagent, its name a link', () => {
  const html = render(<RelayRow agentId="a0000000000000001" words={'Check the lockfile first.\nThen the tests.'} at="2026-11-10T10:00:00.000Z" />);
  assert.match(html, /class="sys-msg"/);
  assert.match(text(html), /Tú .*Ping-pong subagent task .*Check the lockfile first\./);
  assert.doesNotMatch(html, /Then the tests/);
  assert.match(html, /title="Tú → Ping-pong subagent task"/);
});
