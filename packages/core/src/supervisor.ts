import { randomUUID } from 'node:crypto';
import type { DecisionMode, HealthSignal, HealthSignalAgent, HealthSignalKind, SupervisorConfig, SupervisorProposal, ToolPreset, TranscriptEntry } from '@claudio/shared';
import { isCapacityRefusal } from './chat-errors.ts';
import { DEFAULT_TOOL_PRESETS } from './chat-tools.ts';
import type { ChatRuntime } from './chats.ts';
import type { Db } from './db.ts';
import { SUPERVISOR_POINT, type DecisionSettingsStore } from './decisions/settings.ts';
import { runRef } from './event-sources.ts';
import type { ClaudioEventInput } from './events.ts';
import { occurrenceOf, type TaskContext } from './health-service.ts';
import { pasted, PASTED_NOTE } from './prompt-rules.ts';
import { stanceOf, type DecisionAsker } from './decisions/stance.ts';

// The optional supervisor of docs/plans/agent-observability.md §3. When a worker's health turns
// bad, a small model reads the signal and the worker's last steps and drafts a hint of a line or
// two. It is a housekeeping chat of the CLI like the planner, never a call of its own to a model.
//
// Its one control is the `supervisor.intervene` point (docs/plans/settings-ia.md §7.2): Off, it does
// not watch; Shadow, it proposes hints for a person to send; Active, it acts on its own, and under
// Jev only when the engine expects a hint to help. The model is the engine's CLI model and the cap
// its own (`cli.supervisorMaxCostUsd`), since the hint is always drafted by the CLI.
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
}

/** What it answered, and what the CLI said it cost. */
export interface SupervisorAnswer {
  text: string;
  costUsd: number;
  isError: boolean;
}

/** The signals about one command still running, which Active answers by cancelling it */
const COMMAND_SIGNALS: ReadonlySet<HealthSignalKind> = new Set(['hung-command', 'repeat-stall']);
/** A question that failed is asked again after this long: one broken answer is not the last word on a long chat */
export const FAILED_RETRY_MS = 15 * 60_000;
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
  /** Delivers a proposal's hint to its worker through the hint route of the chat or the task */
  hint: (proposal: SupervisorProposal) => Promise<void>;
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

export function supervisorPrompt(signal: HealthSignal, steps: string, task: TaskContext | null): string {
  const agent = signal.agent;
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
    `Write a hint for the ${agent ? 'subagent' : 'agent'}: one or two short lines addressed to it, specific to what it is doing, ` +
      'saying what to check or do differently. Reply with the hint only, no preamble. Do not change anything yourself.',
  ].join('\n');
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

/**
 * The hint as the lead reads it, for a signal about one of its subagents: nothing documented writes
 * to one subagent, so the lead is asked to pass it on with its own tools, or to stop the agent (C3).
 */
export function relayHint(agent: HealthSignalAgent, hint: string): string {
  const name = agentName(agent).replace(/`/g, "'");
  return `Your background agent \`${name}\` is stuck. Relay this to it with SendMessage, or stop it if it cannot get past it: ${hint}`;
}

/** Whether a proposal already answers this occurrence: its own kind, or the other signal about the same command */
function answers(proposal: SupervisorProposal, signal: HealthSignal, occurrence: string): boolean {
  if (proposal.signal === signal.kind && (proposal.occurrence ?? '') === occurrence) return true;
  // A hung command that is also the third stall of its kind is one thing to act on, not two
  return !!signal.toolUseId && COMMAND_SIGNALS.has(signal.kind) && COMMAND_SIGNALS.has(proposal.signal) && proposal.occurrence === signal.toolUseId;
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * Wakes on a worker's bad health, once per occurrence of a signal per chat, and keeps what it
 * proposed as a row. The rule lives in the store (a unique key on chat, signal and occurrence), so
 * neither a monitor tick nor a restart asks twice about the same thing.
 */
export class Supervisor {
  /** Occurrences being asked about right now: the monitor can announce again before the answer is in */
  private readonly asking = new Set<string>();
  /** Occurrences whose question failed, and when: asked again once {@link FAILED_RETRY_MS} has passed */
  private readonly failed = new Map<string, number>();

  constructor(private readonly deps: SupervisorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private mode(): DecisionMode {
    return this.deps.settings.get().points[SUPERVISOR_POINT]?.mode ?? 'off';
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

  /** Whether a question about `key` failed recently enough not to be asked again yet; an old failure is forgotten */
  private failedRecently(key: string): boolean {
    const at = this.failed.get(key);
    if (at === undefined) return false;
    if (this.now() - at < FAILED_RETRY_MS) return true;
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
    const signal = signals.find((s) => {
      if (s.level !== 'bad') return false;
      const occurrence = occurrenceOf(s);
      const key = keyOf(s);
      return !proposals.some((p) => answers(p, s, occurrence)) && !this.asking.has(key) && !this.failedRecently(key);
    });
    if (!signal) return null;
    const key = keyOf(signal);
    const agent = signal.agent ?? null;
    this.asking.add(key);
    try {
      const entries = await this.deps.steps(chat.id, signal.agent).catch((): TranscriptEntry[] => []);
      // A worker the decision says no hint can help gets none; the signal itself stays on the chat
      if (settings.provider === 'jev' && (await this.declined(chat, signal, entries))) {
        this.failed.set(key, this.now());
        return null;
      }
      const steps = lastSteps(entries, agent?.parentToolUseId ?? null);
      const answer = await this.askForRoom({ prompt: supervisorPrompt(signal, steps, task), cwd: chat.workingDir, model: settings.cli.model, maxCostUsd: settings.cli.supervisorMaxCostUsd });
      // No room came free in time: nothing was spent and nothing failed
      if (!answer) return null;
      const costUsd = Number.isFinite(answer.costUsd) && answer.costUsd > 0 ? answer.costUsd : 0;
      // Spent whether or not the answer is usable, so it counts either way
      if (task && costUsd > 0) this.deps.charge(task.orchestrationId, costUsd);
      const hint = answer.isError ? '' : hintFrom(answer.text);
      if (!hint) {
        this.failed.set(key, this.now());
        return null;
      }
      const proposal: SupervisorProposal = {
        id: randomUUID(),
        chatId: chat.id,
        ...(task ? { taskId: task.taskId, orchestrationId: task.orchestrationId } : {}),
        signal: signal.kind,
        occurrence: occurrenceOf(signal),
        ...(agent ? { agent } : {}),
        // Addressed to whoever reads it: the lead, for a subagent's call, is asked to pass it on
        hint: agent ? relayHint(agent, hint) : hint,
        costUsd,
        at: new Date().toISOString(),
        status: 'proposed',
      };
      if (!this.deps.db.saveProposal(proposal)) return null;
      const who = task?.taskName ?? chat.name;
      this.deps.emit({
        type: 'supervisor.proposed',
        title: `${who}: the supervisor proposes a hint`,
        ...runRef(chat),
        taskId: task?.taskId ?? null,
        taskName: task?.taskName ?? null,
        proposal,
      });
      // Read again: a person who switched the point while the hint was being drafted decides
      if (this.mode() !== 'active') return proposal;
      try {
        return await this.act(proposal, signal, hint);
      } catch {
        // The worker moved on before the answer came: the proposal stays for a person to judge
        return proposal;
      }
    } catch {
      this.failed.set(key, this.now());
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
        if (!isCapacityRefusal(error)) throw error;
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
        if (!this.deps.db.settleProposal(proposal.id, 'sent')) throw new SupervisorConflictError('the proposal was settled in the meantime');
        return { ...proposal, status: 'sent' };
      } catch (error) {
        if (error instanceof SupervisorConflictError) throw error;
        // Refused: the command ended or cannot be told apart, and a message is what is left
      }
    }
    return this.send(proposal.id, { chatId: proposal.chatId });
  }

  /**
   * `supervisor.intervene` under Jev: whether the decision, active and above its threshold, says a
   * hint would not get this worker out. Shadow, and every other outcome, leave the hint to be asked
   * for. Under the CLI the engine is not asked at all: its answer has no probability to gate on, and
   * the hint is itself a call to the CLI. Wakes already run in the background, so shadow is not
   * awaited: nothing here waits for a row.
   */
  private async declined(chat: ChatRuntime, signal: HealthSignal, entries: readonly TranscriptEntry[]): Promise<boolean> {
    const engine = this.deps.decisions;
    const stance = stanceOf(engine, SUPERVISOR_POINT, null);
    if (!engine || stance === 'off') return false;
    const calls = callsOf(entries, signal.agent?.parentToolUseId ?? null);
    const asked = engine.ask(SUPERVISOR_POINT, { kind: 'chat', id: chat.id, data: { signal: signal.kind, detail: signal.detail ?? signal.reason, calls } }, { projectId: null }).catch(() => null);
    if (stance === 'watch') return false;
    const answer = (await asked)?.answers?.intervene;
    return answer?.kind === 'noul' && !answer.value;
  }

  private owned(id: string, owner: ProposalOwner): SupervisorProposal {
    const proposal = this.deps.db.proposal(id);
    const matches =
      proposal &&
      ('chatId' in owner ? proposal.chatId === owner.chatId : proposal.orchestrationId === owner.orchestrationId && proposal.taskId === owner.taskId);
    if (!proposal || !matches) throw new Error('proposal not found');
    if (proposal.status !== 'proposed') throw new SupervisorConflictError(`the proposal was already ${proposal.status}`);
    return proposal;
  }

  /** Sends the hint to the worker, then marks it sent: a hint that did not arrive stays proposed. */
  async send(id: string, owner: ProposalOwner): Promise<SupervisorProposal> {
    const proposal = this.owned(id, owner);
    await this.deps.hint(proposal);
    if (!this.deps.db.settleProposal(id, 'sent')) throw new SupervisorConflictError('the proposal was settled in the meantime');
    return { ...proposal, status: 'sent' };
  }

  dismiss(id: string, owner: ProposalOwner): SupervisorProposal {
    const proposal = this.owned(id, owner);
    if (!this.deps.db.settleProposal(id, 'dismissed')) throw new SupervisorConflictError('the proposal was settled in the meantime');
    return { ...proposal, status: 'dismissed' };
  }
}
