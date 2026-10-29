import type { AccountRef } from '@claudio/accounts';
import type {
  Attachment,
  ContextDetail,
  EffectiveEnvironment,
  LiveMcpServer,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PermissionUpdate,
  PolicyTranslation,
  ProviderCapability,
  RateLimitInfo,
  RunEvent,
  RunGuardEvent,
  ToolPolicy,
  TranscriptEntry,
} from '@claudio/shared';
import type { BackgroundTask, SubagentInfo, WorkflowRun } from '../cli-facts.ts';
import type { ChatConfinement, NewChat } from '../live-chat.ts';
import type { NeutralRequest } from '../policy-judge.ts';
import type { ProviderManifest } from './manifest.ts';
import type { TranscriptStore } from './transcripts.ts';

/**
 * The executable a driver starts: a fixed path, or one read again at every start. Core passes the
 * latter, so the person's binary override in Settings → Claude Code applies to the next process
 * without rebuilding the driver.
 */
export type BinarySource = string | (() => string);

export function binaryOf(source: BinarySource): string {
  return typeof source === 'function' ? source() : source;
}

/**
 * The code half of a provider; the manifest is the data half. Everything that is the agent's own
 * (its flags, its environment, its stream, its control protocol) sits behind this; everything that is
 * Claudio's (chats, executions, queueing, tokens, persistence, limits and moves) stays in
 * `ChatManager`.
 */
export interface ProviderDriver {
  readonly manifest: ProviderManifest;

  /** Claudio's policy in the provider's own terms, and what it cannot enforce */
  translatePolicy(policy: ToolPolicy): PolicyTranslation;
  /** What the picker offers for this provider */
  models(): ModelOption[];
  /**
   * Every name the provider's catalog may use for one model: an alias and the id it resolved to.
   * A run records the id the CLI reports, while the picker holds the alias.
   */
  modelNames?(model: string): string[];
  /** Who names the session: Claudio (`imposed`, Claude) or the agent (`assigned`) */
  readonly sessionIds: 'imposed' | 'assigned';
  /** The permission modes this provider can honour, each with its native value; the picker offers only these */
  permissionModes(): Array<{ mode: PermissionMode; native: string }>;
  /** Reads what the provider wrote; null when it keeps nothing Claudio can read */
  readonly transcripts: TranscriptStore | null;
  /** A handshake that spends nothing, for detection: version, account, models, confirmed capabilities */
  handshake?(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<HandshakeResult>;

  /** How one process of a session starts: binary, argv and environment */
  launch(spec: SessionLaunch): LaunchPlan;
  /** Speaks the protocol to one process; events come out already neutral */
  attach(io: SessionIO, sink: (event: DriverEvent) => void, branches: BranchTracker, guard?: AttachedGuard): DriverSession;
  /** Per chat, across its processes: background tasks, subagents, workflows */
  createBranches(): BranchTracker;
  /** OS processes holding a session, for "it is still running elsewhere" and restore's leftovers */
  sessionHolders(sessionId: string): number[];
  liveSessions(): Array<{ pid: number; sessionId: string }>;

  /** What a session's first event confirms for the installed version */
  confirm(init: SessionInit): CapabilityConfirmation;
}

/**
 * The guard a process was launched with, as the stream needs it: markers only count when the launch
 * carried one, and its `armed` marker must name these rules (docs/plans/guards.md, "Arming and liveness").
 */
export interface AttachedGuard {
  /** SHA-256 of the rules file the process's hook was given */
  rulesSha256: string;
}

/** What a handshake that spends nothing learns about the installed provider. */
export interface HandshakeResult {
  version: string | null;
  /** Who is signed in, when the protocol says; null when it does not */
  account: string | null;
  models: ModelOption[];
  confirmed: ProviderCapability[];
}

/** Everything a process of a session is started from, minus what belongs to Claudio alone. */
export interface SessionLaunch {
  /** The session id, chosen by Claudio and imposed on the agent */
  id: string;
  /** The agent's own id once it has named the session; null before the first process confirms it */
  nativeId: string | null;
  /** The agent has confirmed the session exists: a process resumes it */
  created: boolean;
  /** The session this one is a copy of, until the copy is confirmed */
  forkFrom: string | null;
  name: string;
  cwd: string;
  permissionMode: PermissionMode;
  model?: string;
  effort?: NewChat['effort'];
  appendSystemPrompt?: string;
  /** The person's own rules, in the provider's words */
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpConfig?: string;
  /** `mcpConfig` adds to the servers the CLI loads on its own instead of replacing them */
  mcpConfigAdds?: boolean;
  /** No MCP server loads but those of `mcpConfig`, and none without one: a confined API chat's */
  strictMcpConfig?: true;
  confine?: ChatConfinement;
  /** Where attached files live, when this session may read them */
  uploadsDir?: string;
  worktree?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  fallbackModel?: string;
  thinking?: 'adaptive' | 'disabled';
  maxThinkingTokens?: number;
  thinkingDisplay?: string;
  /** Resume at this message of the session instead of its end; only with `created` */
  resumeSessionAt?: string;
  /** `host` only when something is listening for what the agent asks */
  permissionPrompts: 'host' | 'none';
  jsonSchema?: unknown;
  systemPromptSnapshot?: 'off';
  internal?: boolean;
  agent?: string;
  agentsFile?: string;
  /** The settings file that registers the guard's hooks; the driver passes it and asks for the hook events */
  guard?: { settingsPath: string };
  /** Claudio's policy for this run; the driver applies the settings part, the judge the host part */
  policy: ToolPolicy | null;
  /** The Claude account this process runs on; absent leaves the environment as the CLI's own login */
  account?: AccountRef;
}

/** The process to start. `ChatManager` adds `CLAUDIO_CHAT_ID`, `CLAUDIO_API_URL` and the minted token itself. */
export interface LaunchPlan {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Variables the process must not inherit, removed after `env` */
  unsetEnv: string[];
}

/** The pipes of one process, as the protocol sees them. */
export interface SessionIO {
  write(text: string): void;
  /** Closes what the agent reads from */
  end(): void;
  /** The process is started and has not exited */
  up(): boolean;
}

/** What the agent made of a set of run-time servers, by name. */
export interface McpSetServersResult {
  added: string[];
  removed: string[];
  /** A name the agent refused, with its own words */
  errors: Record<string, string>;
}

/** A user turn: text and the files that go with it. */
export interface UserTurn {
  /** Claudio's id for the message, which the driver hands the agent where its protocol takes one */
  id?: string;
  text: string;
  attachments: Attachment[];
  /** The bytes of an attachment, for a provider that sends images and documents inline */
  read?: (uploadId: string) => Buffer;
}

export interface DriverSession {
  /** Sends a turn; returns the text the agent received as the user's, for the transcript */
  send(turn: UserTurn): string;
  interrupt(): Promise<void>;
  setOption(option: { permissionMode: PermissionMode } | { model: string } | { maxThinkingTokens: number | null }): Promise<void>;
  /** The MCP servers the process has, as it reports them now; a driver that cannot say leaves it out */
  mcpStatus?(): Promise<LiveMcpServer[]>;
  /** The context window's use as the process reports it now, between turns; a driver that cannot say leaves it out */
  contextUsage?(detail?: ContextDetail): Promise<Record<string, unknown>>;
  /** Switches one MCP server of the process on or off; the agent may keep the choice beyond the process */
  mcpToggle?(name: string, enabled: boolean): Promise<void>;
  /**
   * Replaces the servers the process was handed at run time (Claude Code's `mcp_set_servers`): the
   * ones named are started or kept, the ones pushed before and missing now are stopped. Answers what
   * the agent added, removed and refused, by name.
   */
  mcpSetServers?(servers: Record<string, Record<string, unknown>>): Promise<McpSetServersResult>;
  answerPermission(requestId: string, decision: PermissionDecision): void;
  /** One line of stdout */
  readLine(line: string): void;
  /** One line of stderr */
  readError(line: string): void;
  /** Closes stdin: `keepAlive: false`, or the idle timeout */
  endInput(): void;
  /**
   * Turns sent and not started yet, held by the driver itself: input is not ended while it holds
   * any, or they would be written after it. A driver whose agent keeps its own queue holds none.
   */
  holdsTurns?(): boolean;
  /** Rejects pending control requests */
  dispose(reason: string): void;
}

/** Per chat, across its processes: what the agent delegated. */
export interface BranchTracker {
  readonly tasks: Map<string, BackgroundTask>;
  /** Long commands reported as tasks while they run in the foreground; listed once sent to the background */
  readonly foregroundTasks: Map<string, BackgroundTask>;
  readonly subagents: Map<string, SubagentInfo>;
  readonly workflows: Map<string, WorkflowRun>;
  /** The session the tracker belongs to; the id a task reports when it names none */
  sessionId: string;
  /** Reads the delegation out of a message the main agent or a subagent wrote */
  message(entry: TranscriptEntry): void;
  /** Applies a change of the agent's task list */
  task(change: string, raw: Record<string, unknown>): void;
  /** The process is gone: whatever still runs is over */
  endAll(at: string): void;
  /** A turn ended: an agent the turn waited on and never heard back from is over; the ones sent to the background go on */
  endForeground(at: string): void;
}

/** What a session's first event says about it. */
export interface SessionInit {
  version: string | null;
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  /** The session was started with a schema */
  structuredOutput: boolean;
}

export interface CapabilityConfirmation {
  version: string | null;
  confirmed: ProviderCapability[];
  /** Declared and contradicted by the init */
  missing: ProviderCapability[];
}

/** The request for a decision the agent is waiting on. */
export interface PermissionQuestion {
  id: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  description?: string;
  suggestions?: PermissionUpdate[];
  requiresUserInteraction?: boolean;
  /** The path the agent was blocked on, when the request is about one */
  blockedPath?: string;
  /** Why the agent asks, as the CLI words it */
  decisionReason?: string;
  title?: string;
  displayName?: string;
  /** The subagent that asked, when it is not the main agent */
  agentId?: string;
  /** The request in neutral terms, for a driver whose translation leaves a part to the judge */
  request?: NeutralRequest;
}

/** A per-model cost and window, as the agent reports them at the end of a turn. */
export interface ModelUsage {
  model: string;
  costUsd?: number;
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  maxOutputTokens?: number;
}

/**
 * What `ChatManager` pushes to a chat's feed: the neutral `RunEvent`, built by the driver because
 * only it knows what its protocol's event means.
 */
export type RunDraft = Omit<RunEvent, 'seq' | 'ts'>;

/** The environment an `init` describes, before the manager adds where and for which chat. */
export type EnvironmentDetails = Omit<EffectiveEnvironment, 'cwd' | 'chatId' | 'observedAt'>;

/** Internal to core: richer than `RunEvent`, and neutral. The manager folds them into `LiveChat`. */
export type DriverEvent =
  | {
      kind: 'init';
      sessionId: string | null;
      /** The id the agent itself gave the session; a driver that imposes the id leaves it out, and `sessionId` is the native one */
      nativeSessionId?: string | null;
      model: string | null;
      permissionMode: PermissionMode | null;
      cwd: string | null;
      environment: EnvironmentDetails;
      run: RunDraft;
    }
  | { kind: 'mode-changed'; mode: PermissionMode }
  /** The agent is summarising the conversation (`active`), or has stopped doing so, whichever way it ended */
  | { kind: 'compacting'; active: boolean }
  /** The agent's marker of a compaction, as the transcript will hold it; the figures are its own, null where it gave none */
  | {
      kind: 'compacted';
      entry: TranscriptEntry;
      uuid: string | null;
      trigger: 'manual' | 'auto' | null;
      preTokens: number | null;
      postTokens: number | null;
      durationMs: number | null;
      run: RunDraft;
    }
  /** The agent said a compaction failed, with its own words when it gave any */
  | { kind: 'compact-failed'; error: string | null }
  | { kind: 'message'; entry: TranscriptEntry; mainAgent: boolean; stopReason?: string; run: RunDraft }
  | {
      kind: 'block-started';
      /** The block as the agent described it, for the activity ticker */
      block: { type?: unknown; id?: unknown; name?: unknown };
      /** What streams as text; `other` for a tool call and the like */
      streams: 'text' | 'thinking' | 'other';
      /** Its input is the structured result the session was asked for */
      structured: boolean;
    }
  | { kind: 'delta'; block: 'text' | 'thinking'; text: string }
  | { kind: 'structured-delta'; json: string }
  | { kind: 'block-stopped' }
  | { kind: 'stop-reason'; reason: string }
  | { kind: 'heartbeat'; toolUseId: string | null; elapsedSeconds: number | null }
  | { kind: 'command-started'; toolUseId: string; command: string }
  | { kind: 'command-ended'; toolUseId: string; isError: boolean }
  | { kind: 'task'; run: RunDraft }
  /** The session cannot go on: the execution fails with `reason` (`auth-required: …`, `protocol: …`) and the process is stopped */
  | { kind: 'failed'; reason: string }
  | { kind: 'rate-limit'; info: RateLimitInfo }
  | { kind: 'permission-request'; question: PermissionQuestion }
  | { kind: 'permission-withdrawn'; id: string }
  /** The agent took these messages, by the id each was sent with: into the running turn or as a turn of its own */
  | { kind: 'delivered'; ids: string[] }
  | {
      kind: 'result';
      isError: boolean;
      text: string;
      /** What a failed result is recorded as: its text, or the kind of failure when there is none */
      failure: string;
      turns: number;
      costUsd?: number;
      modelUsage: ModelUsage[];
      structuredOutput: unknown;
      stopReason?: string;
      /** The agent ended the turn because the budget ran out */
      budget: boolean;
      /** The failure was the account's rate limit, as the agent reports it in data (Claude's 429), never as its wording reads */
      rateLimited: boolean;
      /** The failure was the account's sign-in (Claude's 401), as the agent reports it in data; absent when it was not */
      authFailed?: boolean;
      run: RunDraft;
    }
  | { kind: 'stderr'; text: string }
  /** The guard's `SessionStart` marker arrived: its hooks run, and the first message may be written */
  | { kind: 'guard-armed' }
  /** The guard blocked, observed or let through once a tool call, or failed and so blocked it; a pass produces nothing */
  | { kind: 'guard'; guard: RunGuardEvent; run: RunDraft }
  /** A tool call was answered without the guard having spoken for it: the call already ran */
  | { kind: 'guard-missing'; guard: RunGuardEvent; run: RunDraft }
  /** Claudio's own words about something the agent did that the person may want to see, with no change of status */
  | { kind: 'notice'; text: string }
  /** A stdout line that is not the protocol */
  | { kind: 'unreadable'; text: string };
