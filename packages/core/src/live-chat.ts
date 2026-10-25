import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename, join, resolve } from 'node:path';
import type {
  ClaudioAssistantMarker,
  Attachment,
  ChatActivity,
  ChatFork,
  ChatGuards,
  ChatMessageReceipt,
  ChatOrigin,
  ChatPendingMessage,
  ChatToolConfig,
  EffectiveEnvironment,
  Effort,
  Execution,
  GuardMode,
  GuardRuleId,
  NewChatRequest,
  PermissionMode,
  RunEvent,
  RunStatus,
  SpendPurpose,
  TokenUsage,
  TranscriptEntry,
} from '@claudio/shared';
import { isEffort } from '@claudio/shared';
import { ChatActivityTracker } from './chat-activity.ts';
import type { LiveSubagent } from './chat-branches.ts';
import { executionOutcome, INTERRUPTED_BY_RESTART } from './chat-model.ts';
import type { ChatRecord, StoredChat } from './chat-records.ts';
import type { BackgroundTask, WorkflowRun } from './cli-facts.ts';
import type { Db } from './db.ts';
import type { CoreConfig } from './paths.ts';
import type { PermissionBroker } from './permissions.ts';
import type { BranchTracker, DriverEvent, DriverSession, ModelUsage, ProviderDriver } from './providers/driver.ts';
import { emptyTokenUsage } from './usage.ts';

const MAX_EVENTS_PER_RUN = 5000;
/** Ids remembered per chat for a retried send: far more than any page retries */
const MAX_RECEIPTS = 500;
/** Why a message the agent had not taken when the wrapper went away is lost */
const RESTARTED = 'Claudio restarted before the agent read it';
/** Lost messages kept for a page opened later: the newest ones */
const MAX_UNDELIVERED = 20;

/** A message as sent: its id, its words and its files. */
export interface SentMessage {
  id: string;
  text: string;
  attachments: Attachment[];
  sentAt: string;
}

/** A message the agent has not taken yet: in its own queue (`written`), or held for the next process. */
export interface PendingMessage extends SentMessage {
  state: 'written' | 'held';
}

/** What the page sees of a message: the files without their path on the server's disk. */
export function pendingView(message: SentMessage & { state: ChatPendingMessage['state'] }, reason?: string): ChatPendingMessage {
  return {
    id: message.id,
    text: message.text,
    attachments: message.attachments.map(({ id, name, mediaType, kind, sizeBytes }) => ({ id, name, mediaType, kind, sizeBytes })),
    state: message.state,
    sentAt: message.sentAt,
    ...(reason ? { reason } : {}),
  };
}
const PARTIAL_THROTTLE_MS = 50;

/**
 * What a turn Claudio sends for the chat's own upkeep is: a compaction, or a request for a session
 * note. Its result is real (it costs, it counts) but it is nobody's work product, so it never reaches
 * what acts on a chat's result (docs/plans/context-control.md, D8).
 */
export type HousekeepingPurpose = 'compact' | 'note';

export interface RunResult {
  /** Set when the turn was housekeeping: the listeners that move work along on a result leave it alone */
  purpose?: HousekeepingPurpose;
  isError: boolean;
  result: string;
  structuredOutput: unknown;
  /** What the chat has cost across every execution so far */
  costUsd: number;
  /**
   * Why a failed result is not one to try again blindly: the budget ran out (the retry meets the same
   * ceiling), its provider hit its usage limit (moving the work is the rotation's job) or someone stopped it.
   */
  cause?: 'budget' | 'rate-limit' | 'stopped';
  /** The main agent's last `stop_reason` in the turn (`end_turn`, `tool_use`, `max_tokens`…), when the CLI said */
  stopReason?: string;
}

/**
 * The guard a chat's processes are launched with, once the launch path has resolved the rules and
 * written their files (`resolveGuards`, `writeGuardFiles`). Absent: the chat is not guarded.
 */
export interface ChatGuardPlan {
  /** The effective rules, `integrity` first */
  rules: GuardRuleId[];
  mode: GuardMode;
  /** The `--settings` file that registers the hooks */
  settingsPath: string;
  /** SHA-256 of the rules file the hooks check; the `armed` marker must name it */
  rulesSha256: string;
  /** A person is in the chat: a tool call with no marker stops the process but ends no run as failed, and the next turn waits for them */
  interactive?: boolean;
  /** The run's own scratch dir (`<data>/tmp/<id>`), exported as `TMPDIR` and removed when the run ends; the rules name it */
  tmpDir?: string;
}

/** What starts a chat, beyond what the API takes: the housekeeping knobs the wrapper's own callers use. */
export interface NewChat extends NewChatRequest {
  name?: string;
  /** A CLI agent the session runs as (`--agent`): a team member's, for a run of the flow by column */
  agent?: string;
  /**
   * A file defining agents for the session (`--agents`). The flow hands the member's definition this
   * way because the item's worktree only has the agent files that were committed.
   */
  agentsFile?: string;
  /**
   * `off` renders the system prompt fresh on every request instead of recording it on the first
   * (`--system-prompt-snapshot off`). A member's run asks for it: its prompt is the agent's and the
   * journal as they are now, and a recorded one would outlive the run into whoever continues the chat.
   */
  systemPromptSnapshot?: 'off';
  /**
   * `false` leaves the uploads directory out (`--add-dir`): a run Claudio starts on its own carries
   * no attachment, and every person's uploads would otherwise be readable to it.
   */
  uploads?: false;
  /** Keep the process alive after each turn so more messages can be sent (default true) */
  keepAlive?: boolean;
  /** Housekeeping: no transcript is written (`--no-session-persistence`), so it cannot be resumed */
  internal?: boolean;
  /**
   * Core-only, never read from a request body: the OpenAI-compatible surface started the chat, whose
   * origin is then `api` (`ChatService.create` takes it as its own argument and drops one in a body).
   */
  apiClient?: true;
  /**
   * `false` leaves `CLAUDIO_API_URL` out of the environment and mints no `CLAUDIO_API_TOKEN`: a run
   * that never calls the API back (a decision chat) holds no credential to it.
   */
  api?: false;
  /** Why the chat spends, for the daily spend ledger; unset reads `other` */
  purpose?: SpendPurpose;
  toolConfig?: ChatToolConfig | null;
  /** Held to a closed set of tools and no settings file: the project assistant's read-only runs */
  confine?: ChatConfinement;
  /**
   * Makes the chat one of the Claudio assistant: whatever the request asked for its tools, mode and
   * prompt, the core sets them again at every process (`ChatManager.assistantLaunch`).
   */
  claudioAssistant?: ClaudioAssistantMarker;
  /** Runs its processes under the guard's hooks (docs/plans/guards.md) */
  guards?: ChatGuardPlan;
  /**
   * Core-only, never read from a request: `handoff` says the Lessons section is already in
   * `appendSystemPrompt` (the flow's journal handoff carries it), so `launchSpec` does not add it again.
   */
  lessons?: 'handoff';
}

/**
 * A chat that may only do what Claudio names. The allow and deny lists only rule on the tools a
 * session has, and add to whatever the person's settings files allow; this takes the rest away.
 */
export interface ChatConfinement {
  /** `--tools`: the only built-in tools the session has */
  tools: string[];
  /** `--setting-sources`: the settings files it loads; empty loads none, so no rule, hook or server of theirs applies */
  settingSources: Array<'user' | 'project' | 'local'>;
}

/**
 * What `ChatTools` made of the tool preset and MCP servers a request picked, next to the request:
 * the lists and the config file the CLI is given, and the description of them a chat keeps.
 */
export interface ResolvedTools {
  toolConfig?: ChatToolConfig | null;
}

/**
 * What one execution of a resumed chat runs with beyond the start options: the flow resumes a
 * member's chat as its agent, asking for its structured result. `null` drops what an earlier
 * execution set, so a chat a person continues by hand is not held to a schema it never asked for.
 */
export interface ExecutionExtras {
  agent?: string | null;
  agentsFile?: string | null;
  jsonSchema?: unknown;
  systemPromptSnapshot?: 'off' | null;
  uploads?: false | null;
  /** See `NewChat.lessons`; `null` drops it, as a chat a person continues gets the section itself */
  lessons?: 'handoff' | null;
  keepAlive?: boolean;
  /**
   * The chat goes back to a person: whatever a member's run set (its mode, its allow and deny lists,
   * its budget, the appended journal, `keepAlive: false`) is dropped before the request's own
   * options apply, so the person's chat is not held to the rules of a run that already ended. The
   * model stays: it is the chat's, shown on it and switchable.
   */
  handBack?: boolean;
  confine?: ChatConfinement | null;
  /** The guard this execution runs under; `null` drops it. Only core's launch paths pass it, never a request body */
  guards?: ChatGuardPlan | null;
  /** Why this execution spends, for the daily spend ledger; left out, the chat keeps the purpose it had */
  purpose?: SpendPurpose;
  /**
   * The first turn of this execution is housekeeping: it is told apart from work wherever results are
   * acted on. Not `purpose`, which is the spend ledger's: a compaction spends for whatever the chat is for.
   */
  housekeeping?: HousekeepingPurpose;
  /** See `RunMeta.queued` */
  queued?: boolean;
}

export interface RunMeta {
  /** The start gives way to a person's chat that was refused a place: only for a caller that keeps its work pending and asks again (admission-queue.ts) */
  queued?: boolean;
  orchestrationId?: string;
  orchestrationTaskId?: string;
  /** The eval sample this chat is: its limit is the runner's to handle, so the rotation leaves it alone */
  evalSampleId?: string;
}

/** What is known of a chat that already exists when an execution resumes it from outside the store. */
export interface AdoptedChat {
  cwd: string;
  name: string;
  model: string | null;
}

/**
 * What the runtime says about a chat Claudio drives or has driven: its process, its live stream and
 * what it delegated. The chat the API serves is assembled from this, the transcript and the CLI's
 * own list of sessions (see `chat-service.ts`).
 */
export interface ChatRuntime {
  /** The session id */
  id: string;
  /** The provider whose agent runs the chat; a runtime built without a driver states none */
  provider?: string;
  /** The agent's own id for the session once it named it; null for a provider that takes Claudio's id */
  nativeSessionId?: string | null;
  name: string;
  cwd: string;
  /** Directory the CLI actually works in, which differs from `cwd` when it runs in a worktree */
  workingDir: string;
  origin: ChatOrigin;
  derivedFrom: ChatFork | null;
  model: string | null;
  permissionMode: PermissionMode;
  /** Id of the account its last process ran on; null before a process, or without accounts */
  account?: string | null;
  /** The chat was started on an account on purpose and keeps it while it can run */
  accountPinned?: boolean;
  /** The account a person chose while a turn ran; it takes over when the turn ends */
  pendingAccount?: string | null;
  /** The process's state, as the stream reports it: a chat's own state is derived from it */
  status: RunStatus;
  pid: number | null;
  /** When the live process started; null without one */
  processStartedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  turns: number;
  costUsd: number;
  prompt: string;
  lastText: string | null;
  error: string | null;
  orchestrationId: string | null;
  orchestrationTaskId: string | null;
  permissionPrompts: 'host' | 'none';
  /** Prompts waiting for someone right now: the chat is stuck until they are answered */
  pendingPrompts: number;
  /** What the live process is doing right now; null when there is none */
  activity: ChatActivity | null;
  /** The tool preset and MCP servers Claudio started it with; null when it picked none */
  tools?: ChatToolConfig | null;
  claudioAssistant?: ClaudioAssistantMarker | null;
  executions: Execution[];
  backgroundTasks: BackgroundTask[];
  /** With what each running one is doing, from its own sidechain */
  subagents: LiveSubagent[];
  workflows: WorkflowRun[];
  /** Messages the agent has not taken yet, and those lost since: what the page builds its queued cards from */
  pending?: ChatPendingMessage[];
  /** The guards on its live process; absent when none runs or the chat is not guarded */
  guards?: ChatGuards | null;
}

/** A shell command the process started and has had no answer to yet. */
export interface RunningCommand {
  command: string;
  startedAt: string;
  /** The tool call, which is what cancelling one command is addressed by */
  toolUseId: string;
  /** The CLI's heartbeat for it: how long it says the command has run, as of `at` */
  heartbeat?: { elapsedSeconds: number; at: string };
}

/** What the process working on a chat is doing right now. */
export interface ChatPulse {
  /** The last thing it did, streamed text included */
  lastEventAt: string;
  commands: RunningCommand[];
}

export const now = () => new Date().toISOString();

/** Started (a failed spawn has no pid) and not exited yet */
export const processUp = (proc: ChildProcess): boolean => proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null;

/**
 * What the code that reads and writes a chat's process needs of the manager that owns the chat: the
 * stores it records into, the announcements it makes and the few things only the manager can do.
 * The manager hands over one, so the functions that parse the stream and answer the CLI hold no
 * reference to the manager itself.
 */
export interface ChatHost {
  readonly db: Db;
  /** Latest `init` snapshot per working directory */
  readonly environments: Map<string, EffectiveEnvironment>;
  readonly permissions: PermissionBroker | null;
  emit(event: string, ...args: unknown[]): void;
  persist(): void;
  noteActivity(chat: LiveChat): void;
  /** Folds what the chat's provider reported about its limit into the provider's reading */
  observeLimit(chat: LiveChat, event: DriverEvent): void;
  /** Marks the account the chat ran on as signed out, or clears the mark when a turn went through on it */
  observeSignIn(chat: LiveChat, authFailed: boolean): void;
  learnModelCosts(execution: Execution, modelUsage: ModelUsage[]): void;
  learnWindows(modelUsage: ModelUsage[]): void;
  maybeLimit(chat: LiveChat): void;
  /** Writes one row of the daily spend ledger for a result: `usd` is the increase over the process's last report, null when the result carried no cost */
  recordSpend(chat: LiveChat, execution: Execution, usd: number | null): void;
  /** Ends the chat's execution as failed for a protocol fault and takes the process down */
  failProtocol(chat: LiveChat, message: string): void;
  /** The guard's `SessionStart` marker arrived: the chat is armed, and what waited for it is written */
  guardArmed(chat: LiveChat): void;
  /** A tool call went by with no guard marker: the process is interrupted and the run ends, or waits for the person */
  guardMissing(chat: LiveChat): void;
}

/**
 * What `ContextControl` hears of a chat, through the manager's `chat-context` event: the agent's own
 * compaction events, the end of a housekeeping turn, and the end of the process.
 */
export type ContextSignal =
  | { kind: 'driver'; event: Extract<DriverEvent, { kind: 'compacting' | 'compacted' | 'compact-failed' }>; interrupted?: boolean; stopped?: boolean }
  /** The summary Claude Code continued from, as the stream carries it right after the boundary */
  | { kind: 'summary'; entry: TranscriptEntry }
  | { kind: 'result'; result: RunResult; interrupted: boolean }
  | { kind: 'ended'; stopped: boolean; error: string | null };

/**
 * A chat Claudio has a record of, in memory: its live stream, whatever it delegated, its history of
 * executions and, while one is running, the process. There is one per session id, however many
 * times the chat is resumed: resuming adds an execution here, it never adds a chat.
 */
export class LiveChat {
  readonly emitter = new EventEmitter();
  readonly events: RunEvent[] = [];
  /** What the agent delegated, across every process of the chat */
  readonly branches: BranchTracker;
  /** The protocol of the live process; null without one */
  session: DriverSession | null = null;
  /** Every execution, oldest first; at most the last one is live */
  executions: Execution[] = [];
  /** The execution a wrapper restart cut off, when this chat was restored with one: its stop time is still an estimate */
  cutOff: Execution | null = null;
  proc: ChildProcessWithoutNullStreams | null = null;
  /** When `proc` was spawned: its stream reports every workflow started since, and none before */
  procStartedAt: string | null = null;
  /** The `total_cost_usd` the current process last reported; it is cumulative over the process, so each result's spend is the increase. Reset at every spawn. */
  lastReportedCostUsd = 0;
  /** The `modelUsage` the current process last reported, cumulative like its cost. Reset at every spawn. */
  lastReportedModelUsage: ModelUsage[] = [];
  /**
   * What the last result's turn alone used and cost: the growth of the process's cumulative figures
   * since its previous result. Null before any result, or when the result reported none.
   */
  lastTurn: { tokens: TokenUsage | null; costUsd: number | null } = { tokens: null, costUsd: null };
  seq = 0;
  /** `seq` when the current execution began: a stream opened from here replays the whole execution */
  executionSeq = 0;
  status: RunStatus = 'starting';
  model: string | null;
  name: string;
  cwd: string;
  permissionMode: PermissionMode;
  createdAt = now();
  updatedAt = now();
  /** The last thing the process did, streamed text included, which `updatedAt` (stored events only) leaves out */
  activityAt = now();
  endedAt: string | null = null;
  lastText: string | null = null;
  /** Where the CLI says it works, from its init event: a worktree when it was given one */
  workingDir: string | null = null;
  error: string | null = null;
  lastResult: RunResult | null = null;
  /** The housekeeping turn under way, cleared by its result, by an exit and by an interrupt */
  purpose: HousekeepingPurpose | null = null;
  stopRequested = false;
  idleTimer: NodeJS.Timeout | null = null;
  /** When the chat went idle, while its idle timer runs */
  idleSince: number | null = null;
  /** Pages holding the chat's stream open */
  viewers = 0;
  /** Its input was ended to make room for a start: the process is on its way out and no longer counts */
  released = false;
  partial: { block: 'text' | 'thinking'; text: string } | null = null;
  partialTimer: NodeJS.Timeout | null = null;
  private partialSentAt = 0;
  /** How much of the current block subscribers hold; null until its first partial went out */
  partialSent: { block: 'text' | 'thinking'; length: number } | null = null;
  /** The structured result (`--json-schema`) as its tool call streams it: raw JSON, cut wherever it has got to */
  structured: string | null = null;
  /**
   * The live process's guard: `arming` from the spawn until its `SessionStart` marker arrives, then
   * `armed`; `missing` after a tool call went by unguarded. Null when the chat is not guarded.
   */
  guardState: ChatGuards['state'] | null = null;
  /** Messages written while arming, in order: the process is sent them when it is armed */
  armingQueue: Array<{ message: SentMessage; announce: boolean }> = [];
  armingTimer: NodeJS.Timeout | null = null;
  /** Prompts the CLI is holding for a person */
  pendingPrompts = 0;
  /** The turn is ending because someone interrupted it, not because it failed */
  interruptRequested = false;
  /** What the live process is doing right now, folded from the stream as it arrives */
  readonly activity: ChatActivityTracker;
  /** The last activity announced on the feed, so a line that changes nothing costs no summary */
  activityKey = '';
  /**
   * What each running subagent is doing, by the id of the call that launched it: its sidechain names
   * it so (`parentToolUseId`), and the agent id may not be known yet when its first call streams.
   */
  readonly branchActivity = new Map<string, ChatActivityTracker>();
  /** The last activity announced per subagent, by the same key; one whose tracker is gone is announced as null once */
  readonly branchActivityKeys = new Map<string, string>();
  /** The CLI's `tool_progress` heartbeats for the commands still running, by tool call */
  readonly heartbeats = new Map<string, { elapsedSeconds: number; at: string }>();
  /** Foreground commands started and not answered, for the history of how long each kind takes */
  readonly openCommands = new Map<string, { command: string; kind: string; startedAt: string }>();
  /** Commands a person cancelled: their failed result is the person's doing, and says nothing about how long the command takes */
  readonly cancelled = new Set<string>();
  /**
   * Every message the agent has not taken yet, by id, in the order sent (docs/chat-delivery.md).
   * `written`: in the agent's own queue until it reports taking it. `held`: it arrived while the
   * process was on its way out (stopped, or its stdin closed and it finishing background work), and
   * one process replaces it when it exits and gets all of them. Each used to schedule a replacement
   * of its own, and three messages made three processes.
   */
  readonly pending = new Map<string, PendingMessage>();
  /** Messages lost on the way, kept until the person sends again, so a page opened later still says so */
  undelivered: ChatPendingMessage[] = [];
  /** Ids already taken, newest last, with how: a retried send is written once */
  readonly receipts = new Map<string, ChatMessageReceipt>();
  /**
   * Whether the live process reports each message it takes. Unknown until it reports one, or until
   * its first result arrives without having reported the message that started it: a CLI that does
   * not, and what is written to it is tracked no further, as before.
   */
  reportsDelivery: boolean | null = null;
  /** The messages of the turn under way, or of the last one: what a limit replay sends again */
  turnMessages: SentMessage[] = [];
  /** A result arrived since the last message: the next one starts the list again */
  turnOver = true;
  /** The live process has closed its pipes; until then a process that exited is still on its way out */
  procClosed = true;
  /** The live process's messages go on in another process (a limit replay): stopping it loses none */
  carrying = false;
  /**
   * The CLI has confirmed the session exists (its `init` arrived): from then on a process resumes
   * it. Until then the first spawn creates it, under the id Claudio chose, which is what lets a fork
   * have its id before the CLI has said anything.
   */
  created: boolean;
  /** The chat this one is a copy of, until the copy is confirmed: the first spawn forks it */
  forkFrom: string | null = null;
  /**
   * The agent's own id for the session, once a process has reported it; null before, and always
   * null for a provider that takes the id Claudio chose. Once set it never changes.
   */
  nativeId: string | null = null;
  /** The last message sent, files included: a chat with none has no turn a limit could replay */
  lastUserTurn: { text: string; attachments: string[] } | null = null;
  /** The turn died against its provider's usage limit */
  rateLimited = false;
  /**
   * The turn died because the account's sign-in is gone (a 401). The rotation takes it as it takes a
   * limit, so `rateLimited` is set with it; this says which of the two it was.
   */
  authFailed = false;
  /**
   * The accounts the turn died on at their limit since the chat last ended a turn without one: what
   * the rotation passes over. Kept on the chat, not in the accounts' readings, because a failure
   * says the account is out but not how full it is or until when
   */
  limitedAccounts = new Set<string>();
  /**
   * The main agent's last `stop_reason` in this turn, from stream-json: a turn cut by `max_tokens`
   * can still end with JSON that parses, and a reader of the result has to know it was cut
   */
  stopReason: string | null = null;
  /** `limit-hit` was already announced for this attempt */
  limitRequested = false;
  /** Replays of the last turn for this execution: a second failure on the limit is a real one */
  limitReplays = 0;
  /** Id of the account the last process ran on */
  account: string | null = null;
  /** The account the rotation moved the chat to: the next process takes it instead of choosing, once */
  forcedAccount: string | null = null;
  /** Why `forcedAccount` was set; `limit` unless a person chose it */
  forcedReason: 'limit' | 'person' = 'limit';
  /** The account a person chose while a turn runs, applied when its result arrives */
  pendingAccount: string | null = null;

  constructor(
    /** The session id */
    readonly id: string,
    readonly opts: NewChat,
    readonly meta: RunMeta,
    readonly origin: ChatOrigin,
    readonly derivedFrom: ChatFork | null,
    config: Pick<CoreConfig, 'workspaceDir' | 'defaultPermissionMode'>,
    readonly driver: ProviderDriver,
    created = false,
  ) {
    this.cwd = resolve(opts.cwd ?? config.workspaceDir);
    this.permissionMode = opts.permissionMode ?? config.defaultPermissionMode;
    this.model = opts.model ?? null;
    this.created = created;
    this.name = opts.name ?? `${basename(this.cwd)}-${this.id.slice(0, 6)}`;
    this.activity = new ChatActivityTracker(this.cwd);
    this.branches = driver.createBranches();
    this.branches.sessionId = id;
    this.emitter.setMaxListeners(100);
  }

  /**
   * Rebuilds a chat persisted by a previous wrapper process; it has no process until a message
   * resumes it. An execution that was live when that wrapper went away is over now, and nobody
   * stopped it: it ends as `interrupted`.
   */
  static restore({ record, executions }: StoredChat, config: CoreConfig, driver: ProviderDriver): LiveChat {
    const lastEffort = executions[executions.length - 1]?.effort ?? null;
    const chat = new LiveChat(
      record.id,
      {
        prompt: record.prompt,
        cwd: record.cwd,
        name: record.name,
        ...(record.model ? { model: record.model } : {}),
        // A resume or a fork goes on with the effort the last execution ran with, unless it is given
        ...(lastEffort ? { effort: lastEffort } : {}),
        permissionMode: record.permissionMode,
        internal: record.origin === 'internal',
        permissionPrompts: record.permissionPrompts,
        // A resumed chat keeps the tools and servers it was given, not the ones the CLI would pick
        ...(record.tools ? { toolConfig: record.tools, allowedTools: record.tools.allowedTools, disallowedTools: record.tools.disallowedTools } : {}),
        ...(record.tools?.mcp?.config ? { mcp: record.tools.mcp } : {}),
        ...(record.claudioAssistant ? { claudioAssistant: record.claudioAssistant } : {}),
        ...(record.keepAlive === false ? { keepAlive: false } : {}),
        // The purpose is not stored: what a person sends to a chat after a restart is theirs, and the
        // starters set their own again when they resume it
        ...(record.origin === 'orchestration' ? { purpose: 'orchestration' as const } : record.origin === 'claudio' || record.origin === 'external' || record.origin === 'api' ? { purpose: 'person' as const } : {}),
        ...(record.accountPinned && record.account ? { account: record.account } : {}),
      },
      { orchestrationId: record.orchestrationId ?? undefined, orchestrationTaskId: record.orchestrationTaskId ?? undefined },
      record.origin,
      record.derivedFrom,
      config,
      driver,
      true,
    );
    // `updatedAt` is a floor for when it stopped: the record is only written at a few moments of a
    // turn, so the manager refines it from the transcript, which the CLI writes as it goes
    chat.executions = executions.map((e) => {
      if (e.endedAt !== null) return e;
      const cut = { ...e, endedAt: record.updatedAt, outcome: executionOutcome('busy', true), error: e.error ?? INTERRUPTED_BY_RESTART };
      chat.cutOff = cut;
      return cut;
    });
    const last = chat.executions[chat.executions.length - 1];
    // The process's own status, for whatever still asks: nothing is running, and how it ended is
    // what the last execution says
    chat.status = last?.outcome === 'completed' || last?.outcome === 'failed' ? last.outcome : 'stopped';
    chat.createdAt = record.createdAt;
    chat.updatedAt = record.updatedAt;
    chat.endedAt = last?.endedAt ?? record.updatedAt;
    chat.lastText = record.lastText;
    chat.error = last?.error ?? null;
    chat.workingDir = record.workingDir;
    chat.nativeId = record.nativeSessionId ?? null;
    chat.account = record.account ?? null;
    // Whatever the agent had not taken went with the processes of the wrapper that wrote this
    chat.undelivered = (record.pending ?? []).map((m) => (m.state === 'undelivered' ? m : { ...m, state: 'undelivered', reason: RESTARTED }));
    return chat;
  }

  /**
   * What the chat runs with: what was resolved from a preset and servers, or, for a chat that only
   * has tool lists (an orchestration worker), those lists, since they are what explains a refusal.
   */
  get tools(): ChatToolConfig | null {
    const { toolConfig, allowedTools, disallowedTools } = this.opts;
    if (toolConfig) return toolConfig;
    if (!allowedTools?.length && !disallowedTools?.length) return null;
    return { preset: null, allowedTools: allowedTools ?? [], disallowedTools: disallowedTools ?? [], mcp: null };
  }

  /** The guards on the live process, for the page's tag; a process stopped for a missing marker still says so */
  get guards(): ChatGuards | null {
    const plan = this.opts.guards;
    if (!plan || !this.guardState) return null;
    if (!this.alive && this.guardState !== 'missing') return null;
    return { rules: plan.rules, mode: plan.mode, state: this.guardState };
  }

  /** The provider whose agent runs the chat */
  get provider(): string {
    return this.driver.manifest.id;
  }

  /** The live execution, when a process is working on the chat */
  get execution(): Execution | null {
    const last = this.executions[this.executions.length - 1];
    return last && last.endedAt === null ? last : null;
  }

  get turns(): number {
    return this.executions.reduce((sum, e) => sum + e.turns, 0);
  }

  /** What the chat has cost: only what the CLI reported, nothing estimated */
  get costUsd(): number {
    return this.executions.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  }

  /** A message waits for the exiting process to be replaced: its exit is not the chat's end */
  get respawnQueued(): boolean {
    return this.held().length > 0;
  }

  /** The messages held for the process that replaces this one, oldest first */
  held(): PendingMessage[] {
    return [...this.pending.values()].filter((m) => m.state === 'held');
  }

  /** The messages written into the agent's queue that it has not taken yet, oldest first */
  written(): PendingMessage[] {
    return [...this.pending.values()].filter((m) => m.state === 'written');
  }

  /** What the page is told is still on its way, and what was lost since */
  pendingList(): ChatPendingMessage[] {
    return [...[...this.pending.values()].map((m) => pendingView(m)), ...this.undelivered];
  }

  /** Remembers how a message was taken, so the same id sent again is answered without writing it twice */
  remember(receipt: ChatMessageReceipt): void {
    this.receipts.set(receipt.id, receipt);
    for (const id of this.receipts.keys()) {
      if (this.receipts.size <= MAX_RECEIPTS) break;
      this.receipts.delete(id);
    }
  }

  /**
   * Until it has exited. `killed` only says a signal was delivered: a stopped process can take
   * seconds to go, and counting it gone let a resume start a second process beside it.
   */
  get alive(): boolean {
    return this.proc !== null && processUp(this.proc);
  }

  /**
   * The effort the next process starts with: what the start options chose, and only on a provider
   * that declares `effort`: a driver without it is never handed a level it cannot take.
   */
  get effort(): Effort | null {
    const level = this.opts.effort;
    return isEffort(level) && this.driver.manifest.capabilities.includes('effort') ? level : null;
  }

  /** The mode and model the chat runs with now, and the live execution with it. */
  setSettings(update: { permissionMode?: PermissionMode; model?: string }): void {
    const live = this.execution;
    if (update.permissionMode) {
      this.permissionMode = update.permissionMode;
      if (live) live.permissionMode = update.permissionMode;
    }
    if (update.model) {
      this.model = update.model;
      if (live) live.model = update.model;
    }
  }

  /** Opens the execution a process starts, on top of the settings the chat has now. */
  beginExecution(): Execution {
    this.executionSeq = this.seq;
    const execution: Execution = {
      id: randomUUID(),
      startedAt: now(),
      endedAt: null,
      outcome: null,
      error: null,
      permissionMode: this.permissionMode,
      model: this.model,
      ...(this.account ? { account: this.account } : {}),
      // Left out when none was passed, as the executions written before it was kept
      ...(this.effort ? { effort: this.effort } : {}),
      maxBudgetUsd: typeof this.opts.maxBudgetUsd === 'number' && this.opts.maxBudgetUsd > 0 ? this.opts.maxBudgetUsd : null,
      costUsd: null,
      tokens: emptyTokenUsage(),
      turns: 0,
    };
    this.executions.push(execution);
    return execution;
  }

  summary(): ChatRuntime {
    return {
      id: this.id,
      provider: this.provider,
      name: this.name,
      cwd: this.cwd,
      workingDir: this.workingDir ?? (this.opts.worktree ? join(this.cwd, '.claude', 'worktrees', this.opts.worktree) : this.cwd),
      origin: this.origin,
      derivedFrom: this.derivedFrom,
      model: this.model,
      permissionMode: this.permissionMode,
      ...(this.account ? { account: this.account } : {}),
      ...(this.opts.account ? { accountPinned: true } : {}),
      ...(this.pendingAccount ? { pendingAccount: this.pendingAccount } : {}),
      status: this.status,
      pid: this.alive ? (this.proc?.pid ?? null) : null,
      processStartedAt: this.alive ? this.procStartedAt : null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      endedAt: this.endedAt,
      turns: this.turns,
      costUsd: this.costUsd,
      prompt: this.opts.prompt,
      lastText: this.lastText,
      error: this.error,
      orchestrationId: this.meta.orchestrationId ?? null,
      orchestrationTaskId: this.meta.orchestrationTaskId ?? null,
      permissionPrompts: this.opts.permissionPrompts === 'host' ? 'host' : 'none',
      ...(this.nativeId ? { nativeSessionId: this.nativeId } : {}),
      pendingPrompts: this.pendingPrompts,
      // A chat with no process of ours is doing nothing, whatever the last stream left behind
      activity: this.alive ? this.activity.current() : null,
      tools: this.tools,
      ...(this.opts.claudioAssistant ? { claudioAssistant: this.opts.claudioAssistant } : {}),
      executions: this.executions,
      backgroundTasks: [...this.branches.tasks.values()],
      subagents: [...this.branches.subagents.values()].map((sub) => {
        const tracker = this.alive && sub.status === 'running' ? this.branchActivity.get(sub.toolUseId) : undefined;
        return tracker ? { ...sub, activity: tracker.current() } : sub;
      }),
      workflows: [...this.branches.workflows.values()],
      pending: this.pendingList(),
      ...(this.guards ? { guards: this.guards } : {}),
    };
  }

  /** A message lost on the way: the page is told at once, and a page opened later still finds it. */
  lose(message: SentMessage, reason: string): void {
    const view = pendingView({ ...message, state: 'undelivered' }, reason);
    this.undelivered = [...this.undelivered.filter((m) => m.id !== message.id), view].slice(-MAX_UNDELIVERED);
    this.push({ kind: 'delivery', delivery: { id: message.id, state: 'undelivered', message: view } });
  }

  /** What the store keeps of the chat besides its executions. */
  record(): ChatRecord {
    return {
      id: this.id,
      provider: this.provider,
      name: this.name,
      cwd: this.cwd,
      workingDir: this.workingDir,
      origin: this.origin,
      orchestrationId: this.meta.orchestrationId ?? null,
      orchestrationTaskId: this.meta.orchestrationTaskId ?? null,
      derivedFrom: this.derivedFrom,
      prompt: this.opts.prompt,
      lastText: this.lastText,
      model: this.model,
      permissionMode: this.permissionMode,
      permissionPrompts: this.opts.permissionPrompts === 'host' ? 'host' : 'none',
      ...(this.account ? { account: this.account } : {}),
      ...(this.opts.account ? { accountPinned: true as const } : {}),
      ...(this.nativeId ? { nativeSessionId: this.nativeId } : {}),
      tools: this.tools,
      ...(this.opts.claudioAssistant ? { claudioAssistant: this.opts.claudioAssistant } : {}),
      ...(this.opts.keepAlive === false ? { keepAlive: false as const } : {}),
      ...(this.pending.size || this.undelivered.length ? { pending: this.pendingList() } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  push(event: Omit<RunEvent, 'seq' | 'ts'>): void {
    const full: RunEvent = { ...event, seq: ++this.seq, ts: now() };
    this.events.push(full);
    if (this.events.length > MAX_EVENTS_PER_RUN) this.events.splice(0, this.events.length - MAX_EVENTS_PER_RUN);
    this.updatedAt = full.ts;
    this.activityAt = full.ts;
    this.emitter.emit('event', full);
  }

  /** Streams the in-progress block to live subscribers only: not stored, not replayed, seq untouched. */
  emitPartial(): void {
    this.activityAt = now();
    if (this.partialTimer) return;
    // The first token of a block goes out at once; after that at most one frame per throttle
    const wait = PARTIAL_THROTTLE_MS - (Date.now() - this.partialSentAt);
    if (wait <= 0) return this.sendPartial();
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null;
      this.sendPartial();
    }, wait);
  }

  private sendPartial(): void {
    if (!this.partial) return;
    this.partialSentAt = Date.now();
    const { block, text } = this.partial;
    const sent = this.partialSent;
    // The first partial of a block carries all of it; after that only what is new, and where it starts
    const whole = !sent || sent.block !== block || sent.length > text.length;
    this.partialSent = { block, length: text.length };
    this.emitter.emit('event', {
      seq: this.seq,
      ts: now(),
      kind: 'partial',
      block,
      ...(whole ? { text } : { append: text.slice(sent.length), at: sent.length }),
    } satisfies RunEvent);
  }

  /** The current block as a late subscriber needs it: the whole text so far, or null between blocks. */
  partialSnapshot(): RunEvent | null {
    if (!this.partial) return null;
    return { seq: this.seq, ts: now(), kind: 'partial', block: this.partial.block, text: this.partial.text };
  }

  setStatus(status: RunStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.push({ kind: 'status', status });
  }
}
