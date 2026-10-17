// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatWorkflow, ChatWorkflowAgent, LimitWait, Orchestration, OrchestrationTaskState, ProviderStatus } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { keys } from '../src/api';
import i18n from '../src/i18n';
import { WorkflowEndedNotice, WorkflowWaitNotice } from '../src/components/OrchestrationBoard';
import { FailedByChecksNotice } from '../src/components/VerificationCard';
import { waitShownOnGraph, workflowEnded, workflowWait } from '../src/lib/orchestration-board';
import { orchestrationSteps } from '../src/lib/orchestration-steps';

// A workflow graph at a usage limit (R15): its task states come from the CLI's journal, the one wait
// its lead is in is said once for the graph, and why the run did not finish is said in the bad tone.

const task = (id: string, extra: Partial<OrchestrationTaskState> = {}): OrchestrationTaskState => ({
  id,
  name: id,
  prompt: 'do it',
  status: 'pending',
  attempts: 0,
  runId: 'lead',
  sessionId: null,
  result: null,
  error: null,
  startedAt: null,
  endedAt: null,
  costUsd: 0,
  ...extra,
});

const orch = (tasks: OrchestrationTaskState[], extra: Partial<Orchestration> = {}): Orchestration => ({
  id: 'o1',
  name: 'graph',
  objective: null,
  status: 'running',
  cwd: '/repo',
  model: null,
  permissionMode: 'acceptEdits',
  concurrency: 3,
  synthesize: true,
  worktree: false,
  maxAttempts: 1,
  allowedTools: [],
  permissionPrompts: 'host',
  createdAt: '2026-10-17T00:00:00Z',
  endedAt: null,
  tasks,
  finalResult: null,
  costUsd: 0,
  engine: 'workflow',
  workflow: { runId: 'lead', workflowRunId: 'wf_1', scriptPath: '/tmp/s.js' } as Orchestration['workflow'],
  ...extra,
});

const wait: LimitWait = { provider: 'claude-code', resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(), moveId: 'm1' };

const agent = (label: string, phase: string, status: ChatWorkflowAgent['status']): ChatWorkflowAgent => ({ index: 0, label, status, id: null, phase }) as ChatWorkflowAgent;

const run = (agents: ChatWorkflowAgent[]): ChatWorkflow =>
  ({ id: 'wf_1', name: 'claudio', description: '', status: 'running', phases: ['Tasks', 'Synthesis'], agents, startedAt: null, endedAt: null, totalTokens: null }) as unknown as ChatWorkflow;

const provider: ProviderStatus = {
  id: 'claude-code',
  label: 'Claude Code',
  state: 'ready',
  reason: null,
  version: '2.1.282',
  compatibleRange: '>=2.1 <3',
  binaryPath: '/usr/local/bin/x',
  configHome: null,
  account: null,
  capabilities: [],
  checkedAt: '2026-10-17T00:00:00Z',
};

/** What the component drew, without the toast region its provider always adds. */
function render(node: ReactNode, language = 'en'): string {
  void i18n.changeLanguage(language);
  const client = new QueryClient();
  client.setQueryData(keys.providers, [provider]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      {/* main.tsx wraps the app in it */}
      <TooltipProvider>
        <ToastProvider>{node}</ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  void i18n.changeLanguage('en');
  return html.replace(/<div class="toasts"[^>]*><\/div>/, '');
}

// The f33d7d0b shape: g7 done, g8 refused at the limit and held running while the lead waits, z1 not started
const held = () => orch([task('g7', { status: 'completed' }), task('g8', { status: 'running', waiting: wait }), task('z1', { dependsOn: ['g8'] })]);

test("a workflow held at a limit has one wait, the lead's, and its tasks give their wait strips to it", () => {
  const o = held();
  assert.deepEqual(workflowWait(o), wait);
  assert.equal(waitShownOnGraph(o), true);
  // A graph engine's tasks keep their own: each worker waits on its own
  assert.equal(workflowWait({ ...o, engine: 'graph' }), null);
  assert.equal(waitShownOnGraph({ ...o, engine: 'graph' }), false);
  // Nothing waits once the graph is not running, nor while a rotation moved it on
  assert.equal(workflowWait({ ...o, status: 'stopped' }), null);
  assert.equal(workflowWait(orch([task('g8', { status: 'running' })])), null);
});

test('the wait is said once over the graph: warn, the hour, the cache, and the ways out: stop it, or run it now', () => {
  const html = render(<WorkflowWaitNotice orch={held()} />);
  assert.equal((html.match(/class="wait-line"/g) ?? []).length, 1);
  assert.match(html, /Waiting for Claude Code/);
  assert.match(html, /resumes from its cache at the reset/);
  assert.match(html, /<span class="wait-line-go"><button[^>]*>Stop waiting<\/button>/);
  assert.match(html, /<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?\s*Run now<\/button>/, 'R11: or run it now on an account with room');
  // Nothing moves while it waits
  assert.doesNotMatch(html, /spinner|live-/);
  assert.equal(render(<WorkflowWaitNotice orch={orch([task('g8', { status: 'running' })])} />), '');
});

test('the wait reads in Spanish too', () => {
  const html = render(<WorkflowWaitNotice orch={held()} />, 'es');
  assert.match(html, /Esperando a Claude Code/);
  assert.match(html, /se reanuda desde su caché/);
  assert.match(html, />Dejar de esperar</);
  assert.match(html, /Ejecutar ahora</);
});

test("why a workflow did not finish is the server's sentence, bad when it failed and warn when it was stopped", () => {
  const reason = 'nothing in the workflow moved for 30 min; resume it to go on from its cache';
  const failed = orch([task('g8', { status: 'failed', error: reason })], { status: 'failed', error: reason });
  assert.deepEqual(workflowEnded(failed), { tone: 'bad', error: reason });
  const html = render(<WorkflowEndedNotice orch={failed} />);
  assert.match(html, /class="alert alert-bad"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /The workflow did not finish/);
  assert.ok(html.includes(reason));

  const stopped = orch([task('g8', { status: 'stopped' })], { status: 'stopped', error: 'a person stopped waiting for the usage limit to reset' });
  assert.equal(workflowEnded(stopped)?.tone, 'warn');
  assert.match(render(<WorkflowEndedNotice orch={stopped} />), /class="alert alert-warn"[\s\S]*The workflow was stopped/);

  // A completed workflow, or one without a reason, says nothing; a graph's reason is its checks'
  assert.equal(workflowEnded(orch([], { status: 'completed' })), null);
  assert.equal(workflowEnded(orch([], { status: 'failed' })), null);
  assert.equal(workflowEnded({ ...failed, engine: 'graph' }), null);
});

test("a workflow's failure is not reported as its checks'", () => {
  const failed = orch([], { status: 'failed', error: 'the workflow did not finish: the session ended' });
  assert.equal(render(<FailedByChecksNotice orch={failed} />), '');
  assert.match(render(<FailedByChecksNotice orch={{ ...failed, engine: 'graph' }} />), /alert-bad/);
});

test("the workflow's phase lists the graph's tasks, a refused one included, and reads as a stage does", () => {
  const o = held();
  // The stream reported g7 and nothing else: g8 was refused and reached only the journal
  const steps = orchestrationSteps(o, run([agent('g7', 'Tasks', 'completed')]));
  const tasks = steps[0];
  assert.equal(tasks?.kind, 'phase');
  assert.deepEqual(tasks?.kind === 'phase' && tasks.tasks.map((t) => t.id), ['g7', 'g8', 'z1']);
  // From the journal's states, not the stream's: g8 is still the run's, waiting for the reset
  assert.equal(tasks?.state, 'current');
  // The synthesis phase keeps its own agent, and the graph's synthesis step follows
  assert.deepEqual(
    steps.map((s) => `${s.kind}:${s.kind === 'phase' ? s.tasks.length : '-'}`),
    ['phase:3', 'phase:0', 'synthesis:-'],
  );

  // Failed by a limit nobody could take: the phase fails, as a graph's stage would
  const failed = orch([task('g7', { status: 'completed' }), task('g8', { status: 'failed', error: "You've hit your session limit" }), task('z1', { status: 'skipped' })], { status: 'failed' });
  assert.equal(orchestrationSteps(failed, run([agent('g7', 'Tasks', 'completed')]))[0]?.state, 'failed');

  // Before the stream reports anything the one step still holds every task
  const one = orchestrationSteps(o, null);
  assert.equal(one[0]?.kind, 'workflow');
  assert.deepEqual(one[0]?.kind === 'workflow' && one[0].tasks.map((t) => t.id), ['g7', 'g8', 'z1']);
});
