import { randomUUID } from 'node:crypto';
import { isRecord, type ChatMessageSource, type DecisionMode, type HealthSignal, type HealthSignalAgent, type HealthSignalKind, type RelayTarget, type SupervisorConfig, type SupervisorProposal, type SupervisorProposalSender, type ToolPreset, type TranscriptEntry } from '@claudio/shared';
import { isTransientRefusal } from './chat-errors.ts';
import { DEFAULT_TOOL_PRESETS } from './chat-tools.ts';
import type { ChatRuntime } from './chats.ts';
import type { Db } from './db.ts';
import { SUPERVISOR_POINT, type DecisionSettingsStore } from './decisions/settings.ts';
import { runRef } from './event-sources.ts';
import type { ClaudioEventInput } from './events.ts';
import { occurrenceOf, type TaskContext } from './health-service.ts';
import { pasted, PASTED_NOTE, thinkThrough } from './prompt-rules.ts';
import { stanceOf, type DecisionAsker } from './decisions/stance.ts';
import { NotFoundError } from '@claudio/shared';

// The optional supervisor of docs/plans/agent-observability.md §3. When a worker's health turns
// bad, a small model reads the signal and the worker's last steps and drafts a hint of a line or
// two. It is a housekeeping chat of the CLI like the planner, never a call of its own to a model.
//
// Its one control is the `supervisor.intervene` point (docs/plans/settings-ia.md §7.2): Off, it does
// not watch; Shadow, it proposes hints for a person to send; Active, it acts on its own for the signal
// kinds its options list (`supervisor.autoSignals`) and proposes for the rest, and under Jev only when
// the engine does not decline. The model is the engine's CLI model and the cap its own
// (`cli.supervisorMaxCostUsd`), since the hint is always drafted by the CLI.
//
// The draft decides first whether the worker is stuck at all (docs/plans/decision-engine-v2.md §6):
// most of what woke it was a worker waiting on a command doing work, on CI or on agents it delegated
// to, and a hint there only interrupts. A draft that says so sends nothing and proposes nothing.
// It does not close the occurrence either: a build that was honest work at minute twenty can hang for
// hours after, so a "not stuck" occurrence is drafted again after a back-off ({@link notStuckDue}), up
// to {@link NOT_STUCK_MAX_DRAFTS} drafts, and a later draft that finds it stuck is an ordinary proposal.
//
// What it answers is one occurrence of a signal (D5 of docs/plans/regression-fixes-2026-10-29.md):
// the call a signal is about, or when it started. A hint is a message the agent reads only once the
// call it is blocked in returns, so for a hung command Active cancels the command with the hint as
// the reason, and sends the hint only when the cancel is refused. A signal about a subagent's call
// names that agent; the hint goes to the lead, the only one Claudio can write to, and asks it to
// relay the hint or stop the agent.

/** The shipped `read-only` preset, for an install whose person deleted theirs: the supervisor reads, never writes. */
export const DEFAULT_SUPERVISOR_PRESET: ToolPreset = DEFAULT_TOOL_PRESETS.find((p) => p.id === 'read-only') ?? {
  id: 'read-only',
  name: 'Read only',
  allowedTools: ['Read', 'Glob', 'Grep'],
  disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
};

/**
 * The tools a confined chat is given (`--tools`) for a preset's permission rules: each rule's tool
 * name, a rule with a pattern read as its tool. The rules themselves stay the allow list, so under
 * `dontAsk` only what they name runs.
 */
export function toolsOfRules(rules: readonly string[]): string[] {
  return [...new Set(rules.map((rule) => rule.replace(/\(.*$/s, '').trim()).filter(Boolean))];
}

/**
 * The deprecated `PUT /settings/supervisor` body as the point's mode: `enabled` and `autoSend` map
 * onto it, and the model and the cap, which are the engine's now, are ignored.
 */
export function supervisorModeOf(input: unknown): DecisionMode {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('the supervisor settings must be a JSON object');
  const body = input as Record<string, unknown>;
  if (typeof body.enabled !== 'boolean') throw new Error('enabled must be true or false');
  if (body.autoSend !== undefined && typeof body.autoSend !== 'boolean') throw new Error('autoSend must be true or false');
  if (!body.enabled) return 'off';
  return body.autoSend === true ? 'active' : 'shadow';
}

/** What the housekeeping chat is asked, and where. */
export interface SupervisorQuestion {
  prompt: string;
  /** The worker's own directory, so a look at a file it names is a look at the right one */
  cwd: string;
  model: string;
  /** `cli.supervisorMaxCostUsd`, as `--max-budget-usd` */
  maxCostUsd: number;
  /** What the answer is held to (`--json-schema`): {@link SUPERVISOR_SCHEMA} */
  jsonSchema: Record<string, unknown>;
}

/** What it answered (the CLI's `structured_output`), and what the CLI said it cost. */
export interface SupervisorAnswer {
  structured: unknown;
  costUsd: number;
  isError: boolean;
}

/**
 * The draft's contract: whether the worker is stuck, and the hint when it is. No field for reasons:
 * a prompt that asks for written reasoning can be refused (docs/prompts.md, point 1).
 */
export const SUPERVISOR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    stuck: { type: 'boolean', description: 'Whether the agent is stuck: true only when it is not getting anywhere by itself' },
    hint: { type: 'string', description: 'When stuck, one or two short lines addressed to the agent; empty when it is not stuck' },
  },
  required: ['stuck', 'hint'],
  additionalProperties: false,
};

/** What a draft comes to: nothing to send, or the hint to propose */
export type SupervisorDraft = { stuck: false } | { stuck: true; hint: string };

/** The signals about one command still running, which Active answers by cancelling it */
const COMMAND_SIGNALS: ReadonlySet<HealthSignalKind> = new Set(['hung-command', 'repeat-stall']);
/** A question that failed is asked again after this long: one broken answer is not the last word on a long chat */
export const FAILED_RETRY_MS = 15 * 60_000;
/** A "not stuck" occurrence that is not a running command is drafted again after this long: longer than a failed draft's wait, since this one was answered */
export const NOT_STUCK_RETRY_MS = 60 * 60_000;
/** Drafts per occurrence, the first included: a worker judged not stuck this often is left to the person */
export const NOT_STUCK_MAX_DRAFTS = 4;
/** Between tries of a question refused for room (a full slot, short memory) */
export const ROOM_RETRY_MS = 15_000;
/** How long a question waits for room before it gives up for now; the next announcement asks again */
export const ROOM_WAIT_MS = 5 * 60_000;

export interface SupervisorDeps {
  /** The decision settings: the point's mode, who answers, and the CLI model and cap the hint is drafted with */
  settings: Pick<DecisionSettingsStore, 'get' | 'setPointMode'>;
  db: Db;
  /** Runs the housekeeping chat to its result; a test puts a fake here, never a real model */
  ask: (question: SupervisorQuestion) => Promise<SupervisorAnswer>;
  /**
   * The newest entries of the worker's transcript, oldest first; with `agent`, those of that
   * subagent's branch (its sidechain), which is where the call the signal is about was made
   */
  steps: (chatId: string, agent?: HealthSignalAgent) => Promise<TranscriptEntry[]>;
  /**
   * Delivers a proposal's hint to its worker through the hint route of the chat or the task:
   * `person` when someone pressed Send on it, `supervisor` when it went out on its own (C2)
   */
  hint: (proposal: SupervisorProposal, source: Extract<ChatMessageSource, 'person' | 'supervisor'>) => Promise<void>;
  /**
   * Writes straight to one subagent (the claudio-bridge mod) and resolves with whether it was
   * delivered, waiting for the answer for a bounded time. Rejects when the message is refused up
   * front (chat not live, subagent stopped or unknown). Absent, a hint about a subagent goes to the lead.
   */
  messageAgent?: (chatId: string, agentId: string, words: string, source: Extract<ChatMessageSource, 'person' | 'supervisor'>) => Promise<{ delivered: boolean }>;
  /**
   * Hands the proposal's lead (the chat's, or the task's worker) the hint framed as a message to pass on
   * to `target` (`relayToSubagent`), which the page draws as a system row and not as a hint. Absent, the
   * lead is sent `relayHint` through `hint`, as before.
   */
  relay?: (proposal: SupervisorProposal, target: RelayTarget, words: string, source: Extract<ChatMessageSource, 'person' | 'supervisor'>) => Promise<void>;
  /**
   * Cancels the command `toolUseId` of the proposal's chat with its hint as the reason: the failed
   * result reaches the agent blocked in it, which a message would not until the call returned.
   * Rejects when the cancel is refused (the command ended, its process cannot be told apart).
   */
  cancel?: (proposal: SupervisorProposal, toolUseId: string) => Promise<void>;
  emit: (event: ClaudioEventInput) => void;
  /** Adds what the supervisor spent on a task's worker to its graph */
  charge: (orchestrationId: string, costUsd: number) => void;
  /** The decision engine `supervisor.intervene` asks; absent, the point is off */
  decisions?: DecisionAsker;
  /** The daily spend cap lets a new call be made; without it every call may. Over the cap health still shows, and nothing is asked. */
  spendOpen?: () => boolean;
  /** Between tries of a question refused for room; {@link ROOM_RETRY_MS} when absent */
  roomRetryMs?: number;
  /** How long a question waits for room; {@link ROOM_WAIT_MS} when absent */
  roomWaitMs?: number;
  /** The clock failed questions expire on; a test hands its own */
  now?: () => number;
}

/** Where a proposal is acted on from: the chat, or the task of the graph whose worker it is. */
export type ProposalOwner = { chatId: string } | { orchestrationId: string; taskId: string };

export class SupervisorConflictError extends Error {
  readonly statusCode = 409;
}

/** How much of the worker's recent history the supervisor reads. */
const STEPS = { calls: 12, inputChars: 300, resultLines: 6, resultChars: 600, messageChars: 1200, errorChars: 200 } as const;
/** A hint is a line or two; what comes back past that is cut rather than sent to the worker. */
const HINT_MAX_CHARS = 400;

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function resultLines(text: string): string {
  const lines = text.trim().split('\n');
  const kept = lines.length > STEPS.resultLines ? [...lines.slice(0, STEPS.resultLines), `… (${String(lines.length - STEPS.resultLines)} more lines)`] : lines;
  return cut(kept.join('\n'), STEPS.resultChars);
}

/**
 * Whether an entry is one of the agent's own: the lead's when `agent` is null, else that subagent's
 * branch. The steps the supervisor reads are those of whoever made the call it was told about.
 */
const ownEntry = (entry: TranscriptEntry, agent: string | null): boolean => (agent === null ? !entry.isSidechain : entry.parentToolUseId === agent);

/**
 * The agent's last steps as the supervisor reads them: its latest tool calls, each with its input
 * and the start of its result, and the last thing it said. `agent` is the lead's call that launched
 * the subagent the signal is about; null reads the lead's own steps and leaves every subagent out.
 */
export function lastSteps(entries: readonly TranscriptEntry[], agent: string | null = null): string {
  const calls: Array<{ id: string; name: string; input: string; result: string | null; isError: boolean }> = [];
  const byId = new Map<string, (typeof calls)[number]>();
  let message = '';
  for (const entry of entries) {
    if (!ownEntry(entry, agent)) continue;
    for (const block of entry.blocks) {
      if (block.type === 'tool_use') {
        const call = { id: block.id, name: block.name, input: cut(JSON.stringify(block.input ?? {}), STEPS.inputChars), result: null, isError: false };
        calls.push(call);
        byId.set(block.id, call);
      } else if (block.type === 'tool_result') {
        const call = byId.get(block.toolUseId);
        if (call) Object.assign(call, { result: resultLines(block.content), isError: block.isError });
      } else if (block.type === 'text' && entry.role === 'assistant' && block.text.trim()) {
        message = block.text.trim();
      }
    }
  }
  const out: string[] = [];
  for (const call of calls.slice(-STEPS.calls)) {
    out.push(`- ${call.name} ${call.input}`);
    out.push(call.result === null ? '  (still running)' : `  ${call.isError ? 'failed: ' : ''}${call.result.replace(/\n/g, '\n  ')}`);
  }
  if (message) out.push('', 'Its last message:', cut(message, STEPS.messageChars));
  return out.join('\n') || '(nothing recorded yet)';
}

/** The tool calls `supervisor.intervene` reads: names and the head of an error, never inputs or file contents */
export function callsOf(entries: readonly TranscriptEntry[], agent: string | null = null): Array<{ tool: string; error?: string }> {
  const calls: Array<{ tool: string; error?: string }> = [];
  const byId = new Map<string, (typeof calls)[number]>();
  for (const entry of entries) {
    if (!ownEntry(entry, agent)) continue;
    for (const block of entry.blocks) {
      if (block.type === 'tool_use') {
        const call = { tool: block.name };
        calls.push(call);
        byId.set(block.id, call);
      } else if (block.type === 'tool_result' && block.isError) {
        const call = byId.get(block.toolUseId);
        if (call) Object.assign(call, { error: cut(block.content.trim(), STEPS.errorChars) });
      }
    }
  }
  return calls.slice(-STEPS.calls);
}

/** How a hint names a subagent to its lead: by what the lead's `Agent` call said it was for */
const agentName = (agent: HealthSignalAgent): string => agent.description?.trim() || agent.subagentType || agent.parentToolUseId;

export function supervisorPrompt(signal: HealthSignal, steps: string, task: TaskContext | null, model: string | null = null): string {
  const agent = signal.agent;
  const who = agent ? 'subagent' : 'agent';
  return [
    `You are watching an AI coding agent${task ? ' working on a task of an orchestration' : ''}. Claudio's health checks flagged it:`,
    ...(task ? ['', 'The task, as it is named:', pasted(task.taskName)] : []),
    ...(agent ? ['', `The call was made by a subagent the agent launched${agent.subagentType ? ` (type ${agent.subagentType})` : ''}, described as:`, pasted(agentName(agent))] : []),
    '',
    `${signal.kind}: ${signal.reason}`,
    ...(signal.detail ? [`Detail: ${signal.detail}`] : []),
    ...(signal.hint ? [`Claudio's generic suggestion: ${signal.hint}`] : []),
    '',
    agent ? "The subagent's last steps, as its branch of the transcript records them:" : 'Its last steps, as its transcript records them:',
    pasted(steps),
    '',
    PASTED_NOTE,
    '',
    `First decide whether the ${who} is stuck at all. The health check measures time and repetition, not intent, so it often fires on honest work. ` +
      `The ${who} is not stuck when it is waiting on something that is doing work: a command or a batch of calls still running ` +
      'as such work takes (a build, a test suite, an install), CI or a review it is polling, or agents and tasks it delegated and is waiting for. ' +
      'It is stuck when it repeats something that keeps failing the same way, waits on something that will never answer ' +
      '(a server that is not running, a prompt nobody will answer, a command in watch mode), or has stopped moving towards its goal.',
    '',
    `Answer in the structured result. \`stuck\`: whether it is stuck. \`hint\`: when it is stuck, one or two short lines addressed to the ${who}, ` +
      'specific to what it is doing, saying what to check or do differently, with no preamble; when it is not stuck, an empty string. ' +
      'Do not change anything yourself.',
    ...thinkThrough(model),
  ].join('\n');
}

/** Reads the structured answer; null when it is not one the contract allows, which counts as a failed question */
export function draftOf(structured: unknown): SupervisorDraft | null {
  if (!isRecord(structured) || typeof structured.stuck !== 'boolean') return null;
  if (!structured.stuck) return { stuck: false };
  const hint = typeof structured.hint === 'string' ? hintFrom(structured.hint) : '';
  return hint ? { stuck: true, hint } : null;
}

/** The answer made fit to send: the first two lines that say something, and no more than a hint needs. */
export function hintFrom(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2);
  return cut(lines.join('\n'), HINT_MAX_CHARS);
}

/** How a relayed hint begins: a stored hint that starts so was already written for the lead */
const RELAY_START = 'Your background agent `';

/**
 * The hint as the lead reads it, for a signal about one of its subagents: the lead is asked to pass it on
 * with its own tools, or to stop the agent (C3). It is the fallback when a direct write to the
 * subagent is refused or undelivered (D7).
 */
export function relayHint(agent: HealthSignalAgent, hint: string): string {
  const name = agentName(agent).replace(/`/g, "'");
  return `${RELAY_START}${name}\` is stuck. Relay this to it with SendMessage, or stop it if it cannot get past it: ${hint}`;
}

/** Whether a proposal already answers this occurrence: its own kind, or the other signal about the same command */
function answers(proposal: SupervisorProposal, signal: HealthSignal, occurrence: string): boolean {
  if (proposal.signal === signal.kind && (proposal.occurrence ?? '') === occurrence) return true;
  // A hung command that is also the third stall of its kind is one thing to act on, not two
  return !!signal.toolUseId && COMMAND_SIGNALS.has(signal.kind) && COMMAND_SIGNALS.has(proposal.signal) && proposal.occurrence === signal.toolUseId;
}

/**
 * Whether a `not-stuck` answer is due to be drafted again. A running command is asked again once its
 * running time has doubled since the answer (twenty minutes in, at forty; forty, at eighty), which
 * follows the command's own pace; anything else after {@link NOT_STUCK_RETRY_MS}. Both read the row's
 * `at`, the time of its latest answer, so the back-off survives a restart.
 */
export function notStuckDue(answer: Pick<SupervisorProposal, 'at'>, signal: Pick<HealthSignal, 'kind' | 'toolUseId' | 'since'>, nowMs: number): boolean {
  const answeredAt = Date.parse(answer.at);
  if (!Number.isFinite(answeredAt)) return false;
  const since = signal.since ? Date.parse(signal.since) : Number.NaN;
  if (signal.toolUseId && COMMAND_SIGNALS.has(signal.kind) && Number.isFinite(since) && answeredAt > since) {
    return nowMs - since >= 2 * (answeredAt - since);
  }
  return nowMs - answeredAt >= NOT_STUCK_RETRY_MS;
}

/** Today's rule for `supervisor.intervene`, as the row's baseline: a hint is drafted, so nothing is declined */
const DRAFT_BASELINE = false;

/** Who answers the point; a settings read that fails is no provider, and nothing is asked */
function providerOf(engine: DecisionAsker): string | null {
  try {
    return engine.effective(SUPERVISOR_POINT, null).provider;
  } catch {
    return null;
  }
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * Wakes on a worker's bad health, once per occurrence of a signal per chat, and keeps what it
 * proposed as a row. The rule lives in the store (a unique key on chat, signal and occurrence), so
 * neither a monitor tick nor a restart asks twice about the same thing; the one exception is an
 * occurrence a draft found not stuck, asked again on the same row after its back-off.
 */
export class Supervisor {
  /** Occurrences being asked about right now: the monitor can announce again before the answer is in */
  private readonly asking = new Set<string>();
  /**
   * Occurrences not to ask about again before a time: a failed question for {@link FAILED_RETRY_MS},
   * one the engine declined for {@link NOT_STUCK_RETRY_MS} (its "no hint helps" is an answer, like a
   * "not stuck" draft, and the monitor wakes a chat that stays bad every few minutes)
   */
  private readonly failed = new Map<string, number>();

  constructor(private readonly deps: SupervisorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private mode(): DecisionMode {
    return this.deps.settings.get().points[SUPERVISOR_POINT]?.mode ?? 'off';
  }

  /**
   * Whether Active may act on this kind of signal by itself. Standing is earned per point, not per
   * signal kind, so the kinds that have earned it are the owner's list; none by default.
   */
  private actsOn(kind: HealthSignalKind): boolean {
    return this.deps.settings.get().supervisor.autoSignals.includes(kind);
  }

  /** The view of the deprecated `GET /settings/supervisor`, derived from the point and the engine */
  get config(): SupervisorConfig {
    const settings = this.deps.settings.get();
    const mode = settings.points[SUPERVISOR_POINT]?.mode ?? 'off';
    return { enabled: mode !== 'off', model: settings.cli.model, autoSend: mode === 'active', maxCostUsd: settings.cli.supervisorMaxCostUsd };
  }

  /** The deprecated `PUT /settings/supervisor`: sets the point's mode; a proposal already made keeps the cost and status it has. */
  async configure(input: unknown): Promise<SupervisorConfig> {
    await this.deps.settings.setPointMode(SUPERVISOR_POINT, supervisorModeOf(input));
    return this.config;
  }

  /** Whether an occurrence already answered is to be drafted again: only a `not-stuck` one, after its back-off and under the cap */
  private redraftDue(answer: SupervisorProposal, signal: HealthSignal): boolean {
    if (answer.status !== 'not-stuck' || !notStuckDue(answer, signal, this.now())) return false;
    return this.deps.db.proposalAsks(answer.id) < NOT_STUCK_MAX_DRAFTS;
  }

  /** Whether a question about `key` failed recently enough not to be asked again yet; an old failure is forgotten */
  private failedRecently(key: string): boolean {
    const until = this.failed.get(key);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.failed.delete(key);
    return false;
  }

  /**
   * Asks about the worst bad signal whose occurrence it has not asked about yet for this chat, and
   * records the answer. Resolves with the proposal, or null when there was nothing to ask, no usable
   * answer, or no room to ask in (which is not a failure: the next announcement asks again).
   */
  async wake(chat: ChatRuntime, task: TaskContext | null, signals: readonly HealthSignal[]): Promise<SupervisorProposal | null> {
    const settings = this.deps.settings.get();
    const mode = settings.points[SUPERVISOR_POINT]?.mode ?? 'off';
    // Housekeeping is not supervised: that would be the supervisor watching itself
    if (mode === 'off' || chat.origin === 'internal') return null;
    // Not recorded as asked either: once the cap lets go, the next announcement of the signal asks
    if (this.deps.spendOpen?.() === false) return null;
    const proposals = this.deps.db.proposalsOf(chat.id);
    const keyOf = (s: HealthSignal) => `${chat.id}:${s.kind}:${occurrenceOf(s)}`;
    const answerOf = (s: HealthSignal): SupervisorProposal | undefined => proposals.find((p) => answers(p, s, occurrenceOf(s)));
    const signal = signals.find((s) => {
      if (s.level !== 'bad') return false;
      const key = keyOf(s);
      if (this.asking.has(key) || this.failedRecently(key)) return false;
      const answer = answerOf(s);
      return !answer || this.redraftDue(answer, s);
    });
    if (!signal) return null;
    // Set when this is a "not stuck" occurrence asked again: its row takes the new answer
    const previous = answerOf(signal) ?? null;
    const key = keyOf(signal);
    const agent = signal.agent ?? null;
    this.asking.add(key);
    try {
      const entries = await this.deps.steps(chat.id, signal.agent).catch((): TranscriptEntry[] => []);
      // A worker the decision says no hint can help gets none; the signal itself stays on the chat
      if (await this.declined(chat, signal, entries)) {
        this.failed.set(key, this.now() + NOT_STUCK_RETRY_MS);
        return null;
      }
      const steps = lastSteps(entries, agent?.parentToolUseId ?? null);
      const answer = await this.askForRoom({
        prompt: supervisorPrompt(signal, steps, task, settings.cli.model),
        cwd: chat.workingDir,
        model: settings.cli.model,
        maxCostUsd: settings.cli.supervisorMaxCostUsd,
        jsonSchema: SUPERVISOR_SCHEMA,
      });
      // No room came free in time: nothing was spent and nothing failed
      if (!answer) return null;
      const costUsd = Number.isFinite(answer.costUsd) && answer.costUsd > 0 ? answer.costUsd : 0;
      // Spent whether or not the answer is usable, so it counts either way
      if (task && costUsd > 0) this.deps.charge(task.orchestrationId, costUsd);
      const draft = answer.isError ? null : draftOf(answer.structured);
      if (!draft) {
        this.failed.set(key, this.now() + FAILED_RETRY_MS);
        return null;
      }
      const at = new Date(this.now()).toISOString();
      const occurrence = previous ? previous.occurrence : occurrenceOf(signal);
      const base = {
        id: previous?.id ?? randomUUID(),
        chatId: chat.id,
        ...(task ? { taskId: task.taskId, orchestrationId: task.orchestrationId } : {}),
        // A row asked again keeps the kind and occurrence it is stored under: the store's unique key
        signal: previous?.signal ?? signal.kind,
        ...(occurrence !== undefined ? { occurrence } : {}),
        ...(agent ? { agent } : {}),
        costUsd,
        at,
      };
      if (!draft.stuck) {
        // Kept as the occurrence's answer, which the store's unique key holds across restarts: nothing
        // reaches the worker or a person, and the occurrence is asked again only after its back-off
        if (previous) this.deps.db.redraftProposal(previous.id, { hint: '', status: 'not-stuck', costUsd, at, agent });
        else this.deps.db.saveProposal({ ...base, hint: '', status: 'not-stuck' });
        return null;
      }
      const hint = draft.hint;
      const proposal: SupervisorProposal = {
        ...base,
        // Stored as the subagent reads it: written to it straight when it can be addressed (D7), else framed
        // for the lead to pass on when it is delivered. Without a relay of its own, the lead's old sentence
        hint: agent && !(agent.agentId && this.deps.messageAgent) && !this.deps.relay ? relayHint(agent, hint) : hint,
        status: 'proposed',
      };
      // A redraft adds its cost to the row's, so the proposal carries the occurrence's whole cost
      let stored: SupervisorProposal | null = null;
      if (!previous) stored = this.deps.db.saveProposal(proposal) ? proposal : null;
      else if (this.deps.db.redraftProposal(previous.id, { hint: proposal.hint, status: 'proposed', costUsd, at, agent })) stored = this.deps.db.proposal(previous.id);
      if (!stored) return null;
      const who = task?.taskName ?? chat.name;
      this.deps.emit({
        type: 'supervisor.proposed',
        title: `${who}: the supervisor proposes a hint`,
        ...runRef(chat),
        taskId: task?.taskId ?? null,
        taskName: task?.taskName ?? null,
        proposal: stored,
      });
      // Read again: a person who switched the point while the hint was being drafted decides. Under
      // Active only the kinds the owner listed are sent on their own; the rest wait for a person
      if (this.mode() !== 'active' || !this.actsOn(signal.kind)) return stored;
      try {
        return await this.act(stored, signal, hint);
      } catch {
        // The worker moved on before the answer came: the proposal stays for a person to judge
        return stored;
      }
    } catch {
      this.failed.set(key, this.now() + FAILED_RETRY_MS);
      return null;
    } finally {
      this.asking.delete(key);
    }
  }

  /**
   * Runs the question, retrying while it is refused for room: a full slot or short memory is what an
   * orchestration at full concurrency looks like, and it frees within minutes. Null when no room
   * came in time, or the point was switched off meanwhile; any other refusal is thrown.
   */
  private async askForRoom(question: SupervisorQuestion): Promise<SupervisorAnswer | null> {
    const deadline = this.now() + (this.deps.roomWaitMs ?? ROOM_WAIT_MS);
    for (;;) {
      try {
        return await this.deps.ask(question);
      } catch (error) {
        if (!isTransientRefusal(error)) throw error;
        if (this.now() >= deadline) return null;
        await pause(this.deps.roomRetryMs ?? ROOM_RETRY_MS);
        if (this.mode() === 'off' || this.deps.spendOpen?.() === false) return null;
      }
    }
  }

  /**
   * What Active does with a proposal. A hung command is cancelled with the hint as the reason: the
   * agent blocked in it gets a failed result carrying the hint, where a message would wait for the
   * call to return. The hint goes as a message only when there is no command to cancel or the
   * cancel is refused. The proposal is marked sent either way, once the worker has it.
   */
  private async act(proposal: SupervisorProposal, signal: HealthSignal, hint: string): Promise<SupervisorProposal> {
    const cancel = this.deps.cancel;
    if (cancel && signal.toolUseId && COMMAND_SIGNALS.has(signal.kind)) {
      try {
        // The failed result reaches the agent that ran the command, the subagent too: the hint is its own words
        await cancel({ ...proposal, hint }, signal.toolUseId);
        if (!this.deps.db.settleProposal(proposal.id, 'sent', 'supervisor')) throw new SupervisorConflictError('the proposal was settled in the meantime');
        return { ...proposal, status: 'sent', sentBy: 'supervisor' };
      } catch (error) {
        if (error instanceof SupervisorConflictError) throw error;
        // Refused: the command ended or cannot be told apart, and a message is what is left
      }
    }
    return this.send(proposal.id, { chatId: proposal.chatId }, 'supervisor');
  }

  /**
   * `supervisor.intervene`: whether the engine declines the hint. It is asked only where its answer
   * can change something: before the hint is drafted, since a "no" saves the draft (a CLI run) and the
   * interruption, and only under Jev. Under the CLI the draft is itself a call that judges the case,
   * and a second CLI answer has no probability to act on. In shadow the row is the point's evidence and
   * nothing waits for it. The answer is used as the engine gives it: it hands answers back only when
   * the point acts, and this point acts by saying no. The baseline is today's rule, "a hint is
   * drafted", which never declines: `false`, as the point's `effect.baselineActs` reads it.
   */
  private async declined(chat: ChatRuntime, signal: HealthSignal, entries: readonly TranscriptEntry[]): Promise<boolean> {
    const engine = this.deps.decisions;
    const stance = stanceOf(engine, SUPERVISOR_POINT, null);
    if (!engine || stance === 'off' || providerOf(engine) !== 'jev') return false;
    const calls = callsOf(entries, signal.agent?.parentToolUseId ?? null);
    const asked = engine
      .ask(SUPERVISOR_POINT, { kind: 'chat', id: chat.id, data: { signal: signal.kind, detail: signal.detail ?? signal.reason, calls } }, { projectId: null, baseline: DRAFT_BASELINE })
      .catch(() => null);
    if (stance === 'watch') return false;
    const outcome = await asked;
    const answer = outcome?.act ? outcome.answers?.intervene : undefined;
    return answer?.kind === 'noul' && !answer.value;
  }

  private owned(id: string, owner: ProposalOwner): SupervisorProposal {
    const proposal = this.deps.db.proposal(id);
    const matches =
      proposal &&
      ('chatId' in owner ? proposal.chatId === owner.chatId : proposal.orchestrationId === owner.orchestrationId && proposal.taskId === owner.taskId);
    if (!proposal || !matches) throw new NotFoundError('proposal not found');
    if (proposal.status !== 'proposed') throw new SupervisorConflictError(`the proposal was already ${proposal.status}`);
    return proposal;
  }

  /**
   * Sends the hint to the worker, then marks it sent: a hint that did not arrive stays proposed. A
   * person's Send makes it theirs; one the Supervisor sends on its own is framed as automatic.
   */
  async send(id: string, owner: ProposalOwner, source: SupervisorProposalSender = 'person'): Promise<SupervisorProposal> {
    const proposal = this.owned(id, owner);
    await this.deliver(proposal, source);
    if (!this.deps.db.settleProposal(id, 'sent', source)) throw new SupervisorConflictError('the proposal was settled in the meantime');
    return { ...proposal, status: 'sent', sentBy: source };
  }

  /**
   * Straight to the subagent when the proposal is about one that can be addressed; once, and only
   * once, through the lead (`relayHint`) when that is refused or comes back undelivered. A hint about
   * the lead itself, or a proposal made before the agent id was known, goes the old way.
   */
  private async deliver(proposal: SupervisorProposal, source: Extract<ChatMessageSource, 'person' | 'supervisor'>): Promise<void> {
    const agent = proposal.agent;
    const direct = this.deps.messageAgent;
    // A proposal stored as the lead's sentence (before the relay had its own frame) goes as it was written
    if (!agent || proposal.hint.startsWith(RELAY_START)) return this.deps.hint(proposal, source);
    if (agent.agentId && direct) {
      try {
        if ((await direct(proposal.chatId, agent.agentId, proposal.hint, source)).delivered) return;
      } catch {
        // Refused up front: the lead can still pass it on, or fail the same way and leave the proposal for a person
      }
    }
    if (this.deps.relay) return this.deps.relay(proposal, { name: agentName(agent), ...(agent.agentId ? { agentId: agent.agentId } : {}) }, proposal.hint, source);
    return this.deps.hint({ ...proposal, hint: relayHint(agent, proposal.hint) }, source);
  }

  dismiss(id: string, owner: ProposalOwner): SupervisorProposal {
    const proposal = this.owned(id, owner);
    if (!this.deps.db.settleProposal(id, 'dismissed')) throw new SupervisorConflictError('the proposal was settled in the meantime');
    return { ...proposal, status: 'dismissed' };
  }
}
