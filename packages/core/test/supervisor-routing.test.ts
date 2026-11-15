import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chatHealth, HUNG_COMMAND_BAD_MS, SELF_BOUND_GRACE_MS, SILENCE_BAD_MS, type HealthFacts } from '../src/chat-model.ts';
import type { ChatManager, ChatRuntime } from '../src/chats.ts';
import type { Db } from '../src/db.ts';
import { HealthService } from '../src/health-service.ts';
import { familyDirs, lastRecordAt, quietParty, repeatStall, type DelegatedAgent, type ToolCall, type Trace } from '../src/health.ts';

// The cases of docs/reports/supervisor-routing-2026-11-14.md, each as it happened in the 36-hour
// session that prompted it: a lead that orchestrates subagents read as silent and as making no
// progress while it waited on them, and a command that bounded itself was cancelled before its bound.

const T0 = Date.parse('2026-11-13T10:00:00.000Z');
const at = (msAfter: number) => new Date(T0 + msAfter).toISOString();
const MIN = 60_000;

let n = 0;
function call(name: string, input: Record<string, unknown>, over: Partial<ToolCall> = {}): ToolCall {
  return { id: `toolu_${String(++n)}`, name, input, at: at(0), endedAt: at(1000), isError: false, result: 'ok', ...over };
}
const sub = (toolUseId: string, over: Partial<DelegatedAgent> = {}): DelegatedAgent => ({
  toolUseId,
  status: 'running',
  startedAt: at(0),
  description: `agent ${toolUseId}`,
  subagentType: 'developer',
  ...over,
});
const traceOf = (over: Partial<Trace>): Trace => ({ executionStartedAt: at(0), lastEventAt: at(0), calls: [], heartbeats: new Map(), ...over });

// ---------- silence (cause 2) ----------

test('a lead waiting on the subagents it launched is not silent', () => {
  const agentCall = call('Agent', { description: 'build it', prompt: 'x' }, { endedAt: null });
  // The subagent itself sits in a long call of its own, which is judged as a command, not as silence
  const its = call('mcp__plugin_sluice_sluice__verify', { working_directory: '/w' }, { endedAt: null, parentToolUseId: agentCall.id });
  assert.equal(quietParty(traceOf({ calls: [agentCall, its], delegated: { subagents: [sub(agentCall.id)], background: 0 } })), null, 'a foreground Agent call');
  // Background agents: the lead's own calls all answered
  assert.equal(quietParty(traceOf({ calls: [call('Agent', { run_in_background: true })], delegated: { subagents: [sub('toolu_bg', { status: 'waiting' })], background: 0 } })), null);
});

test('a lead waiting on a background task, a monitor or a CI watch it sent to the background is not silent', () => {
  const watch = call('Bash', { command: 'gh pr checks 136 --watch', run_in_background: true });
  assert.equal(quietParty(traceOf({ calls: [watch], delegated: { subagents: [], background: 1 } })), null);
});

test('a lead inside an MCP call that takes its time, such as a queued verification, is not silent', () => {
  const verify = call('mcp__plugin_sluice_sluice__verify', { working_directory: '/w' }, { endedAt: null });
  assert.equal(quietParty(traceOf({ calls: [verify] })), null);
});

test('a running subagent with nothing in flight is the silent one, judged on its own last event', () => {
  const agentCall = call('Agent', { description: 'review' }, { endedAt: null });
  const busy = sub('toolu_busy');
  const quiet = sub('toolu_quiet', { agentId: 'a-quiet' });
  const trace = traceOf({
    calls: [agentCall, call('Bash', { command: 'pnpm test' }, { endedAt: null, parentToolUseId: 'toolu_busy' })],
    activity: new Map([
      ['', at(0)],
      ['toolu_busy', at(2 * MIN)],
      ['toolu_quiet', at(1 * MIN)],
    ]),
    delegated: { subagents: [busy, quiet], background: 0 },
  });
  assert.deepEqual(quietParty(trace), {
    since: at(1 * MIN),
    agent: { parentToolUseId: 'toolu_quiet', agentId: 'a-quiet', description: 'agent toolu_quiet', subagentType: 'developer' },
  });
});

test('a lead that delegated nothing that still runs and has nothing in flight is the silent one', () => {
  assert.deepEqual(quietParty(traceOf({ lastEventAt: at(5 * MIN), calls: [call('Read', { file_path: '/x' })] })), { since: at(5 * MIN) });
});

const working = (live: HealthFacts['live']): HealthFacts => ({ state: 'working', live, lastEnded: null, context: null, failedBranches: 0 });

test('silence fires for the chat only when everything is quiet, and names the agent that is silent', () => {
  const agent = { parentToolUseId: 'toolu_quiet', description: 'review' };
  // Everyone waits on something: no silence however long the chat has been quiet
  assert.deepEqual(chatHealth(working({ lastEventAt: at(0), commands: [], silent: null }), T0 + 40 * MIN).signals, []);
  // Something spoke recently: the chat is not quiet
  assert.deepEqual(chatHealth(working({ lastEventAt: at(39 * MIN), commands: [], silent: { since: at(0), agent } }), T0 + 40 * MIN).signals, []);
  const quiet = chatHealth(working({ lastEventAt: at(0), commands: [], silent: { since: at(0), agent } }), T0 + SILENCE_BAD_MS);
  assert.equal(quiet.signals[0]?.kind, 'silence');
  assert.equal(quiet.signals[0]?.level, 'bad');
  assert.deepEqual(quiet.signals[0]?.agent, agent, 'the hint goes to the subagent, not the lead');
});

// ---------- a command that bounded itself (cause 4) ----------

test('a command under its own timeout is not a problem before its bound, only a warning', () => {
  const watch = { command: 'timeout 2700 gh pr checks 136 --watch', startedAt: at(0), toolUseId: 'toolu_watch' };
  const at15 = chatHealth(working({ lastEventAt: at(0), commands: [watch] }), T0 + 15 * MIN).signals[0];
  assert.equal(at15?.kind, 'hung-command');
  assert.equal(at15?.level, 'warn', 'not bad, so the Supervisor is not woken and nothing is cancelled');
  const past = chatHealth(working({ lastEventAt: at(0), commands: [watch] }), T0 + 2700_000 + SELF_BOUND_GRACE_MS).signals[0];
  assert.equal(past?.level, 'bad', 'outlived its own bound');
  // Without a bound the old limit holds
  const bare = { command: 'gh pr checks 136 --watch', startedAt: at(0), toolUseId: 'toolu_bare' };
  assert.equal(chatHealth(working({ lastEventAt: at(0), commands: [bare] }), T0 + HUNG_COMMAND_BAD_MS).signals[0]?.level, 'bad');
});

test('a repeated stall whose running command is inside its own bound stays a warning', () => {
  const runs = [0, 1, 2].map((i) => call('Bash', { command: 'timeout 1800 pnpm e2e' }, { at: at(i * 20 * MIN), endedAt: i < 2 ? at(i * 20 * MIN + 15 * MIN) : null }));
  const limits = { fallbackMs: 3 * MIN, usualOf: () => null };
  assert.equal(repeatStall(traceOf({ calls: runs }), limits, T0 + 40 * MIN + 10 * MIN)?.level, 'warn');
  const unbounded = runs.map((c) => ({ ...c, input: { command: 'pnpm e2e' } }));
  assert.equal(repeatStall(traceOf({ calls: unbounded }), limits, T0 + 40 * MIN + 10 * MIN)?.level, 'bad');
});

// ---------- progress across the family (cause 3) ----------

test("the directories a lead's subagents work in are found from their calls and their cwd", () => {
  const trace = traceOf({
    calls: [
      call('Edit', { file_path: '/repo/.claude/worktrees/feat-a/src/x.ts' }, { parentToolUseId: 'toolu_a' }),
      call('Bash', { command: 'cd /repo/.claude/worktrees/feat-b && pnpm test' }, { parentToolUseId: 'toolu_b' }),
      call('Bash', { command: 'cd /elsewhere/checkout && git status' }, { parentToolUseId: 'toolu_b' }),
      // The lead's own calls are its own directory's business
      call('Bash', { command: 'cd /repo/.claude/worktrees/lead-only && ls' }),
    ],
    delegated: { subagents: [sub('toolu_c', { cwd: '/repo/.claude/worktrees/feat-c' })], background: 0 },
  });
  assert.deepEqual(familyDirs(trace, '/repo').sort(), ['/elsewhere/checkout', '/repo/.claude/worktrees/feat-a', '/repo/.claude/worktrees/feat-b', '/repo/.claude/worktrees/feat-c']);
});

test('a commit or a push by any agent of the chat is progress', () => {
  const trace = traceOf({
    calls: [
      call('Bash', { command: 'git -C /w commit -m "feat: x"' }, { endedAt: at(7 * MIN), parentToolUseId: 'toolu_a' }),
      call('Bash', { command: 'git push' }, { endedAt: at(9 * MIN), isError: true }),
    ],
  });
  assert.equal(lastRecordAt(trace), at(7 * MIN), 'a failed push is not');
});

/** A HealthService over one made-up chat: the runtime and the store are stubs, and the checkout is not a repository */
function service(trace: Trace) {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-family-'));
  const chat = { id: 'lead', workingDir: dir, cwd: dir } as ChatRuntime;
  const runtime = { get: () => chat, trace: () => trace } as unknown as ChatManager;
  return new HealthService(runtime, {} as Db);
}

const base = { state: 'working' as const, lastEnded: null, context: null, failedBranches: 0 };

test('a lead is not asked for progress while a subagent it delegated to is running', () => {
  const agentCall = call('Agent', { description: 'implement' }, { endedAt: null });
  const delegating = traceOf({ calls: [agentCall], delegated: { subagents: [sub(agentCall.id)], background: 0 } });
  const kinds = service(delegating).read('lead', base, T0 + 50 * MIN).signals.map((s) => s.kind);
  assert.ok(!kinds.includes('no-progress'), kinds.join(','));
  // The same lead with nothing delegated and nothing done is asked, as before
  const alone = traceOf({ calls: [call('Read', { file_path: '/x' }, { endedAt: at(50 * MIN) })], lastEventAt: at(50 * MIN) });
  assert.ok(service(alone).read('lead', base, T0 + 50 * MIN).signals.some((s) => s.kind === 'no-progress'));
});

test("a subagent's commit counts as the lead's progress once the subagent is done", () => {
  const done = traceOf({
    calls: [call('Bash', { command: 'git commit -m "fix: y"' }, { endedAt: at(40 * MIN), parentToolUseId: 'toolu_a' })],
    lastEventAt: at(49 * MIN),
  });
  const signals = service(done).read('lead', base, T0 + 50 * MIN).signals;
  assert.ok(!signals.some((s) => s.kind === 'no-progress'), 'ten minutes since the commit is under the limit');
});
