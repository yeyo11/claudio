import type { DatabaseSync } from 'node:sqlite';
import type { ClaudioEvent, ContinuationEffect, DecisionAnswer, DecisionOutcomeQuality, DecisionPointId, DecisionRecord, DecisionResolution, ModelFallback } from '@claudio/shared';
import { TTL_SECONDS } from '../push.ts';
import { CONTINUATION_OWES } from './points.ts';

/*
 * Shadow accuracy (docs/plans/decision-engine.md, "Shadow accuracy"). Each point has a resolver that
 * reads the signal the app already produces (a flow run ending, a proposal decided, a task's
 * status) and says whether the answer matched what happened. A resolver returns null while the
 * outcome is not known yet, so the row stays unresolved and does not count. The person's
 * useful / not useful outranks the inference: the store leaves `agreed` alone once there is feedback.
 *
 * Only what a point flagged is judged for the suggest points: "not flagged" says nothing that a
 * later event could confirm or refute.
 */

type Sql = DatabaseSync;
type Resolver = (row: DecisionRecord, sql: Sql, now: number, context: ResolverContext) => DecisionResolution | null;

/** What a resolver reads outside the database */
interface ResolverContext {
  modelFallbacks: () => readonly ModelFallback[];
}

const PERSON = 'person';

/** How long a push lives at the push service: a notification not opened by then was not opened soon */
const NOTIFICATION_WINDOW_MS = TTL_SECONDS * 1000;

/** A task in one of these may still change, so the row waits */
const STILL_GOING = new Set(['pending', 'running', 'blocked', 'interrupted']);

const FAMILIES = ['haiku', 'sonnet', 'opus'];
const rankOf = (model: string | null): number => (model ? FAMILIES.findIndex((f) => model.toLowerCase().includes(f)) : -1);

/** Whether the suggestion was right for a task that ended; null when this task says nothing about it */
function modelVerdict(suggested: string, launched: string | null, kept: boolean, completed: boolean): boolean | null {
  if (kept) return completed;
  const s = rankOf(suggested);
  const l = rankOf(launched);
  if (s < 0 || l < 0 || s === l) return null;
  // A stronger model was suggested and the task failed: the suggestion was right. If it completed anyway, it was not needed
  if (s > l) return completed ? false : true;
  // A weaker one was suggested and the task failed: the suggestion was wrong; if it completed, it proves nothing
  return completed ? null : false;
}

/**
 * Every outcome says how far it can be trusted (M3 of docs/plans/decision-engine-v2.md): `direct` is an
 * effect the decision could not have caused to look right (a person's action, a retry's result, what
 * a continuation changed); `proxy` is correlated but contaminated (a later QA verdict, or what the
 * decision itself set in motion). Only `direct` outcomes count as a point's evidence.
 */
const verdict = (quality: DecisionOutcomeQuality, agreed: boolean, summary: string, detail?: Record<string, unknown>): DecisionResolution => ({
  agreed,
  quality,
  summary,
  ...(detail ? { detail } : {}),
});

const choiceOf = (row: DecisionRecord, id: string): string | null => {
  const answer: DecisionAnswer | undefined = row.answers?.[id];
  return answer?.kind === 'choice' ? answer.value : null;
};
const scoreOf = (answer: DecisionAnswer | undefined): string | null => (answer?.kind === 'score' ? answer.value : null);
const yes = (answer: DecisionAnswer | undefined): boolean => answer?.kind === 'noul' && answer.value;
const flagged = (row: DecisionRecord): string[] => Object.entries(row.answers ?? {}).filter(([, a]) => yes(a)).map(([id]) => id);

interface RunRow {
  id: string;
  item_id: string;
  chat_id: string | null;
  stage: string;
  role: string;
  state: string;
  outcome: string | null;
  cause: string | null;
  retry_of: string | null;
  seq: number;
  ended_at: string | null;
}

const runById = (sql: Sql, id: string | null): RunRow | null => (id ? ((sql.prepare('SELECT * FROM flow_runs WHERE id = ?').get(id) as RunRow | undefined) ?? null) : null);

/** The first run of a stage that ended on the card after `since`, with an outcome */
function endedAfter(sql: Sql, itemId: string, stage: string, since: string, afterSeq = 0): RunRow | null {
  return (
    (sql
      .prepare("SELECT * FROM flow_runs WHERE item_id = ? AND stage = ? AND state = 'ended' AND outcome IN ('passed', 'rejected') AND ended_at > ? AND seq > ? ORDER BY seq LIMIT 1")
      .get(itemId, stage, since, afterSeq) as RunRow | undefined) ?? null
  );
}

interface HistoryRow {
  change: string;
  from_value: string | null;
  to_value: string | null;
  actor_kind: string;
  created_at: string;
}

const historyAfter = (sql: Sql, itemId: string, since: string, changes: string[]): HistoryRow[] =>
  sql
    .prepare(`SELECT change, from_value, to_value, actor_kind, created_at FROM work_item_history WHERE item_id = ? AND created_at > ? AND change IN (${changes.map(() => '?').join(',')}) ORDER BY seq`)
    .all(itemId, since, ...changes) as unknown as HistoryRow[];

const parse = (value: string | null): Record<string, unknown> | null => {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

interface TaskRef {
  status: string;
  attempts: number;
  continuations: number;
  continuationEffects: ContinuationEffect[];
  verification: string | null;
}

/** `<orchestration id>:<task id>`, as the orchestrator's points use it as a subject */
function taskOf(sql: Sql, subjectId: string | null): TaskRef | null {
  if (!subjectId) return null;
  const at = subjectId.indexOf(':');
  if (at < 0) return null;
  const found = sql.prepare('SELECT json FROM orchestrations WHERE id = ?').get(subjectId.slice(0, at)) as { json: string } | undefined;
  const orch = found ? parse(found.json) : null;
  if (!orch) return null;
  const taskId = subjectId.slice(at + 1);
  const verification = (orch.verification as { status?: string } | null | undefined)?.status ?? null;
  if (taskId === '__verification__') return { status: String(orch.status ?? ''), attempts: 0, continuations: 0, continuationEffects: [], verification };
  const task = (orch.tasks as Array<Record<string, unknown>> | undefined)?.find((t) => t.id === taskId);
  if (!task) return null;
  return { status: String(task.status ?? ''), attempts: Number(task.attempts ?? 0), continuations: Number(task.continuations ?? 0), continuationEffects: effectsOf(task.continuationEffects), verification };
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];

/** The verify run that follows what the row was about: passed or rejected, whichever came first */
function nextVerify(sql: Sql, itemId: string, since: string, afterSeq = 0): RunRow | null {
  return endedAfter(sql, itemId, 'verify', since, afterSeq);
}

/** The work item a chat belongs to, through the flow run that owns the chat */
function itemOfChat(sql: Sql, chatId: string | null): string | null {
  if (!chatId) return null;
  const run = sql.prepare("SELECT item_id FROM flow_runs WHERE chat_id = ? AND stage = 'work' ORDER BY seq DESC LIMIT 1").get(chatId) as { item_id: string } | undefined;
  return run?.item_id ?? null;
}

/** How long after a `supervisor.intervene` question its proposal may arrive: the room wait and the draft */
const PROPOSAL_WINDOW_MS = 15 * 60_000;
/** How long after a loop flag a person's action on the chat is still read as an answer to it */
const PERSON_WINDOW_MS = 30 * 60_000;

/** Every answer `run.continuation` has given, the ids of state version 1 included */
const CONTINUATION_ANSWERS: ReadonlySet<string> = new Set(['done', 'hands-off', ...CONTINUATION_OWES]);

/** The continuations a run had when the row was asked: a number, or the words the call sites send */
const CONTINUATION_WORDS = ['no continuation yet', 'one continuation so far', 'two continuations so far'];
function continuationsDone(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const at = CONTINUATION_WORDS.indexOf(value);
  return at >= 0 ? at : null;
}

const effectsOf = (value: unknown): ContinuationEffect[] =>
  Array.isArray(value)
    ? value.filter((e): e is ContinuationEffect => typeof e === 'object' && e !== null && typeof (e as ContinuationEffect).n === 'number' && typeof (e as ContinuationEffect).changed === 'boolean')
    : [];

function flowContinuationEffects(sql: Sql, runId: string | null): ContinuationEffect[] | null {
  if (!runId) return null;
  const found = sql.prepare('SELECT continuation_effects FROM flow_runs WHERE id = ?').get(runId) as { continuation_effects: string | null } | undefined;
  if (!found?.continuation_effects) return null;
  try {
    return effectsOf(JSON.parse(found.continuation_effects));
  } catch {
    return null;
  }
}

/**
 * The command a hung-command signal was about: the proposal's call when there is one, else the
 * command of the chat that was running when the question was asked, the oldest first. Null while it
 * has not ended (or was never measured). `usualMs` is the median of the same kind's earlier runs.
 */
function commandAt(sql: Sql, chatId: string, toolUseId: string | null, at: string): { outcome: string; durationMs: number; usualMs: number | null } | null {
  type Run = { kind: string; started_at: string; duration_ms: number; outcome: string };
  let found: Run | undefined;
  if (toolUseId) {
    found = sql.prepare('SELECT kind, started_at, duration_ms, outcome FROM command_durations WHERE chat_id = ? AND tool_use_id = ?').get(chatId, toolUseId) as Run | undefined;
  } else {
    const asked = Date.parse(at);
    const runs = sql.prepare('SELECT kind, started_at, duration_ms, outcome FROM command_durations WHERE chat_id = ? AND started_at <= ? ORDER BY started_at').all(chatId, at) as unknown as Run[];
    found = runs.find((r) => Date.parse(r.started_at) + r.duration_ms >= asked);
  }
  if (!found) return null;
  const earlier = (sql.prepare('SELECT duration_ms FROM command_durations WHERE kind = ? AND started_at < ? ORDER BY started_at DESC LIMIT 50').all(found.kind, found.started_at) as unknown as Array<{ duration_ms: number }>)
    .map((r) => r.duration_ms)
    .sort((a, b) => a - b);
  const usualMs = earlier.length ? (earlier[Math.floor(earlier.length / 2)] ?? null) : null;
  return { outcome: found.outcome, durationMs: found.duration_ms, usualMs };
}

/** The routes by which a person steps in on a working chat; a plain message is left out, since it is as often the next prompt */
const STEP_IN = [
  'POST /chats/:id/stop',
  'POST /chats/:id/interrupt',
  'POST /chats/:id/hint',
  'POST /chats/:id/commands/:toolUseId/cancel',
  'POST /chats/:id/supervisor/:proposalId/send',
  'POST /orchestrations/:id/tasks/:taskId/hint',
  'POST /orchestrations/:id/tasks/:taskId/skip',
  'POST /orchestrations/:id/tasks/:taskId/supervisor/:proposalId/send',
];
/** Actors that are not a person: a chat's own token, the wrapper itself, webhooks and refusals */
const NOT_A_PERSON = "actor NOT LIKE 'chat:%' AND actor NOT IN ('anonymous', 'webhook', 'env', 'claudio')";

/** Every key that sorts under `prefix` (which ends in `/`): `0` is the character after `/` */
const under = (prefix: string): [string, string] => [prefix, `${prefix.slice(0, -1)}0`];

/** The first step-in by a person on the chat, or on the orchestration task it works for, in `(since, until]` */
function personActedOn(sql: Sql, chatId: string, since: string, until: string): { route: string; at: string } | null {
  const chat = sql.prepare("SELECT json_extract(json, '$.orchestrationId') AS orch, json_extract(json, '$.orchestrationTaskId') AS task FROM chats WHERE id = ?").get(chatId) as
    | { orch: string | null; task: string | null }
    | undefined;
  const prefixes = [`/api/chats/${chatId}/`];
  if (chat?.orch && chat.task) prefixes.push(`/api/orchestrations/${chat.orch}/tasks/${chat.task}/`);
  const routes = STEP_IN.map(() => '?').join(',');
  for (const prefix of prefixes) {
    const [from, to] = under(prefix);
    const found = sql
      .prepare(`SELECT route, at FROM audit WHERE path >= ? AND path < ? AND at > ? AND at <= ? AND status < 400 AND route IN (${routes}) AND ${NOT_A_PERSON} ORDER BY at LIMIT 1`)
      .get(from, to, since, until, ...STEP_IN) as { route: string; at: string } | undefined;
    if (found) return found;
  }
  return null;
}

const RESOLVERS: Partial<Record<DecisionPointId, Resolver>> = {
  'flow.refine-needed': (row, sql) => {
    const itemId = row.subjectId;
    const answer = choiceOf(row, 'refine');
    if (!itemId || !answer) return null;
    const edits = historyAfter(sql, itemId, row.at, ['description', 'criterion']);
    if (answer === 'refine') {
      const refine = endedAfter(sql, itemId, 'refine', row.at);
      if (!refine?.ended_at) return null;
      const changed = edits.some((e) => e.created_at <= (refine.ended_at ?? ''));
      return verdict('direct', changed, changed ? 'The refine changed the description or the criteria' : 'The refine changed nothing', { refine: refine.outcome });
    }
    const verify = nextVerify(sql, itemId, row.at);
    if (!verify) return null;
    const editedByPerson = edits.some((e) => e.actor_kind === PERSON);
    const right = verify.outcome === 'passed' && !editedByPerson;
    return verdict('proxy', right, right ? 'The card was built as written and QA passed it' : 'The card was rejected or a person rewrote it', { verify: verify.outcome, editedByPerson });
  },

  'flow.criteria-precheck': (row, sql) => {
    const itemId = row.subjectId;
    if (!itemId || !row.answers) return null;
    const unmet = Object.entries(row.answers).filter(([, a]) => a.kind === 'choice' && a.value === 'clearly-unmet').map(([id]) => id);
    const verify = nextVerify(sql, itemId, row.at);
    if (!verify) return null;
    const rejected = verify.outcome === 'rejected';
    return verdict('proxy', rejected === unmet.length > 0, rejected ? 'QA rejected the card' : 'QA passed the card', { unmet: unmet.length, verify: verify.outcome });
  },

  'flow.bounce': (row, sql) => {
    const answer = choiceOf(row, 'bounce');
    const run = runById(sql, row.subjectId);
    if (!run || !answer) return null;
    const next = nextVerify(sql, run.item_id, row.at, run.seq);
    const people = historyAfter(sql, run.item_id, row.at, ['status', 'description', 'criterion', 'waiting']).some((e) => e.actor_kind === PERSON);
    if (answer === 'fixable') {
      if (!next) return null;
      return verdict('proxy', next.outcome === 'passed', next.outcome === 'passed' ? 'The next QA run passed' : 'The next QA run rejected it again', { next: next.outcome });
    }
    const waiting = sql.prepare('SELECT waiting FROM work_items WHERE id = ?').get(run.item_id) as { waiting: string | null } | undefined;
    // An acted needs-person parked the card itself, and a person then moving it is what parking asks
    // for: the decision caused the agreement, so only a held-out or shadow row's person is direct
    if (waiting?.waiting === 'bounces' || people) return verdict(people && !row.acted ? 'direct' : 'proxy', true, 'The card waited for a person', { waiting: waiting?.waiting ?? null, person: people });
    if (!next) return null;
    return verdict('proxy', next.outcome !== 'passed', next.outcome === 'passed' ? 'A bounce was enough: the next QA run passed' : 'The next QA run rejected it again', { next: next.outcome });
  },

  // The run's own chat, read between its start and end: the CLI compacted it by itself, or the run
  // died on a full context, and `compact-first` was right; a pass with none, and `continue` was
  'context.compact': (row, sql) => {
    const answer = choiceOf(row, 'compact');
    const run = runById(sql, row.subjectId);
    if (!answer || !run) return null;
    if (run.state !== 'ended' || !run.outcome || run.outcome === 'cancelled' || !run.chat_id) return null;
    const started = sql.prepare('SELECT started_at, summary FROM flow_runs WHERE id = ?').get(run.id) as { started_at: string | null; summary: string | null } | undefined;
    const auto = sql
      .prepare("SELECT COUNT(*) AS n FROM chat_compactions WHERE chat_id = ? AND origin = 'cli' AND requested_at >= ? AND requested_at <= ?")
      .get(run.chat_id, started?.started_at ?? row.at, run.ended_at ?? '9999') as { n: number };
    const contextError = run.outcome === 'failed' && /context window|prompt is too long|context length/i.test(`${run.cause ?? ''} ${started?.summary ?? ''}`);
    let needed: boolean;
    if (auto.n > 0 || contextError) needed = true;
    else if (run.outcome === 'passed') needed = false;
    else return null;
    const wanted = answer === 'compact-first';
    return verdict(row.acted ? 'proxy' : 'direct', wanted === needed, needed ? 'The CLI compacted the chat during the run, or the run ran out of context' : 'The run passed with no compaction', { automatic: auto.n, outcome: run.outcome });
  },

  'flow.restart': (row, sql) => {
    const requeue = row.answers?.requeue;
    const run = runById(sql, row.subjectId);
    if (!run || !requeue) return null;
    // The requeued run is the same row started again, or one it was retried as
    const later = sql
      .prepare("SELECT * FROM flow_runs WHERE (id = ? OR retry_of = ?) AND state = 'ended' AND ended_at > ? AND COALESCE(cause, '') != 'restarts' ORDER BY seq LIMIT 1")
      .get(run.id, run.id, row.at) as RunRow | undefined;
    if (!later) return null;
    const failedAgain = later.outcome === 'failed' || later.outcome === 'rejected';
    const doNotRequeue = requeue.kind === 'noul' && !requeue.value;
    return verdict('direct', doNotRequeue === failedAgain, failedAgain ? 'The requeued run failed again' : 'The requeued run finished', { outcome: later.outcome });
  },

  'flow.criteria-merge': (row, sql) => {
    const flags = flagged(row);
    const run = runById(sql, row.subjectId);
    if (!run || flags.length === 0) return null;
    const removed = historyAfter(sql, run.item_id, row.at, ['criterion']).filter((e) => e.actor_kind === PERSON && e.from_value !== null && (e.to_value === null || (parse(e.to_value)?.text !== parse(e.from_value)?.text)));
    if (removed.length > 0) return verdict('direct', true, 'A person removed or edited a merged criterion', { removed: removed.length });
    const item = sql.prepare('SELECT status FROM work_items WHERE id = ?').get(run.item_id) as { status: string } | undefined;
    return item?.status === 'done' ? verdict('proxy', false, 'The card was finished with the flagged criteria untouched') : null;
  },

  'team.assign': (row, sql) => {
    const itemId = row.subjectId;
    const proposed = choiceOf(row, 'member');
    if (!itemId || !proposed) return null;
    const assigned = typeof row.state.assigned === 'string' ? row.state.assigned : null;
    const moves = historyAfter(sql, itemId, row.at, ['assignee']).filter((e) => e.actor_kind === PERSON);
    const last = moves[moves.length - 1];
    if (last) {
      const to = parse(last.to_value)?.role;
      return verdict('direct', to === proposed, to === proposed ? 'A person reassigned the card to the proposed member' : 'A person reassigned it elsewhere', { to: to ?? null });
    }
    // Same as the column's member: nothing to compare until a person disagrees, so the card's end counts
    const verify = nextVerify(sql, itemId, row.at);
    if (!verify) return null;
    if (proposed === assigned) return verdict('proxy', verify.outcome === 'passed', verify.outcome === 'passed' ? 'The fixed member did the work and QA passed it' : 'The fixed member was rejected', { verify: verify.outcome });
    return verdict('proxy', verify.outcome !== 'passed', verify.outcome === 'passed' ? 'The fixed member succeeded where another was proposed' : 'The fixed member was rejected where another was proposed', { verify: verify.outcome });
  },

  // Judged only by what the continuation that followed the row's turn changed (`continuationEffects`),
  // never by how the task or the stage ended: a worker that finished well after a needless
  // continuation made `owes-own-work` look right. An acted `owes-own-work` caused that continuation; a
  // row that did not act is judged only when today's rule sent one anyway. No continuation, no effect
  // to read: the row stays unresolved, `done` included, since scoring it would only agree with the
  // rule. `hands-off` stops the run as `done` does; `owes-work` is the id rows of state version 1 carry
  'run.continuation': (row, sql) => {
    const report = choiceOf(row, 'report');
    if (report === null || !CONTINUATION_ANSWERS.has(report)) return null;
    const done = continuationsDone(row.state.continuations);
    if (done === null) return null;
    const effects = row.subjectKind === 'task' ? taskOf(sql, row.subjectId)?.continuationEffects : flowContinuationEffects(sql, row.subjectId);
    const effect = effects?.find((e) => e.n === done + 1);
    if (!effect) return null;
    const owes = CONTINUATION_OWES.has(report);
    // A continuation the decision did not send says nothing about an acted stop, which held one back
    if (row.acted && !owes && effect.cause === 'decision') return null;
    const detail = { n: effect.n, cause: effect.cause, changed: effect.changed, commits: effect.commits, edits: effect.edits };
    return verdict('direct', owes === effect.changed, effect.changed ? 'The continuation committed or edited something' : 'The continuation changed nothing', detail);
  },

  'orchestration.retry': (row, sql) => {
    const answer = choiceOf(row, 'retry');
    const task = taskOf(sql, row.subjectId);
    if (!answer || !task || (task.status !== 'completed' && task.status !== 'failed')) return null;
    const asked = ORDINALS.indexOf(String(row.state.attempt ?? '').split(' ')[0] ?? '') + 1;
    // A permanent answer that was acted on left no retry to compare with
    if (asked === 0 || task.attempts <= asked) return null;
    const completed = task.status === 'completed';
    return verdict('direct', answer === 'permanent' ? !completed : completed, completed ? 'A retry completed' : 'Every retry failed', { attempts: task.attempts });
  },

  'orchestration.fixer': (row, sql) => {
    const again = row.answers?.['another-attempt'];
    const task = taskOf(sql, row.subjectId);
    // A stop that was acted on ended the verification itself, so there is nothing to compare with
    if (!again || row.acted || !task?.verification || (task.verification !== 'passed' && task.verification !== 'fixed' && task.verification !== 'failed')) return null;
    const passed = task.verification !== 'failed';
    return verdict('direct', yes(again) === passed, passed ? 'The checks passed after more attempts' : 'The checks still failed', { verification: task.verification });
  },

  // Judged by what a full review found: a blocking finding from a dimension a light review skips is what a full one earns its cost for
  'review.depth': (row, sql) => {
    const depth = choiceOf(row, 'depth');
    const orchestrationId = row.subjectId?.split(':')[0];
    if (!depth || !orchestrationId) return null;
    const round = sql
      .prepare("SELECT id FROM review_rounds WHERE orchestration_id = ? AND depth = 'full' AND state IN ('passed', 'blocked', 'incomplete', 'accepted') AND started_at >= ? ORDER BY started_at LIMIT 1")
      .get(orchestrationId, row.at) as { id: string } | undefined;
    // A light review gives no evidence about what a full one would have found
    if (!round) return null;
    const found = sql.prepare('SELECT dimensions FROM review_findings WHERE round_id = ? AND blocking = 1').all(round.id) as unknown as Array<{ dimensions: string }>;
    const securityHit = row.state.securityHit === true;
    const skipped = found.some((f) => {
      const dims = (parse(f.dimensions) as unknown as string[] | null) ?? [];
      return dims.includes('tests') || dims.includes('conventions') || (!securityHit && dims.includes('security'));
    });
    const light = depth === 'light';
    return verdict('proxy', light !== skipped, skipped ? 'A full review confirmed a blocking finding a light one skips' : 'A full review found nothing a light one would have missed', { depth });
  },

  // The question is asked before the hint is drafted, so the proposal that follows is the first one
  // for that chat and signal within the drafting window. Per signal kind: a hung command is judged by
  // the command itself (it ended on its own, or someone cancelled it). Every kind is judged by what
  // became of the proposal, and who did it is what makes it direct: a person's Send or Dismiss is, in
  // any mode; the Supervisor's own send (`sent_by` 'supervisor') is the decision's own doing, so a
  // proxy; and so is a draft that judged the worker not stuck, which is a model's reading too. A sent
  // row from before `sent_by` was kept is read by the point's mode, as it was
  'supervisor.intervene': (row, sql) => {
    const intervene = row.answers?.intervene;
    const signal = typeof row.state.signal === 'string' ? row.state.signal : null;
    if (intervene?.kind !== 'noul' || !row.subjectId || !signal) return null;
    const stuck = intervene.value;
    const proposal = sql
      .prepare('SELECT status, occurrence, at, sent_by FROM supervisor_proposals WHERE chat_id = ? AND signal = ? AND at >= ? AND at <= ? ORDER BY at LIMIT 1')
      .get(row.subjectId, signal, row.at, new Date(Date.parse(row.at) + PROPOSAL_WINDOW_MS).toISOString()) as
      | { status: string; occurrence: string; at: string; sent_by: string | null }
      | undefined;
    const sentBy = proposal?.status !== 'sent' ? null : proposal.sent_by === 'person' || proposal.sent_by === 'supervisor' ? proposal.sent_by : row.mode === 'shadow' ? 'person' : 'supervisor';
    if (signal === 'hung-command') {
      const command = commandAt(sql, row.subjectId, proposal && proposal.occurrence !== '' ? proposal.occurrence : null, row.at);
      if (command) {
        const detail = { signal, command: command.outcome, durationMs: command.durationMs, usualMs: command.usualMs, status: proposal?.status ?? null };
        // It returned by itself: the worker was waiting on a slow command, and a hint reaches an agent only once its call returns
        if (command.outcome !== 'cancelled') return verdict('direct', !stuck, 'The command ended by itself', detail);
        // The Supervisor cancels a command only as the way it sends its own hint: any other cancel was a person judging it hung
        if (sentBy !== 'supervisor') return verdict('direct', stuck, 'A person cancelled the command', detail);
        return verdict('proxy', stuck, 'The Supervisor cancelled the command', detail);
      }
    }
    if (!proposal || proposal.status === 'proposed') return null;
    if (proposal.status === 'not-stuck') return verdict('proxy', !stuck, "The Supervisor's draft found the worker not stuck", { signal, status: proposal.status });
    const sent = proposal.status === 'sent';
    // A dismissal is always a person's; a send is a person's when `sent_by` says so
    const quality: DecisionOutcomeQuality = !sent || sentBy === 'person' ? 'direct' : 'proxy';
    return verdict(quality, stuck === sent, sent ? (sentBy === 'person' ? 'A person sent the hint' : 'The Supervisor sent the hint') : 'The hint was dismissed', {
      signal,
      status: proposal.status,
      sentBy,
    });
  },

  'memory.triage': (row, sql) => {
    const level = scoreOf(row.answers?.usefulness);
    const proposal = row.subjectId ? (sql.prepare('SELECT status FROM memory_proposals WHERE id = ?').get(row.subjectId) as { status: string } | undefined) : undefined;
    if (!level || !proposal || proposal.status === 'pending') return null;
    const approved = proposal.status === 'approved';
    const predictedApproved = level === 'high' || level === 'medium';
    return verdict('direct', predictedApproved === approved, approved ? 'The proposal was approved' : 'The proposal was rejected', { score: level, status: proposal.status });
  },

  'assistant.rerank': (row, sql) => {
    if (!row.answers || !row.subjectId) return null;
    const rows = sql.prepare('SELECT id, status FROM assistant_proposals WHERE run_id = ?').all(row.subjectId) as unknown as Array<{ id: string; status: string }>;
    let judged = 0;
    let right = 0;
    for (const p of rows) {
      const level = scoreOf(row.answers[p.id]);
      if (!level || level === 'minor') continue;
      if (p.status === 'pending') return null;
      if (p.status !== 'accepted' && p.status !== 'discarded') continue;
      judged += 1;
      if ((level === 'covered') === (p.status === 'discarded')) right += 1;
    }
    return judged === 0 ? null : verdict('direct', right * 2 >= judged, `${right} of ${judged} proposals went the way they were ranked`, { judged, right });
  },

  'assistant.sources': (row, sql) => {
    if (!row.answers || !row.projectId) return null;
    const dropped = Object.entries(row.answers).filter(([, a]) => a.kind === 'noul' && !a.value).map(([id]) => id);
    const run = sql
      .prepare("SELECT reads, status FROM assistant_runs WHERE project_id = ? AND started_at >= ? AND status != 'running' ORDER BY seq LIMIT 1")
      .get(row.projectId, row.at) as { reads: string; status: string } | undefined;
    if (!run) return null;
    const read = new Set(((parse(run.reads)?.files as string[] | undefined) ?? []).map(String));
    const missed = dropped.filter((id) => read.has(id));
    return verdict(row.acted ? 'proxy' : 'direct', missed.length === 0, missed.length ? `The run read ${missed.length} file(s) judged not needed` : 'No file judged unneeded was read', { missed });
  },

  'journal.relevance': (row, sql) => {
    if (!row.projectId || !row.answers || typeof row.state.title !== 'string') return null;
    const item = sql.prepare("SELECT id FROM work_items WHERE project_id = ? AND title = ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1").get(row.projectId, row.state.title, row.at) as { id: string } | undefined;
    if (!item) return null;
    const verify = nextVerify(sql, item.id, row.at);
    if (!verify) return null;
    const entries = Array.isArray(row.state.entries) ? (row.state.entries as Array<{ id?: string; title?: string }>) : [];
    const irrelevant = entries.filter((e) => e.id && e.title && scoreOf(row.answers?.[e.id]) === 'irrelevant');
    const comments = (sql.prepare("SELECT body FROM work_item_comments WHERE item_id = ? AND created_at > ? AND author_kind != 'person'").all(item.id, row.at) as unknown as Array<{ body: string }>).map((c) => c.body.toLowerCase());
    const cited = irrelevant.filter((e) => comments.some((c) => c.includes((e.title ?? '').toLowerCase())));
    return verdict('proxy', cited.length === 0, cited.length ? `${cited.length} entry(ies) judged irrelevant were then cited` : 'No entry judged irrelevant was cited', { cited: cited.map((e) => e.id) });
  },

  'lesson.mine': (row, sql) => {
    // A shadow gate never starts a miner, and a "no" leaves nothing a later event could confirm.
    // Only lessons born in the job count: a sighting added to an older lesson is not a proposal
    if (row.mode !== 'active' || !yes(row.answers?.mine)) return null;
    const job = sql.prepare('SELECT id, status, started_at FROM lesson_jobs WHERE decision_id = ?').get(row.id) as { id: string; status: string; started_at: string | null } | undefined;
    if (!job || job.status !== 'done') return null;
    const made = sql
      .prepare('SELECT DISTINCT l.id, l.status FROM lessons l JOIN lesson_evidence e ON e.lesson_id = l.id WHERE e.job_id = ? AND l.created_at >= ?')
      .all(job.id, job.started_at ?? '') as unknown as Array<{ id: string; status: string }>;
    if (made.some((l) => l.status === 'proposed')) return null;
    const approved = made.filter((l) => l.status !== 'rejected').length;
    // A miner that proposed nothing is a result too, and the decision cannot fake it: the paid run was wasted
    return verdict('direct', approved > 0, approved > 0 ? 'A proposed lesson was approved' : made.length ? 'Every proposed lesson was rejected' : 'The miner proposed nothing', { proposed: made.length, approved });
  },

  'board.triage': (row, sql) => {
    if (!row.subjectId) return null;
    const dup = row.answers?.duplicate;
    const item = sql.prepare('SELECT type, priority, status, created_at FROM work_items WHERE id = ?').get(row.subjectId) as { type: string; priority: string; status: string; created_at: string } | undefined;
    if (!item) return yes(dup) ? verdict('direct', true, 'The item was removed, as a duplicate would be') : null;
    // Wait for the item to settle: a person often edits the prefill some minutes after creating
    if (item.status !== 'done' && Date.parse(row.at) + 86_400_000 > Date.now()) return null;
    const type = choiceOf(row, 'type');
    const priority = choiceOf(row, 'priority');
    const kept = (!type || type === item.type) && (!priority || priority === item.priority);
    return verdict(kept ? 'proxy' : 'direct', kept && !yes(dup), kept ? 'The person kept the prefill' : 'The person changed the type or priority', { type: item.type, priority: item.priority });
  },

  'flow.scope-drift': (row, sql) => {
    if (!row.subjectId || flagged(row).length === 0) return null;
    const verify = nextVerify(sql, row.subjectId, row.at);
    if (!verify) return null;
    const rejected = verify.outcome === 'rejected';
    return verdict('proxy', rejected, rejected ? 'QA rejected the card after the drift flag' : 'QA passed the card', { verify: verify.outcome });
  },

  // Only a person's own action on the chat after the flag says a loop was there: a stop, an
  // interrupt, a hint, a cancelled command or a Supervisor hint they sent, read from the audit log
  // (on the chat, or on the orchestration task it works for). A Supervisor hint sent by itself, or the
  // run's end, says nothing about a loop. A person's not useful on the row is the only "wrong" for now
  'health.semantic-loop': (row, sql) => {
    if (!row.subjectId || flagged(row).length === 0) return null;
    const action = personActedOn(sql, row.subjectId, row.at, new Date(Date.parse(row.at) + PERSON_WINDOW_MS).toISOString());
    if (!action) return null;
    return verdict('direct', true, 'A person stepped in on the chat after the flag', { route: action.route, at: action.at });
  },

  'palette.intent': (row) => {
    const action = row.paletteAction;
    const answer = choiceOf(row, 'command');
    if (!action || !answer) return null;
    const detail = { action: action.action, commandId: action.commandId };
    if (answer !== 'none') {
      const proposed = action.action === 'proposed';
      return verdict('direct', proposed, proposed ? 'The person ran the proposed command' : action.action === 'other' ? 'The person ran another command' : 'The person dismissed the palette', detail);
    }
    // "No command" is right when nothing listed ran: a dismissal, or a command the palette did not offer
    const listed = Array.isArray(row.state.commands) ? (row.state.commands as Array<{ id?: unknown }>).some((c) => c.id === action.commandId) : false;
    const right = action.action === 'dismissed' || (action.action === 'other' && !listed);
    return verdict('direct', right, right ? 'No command was proposed and none of the listed ones ran' : 'A listed command ran where none was proposed', detail);
  },

  'notification.urgency': (row) => {
    const urgency = choiceOf(row, 'urgency');
    if (!urgency) return null;
    const start = Date.parse(row.at);
    const opened = row.openedAt ? Date.parse(row.openedAt) : null;
    const withinMs = opened !== null && Number.isFinite(opened) ? opened - start : null;
    const inTime = withinMs !== null && withinMs <= NOTIFICATION_WINDOW_MS;
    const detail = { urgency, openedAt: row.openedAt, withinMs };
    // An acted answer set the push's priority, and a raised push interrupts: the open it made more
    // likely is the decision's own doing. A shadow or held-out row went out as today's push
    if (inTime) return verdict(row.acted ? 'proxy' : 'direct', urgency === 'high', urgency === 'high' ? 'A raised notification was opened within the hour' : 'A normal notification was opened within the hour', detail);
    // A push nobody tapped says nothing: people ignore most of them, the app may have been opened some
    // other way, and no push may have reached a device at all. Counting that as "normal was right"
    // made the score mostly the share of normal answers, so only an open is a signal.
    return null;
  },

  'orchestration.model': (row, sql) => {
    if (!row.answers || !row.subjectId) return null;
    const found = sql
      .prepare("SELECT json FROM orchestrations WHERE created_at >= ? AND json_extract(json, '$.plannerRunId') = ? ORDER BY created_at LIMIT 1")
      .get(row.at, row.subjectId) as { json: string } | undefined;
    const orch = found ? parse(found.json) : null;
    if (!orch) return null;
    const tasks = Array.isArray(orch.tasks) ? (orch.tasks as Array<Record<string, unknown>>) : [];
    const detail: Array<{ task: string; suggested: string; launched: string | null; kept: boolean; status: string }> = [];
    let judged = 0;
    let right = 0;
    for (const [taskId, answer] of Object.entries(row.answers)) {
      if (answer.kind !== 'choice') continue;
      const task = tasks.find((t) => t.id === taskId);
      if (!task) continue;
      const status = String(task.status ?? '');
      if (STILL_GOING.has(status)) return null;
      const launched = typeof task.model === 'string' ? task.model : typeof orch.model === 'string' ? orch.model : null;
      const kept = launched === answer.value;
      detail.push({ task: taskId, suggested: answer.value, launched, kept, status });
      if (status !== 'completed' && status !== 'failed') continue;
      const completed = status === 'completed';
      const verdictOf = modelVerdict(answer.value, launched, kept, completed);
      if (verdictOf === null) continue;
      judged += 1;
      if (verdictOf) right += 1;
    }
    if (judged === 0) return null;
    return verdict('proxy', right * 2 >= judged, `${right} of ${judged} model suggestions matched how the tasks ended`, { judged, right, tasks: detail });
  },
};

// Both are judged on the card the chat worked on: QA rejecting on the change
const viaItemOfChat: Resolver = (row, sql) => {
  if (flagged(row).length === 0) return null;
  const itemId = itemOfChat(sql, row.subjectId);
  const verify = itemId ? nextVerify(sql, itemId, row.at) : null;
  if (!verify) return null;
  const rejected = verify.outcome === 'rejected';
  return verdict('proxy', rejected, rejected ? 'QA rejected the card after the flag' : 'QA passed the card', { verify: verify.outcome });
};
/**
 * `checks.fix`: judged by what the rollup read after the head the failures were seen on. A new head
 * that passes says the branch was at fault and a fix worked; the same head turning green on its own
 * says it was a flake. Anything else is not known yet.
 */
RESOLVERS['checks.fix'] = (row, sql) => {
  const answer = choiceOf(row, 'fix');
  const asked = typeof row.state.headSha === 'string' ? row.state.headSha : null;
  if (!answer || !asked || !row.subjectId) return null;
  const snapshot = sql
    .prepare('SELECT s.head_sha, s.rollup FROM change_request_snapshots s JOIN work_item_pull_requests p ON p.id = s.cr_id WHERE p.item_id = ? ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1')
    .get(row.subjectId) as { head_sha: string | null; rollup: string | null } | undefined;
  if (!snapshot || snapshot.rollup !== 'passing') return null;
  if (snapshot.head_sha === asked) return verdict('direct', answer === 'not-branch', 'The same head turned passing without a change', { rollup: 'passing', pushed: false });
  const fixable = answer === 'branch-fixable';
  return verdict(row.acted ? 'proxy' : 'direct', fixable, 'A new head turned the checks passing', { rollup: 'passing', pushed: true });
};

/**
 * `account.model-fallback`: judged by what the person did with the mapping. The same pair accepted
 * in `model-fallbacks.json` says the suggestion was right, another target for the same model says
 * it was not; until one of them exists the row waits, and "none" says nothing a later event could
 * confirm.
 */
RESOLVERS['account.model-fallback'] = (row, _sql, _now, context) => {
  const suggested = choiceOf(row, 'model');
  const from = typeof row.state.model === 'string' ? row.state.model : null;
  if (!suggested || suggested === 'none' || !from) return null;
  const accepted = context.modelFallbacks().find((f) => f.from === from);
  if (!accepted) return null;
  const right = accepted.to === suggested;
  return verdict('direct', right, right ? 'The person accepted the suggested model' : 'The person mapped the model to another one', { from, suggested, accepted: accepted.to });
};

RESOLVERS['health.test-weakening'] = viaItemOfChat;
RESOLVERS['changes.unexplained-hunk'] = viaItemOfChat;

export const RESOLVED_POINTS: readonly DecisionPointId[] = Object.keys(RESOLVERS) as DecisionPointId[];

/**
 * Whether each resolver can ever return a `direct` outcome, declared beside the resolvers so the two
 * move together (a test reads every resolver's own source against it). A point declared false, or
 * with no resolver at all, can never earn evidence from what the app observes: only a person's
 * useful / not useful proves it (D6 of docs/plans/decision-engine-v2.md).
 */
export const DIRECT_OUTCOMES: Readonly<Partial<Record<DecisionPointId, boolean>>> = {
  'flow.refine-needed': true,
  'flow.criteria-precheck': false,
  'flow.bounce': true,
  'context.compact': true,
  'flow.restart': true,
  'flow.criteria-merge': true,
  'team.assign': true,
  'run.continuation': true,
  'orchestration.retry': true,
  'orchestration.fixer': true,
  'review.depth': false,
  'supervisor.intervene': true,
  'memory.triage': true,
  'assistant.rerank': true,
  'assistant.sources': true,
  'journal.relevance': false,
  'lesson.mine': true,
  'board.triage': true,
  'flow.scope-drift': false,
  'health.semantic-loop': true,
  'palette.intent': true,
  'notification.urgency': true,
  'orchestration.model': false,
  'checks.fix': true,
  'account.model-fallback': true,
  'health.test-weakening': false,
  'changes.unexplained-hunk': false,
};

/** Whether an outcome the app infers can ever count as this point's evidence; served as `evidencePossible` */
export const evidencePossible = (point: DecisionPointId): boolean => DIRECT_OUTCOMES[point] === true;

/** A point's resolver, for the test that holds {@link DIRECT_OUTCOMES} to what each resolver can return */
export const resolverOf = (point: DecisionPointId): Resolver | undefined => RESOLVERS[point];

/** The events after which an outcome may have become known */
const EVENTS = /^(flow\.|orchestration\.|workitem\.|change-request\.|memory\.|lesson\.|assistant\.|supervisor\.|run\.ended$|health\.)/;

/** Rows one pass reads in all, shared between the points */
const SWEEP_MAX = 500;
const SWEEP_EVERY_MS = 5 * 60_000;
const DEBOUNCE_MS = 2_000;
/** Slack past a signal's window, for a pass that was late (the app was closed) */
const REACH_GRACE_MS = 6 * 3_600_000;

/**
 * How long after its row a point's outcome can still arrive. Past it the resolver cannot return
 * anything but null, so the sweep stops reading the row (thousands of them crowded the others out).
 * A point absent here has no such limit.
 */
const REACH_MS: Partial<Record<DecisionPointId, number>> = {
  'health.semantic-loop': PERSON_WINDOW_MS + REACH_GRACE_MS,
};

/** Points whose resolver judges only a flag: a row with no "yes" in its answers waits for ever, so it is not read */
const FLAG_ONLY: ReadonlySet<DecisionPointId> = new Set<DecisionPointId>(['health.semantic-loop', 'health.test-weakening', 'changes.unexplained-hunk', 'flow.scope-drift']);
/** What else a row must have for its resolver to ever say anything: a push nobody opened has no outcome, now or later */
const NEEDS_SQL: Partial<Record<DecisionPointId, string>> = { 'notification.urgency': 'AND opened_at IS NOT NULL' };
const FLAGGED_SQL = "AND EXISTS (SELECT 1 FROM json_each(decisions.answers) WHERE json_extract(json_each.value, '$.value') = 1)";

export interface DecisionResolversDeps {
  sql: Sql;
  db: { decision(id: string): DecisionRecord | null };
  engine: { resolve(decisionId: string, outcome: DecisionResolution): void };
  historyDays: () => number;
  /** The accepted model mappings; absent reads as none */
  modelFallbacks?: () => readonly ModelFallback[];
  now?: () => Date;
}

/**
 * Finds the answered rows still waiting for an outcome and resolves the ones whose signal has
 * arrived. It runs shortly after the events above and every few minutes, so signals that are only
 * the passing of time (a card left alone) are found too. It never throws into the caller.
 */
export class DecisionResolvers {
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;

  private readonly deps: DecisionResolversDeps;

  constructor(deps: DecisionResolversDeps) {
    this.deps = deps;
  }

  /** Per point, the `seq` the last read stopped at: the next one goes on from there, and wraps at the end */
  private readonly cursors = new Map<DecisionPointId, number>();

  /**
   * Resolves what can be resolved now; returns how many rows it resolved. Each point gets an equal
   * share of {@link SWEEP_MAX}, its oldest unresolved rows first and from where its last read
   * stopped, so a point with thousands of rows that cannot resolve neither crowds out the others nor
   * keeps its own newer rows from being read. What a point does not fill goes to the points that did.
   */
  sweep(): number {
    const now = this.deps.now?.() ?? new Date();
    const since = new Date(now.getTime() - this.deps.historyDays() * 86_400_000).toISOString();
    let resolved = 0;
    try {
      const share = Math.max(1, Math.floor(SWEEP_MAX / RESOLVED_POINTS.length));
      let used = 0;
      const full: DecisionPointId[] = [];
      const read = (point: DecisionPointId, limit: number): number => {
        const rows = this.unresolved(point, since, now.getTime(), limit);
        for (const id of rows) resolved += this.resolveRow(id, now.getTime());
        used += rows.length;
        return rows.length;
      };
      for (const point of RESOLVED_POINTS) if (read(point, share) >= share) full.push(point);
      // What the quiet points left unread goes to the ones that filled their share
      const extra = full.length ? Math.floor((SWEEP_MAX - used) / full.length) : 0;
      if (extra > 0) for (const point of full) read(point, extra);
    } catch {
      // The database may be closed at shutdown
    }
    return resolved;
  }

  /** The ids of up to `limit` unresolved rows of a point after its cursor, oldest first; moves the cursor */
  private unresolved(point: DecisionPointId, since: string, nowMs: number, limit: number): string[] {
    const reach = REACH_MS[point];
    const from = reach === undefined ? since : new Date(Math.max(Date.parse(since), nowMs - reach)).toISOString();
    const rows = this.deps.sql
      .prepare(
        `SELECT id, seq FROM decisions WHERE point = ? AND outcome IS NULL AND status = 'answered' AND answers IS NOT NULL AND at >= ? AND seq > ? ${FLAG_ONLY.has(point) ? FLAGGED_SQL : ''} ${NEEDS_SQL[point] ?? ''} ORDER BY seq LIMIT ?`,
      )
      .all(point, from, this.cursors.get(point) ?? 0, limit) as unknown as Array<{ id: string; seq: number }>;
    // A short read reached the end: the next pass starts again from the oldest
    this.cursors.set(point, rows.length < limit ? 0 : (rows[rows.length - 1]?.seq ?? 0));
    return rows.map((r) => r.id);
  }

  /** 1 when the row's outcome is known now and was recorded */
  private resolveRow(id: string, nowMs: number): number {
    const row = this.deps.db.decision(id);
    const resolver = row ? RESOLVERS[row.point] : undefined;
    if (!row || !resolver) return 0;
    try {
      const outcome = resolver(row, this.deps.sql, nowMs, { modelFallbacks: this.deps.modelFallbacks ?? (() => []) });
      if (!outcome) return 0;
      this.deps.engine.resolve(id, outcome);
      return 1;
    } catch {
      // One row whose signal cannot be read must not hold the others back
      return 0;
    }
  }

  observe(event: ClaudioEvent): void {
    if (EVENTS.test(event.type)) this.soon();
  }

  /** Schedules the debounced sweep; a signal recorded outside the event bus calls it too */
  soon(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.sweep();
    }, DEBOUNCE_MS);
    this.debounce.unref();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
  }
}
