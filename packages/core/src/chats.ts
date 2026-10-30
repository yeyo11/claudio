import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ChatNotFoundError, ChatRefusal, DeliveryRefusal, MemoryRefusal, QueueYieldRefusal, RunSlotRefusal } from './chat-errors.ts';
import { DEFAULT_ID, isOut, readingFromEvent, type AccountRef, type AccountStore, type Choice, type Reading } from '@claudio/accounts';
import { ChatTokenStore } from './security/chat-tokens.ts';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type AccountSwitchReason,
  type AccountSwitchRefusalCode,
  type ClaudioAssistantMarker,
  type ChatActivity,
  type Attachment,
  type ChatClaudioMcp,
  type ChatMcpServers,
  type ClaudioMcpUnavailable,
  type LiveMcpServer,
  type ChatMessageReceipt,
  type ChatMessageTaken,
  type ChatToolConfig,
  type ChatSettingsUpdate,
  type ContextDetail,
  type ChatStartOptions,
  type Execution,
  type ProviderId,
  type PermissionMode,
  type ProviderLimit,
  type ProvidersSettings,
  type ResumeChatRequest,
  type RunEvent,
  type RunGuardEvent,
  type RunStatus,
  type TokenUsage,
  type ToolPolicy,
  type TranscriptEntry,
  type UsageHistoryPoint,
} from '@claudio/shared';
import { activityKey } from './chat-activity.ts';
import { executionOutcome } from './chat-model.ts';
import { foldEvent, goIdle, idleTimeoutMs, NOT_READ, recordEntry } from './chat-fold.ts';
import { CLAUDIO_MCP_READ_TOOLS, CLAUDIO_MCP_SERVER } from '@claudio/mcp';
import { EnvironmentIndex } from './environments.ts';
import type { AssistantChatOptions, ClaudioMcpIdentity, CollabMcpLaunch } from './claudio-mcp.ts';
import { chatsFromRuns, LEGACY_PROVIDER, type LegacyRun, type StoredChat } from './chat-records.ts';
import type { Db } from './db.ts';
import { RunEventPublisher } from './event-sources.ts';
import type { EventBus } from './events.ts';
import type { RunDefaults } from './app-settings.ts';
import {
  LiveChat,
  now,
  processUp,
  runsInBackground,
  type AdoptedChat,
  type ChatGuardPlan,
  type ChatHost,
  type ChatPulse,
  type ChatRuntime,
  type ContextSignal,
  type ExecutionExtras,
  type HousekeepingPurpose,
  type NewChat,
  type PermissionHost,
  type ResolvedTools,
  type RunMeta,
  type RunResult,
  type SentMessage,
} from './live-chat.ts';
import { removeChatExtrasConfigs, writeChatExtrasConfigSync } from './chat-tools.ts';
import { ChatTable } from './chat-table.ts';
import { ThrottledLog } from './throttled-log.ts';
import type { CoreConfig } from './paths.ts';
import type { PermissionBroker } from './permissions.ts';
import { runningCommands, type GuardTraceEntry, type ToolCall, type Trace, type TraceAgent } from './health.ts';
import { cliProcessOf, commandRoots, descendantsOf, processTable, terminateTree, type ProcessEntry } from './processes.ts';
import { ClaudeCodeDriver } from './providers/claude-code/driver.ts';
import type { BranchTracker, DriverEvent, InterruptReceipt, ModelUsage, ProviderDriver, SessionLaunch } from './providers/driver.ts';
import { providerLimitOf } from './providers/limits.ts';
import { classOfChat, classOfStart, InteractiveHold, QUEUE_YIELD_PREFIX, type StartClass } from './admission-queue.ts';
import { admissionLimitsFrom, readSystemLoad } from './system-load.ts';
import { PROVIDER_MANIFESTS, ProviderRegistry } from './providers/registry.ts';
import type { SessionStore } from './sessions.ts';
import type { UploadStore } from './uploads.ts';
import { LESSONS_ARG_MAX_BYTES } from './lessons/render.ts';
import { ChatStartRefusal, CLIENT_TOOLS_PERMISSION_MODE, CONFINED_PERMISSION_MODE, confinedGitEnv, confinementOf, cwdMissing } from './confined-chat.ts';
import { CLIENT_TOOLS_SERVER } from './openai/client-tools.ts';

// Every name `chats.ts` has ever exported stays importable from here
export type { AdoptedChat, ChatConfinement, ChatPulse, ChatRuntime, ExecutionExtras, NewChat, PermissionHost, ResolvedTools, RunMeta, RunningCommand, RunResult } from './live-chat.ts';
export { STRUCTURED_OUTPUT_TOOL } from './providers/claude-code/stream.ts';

const MAX_PERSISTED_CHATS = 200;
/** How long a stopped chat's process tree has to leave on SIGTERM before it gets SIGKILL */
const STOP_GRACE_MS = 5000;
/** An ended chat nobody has touched for this long is retired from memory to its summary (see `ChatTable`) */
export const RETIRE_AFTER_MS = 60 * 60_000;
/** How often the chats that ended are looked at for retiring */
const RETIRE_SWEEP_MS = 5 * 60_000;
/**
 * The accounts a chat's latest executions died on at their limit, newest first, up to the first
 * that did not. Recorded on the executions, so it survives a restart; the chat's set covers the turn
 * still running, which has no record of its end yet.
 */
export function limitedTail(executions: readonly Execution[]): string[] {
  const accounts: string[] = [];
  for (let i = executions.length - 1; i >= 0; i--) {
    const e = executions[i];
    if (!e || e.cause !== 'rate-limit') break;
    if (e.account) accounts.push(e.account);
  }
  return accounts;
}
/**
 * What starting or continuing a chat refuses on purpose (no prompt, the runtime full, the session
 * held elsewhere, a bad upload): the caller's to fix, with its 4xx. Anything else that goes wrong
 * while a chat starts is the server's (`ChatStartError`).
 */
/** Why a chat's account cannot be switched: the codes of `POST /chats/:id/account`, plus the two unknowns (404). */
export class AccountSwitchRefusal extends Error {
  constructor(
    readonly code: AccountSwitchRefusalCode | 'chat-not-found' | 'account-not-found',
    message: string,
  ) {
    super(message);
    this.name = 'AccountSwitchRefusal';
  }
}

export { ChatNotFoundError, ChatRefusal, DeliveryRefusal, isTransientRefusal, MemoryRefusal, QueueYieldRefusal, RunSlotRefusal } from './chat-errors.ts';

/**
 * Replays of a turn lost to a limit on no new account, between two turns that went through: a second
 * failure there is a real one, not a quota one. A move to another account is never counted nor held
 * back by it (`chooseNext` passes over every account the turn died on, so a chain of moves ends by itself).
 */
const MAX_LIMIT_REPLAYS = 1;

/**
 * The model a chat asked for (`--model`), which is what the account choice filters on: the chat's
 * `model` follows the one the CLI resolved (`default` becomes `claude-opus-…`), and filtering on that
 * kept a chat started on `default` waiting for an account that offers Opus (regression audit §2.3).
 * Absent or `default` runs on any account.
 */
const askedModel = (chat: LiveChat): string | null => chat.opts.model ?? null;

/** The windows `usage_history` keeps a line for */
const HISTORY_WINDOWS = ['five_hour', 'seven_day'] as const;

/** What the chat manager needs of the accounts: the store, as `@claudio/accounts` builds it */
/** What a guard plan is derived from at a spawn: the chat's folder, the plan it last had, and what kind of chat it is. */
export interface GuardSubject {
  cwd: string;
  /** The plan the last process ran with; its `request` is what a new one is derived from */
  plan: ChatGuardPlan | null;
  /** A person's own chat, guarded by its project's opt-in when nothing else says how */
  person: boolean;
  /** The tool policy of an automated run, when it stated one */
  policy: ToolPolicy | null;
  /** Confined to a tool list (`--restricted`/`--tools`): such a run is never guarded */
  confined: boolean;
}

export type ChatAccounts = Pick<AccountStore, 'ref' | 'pick' | 'observe' | 'markAuthFailed' | 'confirm' | 'settings' | 'policyFor' | 'find' | 'cachedModels' | 'warmModels' | 'canRun'>;
const MAX_ATTACHMENTS = 20;

/** Why a message is lost when the chat is stopped before the agent read it */
/** How long a guarded process may take to arm before the run fails (F9: the marker comes about 0.7 s after launch); read when used so a test can shorten it */
const guardArmMs = (): number => Number(process.env.CLAUDIO_GUARD_ARM_MS ?? 20_000);
/** How long the interrupt of a run with an unguarded call is given to be read before the process is taken down */
const GUARD_INTERRUPT_WAIT_MS = 1500;
const STOPPED = 'the chat was stopped before the agent read it';
/** ...and when its process ended for another reason, with nothing better to say */
const ENDED = 'the process ended before the agent read it';

/**
 * How long a process that exited is given to close its pipes. A child that inherited the CLI's
 * stdout or stderr (a stdio MCP server left behind, a daemonised command) holds them open, and
 * `close` with them; read when used, so a test can shorten it.
 */
const closeAfterExitMs = (): number => Number(process.env.CLAUDIO_CLOSE_AFTER_EXIT_MS ?? 3000);

/** Who wrote a message besides a person, and the words it carries without Claudio's framing (`SentMessage`). */
export type MessageFrom = Partial<Pick<SentMessage, 'source' | 'words'>>;

/** Who wrote a message, to send it again as it was */
const fromOf = (message: SentMessage): MessageFrom => ({ source: message.source, ...(message.words !== undefined ? { words: message.words } : {}) });

/** A message Claudio sends of its own accord (a first prompt, a resume): an id of its own, now. */
const sent = (text: string, attachments: Attachment[] = []): SentMessage => ({ id: randomUUID(), text, attachments, sentAt: now(), source: 'person' });

/** The person's entry for a message, under the message's id: the id the agent's transcript gives it too. */
function userEntry(message: SentMessage, shown: string): TranscriptEntry {
  return {
    uuid: message.id,
    role: 'user',
    timestamp: message.sentAt,
    model: null,
    isSidechain: false,
    parentToolUseId: null,
    blocks: [
      ...message.attachments
        .filter((a) => a.kind !== 'file')
        .map((a) => ({ type: a.kind === 'image' ? ('image' as const) : ('document' as const), mediaType: a.mediaType, name: a.name, uploadId: a.id })),
      { type: 'text', text: shown },
    ],
  };
}

/** A chat as it was last written: its record and each execution, as JSON. */
interface SavedChat {
  record: string;
  executions: Map<string, string>;
}

/**
 * Manages `claude -p` processes using stream-json input/output.
 * Each LiveChat is a live conversation: it accepts multiple turns over stdin and, if the
 * process already exited, it is respawned with `--resume` when a new message arrives.
 */
export class ChatManager extends EventEmitter {
  /** Working and lately ended chats in memory, the rest retired to their summary and woken from their row (`ChatTable`) */
  private readonly chats = new ChatTable((id) => this.wake(id));
  /** What was last written of each chat, so that a save writes only what changed since */
  private readonly saved = new Map<string, SavedChat>();
  /**
   * Chats that changed since they were last written: every event a chat emits marks it, and so does
   * a save asked for it by name. A save writes these and no others; comparing every chat in memory
   * with what was last written of it, on every turn of every chat, was most of a save's cost.
   */
  private readonly dirty = new Set<string>();
  /** Retires the chats that ended long enough ago; unref'd, so it never keeps a process up */
  private readonly retireTimer: NodeJS.Timeout;
  /** How long an ended chat stays in memory before it is retired to its summary; a test shortens it */
  retireAfterMs = RETIRE_AFTER_MS;
  /** The code half of each provider that can run chats */
  readonly providers: ProviderRegistry;
  /**
   * Which providers the person turned on, and in what order: read as each chat starts, so a change
   * applies to the next one. Core sets it; without it the manifests' own order is the person's.
   */
  providerSettings: (() => Pick<ProvidersSettings, 'order' | 'defaultProvider'>) | null = null;
  /**
   * Where this wrapper's REST API answers, once it listens. Handed to every chat as
   * `CLAUDIO_API_URL`: with a desktop app and a dev server on one machine, an agent that guessed a
   * port drove the other wrapper and its orchestrations never showed up in the one it ran in.
   */
  apiUrl: string | null = null;
  /** The MCP config problems each chat was told about already (`baseUnread`) */
  private readonly mcpConfigNoticed = new WeakMap<LiveChat, Set<string>>();
  /**
   * The per-process credentials handed over as `CLAUDIO_API_TOKEN` beside `CLAUDIO_API_URL`, so a
   * chat can call a guarded API. Core replaces it with the one its guard reads.
   */
  chatTokens = new ChatTokenStore();
  /** The workspaces root (D7), where a confined API chat's git stops looking for a repository; Core sets it */
  workspacesRoot: string | null = null;
  /**
   * What a Claudio assistant chat runs with, from the marker it stores. Core sets it; without it
   * such a chat is refused rather than started unconfined.
   */
  assistantLaunch: ((marker: ClaudioAssistantMarker) => AssistantChatOptions) | null = null;
  /**
   * Claudio's own server for a process of a chat that is not the assistant, or null when it gets
   * none: the reads of teammates' copies, decided at every process from its directory and its mode
   * (docs/plans/collaborators-agent-access.md), and all of Claudio's tools when the person switched
   * them on for the chat (`claudioMcp`). Core sets it. `mcpConfig` is the file of the servers the chat chose.
   */
  agentReadsLaunch: ((chat: { dir: string; permissionMode: PermissionMode; mcpConfig: string | null; claudioMcp: boolean }) => CollabMcpLaunch | null) | null = null;
  /**
   * The `claudio` server a live process is handed with `mcp_set_servers`: all of Claudio's tools when
   * `claudio`, else the reads of teammates' copies alone when the chat's scope allows them, else null.
   * Throws when the server cannot be built here (no API address). Core sets it.
   */
  claudioServer: ((chat: { dir: string; permissionMode: PermissionMode; claudio: boolean } & ClaudioMcpIdentity) => Record<string, unknown> | null) | null = null;
  /** Where chats with `permissionPrompts: 'host'` send what they ask; null means nobody answers */
  permissions: PermissionBroker | null = null;
  /** Files attached to messages; every chat may read them */
  uploads: UploadStore | null = null;
  /** Where changes to chats are announced; set by Core */
  bus: EventBus | null = null;
  /**
   * The Claude accounts a process may run on, chosen at every launch; Core sets it. Without it every
   * process runs on the CLI's own login, as before accounts.
   */
  accounts: ChatAccounts | null = null;
  /** The project a directory belongs to, for its rotation policy; Core sets it */
  projectOf: ((dir: string) => string | null) | null = null;
  /**
   * What a process of an interactive chat or an orchestration worker is appended: the Lessons
   * section and the note on pasted text, or '' when the project gives none; Core sets it
   */
  lessonsFor: ((projectId: string | null, orchestrated: boolean) => string) | null = null;
  /**
   * A process's guard plan, derived again from the settings as they are now (D6). Called at every
   * spawn the caller did not hand a plan to: a respawn after a limit, a queued message, a send to a
   * chat whose process ended. Core sets it; without it a chat keeps the plan it was started with.
   */
  guardPlanner: ((chat: GuardSubject) => ChatGuardPlan | null) | null = null;
  /** The chats whose next spawn uses the plan its caller just handed over, rather than deriving one */
  private readonly guardsGiven = new WeakSet<LiveChat>();
  /** Read as each run starts, so a change in the settings applies to the next one; Core sets the layered store */
  defaults: RunDefaults;
  /** What each chat's last process loaded, from its `init` event, with its folder's last as the fallback */
  readonly environments: EnvironmentIndex;

  private readonly publisher = new RunEventPublisher((event) => this.bus?.emit(event));
  /** The token each process was minted, for a server handed to it at run time, in which the CLI expands no reference */
  private readonly procTokens = new WeakMap<ChildProcessWithoutNullStreams, string | null>();
  /** The processes Claudio pushed its own server to: until then a `claudio` they list came from their `--mcp-config` */
  private readonly claudioPushed = new WeakSet<ChildProcessWithoutNullStreams>();
  /** What the CLI said when it last refused Claudio's server in a chat, by chat */
  private readonly claudioRefusals = new Map<string, string>();

  private readonly file: string;

  /** What the code that reads a chat's process needs of this manager */
  private readonly host: ChatHost;

  /**
   * CLI processes found at start still working on a restored chat's session, by chat id: a previous
   * wrapper went away without them (a crash, or `tsx watch` killing it mid-shutdown). Nothing here
   * can write to their stdin, so the chat cannot attach to them; it must not resume beside them.
   */
  private readonly leftovers = new Map<string, number[]>();

  /** What the machine must have free before a chat may start; read once, so a restart is what changes it */
  private readonly admission = admissionLimitsFrom();

  /** Set while a person's start was refused a place; a worker's start gives way to it (admission-queue.ts) */
  private readonly interactive = new InteractiveHold();

  constructor(
    private readonly config: CoreConfig,
    private readonly db: Db,
    drivers: readonly ProviderDriver[] = [new ClaudeCodeDriver(() => config.claudeBin)],
  ) {
    super();
    this.providers = new ProviderRegistry(PROVIDER_MANIFESTS, drivers);
    this.defaults = config;
    // A switch asked for while a turn ran takes effect when its result arrives
    // (the result is announced before the chat is marked idle, so the check waits for the fold to finish)
    this.on('chat-result', (chatId: string) => setImmediate(() => void this.applyPendingAccount(chatId).catch(() => undefined)));
    // What waited for the agent's background work goes ahead once it is over (D3)
    this.on('chat-background-settled', (chatId: string) => setImmediate(() => void this.applyPendingAccount(chatId).catch(() => undefined)));
    this.file = join(config.dataDir, 'runs.json');
    this.retireTimer = setInterval(() => this.retireEnded(), RETIRE_SWEEP_MS);
    this.retireTimer.unref();
    for (const driver of drivers) {
      if (driver instanceof ClaudeCodeDriver) {
        driver.modelSource = { listed: () => this.accounts?.cachedModels(DEFAULT_ID) ?? null };
      }
    }
    this.environments = new EnvironmentIndex(db);
    const manager = this;
    this.host = {
      db,
      environments: this.environments,
      // Set by Core after construction, so read as it is when asked
      get permissions() {
        return manager.permissions;
      },
      emit: (event, ...args) => this.emit(event, ...args),
      persist: (chat) => this.persist(chat),
      noteActivity: (chat) => this.noteActivity(chat),
      // The stream's reading is the account's it ran on, and no one else's: no provider-wide reading is kept
      observeLimit: (chat, event) => {
        try {
          this.observeAccount(chat, event);
        } catch {
          // Output still draining after the database closed (shutdown): losing a limit reading must not become an uncaught error
        }
      },
      observeSignIn: (chat, authFailed) => this.observeSignIn(chat, authFailed),
      learnModelCosts: (execution, modelUsage) => this.learnModelCosts(execution, modelUsage),
      learnWindows: (modelUsage) => this.learnWindows(modelUsage),
      maybeLimit: (chat) => this.maybeLimit(chat),
      recordSpend: (chat, execution, usd) => this.recordSpend(chat, execution, usd),
      failProtocol: (chat, message) => this.failProtocol(chat, message),
      guardArmed: (chat) => this.guardArmed(chat),
      guardMissing: (chat) => this.guardMissing(chat),
    };
  }

  /** The driver a request asks for, or the person's default; refused when that provider cannot run chats. */
  driverFor(provider: ProviderId | undefined): ProviderDriver {
    const settings = this.providerSettings?.() ?? { order: this.providers.list().map((m) => m.id), defaultProvider: null };
    const id = provider ?? this.providers.defaultSessionProvider(settings);
    const driver = id ? this.providers.driverFor(id) : null;
    if (!driver) throw new ChatRefusal('this provider cannot run chats yet');
    return driver;
  }

  /** The CLI's per-model cost, cumulative over its process like the total, so it only ever grows. */
  private learnModelCosts(execution: Execution, modelUsage: ModelUsage[]): void {
    for (const { model, costUsd: usd } of modelUsage) {
      if (usd === undefined) continue;
      execution.modelCosts = { ...execution.modelCosts, [model]: Math.max(execution.modelCosts?.[model] ?? 0, usd) };
    }
  }

  /**
   * One row of the daily spend ledger per result, so the cap sums what was spent on the day it was
   * spent. The account's kind is looked up now: the ledger keeps it as it was.
   */
  private recordSpend(chat: LiveChat, execution: Execution, usd: number | null): void {
    let kind: string | null = null;
    const account = execution.account ?? chat.account ?? null;
    try {
      kind = this.accounts?.ref(account ?? DEFAULT_ID).kind ?? null;
    } catch {
      // an account removed since: its kind is unknown
    }
    let projectId: string | null = null;
    try {
      projectId = this.projectOf?.(chat.workingDir ?? chat.cwd) ?? null;
    } catch {
      // a row without its project is still a row
    }
    try {
      this.db.addSpend({
        at: new Date().toISOString(),
        chatId: chat.id,
        executionId: execution.id,
        usd: usd ?? 0,
        reported: usd !== null,
        purpose: chat.opts.purpose ?? 'other',
        account: account && account !== DEFAULT_ID ? account : null,
        accountKind: kind,
        projectId,
        orchestrationId: chat.meta.orchestrationId ?? null,
      });
    } catch {
      // Output still draining after the database closed (shutdown): a missing row must not become an uncaught error
      return;
    }
    this.emit('spend-recorded');
  }

  /** The context window the CLI reports for each model that answered: the only real source of one. */
  private learnWindows(modelUsage: ModelUsage[]): void {
    for (const { model, contextWindow: window } of modelUsage) {
      if (window === undefined || window <= 0) continue;
      try {
        this.db.saveModelWindow(model, window);
      } catch {
        // a window that could not be written is only a percentage that shows later
      }
    }
  }

  /**
   * Writes the chats that changed: the ones named here, which changed without an event, and every
   * one that emitted an event since it was last written (`dirty`).
   */
  private persist(...touched: LiveChat[]): void {
    // Internal chats are persisted too. The origin means "housekeeping: no transcript, hidden from
    // the chat list", not "disposable": the orchestration planner is internal and costs real
    // money, and dropping it on restart took the only record of that work with it. The other
    // internal chat, the auth check, removes itself as soon as it finishes.
    //
    // A dirty chat is compared with what was last written of it and only what changed is written:
    // this runs on every turn of every chat. The table is trimmed only when a chat is new to it, the
    // only way it can grow.
    for (const chat of touched) this.dirty.add(chat.id);
    if (this.dirty.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    const candidates: Array<{ chat: LiveChat; record: StoredChat['record']; recordJson: string; executionJson: Map<string, string>; known: SavedChat | undefined }> = [];
    for (const id of ids) {
      // Removed since, or retired: a retired chat was written before it was
      const chat = this.chats.peek(id);
      if (!chat) continue;
      const record = chat.record();
      const known = this.saved.get(chat.id);
      const recordJson = JSON.stringify(record);
      const executionJson = new Map(chat.executions.map((e) => [e.id, JSON.stringify(e)]));
      const same = known !== undefined && known.record === recordJson && chat.executions.every((e) => known.executions.get(e.id) === executionJson.get(e.id));
      if (!same) candidates.push({ chat, record, recordJson, executionJson, known });
    }
    if (candidates.length === 0) return;
    try {
      // A chat trimmed from the table since it was written, by a trim of ours or of another process
      // sharing the file, is written whole again: its executions went with it, and writing only
      // the ones that changed would bring it back with part of its history
      const stored = this.db.storedChats(candidates.filter((c) => c.known).map((c) => c.chat.id));
      let added = false;
      const changed: StoredChat[] = candidates.map(({ chat, record, executionJson, known }) => {
        const kept = known && stored.has(chat.id) ? known : undefined;
        added ||= !kept;
        return { record, executions: chat.executions.filter((e) => kept?.executions.get(e.id) !== executionJson.get(e.id)) };
      });
      // What this process holds in memory is a conversation going on: the trim never takes its rows
      const trimmed = this.db.saveChats(changed, added ? MAX_PERSISTED_CHATS : null, new Set([...this.chats.values()].map((c) => c.id)));
      for (const { chat, recordJson, executionJson } of candidates) this.saved.set(chat.id, { record: recordJson, executions: executionJson });
      // A retired chat whose row went is gone, as a restart would find it
      this.chats.forgetRetired(trimmed);
      for (const id of trimmed) this.saved.delete(id);
    } catch (err) {
      // Persistence must never take the live chat down with it, but it must not fail unseen: the
      // chats stay dirty, so the next save tries them again
      for (const { chat } of candidates) this.dirty.add(chat.id);
      this.saveFailures.failed(err);
    }
  }

  private readonly saveFailures = new ThrottledLog('chats: saving the chats');

  /**
   * Carries a pre-SQLite `runs.json` into the store once, then renames it out of the way:
   * `.migrated` once carried, `.corrupt` when it could not be read, so what was lost is said and kept.
   */
  private importLegacy(): void {
    if (!existsSync(this.file)) return;
    let carried = true;
    try {
      this.db.saveChats(chatsFromRuns(JSON.parse(readFileSync(this.file, 'utf8')) as LegacyRun[]).chats, MAX_PERSISTED_CHATS);
    } catch (err) {
      carried = false;
      console.warn(`chats: ${this.file} could not be carried into the database and was set aside as .corrupt: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      renameSync(this.file, `${this.file}.${carried ? 'migrated' : 'corrupt'}`);
    } catch {
      // another process got there first
    }
  }

  /** What was last written of a chat, as `persist` compares it */
  private static savedOf(chat: LiveChat): SavedChat {
    return { record: JSON.stringify(chat.record()), executions: new Map(chat.executions.map((e) => [e.id, JSON.stringify(e)])) };
  }

  /**
   * A retired chat, back from its row in the store: what a restart restores of it, and nothing it
   * had only in memory (its event buffer, its last result). Null when the row is gone.
   */
  private wake(id: string): LiveChat | null {
    let entry: StoredChat | null;
    try {
      entry = this.db.loadChat(id);
    } catch {
      return null; // the store closed under it: a shutdown
    }
    const driver = entry ? this.providers.driverFor(entry.record.provider ?? '') : null;
    if (!entry || !driver) return null;
    const chat = LiveChat.restore(entry, this.config, driver);
    this.saved.set(id, ChatManager.savedOf(chat));
    this.watch(chat);
    return chat;
  }

  /** Whether nothing holds the chat in memory any more: no process, nobody reading it or waiting on it, nothing left to deliver or replay. */
  private retirable(chat: LiveChat, cutoff: string): boolean {
    return (
      !chat.alive &&
      (chat.status === 'completed' || chat.status === 'failed' || chat.status === 'stopped') &&
      chat.endedAt !== null &&
      chat.endedAt <= cutoff &&
      chat.viewers === 0 &&
      chat.preparing === 0 &&
      chat.pending.size === 0 &&
      !chat.respawnQueued &&
      !chat.carrying &&
      // A limit's wait and replay need the turn it holds in memory
      !chat.rateLimited &&
      !chat.limitRequested &&
      !chat.authFailed &&
      !chat.pendingAccount &&
      !this.leftovers.has(chat.id) &&
      // Only the manager's own listener: a caller waiting for the chat's next result holds it
      chat.emitter.listenerCount('event') <= 1
    );
  }

  /**
   * Retires from memory the chats that ended more than `retireAfterMs` before `nowMs` and that nothing
   * holds, keeping the summary waking them would read back. Runs on a timer; returns the ids retired.
   */
  retireEnded(nowMs: number = Date.now()): string[] {
    const cutoff = new Date(nowMs - this.retireAfterMs).toISOString();
    const retired: string[] = [];
    for (const chat of [...this.chats.values()]) {
      if (!this.retirable(chat, cutoff)) continue;
      // Written first: the row is the chat from here on. One whose write failed stays until it goes through
      this.persist(chat);
      if (this.dirty.has(chat.id)) continue;
      let entry: StoredChat | null = null;
      try {
        entry = this.db.loadChat(chat.id);
      } catch {
        return retired; // the store closed: a shutdown
      }
      // Trimmed by another process sharing the file: kept, and written whole again by the next save
      if (!entry) continue;
      const summary = LiveChat.restore(entry, this.config, chat.driver).summary();
      chat.emitter.removeAllListeners('event');
      this.chats.retire(chat.id, summary);
      this.saved.delete(chat.id);
      // A list that showed it as it was in memory hears what it reads now
      this.publisher.observe(summary);
      retired.push(chat.id);
    }
    return retired;
  }

  /**
   * Loads the chats of previous wrapper processes from their rows. No transcript is replayed into
   * them: a chat's page reads its transcript from the session store, and replaying every stored
   * chat's at each start held the start for as long as the slowest transcript took. A chat that
   * ended long ago is retired at once to its summary, and woken when something needs it; only one a
   * restart cut off, or with a process of a previous wrapper still on it, stays in memory, and the
   * transcript's summary says when the cut one really stopped.
   */
  async restore(sessions: SessionStore): Promise<void> {
    for (const manifest of this.providers.list()) {
      const driver = this.providers.driverFor(manifest.id);
      if (driver instanceof ClaudeCodeDriver) driver.useSessions(sessions);
    }
    this.importLegacy();
    // A chat of a provider that has no driver here cannot be driven, so it is left in the store as it is
    const stored = this.db.loadChats().filter(({ record }) => !this.chats.has(record.id) && this.providers.driverFor(record.provider ?? ''));
    // Before the first await, so whoever starts the wrapper can report them as soon as Core exists
    const live = this.liveSessions();
    for (const { record } of stored) {
      const pids = live.filter((p) => p.sessionId === record.id).map((p) => p.pid);
      if (pids.length) this.leftovers.set(record.id, pids);
    }
    const cutoff = new Date(Date.now() - this.retireAfterMs).toISOString();
    const cut: LiveChat[] = [];
    for (const entry of stored) {
      const driver = this.providers.driverFor(entry.record.provider ?? '');
      if (!driver || this.chats.has(entry.record.id)) continue;
      const chat = LiveChat.restore(entry, this.config, driver);
      const pids = this.leftovers.get(chat.id);
      // What is read back is what was written: nothing to save again. One the restore cut off has
      // an execution it ended just now, and is written whole below
      if (!chat.cutOff) this.saved.set(chat.id, ChatManager.savedOf(chat));
      if (!chat.cutOff && !pids && chat.endedAt !== null && chat.endedAt <= cutoff) {
        this.chats.set(chat.id, chat);
        this.chats.retire(chat.id, chat.summary());
        this.saved.delete(chat.id);
        this.publisher.baseline(chat.summary());
        continue;
      }
      this.chats.set(chat.id, chat);
      if (chat.cutOff) cut.push(chat);
      if (pids) {
        chat.push({
          kind: 'notice',
          text:
            `A CLI process a previous wrapper started for this session is still running (pid ${pids.join(', ')}). ` +
            'It is not tracked here, so the chat cannot be resumed beside it: wait for it to finish, or stop the chat to end it.',
          data: { pids },
        });
        chat.updatedAt = entry.record.updatedAt; // push() bumped it
      }
      this.watch(chat);
    }
    for (const chat of cut) {
      // The transcript is written as the CLI works, so its last line is when the process really
      // stopped; the stored record can be older than that. Its summary is cached, not a replay
      const heard = (await sessions.summary(chat.id).catch(() => null))?.updatedAt;
      const execution = chat.cutOff;
      if (execution?.endedAt && heard && heard > execution.endedAt && heard <= now()) {
        execution.endedAt = heard;
        chat.endedAt = heard;
      }
    }
    // The executions the restore closed as interrupted are written down, so a second start does
    // not have to conclude it again
    this.persist(...cut);
    // What the servers core's callers added pointed at (a stub in a server that is gone) died with
    // the processes that read them: no process of this wrapper is running yet
    removeChatExtrasConfigs(this.config.dataDir, (chatId) => !this.chats.peek(chatId)?.alive);
  }

  /** Processes found at start working on a restored chat's session that are still up. */
  strays(): Array<{ chatId: string; pid: number }> {
    if (this.leftovers.size === 0) return [];
    const live = this.liveSessions();
    return [...this.leftovers].flatMap(([chatId, pids]) =>
      pids.filter((pid) => live.some((p) => p.pid === pid && p.sessionId === chatId)).map((pid) => ({ chatId, pid })),
    );
  }

  /** The processes of every driver that hold a session, read once so matching many chats costs one pass. */
  private liveSessions(): Array<{ pid: number; sessionId: string }> {
    return this.providers.list().flatMap((m) => this.providers.driverFor(m.id)?.liveSessions() ?? []);
  }

  /**
   * What would share the session with a process started for this chat now: any CLI process on it,
   * this wrapper's (another chat on the same session) or not, which includes whatever a previous
   * wrapper left.
   * A session that does not exist yet (a new chat, a fork) has no one on it.
   */
  private sessionHolders(chat: LiveChat): number[] {
    return chat.created ? chat.driver.sessionHolders(chat.id) : [];
  }

  /** Announces what changes in the chat from here on; `created` also announces the chat itself. */
  private watch(chat: LiveChat, created = false): void {
    if (created) this.publisher.created(chat.summary());
    else this.publisher.baseline(chat.summary());
    chat.emitter.on('event', (event: RunEvent) => {
      // A partial is only text on its way: it is neither stored nor shown in a list
      if (event.kind === 'partial') return;
      this.dirty.add(chat.id);
      // stderr changes nothing a list shows
      if (event.kind !== 'stderr') this.publisher.observe(chat.summary());
    });
  }

  /**
   * Announces what the chat is doing, when it changed. Called after every line the CLI writes, so
   * the comparison comes first: a chat streaming a paragraph produces dozens of lines a second and
   * none of them changes the one word the ticker shows.
   */
  private noteActivity(chat: LiveChat): void {
    const key = activityKey(chat.alive ? chat.activity.current() : null);
    if (key !== chat.activityKey) {
      chat.activityKey = key;
      this.publisher.activity(chat.summary());
    }
    this.noteBranchActivity(chat);
  }

  /**
   * The same for each subagent the chat is running, by the call that launched it. A subagent whose
   * ticker is gone (it reported back, or the turn or the process ended) is announced as doing
   * nothing, once.
   */
  private noteBranchActivity(chat: LiveChat): void {
    const moved: Array<{ toolUseId: string; activity: ChatActivity | null }> = [];
    for (const [toolUseId, tracker] of chat.branchActivity) {
      const activity = chat.alive ? tracker.current() : null;
      const key = activityKey(activity);
      if (key === (chat.branchActivityKeys.get(toolUseId) ?? '')) continue;
      chat.branchActivityKeys.set(toolUseId, key);
      moved.push({ toolUseId, activity });
    }
    for (const [toolUseId, key] of chat.branchActivityKeys) {
      if (chat.branchActivity.has(toolUseId)) continue;
      chat.branchActivityKeys.delete(toolUseId);
      if (key) moved.push({ toolUseId, activity: null });
    }
    if (moved.length === 0) return;
    const run = chat.summary();
    for (const { toolUseId, activity } of moved) {
      this.publisher.subagentActivity(run, { toolUseId, agentId: chat.branches.subagents.get(toolUseId)?.agentId ?? null, activity });
    }
  }

  list(): ChatRuntime[] {
    return this.chats.summaries().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** A retired chat answers with the summary it was retired with, which is what waking it would read back */
  get(id: string): ChatRuntime | null {
    return this.chats.summaryOf(id);
  }

  /**
   * The tokens and cost of the chat's last turn alone (see `LiveChat.lastTurn`). Read when that
   * turn's `result` event arrives: the event is pushed after the figures are set.
   */
  lastTurn(id: string): { tokens: TokenUsage | null; costUsd: number | null } | null {
    return this.chats.get(id)?.lastTurn ?? null;
  }

  /**
   * What the process working on a chat is doing right now, read from the events it streamed: when
   * it last did anything, and the shell commands it started and has not had an answer to. Null
   * when Claudio has no process on the chat, which is when there is nothing to watch. Only the
   * live execution counts: a command a previous wrapper left unanswered is not running.
   */
  pulse(id: string): ChatPulse | null {
    const trace = this.trace(id);
    if (!trace) return null;
    return {
      lastEventAt: trace.lastEventAt,
      commands: runningCommands(trace).map((call) => {
        const beat = trace.heartbeats.get(call.id);
        return {
          command: typeof call.input.command === 'string' ? call.input.command : 'a command',
          startedAt: call.at,
          toolUseId: call.id,
          ...(beat ? { heartbeat: beat } : {}),
        };
      }),
    };
  }

  /**
   * Every tool call the live execution has made and what came back, with the CLI's heartbeats for
   * the ones still running: what the signals of a worker that is busy and getting nowhere are read
   * from. Null when Claudio has no process on the chat. A turn that ended closes whatever was still
   * open in it, so a call an interrupt left without an answer is not a command running for ever.
   */
  trace(id: string): Trace | null {
    const chat = this.chats.get(id);
    const live = chat?.execution;
    if (!chat || !live || !chat.alive) return null;
    const calls = new Map<string, ToolCall>();
    const guards: GuardTraceEntry[] = [];
    for (const event of chat.events) {
      if (event.ts < live.startedAt) continue;
      if (event.kind === 'guard' && event.guard) {
        guards.push({ at: event.ts, outcome: event.guard.outcome, rule: event.guard.rule });
        continue;
      }
      if (event.kind === 'result') {
        for (const call of calls.values()) call.endedAt ??= event.ts;
        continue;
      }
      // A subagent's calls stream on its sidechain, each line naming the lead's call that launched it
      const parent = event.entry?.parentToolUseId ?? null;
      for (const block of event.entry?.blocks ?? []) {
        if (block.type === 'tool_use') {
          const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
          calls.set(block.id, { id: block.id, name: block.name, input, at: event.ts, endedAt: null, isError: false, result: '', ...(parent ? { parentToolUseId: parent } : {}) });
        } else if (block.type === 'tool_result') {
          const call = calls.get(block.toolUseId);
          if (call) Object.assign(call, { endedAt: event.ts, isError: block.isError, result: block.content.slice(0, 300) });
        }
      }
    }
    // Who each subagent is, by the call that launched it: what a signal about one of its calls names
    const agents = new Map<string, TraceAgent>();
    for (const call of calls.values()) {
      if (!call.parentToolUseId || agents.has(call.parentToolUseId)) continue;
      const sub = chat.branches.subagents.get(call.parentToolUseId);
      agents.set(call.parentToolUseId, sub ? { description: sub.description, subagentType: sub.subagentType } : {});
    }
    return {
      executionStartedAt: live.startedAt,
      lastEventAt: chat.activityAt,
      calls: [...calls.values()],
      heartbeats: new Map(chat.heartbeats),
      ...(guards.length ? { guards } : {}),
      ...(agents.size ? { agents } : {}),
    };
  }

  /**
   * Kills the process tree of one command a chat is running, and only that: the turn goes on, the
   * CLI writes a failed result for the call and the worker carries on with it. Which processes are
   * the command's is worked out from the tree under the CLI's pid and from when each started (see
   * {@link commandRoots}); nothing is matched on a command line. Refuses rather than guesses when
   * the command has no process of its own to be found.
   */
  cancelCommand(id: string, toolUseId: string): { command: string; processes: number } {
    const chat = this.chats.get(id);
    if (!chat) throw new ChatNotFoundError();
    const trace = this.trace(id);
    if (!trace || !chat.proc?.pid) throw new Error('the chat has no live process, so it runs no command');
    const open = runningCommands(trace);
    const at = open.findIndex((c) => c.id === toolUseId);
    const call = open[at];
    if (!call) throw new Error(`the call ${toolUseId} is not a command that is running: it may have ended already`);
    const table = processTable();
    if (table.length === 0) throw new Error('a command can only be cancelled where /proc lists the processes, which this system does not');
    const cli = cliProcessOf(table, chat.proc.pid, chat.id);
    if (!cli) throw new Error('the CLI process is gone');
    const { roots, unclaimed } = commandRoots(table, cli.pid, open.map((c) => Date.parse(c.at)));    const root = roots[at];
    if (!root) throw new Error('no process of this command was found: it has not started yet, or has ended');
    // Never the CLI itself, whatever the clock says: that is stopping the chat, which has its own action
    if (root.argv.includes('stream-json')) throw new Error('the process found for this command is a CLI, not a command');
    // A background command also leaves a child of the CLI behind, and nothing says which one is whose
    const earliest = Date.parse(open[0]?.at ?? call.at);
    if (unclaimed > 0 && trace.calls.some((c) => c.name === 'Bash' && c.input.run_in_background === true && Date.parse(c.at) >= earliest - 2000)) {
      throw new Error('cannot tell this command\'s process from a background command\'s started beside it: stop the chat or wait');
    }
    chat.cancelled.add(toolUseId);
    const command = typeof call.input.command === 'string' ? call.input.command : 'a command';
    return { command, processes: terminateTree(root, table) };
  }

  events(id: string, sinceSeq = 0): RunEvent[] {
    return this.chats.get(id)?.events.filter((e) => e.seq > sinceSeq) ?? [];
  }

  /** Where a chat's event buffer stands, for a page that reads the transcript and then opens the stream. */
  streamPosition(id: string): { seq: number; executionSeq: number } | null {
    const chat = this.chats.get(id);
    return chat ? { seq: chat.seq, executionSeq: chat.executionSeq } : null;
  }

  /** The block being written right now, whole, for a subscriber that joined in the middle of it. */
  partialSnapshot(id: string): RunEvent | null {
    return this.chats.get(id)?.partialSnapshot() ?? null;
  }

  /**
   * The messages a chat's process streamed, oldest first: what its transcript would hold, for a
   * chat that keeps none (housekeeping ones run without persistence, and a new one has written
   * nothing yet). Null when Claudio has no such chat.
   */
  messages(id: string): TranscriptEntry[] | null {
    const chat = this.chats.get(id);
    if (!chat) return null;
    return chat.events.flatMap((e): TranscriptEntry[] => (e.kind === 'message' && e.entry ? [e.entry] : []));
  }

  activeCount(): number {
    return [...this.chats.values()].filter((r) => r.alive).length;
  }

  /**
   * The guard files the chats' plans name: the sweep of the guard folder never removes these, since a
   * process reads its rules file on every tool call. A chat without a process counts too: its plan
   * is what it would be launched with until its next spawn derives another.
   */
  liveGuardFiles(): string[] {
    return [...this.chats.values()].flatMap((chat) => {
      const plan = chat.opts.guards;
      return plan ? [plan.settingsPath, join(dirname(plan.settingsPath), `${plan.rulesSha256.slice(0, 16)}.rules.json`)] : [];
    });
  }

  /** The chats whose process is up, with its pid: what the resource report of the machine is grouped by */
  livePids(): Array<{ chatId: string; pid: number }> {
    return [...this.chats.values()].flatMap((chat) => (chat.alive && chat.proc?.pid !== undefined ? [{ chatId: chat.id, pid: chat.proc.pid }] : []));
  }

  subscribe(id: string, listener: (event: RunEvent) => void): () => void {
    const chat = this.chats.get(id);
    if (!chat) return () => {};
    chat.emitter.on('event', listener);
    // The stream route is the only caller, and it stands for a person reading the chat
    chat.viewers++;
    let open = true;
    return () => {
      chat.emitter.off('event', listener);
      if (open) chat.viewers--;
      open = false;
    };
  }

  /**
   * Starts a new chat: a new session, under an id Claudio chooses and imposes on the CLI. Continuing
   * a conversation that exists is `resume` (the same chat) or `fork` (a new one), never this.
   */
  start(opts: NewChat, meta: RunMeta = {}): ChatRuntime {
    if (!opts.prompt?.trim() && !opts.attachments?.length) throw new ChatRefusal('prompt is required');
    const driver = this.driverFor(opts.provider);
    const room = this.admit(opts, driver, classOfStart({ purpose: opts.purpose, internal: opts.internal, queued: meta.queued }));
    const attachments = this.resolveAttachments(opts.attachments);
    const origin = opts.internal ? 'internal' : meta.orchestrationId ? 'orchestration' : opts.apiClient ? 'api' : 'claudio';
    if (opts.apiPolicy) opts.apiAttachments = attachments.map((a) => a.path);
    const chat = new LiveChat(randomUUID(), opts, meta, origin, null, this.chatDefaults(), driver);
    // The starter derived the plan a moment ago, or chose none: the first process runs as it said
    this.guardsGiven.add(chat);
    return this.begin(chat, opts.prompt, attachments, room);
  }

  /**
   * Continues a chat nobody holds, in place: a new execution on the same session, which keeps its id.
   * A chat this wrapper has no record of (it was started from a terminal, say) is adopted: it
   * becomes ours to drive, and stays `external`, because that is where it was born. Whether
   * something holds the session is checked again here, on the process table, whatever the caller
   * saw a moment ago.
   */
  resume(id: string, request: ResumeChatRequest & ResolvedTools & ExecutionExtras, adopt?: AdoptedChat): ChatRuntime {
    if (!request.prompt?.trim() && !request.attachments?.length) throw new ChatRefusal('prompt is required');
    let chat = this.chats.get(id);
    if (chat?.alive) throw new ChatRefusal('the chat already has a live execution; send it a message instead');
    const driver = chat?.driver ?? this.driverFor(request.provider);
    const room = this.admit(request, driver, classOfStart({ purpose: request.purpose, housekeeping: request.housekeeping !== undefined, queued: request.queued }));
    const attachments = this.resolveAttachments(request.attachments);
    if (!chat) {
      if (!adopt) throw new ChatNotFoundError();
      chat = new LiveChat(id, { prompt: request.prompt, cwd: adopt.cwd, name: adopt.name, ...(adopt.model ? { model: adopt.model } : {}) }, {}, 'external', null, this.chatDefaults(), driver, true);
      chat.workingDir = adopt.cwd;
    }
    this.applyStartOptions(chat, request);
    // The files a resume attaches join the ones a confined chat may read; its guard was armed with them
    if (chat.opts.apiPolicy && attachments.length) chat.opts.apiAttachments = [...new Set([...(chat.opts.apiAttachments ?? []), ...attachments.map((a) => a.path)])];
    // A new execution is a new turn to see through: the replay it may need is its own, not one an
    // earlier execution of the chat already spent (a flow run continues its member's chat this way)
    chat.limitReplays = 0;
    const known = this.chats.has(id);
    if (!known) this.chats.set(id, chat);
    chat.purpose = request.housekeeping ?? null;
    try {
      this.spawnProcess(chat, sent(request.prompt, attachments), room);
    } catch (err) {
      // Refused before any process started (something else holds the session): an adopted chat is not ours yet
      chat.purpose = null;
      if (!known) this.discardUnstarted(id);
      throw err;
    }
    if (!known) this.watch(chat, true);
    return chat.summary();
  }

  /**
   * Continues a chat in a copy: a new chat, with the same history, that records where it came from.
   * The copy's id is chosen here and imposed on the CLI (`--session-id` beside `--fork-session`), so
   * the chat exists under its final id from the first instant and no other row can stand for it.
   */
  fork(sourceId: string, request: ResumeChatRequest & ResolvedTools & Pick<ExecutionExtras, 'handBack' | 'purpose' | 'guards'>, source: AdoptedChat): ChatRuntime {
    if (!request.prompt?.trim() && !request.attachments?.length) throw new ChatRefusal('prompt is required');
    const known = this.chats.get(sourceId);
    if (known?.opts.apiPolicy) throw new ChatRefusal('a confined API chat cannot be forked: start a new chat with the policy it needs', 409);
    const driver = known?.driver ?? this.driverFor(request.provider);
    const room = this.admit(request, driver, classOfStart({ purpose: request.purpose }));
    const attachments = this.resolveAttachments(request.attachments);
    const chat = new LiveChat(
      randomUUID(),
      {
        prompt: request.prompt,
        cwd: source.cwd,
        name: `${source.name} (fork)`.slice(0, 60),
        ...(source.model ? { model: source.model } : {}),
        // A fork thinks as hard as its source did, unless the request says otherwise
        ...(known?.effort ? { effort: known.effort } : {}),
      },
      {},
      'claudio',
      { chatId: sourceId, at: now() },
      this.chatDefaults(),
      driver,
    );
    // An agent that names its own sessions is asked to copy by the name it gave, not the chat's
    chat.forkFrom = driver.sessionIds === 'assigned' ? (known?.nativeId ?? sourceId) : sourceId;
    chat.workingDir = source.cwd;
    // A fork of an assistant chat is an assistant chat: the marker comes from the source, never from the request
    if (known?.opts.claudioAssistant) chat.opts.claudioAssistant = known.opts.claudioAssistant;
    if (known) chat.permissionMode = known.permissionMode;
    // A fork goes on where its source was, as `ChatStartOptions.account` says: on its account, and
    // pinned to it when the source was; the rotation still moves it from there at a limit. A request
    // that names an account wins (applied next)
    if (known) {
      chat.account = known.account;
      if (known.opts.account) chat.opts.account = known.opts.account;
    }
    this.applyStartOptions(chat, request);
    return this.begin(chat, request.prompt, attachments, room);
  }

  /**
   * The idle chats whose input a start would end to fit, least recently used first: those held warm
   * for a reader past the idle timeout, and an OpenAI client's chats at any point of their wait. They
   * exit within moments, as after the idle timeout, so they count as free. Empty when there is room
   * already, null when ending every candidate would still not make room: then the start is refused
   * anyway, and nobody's process is ended for it. Nothing is ended here: {@link evict} does that,
   * once nothing else refuses the start.
   */
  private evictionFor(limit: number): LiveChat[] | null {
    const at = Date.now();
    let busy = 0;
    const idle: LiveChat[] = [];
    for (const chat of this.chats.values()) {
      // Its process may have exited already: the slot stays taken until its replacement starts
      if (chat.slotReserved) {
        busy++;
        continue;
      }
      if (!chat.alive || chat.released) continue;
      busy++;
      if (this.evictable(chat, at)) idle.push(chat);
    }
    const excess = busy - limit + 1;
    if (excess <= 0) return [];
    if (idle.length < excess) return null;
    return idle.sort((a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0)).slice(0, excess);
  }

  /**
   * Ends the input of the chats {@link evictionFor} chose. `released` is set before this returns,
   * and admission runs to the spawn without yielding, so two starts never take the same slot.
   */
  private evict(chats: readonly LiveChat[]): void {
    const at = Date.now();
    for (const chat of chats) {
      if (chat.origin === 'api') console.warn(`run slots: ended the idle process of API chat ${chat.id} (idle ${String(Math.round((at - (chat.idleSince ?? at)) / 1000))} s) for a new run`);
      chat.released = true;
      chat.session?.endInput();
    }
  }

  /**
   * An idle process whose input can be ended for a slot without losing anything. Never one with a
   * message waiting for it or for its replacement, or a turn being prepared for it (`preparing`).
   * Never one with work running in the background, however long it has been idle (D3): its process
   * does not exit when its input ends, so it would count as free while it still runs, and the CLI
   * kills that work once it has waited for it long enough. Past the idle timeout the rule is the one
   * warm chats always had; before it, only an API chat's slot is given away.
   */
  private evictable(chat: LiveChat, at: number): boolean {
    if (chat.status !== 'idle' || chat.idleSince === null || chat.preparing > 0 || chat.pending.size > 0) return false;
    if (runsInBackground(chat.branches)) return false;
    if (at - chat.idleSince >= idleTimeoutMs()) return true;
    return this.evictableApiChat(chat);
  }

  /**
   * An OpenAI client's chat whose idle process may give its slot away before the idle timeout: every
   * new conversation (and each background task of a client like Open WebUI) is a chat of its own,
   * and their idle processes would otherwise refuse everyone, a person included, for ten minutes. Its
   * next turn resumes cold, as after the timeout. Only one that waits for nothing: no permission
   * prompt, no client tool call held, owed or not yet handed to the CLI, no limit to replay.
   */
  private evictableApiChat(chat: LiveChat): boolean {
    if (chat.origin !== 'api' || this.leaving(chat) || chat.rateLimited || chat.pendingAccount || chat.armingQueue.length > 0) return false;
    if (chat.permissionHost?.holding?.()) return false;
    return !(this.permissions?.has(chat.id) ?? false);
  }

  /**
   * Keeps the chat's idle process from giving its slot away while a caller prepares the turn it is
   * about to send (the /v1 route awaits settings between deciding the chat is live and sending to
   * it). Returns the release, which the caller runs once the turn is sent or abandoned.
   */
  holdForTurn(id: string): () => void {
    const chat = this.chats.get(id);
    if (!chat) return () => {};
    chat.preparing++;
    let held = true;
    return () => {
      if (held) chat.preparing--;
      held = false;
    };
  }

  /**
   * The chat's process will read no more messages (its slot given away, its input ended, a
   * replacement already queued): a turn that needs its own launch flags waits for the exit and
   * resumes cold, since a message sent now would be held for a replacement started with the chat's.
   */
  isLeaving(id: string): boolean {
    const chat = this.chats.get(id);
    return !!chat && this.leaving(chat);
  }

  /**
   * Refuses what cannot start, before anything is created, and answers which idle processes the
   * start ends to fit: the caller hands them to the spawn ({@link spawnProcess}), so a start refused
   * later still (an unknown attachment, a session held elsewhere) has ended nobody's.
   */
  private admit(opts: ChatStartOptions, driver: ProviderDriver, kind: StartClass = 'other'): LiveChat[] {
    if (opts.account !== undefined) {
      if (!this.accounts) throw new ChatRefusal('accounts are not available here');
      try {
        this.accounts.ref(opts.account);
      } catch {
        throw new ChatRefusal(`account ${opts.account} not found`);
      }
    }
    // A person's chat goes before a worker: while one was refused a place, the places that free up are kept for its retry
    if (kind === 'worker' && this.interactive.active()) {
      throw new QueueYieldRefusal(`${QUEUE_YIELD_PREFIX}: a chat a person asked for is waiting for a place`);
    }
    let room: LiveChat[];
    try {
      const limit = this.defaults.maxConcurrentRuns;
      const found = this.evictionFor(limit);
      if (found === null) throw new RunSlotRefusal(limit);
      room = found;
      // Refused by the machine's memory, not by the count: a chat started now could be the one the kernel kills
      const { refusal } = readSystemLoad(this.admission);
      if (refusal) throw new MemoryRefusal(refusal);
    } catch (err) {
      // The person is told exactly what they were told before; the refusal only also reserves the next place
      if (kind === 'interactive' && (err instanceof RunSlotRefusal || err instanceof MemoryRefusal)) {
        this.interactive.hold();
      }
      throw err;
    }
    if (kind === 'interactive') this.interactive.release();
    return room;
  }

  /** What a new chat starts from: the configured workspace, and the default mode as it stands now */
  private chatDefaults(): Pick<CoreConfig, 'workspaceDir' | 'defaultPermissionMode'> {
    return { workspaceDir: this.config.workspaceDir, defaultPermissionMode: this.defaults.defaultPermissionMode };
  }

  /** What a request chooses for the execution it starts, on top of what the chat already had. */
  private applyStartOptions(chat: LiveChat, options: ChatStartOptions & ResolvedTools & ExecutionExtras): void {
    const { opts } = chat;
    if (options.handBack) {
      for (const key of ['lessons', 'agent', 'agentsFile', 'jsonSchema', 'systemPromptSnapshot', 'uploads', 'confine', 'keepAlive', 'permissionMode', 'appendSystemPrompt', 'allowedTools', 'disallowedTools', 'maxBudgetUsd', 'permissionPrompts', 'toolConfig', 'mcp'] as const) {
        delete opts[key];
      }
      chat.setSettings({ permissionMode: options.permissionMode ?? this.defaults.defaultPermissionMode });
    }
    if (options.agent !== undefined) {
      if (options.agent === null) delete opts.agent;
      else opts.agent = options.agent;
    }
    if (options.agentsFile !== undefined) {
      if (options.agentsFile === null) delete opts.agentsFile;
      else opts.agentsFile = options.agentsFile;
    }
    if (options.jsonSchema !== undefined) {
      if (options.jsonSchema === null) delete opts.jsonSchema;
      else opts.jsonSchema = options.jsonSchema;
    }
    if (options.systemPromptSnapshot !== undefined) {
      if (options.systemPromptSnapshot === null) delete opts.systemPromptSnapshot;
      else opts.systemPromptSnapshot = options.systemPromptSnapshot;
    }
    if (options.lessons !== undefined) {
      if (options.lessons === null) delete opts.lessons;
      else opts.lessons = options.lessons;
    }
    if (options.uploads !== undefined) {
      if (options.uploads === null) delete opts.uploads;
      else opts.uploads = options.uploads;
    }
    if (options.keepAlive !== undefined) opts.keepAlive = options.keepAlive;
    if (options.purpose !== undefined) opts.purpose = options.purpose;
    if (options.account !== undefined) opts.account = options.account;
    if (options.confine !== undefined) {
      if (options.confine === null) delete opts.confine;
      else opts.confine = options.confine;
    }
    if (options.guards !== undefined) {
      if (options.guards === null) delete opts.guards;
      else opts.guards = options.guards;
      this.guardsGiven.add(chat);
    }
    if (options.extraMcpServers !== undefined) {
      if (options.extraMcpServers === null) delete opts.extraMcpServers;
      else opts.extraMcpServers = options.extraMcpServers;
    }
    chat.setSettings({ ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}), ...(options.model ? { model: options.model } : {}) });
    // A rewind point belongs to the one process the resume starts, not to the ones after it
    if ('resumeSessionAt' in options || options.handBack) delete opts.resumeSessionAt;
    if (options.resumeSessionAt) opts.resumeSessionAt = options.resumeSessionAt;
    for (const key of ['model', 'effort', 'permissionMode', 'appendSystemPrompt', 'allowedTools', 'disallowedTools', 'maxBudgetUsd', 'maxTurns', 'fallbackModel', 'thinking', 'maxThinkingTokens', 'thinkingDisplay', 'permissionPrompts'] as const) {
      if (options[key] !== undefined) Object.assign(opts, { [key]: options[key] });
    }
    // `null` takes the chat back to the servers the CLI loads on its own
    if (options.mcp === null) delete opts.mcp;
    else if (options.mcp) opts.mcp = options.mcp;
    if (options.toolConfig !== undefined) opts.toolConfig = options.toolConfig;
  }

  private begin(chat: LiveChat, prompt: string, attachments: Attachment[], room: readonly LiveChat[]): ChatRuntime {
    // The working directory is never created here (D9): an empty folder in place of a missing one
    // turned a mistyped path, or a volume that was not mounted, into a run that read nothing
    this.chats.set(chat.id, chat);
    try {
      this.spawnProcess(chat, sent(prompt, attachments), room);
    } catch (err) {
      this.discardUnstarted(chat.id);
      throw err;
    }
    // After the spawn, so the announcement carries the status the process started with
    this.watch(chat, true);
    return chat.summary();
  }

  /**
   * Sends a new turn. A chat has at most one process: a live one gets the message, one on its way
   * out hands it to the single process that replaces it, and only a chat with none resumes the
   * session with --resume.
   */
  send(id: string, text: string, attachmentIds: string[] = [], messageId?: string, from: MessageFrom = {}): ChatRuntime {
    this.sendMessage(id, text, attachmentIds, messageId, undefined, from);
    const chat = this.chats.get(id);
    if (!chat) throw new ChatNotFoundError();
    return chat.summary();
  }

  /**
   * {@link send}, answering how the message was taken and the id it goes by (docs/chat-delivery.md).
   * An id already taken writes nothing and answers as it did the first time: a send retried after a
   * timeout reaches the agent once. `from` says who wrote it when a person did not (a hint of the
   * Supervisor's, a notice of Claudio's): the page draws it as a notice, never as the person's.
   */
  sendMessage(id: string, text: string, attachmentIds: string[] = [], messageId?: string, purpose?: HousekeepingPurpose, from: MessageFrom = {}): ChatMessageReceipt {
    const chat = this.chats.get(id);
    if (!chat) throw new ChatNotFoundError();
    const known = messageId ? chat.receipts.get(messageId) : undefined;
    if (known) return { ...known, duplicate: true };
    const attachments = this.resolveAttachments(attachmentIds);
    if (!text.trim() && attachments.length === 0) throw new Error('text is required');
    if (chat.opts.apiPolicy) {
      // Images and PDFs reach the model inline; any other file is read by path, which only the files
      // its guard and `--add-dir` were given at the start or a resume can be
      const known = new Set(chat.opts.apiAttachments ?? []);
      const unread = attachments.find((a) => a.kind === 'file' && !known.has(a.path));
      if (unread) throw new ChatStartRefusal(`a confined API chat reads attached files only from its start or a resume: ${unread.name} cannot be read now`, 400);
    }
    const message: SentMessage = { id: messageId ?? randomUUID(), text, attachments, sentAt: now(), source: from.source ?? 'person', ...(from.words !== undefined ? { words: from.words } : {}) };
    // The person has seen the chat since: what was lost before is theirs to have sent again or not
    chat.undelivered = [];
    let taken: ChatMessageTaken;
    if (this.leaving(chat)) {
      // Held for a replacement process, it would reach the CLI as work and its result would be fanned out as such
      if (purpose) throw new ChatRefusal('the chat is ending: try again when it has', 409);
      if (chat.alive && chat.released) {
        // Its process gave its slot to a start and is on its way out: the replacement takes a slot
        // now, or the sender hears there is none. Left to the exit, the slot could be gone by then,
        // and the message lost with the turn failed. The slot is the chat's (`slotReserved`) until
        // the replacement takes it at the exit, without a second admission that could refuse
        this.evict(this.admit({}, chat.driver, classOfChat(chat.origin)));
        chat.slotReserved = true;
      }
      // A message written now would never be read: it waits for the replacement, behind any
      // message already waiting, so the order they were sent in is the order they arrive in
      chat.pending.set(message.id, { ...message, state: 'held', order: chat.writes, results: chat.results });
      chat.push({ kind: 'message', entry: userEntry(message, message.text) });
      taken = 'held';
    } else if (!chat.alive) {
      const room = this.admit({}, chat.driver, purpose ? 'other' : classOfChat(chat.origin));
      chat.purpose = purpose ?? null;
      try {
        this.spawnProcess(chat, message, room);
      } catch (err) {
        chat.purpose = null;
        throw err;
      }
      taken = 'started';
    } else {
      const idle = chat.status === 'idle';
      // A housekeeping turn is only ever sent to a chat between turns: on a busy one the purpose would mark the wrong result
      if (purpose && !idle) throw new ChatRefusal('the chat is working: try again when it is idle', 409);
      if (purpose) chat.purpose = purpose;
      this.writeUserMessage(chat, message);
      // A driver that starts the turn at once has reported it taken by now; a CLI that reports
      // nothing leaves it written, as far as anyone here can tell
      taken = idle || (chat.reportsDelivery !== false && !chat.pending.has(message.id)) ? 'started' : 'written';
    }
    const receipt = { id: message.id, taken };
    chat.remember(receipt);
    this.persist(chat);
    return receipt;
  }

  /**
   * The guard plan of the process about to start (D6). A plan the caller just handed over stands; any
   * other spawn derives it again from the settings of now, so a rule switched off since the chat
   * started is off for its next process too. The Claudio assistant and housekeeping are never
   * guarded, and a confined API chat keeps the `declared-tools` guard its policy armed.
   */
  private planGuards(chat: LiveChat): void {
    const given = this.guardsGiven.delete(chat);
    if (chat.opts.claudioAssistant || chat.origin === 'internal') {
      delete chat.opts.guards;
      return;
    }
    if (given || chat.opts.apiPolicy || !this.guardPlanner) return;
    const plan = this.guardPlanner({
      cwd: chat.cwd,
      plan: chat.opts.guards ?? null,
      person: chat.opts.purpose === 'person' || chat.opts.purpose === undefined,
      policy: chat.opts.toolConfig?.policy ?? null,
      confined: !!chat.opts.confine,
    });
    if (plan) chat.opts.guards = plan;
    else delete chat.opts.guards;
  }

  /**
   * The process will not read another message: stopped, its stdin closed while it finishes
   * background work, messages already held for its replacement, or exited with its pipes still open.
   */
  private leaving(chat: LiveChat): boolean {
    if (chat.alive) return chat.stopRequested || chat.proc?.stdin.writableEnded === true || chat.respawnQueued;
    return chat.proc !== null && !chat.procClosed;
  }

  /** The process has exited: one process takes every message that waited for it. */
  private drainQueue(chat: LiveChat): void {
    const reserved = chat.slotReserved;
    chat.slotReserved = false;
    const held = chat.held();
    const [next, ...rest] = held;
    if (!next) return;
    for (const message of held) chat.pending.delete(message.id);
    // Something that heard the chat end may have resumed it already: then that process gets them all
    if (chat.alive) {
      for (const message of held) this.writeUserMessage(chat, message, false);
      return;
    }
    try {
      // A slot reserved at send time was admitted then, memory included
      this.spawnProcess(chat, next, reserved ? [] : this.admit({}, chat.driver, classOfChat(chat.origin)), false);
    } catch (err) {
      chat.error = err instanceof Error ? err.message : String(err);
      // The exit ended the chat while messages waited, and nothing will read them: the page is told
      // each one was lost, and anyone waiting for a result has to hear the chat ended
      for (const message of held) chat.lose(message, chat.error);
      chat.endedAt = null;
      this.finalize(chat, 'failed');
      return;
    }
    for (const message of rest) this.writeUserMessage(chat, message, false);
  }

  /** The files a confined API chat was given so far, the ones its next guard allows again */
  confinedFiles(id: string): string[] {
    return [...(this.chats.get(id)?.opts.apiAttachments ?? [])];
  }

  /** The files of these uploads, for a confined API chat's guard to allow; a bad id is refused as at a start */
  attachmentPaths(ids: string[] = []): string[] {
    return this.resolveAttachments(ids).map((a) => a.path);
  }

  /** Looks the uploads up before anything starts, so a bad id fails the request, not the turn. */
  private resolveAttachments(ids: string[] = []): Attachment[] {
    if (ids.length === 0) return [];
    if (!this.uploads) throw new ChatRefusal('attachments are not available');
    if (ids.length > MAX_ATTACHMENTS) throw new ChatRefusal(`at most ${MAX_ATTACHMENTS} files can be attached to one message`);
    const uploads = this.uploads;
    return ids.map((id) => {
      try {
        return uploads.get(String(id));
      } catch (err) {
        throw new ChatRefusal(err instanceof Error ? err.message : String(err), 404);
      }
    });
  }

  stop(id: string): ChatRuntime {
    const chat = this.chats.get(id);
    if (!chat) throw new ChatNotFoundError();
    chat.stopRequested = true;
    // Stopping means none of them is wanted any more, and the page is told so for each
    for (const message of chat.held()) {
      chat.pending.delete(message.id);
      if (!chat.carrying) chat.lose(message, STOPPED);
    }
    const proc = chat.proc;
    if (!chat.alive) {
      // Nothing of this wrapper's: what is left is a process a previous one started on this chat
      for (const pid of this.strays().filter((s) => s.chatId === id).map((s) => s.pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // gone in between
        }
      }
    }
    if (chat.alive && proc) {
      // The CLI's own children (a build, Vitest, Chromium) are not its to keep: they go with it, descendants first
      const table = processTable();
      const root = table.find((p) => p.pid === proc.pid);
      // The tree's own signal reaches the root last; signalling it again here sent it SIGTERM twice
      if (root) terminateTree(root, table, STOP_GRACE_MS);
      else proc.kill('SIGTERM');
      // The process being stopped, not whatever `chat.proc` is by then: a chat resumed within these
      // seconds has a new process, and this used to kill it
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      }, STOP_GRACE_MS).unref();
    }
    return chat.summary();
  }

  /**
   * Ends the current turn and keeps the process: the CLI withdraws any prompt it was holding and
   * waits for the next message, unlike `stop`, which takes the process down.
   */
  async interrupt(id: string, messageId?: string): Promise<ChatRuntime> {
    const chat = this.chats.get(id);
    if (!chat) throw new ChatNotFoundError();
    if (!chat.alive || !chat.session) throw new Error('the chat has no live process to interrupt');
    if (messageId !== undefined) {
      // The read-back that says the agent took it may sit in the stdout pipe already: what has
      // arrived is read before deciding, or "Send now" would cut the turn answering the message
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
      if (chat.pending.get(messageId)?.state !== 'written') {
        throw new ChatRefusal('the agent has already read this message, or it is not waiting in this chat', 409);
      }
    }
    const session = chat.session;
    if (!chat.alive || !session) throw new Error('the chat has no live process to interrupt');
    // Its input is closed: nothing written now would be read, and the turn is already over
    if (chat.proc?.stdin.writableEnded) return chat.summary();
    // Sent whatever the status says: the agent answers it harmlessly between turns, and a turn on a
    // queued message can be under way before anything of it has been streamed. Only a turn that can
    // end is marked, the lead's: a background agent's lines make the chat busy with no result to come
    const turning = chat.turnOpen || chat.written().length > 0;
    if (turning) chat.interruptRequested = true;
    // The receipt speaks for the messages written before the interrupt; a later one is still on its way
    const asked = chat.writes;
    let receipt: InterruptReceipt;
    try {
      receipt = await session.interrupt();
    } catch (err) {
      chat.interruptRequested = false;
      throw err;
    }
    if (chat.session !== session) return chat.summary();
    this.settleQueue(chat, receipt, asked);
    // The receipt comes before the interrupted turn's result: with no turn under way by then, there
    // is no result to clear the mark, and the next turn's own result is not this interrupt's
    if (!chat.turnOpen) chat.interruptRequested = false;
    return chat.summary();
  }

  /**
   * What an interrupt's receipt says of the messages of ours the agent had not read back: one written
   * before the interrupt that its queue no longer holds was dropped on the way, and nothing will read
   * it. A message absorbed into the turn was read back before the receipt was written.
   */
  private settleQueue(chat: LiveChat, receipt: InterruptReceipt, asked: number): void {
    if (!receipt.stillQueued) return;
    const queued = new Set(receipt.stillQueued);
    const dropped = chat.written().filter((m) => m.order <= asked && !queued.has(m.id));
    for (const message of dropped) {
      chat.pending.delete(message.id);
      chat.lose(message, NOT_READ, 'not-read');
    }
    if (dropped.length === 0) return;
    this.persist(chat);
    // They were all that kept a chat busy between turns: it waits for the person now
    if (!chat.turnOpen && chat.written().length === 0 && chat.status === 'busy' && chat.opts.keepAlive !== false) {
      if (chat.settleTimer) clearTimeout(chat.settleTimer);
      chat.settleTimer = null;
      goIdle(chat);
    }
  }

  /**
   * Sends one call the running turn waits on (a foreground agent or command) to the background: the
   * call returns at once, the agent reads what waits at that tool boundary, and the work goes on
   * where it was ("Send to background and deliver", D4). Refused with `not-running` when the call is
   * no foreground call of the lead's turn, or the agent no longer has it.
   */
  async backgroundCall(id: string, toolUseId: string): Promise<ChatRuntime> {
    const chat = this.chats.get(id);
    if (!chat) throw new ChatNotFoundError();
    const session = chat.session;
    if (!chat.alive || !session || !chat.turnOpen || !chat.foreground.has(toolUseId)) {
      throw new DeliveryRefusal(`the call ${toolUseId} is not a foreground call the chat's turn is waiting on`, 'not-running');
    }
    if (!session.backgroundCall) throw new DeliveryRefusal("this chat's agent cannot send a call to the background", 'unsupported');
    if (!(await session.backgroundCall(toolUseId))) {
      throw new DeliveryRefusal(`the agent has no foreground call ${toolUseId} to send to the background: it may have returned already`, 'not-running');
    }
    return chat.summary();
  }

  /**
   * Withdraws a message the agent has not read yet: one held for a replacement process, or still
   * waiting for its guard, is dropped here; one in the agent's queue is taken back from it
   * (`cancel_async_message`), which the agent refuses once it has taken it (409 `taken`). The page
   * hears `undelivered` with `reason: 'cancelled'`.
   */
  async cancelMessage(id: string, messageId: string): Promise<ChatRuntime> {
    const chat = this.chats.get(id);
    if (!chat) throw new ChatNotFoundError();
    const message = chat.pending.get(messageId);
    if (!message) {
      if (chat.receipts.has(messageId)) throw new DeliveryRefusal('the agent has already taken this message', 'taken');
      throw new ChatRefusal('no message with this id waits in this chat', 404);
    }
    // Not written to any agent yet: it is Claudio's own to drop
    if (message.state === 'held' || chat.armingQueue.some((queued) => queued.message.id === messageId)) {
      chat.withdraw(message);
      this.persist(chat);
      return chat.summary();
    }
    const session = chat.session;
    if (!session?.cancelMessage) throw new DeliveryRefusal("this chat's agent cannot take a message back", 'unsupported');
    if (!(await session.cancelMessage(messageId))) throw new DeliveryRefusal('the agent has already taken this message', 'taken');
    const still = chat.pending.get(messageId);
    if (still) chat.withdraw(still);
    this.persist(chat);
    return chat.summary();
  }

  /**
   * Changes the permission mode or the model. A live process switches at once; one that has
   * exited gets them when the next message resumes it.
   */
  /**
   * Where the chat's permission prompts go from now on, its live process included: the CLI's
   * requests are routed when they arrive (`askPermission` reads the option then), so a turn sent by
   * a caller nobody watches can be made to deny them instead of waiting for a person.
   */
  setPermissionPrompts(id: string, prompts: 'host' | 'none'): ChatRuntime {
    const chat = this.chats.get(id);
    if (!chat) throw new ChatNotFoundError();
    if (chat.opts.permissionPrompts !== prompts) {
      chat.opts.permissionPrompts = prompts;
      this.persist(chat);
    }
    return chat.summary();
  }

  /**
   * Hands the chat's permission requests to a program instead of a person (`LiveChat.permissionHost`),
   * or back with null. Read when each request arrives, so it applies to the live process too.
   */
  setPermissionHost(id: string, permissionHost: PermissionHost | null): void {
    const chat = this.chats.get(id);
    if (!chat) throw new ChatNotFoundError();
    chat.permissionHost = permissionHost;
  }

  async updateSettings(id: string, update: ChatSettingsUpdate): Promise<ChatRuntime> {
    const chat = this.chats.get(id);
    if (!chat) throw new ChatNotFoundError();
    if (chat.opts.apiPolicy) throw new ChatRefusal('a confined API chat keeps the settings it was created with', 409);
    const { permissionMode, model } = update;
    if (permissionMode !== undefined) {
      // A process on its way out reads nothing more: its replacement starts with the setting
      if (chat.alive && !this.leaving(chat)) await chat.session?.setOption({ permissionMode });
      chat.setSettings({ permissionMode });
    }
    if (model !== undefined) {
      const next = model.trim();
      if (!next) throw new Error('model must not be empty');
      if (chat.alive && !this.leaving(chat)) await chat.session?.setOption({ model: next });
      chat.opts.model = next;
      chat.setSettings({ model: next });
    }
    this.persist(chat);
    return chat.summary();
  }

  /**
   * What a chat's last execution was started with that is not in its tools or request: a housekeeping
   * resume carries it so a confined chat stays confined. The schema is left out on purpose, a
   * compaction is not held to a structured result.
   */
  executionExtrasOf(id: string): ExecutionExtras {
    const opts = this.chats.get(id)?.opts;
    if (!opts) return {};
    return {
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.agentsFile ? { agentsFile: opts.agentsFile } : {}),
      ...(opts.systemPromptSnapshot ? { systemPromptSnapshot: opts.systemPromptSnapshot } : {}),
      ...(opts.uploads === false ? { uploads: false as const } : {}),
      ...(opts.lessons ? { lessons: opts.lessons } : {}),
      ...(opts.confine ? { confine: opts.confine } : {}),
      // A compaction spends for what the chat is for, not as a person's turn
      ...(opts.purpose ? { purpose: opts.purpose } : {}),
    };
  }

  /**
   * The live process's own account of what fills its context window, raw. Null when Claudio has no
   * process on the chat or its driver cannot say; a CLI that refuses or does not answer rejects.
   */
  async contextUsage(id: string, detail?: ContextDetail): Promise<Record<string, unknown> | null> {
    const chat = this.chats.get(id);
    const session = chat?.alive ? chat.session : null;
    if (!session?.contextUsage) return null;
    return session.contextUsage(detail);
  }

  /** The MCP servers of the chat's live process, as it reports them now, and Claudio's own server for it. */
  /** `ask: false` answers without a control request, as a chat with no live process does: the caller judged the CLI too busy to answer now. */
  async mcpServers(id: string, opts: { ask?: boolean } = {}): Promise<ChatMcpServers> {
    const chat = this.chats.get(id);
    const session = chat?.alive && opts.ask !== false ? chat.session : null;
    if (!session?.mcpStatus) return { live: false, servers: [], ...(chat ? { claudio: this.claudioState(chat, []) } : {}) };
    const servers = await session.mcpStatus();
    return { live: true, servers, ...(chat ? { claudio: this.claudioState(chat, servers) } : {}) };
  }

  private claudioState(chat: LiveChat, servers: readonly LiveMcpServer[]): ChatClaudioMcp {
    return { on: chat.tools?.claudioMcp === true, unavailable: this.claudioUnavailable(chat, servers), error: this.claudioRefusals.get(chat.id) ?? null };
  }

  /**
   * Why Claudio's own server cannot be switched on in this chat, or null. A `claudio` the process
   * lists from the person's own settings, or one of the servers the chat chose by that name, is
   * theirs: it is reported, never replaced. Ours is the one with the scope `dynamic`.
   */
  private claudioUnavailable(chat: LiveChat, servers: readonly LiveMcpServer[]): ClaudioMcpUnavailable | null {
    if (chat.opts.claudioAssistant) return 'assistant';
    if (chat.provider !== LEGACY_PROVIDER || chat.opts.confine || chat.opts.internal || chat.origin === 'internal') return 'provider';
    if (servers.some((s) => s.name === CLAUDIO_MCP_SERVER && s.scope !== 'dynamic') || chat.opts.mcp?.servers.includes(CLAUDIO_MCP_SERVER)) return 'clash';
    return this.claudioEntryOrNull(chat, { chatId: chat.id, token: null }) ? null : 'no-api';
  }

  private claudioEntry(chat: LiveChat, claudio: boolean, identity: ClaudioMcpIdentity): Record<string, unknown> | null {
    if (!this.claudioServer) throw new Error("Claudio's MCP server is not available here");
    return this.claudioServer({ dir: chat.workingDir ?? chat.cwd, permissionMode: chat.permissionMode, claudio, ...identity });
  }

  /** The server with all of Claudio's tools, or null when it cannot be built here */
  private claudioEntryOrNull(chat: LiveChat, identity: ClaudioMcpIdentity): Record<string, unknown> | null {
    try {
      return this.claudioEntry(chat, true, identity);
    } catch {
      return null;
    }
  }

  /**
   * Switches Claudio's own MCP server on or off in a live chat with the CLI's `mcp_set_servers`, and
   * stores the choice on the chat, so every later process starts with it in its `--mcp-config`.
   * Answers with the servers as they are after it; a server the CLI refused is in `claudio.error`.
   */
  async setClaudioMcp(id: string, enabled: boolean): Promise<ChatMcpServers> {
    const chat = this.chats.get(id);
    if (!chat) throw new ChatNotFoundError();
    if (chat.opts.apiPolicy) throw new ChatRefusal('a confined API chat has no way back into Claudio', 409);
    const proc = chat.alive ? chat.proc : null;
    const session = proc ? chat.session : null;
    if (!proc || !session?.mcpSetServers || !session.mcpStatus) throw new ChatRefusal("This chat has no live process: choose Claudio's server when you resume it.");
    const servers = await session.mcpStatus();
    const unavailable = this.claudioUnavailable(chat, servers);
    if (unavailable === 'assistant') throw new ChatRefusal("The Claudio assistant already has Claudio's server.");
    if (unavailable === 'provider') throw new ChatRefusal("Claudio's server is offered to Claude Code chats only.");
    if (unavailable === 'clash') throw new ChatRefusal("There is already a server named claudio: rename it to switch on Claudio's own.", 409);
    const identity = { chatId: chat.id, token: this.procTokens.get(proc) ?? null };
    let entry: Record<string, unknown> | null;
    try {
      // Off keeps the reads of teammates' copies the chat's scope gives it, as its next process would have
      entry = this.claudioEntry(chat, enabled, identity);
    } catch (err) {
      if (enabled) throw new ChatRefusal(err instanceof Error ? err.message : String(err), 503);
      entry = null;
    }
    // The CLI leaves a server of `--mcp-config` alone until a set names it: replaced by a pushed one
    // first, the set after it removes it (checked against CLI 2.1.302)
    if (!entry && !this.claudioPushed.has(proc) && servers.some((s) => s.name === CLAUDIO_MCP_SERVER && s.scope === 'dynamic')) {
      const stand = this.claudioEntryOrNull(chat, identity);
      if (stand) await session.mcpSetServers({ [CLAUDIO_MCP_SERVER]: stand });
    }
    const result = await session.mcpSetServers(entry ? { [CLAUDIO_MCP_SERVER]: entry } : {});
    this.claudioPushed.add(proc);
    const refused = result.errors[CLAUDIO_MCP_SERVER];
    if (refused) this.claudioRefusals.set(chat.id, refused);
    else {
      this.claudioRefusals.delete(chat.id);
      this.storeClaudioMcp(chat, enabled);
      await this.allowClaudioReads(chat, session, enabled);
    }
    return this.mcpServers(id);
  }

  /**
   * The reads of Claudio's server, allowed ahead of time in the live process as `--allowedTools`
   * allows them in its next ones: without them a read is denied in a chat whose prompts go nowhere or
   * under `dontAsk`. The process is given the rules in its flag layer (the CLI's
   * `apply_flag_settings`); switched off, the rules go with the server. A CLI that refuses the request
   * keeps the server, whose reads then ask as the chat's mode says, and the chat says so.
   */
  private async allowClaudioReads(chat: LiveChat, session: NonNullable<LiveChat['session']>, enabled: boolean): Promise<void> {
    if (!session.applyFlagSettings) return;
    try {
      await session.applyFlagSettings({ permissions: { allow: enabled ? [...CLAUDIO_MCP_READ_TOOLS] : [] } });
    } catch (err) {
      if (!enabled) return;
      const why = err instanceof Error ? err.message : String(err);
      chat.push({ kind: 'notice', text: `Claudio's reads could not be allowed ahead of time in this process (${why}): they ask as the chat's mode says until its next process.` });
    }
  }

  /** The choice goes on the chat's tool record, which is what a resume, a fork and a respawn start from. */
  private storeClaudioMcp(chat: LiveChat, enabled: boolean): void {
    const { claudioMcp: _was, ...rest } = chat.tools ?? { preset: null, allowedTools: [], disallowedTools: [], mcp: chat.opts.mcp ?? null };
    chat.opts.toolConfig = enabled ? { ...rest, claudioMcp: true } : rest;
    this.persist(chat);
  }

  /**
   * Switches one MCP server of the live process on or off, and answers with the servers as they are
   * after it. The CLI keeps the choice for the chat's folder, so later chats there start with it too.
   */
  async toggleMcpServer(id: string, name: string, enabled: boolean): Promise<ChatMcpServers> {
    const chat = this.chats.get(id);
    if (!chat) throw new ChatNotFoundError();
    if (chat.opts.apiPolicy) throw new ChatRefusal('a confined API chat loads no MCP server', 409);
    const session = chat.alive ? chat.session : null;
    if (!session?.mcpToggle) throw new ChatRefusal('This chat has no live process: choose its servers when you resume it.');
    await session.mcpToggle(name, enabled);
    return this.mcpServers(id);
  }

  /**
   * Forgets a chat whose first process never started: it is not a chat of Claudio's yet. A spawn that
   * threw has ended its execution and written it (`spawnProcess`), and that row goes too, or the
   * failed start would come back as a chat at the next restart.
   */
  private discardUnstarted(id: string): void {
    this.chats.delete(id);
    this.dirty.delete(id);
    if (!this.saved.delete(id)) return;
    try {
      this.db.deleteChat(id);
    } catch {
      // the store closed: there is no restart to come back in
    }
  }

  remove(id: string): boolean {
    const chat = this.chats.get(id);
    if (!chat || chat.alive) return false;
    this.chats.delete(id);
    this.publisher.forget(id);
    this.bus?.emit({ type: 'run.removed', title: `${chat.name} removed`, runId: id });
    this.db.deleteChat(id);
    this.saved.delete(id);
    this.dirty.delete(id);
    removeChatExtrasConfigs(this.config.dataDir, (chatId) => chatId === id);
    return true;
  }

  /**
   * Stops every live chat, then resolves once their processes and everything they started are gone:
   * at once for what leaves on SIGTERM, and after `graceMs` for the rest, which then gets SIGKILL.
   * `stop` arms that escalation on an unref'd timer, which a server that exits right after never
   * reached: a child ignoring SIGTERM outlived the server. The stops themselves happen before this
   * returns, so a caller that does not wait still has every chat told to stop.
   */
  async stopAll(graceMs = STOP_GRACE_MS): Promise<void> {
    // Read before the stops, while each tree still hangs from its CLI: a child whose parent has
    // exited is adopted by init and could no longer be told from a stranger's
    const table = processTable();
    const trees: ProcessEntry[] = [];
    const closing: Array<Promise<unknown>> = [];
    for (const chat of [...this.chats.values()]) {
      if (!chat.alive) continue;
      const proc = chat.proc;
      const root = proc ? table.find((p) => p.pid === proc.pid) : undefined;
      if (root) trees.push(...descendantsOf(table, root.pid), root);
      if (proc && proc.exitCode === null && proc.signalCode === null) closing.push(once(proc, 'close').catch(() => undefined));
      this.stop(chat.id);
    }
    // The processes take a moment to exit; their credentials go now, with the wrapper
    this.chatTokens.revokeAll();
    if (trees.length === 0 && closing.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(closing), new Promise<void>((resolve) => (timer = setTimeout(resolve, graceMs)))]);
    clearTimeout(timer);
    // Only what is still the same process (pid and start time): a pid reused since is somebody else's
    const now = processTable();
    for (const victim of trees) {
      if (!now.some((p) => p.pid === victim.pid && p.started === victim.started)) continue;
      try {
        process.kill(victim.pid, 'SIGKILL');
      } catch {
        // gone in between
      }
    }
  }

  /** Resolves with the first `result` after the call, or when the process exits. */
  /** The result of a chat that is already over, or null while it can still produce one. */
  private static settled(chat: LiveChat): RunResult | null {
    if (chat.lastResult) return chat.lastResult;
    if (!['completed', 'failed', 'stopped'].includes(chat.status)) return null;
    return ChatManager.ended(chat, chat.status);
  }

  /** What a chat whose process ended without a result stands for. */
  private static ended(chat: LiveChat, status: string): RunResult {
    return {
      isError: true,
      result: chat.error ?? `The process ended (${status}) without a result`,
      structuredOutput: undefined,
      costUsd: chat.costUsd,
      ...(chat.stopRequested ? { cause: 'stopped' as const } : chat.rateLimited ? { cause: 'rate-limit' as const } : {}),
    };
  }

  /** Resolves once the chat has no process and has read its output to the end: at once when it has none, or when the one it has closes. */
  async exited(id: string): Promise<void> {
    const chat = this.chats.get(id);
    if (chat?.alive && chat.proc) await once(chat.proc, 'close');
  }

  /**
   * Resolves with the next result the chat produces, ignoring one it already has: what a turn sent
   * to a chat that has answered before needs, where {@link waitForResult} would return the old one.
   * Call it before sending the turn, so nothing is missed in between. `signal` lets a caller that
   * stopped waiting (a race it lost) take its listener off the chat at once rather than leave it
   * until a result comes, which may be never: the promise then rejects with the signal's reason.
   */
  nextResult(id: string, signal?: AbortSignal): Promise<RunResult> {
    const chat = this.chats.get(id);
    if (!chat) return Promise.reject(new ChatNotFoundError());
    if (signal?.aborted) return Promise.reject(signal.reason);
    const before = chat.lastResult;
    return new Promise((resolvePromise, rejectPromise) => {
      const onEvent = (event: RunEvent) => {
        if (event.kind === 'result' && chat.lastResult && chat.lastResult !== before) finish(chat.lastResult);
        // A process stopped for a limit replay (`carrying`) is replaced at once: its end is not the
        // chat's, and the replayed turn's result is the next one (the flake of 2026-10: a worker whose
        // limited process was still exiting ended its task with the replay's stop)
        else if (event.kind === 'status' && ['completed', 'failed', 'stopped'].includes(event.status ?? '') && !chat.respawnQueued && !chat.carrying) {
          finish(
            chat.lastResult && chat.lastResult !== before ? chat.lastResult : ChatManager.ended(chat, event.status ?? 'ended'),
          );
        }
      };
      const onAbort = (): void => {
        chat.emitter.off('event', onEvent);
        rejectPromise(signal?.reason);
      };
      const finish = (result: RunResult) => {
        chat.emitter.off('event', onEvent);
        signal?.removeEventListener('abort', onAbort);
        resolvePromise(result);
      };
      chat.emitter.on('event', onEvent);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  waitForResult(id: string): Promise<RunResult> {
    const chat = this.chats.get(id);
    if (!chat) return Promise.reject(new ChatNotFoundError());
    // A chat that has already ended emits nothing further, so subscribing alone would wait for an
    // event that never comes. Anything awaiting it — the planner holds an HTTP request open —
    // would hang until the process dies.
    const ended = ChatManager.settled(chat);
    if (ended) return Promise.resolve(ended);
    return new Promise((resolvePromise) => {
      const onEvent = (event: RunEvent) => {
        if (event.kind === 'result' && chat.lastResult) finish(chat.lastResult);
        else if (event.kind === 'status' && ['completed', 'failed', 'stopped'].includes(event.status ?? '')) {
          finish(chat.lastResult ?? ChatManager.ended(chat, event.status ?? 'ended'));
        }
      };
      const finish = (result: RunResult) => {
        chat.emitter.off('event', onEvent);
        resolvePromise(result);
      };
      chat.emitter.on('event', onEvent);
    });
  }

  /**
   * A Claudio assistant chat gets its tools, mode, prompt and confinement set again before every
   * process, over what the request or an earlier execution put in its options: nothing a request can
   * say widens it, and a restart, a resume or a fork cannot lose it.
   */
  private confineAssistant(chat: LiveChat): void {
    const marker = chat.opts.claudioAssistant;
    if (!marker) return;
    if (!this.assistantLaunch) throw new ChatRefusal('the Claudio assistant is not available here');
    if (chat.provider !== LEGACY_PROVIDER) throw new ChatRefusal('the Claudio assistant runs on Claude Code only');
    const { opts } = chat;
    const launch = this.assistantLaunch(marker);
    for (const key of ['agent', 'agentsFile', 'toolPreset', 'worktree', 'jsonSchema', 'maxBudgetUsd', 'systemPromptSnapshot', 'internal', 'api'] as const) delete opts[key];
    Object.assign(opts, launch);
    chat.setSettings({ permissionMode: launch.permissionMode });
  }

  /**
   * Confines a process of a confined API chat (docs/plans/headless-image.md, D14) from its stored
   * policy alone, over whatever a request or an earlier execution put in its options: only the
   * declared tools, no settings file, no MCP server but the ones core adds (the `/v1` client-tool
   * stub), `dontAsk`, no way back into Claudio, and never without its `declared-tools` guard.
   */
  private confineApiChat(chat: LiveChat): void {
    const policy = chat.opts.apiPolicy;
    if (!policy) return;
    const { opts } = chat;
    // A restart loses the guard's files and the schema: whoever continues the chat arms them again
    if (!opts.guards) throw new ChatRefusal('a confined API chat runs only under its declared-tools guard: continue it through its resume', 409);
    if (policy.schema && opts.jsonSchema === undefined) throw new ChatRefusal('this chat answers a JSON schema: continue it with the schema it was created with', 409);
    for (const key of ['agent', 'agentsFile', 'worktree', 'mcp', 'toolPreset', 'claudioAssistant', 'internal'] as const) delete opts[key];
    if (!policy.schema) delete opts.jsonSchema;
    if (opts.toolConfig) opts.toolConfig = { ...opts.toolConfig, mcp: null, claudioMcp: false };
    opts.api = false;
    opts.uploads = false;
    // The `/v1` client-tool stub is the one server such a chat may load; nothing else core adds stays
    const stub = opts.extraMcpServers?.[CLIENT_TOOLS_SERVER];
    if (stub) opts.extraMcpServers = { [CLIENT_TOOLS_SERVER]: stub };
    else delete opts.extraMcpServers;
    // A client's tool calls are held at the CLI's permission request (`ClientToolSession`), which
    // `dontAsk` never makes. With the stub, the CLI's default mode asks the session, which denies
    // every request but a client call: what is not declared is still refused without a person
    opts.permissionPrompts = stub ? 'host' : 'none';
    opts.allowedTools = [...policy.allowedTools];
    opts.maxBudgetUsd = policy.maxBudgetUsd;
    if (policy.maxTurns === null) delete opts.maxTurns;
    else opts.maxTurns = policy.maxTurns;
    opts.confine = confinementOf(policy, opts.apiAttachments ?? []);
    chat.setSettings({ permissionMode: stub ? CLIENT_TOOLS_PERMISSION_MODE : CONFINED_PERMISSION_MODE });
  }

  /**
   * The chat's own `appendSystemPrompt` and, per spawn, the Lessons section after it. The section is
   * read now so a lesson approved since the last process reaches this one, and it is never written
   * to `chat.opts`, which is what a resume or a fork carries on. Housekeeping, confined and assistant
   * chats get none, and neither does a run whose handoff already holds it.
   */
  private appendedPrompt(chat: LiveChat): { appendSystemPrompt?: string } {
    const { opts } = chat;
    const own = opts.appendSystemPrompt ?? '';
    const skip = opts.internal || opts.confine || opts.claudioAssistant || opts.lessons === 'handoff' || chat.origin === 'internal';
    const projectId = skip ? null : (this.projectOf?.(chat.workingDir ?? chat.cwd) ?? null);
    const section = skip ? '' : (this.lessonsFor?.(projectId, chat.origin === 'orchestration') ?? '');
    if (!section) return own ? { appendSystemPrompt: own } : {};
    const joined = own ? `${own}\n\n${section}` : section;
    // One argument of `claude`: past this the person's text is kept whole and the section is dropped
    if (Buffer.byteLength(joined) > LESSONS_ARG_MAX_BYTES) {
      chat.push({ kind: 'notice', text: 'The lessons were left out of this process: the instructions already appended to this chat leave no room for them.' });
      return own ? { appendSystemPrompt: own } : {};
    }
    return { appendSystemPrompt: joined };
  }

  /**
   * Claudio's own server for this process, or null: the reads of teammates' copies when the scope
   * says so, and all of its tools when the person switched it on for the chat. The assistant has its
   * own launch, and housekeeping and confined chats get none.
   */
  private agentReads(chat: LiveChat): CollabMcpLaunch | null {
    const { opts } = chat;
    if (!this.agentReadsLaunch || opts.claudioAssistant || opts.confine || opts.internal || chat.origin === 'internal' || chat.provider !== LEGACY_PROVIDER) return null;
    const claudioMcp = opts.toolConfig?.claudioMcp === true;
    try {
      return this.agentReadsLaunch({ dir: chat.workingDir ?? chat.cwd, permissionMode: chat.permissionMode, mcpConfig: opts.mcp?.config ?? null, claudioMcp });
    } catch (err) {
      // The chat runs without them rather than not at all
      const why = err instanceof Error ? err.message : String(err);
      chat.push({ kind: 'notice', text: claudioMcp ? `This process starts without Claudio's MCP server: ${why}` : `This process cannot read what teammates share: ${why}` });
      return null;
    }
  }

  /**
   * The `--mcp-config` of a process: the servers the chat chose (or Claudio's reads joined to them),
   * plus the servers core's callers add (`extraMcpServers`) in one file, since the CLI is given one.
   * Added servers keep the chat's choice as it was: a chat that chose none still loads the servers
   * the CLI finds on its own, so the file only adds to them.
   */
  private mcpLaunch(chat: LiveChat, reads: CollabMcpLaunch | null): Pick<SessionLaunch, 'mcpConfig' | 'mcpConfigAdds' | 'strictMcpConfig'> {
    if (chat.opts.apiPolicy) {
      // Only what core adds, and nothing the CLI would find on its own: a repository's `.mcp.json` included
      const added = chat.opts.extraMcpServers;
      return added && Object.keys(added).length ? { mcpConfig: writeChatExtrasConfigSync(this.config.dataDir, chat.id, added) } : { strictMcpConfig: true };
    }
    const base = reads ? reads.mcpConfig : (chat.opts.mcp?.config ?? null);
    const adds = reads ? reads.adds : base === null;
    const extra = chat.opts.extraMcpServers;
    if (!extra || Object.keys(extra).length === 0) return base ? { mcpConfig: base, ...(adds ? { mcpConfigAdds: true } : {}) } : {};
    const servers = base ? this.baseServers(chat, base, reads !== null) : {};
    return { mcpConfig: writeChatExtrasConfigSync(this.config.dataDir, chat.id, { ...servers, ...extra }), ...(adds ? { mcpConfigAdds: true } : {}) };
  }

  /**
   * The servers of the chat's config file, to join the added ones to. A file that is gone or not a
   * config (edited by hand, a disk cleaned up) is no reason to refuse the spawn: the process starts
   * with the added servers only, and the chat says why. `claudios` is Claudio's own file (its server
   * joined to the chat's choice, `agentReadsLaunch`), which nobody picked and nobody can pick again.
   */
  private baseServers(chat: LiveChat, base: string, claudios: boolean): Record<string, Record<string, unknown>> {
    let text: string;
    try {
      text = readFileSync(base, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return this.baseUnread(chat, base, claudios, code === 'ENOENT' ? 'the file is gone' : `it cannot be read: ${code ?? (err instanceof Error ? err.message : String(err))}`);
    }
    let listed: unknown;
    try {
      listed = (JSON.parse(text) as { mcpServers?: unknown } | null)?.mcpServers;
    } catch {
      return this.baseUnread(chat, base, claudios, 'it is not valid JSON');
    }
    if (listed && typeof listed === 'object' && !Array.isArray(listed)) return { ...(listed as Record<string, Record<string, unknown>>) };
    return this.baseUnread(chat, base, claudios, 'it lists no `mcpServers`');
  }

  /**
   * Says once per chat and problem that its servers are missing: an API chat respawns its process
   * on many turns, and the same notice on each would bury the conversation.
   */
  private baseUnread(chat: LiveChat, base: string, claudios: boolean, why: string): Record<string, Record<string, unknown>> {
    const key = `${base}\n${why}`;
    const told = this.mcpConfigNoticed.get(chat) ?? new Set<string>();
    this.mcpConfigNoticed.set(chat, told);
    if (told.has(key)) return {};
    told.add(key);
    const chose = chat.opts.mcp?.config != null;
    const text = claudios
      ? `Claudio's MCP config for this chat could not be read (${why}): this process starts without Claudio's server${chose ? ' and the servers the chat chose' : ''}. The next process writes it again.`
      : `The chat's MCP server config could not be read (${why}): this process starts without the servers it chose. Pick them again to restore them.`;
    chat.push({ kind: 'notice', text, data: { mcpConfig: base } });
    return {};
  }

  /** What a process of the chat is started from: the driver turns it into a command line. */
  private launchSpec(chat: LiveChat, account: AccountRef | null): SessionLaunch {
    const { opts } = chat;
    const reads = this.agentReads(chat);
    return {
      ...(account ? { account } : {}),
      id: chat.id,
      nativeId: chat.nativeId,
      created: chat.created,
      forkFrom: chat.forkFrom,
      name: chat.name,
      cwd: chat.cwd,
      permissionMode: chat.permissionMode,
      ...(opts.model ? { model: opts.model } : {}),
      ...(chat.effort ? { effort: chat.effort } : {}),
      ...this.appendedPrompt(chat),
      ...(opts.allowedTools || reads ? { allowedTools: [...(opts.allowedTools ?? []), ...(reads?.allowedTools ?? [])] } : {}),
      ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
      ...this.mcpLaunch(chat, reads),
      ...(opts.confine ? { confine: opts.confine } : {}),
      // Attached files live outside every project: a session that may read them is told where they are
      ...(this.uploads && opts.uploads !== false ? { uploadsDir: this.uploads.dir } : {}),
      ...(opts.worktree ? { worktree: opts.worktree } : {}),
      ...(typeof opts.maxBudgetUsd === 'number' ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.fallbackModel ? { fallbackModel: opts.fallbackModel } : {}),
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
      ...(opts.maxThinkingTokens ? { maxThinkingTokens: opts.maxThinkingTokens } : {}),
      ...(opts.thinkingDisplay ? { thinkingDisplay: opts.thinkingDisplay } : {}),
      ...(opts.resumeSessionAt ? { resumeSessionAt: opts.resumeSessionAt } : {}),
      // Prompts go to a host only when something is listening: a chat waiting on an answer that never
      // comes is worse than one told plainly that it was denied
      permissionPrompts: opts.permissionPrompts === 'host' && this.permissions ? 'host' : 'none',
      ...(opts.jsonSchema !== undefined ? { jsonSchema: opts.jsonSchema } : {}),
      ...(opts.systemPromptSnapshot ? { systemPromptSnapshot: opts.systemPromptSnapshot } : {}),
      ...(opts.internal ? { internal: true } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.agentsFile ? { agentsFile: opts.agentsFile } : {}),
      ...(opts.guards ? { guard: { settingsPath: opts.guards.settingsPath } } : {}),
      policy: opts.toolConfig?.policy ?? null,
    };
  }

  /**
   * The account the chat's next process runs on, chosen at every launch: the one the rotation moved
   * the chat to, else what `choose` makes of the accounts and their readings (a pinned chat keeps
   * its account while it can run). When nobody can take the work the chat stays where it is and the
   * limit path waits. Announced when it differs from the last process's.
   */
  private chooseAccount(chat: LiveChat): AccountRef | null {
    const store = this.accounts;
    if (!store) return null;
    // A switch still waiting for the turn to end applies now: no process is left to wait for
    if (chat.pendingAccount) this.moveTo(chat, chat.pendingAccount, 'person');
    const moved = chat.forcedAccount;
    const movedFor = chat.forcedReason;
    chat.forcedAccount = null;
    chat.forcedReason = 'limit';
    const at = Date.now();
    let to: string;
    let reason: AccountSwitchReason | null = null;
    if (moved) {
      to = moved;
      reason = movedFor;
    } else {
      const projectId = this.projectOf?.(chat.workingDir ?? chat.cwd) ?? null;
      const choice = store.pick({ current: chat.account, pinned: chat.opts.account ?? null, policy: store.policyFor(projectId), now: at, model: askedModel(chat) });
      to = choice.account ?? chat.account ?? DEFAULT_ID;
      reason = choice.reason;
    }
    let ref: AccountRef;
    try {
      ref = store.ref(to);
    } catch {
      // The account was removed since the chat last ran: the CLI's own login is always there
      ref = store.ref(DEFAULT_ID);
    }
    const from = chat.account;
    if (from && from !== ref.id) {
      this.bus?.emit({ type: 'account.switched', title: `New work moves from ${from} to ${ref.id}`, from, to: ref.id, reason: reason ?? 'threshold' });
    }
    return ref;
  }

  /**
   * What the chat's account reports, kept on that account and no other: a stream reading is stored
   * as it is, and every change of a window lands in `usage_history`. A turn that died on the limit
   * writes nothing into the account's reading, since the CLI said neither how much was used nor until
   * when; the chat only remembers the account, so that its next move does not go back to it. A
   * rejected event with no reset leaves the account out for `cooldownSeconds` on its reading.
   */
  private observeAccount(chat: LiveChat, event: DriverEvent): void {
    if (event.kind === 'rate-limit' && event.info.status === 'rejected' && event.info.resetsAt) this.refusedUntil.set(chat, new Date(event.info.resetsAt * 1000).toISOString());
    const store = this.accounts;
    const id = chat.account;
    if (!store || !id) return;
    if (event.kind !== 'rate-limit' || event.info.status === 'rejected') chat.limitedAccounts.add(id);
    if (event.kind !== 'rate-limit') return;
    const { info } = event;
    const reading = readingFromEvent(
      {
        status: info.status,
        rateLimitType: info.rateLimitType,
        resetsAt: info.resetsAt,
        utilization: info.utilization,
        unifiedWindows: info.windows,
        ...(info.isUsingOverage !== undefined ? { isUsingOverage: info.isUsingOverage } : {}),
        ...(info.overageStatus !== undefined ? { overageStatus: info.overageStatus } : {}),
      },
      Date.now(),
      { cooldownMs: store.settings().cooldownSeconds * 1000 },
    );
    if (!reading) return;
    void this.noteAccountReading(id, reading).catch(() => undefined);
  }

  /** Stores a reading and appends the windows that moved to `usage_history`; also what Core's idle-cache pass calls. */
  async noteAccountReading(id: string, reading: Reading): Promise<void> {
    const store = this.accounts;
    if (!store) return;
    if (!(await store.observe(id, reading))) return;
    // Removed since the reading was taken, or the credential-less default: nothing to draw a line for
    const limit = store.find(id)?.limits;
    if (!limit) return;
    const points: UsageHistoryPoint[] = [];
    for (const window of HISTORY_WINDOWS) {
      const w = limit.windows[window];
      if (!w) continue;
      const pct = Math.round(w.utilization * 1000) / 10;
      if (this.db.latestUsagePoint(id, window)?.pct === pct) continue;
      points.push({ account: id, window, at: limit.observedAt, pct });
    }
    this.db.appendUsagePoints(points);
  }

  /**
   * A turn died on the account's sign-in: the account is marked, so that no choice lands on it until
   * it signs in again. A turn that went through on a marked account clears the mark. The mark is
   * stored before the turn's end is announced, which is when the rotation chooses. A turn that
   * went through on an account never confirmed (an OAuth token from the environment has no free
   * check) confirms it: the CLI refuses an invalid token before generating anything.
   *
   * A turn that went through also ends the replay count: the next limit is a new one, with a replay
   * of its own. Before 2026-10-29 the count was reset only on a resume, so after one wait-replay a
   * chat never rotated again (regression audit §2.2).
   *
   * The account may be gone (a person removed it, the store's lookup is nullable): the turn's result
   * is folded all the same. On 2026-10-25 a throw here went up the stream handler and took the
   * server down.
   */
  private observeSignIn(chat: LiveChat, authFailed: boolean): void {
    if (!authFailed) {
      chat.limitReplays = 0;
      this.refusedUntil.delete(chat);
    }
    const store = this.accounts;
    const id = chat.account;
    if (!store || !id) return;
    const account = authFailed ? null : store.find(id);
    if (!authFailed && !account) return;
    const done = authFailed ? store.markAuthFailed(id) : account?.authFailedAt || account?.checkedAt === null ? store.confirm(id) : null;
    void done?.catch(() => undefined);
  }

  /** Whether the chat's last turn died on the account's sign-in rather than its limit. */
  signInFailed(id: string): boolean {
    return this.chats.get(id)?.authFailed === true;
  }

  /**
   * What `choose` makes of the accounts for a chat that just hit its limit: the account to move it
   * to, or when none is left the earliest reset. Null for a chat that runs on none. Every account
   * the turn already died on is passed over, so a chain of moves ends by itself.
   */
  chooseNext(id: string): Choice | null {
    const chat = this.chats.get(id);
    const store = this.accounts;
    if (!chat || !store || !chat.account) return null;
    const projectId = this.projectOf?.(chat.workingDir ?? chat.cwd) ?? null;
    const failedOn = new Set([...chat.limitedAccounts, ...limitedTail(chat.executions)]);
    return store.pick({ current: chat.account, pinned: chat.opts.account ?? null, policy: store.policyFor(projectId), model: askedModel(chat), failedOn: [...failedOn] });
  }

  /**
   * What `choose` makes of the accounts for a chat that waits at its limit. As `chooseNext`, except
   * that an account the turn died on is a candidate again once a reading taken after `since` (epoch
   * ms, when the wait began) says it is not out: a failure says the account was out then, and a
   * newer reading knows better (R10: the CLI's own login restarted its window early while twelve
   * tasks waited for another account's reset). With `since` null every failure is passed over, which
   * is a person asking to run now: only the readings decide. Null for a chat that runs on none.
   */
  roomFor(id: string, since: number | null): Choice | null {
    const chat = this.chats.get(id);
    const store = this.accounts;
    if (!chat || !store || !chat.account) return null;
    const projectId = this.projectOf?.(chat.workingDir ?? chat.cwd) ?? null;
    const newer = (account: string): boolean => {
      const limit = store.find(account)?.limits;
      return !!limit && limit.state !== 'exhausted' && Date.parse(limit.observedAt) > (since ?? 0);
    };
    const failedOn = since === null ? [] : [...new Set([...chat.limitedAccounts, ...limitedTail(chat.executions)])].filter((a) => !newer(a));
    // Overriding the failures, staying on the account the turn died on last is no reason of its own:
    // the order (or the most room) decides
    return store.pick({ current: since === null ? null : chat.account, pinned: chat.opts.account ?? null, policy: store.policyFor(projectId), model: askedModel(chat), failedOn });
  }

  /** The live chats whose process runs on an account: what removing that account waits for. */
  liveChatsOn(account: string): string[] {
    return [...this.chats.values()].filter((c) => c.alive && (c.account ?? DEFAULT_ID) === account).map((c) => c.id);
  }

  /** Reads the model lists the account choice needs and does not have yet (no turn, no tokens). */
  async warmModels(): Promise<void> {
    await this.accounts?.warmModels();
  }

  /** The id of the account the chat's last process ran on; null when it ran on none. */
  accountOf(id: string): string | null {
    return this.chats.get(id)?.account ?? null;
  }

  /** Whether a person's chat moves to another account at its limit (`rotateOnLimit`); false without accounts. */
  rotatesOnLimit(): boolean {
    return !!this.accounts && this.accounts.settings().rotateOnLimit;
  }

  /**
   * The only place a CLI process starts, and it becomes the chat's at once: every process is tracked
   * by the chat it works for, and a chat never has two.
   */
  /** `room`: the idle processes admission chose to end for this one, ended once nothing before the spawn refuses it. */
  private spawnProcess(chat: LiveChat, first: SentMessage, room: readonly LiveChat[], announce = true): void {
    if (chat.alive) throw new ChatRefusal('the chat already has a live process');
    const holders = this.sessionHolders(chat);
    if (holders.length) {
      throw new ChatRefusal(
        `session ${chat.id} is still running in process ${holders.join(', ')}, which this chat does not track; ` +
          'a second process would carry on the same conversation beside it. Wait for it to finish, or stop it first.',
      );
    }
    // D9: a start, a resume or a respawn whose folder is gone is refused; nothing creates it again
    if (!existsSync(chat.cwd)) throw cwdMissing(chat.cwd, chat.opts.apiPolicy?.workspaceId ?? null);
    this.confineAssistant(chat);
    this.confineApiChat(chat);
    this.planGuards(chat);
    const account = this.chooseAccount(chat);
    // The CLI's own login keeps the environment it always had (the vault's credential, the container's)
    const plan = chat.driver.launch(this.launchSpec(chat, account && account.id !== DEFAULT_ID ? account : null));
    if (account) chat.account = account.id;
    // The CLI's total is cumulative over its process, so a new process counts from zero again
    chat.lastReportedCostUsd = 0;
    chat.lastReportedModelUsage = [];
    chat.stopRequested = false;
    chat.endedAt = null;
    chat.error = null;
    chat.rateLimited = false;
    chat.authFailed = false;
    chat.limitRequested = false;
    chat.stopReason = null;
    // Whatever the last process left open went with it
    chat.heartbeats.clear();
    chat.openCommands.clear();
    chat.cancelled.clear();
    // Whether this process reports what it takes is its own to show
    chat.reportsDelivery = null;
    chat.carrying = false;
    // Its turns, its calls and its counts start again; a message the last one dropped cannot be read back by this one
    chat.turnOpen = false;
    chat.foreground.clear();
    chat.writes = 0;
    chat.results = 0;
    chat.notRead.clear();
    if (chat.settleTimer) clearTimeout(chat.settleTimer);
    chat.settleTimer = null;
    chat.beginExecution();
    // Each process arms on its own: the guard's hooks are read at its start, and a resume registers them again
    if (chat.armingTimer) clearTimeout(chat.armingTimer);
    chat.armingTimer = null;
    chat.armingQueue = [];
    chat.guardState = chat.opts.guards ? 'arming' : null;
    // Whatever the last process was doing went with it
    chat.activity.clear();
    chat.branchActivity.clear();
    chat.setStatus('starting');

    const env: NodeJS.ProcessEnv = { ...plan.env, CLAUDIO_CHAT_ID: chat.id };
    for (const name of plan.unsetEnv) delete env[name];
    // One inherited from the wrapper that started this one points at the wrong wrapper, and its
    // token is another wrapper's credential: neither is ever passed through
    delete env.CLAUDIO_API_TOKEN;
    let token: string | null = null;
    if (this.apiUrl && chat.opts.api !== false) {
      env.CLAUDIO_API_URL = this.apiUrl;
      // Minted whatever the mode: a guard switched on mid-turn still finds the turn holding a credential
      token = this.chatTokens.mint(chat.id);
      env.CLAUDIO_API_TOKEN = token;
    } else delete env.CLAUDIO_API_URL;
    // A confined API chat's git reads no configuration but the run's own (D14.7)
    if (chat.opts.apiPolicy) Object.assign(env, confinedGitEnv(chat.cwd, this.workspacesRoot));
    let proc: ChildProcessWithoutNullStreams;
    try {
      // A guarded run's temp files live in its own dir, the only place `rm -rf` outside the worktree is allowed
      const tmpDir = chat.opts.guards?.tmpDir;
      if (tmpDir) {
        mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
        env.TMPDIR = tmpDir;
      }
      proc = spawn(plan.bin, plan.args, { cwd: chat.cwd, env, stdio: 'pipe' });
    } catch (error) {
      if (token) this.chatTokens.revoke(token);
      // The execution has begun and the chat says it is starting: a spawn that throws at once (ENOMEM,
      // E2BIG, a temp dir that cannot be made) ends both as a process that failed would, or the chat
      // stays `starting` with an execution that never ends
      chat.error = error instanceof Error ? error.message : String(error);
      chat.procClosed = true;
      this.finalize(chat, 'failed');
      throw error;
    }
    // Only now that a process exists: a spawn that failed has ended nobody's. Nothing yields between
    // admission and here, so no other start could count the slots meanwhile
    this.evict(room);
    // Keyed by this process's own token, so an earlier process ending late never revokes the current one
    const revokeToken = () => {
      if (token) this.chatTokens.revoke(token);
    };
    if (token) this.chatTokens.attach(token, proc.pid);
    this.procTokens.set(proc, token);
    chat.proc = proc;
    chat.released = false;
    chat.slotReserved = false;
    chat.procClosed = false;
    chat.procStartedAt = now();
    // The chat's status follows the process it tracks and no other: an earlier process ending late
    // used to mark the chat failed while its current one was still working
    const current = () => chat.proc === proc;

    const session = chat.driver.attach(
      { write: (text) => proc.stdin.write(text), end: () => proc.stdin.end(), up: () => processUp(proc) },
      (event) => foldEvent(this.host, chat, event),
      chat.branches,
      chat.opts.guards ? { rulesSha256: chat.opts.guards.rulesSha256 } : undefined,
    );
    chat.session = session;
    if (chat.opts.guards) {
      chat.armingTimer = setTimeout(() => {
        if (current() && chat.guardState === 'arming') this.guardUnarmed(chat, `the guard did not start within ${Math.round(guardArmMs() / 1000)} s`);
      }, guardArmMs());
      chat.armingTimer.unref();
    }
    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!current()) return;
      // A line the fold cannot take is this chat's failure, never the server's: a throw out of this
      // handler is an uncaught exception, which took the whole server down on 2026-10-25
      try {
        session.readLine(line);
      } catch (err) {
        this.failProtocol(chat, `Claudio could not read a line of the agent's output: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.noteActivity(chat);
    });
    createInterface({ input: proc.stderr }).on('line', (line) => {
      if (!line.trim() || !current()) return;
      session.readError(line);
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => {
      revokeToken();
      if (!current()) return;
      chat.error = err.message;
      chat.procClosed = true;
      this.finalize(chat, 'failed');
    });
    // The token goes as soon as the process is gone; what the chat becomes waits for `close`, which
    // comes after stdout and stderr have been read to the end, so the last lines of stderr, the reason
    // an execution failed, are in the chat's events before they are read back. A child that inherited
    // the pipes would hold `close` off for as long as it lives, and the chat on its way out with it:
    // the pipes are let go a moment after the exit, which is what closes them
    let closed = false;
    let lingering: NodeJS.Timeout | null = null;
    proc.on('exit', () => {
      revokeToken();
      lingering = setTimeout(() => {
        if (closed) return;
        proc.stdout.destroy();
        proc.stderr.destroy();
        proc.stdin.destroy();
      }, closeAfterExitMs());
      lingering.unref();
    });
    proc.on('close', (code) => {
      closed = true;
      if (lingering) clearTimeout(lingering);
      revokeToken();
      if (!current()) return;
      chat.procClosed = true;
      if (chat.guardState === 'arming' && !chat.stopRequested) this.guardUnarmed(chat, 'the process ended before the guard started');
      else if (chat.stopRequested) this.finalize(chat, 'stopped');
      else if (code === 0) this.finalize(chat, 'completed');
      else {
        chat.error ??= chat.events.filter((e) => e.kind === 'stderr').slice(-3).map((e) => e.text).join('\n') || `exit code ${code}`;
        this.finalize(chat, 'failed');
      }
      this.drainQueue(chat);
    });

    // Recorded at once: a wrapper that dies from here on leaves an execution to read back as interrupted, not a gap
    this.persist(chat);
    this.writeUserMessage(chat, first, announce);
  }

  /**
   * Writes a message to the live process, under its id, and keeps it as pending until the agent
   * reports taking it. `announce`: stream it now; a held message was streamed when it arrived.
   */
  private writeUserMessage(chat: LiveChat, message: SentMessage, announce = true): void {
    const { text, attachments } = message;
    chat.lastUserTurn = { text, attachments: attachments.map((a) => a.id) };
    if (chat.turnOver) {
      chat.turnMessages = [];
      chat.turnOver = false;
    }
    chat.turnMessages.push(message);
    if (chat.idleTimer) clearTimeout(chat.idleTimer);
    chat.idleSince = null;
    // Before the write: a driver that starts the turn at once reports it taken from inside `send`
    if (chat.reportsDelivery !== false) chat.pending.set(message.id, { ...message, state: 'written', order: ++chat.writes, results: chat.results });
    // The agent must not read a word before its guard is live: the message goes out when `armed` arrives
    if (chat.guardState === 'arming') {
      chat.armingQueue.push({ message, announce });
      return;
    }
    this.deliver(chat, message, announce);
  }

  private deliver(chat: LiveChat, message: SentMessage, announce: boolean): void {
    const { text, attachments } = message;
    const uploads = this.uploads;
    const shown = chat.session?.send({ id: message.id, text, attachments, ...(uploads ? { read: (id: string) => uploads.read(id).bytes } : {}) }) ?? text;
    // Kept as rows: which uploads a chat has must be known for a chat not loaded since the start (a shared chat's copy)
    if (attachments.length) this.db.addChatUploads(chat.id, attachments.map((a) => a.id), new Date().toISOString());
    const entry = userEntry(message, shown);
    // A provider whose transcript Claudio keeps itself has no other record of what the person said
    recordEntry(this.host, chat, entry);
    if (announce) chat.push({ kind: 'message', entry });
    // It starts the lead's turn, or joins the one under way
    const pending = chat.pending.get(message.id);
    if (pending) pending.opens = !chat.turnOpen;
    chat.turnOpen = true;
    chat.setStatus('busy');
  }

  /** The guard is live: the messages that waited for it go out, in order */
  private guardArmed(chat: LiveChat): void {
    if (chat.guardState !== 'arming') return;
    chat.guardState = 'armed';
    if (chat.armingTimer) clearTimeout(chat.armingTimer);
    chat.armingTimer = null;
    const queue = chat.armingQueue;
    chat.armingQueue = [];
    for (const { message, announce } of queue) this.deliver(chat, message, announce);
  }

  /** The process never armed: nothing was written to it, so the run ends before it spends anything */
  private guardUnarmed(chat: LiveChat, why: string): void {
    // Said once: the exit that follows the kill finds the chat no longer arming
    chat.guardState = null;
    const guard: RunGuardEvent = { outcome: 'unarmed', toolUseId: null, toolName: '', rule: 'integrity', matcher: 'integrity.unarmed', reason: why, excerpt: '' };
    chat.push({ kind: 'guard', guard });
    this.emit('chat-guard', chat.id, guard);
    this.failProtocol(chat, `guard-unarmed: ${why}`);
  }

  /**
   * A tool call ran with no guard marker (D6). The turn is interrupted. A run that nobody watches
   * ends failed, `guard-missing`. A person's chat is stopped without an error and shows the tag: its
   * next message starts a process that must arm again, and nothing is sent on its own.
   */
  private guardMissing(chat: LiveChat): void {
    chat.guardState = 'missing';
    const why = 'a tool call ran without a guard marker, so the guards are not running';
    // The interrupt is asked for first and given a moment to be read: a process taken down in the same
    // breath may never see it. A CLI that does not answer is taken down all the same.
    const settled = chat.session ? chat.session.interrupt().catch(() => {}) : Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    const patience = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, GUARD_INTERRUPT_WAIT_MS);
    });
    void Promise.race([settled, patience]).then(() => {
      clearTimeout(timer);
      if (chat.endedAt) return;
      if (chat.opts.guards?.interactive) {
        chat.push({ kind: 'notice', text: `Guards not running: ${why}. The chat was stopped; send your next message again to continue.` });
        this.stop(chat.id);
      } else this.failProtocol(chat, `guard-missing: ${why}`);
    });
  }

  /** A fault in what the agent said about itself: the execution fails with the reason, and nothing carries on beside it. */
  private failProtocol(chat: LiveChat, message: string): void {
    chat.error = message;
    this.finalize(chat, 'failed');
    chat.proc?.kill('SIGTERM');
  }

  /** The run's scratch dir goes with it; only one under `<data>/tmp`, whatever a plan says */
  private removeGuardTmp(chat: LiveChat): void {
    const dir = chat.opts.guards?.tmpDir;
    if (!dir || !resolve(dir).startsWith(join(resolve(this.config.dataDir), 'tmp') + sep)) return;
    rmSync(dir, { recursive: true, force: true });
  }

  private finalize(chat: LiveChat, status: RunStatus): void {
    if (chat.endedAt) return;
    if (chat.idleTimer) clearTimeout(chat.idleTimer);
    if (chat.armingTimer) clearTimeout(chat.armingTimer);
    chat.armingTimer = null;
    if (chat.settleTimer) clearTimeout(chat.settleTimer);
    chat.settleTimer = null;
    chat.turnOpen = false;
    chat.foreground.clear();
    this.removeGuardTmp(chat);
    chat.idleSince = null;
    chat.endedAt = now();
    // A prompt still waiting belongs to a process that is gone: nobody can act on the answer.
    this.permissions?.denyAllFor(chat.id);
    chat.permissionHost?.ended();
    chat.session?.dispose('the chat ended before the CLI answered');
    chat.branches.endAll(chat.endedAt);
    const execution = chat.execution;
    if (execution) {
      Object.assign(execution, { endedAt: chat.endedAt, outcome: executionOutcome(status), error: chat.error, ...(chat.rateLimited ? { cause: chat.authFailed ? ('auth' as const) : ('rate-limit' as const) } : {}) });
    }
    // What the agent still had in its queue died with it; what waits for the next process does not
    for (const message of chat.written()) {
      chat.pending.delete(message.id);
      if (!chat.carrying) chat.lose(message, chat.stopRequested ? STOPPED : (chat.error ?? ENDED));
    }
    chat.activity.clear();
    chat.branchActivity.clear();
    chat.setStatus(status);
    this.noteActivity(chat);
    this.persist(chat);
    this.maybeLimit(chat);
    chat.purpose = null;
    this.emit('chat-context', chat.id, { kind: 'ended', stopped: chat.stopRequested, error: chat.error } satisfies ContextSignal);
  }

  /**
   * Announces that the chat's provider is at its limit, once per attempt. The turn can die against the limit while the
   * process stays alive (keepAlive) or by taking it down, so both paths end up here.
   */
  private maybeLimit(chat: LiveChat): void {
    if (!chat.rateLimited || chat.limitRequested || !chat.lastUserTurn) return;
    // A compaction lost to the limit fails as such and is never replayed, on this account or another
    if (chat.purpose) {
      chat.limitRequested = true;
      return;
    }
    // Announced whatever the replay count says: the rotation may move the turn to another account,
    // which the count never holds back; only a replay on no new account is bounded by it
    chat.limitRequested = true;
    this.emit('limit-hit', chat.summary(), this.limitResetOf(chat.id));
  }

  /** The reset each chat's last refused turn gave (ISO), until a turn goes through: that turn's own evidence */
  private readonly refusedUntil = new WeakMap<LiveChat, string>();

  /**
   * When the account the chat's turn died on comes back, as far as the chat knows: its reading's
   * reset while it reads out, else the reset the refusal itself gave, which may have passed already
   * (the wait then goes on at once). Null when neither said. Never another account's reset.
   */
  limitResetOf(id: string): string | null {
    const chat = this.chats.get(id);
    if (!chat) return null;
    const limit = this.limitOf(id);
    return limit?.state === 'exhausted' && limit.resetsAt ? limit.resetsAt : (this.refusedUntil.get(chat) ?? null);
  }

  /** A wrapper-generated line in the transcript (account rotations, retries). */
  notice(id: string, text: string, data?: Record<string, unknown>): void {
    this.chats.get(id)?.push({ kind: 'notice', text, ...(data ? { data } : {}) });
  }

  /**
   * The chat's turns are held to a structured result, which only a run Claudio started on its own
   * asks for (a flow run, the assistant): whoever started it heard its result already.
   */
  heldToSchema(id: string): boolean {
    const chat = this.chats.get(id);
    // An OpenAI client's `response_format` is a schema too, but its turn is a request still waiting
    // for its answer: at a limit it is handled as a person's chat, not as a run nobody waits for
    return !!chat && chat.opts.jsonSchema !== undefined && !chat.opts.apiClient;
  }

  /** The JSON schema the chat's process was started with (`--json-schema`), if any: fixed until it ends. */
  jsonSchemaOf(id: string): unknown {
    return this.chats.get(id)?.opts.jsonSchema;
  }

  /**
   * The model the chat's process was started with (`--model`), as it was asked for: the chat's
   * `model` setting follows what the transcript reports (`claude-sonnet-5-5` for `sonnet`).
   */
  modelOf(id: string): string | undefined {
    return this.chats.get(id)?.opts.model;
  }

  /**
   * The chat's own `appendSystemPrompt` (without the Lessons section a spawn adds), which its live
   * process was started with: like the schema, fixed until the process ends.
   */
  systemPromptOf(id: string): string | undefined {
    return this.chats.get(id)?.opts.appendSystemPrompt;
  }

  /**
   * Ends an idle chat's live process between turns, the way its idle timeout does, and resolves once
   * it is gone: for a caller whose next turn needs launch flags the process cannot change (a new
   * `--json-schema`), and resumes the chat with them. A chat that is working is refused.
   */
  async endBetweenTurns(id: string): Promise<void> {
    const chat = this.chats.get(id);
    if (!chat) throw new ChatNotFoundError();
    if (!chat.alive) return;
    if (chat.status !== 'idle' || chat.written().length > 0) throw new ChatRefusal('the chat is working on a turn; its process cannot be ended between turns now', 409);
    // Its CLI would kill that work once it had waited for it with its input closed (D3)
    if (runsInBackground(chat.branches)) throw new ChatRefusal('the chat runs work in the background, which ending its process now would stop; try again when it is done', 409);
    // Resolves on the process's `close`, after the handler registered at spawn has finalised the chat
    await this.endProcessBetweenTurns(chat);
  }

  /**
   * The chat's turn died against its provider's limit and `limit-hit` will be announced for it: what
   * a run held to a schema waits on rather than fail. True from the limit until the announcement.
   */
  limitComing(id: string): boolean {
    const chat = this.chats.get(id);
    return !!chat && chat.rateLimited && !chat.limitRequested && !!chat.lastUserTurn;
  }

  /**
   * A limit the chat's process met where its stream does not say so: a workflow's subagent, refused by
   * the API, ends in a transcript of its own (R15). It is recorded as the stream's rejected reading or
   * failed sign-in would be, on the account it ran on, and the chat is at its limit: a live
   * process is stopped, and its end announces `limit-hit` as a turn of its own that died would. False
   * when the chat already is at a limit. A replay spent without a turn going through since does not
   * stop it: the rotation passes over the accounts the turn died on, and waits when none is left.
   */
  limitReached(id: string, refusal: { resetsAt: string | null; rateLimitType: string | null; auth: boolean }): boolean {
    const chat = this.chats.get(id);
    if (!chat || chat.rateLimited || chat.limitRequested || !chat.lastUserTurn) return false;
    chat.rateLimited = true;
    if (refusal.auth) {
      chat.authFailed = true;
      this.observeSignIn(chat, true);
    } else {
      // The stream's reset is in epoch seconds
      const resetsAt = refusal.resetsAt ? Math.floor(Date.parse(refusal.resetsAt) / 1000) : NaN;
      const event: DriverEvent = {
        kind: 'rate-limit',
        info: { status: 'rejected', windows: {}, observedAt: now(), ...(refusal.rateLimitType ? { rateLimitType: refusal.rateLimitType } : {}), ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) },
      };
      try {
        this.observeAccount(chat, event);
      } catch {
        // A closed database (shutting down): the chat is at its limit all the same
      }
    }
    this.persist(chat);
    if (chat.alive) this.stop(id);
    else this.maybeLimit(chat);
    return true;
  }

  /** The chat's work went on past a limit it was replayed for: the next limit is a new one, with a replay of its own. */
  limitProgress(id: string): void {
    const chat = this.chats.get(id);
    if (chat) chat.limitReplays = 0;
  }

  /** The chat's last turn died on its provider's limit and nothing has started on it since. */
  atLimit(id: string): boolean {
    // Never wakes a retired chat: one at its limit is never retired, and every listed chat asks
    return this.chats.peek(id)?.rateLimited === true;
  }

  /**
   * The reading of the account the chat ran on, as its provider's limit; null for a chat Claudio does
   * not drive, one that runs on no account, or one whose account has none. Never another account's:
   * the provider-wide reading this used to be was whichever account ran last.
   */
  limitOf(id: string): ProviderLimit | null {
    const chat = this.chats.get(id);
    if (!chat?.account || !this.accounts) return null;
    return providerLimitOf(chat.provider, this.accounts.find(chat.account)?.limits ?? null);
  }

  /**
   * Switches the account of a chat on a person's request. An idle chat moves at once (a live process
   * is ended between turns, the next message resumes the session under the new account); a working
   * one keeps its turn and moves when the turn ends. Naming the current account cancels a pending
   * switch. The choice is not a pin: the rotation still moves the chat at a limit.
   */
  async switchAccount(id: string, accountId: string, actor: string): Promise<{ chat: ChatRuntime; pending: boolean }> {
    const chat = this.chats.get(id);
    const store = this.accounts;
    if (!chat) throw new AccountSwitchRefusal('chat-not-found', 'chat not found');
    if (!store) throw new AccountSwitchRefusal('account-not-found', 'no accounts are configured');
    const account = store.find(accountId);
    if (!account) throw new AccountSwitchRefusal('account-not-found', `account ${accountId} not found`);
    if (accountId === (chat.account ?? DEFAULT_ID)) {
      if (!chat.pendingAccount) throw new AccountSwitchRefusal('same-account', 'the chat already runs on this account');
      chat.pendingAccount = null;
      this.persist(chat);
      return { chat: chat.summary(), pending: false };
    }
    if (accountId === chat.pendingAccount) return { chat: chat.summary(), pending: true };
    if (!account.enabled) throw new AccountSwitchRefusal('disabled', `account ${accountId} is disabled`);
    // Checked before signedIn, which an unusable sign-in also clears: the person is told it needs a new sign-in
    if (account.signInState === 'expired' || account.signInState === 'incomplete') {
      throw new AccountSwitchRefusal('sign-in-expired', `account ${accountId} needs a new sign-in (${account.signInState})`);
    }
    if (!account.signedIn) throw new AccountSwitchRefusal('signed-out', `account ${accountId} is signed out`);
    const out = isOut(account.limits, Date.now());
    if (out || chat.limitedAccounts.has(accountId)) {
      throw new AccountSwitchRefusal('exhausted', `account ${accountId} is out of usage${out && account.limits?.resetsAt ? ` until ${account.limits.resetsAt}` : ''}`);
    }
    // The lists the check looks at may not have been read yet (no turn, no tokens)
    await store.warmModels();
    const model = askedModel(chat);
    if (model && model !== 'default' && !store.canRun(accountId, model)) {
      throw new AccountSwitchRefusal('model-unavailable', `account ${accountId} does not offer ${model}`);
    }
    if (chat.status === 'busy' || chat.status === 'starting') {
      chat.pendingAccount = accountId;
      this.persist(chat);
      return { chat: chat.summary(), pending: true };
    }
    // The move ends the process, and its CLI would kill the work it runs in the background once its
    // input closed (D3): the switch waits for that work, and the chat says why it has not moved
    if (chat.alive && runsInBackground(chat.branches)) {
      chat.pendingAccount = accountId;
      this.persist(chat);
      this.notice(chat.id, `The switch to account ${accountId} waits for the work running in the background: ending the process now would stop it.`, { account: accountId, reason: 'background' });
      return { chat: chat.summary(), pending: true };
    }
    await this.endProcessBetweenTurns(chat);
    this.moveTo(chat, accountId, actor);
    return { chat: chat.summary(), pending: false };
  }

  /** Applies the switch that waited for the turn, once the turn has ended and the chat is idle. */
  private async applyPendingAccount(id: string): Promise<void> {
    const chat = this.chats.get(id);
    const to = chat?.pendingAccount;
    // A limited turn is the rotation's: it replays on an account of its own, and the choice waits for the next result.
    // Messages the agent is about to start on, and work it runs in the background, keep the process (D3)
    if (!chat || !to || chat.rateLimited || chat.status === 'busy' || chat.status === 'starting') return;
    if (chat.written().length > 0 || (chat.alive && runsInBackground(chat.branches))) return;
    await this.endProcessBetweenTurns(chat);
    // Another message may have started a turn while the process was closing
    if (chat.pendingAccount === to && !chat.alive) this.moveTo(chat, to, 'person');
  }

  /**
   * Ends an idle chat's process the way its idle timeout does: the input closes and the CLI exits by
   * itself. Its callers wait while the chat runs work in the background (D3).
   */
  private async endProcessBetweenTurns(chat: LiveChat): Promise<void> {
    const proc = chat.proc;
    if (!chat.alive || !proc) return;
    const closed = once(proc, 'close');
    chat.session?.endInput();
    const gave = await Promise.race([closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000).unref())]);
    if (!gave) {
      proc.kill('SIGTERM');
      await closed;
    }
  }

  /** Sets the account the chat's next execution runs on and records the move (decision 6 of chat-account-switch). */
  private moveTo(chat: LiveChat, to: string, actor: string): void {
    const from = chat.account;
    chat.pendingAccount = null;
    chat.account = to;
    chat.forcedAccount = to;
    chat.forcedReason = 'person';
    // A chat started on an account keeps its pin semantics, on the new account
    if (chat.opts.account) chat.opts.account = to;
    this.persist(chat);
    try {
      this.db.appendRotationEvent({ ts: new Date().toISOString(), event: 'switch', from, to, reason: 'person', detail: chat.name, data: { chatId: chat.id, actor } });
    } catch {
      // A closed database (shutting down) is not the switch's to report
    }
    this.bus?.emit({ type: 'account.switched', title: `${chat.name} moves from ${from ?? DEFAULT_ID} to ${to}`, from, to, reason: 'person' });
    this.notice(chat.id, `Switched to account ${to}.`, { account: to, from, reason: 'person' });
  }

  /**
   * A replay clears the limit flags before it stops the process that is still on its way out, and
   * `finalize` reads those flags to record why the execution ended. Stamp the cause on the execution
   * first, or the account that hit its limit is lost from `limitedTail` after a restart.
   */
  private keepLimitCause(chat: LiveChat): void {
    if (chat.rateLimited && chat.execution && !chat.execution.endedAt) {
      chat.execution.cause = chat.authFailed ? 'auth' : 'rate-limit';
    }
  }

  /**
   * Re-sends the turn that died against the limit, on the same chat and provider: what `wait` does
   * once the reset has passed. The process is gone by now, so `send` respawns it with `--resume`.
   */
  async replayLastTurn(id: string, account?: string): Promise<boolean> {
    const chat = this.chats.get(id);
    if (!chat || !chat.lastUserTurn) return false;
    // A move to another account is not the second failure the counter guards against: every account
    // the turn died on is no candidate for its next move (`chooseNext`), so a chain of moves ends by itself
    if (account) chat.forcedAccount = account;
    else if (chat.limitReplays >= MAX_LIMIT_REPLAYS) return false;
    else chat.limitReplays++;
    this.keepLimitCause(chat);
    chat.rateLimited = false;
    chat.authFailed = false;
    chat.limitRequested = false;
    // The turn that died is its first message and every one written while it ran, and whatever the
    // agent had not taken yet goes along with them, in the order they were sent
    const waiting = new Set(chat.pending.keys());
    const turn = [...chat.turnMessages.filter((m) => !waiting.has(m.id)), ...chat.pending.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    // A live process may hold state from before the reset: a respawn starts clean
    if (chat.alive) {
      const proc = chat.proc;
      chat.carrying = true;
      this.stop(id);
      if (proc) await once(proc, 'close');
    }
    chat.pending.clear();
    for (const message of turn) {
      // One that never reached the agent keeps the id the page knows it by, and the page hears it
      // goes on (`carried`); one the transcript already has goes again under an id of its own
      if (waiting.has(message.id)) this.carry(chat, message);
      this.sendMessage(id, message.text, message.attachments.map((a) => a.id), waiting.has(message.id) ? message.id : undefined, undefined, fromOf(message));
    }
    return true;
  }

  /** A message that waited for a process this chat replaces goes on in the new one, under its own id: the page is told so. */
  private carry(chat: LiveChat, message: SentMessage): void {
    chat.receipts.delete(message.id);
    chat.push({ kind: 'delivery', delivery: { id: message.id, state: 'carried', chatId: chat.id, source: message.source } });
  }

  /**
   * Goes on after a limit with a turn of the caller's instead of the one that died, counted as a
   * replay is: a workflow resumes its run from the cache, where replaying its lead's turn would launch
   * it again from nothing. What was still queued for the old process goes with it, after the
   * caller's turn and under the ids the page knows the messages by.
   */
  async replayWith(id: string, text: string, account?: string): Promise<boolean> {
    const chat = this.chats.get(id);
    if (!chat) return false;
    if (account) chat.forcedAccount = account;
    else if (chat.limitReplays >= MAX_LIMIT_REPLAYS) return false;
    else chat.limitReplays++;
    this.keepLimitCause(chat);
    chat.rateLimited = false;
    chat.authFailed = false;
    chat.limitRequested = false;
    const waiting = [...chat.pending.values()];
    if (chat.alive) {
      const proc = chat.proc;
      // Its messages go on in the next process: stopping this one loses none of them
      chat.carrying = true;
      this.stop(id);
      if (proc) await once(proc, 'close');
    }
    chat.pending.clear();
    this.sendMessage(id, text);
    for (const message of waiting) {
      this.carry(chat, message);
      this.sendMessage(id, message.text, message.attachments.map((a) => a.id), message.id, undefined, fromOf(message));
    }
    return true;
  }
}
