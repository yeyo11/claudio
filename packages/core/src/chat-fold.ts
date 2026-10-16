import { entryText, isModelName, type PolicyPart, type RunOutcome, type ToolPolicy } from '@claudio/shared';
import { isClaudioMcpWriteTool } from '@claudio/mcp';
import { ChatActivityTracker } from './chat-activity.ts';
import { LEGACY_PROVIDER } from './chat-records.ts';
import { commandKind } from './commands.ts';
import { judge, type NeutralRequest } from './policy-judge.ts';
import { now, type ChatHost, type ContextSignal, type LiveChat } from './live-chat.ts';
import type { DriverEvent, SessionInit } from './providers/driver.ts';

/** The next `seq` of a chat's stored entries; read once from the table, so a resumed chat carries on after what an earlier process wrote */
const entrySeq = new WeakMap<LiveChat, number>();

/**
 * Records what a non-Claude chat streamed as rows, the transcript of a provider that keeps none
 * Claudio can read. Claude's own JSONL is its transcript, so it is not copied.
 */
export function recordEntry(host: ChatHost, chat: LiveChat, entry: Extract<DriverEvent, { kind: 'message' }>['entry']): void {
  if (chat.driver.manifest.id === LEGACY_PROVIDER) return;
  try {
    const seq = entrySeq.get(chat) ?? (host.db.chatEntries(chat.id).at(-1)?.seq ?? -1) + 1;
    host.db.appendChatEntries(chat.id, [{ seq, at: entry.timestamp || now(), entry }]);
    entrySeq.set(chat, seq + 1);
  } catch {
    // the transcript only loses this entry; the chat goes on
  }
}

/** Read when used, so a test can shorten them */
export const idleTimeoutMs = (): number => Number(process.env.CLAUDIO_IDLE_TIMEOUT_MS ?? 10 * 60_000);
const viewedIdleMaxMs = (): number => Number(process.env.CLAUDIO_VIEWED_IDLE_MAX_MS ?? 60 * 60_000);

/**
 * Folds what a driver reports into the chat it belongs to: the settings, the ticker, the history of
 * commands, the executions and the feed. Whatever the agent's protocol looked like, this is all
 * `ChatManager` knows of it.
 */
export function foldEvent(host: ChatHost, chat: LiveChat, event: DriverEvent): void {
  switch (event.kind) {
    case 'init': {
      // The session exists now: a respawn resumes it, and a fork is no longer waiting to be made
      chat.created = true;
      chat.forkFrom = null;
      if (chat.driver.sessionIds === 'assigned') {
        // The agent names the session. The first id is recorded; another one later would point the
        // chat at a different conversation without anyone noticing, so it fails the execution
        const native = event.nativeSessionId ?? event.sessionId;
        if (native && chat.nativeId && native !== chat.nativeId) {
          host.failProtocol(chat, `The agent reported session ${native} for a chat bound to ${chat.nativeId}; refusing to rebind it.`);
          return;
        }
        if (native && !chat.nativeId) {
          chat.nativeId = native;
          host.persist();
        }
      } else if (event.sessionId && event.sessionId !== chat.id) {
        // The id was Claudio's to choose, and the agent takes it; if it ever answered otherwise, the
        // chat would be one row on disk and another here, so say so where the person can see it
        chat.push({ kind: 'notice', text: `The CLI reported session ${event.sessionId} for the chat ${chat.id}; its transcript is not where this chat expects it.` });
      }
      // What the alias this process was started with stands for now: the cache of models labels
      // none of the aliases, and this is the one place it says which model one is
      try {
        host.modelIds.record(chat.opts.model, event.model);
      } catch {
        // the picker only goes on showing the alias alone
      }
      chat.setSettings({
        ...(event.permissionMode ? { permissionMode: event.permissionMode } : {}),
        ...(event.model ? { model: event.model } : {}),
      });
      if (event.cwd) {
        chat.workingDir = event.cwd;
        chat.activity.setCwd(event.cwd);
      }
      const environment = { cwd: chat.cwd, observedAt: now(), chatId: chat.id, ...event.environment };
      host.environments.set(chat.cwd, environment);
      try {
        host.db.saveEnvironment(environment);
      } catch {
        // the panel only loses this directory until its next run
      }
      chat.push(event.run);
      // What the first event confirms about the installed agent: Core hands it to the detector
      host.emit('chat-init', chat.provider, {
        version: event.environment.cliVersion ?? null,
        tools: event.environment.tools ?? [],
        mcpServers: (event.environment.mcpServers ?? []).map((s) => ({ name: s.name, status: s.status })),
        structuredOutput: chat.opts.jsonSchema !== undefined,
      } satisfies SessionInit);
      return;
    }

    case 'mode-changed':
      chat.setSettings({ permissionMode: event.mode });
      chat.updatedAt = now();
      return;

    // The CLI summarises the conversation: the ticker says so, and ContextControl keeps the row and its lease. The
    // status repeats on a timer, so it is not pushed as an event: only the activity and the signal change
    case 'compacting':
      chat.activity.compacting(event.active, now());
      chat.activityAt = now();
      host.noteActivity(chat);
      host.emit('chat-context', chat.id, { kind: 'driver', event } satisfies ContextSignal);
      return;

    case 'compacted':
      chat.activity.compacting(false, now());
      host.noteActivity(chat);
      // The divider shows at once, and the meter reads the boundary's figures until the next response
      chat.push(event.run);
      host.emit('chat-context', chat.id, { kind: 'driver', event } satisfies ContextSignal);
      return;

    case 'compact-failed':
      chat.activity.compacting(false, now());
      host.noteActivity(chat);
      // An interrupted compaction fails by the CLI's own count (recorded, F14), but it is the person's doing
      host.emit('chat-context', chat.id, { kind: 'driver', event, interrupted: chat.interruptRequested, stopped: chat.stopRequested } satisfies ContextSignal);
      return;

    case 'block-started':
      // The ticker reacts to the block, not to the message that closes it: a tool call is named
      // here, seconds before its arguments have finished streaming
      chat.activity.blockStarted(event.block, now());
      chat.partial = event.streams === 'other' ? null : { block: event.streams, text: '' };
      chat.partialSent = null;
      chat.structured = event.structured ? '' : null;
      return;

    case 'structured-delta':
      chat.structured = (chat.structured ?? '') + event.json;
      host.emit('chat-structured', chat.id, chat.structured);
      return;

    case 'delta':
      if (!chat.partial) return;
      chat.partial.text += event.text;
      chat.emitPartial();
      return;

    case 'block-stopped':
      chat.activity.blockStopped();
      chat.partial = null;
      chat.partialSent = null;
      chat.structured = null;
      return;

    case 'stop-reason':
      chat.stopReason = event.reason;
      return;

    // Kept for the health of the chat and not pushed as an event: it says a command is alive and
    // how long it has run, which no transcript view needs and which would fill the buffer
    case 'heartbeat':
      if (event.toolUseId && event.elapsedSeconds !== null) chat.heartbeats.set(event.toolUseId, { elapsedSeconds: event.elapsedSeconds, at: now() });
      chat.activityAt = now();
      return;

    // Notes how long each shell command took, by kind, once its result arrives: the history that
    // "far longer than usual" is measured against. A command a person cancelled is recorded as such,
    // and one that failed is too: neither says how long the command takes when it works.
    case 'command-started': {
      const kind = commandKind(event.command);
      if (kind) chat.openCommands.set(event.toolUseId, { command: event.command, kind, startedAt: now() });
      return;
    }
    case 'command-ended': {
      chat.heartbeats.delete(event.toolUseId);
      const open = chat.openCommands.get(event.toolUseId);
      if (!open) return;
      chat.openCommands.delete(event.toolUseId);
      const outcome = chat.cancelled.delete(event.toolUseId) ? 'cancelled' : event.isError ? 'error' : 'ok';
      try {
        host.db.recordCommand({ kind: open.kind, chatId: chat.id, toolUseId: event.toolUseId, startedAt: open.startedAt, durationMs: Date.now() - Date.parse(open.startedAt), outcome });
      } catch {
        // the history only loses one run of a command
      }
      return;
    }

    case 'message': {
      const { entry } = event;
      trackActivity(chat, entry);
      recordEntry(host, chat, entry);
      // The agent can start a turn on its own (e.g. after a background task notification)
      if (entry.role === 'assistant' && chat.status === 'idle') {
        if (chat.idleTimer) clearTimeout(chat.idleTimer);
        chat.idleSince = null;
        chat.setStatus('busy');
      }
      if (event.mainAgent) {
        if (event.stopReason !== undefined) chat.stopReason = event.stopReason;
        const text = entryText(entry);
        if (text) chat.lastText = text.slice(0, 2000);
        // A slash command's reply comes from `<synthetic>`, which a resume would pass back as `--model`
        if (isModelName(entry.model)) chat.setSettings({ model: entry.model });
      }
      chat.push(event.run);
      if (entry.compaction?.part === 'summary') host.emit('chat-context', chat.id, { kind: 'summary', entry } satisfies ContextSignal);
      return;
    }

    case 'task':
      // The driver has already folded it into the branches: a notification may have ended an agent
      dropEndedBranches(chat);
      chat.push(event.run);
      return;

    case 'failed':
      host.failProtocol(chat, event.reason);
      return;

    case 'rate-limit':
      if (event.info.status === 'rejected') chat.rateLimited = true;
      host.observeLimit(chat, event);
      return;

    case 'permission-request':
      askPermission(host, chat, event.question);
      return;

    // The agent withdrew the question: the broker settles it, and the answer that was waiting is dropped
    case 'permission-withdrawn':
      host.permissions?.withdraw(event.id);
      return;

    case 'result':
      foldResult(host, chat, event);
      return;

    case 'delivered':
      foldDelivered(host, chat, event.ids);
      return;

    case 'stderr':
      chat.push({ kind: 'stderr', text: event.text });
      return;

    case 'unreadable':
      chat.push({ kind: 'other', text: event.text });
      return;

    case 'notice':
      chat.push({ kind: 'notice', text: event.text });
      return;
  }
}

/**
 * The agent took these messages: each leaves the pending list and the page hears it was delivered,
 * one event per id, so a prompt the agent made of several messages resolves every one of them.
 */
function foldDelivered(host: ChatHost, chat: LiveChat, ids: string[]): void {
  chat.reportsDelivery = true;
  for (const id of ids) {
    if (chat.pending.get(id)?.state !== 'written') continue;
    chat.pending.delete(id);
    chat.push({ kind: 'delivery', delivery: { id, state: 'delivered' } });
  }
  // The agent is on it: within the turn that runs, or as a turn of its own after the last result,
  // which can stream nothing whole for a long while
  if (chat.status === 'idle') {
    if (chat.idleTimer) clearTimeout(chat.idleTimer);
    chat.idleSince = null;
    chat.setStatus('busy');
  }
  host.persist();
}

function foldResult(host: ChatHost, chat: LiveChat, event: Extract<DriverEvent, { kind: 'result' }>): void {
  const execution = chat.execution;
  if (execution) {
    execution.turns += event.turns;
    // The agent's total is over its process, so per execution it only ever grows
    if (event.costUsd !== undefined) execution.costUsd = Math.max(execution.costUsd ?? 0, event.costUsd);
    // The spend of this result is the increase over the process's last report, not the execution's
    // max(): a process restarted inside one execution begins its total again from zero
    if (event.costUsd !== undefined && Number.isFinite(event.costUsd)) {
      const delta = event.costUsd - chat.lastReportedCostUsd;
      chat.lastReportedCostUsd = Math.max(chat.lastReportedCostUsd, event.costUsd);
      if (delta > 0) host.recordSpend(chat, execution, delta);
    } else if (event.costUsd === undefined) host.recordSpend(chat, execution, null);
    host.learnModelCosts(execution, event.modelUsage);
  }
  host.learnWindows(event.modelUsage);
  if (event.authFailed) {
    // Handled as a limit is (the account cannot take the turn, the rotation has it), but the account
    // is out until it signs in again rather than until a reset
    chat.rateLimited = true;
    chat.authFailed = true;
    host.observeSignIn(chat, true);
  } else if (event.rateLimited) {
    chat.rateLimited = true;
    host.observeLimit(chat, event);
  } else if (!event.isError) {
    host.observeSignIn(chat, false);
    // A turn went through: the accounts an earlier one died on may have reset since
    chat.limitedAccounts.clear();
  }
  const { isError } = event;
  const purpose = chat.purpose;
  const interrupted = chat.interruptRequested;
  const cause = !isError ? undefined : chat.interruptRequested || chat.stopRequested ? 'stopped' : event.budget ? 'budget' : chat.rateLimited ? 'rate-limit' : undefined;
  const stopReason = event.stopReason ?? chat.stopReason;
  // The next turn's reason is its own
  chat.stopReason = null;
  chat.lastResult = { isError, result: event.text, structuredOutput: event.structuredOutput, costUsd: chat.costUsd, ...(cause ? { cause } : {}), ...(stopReason ? { stopReason } : {}), ...(purpose ? { purpose } : {}) };
  // An interrupted turn ends as an error by the agent's own count, but nothing went wrong
  if (isError && !chat.interruptRequested) chat.error = event.failure;
  chat.interruptRequested = false;
  chat.activity.turnEnded();
  chat.branchActivity.clear();
  host.persist();
  chat.push({ ...event.run, outcome: { ...(event.run.outcome as RunOutcome), ...(cause ? { cause } : {}), ...(stopReason ? { stopReason } : {}) } });
  // Every result, where waitForResult only hands out the first: a chat continued by hand keeps
  // producing them, and whoever the chat works for has to hear about each
  host.emit('chat-result', chat.id, chat.lastResult);
  if (purpose) host.emit('chat-context', chat.id, { kind: 'result', result: chat.lastResult, interrupted } satisfies ContextSignal);
  if (chat.reportsDelivery === null) {
    // The turn ended and the agent never said it took the message that started it: it does not say,
    // and what was written to it is not followed any further
    chat.reportsDelivery = false;
    for (const message of chat.written()) chat.pending.delete(message.id);
  }
  chat.turnOver = true;
  if (chat.opts.keepAlive === false) {
    // A driver that still holds a turn would write it after the end of the input
    if (!chat.session?.holdsTurns?.()) chat.session?.endInput();
  } else if (chat.written().length > 0) {
    // The agent has messages of ours still to read and goes on with them as its next turn: the chat
    // is not waiting for anyone
    if (chat.idleTimer) clearTimeout(chat.idleTimer);
    chat.idleSince = null;
  } else {
    chat.setStatus('idle');
    chat.idleSince = Date.now();
    const onIdle = () => {
      // Someone has the chat open: their next message should not wait for a cold start. Bounded, so a
      // tab forgotten open does not hold a process for ever (a hidden tab lets go of its stream after 30 s anyway)
      if (chat.viewers > 0 && Date.now() - (chat.idleSince ?? 0) < viewedIdleMaxMs()) {
        chat.idleTimer = setTimeout(onIdle, idleTimeoutMs());
        chat.idleTimer.unref();
        return;
      }
      chat.session?.endInput();
    };
    chat.idleTimer = setTimeout(onIdle, idleTimeoutMs());
    chat.idleTimer.unref();
  }
  // Last, so the limit check above still knew this was housekeeping
  host.maybeLimit(chat);
  chat.purpose = null;
}

/** The parts of a policy a request falls under; a driver lists in `host` the ones it leaves to the judge. */
function partsOf(request: NeutralRequest): PolicyPart[] {
  switch (request.kind) {
    case 'command':
      return ['commands', 'gitPush'];
    case 'edit':
      return ['edit'];
    case 'read':
      return ['read'];
    case 'fetch':
      return ['network'];
    case 'delegate':
      return ['delegate'];
    case 'other':
      return [];
  }
}

function hostJudges(chat: LiveChat, policy: ToolPolicy, request: NeutralRequest): boolean {
  const host = chat.driver.translatePolicy(policy).host;
  return !!host && partsOf(request).some((part) => host.includes(part));
}

/** The agent asks the host something: a tool permission, a question, a plan to approve. */
function askPermission(host: ChatHost, chat: LiveChat, question: Extract<DriverEvent, { kind: 'permission-request' }>['question']): void {
  const session = chat.session;
  const broker = host.permissions;
  const policy = chat.opts.toolConfig?.policy;
  if (policy && question.request && hostJudges(chat, policy, question.request)) {
    // Decided by Claudio's policy, not by the agent's own rules: the part is listed as `host`
    const verdict = judge(policy, question.request);
    if (verdict !== 'ask') {
      const allowed = verdict === 'allow';
      chat.push({ kind: 'notice', text: `${allowed ? 'Allowed' : 'Denied'} by the chat's policy: ${question.toolName}`, data: { toolUseId: question.toolUseId, verdict } });
      session?.answerPermission(question.id, allowed ? { behavior: 'allow' } : { behavior: 'deny', message: "Denied by the chat's tool policy" });
      return;
    }
  }
  if (!broker || chat.opts.permissionPrompts !== 'host') {
    session?.answerPermission(question.id, { behavior: 'deny', message: 'Nobody is answering permission prompts for this chat' });
    return;
  }
  const isWrite = isClaudioMcpWriteTool(question.toolName);
  chat.pendingPrompts++;
  chat.activity.setPendingPrompts(chat.pendingPrompts, now());
  void broker
    .ask({
      id: question.id,
      runId: chat.id,
      toolName: question.toolName,
      toolUseId: question.toolUseId,
      input: question.input,
      requestedAt: now(),
      ...(question.description !== undefined ? { description: question.description } : {}),
      // No "always allow" for a write of Claudio's own: each one is confirmed on its own, every time
      ...(question.suggestions && !isWrite ? { suggestions: question.suggestions } : {}),
      ...(question.requiresUserInteraction ? { requiresUserInteraction: true } : {}),
    })
    .then((decision) => {
      chat.pendingPrompts = Math.max(0, chat.pendingPrompts - 1);
      chat.activity.setPendingPrompts(chat.pendingPrompts, now());
      host.noteActivity(chat);
      // Withdrawn by the agent, or the process is gone: nobody is waiting for an answer
      if (!decision) return;
      // An allow cannot carry rules either, so a later write is never allowed without asking
      if (isWrite && decision.behavior === 'allow') {
        const { updatedPermissions: _rules, ...once } = decision;
        session?.answerPermission(question.id, once);
        return;
      }
      session?.answerPermission(question.id, decision);
    });
}

/**
 * Feeds the tickers: the main agent's calls and results to the chat's, and a subagent's to its own,
 * keyed by the call that launched it. To the chat's ticker a subagent is the call that started it,
 * which stays open until the subagent reports back.
 */
function trackActivity(chat: LiveChat, entry: Extract<DriverEvent, { kind: 'message' }>['entry']): void {
  if (entry.isSidechain) return trackBranch(chat, entry);
  for (const block of entry.blocks) {
    if (block.type === 'tool_use') {
      chat.activity.called(block.id, block.name, (block.input ?? {}) as Record<string, unknown>, entry.timestamp || now());
    } else if (block.type === 'tool_result') {
      chat.activity.answered(block.toolUseId);
      // The subagent this call launched reported back. A background one only said it was launched,
      // and goes on until its task notification
      const sub = chat.branches.subagents.get(block.toolUseId);
      if (!(sub?.background && sub.status === 'running')) chat.branchActivity.delete(block.toolUseId);
    }
  }
}

/** A subagent's own calls and results, from its sidechain; its text is not on the stream, so only calls tell. */
function trackBranch(chat: LiveChat, entry: Extract<DriverEvent, { kind: 'message' }>['entry']): void {
  const parent = entry.parentToolUseId;
  if (!parent) return;
  // A line that arrives after the agent ended must not bring back a ticker nobody would clear
  const sub = chat.branches.subagents.get(parent);
  if (sub && sub.status !== 'running') return;
  let tracker = chat.branchActivity.get(parent);
  for (const block of entry.blocks) {
    if (block.type === 'tool_use') {
      if (!tracker) {
        tracker = new ChatActivityTracker(chat.workingDir ?? chat.cwd);
        chat.branchActivity.set(parent, tracker);
      }
      tracker.called(block.id, block.name, (block.input ?? {}) as Record<string, unknown>, entry.timestamp || now());
    } else if (block.type === 'tool_result') {
      tracker?.answered(block.toolUseId);
    }
  }
}

/** Forgets the tickers of subagents that are over: a task notification ends a background one. */
function dropEndedBranches(chat: LiveChat): void {
  for (const toolUseId of chat.branchActivity.keys()) {
    const sub = chat.branches.subagents.get(toolUseId);
    if (sub && sub.status !== 'running') chat.branchActivity.delete(toolUseId);
  }
}
