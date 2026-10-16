import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationsFor as englishDraftsFor, waitingDrafts as englishWaitingDrafts, type ClaudioEvent } from '@claudio/shared';

/*
 * The words a notification is born with come from two places: i18next in the browser, and the
 * English built into `@claudio/shared` for the push sender, which has no language of its own. They
 * are the same sentences written twice, so this holds them together: every event below goes
 * through both and must come out saying exactly the same thing.
 */

// The wording follows navigator.languages; pin it so the web's side of the comparison is English.
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'] }, configurable: true });
const { notificationsFor, waitingDrafts } = await import('../src/lib/notifications-model.ts');

let nextId = 1;
const AT = '2026-01-01T12:00:00Z';
const base = (title: string) => ({ id: nextId++, at: AT, title });
const run = { runId: 'run1', runName: 'fix the build', sessionId: null, orchestrationId: null, internal: false };
const ended = (turns: number, error: string | null): ClaudioEvent => ({ type: 'run.ended', ...base('done'), ...run, status: error ? 'failed' : 'completed', error, turns, costUsd: 0.1 });
const orchestration = (status: 'completed' | 'failed'): ClaudioEvent => ({
  type: 'orchestration.updated',
  ...base('o'),
  orchestrationId: 'o1',
  orchestrationName: 'refactor',
  status,
  previousStatus: 'running',
  integrationStatus: null,
  costUsd: 1,
});
const conflict = (paths: string[], resolving: boolean): ClaudioEvent => ({
  type: 'orchestration.conflict',
  ...base('Merge conflict in refactor'),
  orchestrationId: 'o1',
  orchestrationName: 'refactor',
  integrationStatus: 'conflicted',
  branch: 'claudio/o1',
  paths,
  resolving,
});

const spendAlert = (level: 'warn' | 'exhausted', spentUsd: number): ClaudioEvent => ({
  type: 'spend.alert',
  ...base('Daily spend'),
  level,
  spend: {
    day: '2026-01-01',
    timezone: 'UTC',
    capUsd: 20,
    spentUsd,
    share: spentUsd / 20,
    level: level === 'exhausted' ? 'exhausted' : 'bad',
    blocked: level === 'exhausted',
    resetsAt: '2026-01-02T00:00:00Z',
    unreported: 0,
    byPurpose: {},
    byAccountKind: { login: 0, token: 0, apiKey: 0, unknown: 0 },
    waiting: { flowRuns: 0, orchestrationTasks: 0 },
  },
});

const joinRequest = (relayedBy: { endpointId: string; name: string } | null): ClaudioEvent => ({
  type: 'collaborators.join-request',
  ...base('Cleo asks to join Platform'),
  groupName: 'Platform',
  request: { groupId: 'a'.repeat(64), from: 'c'.repeat(64), name: 'Cleo', relayedBy, receivedAt: AT, expiresAt: '2026-01-08T12:00:00Z' },
});

// One event per sentence, including both halves of every plural and the fallbacks for an account
// or an error Claudio cannot name.
const EVENTS: ClaudioEvent[] = [
  { type: 'run.waiting', ...base('waiting'), ...run, reason: 'permission', permissionId: 'p1', toolName: 'Bash' },
  { type: 'run.waiting', ...base('waiting'), ...run, reason: 'question', permissionId: 'p2', toolName: 'AskUserQuestion' },
  { type: 'run.waiting', ...base('waiting'), ...run, reason: 'plan', permissionId: 'p3', toolName: 'ExitPlanMode' },
  { type: 'run.updated', ...base('idle'), ...run, status: 'idle', previousStatus: 'busy', turns: 2, costUsd: 0.1, pendingPrompts: 0 },
  ended(1, null),
  ended(3, null),
  ended(3, 'boom'),
  // A run that failed without saying why is the one case that needs a sentence of ours
  { ...(ended(3, 'boom') as Extract<ClaudioEvent, { type: 'run.ended' }>), error: null },
  { type: 'run.rateLimited', ...base('limited'), ...run },
  orchestration('completed'),
  orchestration('failed'),
  conflict(['a.ts'], false),
  conflict(['a.ts', 'b.ts'], false),
  conflict(['a.ts'], true),
  conflict(['a.ts', 'b.ts'], true),
  { type: 'task.ended', ...base('npm test'), ...run, sessionId: 's1', taskId: 't1', taskType: 'bash', description: 'npm test', status: 'completed', summary: null, fromSubagent: true },
  { type: 'supervisor.proposed', ...base('hint'), ...run, taskId: null, taskName: null, proposal: { id: 'sp1', chatId: 'run1', signal: 'hung-command', hint: 'Run the unit tests instead.', costUsd: 0.01, at: AT, status: 'proposed' } },
  { type: 'health.changed', ...base('stuck'), ...run, taskId: null, taskName: null, level: 'warn', previousLevel: 'ok', reason: 'It has been quiet for 5 min.', signals: ['hung-command'] },
  spendAlert('warn', 15),
  spendAlert('exhausted', 20),
  joinRequest(null),
  joinRequest({ endpointId: 'b'.repeat(64), name: 'Ben' }),
];

for (const [index, event] of EVENTS.entries()) {
  const kind = event.type === 'run.waiting' ? `${event.type}:${event.reason}` : event.type;
  test(`the web and the push sender say the same thing about ${kind} (${index})`, () => {
    assert.deepEqual(notificationsFor(event), englishDraftsFor(event));
  });
}

test('the web and the push sender say the same thing about a prompt found on a reload', () => {
  const chat = { id: 'run1', title: 'fix the build', firstPrompt: null, orchestration: null };
  const requests = [
    { id: 'p1', runId: 'run1', toolName: 'Bash', toolUseId: 'a', input: {}, requestedAt: AT },
    { id: 'q', runId: 'run1', toolName: 'AskUserQuestion', toolUseId: 'b', input: {}, requestedAt: AT },
    { id: 'pl', runId: 'run1', toolName: 'ExitPlanMode', toolUseId: 'c', input: {}, requestedAt: AT },
  ];
  assert.deepEqual(waitingDrafts(chat, requests), englishWaitingDrafts(chat, requests));
});

test('a sentence the server wrote is left alone when this build has no key for its code', () => {
  const unknown: ClaudioEvent = {
    type: 'health.changed',
    ...base('stuck'),
    ...run,
    taskId: null,
    taskName: null,
    level: 'bad',
    previousLevel: 'ok',
    reason: 'Something this build has never heard of.',
    reasonCode: 'health.fromTheFuture',
    signals: ['loop'],
  };
  assert.deepEqual(notificationsFor(unknown), englishDraftsFor(unknown));
});
