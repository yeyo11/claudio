import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { systemTempDirs } from './temp-dirs.ts';
import type {
  ClaudioLanguage,
  AuthVerification,
  ClaudioReleaseInfo,
  TrackerId,
  CliVersionInfo,
  LiveWork,
  StorageReport,
  ProcessUsageReport,
  SystemSample,
  SystemLoad,
  ProviderLimit,
  ChatProject,
  ChatSummary,
  ChatWorktree,
  ConfigFileRoot,
  ModelOption,
  CreateProjectRequest,
  FlowRun,
  FlowRunPage,
  FlowSpendPass,
  FlowStartWaitingResult,
  FlowWaiting,
  FlowRunQuery,
  ImportProjectRequest,
  MemoryFile,
  MemoryProjectSummary,
  Overview,
  Account,
  AccountInUse,
  AccountsRefreshResult,
  AccountsSnapshot,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  Project,
  ProjectCandidate,
  ProjectChange,
  ProjectModule,
  ProjectSettings,
  ProjectTeamMember,
  ProjectTemplate,
  ProjectWorktree,
  RunWorkflowRequest,
  SetupState,
  SetupTool,
  SystemInfo,
  UpdateProjectRequest,
  Board,
  CreateWorkItemFromMessageRequest,
  CreateWorkItemLinkRequest,
  Milestone,
  OrchestrateWorkItemsRequest,
  Orchestration,
  OrchestrationSpec,
  OrchestrationTimings,
  ReviewGateDetail,
  ReviewRoleInfo,
  ReviewRound,
  RelaunchOrchestrationRequest,
  WorkflowDefinition,
  WorkItem,
  WorkItemRef,
  WorkItemCause,
  WorkItemChanges,
  WorkItemDetail,
  WorkItemHistoryEntry,
  WorkItemHistoryValue,
  WorkItemFilter,
  WorkItemPage,
  WorkItemPageQuery,
  BoardQuery,
  WorkItemLink,
  WorkItemOrchestrationDraft,
  WorkOnWorkItemRequest,
  WorkOnWorkItemResult,
  FileDiff,
} from '@claudio/shared';
import { CLAUDIO_LANGUAGES, claudioLanguage, DEFAULT_ASSISTANT_MODEL, isEffort, type ClaudioAssistantMarker, type DecisionRecord, type Effort, type GuardStatus, type LessonList, type LessonSettings, type LessonStatus, type LimitWait, type ProjectCodeHost, type ProviderId, type RunGuardEvent, type ToolPolicy } from '@claudio/shared';
import { LEGACY_PROVIDER } from './chat-records.ts';
import { effortOption, resolveEffort, usedEffort } from './effort.ts';
import { rulesOnDriver } from './tool-policy.ts';
import pkg from '../package.json' with { type: 'json' };
import { AccountStore, DEFAULT_ID, readCache } from '@claudio/accounts';
import { ProviderRotation, openWaitOf } from './rotation.ts';
import type { ChatWork } from './chat-service.ts';
import { AppSettingsStore } from './app-settings.ts';
import { GuardLauncher } from './guards/launch.ts';
import type { ChatGuardPlan } from './live-chat.ts';
import { GuardSettingsStore } from './guards/settings.ts';
import { GuardEventStore } from './guards/events.ts';
import { SpendGate } from './spend.ts';
import { DashboardLayoutStore } from './dashboard-layouts.ts';
import { stateFromRun } from './chat-model.ts';
import { chatLinkName, WorkItemError, WorkItemService, type WorkItemLinkState } from './work-items.ts';
import { DEFAULT_DOCUMENTS_PATH, DocumentError, DocumentService, type DocumentsPlace } from './documents.ts';
import { documentsLine, ItemDocumentsError, syncItemDocuments, withDocumentsLine } from './item-documents.ts';
import { canBranch, existingItemWorktree, itemWorktree, orchestrationDraft, startOptions, titleFromMessage, WORK_CAUSE, WorkItemAutomation, workItemPrompt } from './work-links.ts';
import { TunnelManager } from './tunnel.ts';
import { ContextControl } from './context-control.ts';
import { ChatNotes } from './context-notes.ts';
import { ChatService, ChatStartError, type Placement } from './chat-service.ts';
import { ChatManager, type ChatConfinement, type ChatRuntime, type RunResult } from './chats.ts';
import { Connectors } from './connectors.ts';
import { ProjectDocsError, ProjectDocsService } from './project-docs.ts';
import type { TranscriptSummary } from './cli-facts.ts';
import { detectCli, execCli, getAuthStatus, type CliAuth } from './cli.ts';
import { CliVersionWatch } from './cli-version.ts';
import { ReleaseWatch } from './release-watch.ts';
import { ServerUpdates } from './updates/server-update.ts';
import { CliInstaller } from './updates/cli-install.ts';
import { claudeCodeManifest } from './providers/claude-code/manifest.ts';
import { storageReport } from './storage.ts';
import { ConfigExplorer } from './config/explorer.ts';
import { SettingsFiles } from './config/files.ts';
import { ChangeWatcher } from './change-watcher.ts';
import { Changes, type ChangeScope, type DiffOptions } from './changes.ts';
import { CredentialStore, type StoredCredentials } from './credentials.ts';
import { childEnv, useVaultForChildren } from './child-env.ts';
import { SecretVault } from './secret-vault.ts';
import { LoginService } from './setup/logins.ts';
import { setupMethods } from './setup/methods.ts';
import { CollabStore, Db } from './db.ts';
import { CollaboratorsService, collabHostSettings } from './collab/index.ts';
import type { AgentReadChat, AgentReadDecision } from './collab/agent-access.ts';
import { liveChatsOf } from './collab/readers.ts';
import { ChatUploads } from './chat-uploads.ts';
import { HealthMonitor, HealthService } from './health-service.ts';
import { permissionEvents, runRef, runRefOr, SessionsWatcher } from './event-sources.ts';
import { EventBus } from './events.ts';
import type { ProviderDriver, SessionInit } from './providers/driver.ts';
import { ClaudeCodeDriver } from './providers/claude-code/driver.ts';
import { CodeHostDetector } from './hosts/detector.ts';
import { CodeHostsSettingsStore } from './hosts/settings.ts';
import { TrackersSettingsStore } from './trackers/settings.ts';
import { TrackerError, TrackerImportService, type TrackerAccess } from './trackers/import.ts';
import { TrackerSyncService } from './trackers/sync.ts';
import { TrackerDetector } from './trackers/detector.ts';
import { YoutrackCredentialStore } from './trackers/youtrack/credentials.ts';
import { runHostCall } from './hosts/exec.ts';
import { ChildProcesses } from './child-processes.ts';
import { youtrackIssueUrl } from './trackers/youtrack/adapter.ts';
import { ProviderDetector } from './providers/detector.ts';
import { PROVIDER_MANIFESTS, ProviderRegistry } from './providers/registry.ts';
import { ProvidersSettingsStore } from './providers/settings.ts';
import { Locator } from './locations.ts';
import { PermissionBroker } from './permissions.ts';
import { PushService, riskLine } from './push.ts';
import { claudioMcp, claudioMcpSync, collabMcpSync, assistantChatOptions, type ClaudioMcpLaunch, type AssistantChatOptions, type CollabMcpLaunch } from './claudio-mcp.ts';
import { claudioAssistantPrompt } from './claudio-assistant-prompt.ts';
import { ChatTools, ToolPresetStore } from './chat-tools.ts';
import { McpConfig } from './config/mcp.ts';
import { ConfigResources } from './config/resources.ts';
import { projectScope, userScope, type ConfigScope } from './config/scope.ts';
import { Plugins } from './plugins.ts';
import { UploadStore } from './uploads.ts';
import { MemoryStore } from './memory.ts';
import { JournalService } from './journal.ts';
import { EMPTY_SECTION, type LessonSection } from './lessons/render.ts';
import { PASTED_NOTE } from './prompt-rules.ts';
import { LessonService } from './lessons/service.ts';
import { LessonStore } from './lessons/store.ts';
import { MemoryProposalService } from './memory-proposals.ts';
import { ReviewStore } from './review-store.ts';
import { DEFAULT_ROLE_BODIES, readRole, REVIEW_ROLES, roleFileName, type ReviewRole } from './review-roles.ts';
import { Orchestrator, PUSH_DENIED, validateEffort } from './orchestrator.ts';
import { orchestrationTimings } from './orchestration-timings.ts';
import { loadConfig, type CoreConfig } from './paths.ts';
import { admissionLimitsFrom, chatProcessUsage, readSystemLoad } from './system-load.ts';
import { samplerSettingsFrom, SystemSampler } from './system-history.ts';
import { recentProcessTable } from './processes.ts';
import { byStart, EXPORTED_ORIGINS, type ProjectExportSource } from './project-export.ts';
import { parseKeyPrefix, parseModules, parseProjectSettings, parseProjectSetup, ProjectSettingsStore, settingsChanges } from './project-settings.ts';
import { PROJECT_TEMPLATES } from './project-templates.ts';
import { attachProject, projectCandidates, ProjectStore, type ChatPlace, type ProjectRecord } from './projects.ts';
import { AuthStore } from './security/auth.ts';
import { recognizeSecrets } from './decisions/redact.ts';
import { Scheduler, spendHeldReason } from './schedules.ts';
import { SessionStore } from './sessions.ts';
import { agentsDefinitionFile } from './agents-file.ts';
import { EvalConsents, EvalDefinitionStore, EvalFileError, evalTargetPath } from './evals/definition.ts';
import { EvalJudge } from './evals/judge.ts';
import { EvalRunner } from './evals/runner.ts';
import { EvalService } from './evals/service.ts';
import { EvalStore } from './evals/store.ts';
import { TeamService } from './team.ts';
import { FlowError, FlowService, stagePolicy, type FlowLaunch } from './flow.ts';
import { ChangeRequestService } from './change-requests.ts';
import { ChecksService } from './hosts/checks-service.ts';
import { MergeService, type MergeTarget } from './hosts/merge-service.ts';
import { mergeTargetOf } from './hosts/merge-target.ts';
import { ReviewsService } from './hosts/reviews-service.ts';
import { WebhookStore } from './webhook-store.ts';
import { WebhookSecrets } from './hosts/webhook-secrets.ts';
import { WebhookReceiver } from './hosts/webhook-receiver.ts';
import { WebhooksService } from './hosts/webhooks-service.ts';
import { OrchestrationPullRequestService } from './orchestration-pull-requests.ts';
import { codeHostAdapter, PullRequestService, PullRequestWatcher, type ApproveResult } from './pull-requests.ts';
import { AssistantError, AssistantService, type AssistantKnown, type AssistantLaunch, type AssistantProject } from './assistant.ts';
import { assistantGit } from './assistant-sources.ts';
import { git, gitAsyncText, isGitRepo, isGitRepoAsync, mainCheckout } from './git.ts';
import { hostOf } from './work-item-rows.ts';
import { DecisionEngine } from './decisions/engine.ts';
import { LessonMiningQueue } from './lessons/queue.ts';
import { runMiner } from './lessons/miner.ts';
import { DEFAULT_LESSON_SETTINGS, LessonSettingsStore } from './lessons/settings.ts';
import { SignalRecorder } from './lessons/signals.ts';
import { ChecksFix } from './decisions/checks-fix.ts';
import { IssueTriage } from './decisions/issue-triage.ts';
import { ReviewTriage } from './decisions/review-triage.ts';
import { DecisionResolvers } from './decisions/resolve.ts';
import { CliDecisionProvider, decisionRoute } from './decisions/providers/cli.ts';
import { accountsAtLimit } from './accounts-at-limit.ts';
import { JevProvider } from './decisions/providers/jev.ts';
import { DecisionCredentialStore, DecisionSettingsStore, ModelFallbackStore } from './decisions/settings.ts';
import { DEFAULT_SUPERVISOR_PRESET, Supervisor, type SupervisorAnswer, type SupervisorQuestion } from './supervisor.ts';
export {
  DecisionEngine,
  DEADLINE_MS,
  lowestConfidence,
  type DecisionEngineDeps,
  type DecisionOutcome,
  type DecisionProvider,
  type DecisionRequest,
  type EffectiveDecision,
  type ProviderResult,
} from './decisions/engine.ts';
export { CliDecisionProvider, decisionPrompt, decisionSchema, parseAnswers as parseDecisionAnswers } from './decisions/providers/cli.ts';
export { DECISION_POINTS, decisionPoint, type DecisionPointDefinition, type DecisionSubject } from './decisions/points.ts';
export { cutToBytes, maskSecrets, recognizeSecrets, redactState, SECRET_MASK, stateBytes, type SecretRecognizer } from './decisions/redact.ts';
export {
  DecisionCredentialStore,
  DecisionSettingsStore,
  ModelFallbackStore,
  DEFAULT_DECISION_SETTINGS,
  parseDecisionSettings,
  parseProjectDecisions,
} from './decisions/settings.ts';
import { listWorkflowDefinitions } from './workflows.ts';
import { encodeProjectId, Workspace } from './workspace.ts';
import { TerminalService } from './terminals/service.ts';
import { TerminalSettingsStore } from './terminals/settings.ts';
import { TerminalStore } from './terminals/store.ts';

export { parseMcpScope } from './config/mcp.ts';
export { DEFAULT_TOOL_PRESETS } from './chat-tools.ts';
export { MCP_ENTRY_ENV, type ClaudioMcpLaunch } from './claudio-mcp.ts';
export { TerminalService, type TerminalClient, type TerminalConnection } from './terminals/service.ts';
export { TerminalError, type TerminalErrorCode } from './terminals/errors.ts';
export type { PeerVerdict } from './terminals/peer.ts';
export { RESOURCE_KINDS } from './config/resources.ts';
export { parseVariant, type ConfigScope } from './config/scope.ts';
export { acquireDataDirLock, DataDirLockedError, DATA_DIR_LOCK_FILE, readDataDirLock, type DataDirLock, type DataDirLockHolder } from './data-dir-lock.ts';
export { APP_SETTING_ENV, DEFAULT_APP_SETTINGS, dataDirFrom, loadConfig, PROVIDER_HOME_ENV, type AuthEnv, type CoreConfig } from './paths.ts';
export { LoginInputError, LoginRefusedError, LoginService } from './setup/logins.ts';
export { SecretVault } from './secret-vault.ts';
export { CollaboratorsError, CollaboratorsService, type CollaboratorsErrorCode } from './collab/index.ts';
export { AGENT_READ_MODES, agentReadScope, copyInScope, type AgentReadChat, type AgentReadDecision, type AgentReadRefusal } from './collab/agent-access.ts';
export { DashboardLayoutStore } from './dashboard-layouts.ts';
export { GuardSettingsStore, defaultGuardSettings, parseGuardOverride, parseGuardSettingsUpdate } from './guards/settings.ts';
export { type GuardEvent, type GuardLaunch, findUnsafePath, guardCommand, shellQuote } from './guards/command.ts';
export { type GuardFiles, startGuardSweep, sweepGuardFiles, writeGuardFiles } from './guards/files.ts';
export {
  GUARD_ENTRY_ENV,
  GuardPreflight,
  GuardUnavailableError,
  type GuardUnavailableCode,
  type PreflightInput,
  checkGuardPreflight,
  runGuardSelfTest,
} from './guards/preflight.ts';
export { type GuardRequest, GuardLauncher, guardFailure } from './guards/launch.ts';
export { GuardEventStore, type GuardEventFilter } from './guards/events.ts';
export { decide as decideGuard } from './guards/decide.ts';
export { DEFAULT_LIMITS as GUARD_DEFAULT_LIMITS, type GuardRulesFile } from './guards/input.ts';
export { guardsWeakened, projectGuardsWeakened, resolveGuards, type GuardResolveContext, type GuardRunKind, type ResolvedGuards } from './guards/resolve.ts';
export { AppSettingsStore, RuntimeHosts, type RunDefaults, type RuntimeHostOptions } from './app-settings.ts';
export { DEFAULT_TUNNEL_PORT, MIN_TAILSCALE_VERSION, TunnelManager, TunnelRefusedError, parseTailscaleVersion, readinessFromStatus, servePortUse, type ServePortUse, type TunnelDeps, type TunnelTiming } from './tunnel.ts';
export type { AdoptedChat, ChatRuntime, NewChat, RunResult } from './chats.ts';
export { AccountSwitchRefusal, ChatRefusal } from './chats.ts';
export { ReviewStoreError } from './review-store.ts';
export { REVIEW_ROLES, type ReviewRole } from './review-roles.ts';
export { ChatConflictError, ChatStartError, DEFAULT_ORIGINS, startFailure, type ChatFilter, type Placement } from './chat-service.ts';
export { summarizeOrchestration } from './orchestrator.ts';
export { compareVersions } from './version-check.ts';
export { ReleaseWatch, type ReleaseWatchOptions, type ReleaseAsset } from './release-watch.ts';
export { ServerUpdates, ServerUpdateRefusal, type ServerUpdatesOptions } from './updates/server-update.ts';
export { CliInstaller, CliInstallRefusal, type CliInstallerOptions } from './updates/cli-install.ts';
export { RESTART_EXIT_CODE } from './launcher/protocol.ts';
export { ProviderRotation, RunNowRefusal, effectiveOnLimit, openWaitOf } from './rotation.ts';
export { EvalService } from './evals/service.ts';
export { EvalStartError } from './evals/runner.ts';
export { EvalFileError } from './evals/definition.ts';
export { exportRun, type EvalExportFormat } from './evals/export.ts';
export { stanceOf } from './decisions/stance.ts';

export {
  chatControl,
  chatState,
  executionOutcome,
  sessionHolder,
  stateFromCliAgent,
  stateFromRun,
  type CliAgentFacts,
  type ControlFacts,
  type RunFacts,
  type SessionHolder,
} from './chat-model.ts';
export { addTokenUsage, emptyTokenUsage, foldUsage, UsageFold, type ContextSnapshot } from './usage.ts';
export { usageReport, type ChatSpend, type DayRange } from './usage-report.ts';
export { orchestrationTimings, type TimingsChat } from './orchestration-timings.ts';
export { chatRole } from './chat-service.ts';
export { CONTEXT_USAGE_CACHE_MS, ContextControl, type CompactAndWaitOptions } from './context-control.ts';
export { ChatNotes, compactText, ContextRefusal, NOTE_REQUEST_PROMPT, parseSessionNote, SESSION_NOTE_INSTRUCTIONS, TYPED_COMPACT } from './context-notes.ts';
export { usageBreakdown, usageSeries } from './usage-series.ts';
export { parseChangeScope, parseDiffContext, type ChangeScope, type DiffOptions } from './changes.ts';
export { chatToMarkdown, exportFilename } from './chat-export.ts';
export { deriveKeyPrefix, parseProjectSettings, parseProjectSetup } from './project-settings.ts';
export { PROJECT_TEMPLATES } from './project-templates.ts';
export { agentFileContent, RECORDS_IN_ENGLISH, roleTitleIn, TeamError, TeamService, templateOptionalTeam, templateTeam, type TeamRunSource } from './team.ts';
export {
  ASSISTANT_ERRORS,
  AssistantError,
  AssistantService,
  DENIED_TOOLS,
  memberFile,
  READ_EVENT_MS,
  READ_ONLY_TOOLS,
  type AssistantChatResult,
  type AssistantDeps,
  type AssistantKnown,
  type AssistantLaunch,
  type AssistantProject,
} from './assistant.ts';
export { ProjectDocsError, ProjectDocsService, ProjectDocsStore, mcpServerPrefix, parseDocUrl, type DocsRuntime } from './project-docs.ts';
export { assistantLanguage, assistantPrompt, assistantSchema, assistantTitle, parseAnswer, type AssistantAnswer, type AssistantBrief, type AssistantGit, type AssistantLanguage } from './assistant-answer.ts';
export {
  FLOW_CAUSE,
  FlowError,
  flowPrompt,
  flowTitle,
  flowResultSchema,
  FlowService,
  parseFlowRunQuery,
  parseResult,
  stageRules,
  testCommandRules,
  testCommands,
  checkCommandRules,
  type CheckCommand,
  type FlowChatResult,
  type FlowDeps,
  type FlowLaunch,
  type FlowProject,
  type FlowRules,
} from './flow.ts';
export {
  ciOf,
  codeHostAdapter,
  PullRequestError,
  PullRequestService,
  PullRequestWatcher,
  pullRequestBody,
  pullRequestTitle,
  type WatchSource,
  type ApproveResult,
  type PullRequestDeps,
} from './pull-requests.ts';
export { ChangeRequestError, type ChangeRequestFix } from './change-requests.ts';
export { TrackerError, quotedSource } from './trackers/import.ts';
export { WebhooksError } from './hosts/webhooks-service.ts';
export { MergeError, type MergeOutcome, type UpdateOutcome } from './hosts/merge-service.ts';
export { OrchestrationPullRequestError, OrchestrationPullRequestService, type OpenedPullRequest } from './orchestration-pull-requests.ts';
export { projectExportFilename, projectToJson, projectToMarkdown, type ProjectExportSource } from './project-export.ts';
export { Db, type PushSubscriptionRecord } from './db.ts';
export {
  WorkItemError,
  WorkItemService,
  type WorkItemCommentContext,
  type WorkItemContext,
  type WorkItemLinkInput,
  type WorkItemLinkState,
  type WorkItemProject,
  type WorkItemServiceDeps,
} from './work-items.ts';
export { DEFAULT_DOCUMENTS_PATH, DOCUMENT_CONTENT_MAX, DocumentError, DocumentService, type DocumentServiceDeps, type DocumentsPlace, type TieOptions } from './documents.ts';
export { DocumentPathError } from './document-paths.ts';
export { orchestrationDraft, titleFromMessage, WORK_CAUSE, WorkItemAutomation, workItemPrompt, type WorkItemAutomationDeps } from './work-links.ts';
export { AuthStore, DESKTOP_ACTOR } from './security/auth.ts';
export { CHAT_TOKEN_MAX_AGE_MS, CHAT_TOKEN_PREFIX, ChatTokenStore, chatActor } from './security/chat-tokens.ts';
export { OidcVerifier, type FetchLike } from './security/oidc.ts';
export { hasRedacted, redactSecrets, restoreSecrets, SECRET_MAPS } from './security/redact.ts';
export { describeCron, nextFire, nextFires, parseCron } from './cron.ts';
export { previewCron, Scheduler, SLOT_GRACE_MS, type ScheduleLauncher } from './schedules.ts';
export { SpendGate, localDayOf, localDayWindow } from './spend.ts';
export { EventBus, type ClaudioEventInput, type Replay } from './events.ts';
export { PROVIDERS_TTL_MS, ProviderDetector, satisfiesRange, type ClaudeReading, type ProviderDetectorDeps } from './providers/detector.ts';
export { ProvidersSettingsStore, defaultProvidersSettings } from './providers/settings.ts';
export { PROVIDER_MANIFESTS, ProviderRegistry, type ProviderManifest } from './providers/registry.ts';
export { JOURNAL_HANDOFF_BYTES, JournalService, type JournalHandoff, type JournalWrite } from './journal.ts';
export { MemoryProposalService, type LessonApprovals, type ProposalOrigin } from './memory-proposals.ts';
export { LessonService, type MiningContext, type MiningResult } from './lessons/service.ts';
export { LessonStore } from './lessons/store.ts';
export {
  installDirs,
  nvmBinDirs,
  probeLoginShellPath,
  resolveCommand,
  resolveUserPath,
  SHELL_PATH_PROBE_ENV,
  type ShellPathFailure,
  type ShellPathResult,
} from './providers/path.ts';
export { idOfEndpoint, parseRegistration, payloadOf, PushService, truncateEndpoint, type PushTransport } from './push.ts';
export {
  Supervisor,
  supervisorModeOf,
  SupervisorConflictError,
  type ProposalOwner,
  type SupervisorAnswer,
  type SupervisorDeps,
  type SupervisorQuestion,
} from './supervisor.ts';

// Read from the package rather than written into this file: the release tooling then only edits
// package.json files, and never has to rewrite source to bump a version.
const CLAUDIO_VERSION = pkg.version;
const SYSTEM_TTL_MS = 30_000;
/** How often an idle account's usage cache is read again */
const ACCOUNTS_CACHE_MS = 5 * 60_000;
/** How long a check of the account in use is good for */
const ACCOUNT_CHECK_MS = 30 * 60_000;

/** A system read before the account in use is added to it, which is done on every answer */
type SystemRead = Omit<SystemInfo, 'uptimeSec' | 'models' | 'auth'> & { auth: CliAuth };

/** A session's directory: the worktree the CLI recorded when it ran in one, else where it started. */
const placeOf = (s: TranscriptSummary): ChatPlace => ({ cwd: s.worktree?.path ?? s.projectPath, updatedAt: s.updatedAt });

/** Facade wiring every core service together; the API layer only talks to this. */
export class Core {
  readonly config: CoreConfig;
  readonly db: Db;
  private readonly reviewStore: ReviewStore;
  /** Every change worth telling a client about; what `GET /api/events` streams */
  readonly events = new EventBus();
  /**
   * Which agents are on this machine and whether each is ready: one cache, one TTL, and
   * `providers.changed` when a status changes. Claude Code's reading is the system read below, so the
   * CLI is asked once for both.
   */
  readonly providers: ProviderDetector;
  /** Which providers are on, their order, the default and binary overrides (`providers.json`) */
  readonly providersSettings: ProvidersSettingsStore;
  /**
   * Which code host CLIs (`gh`, `glab`) are on this machine, who is signed in to which host, and
   * `hosts.changed` when a status changes. A project's readiness runs its own probes instead.
   */
  readonly hosts: CodeHostDetector;
  /** The probes and host calls this core started, ended and waited for by `shutdown` */
  private readonly children = new ChildProcesses();
  /** Which code hosts are on and a binary of the person's own (`hosts.json`) */
  readonly hostsSettings: CodeHostsSettingsStore;
  /** Which issue trackers are on and a binary of the person's own (`trackers.json`) */
  readonly trackersSettings: TrackersSettingsStore;
  /** Whether each issue tracker is ready: a host's tracker reads its host's CLI and sign-in */
  readonly trackers: TrackerDetector;
  /** The YouTrack instance and token `youtrack-app` is handed (`youtrack-credentials.json`, decision 3) */
  readonly youtrackCredentials: YoutrackCredentialStore;
  readonly permissions: PermissionBroker;
  /** Processes and live streams of the chats Claudio drives */
  readonly runtime: ChatManager;
  /** The chats the API serves: the transcript, the runtime and the CLI's own list, as one */
  readonly chats: ChatService;
  /** The chat's context window: its breakdown, Compact now and the rows of every compaction */
  readonly context: ContextControl;
  /** Session notes: the summary a compaction continued from, kept per chat */
  readonly notes: ChatNotes;
  readonly sessions: SessionStore;
  readonly orchestrator: Orchestrator;
  /** Today's spend against the daily cap: the start gate every automated unit of work asks (docs/plans/agent-run-improvements.md) */
  readonly spend: SpendGate;
  /** What a task, the integration branch or a chat has changed on disk */
  readonly changes: Changes;
  /** What a chat's health is read from: the calls it made, the history of how long commands take */
  readonly health: HealthService;
  private readonly healthMonitor: HealthMonitor;
  /** The optional model that drafts a hint when a worker's health turns bad; off unless the `supervisor.intervene` point says otherwise */
  readonly supervisor: Supervisor;
  /** The decision engine's settings (`decisions.json`) and its Jev key (`decision-credentials.json`, never returned) */
  readonly decisionSettings: DecisionSettingsStore;
  readonly modelFallbacks: ModelFallbackStore;
  readonly decisionCredentials: DecisionCredentialStore;
  /** The one door every decision point asks through; providers register themselves on it */
  readonly decisions: DecisionEngine;
  /** The `lesson_signals` rows a transcript cannot tell: a person's deny, a rewind, a rejected proposal */
  readonly lessonSignals: SignalRecorder;
  /** Turns a chat's corrections into lesson proposals, one miner run at a time (docs/plans/lessons.md, "Mining") */
  readonly lessonQueue: LessonMiningQueue;
  private readonly decisionResolvers: DecisionResolvers;
  readonly schedules: Scheduler;
  /** Web Push: the VAPID keypair, the installs registered to be woken, and the sender behind them */
  readonly push: PushService;
  readonly files: SettingsFiles;
  readonly explorer: ConfigExplorer;
  readonly plugins: Plugins;
  readonly memory: MemoryStore;
  readonly mcp: McpConfig;
  readonly toolPresets: ToolPresetStore;
  readonly connectors: Connectors;
  /** The Claude Docs each project knows, read and created through the Docs connector */
  readonly projectDocs: ProjectDocsService;
  readonly resources: ConfigResources;
  readonly credentials: CredentialStore;
  /** The first setup's sign-ins: a key or a device code per tool, one live session per tool and host */
  readonly logins: LoginService;
  /** `secrets.json`: what a CLI reads from its environment, sealed, handed to that CLI's processes only */
  readonly vault: SecretVault;
  private readonly releaseVault: () => void;
  /** How the API is guarded: the auth mode, the token hash and read-only */
  readonly security: AuthStore;
  /** The person's own shells: opened by them, never driven by an agent. See docs/plans/terminal.md */
  readonly terminals: TerminalService;
  /** Teammates' Claudios sharing projects read only, peer to peer (docs/plans/collaborators.md) */
  readonly collaborators: CollaboratorsService;
  /**
   * The settings that change at runtime (`app-settings.json` under the environment), and the exact
   * hosts answered beside the allowlist. What applies now is read here, never from `config`
   */
  readonly appSettings: AppSettingsStore;
  /** The global guard settings, `guards.json` (docs/plans/guards.md); the same store is `core.guards` */
  readonly guards: GuardSettingsStore;
  /** Resolves, checks and writes the guard of every launch path (docs/plans/guards.md) */
  readonly guardLauncher: GuardLauncher;
  /** The guards' audit trail, `guard_events` (docs/plans/guards.md) */
  readonly guardEvents: GuardEventStore;
  /** Each Home's layout, per project and for All projects: `dashboard-layouts.json` */
  readonly dashboardLayouts: DashboardLayoutStore;
  /** The tunnel through `tailscale serve`: lends the node's verified name to `appSettings.runtimeHosts` */
  readonly tunnel: TunnelManager;
  readonly uploads: UploadStore;
  /** Which uploads belong to each chat, kept as rows so it holds for a chat not loaded since the start */
  readonly chatUploads: ChatUploads;
  /** What happens when Claude reaches its limit: the account to move to, else the waits and the timers behind them */
  readonly rotation: ProviderRotation;
  /** The instruction evals: files, runs and their export (docs/plans/instruction-evals.md) */
  readonly evals: EvalService;
  /** The Claude accounts of this machine: one config dir each, chosen per process */
  readonly accounts: AccountStore;
  private accountsTimer: NodeJS.Timeout | null = null;
  private sampler: SystemSampler | null = null;
  /** Set by `shutdown`: what was still on its way when it ran must not start anything */
  private closed = false;
  /**
   * Settles once the chats of the last run are back and what waited for them has started (or, shut
   * down first, has not). Whoever ends a Core it just made awaits it after `shutdown`, so nothing of
   * the boot is left to touch the closed database.
   */
  readonly restored: Promise<void>;
  readonly cliVersion: CliVersionWatch;
  /** Whether a newer Claudio has been released: `release.json`, checked once a day */
  readonly release: ReleaseWatch;
  /** Claudio updating itself inside its container: signed bundles under /data/app (docs/plans/container-polish.md, D4) */
  readonly serverUpdates: ServerUpdates;
  /** Claude Code installed in-app inside the container, under /data/cli */
  readonly cliInstaller: CliInstaller;
  readonly workspace: Workspace;
  readonly locator = new Locator();
  private readonly projectStore: ProjectStore;
  /** What each project configures, one JSON document per project id, kept when the project is removed */
  private readonly projectSettingsStore: ProjectSettingsStore;
  /**
   * The work items of every project, kept in the shared database. Routes gate writes through
   * `workItemProject` and friends first: the store itself knows nothing of modules.
   */
  readonly workItems: WorkItemService;
  readonly documents: DocumentService;
  /** Moves items as the chats and nodes linked to them work, from the feed and the runtime's results */
  private readonly workLinks: WorkItemAutomation;
  /** Each project's team: its members' agent files plus the metadata in `settings.team` */
  readonly team: TeamService;
  /** Each project's journal: decisions, closed items and approved memory, handed to every flow run */
  readonly journal: JournalService;
  /** What the team proposes to remember, written to its target only once a person approves it */
  readonly memoryProposals: MemoryProposalService;
  readonly lessons: LessonService;
  /** `lessons.json`: read and changed through here so the queue and the service see the change at once */
  readonly lessonSettings: { get(): Promise<LessonSettings>; update(patch: unknown): Promise<LessonSettings> };
  /** The flow by column: a team member's run when a card enters the column its role answers for */
  readonly flow: FlowService;
  /** Approved items' pull requests: opened with git and gh on the person's request, and watched until merged */
  readonly pullRequests: PullRequestService;
  /** Import and link tracker issues: what the project's tracker routes call */
  readonly trackerImport: TrackerImportService;
  readonly trackerSync: TrackerSyncService;
  private readonly pullRequestWatcher: PullRequestWatcher;
  /** The `checks.fix` decision point: asked once per failing head of an item's change request; off unless the person turns it on */
  private checksFix: ChecksFix | null = null;
  /** The change requests of orchestrations' integration branches */
  readonly orchestrationPullRequests: OrchestrationPullRequestService;
  /** The checks of a change request: the head commit's list, log tails, re-runs and cancels */
  readonly checks: ChecksService;
  readonly reviews: ReviewsService;
  readonly webhooks: WebhookStore;
  /** The 0600 files that hold each registration's signing secret; never returned by the API */
  readonly webhookSecrets: WebhookSecrets;
  /** Takes Claudio's own secrets back out of the redaction, at shutdown */
  private readonly forgetSecrets: () => void;
  /** What `POST /webhooks/:host/:registrationId` calls: verify, dedupe, then move the named rows' next read to now */
  readonly webhookReceiver: WebhookReceiver;
  /** Registers, tests, removes and re-points the hooks Claudio keeps on a repository; the receiver reads their secrets from `webhookSecrets` itself */
  readonly webhookService: WebhooksService;
  /** Merge, auto-merge and update from the base of a change request: the person's click, never a run */
  readonly merge: MergeService;
  /** `/change-requests/:id/…`: a row id of either table, resolved to the service that owns it */
  readonly changeRequests: ChangeRequestService;
  /** The project assistant: read-only runs that propose a team, resources and work items, each accepted on its own */
  readonly assistant: AssistantService;
  private readonly startedAt = Date.now();
  /**
   * The person's language, as their panel last said it (`noteLanguage`): what the chats Claudio
   * starts on its own, with no request of the person's behind them, are titled in.
   */
  private language: ClaudioLanguage = 'en';
  private readonly sessionsWatcher: SessionsWatcher;
  private readonly changeWatcher: ChangeWatcher;
  private systemCache: { at: number; gen: number; value: SystemRead } | null = null;
  private systemPending: { gen: number; promise: Promise<SystemRead> } | null = null;
  private systemGen = 0;

  constructor(config: CoreConfig = loadConfig()) {
    this.config = config;
    // Before anything spawns a CLI: every child environment reads its credentials from here
    this.vault = new SecretVault(config);
    this.releaseVault = useVaultForChildren(this.vault);
    this.providersSettings = new ProvidersSettingsStore(config);
    // The detector and the runtime share the drivers, so the models a handshake lists reach the
    // driver a mapping is checked against (a move needs the target's catalog to know its model)
    const drivers = this.sessionDrivers(config);
    this.accounts = new AccountStore({
      dataDir: config.dataDir,
      defaultDir: config.configDir,
      claude: config.claudeBin,
      // What the CLI will see, the vault's credential included: a login with no file is still one
      defaultEnvCredential: () => {
        const env = childEnv('claude-code');
        return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY);
      },
    });
    this.providers = new ProviderDetector({
      processes: this.children,
      config,
      otherAccount: () => this.readyAccountLabel(),
      defaultExpired: () => this.accounts.list().find((a) => a.id === DEFAULT_ID)?.signInState === 'expired',
      accountsAtLimit: () => accountsAtLimit(this.accounts.list()),
      registry: new ProviderRegistry(PROVIDER_MANIFESTS, drivers),
      settings: () => this.providersSettings.get(),
      emit: (event) => this.events.emit(event),
      commandAliases: { 'claude-code': [config.claudeBin] },
      readClaude: async () => {
        const { cli, auth } = await this.system();
        // Beside the reading, never inside `/health`: a free check of the account in use, at most every 30 minutes
        this.checkAccountInUse();
        return { cli, auth };
      },
    });
    this.hostsSettings = new CodeHostsSettingsStore(config);
    this.trackersSettings = new TrackersSettingsStore(config);
    this.hosts = new CodeHostDetector({
      processes: this.children,
      adapter: codeHostAdapter,
      settings: () => this.hostsSettings.get(),
      emit: (event) => {
        // A CLI that was installed or signed in changes what every project's readiness says
        this.pullRequests.forgetReadiness();
        return this.events.emit(event);
      },
    });
    this.youtrackCredentials = new YoutrackCredentialStore(config, this.vault);
    this.trackers = new TrackerDetector({
      processes: this.children,
      hosts: this.hosts,
      adapter: codeHostAdapter,
      settings: () => this.trackersSettings.get(),
      youtrackCredentials: () => this.youtrackCredentials.get(),
    });
    this.db = new Db(config);
    this.reviewStore = new ReviewStore(this.db.connection);
    this.permissions = new PermissionBroker();
    this.credentials = new CredentialStore(config, this.vault);
    this.security = new AuthStore(config);
    if (this.security.environmentReset) {
      // A credential changed without a request, so the row is the only trace of who changed it
      this.db.appendAudit({
        at: this.security.environmentReset.at,
        actor: 'env',
        method: 'POST',
        path: '/api/security/token',
        status: 200,
        summary: 'Replace the token from CLAUDIO_AUTH_TOKEN (CLAUDIO_AUTH_TOKEN_RESET)',
      });
    }
    if (this.security.firstRunGenerated) {
      this.db.appendAudit({
        at: this.security.firstRunGenerated.at,
        actor: 'env',
        method: 'POST',
        path: '/api/security/token',
        status: 200,
        summary: 'Generate the first-run owner token',
      });
    }
    this.security.onFirstRunUsed = (at) =>
      this.db.appendAudit({ at, actor: 'token:first-run', method: 'POST', path: '/api/security/token', status: 200, summary: 'The first-run owner token was used for the first time' });
    this.guards = new GuardSettingsStore(config.dataDir, {
      onChange: (settings) => this.events.emit({ type: 'guards.changed', title: 'Guard settings changed', settings }),
    });
    this.guardEvents = new GuardEventStore(this.db.connection);
    this.appSettings = new AppSettingsStore(config, {
      emit: (event) => {
        // `system()` carries the default permission mode, and a cached copy would show the old one
        this.forgetSystem();
        this.events.emit(event);
      },
    });
    this.dashboardLayouts = new DashboardLayoutStore(config, {
      hasProject: async (id) => (await this.projects()).some((p) => p.id === id),
      emit: (event) => this.events.emit(event),
    });
    this.tunnel = new TunnelManager({
      dataDir: config.dataDir,
      tailscaleBin: config.tailscaleBin,
      port: config.tunnelPort,
      enabled: config.tunnelEnabled,
      managed: config.tailscaleManaged,
      security: this.security,
      hosts: this.appSettings.runtimeHosts,
      emit: (event) => this.events.emit(event),
      // What the tunnel does by itself; what a person asks for is audited by the API's own hook
      audit: (row) => this.db.appendAudit({ at: new Date().toISOString(), actor: 'claudio', status: 200, ...row }),
    });
    // The tunnel never outlives the guard: it is closed before the first unguarded request
    this.security.beforeUnguarded = async () => {
      await this.tunnel.stop('unguarded');
    };
    this.workspace = new Workspace(config);
    this.cliVersion = new CliVersionWatch(config);
    // Every check judges whether its release installs here, the daily one included (`serverUpdates.inspect`)
    this.release = new ReleaseWatch(config, { current: CLAUDIO_VERSION, events: this.events, onChecked: () => void this.serverUpdates.inspect() });
    const securityState = () => ({ mode: this.security.mode, readOnly: this.security.readOnly });
    this.serverUpdates = new ServerUpdates({
      dataDir: config.dataDir,
      distribution: config.distribution,
      running: CLAUDIO_VERSION,
      release: () => this.release.latestRelease(),
      security: securityState,
      liveWork: () => this.liveWork(),
      audit: (row) => this.db.appendAudit({ at: new Date().toISOString(), actor: 'claudio', status: 200, ...row }),
      events: this.events,
    });
    this.serverUpdates.auditRollback();
    // At start too, from the release the last check left: the card never offers what cannot install
    void this.serverUpdates.inspect();
    this.cliInstaller = new CliInstaller({
      dataDir: config.dataDir,
      distribution: config.distribution,
      range: claudeCodeManifest.versions.range ?? '',
      pinned: () => this.cliVersion.pinned,
      current: () => this.systemKnown()?.cli.version ?? null,
      latest: () => this.cliVersion.latest,
      security: securityState,
      changed: async () => {
        this.forgetSystem();
        await this.system(true);
      },
    });
    this.projectStore = new ProjectStore(config);
    this.projectSettingsStore = new ProjectSettingsStore(config);
    this.team = new TeamService({
      dataDir: config.dataDir,
      project: async (id) => {
        const record = this.requireProject(id);
        return { ...record, settings: await this.projectSettings(id) };
      },
      saveSettings: (id, settings) => this.saveTeamSettings(id, settings),
      emit: (event) => this.events.emit(event),
    });
    this.uploads = new UploadStore(config.dataDir);
    this.runtime = new ChatManager(config, this.db, drivers);
    // The detector was built before the runtime that keeps the limits: every status carries its limit from here on
    this.providers.useLimits(this.runtime.limits);
    // One store, so the token a chat's process is handed is the one the guard accepts
    this.runtime.chatTokens = this.security.chatTokens;
    this.runtime.defaults = this.appSettings;
    this.runtime.permissions = this.permissions;
    this.runtime.assistantLaunch = (marker) => this.assistantChatLaunch(marker);
    this.runtime.agentReadsLaunch = (chat) => this.agentReadsLaunch(chat);
    this.runtime.providerSettings = () => this.providersSettings.get();
    this.runtime.bus = this.events;
    this.runtime.accounts = this.accounts;
    this.runtime.projectOf = (dir) => this.projectOf(resolve(dir)).project?.id ?? null;
    this.watchAccounts();
    this.sampler = new SystemSampler(this.db, () => this.chats.livePids(), () => admissionLimitsFrom(), samplerSettingsFrom());
    this.sampler.start();
    this.sessionsWatcher = new SessionsWatcher(config.projectsDir, this.events, undefined, () => this.chats.holdersKey());
    this.runtime.uploads = this.uploads;
    // The UI watches a run's event stream, so the prompt has to arrive on it
    this.permissions.on('requested', (request: PermissionRequest) => {
      this.runtime.notice(request.runId, `Permission requested for ${request.toolName}`, { permission: request });
      for (const event of permissionEvents(request, this.runtime.get(request.runId))) this.events.emit(event);
    });
    this.permissions.on('resolved', (request: PermissionRequest, decision: PermissionDecision | null) => {
      const outcome = decision ? decision.behavior : 'withdrawn';
      this.events.emit({
        type: 'permission.resolved',
        title: `${request.toolName} ${outcome === 'withdrawn' ? 'was withdrawn' : outcome === 'allow' ? 'allowed' : 'denied'}`,
        ...runRefOr(request.runId, this.runtime.get(request.runId)),
        permissionId: request.id,
        toolName: request.toolName,
        outcome,
      });
      // S-denied: a deny a person wrote, kept for the lessons' pre-filter when the project allows it
      if (decision?.behavior === 'deny') {
        void this.chats
          .get(request.runId)
          .then((chat) => this.lessonSignals.denied(request, decision, { chatId: request.runId, projectId: chat?.project?.id ?? null }))
          .catch(() => undefined);
      }
    });
    // Hangs off the bus as an observer, so it hears every event without counting as a client
    this.push = new PushService({ config, db: this.db, events: this.events });
    this.sessions = new SessionStore(config);
    this.orchestrator = new Orchestrator(config, this.runtime, this.db);
    this.orchestrator.bus = this.events;
    this.guardLauncher = new GuardLauncher({
      dataDir: config.dataDir,
      settings: this.guards,
      capabilities: () => PROVIDER_MANIFESTS.find((m) => m.id === LEGACY_PROVIDER)?.capabilities ?? [],
    });
    this.orchestrator.guards = this.guardLauncher;
    // A broken guard is known before the first launch; the orchestrator's launches cannot wait for the self-test
    this.guardLauncher.warm();
    this.spend = new SpendGate({
      db: this.db,
      cap: () => this.appSettings.dailySpendCapUsd,
      waiting: () => ({ flowRuns: this.flow.queuedCount(), orchestrationTasks: this.orchestrator.waitingForSpend() }),
      passOf: (id) => this.orchestrator.spendPassOf(id),
      grant: (id, day) => this.orchestrator.grantSpendPass(id, day),
      itemPassOf: (id) => this.flow.spendPassOf(id),
      grantItem: (id, day) => this.flow.grantSpendPass(id, day),
    });
    this.orchestrator.spendOpen = (id) => this.spend.allows('orchestration', { orchestrationId: id });
    // A cap raised or cleared, a new day or a pass opens the gate: what waited for it starts, oldest first
    this.spend.onChange(() => {
      this.flow.dispatch();
      this.orchestrator.spendChanged();
      this.events.emit({ type: 'spend.changed', title: 'Daily spend changed', spend: this.spend.state() });
    });
    this.spend.onAlert((level, spend) => {
      this.events.emit({ type: 'spend.alert', title: level === 'exhausted' ? 'Daily spend cap reached' : `Daily spend at ${new Intl.NumberFormat('en', { style: 'percent' }).format(0.75)} of the cap`, level, spend });
    });
    this.appSettings.onSpendCapChange = () => this.spend.capChanged();
    this.runtime.on('spend-recorded', () => this.spend.recorded());
    this.spend.start();
    this.orchestrator.workflowRecords = (sessionId) => this.sessions.workflows(sessionId, true);
    this.orchestrator.workflowJournal = (sessionId, runId, from) => this.sessions.workflowJournal(sessionId, runId, from);
    this.mcp = new McpConfig(config);
    this.toolPresets = new ToolPresetStore(config);
    this.health = new HealthService(this.runtime, this.db);
    this.orchestrator.health = (task) => {
      const chat = task.runId ? this.runtime.get(task.runId) : null;
      const context = task.runId ? this.orchestrator.taskContext(task.runId) : null;
      if (!chat || !context) return null;
      return this.health.read(chat.id, {
        state: stateFromRun({ status: chat.status, pendingPrompts: chat.pendingPrompts }),
        lastEnded: null,
        context: null,
        failedBranches: 0,
        limits: context.limits,
        taskElapsedMs: context.elapsedMs,
        taskSpentUsd: context.spentUsd,
      });
    };
    this.decisionCredentials = new DecisionCredentialStore(config);
    this.decisionSettings = new DecisionSettingsStore(config, this.decisionCredentials);
    // Before anything reads the point: `supervisor.json` folds into `supervisor.intervene` once
    this.decisionSettings.migrateSupervisor();
    this.supervisor = new Supervisor({
      settings: this.decisionSettings,
      db: this.db,
      ask: (question) => this.askSupervisor(question),
      // A page is the newest entries, which is all the supervisor reads
      steps: async (chatId) => (await this.sessions.getSession(chatId, { limit: 60 }))?.entries ?? [],
      hint: async (proposal) => {
        if (proposal.orchestrationId && proposal.taskId) this.orchestrator.hintTask(proposal.orchestrationId, proposal.taskId, proposal.hint);
        else await this.chats.hint(proposal.chatId, { text: proposal.hint });
      },
      emit: (event) => this.events.emit(event),
      spendOpen: () => this.spend.allows('supervisor'),
      charge: (orchestrationId, costUsd) => this.orchestrator.chargeSupervisor(orchestrationId, costUsd),
      // The engine is built just below; a call only ever comes after the constructor
      decisions: { ask: (...args) => this.decisions.ask(...args), effective: (...args) => this.decisions.effective(...args) },
    });
    this.modelFallbacks = new ModelFallbackStore(config);
    this.decisions = new DecisionEngine({
      settings: this.decisionSettings,
      db: this.db,
      projectDecisions: (projectId) => this.projectSettingsStore.stored(projectId, this.projectStore.get(projectId)?.name)?.decisions ?? null,
    });
    this.decisions.register(
      new CliDecisionProvider({
        runtime: this.runtime,
        settings: this.decisionSettings,
        // A decision chat never waits: Claude Code answers, or says that every account is at its limit
        route: (cli) => decisionRoute(cli, this.accounts.list()),
        spendOpen: () => this.spend.allows('decision'),
      }),
    );
    // c6 left this wiring to the routes' worker: without it `jev` is never registered
    this.decisions.register(new JevProvider({ getKey: () => this.decisionCredentials.getKey() }));
    this.decisions.startPruning();
    this.lessonSignals = new SignalRecorder({ db: this.db, mode: (projectId) => this.decisions.effective('lesson.mine', projectId).mode });
    this.decisionResolvers = new DecisionResolvers({
      sql: this.db.connection,
      db: this.db,
      engine: this.decisions,
      historyDays: () => this.decisionSettings.get().historyDays,
      modelFallbacks: () => this.modelFallbacks.list(),
    });
    this.orchestrator.limitHeld = (chatId) => this.rotation.holds(chatId);
    this.orchestrator.waitOf = (chatId) => this.openWait(chatId);
    this.orchestrator.releaseWait = (chatId) => this.cancelWait(chatId);
    this.orchestrator.workflowLimit = (chatId, refusal) => this.runtime.limitReached(chatId, refusal);
    this.events.observe((event) => this.decisionResolvers.observe(event));
    this.decisionResolvers.start();
    this.orchestrator.decisions = this.decisions;
    this.orchestrator.projectOf = (cwd) => this.projectOf(resolve(cwd)).project?.id ?? null;
    this.push.decisions = this.decisions;
    this.push.recentRisk = (runId) => {
      const calls = this.runtime.trace(runId)?.calls;
      const chat = this.runtime.get(runId);
      if (!calls || !chat) return null;
      return riskLine(calls, { cwd: chat.workingDir, roots: [chat.cwd], tempDirs: systemTempDirs() });
    };
    this.health.decisions = this.decisions;
    this.healthMonitor = new HealthMonitor({
      runtime: this.runtime,
      health: this.health,
      emit: (event) => this.events.emit(event),
      taskOf: (chat) => this.orchestrator.taskContext(chat.id),
      onBad: (chat, task, signals) => void this.supervisor.wake(chat, task, signals),
    });
    this.healthMonitor.start();
    this.chats = new ChatService({
      health: this.health,
      config,
      runtime: this.runtime,
      tools: new ChatTools(config, this.mcp, this.toolPresets),
      sessions: this.sessions,
      orchestrator: this.orchestrator,
      place: (dir, recorded) => this.place(dir, recorded),
      environmentOf: (dir) => this.runtime.environments.get(dir),
      windowOf: (model) => this.db.modelWindow(model),
      memberChat: (chatId) => this.memberChat(chatId),
      guardsForChat: (cwd) => this.guardsForChat(cwd),
      compact: (chat) => this.context.availability(chat),
      teammateReads: (chatId) => {
        const decision = this.agentReadScope(chatId);
        return 'scope' in decision ? decision.scope : null;
      },
      typedCompact: (id, request) => this.context.sendTyped(id, request),
      transcriptRead: (id, entries) => this.context.sawEntries(id, entries),
      rewound: (chat, resumeSessionAt) => void this.lessonSignals.rewound({ chatId: chat.id, projectId: chat.project?.id ?? null }, resumeSessionAt),
    });
    this.notes = new ChatNotes({
      db: this.db,
      check: (chatId) => this.context.assertAvailable(chatId),
      turn: (chatId, text) => this.context.startTurn(chatId, text, 'note'),
      compactionEntries: (chatId) => this.chats.compactionEntries(chatId),
    });
    this.context = new ContextControl({
      db: this.db,
      runtime: this.runtime,
      chats: this.chats,
      flowOwns: (chatId) => this.flow.ownsChat(chatId),
      assistantOwns: (chatId) => this.assistant.workOf(chatId) !== null,
      limitHeld: (chatId) => this.rotation.holds(chatId),
      notes: this.notes,
      emit: (event) => this.events.emit(event),
    });
    this.changes = new Changes({
      orchestrator: this.orchestrator,
      chats: this.chats,
      sessions: this.sessions,
      runtime: this.runtime,
      decisions: this.decisions,
      // A chat on a work item works in the item's worktree, cut from the project's checkout
      forkedFrom: (chatId) => {
        const itemId = this.workItems.linksOfChat(chatId).find((l) => l.kind === 'chat' && l.role !== 'origin')?.itemId;
        const item = itemId ? this.workItems.find(itemId) : null;
        return item ? (this.projectStore.get(item.projectId)?.path ?? null) : null;
      },
    });
    // The CLI's list of sessions is kept a while; a process of ours that started or ended changes
    // what it says about that chat, and a stale one would read it as held by someone else
    this.events.observe((event) => {
      const started = event.type === 'run.updated' && event.status !== event.previousStatus && event.status === 'starting';
      if (started || event.type === 'run.created' || event.type === 'run.ended' || event.type === 'run.removed') this.chats.forgetHolders();
    });
    this.changeWatcher = new ChangeWatcher(this.orchestrator, this.events);
    this.changeWatcher.start();
    this.files = new SettingsFiles();
    this.explorer = new ConfigExplorer(config.configDir);
    this.plugins = new Plugins(config);
    this.memory = new MemoryStore(config);
    this.workItems = new WorkItemService({
      db: this.db,
      project: (id) => {
        const settings = this.projectSettingsStore.stored(id, this.projectStore.get(id)?.name);
        return settings ? { keyPrefix: settings.keyPrefix, columnLimits: settings.board.columnLimits } : null;
      },
      emit: (event) => this.events.emit(event),
      linkState: (link) => this.workItemLinkState(link),
      decisions: this.decisions,
    });
    this.documents = new DocumentService({
      items: this.workItems,
      place: (projectId, access) => this.documentsPlace(projectId, access),
      itemProject: async (itemId) => (await this.workItemAccess(itemId, 'write')).projectId,
      emit: (event) => this.events.emit(event),
    });
    this.workLinks = new WorkItemAutomation({
      items: this.workItems,
      writable: (id) => {
        const record = this.projectStore.get(id);
        return !!record && !!this.projectSettingsStore.stored(id, record.name)?.modules.includes('board');
      },
      orchestration: (id) => this.orchestrator.get(id),
      flowOwns: (chatId) => this.flow.ownsChat(chatId),
    });
    this.events.observe((event) => this.workLinks.observe(event));
    const itemRef = (id: string): WorkItemRef | null => {
      const item = this.workItems.find(id);
      return item ? { id: item.id, key: item.key, title: item.title, type: item.type, status: item.status } : null;
    };
    this.journal = new JournalService({
      db: this.db,
      emit: (event) => this.events.emit(event),
      item: itemRef,
      decisions: this.decisions,
      lessons: (projectId) => this.lessonSection(projectId, 'handoff'),
      sources: (id) =>
        this.workItems
          .links(id)
          .filter((l) => l.kind === 'chat' || l.kind === 'orchestration')
          .map((l) => ({ kind: l.kind === 'orchestration' ? 'orchestration' : 'chat', chatId: l.chatId, orchestrationId: l.orchestrationId, taskId: l.taskId })),
    });
    // Every process hears its own moves only, so an item closed here is journalled here, once
    this.events.observe((event) => this.journal.observe(event));
    this.memoryProposals = new MemoryProposalService({
      db: this.db,
      journal: this.journal,
      memory: this.memory,
      project: (id) => {
        const record = this.projectStore.get(id);
        return record ? { path: record.path, memoryKey: encodeProjectId(record.path) } : null;
      },
      emit: (event) => this.events.emit(event),
      item: itemRef,
      decisions: this.decisions,
      // Built further down; read when a rule is approved
      resources: () => this.resources,
    });
    // S-rejected-proposal: a rejection that says why, for the chat the proposal came from
    this.events.observe((event) => {
      if (event.type !== 'memory.proposal' || event.action !== 'rejected') return;
      const proposal = this.memoryProposals.find(event.proposalId);
      if (!proposal?.rejectReason || !proposal.source?.chatId) return;
      this.lessonSignals.rejectedProposal({ chatId: proposal.source.chatId, projectId: proposal.projectId }, proposal.rejectReason, `Proposal: ${proposal.text.slice(0, 200)}`);
      void this.lessonQueue.rejectedProposal(proposal.source.chatId);
    });
    // `lessons.json` is read asynchronously; the queue asks synchronously, so it reads a copy at most 10 s old
    const lessonSettingsFile = new LessonSettingsStore(config);
    let lessonSettings = DEFAULT_LESSON_SETTINGS;
    let lessonSettingsAt = 0;
    const currentLessonSettings = () => {
      if (Date.now() - lessonSettingsAt > 10_000) {
        lessonSettingsAt = Date.now();
        void lessonSettingsFile.get().then((read) => (lessonSettings = read), () => undefined);
      }
      return lessonSettings;
    };
    this.lessonSettings = {
      get: () => lessonSettingsFile.get(),
      update: async (patch) => {
        const next = await lessonSettingsFile.update(patch);
        lessonSettings = next;
        lessonSettingsAt = Date.now();
        this.lessons.invalidate();
        return next;
      },
    };
    const lessonStore = new LessonStore({ db: this.db, settings: currentLessonSettings });
    this.lessonQueue = new LessonMiningQueue({
      db: this.db,
      settings: currentLessonSettings,
      store: lessonStore,
      // The service is made below, and the queue proposes only once it runs a job, after start-up
      proposer: { propose: (request) => this.lessons.proposer().propose(request) },
      decisions: this.decisions,
      chat: async (chatId) => {
        const chat = await this.chats.get(chatId);
        if (!chat) return null;
        return {
          id: chat.id,
          projectId: chat.project?.id ?? null,
          origin: chat.origin,
          internal: chat.origin === 'internal',
          confined: false,
          assistant: !!chat.claudioAssistant,
          live: chat.alive && chat.state !== 'idle',
          driven: chat.origin === 'orchestration' || this.flow.ownsChat(chat.id),
        };
      },
      memoryOn: (projectId) => {
        const record = this.projectStore.get(projectId);
        return !!record && !!this.projectSettingsStore.stored(projectId, record.name)?.modules.includes('memory');
      },
      entries: async (chatId) => (await this.sessions.getSession(chatId, { limit: 1000 }))?.entries ?? [],
      corrections: (chatId) => this.sessions.corrections(chatId),
      rows: (chatId) => this.lessonSignals.forChat(chatId),
      instructions: async (projectId) => {
        const record = this.projectStore.get(projectId);
        const file = record ? join(record.path, 'CLAUDE.md') : null;
        return file && existsSync(file) ? await readFile(file, 'utf8') : null;
      },
      projectKey: (projectId) => this.projectStore.get(projectId)?.name ?? projectId,
      mine: (input, opts) => runMiner({ runtime: this.runtime, settings: currentLessonSettings }, input, opts),
      limitResetsAt: () => this.limitReadings().find((l) => l.resetsAt)?.resetsAt ?? null,
      emit: (event) => this.events.emit(event),
    });
    this.events.observe((event) => this.lessonQueue.observe(event));
    this.lessonQueue.start();
    this.lessons = new LessonService({
      store: lessonStore,
      proposals: this.memoryProposals,
      settings: currentLessonSettings,
      emit: (event) => this.events.emit(event),
    });
    this.events.observe((event) => {
      if (event.type === 'lesson.changed') this.lessons.invalidate();
    });
    this.runtime.lessonsFor = (projectId, orchestrated) => {
      const section = this.lessonSection(projectId, orchestrated ? 'worker' : 'chat');
      return section.text ? `${section.text}\n${PASTED_NOTE}` : '';
    };
    this.lessons.start();
    this.checks = new ChecksService({ db: this.db.connection, resolve: (id) => this.changeRequests.target(id), emit: (event) => this.events.emit(event) });
    this.webhooks = new WebhookStore(this.db.connection);
    this.webhookSecrets = new WebhookSecrets(config);
    this.logins = new LoginService({
      processes: this.children,
      vault: this.vault,
      youtrack: this.youtrackCredentials,
      emit: (event) => this.events.emit(event),
      binary: (tool) => this.setupBinary(tool),
      readiness: (tool, host) => this.setupReadiness(tool, host),
      refusal: (tool) => (tool === 'tailscale' ? this.tailscaleRefusal() : null),
      // A rule left in the daemon's Serve config would outlive the sign-out, and only Claudio would know it
      beforeSignOut: async (tool) => {
        if (tool === 'tailscale') await this.tunnel.stop();
      },
      tailscaleName: config.tailscaleHostname,
    });
    // Claudio's own secrets are masked in everything that may leave the machine (a decision's state,
    // a handoff), whatever text surrounds them
    this.forgetSecrets = recognizeSecrets({
      values: () => [this.decisionCredentials.getKey() ?? '', ...this.vault.values(), ...this.webhookSecrets.values()],
      isSecret: (word) => this.security.isOwnSecret(word),
    });
    this.webhookReceiver = new WebhookReceiver({
      store: this.webhooks,
      secrets: this.webhookSecrets,
      sql: this.db.connection,
      nudge: (ids) => this.nudgeChangeRequests(ids),
      emit: (event) => this.events.emit(event),
    });
    this.reviews = new ReviewsService({ db: this.db.connection, resolve: (id) => this.changeRequests.reviewsTarget(id), emit: (event) => this.events.emit(event) });
    this.merge = new MergeService({
      db: this.db.connection,
      resolve: (id) => this.mergeTarget(id),
      checks: async (id, refresh) => (await this.checks.list(id, refresh ? { refresh: true } : {})).checks,
      unresolvedThreads: async (id) => (await this.reviews.threads(id)).threads.filter((t) => !t.isResolved).length,
      emit: (event) => this.events.emit(event),
      // The row's own watcher reads the host and moves the item to Done as the person (`merged()`)
      merged: async (id) => {
        const kind = this.changeRequests.kindOf(id);
        if (kind === 'work-item') await this.pullRequests.check(id, true);
        else if (kind === 'orchestration') await this.orchestrationPullRequests.check(id, true);
      },
    });
    this.pullRequests = new PullRequestService({
      processes: this.children,
      db: this.db,
      checks: this.checks,
      reviews: this.reviews,
      merge: this.merge,
      flowOn: (projectId) => this.flow.projectFlow(projectId).enabled,
      settings: () => this.hostsSettings.get(),
      items: this.workItems,
      project: (id) => {
        const record = this.projectStore.get(id);
        return record ? { path: record.path } : null;
      },
      busy: (itemId) => this.itemBusy(itemId),
      onMerged: (notice) => this.trackerSync.merged(notice),
      // Built after the flow, which it reads: the watcher cannot announce a failing head before then
      onChecksFailing: (notice) => this.checksFix?.onChecksFailing(notice),
      verdicts: (itemId) => this.flow.verdicts(itemId),
      // A tracker that is off gets no closing word in a change request's body either
      projectTracker: (id) => {
        const tracker = this.projectSettingsStore.stored(id, this.projectStore.get(id)?.name)?.tracker ?? null;
        return tracker && this.trackerEnabled(tracker.id) ? tracker : null;
      },
      // The card's link is the address the person reaches the panel on: the tunnel when it is up
      webOrigin: () => {
        const tunnel = this.tunnel.status();
        return tunnel.state === 'active' && tunnel.url ? tunnel.url : (this.runtime.apiUrl?.replace(/\/api$/, '') ?? null);
      },
    });
    this.trackerImport = new TrackerImportService({
      items: this.workItems,
      project: (id) => {
        const record = this.projectStore.get(id);
        return record ? { path: record.path, tracker: this.projectSettingsStore.stored(id, record.name)?.tracker ?? null } : null;
      },
      access: (path, tracker) => this.trackerAccess(path, tracker),
      triage: new IssueTriage({ decisions: this.decisions, db: this.db }),
    });
    this.trackerSync = new TrackerSyncService({
      items: this.workItems,
      project: (id) => {
        const record = this.projectStore.get(id);
        return record ? { path: record.path, tracker: this.projectSettingsStore.stored(id, record.name)?.tracker ?? null } : null;
      },
      access: (path, tracker) => this.trackerAccess(path, tracker),
    });
    this.events.observe((event) => this.trackerSync.observe(event));
    // Links made before they recorded their repository read it from their project's tracker, once
    this.workItems.backfillIssueScopes((projectId, tracker) => {
      const settings = this.projectSettingsStore.stored(projectId, this.projectStore.get(projectId)?.name)?.tracker;
      return settings?.id === tracker ? settings.scope : null;
    });
    this.orchestrationPullRequests = new OrchestrationPullRequestService({
      processes: this.children,
      db: this.db,
      settings: () => this.hostsSettings.get(),
      codeHost: (path) => this.pullRequests.codeHost(path),
      emit: (event) => this.events.emit(event),
      checks: this.checks,
      reviews: this.reviews,
      merge: this.merge,
      runFix: (req) => this.orchestrator.runChecksFix(req),
    });
    this.changeRequests = new ChangeRequestService({
      db: this.db,
      checks: this.checks,
      reviews: this.reviews,
      merge: this.merge,
      pullRequests: this.pullRequests,
      orchestrationPullRequests: this.orchestrationPullRequests,
      orchestration: (id) => this.orchestrator.get(id),
      itemAccess: (itemId, access) => this.workItemAccess(itemId, access),
      triage: new ReviewTriage({ decisions: this.decisions }),
      viewed: (id) => this.pullRequestWatcher.view(id),
    });
    this.orchestrator.pullRequests = this.orchestrationPullRequests;
    this.webhookService = new WebhooksService({
      store: this.webhooks,
      secrets: this.webhookSecrets,
      target: async (projectId) => {
        const record = this.projectStore.get(projectId);
        if (!record) return null;
        const { readiness, remote } = await this.pullRequests.codeHost(record.path);
        return readiness.host && remote ? { host: readiness.host, hostname: remote.hostname, repoPath: remote.path } : null;
      },
      access: (projectId) => {
        const record = this.projectStore.get(projectId);
        if (!record) throw new Error('no such project');
        return this.pullRequests.hostAccess(record.path);
      },
      // The tunnel is tailnet-only (`tailscale serve`, never Funnel), so a code host on the internet
      // cannot deliver to it: no public origin, and polling carries the repositories alone
      publicUrl: () => null,
      emit: (event) => this.events.emit(event),
    });
    // `webhookService.observe` (re-pointing hooks at a new tunnel address) is not wired: the tunnel's
    // tailnet address is not one a code host can deliver to, so a hook must never be moved there
    // A healthy hook for a repository lets the pacer read its rows every 15 minutes instead of every two
    this.pullRequestWatcher = new PullRequestWatcher([this.pullRequests, this.orchestrationPullRequests], { signals: { webhookHealthy: (row) => this.webhookService.covers(row.url) } });
    this.events.observe((event) => this.pullRequests.observe(event));
    this.checksFix = new ChecksFix({
      decisions: this.decisions,
      sql: this.db.connection,
      checks: this.checks,
      pullRequests: this.pullRequests,
      item: (id) => this.workItems.find(id),
      // Claudio's own word on the card, not an agent's: the point only decides whether a fix may start by itself
      comment: (itemId, body) => void this.workItems.comment(itemId, { body }, { actor: { kind: 'system', role: null } }),
      project: (id) => {
        const record = this.projectStore.get(id);
        const settings = record ? this.projectSettingsStore.stored(id, record.name) : null;
        return record && settings ? { path: record.path, settings } : null;
      },
      spendOpen: () => this.spend.allows('flow'),
    });
    this.flow = new FlowService({
      db: this.db,
      spendOpen: (itemId) => this.spend.allows('flow', { itemId }),
      pullRequests: {
        conflictOf: (itemId) => this.pullRequests.conflictOf(itemId),
        settleConflict: (itemId) => this.pullRequests.settleConflict(itemId),
        verified: (itemId) => this.pullRequests.verified(itemId),
        awaitingVerify: (itemId) => this.pullRequests.awaitingVerify(itemId),
        fixPrompt: (itemId) => this.pullRequests.fixPrompt(itemId),
      },
      decisions: this.decisions,
      workDone: async (item) => {
        const path = this.projectStore.get(item.projectId)?.path;
        const summary = path ? await this.changes.itemChanges(path, item) : null;
        return summary ? { commits: summary.commits.map((c) => c.subject), paths: summary.files.map((f) => f.path) } : null;
      },
      items: this.workItems,
      project: (id) => {
        const record = this.projectStore.get(id);
        const settings = record ? this.projectSettingsStore.stored(id, record.name) : null;
        return record && settings ? { path: record.path, settings } : null;
      },
      handoff: async (id, topic) => (await this.journal.handoffFor(id, topic)).text,
      propose: (id, proposal, origin) => void this.memoryProposals.propose(id, proposal, origin),
      tie: async (itemId, document, options) => {
        await this.documents.tie(itemId, document, { ...options, requireFile: false });
      },
      launch: (launch, onStart) => this.launchFlowRun(launch, onStart),
      chatBusy: (chatId) => {
        const chat = this.runtime.get(chatId);
        return !!chat && stateFromRun({ status: chat.status, pendingPrompts: chat.pendingPrompts }) !== 'idle';
      },
      stop: (chatId) => {
        this.cancelWait(chatId);
        void this.runtime.stop(chatId);
      },
      activity: (chatId) => this.runtime.get(chatId)?.activity ?? null,
      delegates: (chatId) => this.runtime.get(chatId),
      language: () => this.language,
      limitHeld: (chatId) => this.rotation.holds(chatId),
      cost: (chatId) => this.runtime.get(chatId)?.costUsd ?? null,
      contextOf: async (chatId) => {
        const chat = await this.chats.get(chatId, { fresh: true });
        if (!chat) return null;
        const { used, window, compactedSince } = chat.context ?? { used: 0, window: null, compactedSince: undefined };
        const tokens = compactedSince?.postTokens ?? used;
        return {
          share: window ? tokens / window : null,
          usedTokens: tokens,
          window,
          compactable: !!chat.environment?.slashCommands.includes('compact') && !this.db.openCompaction(chatId),
        };
      },
      emit: (event) => this.events.emit(event),
    });
    this.team.runs = (projectId) => this.flow.runs(projectId);
    this.events.observe((event) => this.flow.observe(event));
    this.assistant = new AssistantService({
      db: this.db,
      items: this.workItems,
      project: (id) => this.assistantProject(id),
      known: (project) => this.assistantKnown(project),
      launch: (launch, onStart) => this.launchAssistantRun(launch, onStart),
      chatBusy: (chatId) => {
        const chat = this.runtime.get(chatId);
        return !!chat && stateFromRun({ status: chat.status, pendingPrompts: chat.pendingPrompts }) !== 'idle';
      },
      stop: (chatId) => {
        this.cancelWait(chatId);
        void this.runtime.stop(chatId);
      },
      limitHeld: (chatId) => this.rotation.holds(chatId),
      activity: (chatId) => this.runtime.get(chatId)?.activity ?? null,
      cost: (chatId) => this.runtime.get(chatId)?.costUsd ?? null,
      addMember: (project, member, content) => this.addAssistantMember(project, member, content),
      resourceExists: async (project, scope, kind, name) => (await this.resources.get(this.assistantScope(project, scope), kind, name)) !== null,
      saveResource: async (project, scope, kind, name, content) => {
        await this.resources.save(this.assistantScope(project, scope), kind, name, content);
      },
      evalFile: async (project, name) => {
        const file = await this.evals.file(project.id, name).catch((err: unknown) => {
          if (err instanceof EvalFileError && err.code === 'not-found') return null;
          throw err;
        });
        if (!file) return null;
        const target = file.definition?.target;
        const targetPath = target && target.scope === 'project' ? relative(project.path, evalTargetPath(target, project.path, config)).split(sep).join('/') : null;
        return { file, targetPath };
      },
      appendEvalCase: async (project, name, evalCase, ifMatch) => {
        await this.evals.appendCase(project.id, name, evalCase, ifMatch);
      },
      emit: (event) => this.events.emit(event),
      decisions: this.decisions,
    });
    this.events.observe((event) => this.assistant.observe(event));
    // Every result, not only a run's first: a chat worked on by hand ends many turns. The automation
    // hears it before the flow, which ends its run on it and so stops claiming the chat
    this.runtime.on('chat-result', (chatId: string, result: RunResult) => {
      // A compaction or a note turn is the chat's upkeep, not its work: no item moves and no run ends on it (D8)
      if (result.purpose) return;
      this.workLinks.chatResult(chatId, result);
      void this.flow.chatResult(chatId, result);
      this.assistant.chatResult(chatId, result);
    });
    // "Create with AI" shows the file while the chat writes it, from the result it is streaming
    this.runtime.on('chat-init', (provider: ProviderId, init: SessionInit) => {
      const driver = this.runtime.providers.driverFor(provider);
      if (!driver) return;
      const confirmation = driver.confirm(init);
      this.runtime.providers.confirm(provider, confirmation, new Date().toISOString());
      this.providers.confirm(provider, confirmation);
    });
    this.runtime.on('chat-structured', (chatId: string, raw: string) => this.assistant.chatStructured(chatId, raw));
    // Every verdict the guard gives a chat is a row of the audit trail (docs/plans/guards.md, D10):
    // Settings' Recent blocks and the "N blocked" chips of tasks and flow runs read nothing else
    this.runtime.on('chat-guard', (chatId: string, guard: RunGuardEvent) => this.recordGuard(chatId, guard));
    // The graphs a restart cut off go on in the chats it restores, so only once those are back
    // Started last of all, once the chats it may resume or start are restored, so a slot judged at
    // boot finds the runtime it launches into ready
    this.schedules = new Scheduler(config, {
      chat: (request) => this.chats.create({ ...request, purpose: 'schedule' }),
      orchestration: (spec) => this.orchestrator.create(spec),
      // A chat waiting on a person is still in its turn: it has not ended, whatever it waits for
      running: ({ chatId, orchestrationId }) => {
        if (chatId) {
          const chat = this.runtime.get(chatId);
          return !!chat && stateFromRun({ status: chat.status, pendingPrompts: chat.pendingPrompts }) !== 'idle';
        }
        return !!orchestrationId && this.orchestrator.get(orchestrationId)?.status === 'running';
      },
    });
    this.schedules.bus = this.events;
    // Over the daily cap a slot is skipped with its reason, never run late after midnight
    this.schedules.spendHold = () => {
      if (this.spend.allows('schedule')) return null;
      const state = this.spend.state();
      return spendHeldReason(state.spentUsd, state.capUsd ?? 0);
    };
    // A queued slot follows its predecessor as soon as it ends, not on the next tick. Not before the
    // chats are restored, though: until then a chat still going looks like one that ended
    let schedulesStarted = false;
    this.events.observe((event) => {
      if (!schedulesStarted) return;
      const ended =
        (event.type === 'run.updated' && event.status !== event.previousStatus) ||
        event.type === 'run.ended' ||
        event.type === 'run.removed' ||
        (event.type === 'orchestration.updated' && event.status !== 'running') ||
        event.type === 'orchestration.removed';
      if (ended) void this.schedules.drain().catch(() => undefined);
    });
    const restored = this.runtime.restore(this.sessions).finally(() => {
      // Shut down before the chats came back: nothing may start, and the database is closed. Started
      // anyway, the pull request watcher and the scheduler armed timers no shutdown would ever clear
      if (this.closed) return;
      this.orchestrator.recover();
      void this.evals.load().catch(() => undefined);
      try {
        this.flow.recover();
        // The waits this process owns: its chats are back, so their timers can be armed
        this.rotation.recover();
        // After the chats are back, so a merge moves an item nothing is about to resume on
        this.pullRequestWatcher.start();
      } catch {
        // Shut down before the chats came back: the database is closed, and nothing may start anyway
      }
      void this.assistant.recover().catch(() => undefined);
      this.schedules.start();
      schedulesStarted = true;
      // Every transcript is read once now rather than by whoever opens the first list, which
      // otherwise waits for seconds on a machine with hundreds of megabytes of them
      void this.sessions.listSessions().catch(() => undefined);
    });
    this.restored = restored.then(
      () => undefined,
      (error: unknown) => {
        if (!this.closed) console.warn(`restore: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    this.connectors = new Connectors(config, { account: () => this.accounts.ref(DEFAULT_ID) });
    this.projectDocs = new ProjectDocsService({ config, runtime: this.runtime, connectors: this.connectors });
    // A project's agent file is also a team member's: the team announces it, however it was written
    this.resources = new ConfigResources((change) => {
      if (change.kind !== 'agents' || change.scope.kind !== 'project') return;
      const path = change.scope.projectPath;
      for (const project of this.projectStore.list().filter((p) => p.path === path)) void this.team.agentFileChanged(project.id, change.name, change.action);
    });
    const evalStore = new EvalStore(this.db.connection);
    const evalDefinitions = new EvalDefinitionStore();
    const evalConsents = new EvalConsents(config);
    const evalProjectPath = (id: string): string | null => this.projectStore.get(id)?.path ?? null;
    const evalRunner = new EvalRunner({
      store: evalStore,
      runtime: this.runtime,
      config,
      consents: evalConsents,
      definitions: evalDefinitions,
      emit: (event) => this.events.emit(event),
      projectPath: evalProjectPath,
      maxConcurrentRuns: () => this.runtime.defaults.maxConcurrentRuns,
      // No judge while Phase 2 is off, and none past the daily cap: a judged check then ends `unjudged` and spends nothing
      judgeFor: (maxCostUsd) => (this.appSettings.evalsPhase2 ? new EvalJudge({ runtime: this.runtime, maxCostUsd, spendOpen: () => this.spend.allows('person') }) : null),
      memberRun: (projectId, agent, stage) => {
        const settings = this.projectSettingsStore.stored(projectId, this.projectStore.get(projectId)?.name);
        const member = settings?.team?.members.find((m) => m.agent === agent);
        if (!member) return null;
        const { permissionMode, policy } = stagePolicy(stage, member.writes, {
          documentsPath: settings?.documents?.path ?? DEFAULT_DOCUMENTS_PATH,
          checks: [],
          commands: member.commands,
        });
        return { permissionMode, policy, model: member.model };
      },
      // Null when an account can take a sample; else when the earliest of the ones that could resets
      availability: (_model, account) => {
        const now = Date.now();
        const ready = this.accounts.list().filter((a) => a.enabled && a.signedIn && (account === null || a.id === account));
        const out = (a: (typeof ready)[number]): boolean => a.limits?.state === 'exhausted' && (a.limits.resetsAt === null || Date.parse(a.limits.resetsAt) > now);
        if (ready.length === 0 || !ready.every(out)) return null;
        const resets = ready.flatMap((a) => (a.limits?.resetsAt ? [Date.parse(a.limits.resetsAt)] : []));
        return { waitUntil: resets.length === ready.length ? Math.min(...resets) : null };
      },
    });
    this.evals = new EvalService({ store: evalStore, runner: evalRunner, definitions: evalDefinitions, consents: evalConsents, projectPath: evalProjectPath,
      teamOn: (id) => this.projectSettingsStore.stored(id, this.projectStore.get(id)?.name)?.modules.includes('team') ?? false,
    });
    this.rotation = new ProviderRotation({
      db: this.db,
      evalSample: (chatId) => this.evals.isSample(chatId),
      runtime: this.runtime,
      settings: () => this.providersSettings.get(),
      projectProviders: (projectId) => this.projectSettingsStore.stored(projectId, this.projectStore.get(projectId)?.name)?.providers ?? null,
      projectOf: (dir) => this.projectOf(resolve(dir)).project?.id ?? null,
      emit: (event) => this.events.emit(event),
      work: (chatId) => this.workOf(chatId),
      replay: (chatId, account) => this.orchestrator.replayWorkflow(chatId, account),
      // A wait goes on with the first account that has room, whichever it is (R10)
      accountsChanged: (listener) => this.accounts.onChange(listener),
      ended: (move, end, reason) => {
        if (move.subjectKind === 'flow_run') this.flow.waitEnded(move, end, reason);
        else if (move.subjectKind === 'task') this.orchestrator.waitEnded(move, end, reason);
        else if (move.subjectKind === 'assistant_run') this.assistant.waitEnded(move, end, reason);
      },
    });
    this.rotation.start();
    this.terminals = new TerminalService({
      store: new TerminalStore(this.db.connection),
      settings: new TerminalSettingsStore(config),
      vault: this.vault,
      version: CLAUDIO_VERSION,
      emit: (event) => this.events.emit(event),
      lookup: {
        project: async (id) => {
          const project = (await this.projects()).find((p) => p.id === id);
          return project ? { path: project.path, worktrees: project.worktrees.map((w) => w.path) } : null;
        },
        chat: async (id) => {
          const chat = await this.chats.get(id);
          return chat ? { cwd: chat.cwd, worktree: chat.worktree?.path ?? null, projectId: chat.project?.id ?? null } : null;
        },
        workspace: () => this.config.workspaceDir,
      },
    });
    // Shells a previous server left running (it was killed hard) end before any new one opens
    this.terminals.reapStrays();
    // The serving side is handed reads only: nothing below can start a chat, a run or a flow
    const projectOfDir = (dir: string): string | null => this.projectOf(resolve(dir)).project?.id ?? null;
    const transcriptFile = async (sessionId: string): Promise<string | null> => {
      const summary = await this.sessions.summary(sessionId);
      return summary ? join(config.projectsDir, summary.projectId, `${summary.id}.jsonl`) : null;
    };
    this.chatUploads = new ChatUploads(this.db, this.uploads.dir, transcriptFile);
    this.collaborators = new CollaboratorsService({
      config,
      store: new CollabStore(this.db.connection),
      vault: this.vault,
      emit: (event) => this.events.emit(event),
      projects: () => this.projectStore.list(),
      projectSettings: this.projectSettingsStore,
      ...collabHostSettings(),
      log: (message) => console.warn(message),
      sources: {
        projects: () => this.projectStore.list(),
        worktreeOf: (dir) => this.locator.worktreeOf(dir),
        chats: () => this.db.loadChats().map((stored) => stored.record),
        liveChats: () => liveChatsOf(this.runtime.list()),
        transcriptFile,
        memory: { list: (projectId) => this.memoryFiles(projectId) },
        journal: this.journal,
        documents: this.documents,
        workItems: this.workItems,
        uploadsOfChat: (chatId) => this.chatUploads.of(chatId),
        uploads: this.uploads,
        orchestrations: (projectId) =>
          this.orchestrator
            .list()
            .filter((o) => !!o.finalResult && projectOfDir(o.cwd) === projectId)
            .map((o) => ({ id: o.id, name: o.name, finalResult: o.finalResult ?? '', updatedAt: o.endedAt ?? o.createdAt })),
        planDrafts: (projectId) =>
          this.db.planDrafts(100).filter((draft) => {
            const cwd = this.db.planDraft(draft.runId)?.cwd;
            return !!cwd && projectOfDir(cwd) === projectId;
          }),
        events: { subscribe: (listener) => this.events.observe(listener) },
      },
    });
    void this.collaborators.start().catch((error: unknown) => console.warn(`collab: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** The run, task or item a chat works for: what makes its limit the rotation's. Null for a person's chat. */
  private workOf(chatId: string): ChatWork | null {
    return this.flow.workOf(chatId) ?? this.orchestrator.workOf(chatId) ?? this.assistant.workOf(chatId);
  }

  /** The wait for a limit to reset that a chat is in, as the work it belongs to shows it. */
  private openWait(chatId: string): LimitWait | null {
    return openWaitOf(this.db, chatId);
  }

  /** A chat that is stopped on purpose is not waited for any more: its wait ends, and the work it belonged to with it. */
  private cancelWait(chatId: string): void {
    const id = this.rotation.waitOf(chatId);
    if (id) this.rotation.cancel(id);
  }

  /**
   * What the CLI and the account are, as the last read left them. Reading spawns two `claude`
   * processes, so callers that ask at once share one read and a value only aged out by the clock is
   * served while its replacement is on its way: a burst costs one detection, not one per caller.
   * Only `force` and a change of account wait, because answering with the account that just went
   * would be wrong rather than merely old.
   */
  async system(force = false): Promise<SystemInfo> {
    const cached = this.systemCache;
    if (!force && cached && cached.gen === this.systemGen) {
      if (Date.now() - cached.at > SYSTEM_TTL_MS) void this.readSystem().catch(() => undefined);
      return this.withUptime(cached.value);
    }
    return this.withUptime(await this.readSystem(!force));
  }

  /**
   * `cli` and `loggedIn` for `GET /api/health`, which is reachable with no credential: were it to
   * measure, a burst against it would become a burst of processes. So it reads Claude Code's provider
   * status as the last detection left it and never starts one.
   */
  claudeHealth(): { cli: boolean; loggedIn: boolean } {
    const status = this.providers.knownOne('claude-code');
    return {
      cli: status !== null && status.binaryPath !== null && status.version !== null,
      loggedIn: status !== null && this.providers.knownSignedIn('claude-code') === true,
    };
  }

  /** What the last system read saw, whatever its age, without starting one */
  systemKnown(): SystemInfo | null {
    return this.systemCache ? this.withUptime(this.systemCache.value) : null;
  }

  /**
   * What the CLI and the account report changed, so the next caller measures rather than trust the
   * last reading. The reading itself is kept: it is what the liveness probe answers from, and a
   * probe that started failing on every account switch would have the container restarted under it.
   */
  private forgetSystem(): void {
    this.systemGen++;
  }

  /** The catalog of the provider a new chat starts with */
  private defaultModels(): ModelOption[] {
    const { providers, providerSettings } = this.runtime;
    const id = providers.defaultSessionProvider(providerSettings?.() ?? this.providersSettings.get());
    return (id ? providers.driverFor(id)?.models() : null) ?? [];
  }

  private withUptime(value: SystemRead): SystemInfo {
    // Read here rather than with the rest: the rest costs two `claude` processes and is kept for
    // half a minute, while this is a file the CLI writes, cached by its own mtime
    // The account in use moves with rotation and sign-ins, faster than the system read is redone
    return { ...value, auth: { ...value.auth, inUse: this.accountInUse() }, models: this.defaultModels(), uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) };
  }

  private readSystem(join = true): Promise<SystemRead> {
    const pending = this.systemPending;
    if (join && pending && pending.gen === this.systemGen) return pending.promise;
    const gen = this.systemGen;
    const at = Date.now();
    const promise: Promise<SystemRead> = (async () => {
      const cli = await detectCli(this.config);
      const auth = cli.installed
        ? await getAuthStatus(this.config)
        : { loggedIn: false, tokenSource: 'none' as const, error: 'Claude Code CLI not installed' };
      if (this.credentials.active && auth.tokenSource.startsWith('env-')) {
        auth.tokenSource = auth.tokenSource === 'env-oauth-token' ? 'wrapper-oauth-token' : 'wrapper-api-key';
      }
      const value = {
        cli,
        auth,
        configDir: this.config.configDir,
        workspaceDir: this.config.workspaceDir,
        defaultPermissionMode: this.appSettings.defaultPermissionMode,
        version: CLAUDIO_VERSION,
      };
      // A read that finished late never replaces a newer one
      if (gen === this.systemGen && (!this.systemCache || this.systemCache.at <= at)) {
        this.systemCache = { at, gen, value };
        // The reading is already taken: the provider status is derived from it, not from a second spawn
        await this.providers.refresh({ only: ['claude-code'], claude: { cli, auth } }).catch(() => undefined);
      }
      return value;
    })().finally(() => {
      if (this.systemPending?.promise === promise) this.systemPending = null;
    });
    this.systemPending = { gen, promise };
    return promise;
  }

  private attach(dir: string) {
    return attachProject(this.projectStore.list(), dir, (d) => this.locator.worktreeOf(d));
  }

  /**
   * The project a directory belongs to and the worktree it is in, which is what a chat records. The
   * project is null when the directory is under none that was imported: a loose chat.
   */
  /**
   * The Lessons section a run is handed, or an empty one when the project does not allow it: the
   * Memory module off, the switch of that kind of run off, or a chat outside any project when
   * loose chats do not get global lessons. `handoff` is the journal's, for flow and assistant runs.
   */
  private lessonSection(projectId: string | null, kind: 'handoff' | 'chat' | 'worker'): LessonSection {
    if (projectId === null) return kind === 'handoff' || !this.lessons.delivery().looseChats ? EMPTY_SECTION : this.lessons.section(null);
    const settings = this.projectSettingsStore.stored(projectId, this.projectStore.get(projectId)?.name);
    if (!settings?.modules.includes('memory')) return EMPTY_SECTION;
    const { deliverToChats = true, deliverToWorkers = true, useGlobal = true } = settings.lessons ?? {};
    if ((kind === 'chat' && !deliverToChats) || (kind === 'worker' && !deliverToWorkers)) return EMPTY_SECTION;
    return this.lessons.section(projectId, { useGlobal });
  }

  /** A project's lessons (or the global ones with `null`) and what a run is handed now */
  lessonList(projectId: string | null, status?: LessonStatus): LessonList {
    const section = projectId === null ? (this.lessons.delivery().looseChats ? this.lessons.section(null) : EMPTY_SECTION) : this.lessonSection(projectId, 'handoff');
    return {
      lessons: this.lessons.list(projectId, status),
      handed: { lessons: section.lessons.length, bytes: section.bytes, budget: this.lessons.delivery().handoffBytes, overBudget: section.overBudget },
    };
  }

  /** One guard verdict on a chat, stored with what the chat works for; a replayed stream stores nothing twice. */
  private recordGuard(chatId: string, guard: RunGuardEvent): void {
    try {
      const chat = this.runtime.get(chatId);
      const task = this.orchestrator.taskContext(chatId);
      const run = this.flow.workOf(chatId);
      this.guardEvents.insert({
        chatId,
        projectId: chat ? this.projectOf(resolve(chat.workingDir || chat.cwd)).project?.id ?? null : null,
        orchestrationId: task?.orchestrationId ?? null,
        taskId: task?.taskId ?? null,
        flowRunId: run?.subjectId ?? null,
        toolUseId: guard.toolUseId,
        toolName: guard.toolName,
        rule: guard.rule,
        matcher: guard.matcher,
        outcome: guard.outcome,
        reason: guard.reason,
        excerpt: guard.excerpt,
      });
    } catch (err) {
      // Heard from the chat's stream: a closed database (shutting down) must not become the chat's error
      console.warn(`guard: the verdict on ${chatId} was not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Which teammates' copies a chat may read through its own token, or why none
   * (docs/plans/collaborators-agent-access.md). Decided on the live process Claudio has for the chat:
   * its marker, its permission mode now and the project it works in.
   */
  agentReadScope(chatId: string): AgentReadDecision {
    const runtime = this.runtime.get(chatId);
    const chat: AgentReadChat | null = runtime
      ? {
          assistant: !!runtime.claudioAssistant,
          projectId: this.projectOf(resolve(runtime.workingDir || runtime.cwd)).project?.id ?? null,
          permissionMode: runtime.permissionMode,
        }
      : null;
    return this.collaborators.agentReadScope(chat);
  }

  projectOf(dir: string): { project: ChatProject | null; worktree: ChatWorktree | null } {
    const attached = this.attach(dir);
    const facts = attached ? attached.worktree : this.locator.worktreeOf(dir);
    return {
      project: attached ? { id: attached.project.id, name: attached.project.name } : null,
      worktree: facts ? { path: facts.path, name: facts.name, branch: facts.branch } : null,
    };
  }

  /** The one driver there is: Claude Code's. */
  private sessionDrivers(config: CoreConfig): ProviderDriver[] {
    return [new ClaudeCodeDriver(config.claudeBin)];
  }

  /**
   * Where a chat belongs: its project, and the worktree when it works in one. The CLI's own record
   * of the worktree it created wins over anything guessed from the path.
   */
  private place(dir: string, recorded: TranscriptSummary['worktree']): Placement {
    if (recorded) this.locator.learn(recorded);
    return this.projectOf(dir);
  }

  /** Saved workflows the Workflow tool can run by name, for a project directory and the user. */
  workflowDefinitions(cwd?: string): Promise<WorkflowDefinition[]> {
    return listWorkflowDefinitions(this.config.configDir, cwd);
  }

  /**
   * Starts a run that runs a saved workflow. The CLI has no command for it: a workflow only runs
   * through the Workflow tool, inside a session, so the run is asked to call it, and asking in
   * the user's own words is what the tool requires before it launches one.
   */
  async runWorkflow(request: RunWorkflowRequest): Promise<ChatSummary> {
    const name = request.name?.trim();
    if (!name) throw new Error('name is required');
    validateEffort(request.effort);
    const known = await this.workflowDefinitions(request.cwd);
    if (!known.some((w) => w.name === name)) throw new Error(`workflow "${name}" not found in .claude/workflows/`);
    const args = request.args?.trim();
    const prompt = [
      `Run the saved workflow "${name}" with the Workflow tool (pass name: "${name}"${args ? ' and the args below' : ''}).`,
      'Wait for it to finish, then report its result.',
      ...(args ? ['', 'Args:', args] : []),
    ].join('\n');
    const started = this.runtime.start({
      prompt,
      name: `workflow-${name}`,
      purpose: 'person',
      permissionPrompts: 'host',
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...effortOption(resolveEffort('chat', request.model, request.effort)),
    });
    const chat = await this.chats.summaryOf(started.id);
    if (!chat) throw new Error('chat not found');
    return chat;
  }

  /**
   * Deletes every trace Claude Code keeps of a project: transcripts, tasks, file history and its
   * config entry. The CLI owns that layout, so it does the deleting. Irreversible, and separate
   * from `removeProject`, which only makes Claudio forget the directory.
   */
  async purgeProject(id: string): Promise<{ detail: string }> {
    const project = this.projectStore.get(id);
    if (!project) throw new Error('project not found');
    const res = await execCli(this.config, ['project', 'purge', project.path, '--yes'], { timeoutMs: 60_000 });
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'claude project purge failed');
    // Only that project's transcripts went; the rest stay as they were read
    this.sessions.invalidate(encodeProjectId(project.path));
    return { detail: res.stdout.trim() };
  }

  /**
   * Maps the `?project=` of a config route to a scope. Only projects the wrapper knows about are
   * accepted, so the API cannot be pointed at arbitrary directories.
   */
  async resolveScope(projectId?: string): Promise<ConfigScope> {
    if (!projectId || projectId === 'user') return userScope(this.config);
    const project = this.projectStore.get(projectId);
    if (!project) throw new Error('project not found');
    if (!existsSync(project.path)) throw new Error('project directory is missing on disk');
    return projectScope(project.path);
  }

  /** Claude Code keys a project's memory by its directory, not by the id Claudio gives the project. */
  private memoryKey(projectId: string): string {
    const project = this.projectStore.get(projectId);
    if (!project) throw new Error('project not found');
    return encodeProjectId(project.path);
  }

  async memoryFiles(projectId: string): Promise<MemoryFile[]> {
    const files = await this.memory.list(this.memoryKey(projectId));
    return files.map((f) => ({ ...f, projectId }));
  }

  async saveMemory(projectId: string, name: string, content: unknown): Promise<MemoryFile> {
    return { ...(await this.memory.save(this.memoryKey(projectId), name, content)), projectId };
  }

  removeMemory(projectId: string, name: string): Promise<void> {
    return this.memory.remove(this.memoryKey(projectId), name);
  }

  async memoryOverview(): Promise<MemoryProjectSummary[]> {
    const summaries = await Promise.all(
      this.projectStore.list().map(async (p) => {
        const files = await this.memory.list(encodeProjectId(p.path));
        const lastUpdated = files.map((f) => f.updatedAt ?? '').sort().at(-1) || null;
        return { projectId: p.id, projectPath: p.path, projectName: p.name, fileCount: files.length, lastUpdated };
      }),
    );
    return summaries.sort((a, b) => b.fileCount - a.fileCount || a.projectName.localeCompare(b.projectName));
  }

  async configFileRoots(): Promise<ConfigFileRoot[]> {
    const user = userScope(this.config);
    const roots: ConfigFileRoot[] = [{ id: 'user', label: 'User', path: user.claudeDir, exists: existsSync(user.claudeDir) }];
    for (const project of this.projectStore.list()) {
      if (!existsSync(project.path)) continue;
      const { claudeDir } = projectScope(project.path);
      roots.push({ id: project.id, label: project.name, path: claudeDir, exists: existsSync(claudeDir) });
    }
    return roots;
  }

  /** The CLI in use against the newest published one, as the last check left it: no network here. */
  /** Whether guards can run here, for Settings: the pre-launch checks (`guards/preflight.ts`) say why not */
  async guardStatus(): Promise<GuardStatus> {
    const version = (await this.system()).cli.version;
    return { ...(await this.guardLauncher.status()), cliVersion: version ?? null };
  }

  async cliVersionInfo(): Promise<CliVersionInfo> {
    const { cli } = await this.system();
    return this.cliVersion.info(cli.version, this.cliInstaller.info(cli.path));
  }

  /** Asks the registry now; the button on the System page, not something a page load may trigger. */
  async checkCliVersion(): Promise<CliVersionInfo> {
    await this.cliVersion.check();
    return this.cliVersionInfo();
  }

  /** What each live chat's process tree uses; the process table is at most two seconds old, the per-process figures are read on each call. See system-load.ts */
  processUsage(): ProcessUsageReport {
    const chats = chatProcessUsage(this.chats.livePids(), recentProcessTable());
    const rss = chats.reduce<number | null>((sum, c) => (sum === null || c.rssMb === null ? null : sum + c.rssMb), 0);
    return { chats, processes: chats.reduce((sum, c) => sum + c.processes, 0), rssMb: rss };
  }

  /** What the machine is doing now, and whether it admits a new chat; see system-load.ts. Read on each call. */
  systemLoad(): SystemLoad {
    return readSystemLoad(admissionLimitsFrom());
  }

  /** The stored readings of the machine, oldest first; see system-history.ts */
  systemHistory(query: { since?: string; until?: string; limit?: number; bucketSeconds?: number } = {}): SystemSample[] {
    return this.db.systemSamples(query);
  }

  /** Whether the folders that hold the state would survive replacing the container; see storage.ts */
  storageInfo(): StorageReport {
    const { configDir, dataDir, workspaceDir } = this.config;
    return storageReport(this.release.distribution, { config: configDir, data: dataDir, workspace: workspaceDir });
  }

  /** This Claudio against the newest release, as the last check left it: no network here. */
  releaseInfo(): ClaudioReleaseInfo {
    return this.release.info();
  }

  /** Asks GitHub now, for the Check for updates button. */
  async checkRelease(): Promise<ClaudioReleaseInfo> {
    await this.release.check();
    // Whether the new release installs here (a bundle, a valid signature, a base it fits) is in its
    // assets and signed manifest, judged now rather than on a page load
    await this.serverUpdates.inspect();
    return this.release.info();
  }

  /** What a restart would stop, counted as the overview counts it */
  async liveWork(): Promise<LiveWork> {
    const chats = await this.chats.list({ origins: ['claudio', 'external', 'orchestration'] });
    return {
      working: chats.filter((c) => c.state === 'working').length,
      waiting: chats.filter((c) => c.state === 'waiting').length,
      running: this.orchestrator.runningCount(),
      // Every shell ends with the server (docs/terminal.md, Lifetime)
      terminals: this.terminals.running(),
    };
  }

  /** The version this server runs, as every client should expect it */
  get version(): string {
    return CLAUDIO_VERSION;
  }

  /** Claudio's own MCP server for a chat, and the flags that confine the chat to its read tools. */
  claudioMcp(): Promise<ClaudioMcpLaunch> {
    return claudioMcp({ dataDir: this.config.dataDir, apiUrl: this.runtime.apiUrl, version: CLAUDIO_VERSION });
  }

  /**
   * Starts a chat with the Claudio assistant (`POST /assistant/chats`): the person's prompt, the
   * project in scope as context if there is one, and nothing else of the chat is theirs to choose.
   * It runs in the project's directory when that exists, else in the workspace. Its confinement is
   * `assistantChatLaunch`, applied again at every process of the chat.
   */
  async startClaudioAssistantChat(input: unknown, language: ClaudioLanguage = 'en'): Promise<ChatSummary> {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) throw new AssistantError('prompt is required', 400);
    if (body.projectId !== undefined && body.projectId !== null && typeof body.projectId !== 'string') throw new AssistantError('projectId must be text', 400);
    if (body.model !== undefined && body.model !== null && (typeof body.model !== 'string' || !body.model.trim())) throw new AssistantError('model must be text', 400);
    const project = typeof body.projectId === 'string' && body.projectId ? this.projectStore.get(body.projectId) : null;
    if (typeof body.projectId === 'string' && body.projectId && !project) throw new AssistantError('project not found', 404);
    if (body.effort !== undefined && body.effort !== null && !isEffort(body.effort)) throw new AssistantError('effort must be one of low, medium, high, xhigh, max', 400);
    const model = typeof body.model === 'string' ? body.model.trim() : DEFAULT_ASSISTANT_MODEL;
    const effort = resolveEffort('assistant', model, typeof body.effort === 'string' ? body.effort : undefined);
    return this.chats.create(
      { prompt, model, purpose: 'assistant', ...effortOption(effort), provider: LEGACY_PROVIDER, ...(project && existsSync(project.path) ? { cwd: project.path } : {}) },
      undefined,
      { projectId: project?.id ?? null, language },
    );
  }

  /** What the assistant chat of this marker runs with: `assistantChatOptions`, with the guide for its project and language. */
  private assistantChatLaunch(marker: ClaudioAssistantMarker): AssistantChatOptions {
    const project = marker.projectId ? this.projectStore.get(marker.projectId) : null;
    const scope = project ? { id: project.id, name: project.name, key: this.projectSettingsStore.stored(project.id, project.name)?.keyPrefix ?? '', path: project.path } : null;
    // The assistant always asks before it runs anything (`assistantChatOptions`): its reads of teammates' copies hang on the switches alone
    const decision = this.collaborators.agentReadScope({ assistant: true, projectId: null, permissionMode: 'manual' });
    const reads = 'scope' in decision;
    const launch = claudioMcpSync({ dataDir: this.config.dataDir, apiUrl: this.runtime.apiUrl, version: CLAUDIO_VERSION, toolsets: reads ? ['claudio', 'collab'] : ['claudio'] });
    const teammates = reads ? 'reads' : decision.refusal === 'assistant-off' ? 'off' : null;
    return assistantChatOptions(launch, claudioAssistantPrompt(scope, marker.language, teammates));
  }

  /**
   * The reads of teammates' copies for a process of a chat that is not the assistant: offered when
   * its project opted in and its mode asks before running commands, decided again at every process
   * and checked again by the API at every call (docs/plans/collaborators-agent-access.md).
   */
  private agentReadsLaunch(chat: { dir: string; permissionMode: PermissionMode; mcpConfig: string | null }): CollabMcpLaunch | null {
    const projectId = this.projectOf(resolve(chat.dir)).project?.id ?? null;
    const decision = this.collaborators.agentReadScope({ assistant: false, projectId, permissionMode: chat.permissionMode });
    if (!('scope' in decision)) return null;
    return collabMcpSync({ dataDir: this.config.dataDir, apiUrl: this.runtime.apiUrl, version: CLAUDIO_VERSION }, chat.mcpConfig);
  }

  async setCredentials(credentials: StoredCredentials): Promise<SystemInfo> {
    await this.credentials.set(credentials);
    this.inUseCheckedAt.delete(DEFAULT_ID);
    return this.system(true);
  }

  /**
   * `claude auth login` on the CLI's own login succeeded. A token or an API key Claudio kept in the
   * vault would keep winning over the new credentials file (the variables beat it), so it is dropped.
   */
  async defaultSignedIn(): Promise<void> {
    const { auth } = await this.system(true);
    if (auth.tokenSource === 'wrapper-oauth-token' || auth.tokenSource === 'wrapper-api-key') await this.credentials.clear();
    this.inUseCheckedAt.delete(DEFAULT_ID);
    await this.accounts.confirm(DEFAULT_ID).catch(() => undefined);
    await this.system(true);
  }

  async clearCredentials(): Promise<SystemInfo> {
    await this.credentials.clear();
    this.inUseCheckedAt.delete(DEFAULT_ID);
    return this.system(true);
  }

  /** `claude auth status` only reports what is configured; this proves it with a minimal real request. */
  /**
   * What the first setup has done and what it has not, for the setup assistant and a "finish
   * setting up" card. Reads the detectors' caches (the first call waits for a detection).
   */
  async setupState(): Promise<SetupState> {
    const [providers, hosts, youtrack, tunnel] = await Promise.all([this.providers.statuses(), this.hosts.statuses(), this.trackers.status('youtrack'), this.tunnel.refresh()]);
    const auth = this.security.config;
    const credentials = this.youtrackCredentials.status();
    return {
      seen: this.appSettings.get().setupSeen,
      access: { mode: auth.mode, tokenSet: auth.tokenSet, readOnly: auth.readOnly },
      providers: providers
        .filter((status) => status.reason !== 'disabled')
        .map((status) => ({ id: status.id, label: status.label, state: status.state, reason: status.reason, account: status.account, keyStored: this.vault.has(status.id) })),
      hosts: hosts.map((status) => ({ id: status.id, cli: status.id === 'github' ? 'gh' : 'glab', state: status.state, reason: status.reason, hosts: status.hosts.map((entry) => ({ ...entry })) })),
      youtrack: { configured: credentials.host !== null && credentials.tokenSet, state: youtrack?.state ?? null, reason: youtrack?.reason ?? null },
      tailscale: { enabled: tunnel.enabled, managed: tunnel.managed, state: tunnel.tailscale.state, host: tunnel.tailscale.host },
      methods: setupMethods(),
      secrets: { sealed: this.vault.sealed, keyBeside: this.vault.keyBeside },
    };
  }

  /** The setup assistant was finished or skipped; refused like any app setting the environment owns */
  async markSetupSeen(): Promise<SetupState> {
    const settings = this.appSettings.get();
    if (!settings.setupSeen && settings.sources.setupSeen === 'env') {
      throw Object.assign(new Error('setupSeen is set by the environment (CLAUDIO_SETUP_SEEN) and cannot be changed here'), { statusCode: 409 });
    }
    if (!settings.setupSeen) await this.appSettings.update({ setupSeen: true });
    return this.setupState();
  }

  /**
   * Why Tailscale is not signed in from here, or null where it is: only the daemon the image starts
   * for Claudio is Claudio's to sign in, and only while the tunnel is offered at all.
   */
  private tailscaleRefusal(): string | null {
    if (!this.config.tailscaleManaged) return "This machine's Tailscale belongs to it: sign it in with the Tailscale app or tailscale up. Claudio signs in only the Tailscale it runs itself, in its Docker image.";
    if (!this.config.tunnelEnabled) return 'This Claudio does not offer the tunnel (CLAUDIO_TUNNEL is off), so it runs no Tailscale to sign in.';
    return null;
  }

  /** The binary a sign-in runs: the one the tool's detector resolved, the person's override included */
  private async setupBinary(tool: SetupTool): Promise<string | null> {
    if (tool === 'tailscale') return this.config.tailscaleBin;
    if (tool === 'gh' || tool === 'glab') return (await this.hosts.status(tool === 'gh' ? 'github' : 'gitlab'))?.binaryPath ?? null;
    if (tool === 'youtrack') return (await this.trackers.status('youtrack'))?.binaryPath ?? null;
    return (await this.providers.status(tool))?.binaryPath ?? null;
  }

  /** A tool's readiness read again after a sign-in or a sign-out: what decides whether it worked */
  private async setupReadiness(tool: SetupTool, host: string | null): Promise<boolean | null> {
    if (tool === 'tailscale') {
      // Signed in is any state past NeedsLogin: MagicDNS or HTTPS being off is the tailnet's setting, not the sign-in's
      const { tailscale } = await this.tunnel.refresh(true);
      return tailscale.state === 'ready' || tailscale.state === 'httpsDisabled' || tailscale.state === 'stopped';
    }
    if (tool === 'gh' || tool === 'glab') {
      const status = (await this.hosts.refresh()).find((s) => s.id === (tool === 'gh' ? 'github' : 'gitlab'));
      // Copilot falls back to gh's sign-in to github.com, and Copilot's Code is that sign-in: its
      // row has to move with gh's, not one detection TTL later
      if (tool === 'gh' && host === 'github.com') await this.providers.refresh({ only: ['copilot'] }).catch(() => undefined);
      return status?.hosts.find((entry) => entry.hostname === host)?.signedIn ?? false;
    }
    if (tool === 'youtrack') {
      const status = (await this.trackers.credentialsChanged('youtrack')).find((s) => s.id === 'youtrack');
      return status ? status.state === 'ready' : null;
    }
    if (tool === 'claude-code') {
      // The credential changed, so Core's shared read of the CLI is stale too
      const { cli, auth } = await this.system(true);
      await this.providers.refresh({ only: ['claude-code'], claude: { cli, auth } });
    } else {
      await this.providers.refresh({ only: [tool] });
    }
    return this.providers.knownSignedIn(tool);
  }

  async verifyAuth(): Promise<AuthVerification> {
    const inUse = this.accountInUse()?.id ?? null;
    const run = this.runtime.start({
      prompt: 'Reply with exactly: ok',
      model: 'haiku',
      name: 'auth-check',
      keepAlive: false,
      internal: true,
      permissionMode: 'manual',
      allowedTools: [],
    });
    const result = await this.runtime.waitForResult(run.id);
    this.runtime.remove(run.id);
    // The turn ran on the account new work starts on: a finished one is a check of it, a 401 marked it
    if (inUse && !result.isError) await this.accounts.markChecked(inUse).catch(() => undefined);
    const { auth } = await this.system(true);
    return { ok: !result.isError, detail: result.result.slice(0, 500), auth };
  }

  /**
   * The supervisor's question as a housekeeping chat: no transcript, the `read-only` preset (the
   * stored one, or the shipped one if it was deleted) and the configured ceiling as
   * `--max-budget-usd`. Removed once it answers, like the auth check: the proposal is its record.
   */
  private async askSupervisor(question: SupervisorQuestion): Promise<SupervisorAnswer> {
    const preset = this.toolPresets.get('read-only') ?? DEFAULT_SUPERVISOR_PRESET;
    const allowedTools = preset.allowedTools ?? [];
    // A watcher reads: whatever the stored preset says, it never pushes
    const disallowedTools = [...new Set([...(preset.disallowedTools ?? []), ...PUSH_DENIED])];
    const run = this.runtime.start({
      prompt: question.prompt,
      cwd: question.cwd,
      model: question.model,
      name: 'supervisor',
      purpose: 'supervisor',
      keepAlive: false,
      internal: true,
      permissionMode: 'manual',
      allowedTools,
      disallowedTools,
      toolConfig: { preset, allowedTools, disallowedTools, mcp: null },
      maxBudgetUsd: question.maxCostUsd,
    });
    try {
      const result = await this.runtime.waitForResult(run.id);
      return { text: result.result, costUsd: result.costUsd, isError: result.isError };
    } finally {
      await Promise.race([this.runtime.exited(run.id), new Promise((r) => setTimeout(r, 10_000).unref())]);
      this.runtime.remove(run.id);
    }
  }

  /**
   * The projects the person imported, each with the chats under it and its worktrees. Nothing is
   * discovered here: a directory Claude Code has run in is a project only once it is imported.
   */
  async projects(): Promise<Project[]> {
    const places = await this.chatPlaces();
    // Counted from the chat list the project's page shows, so the figure agrees with it: a chat this
    // process runs (a "Work on it", a flow or an assistant chat) counts before the CLI writes its transcript
    const listed = await this.chats.list();
    const worktrees = new Map<string, Map<string, ProjectWorktree>>();
    const stats = new Map<string, { chatCount: number; lastActivity: string | null }>();
    const addWorktree = (path: string, creator: ProjectWorktree['createdBy'] = null) => {
      const attached = this.attach(path);
      const facts = this.locator.worktreeOf(path);
      if (!attached || facts?.path !== path) return;
      const known = worktrees.get(attached.project.id) ?? new Map<string, ProjectWorktree>();
      known.set(path, { path, name: facts.name, branch: facts.branch, createdBy: creator ?? known.get(path)?.createdBy ?? null });
      worktrees.set(attached.project.id, known);
    };

    for (const place of places) {
      const attached = this.attach(place.cwd);
      if (attached?.worktree) addWorktree(attached.worktree.path);
    }
    for (const chat of listed) {
      if (!chat.project) continue;
      const stat = stats.get(chat.project.id) ?? { chatCount: 0, lastActivity: null };
      stat.chatCount += 1;
      if (chat.updatedAt && (!stat.lastActivity || chat.updatedAt > stat.lastActivity)) stat.lastActivity = chat.updatedAt;
      stats.set(chat.project.id, stat);
    }

    // The orchestration task that created a worktree says more about it than its name does, and a
    // worktree no chat has run in yet is only known from there
    for (const orch of this.orchestrator.list()) {
      for (const task of orch.tasks) {
        if (!task.branch) continue;
        const path = task.worktree ?? join(orch.cwd, '.claude', 'worktrees', task.branch.replace(/^worktree-/, ''));
        addWorktree(path, { orchestrationId: orch.id, orchestrationName: orch.name, taskId: task.id, taskName: task.name });
      }
    }

    // Where the CLI puts the worktrees it makes, for those nothing above has met
    for (const project of this.projectStore.list()) {
      const root = join(project.path, '.claude', 'worktrees');
      for (const name of await readdir(root).catch(() => [] as string[])) addWorktree(join(root, name));
    }

    const records = this.projectStore.list();
    const settings = await this.projectSettingsStore.readAll(records);
    return records.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      key: settings.get(p.id)?.keyPrefix ?? '',
      modules: settings.get(p.id)?.modules ?? [],
      // A worktree removed from disk is history, kept in the chats that ran there, not a place to go
      worktrees: [...(worktrees.get(p.id)?.values() ?? [])].filter((w) => existsSync(w.path)).sort((a, b) => a.path.localeCompare(b.path)),
      exists: existsSync(p.path),
      chatCount: stats.get(p.id)?.chatCount ?? 0,
      lastActivity: stats.get(p.id)?.lastActivity ?? null,
    }));
  }

  /** The worktrees the CLI recorded in its transcripts are what let a chat in one find its repository. */
  private async chatPlaces(): Promise<ChatPlace[]> {
    const sessions = await this.sessions.listSessions();
    for (const s of sessions) if (s.worktree) this.locator.learn(s.worktree);
    return sessions.map(placeOf);
  }

  /** The directories with the most chats that are not projects yet: what a first start offers to import. */
  async projectCandidates(): Promise<ProjectCandidate[]> {
    return projectCandidates(this.projectStore.list(), await this.chatPlaces(), (d) => this.locator.worktreeOf(d));
  }

  /**
   * Imports a directory and writes its settings from the template and modules asked for. A
   * directory that was a project before takes its old id back, and with it its settings and work
   * items.
   */
  async importProject(req: ImportProjectRequest): Promise<Project> {
    const setup = parseProjectSetup(req);
    const active = () => new Set(this.projectStore.list().map((p) => p.id));
    const imported = active();
    const record = await this.projectStore.add(
      { path: req.path, ...(req.name ? { name: req.name } : {}) },
      (d) => this.locator.worktreeOf(d),
      (path) => this.projectSettingsStore.idForPath(path, active()),
    );
    const { settings, previous } = await this.projectSettingsStore.create(record, setup, this.projectStore.list());
    // A directory imported again can come back with other modules: whoever shows its tabs has to know
    if (previous) this.projectUpdated(record, settingsChanges(previous, settings), settings.modules);
    // Other tabs list projects too, and the All projects board takes the new one in
    if (!imported.has(record.id)) this.events.emit({ type: 'project.created', title: `${record.name} added`, projectId: record.id, projectName: record.name });
    return this.projectView(record.id);
  }

  /** A new directory in the workspace, imported straight away. The template is checked before the directory exists. */
  async createProject(req: CreateProjectRequest): Promise<Project> {
    const setup = parseProjectSetup(req);
    const { name, gitUrl } = req as { name?: unknown; gitUrl?: unknown };
    if (typeof name !== 'string') throw new Error('name is required: the name of the new directory');
    if (gitUrl !== undefined && gitUrl !== null && typeof gitUrl !== 'string') throw new Error('gitUrl must be a URL to clone');
    const path = await this.workspace.create(req.name ?? '', req.gitUrl || undefined);
    return this.importProject({ path, ...(setup.template ? { template: setup.template } : {}), ...(setup.modules ? { modules: setup.modules } : {}) });
  }

  /** The five built-in templates, as data a wizard draws. */
  projectTemplates(): ProjectTemplate[] {
    return structuredClone([...PROJECT_TEMPLATES]);
  }

  /**
   * Renames a project, changes its key prefix or its modules. Everything is validated before
   * anything is written, so a prefix another project holds does not leave a rename half done.
   * Switching a module off only hides it: its data stays where it is.
   */
  async updateProject(id: string, req: UpdateProjectRequest): Promise<Project> {
    const record = this.requireProject(id);
    const body: Partial<Record<keyof UpdateProjectRequest, unknown>> = req && typeof req === 'object' ? req : {};
    if (body.name === undefined && body.key === undefined && body.modules === undefined) throw new Error('name, key or modules is required');
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) throw new Error('name is required');
    const key = body.key === undefined ? undefined : parseKeyPrefix(body.key);
    const modules = body.modules === undefined ? undefined : parseModules(body.modules);

    const active = this.projectStore.list();
    const { before, after } = await this.projectSettingsStore.update(record, (current) => ({ ...current, ...(key ? { keyPrefix: key } : {}), ...(modules ? { modules } : {}) }), active);
    const changes: ProjectChange[] = settingsChanges(before, after);
    let current = record;
    if (typeof body.name === 'string' && body.name.trim() !== record.name) {
      current = await this.projectStore.rename(id, body.name);
      if (current.name !== record.name) changes.push('name');
    }
    this.projectUpdated(current, changes, after.modules);
    return this.projectView(id);
  }

  /** Off only when the person turned it off in `trackers.json`: a tracker with no entry is on. */
  private trackerEnabled(id: TrackerId): boolean {
    return this.trackersSettings.get().trackers[id]?.enabled !== false;
  }

  /**
   * The one door import, listing and sync go through to a tracker's CLI: a tracker the person turned
   * off reads and writes nothing, whatever the project's settings still say. The host's own
   * readiness is checked behind it, by `hostAccess`.
   */
  private async trackerAccess(projectPath: string, tracker: TrackerId): Promise<TrackerAccess> {
    if (!this.trackerEnabled(tracker)) throw new TrackerError('this tracker is turned off in the trackers settings', 409, 'tracker-disabled');
    if (tracker === 'youtrack') return this.youtrackAccess(projectPath);
    return this.pullRequests.hostAccess(projectPath);
  }

  /**
   * YouTrack is not the project's host: its calls go to the instance Claudio keeps the address and
   * token of, through the `youtrack-app` the detector found ready, with the token only in the
   * child's environment.
   */
  private async youtrackAccess(projectPath: string): Promise<TrackerAccess> {
    const status = await this.trackers.status('youtrack');
    const credentials = this.youtrackCredentials.get();
    if (!status || status.state !== 'ready' || !status.binaryPath || !credentials) {
      const reason = status?.state === 'not-installed' ? 'cli-missing' : status?.state === 'incompatible' ? 'cli-incompatible' : status?.state === 'signed-out' || !credentials ? 'tracker-signed-out' : 'unreachable';
      throw new TrackerError(`YouTrack is not ready (${status?.reason ?? status?.state ?? 'unknown'}): see Settings, Integrations`, 409, reason);
    }
    const binaryPath = status.binaryPath;
    const cwd = mainCheckout(projectPath);
    return {
      host: null,
      hostname: credentials.host,
      repo: null,
      // The address and token come from the vault, laid over by the execution layer (`buildHostEnv`)
      run: (call) => runHostCall(call, { binaryPath, cwd, baseEnv: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, processes: this.children }),
      issueUrl: (key) => youtrackIssueUrl(credentials.host, key),
    };
  }

  /** The project's settings document, created on first read with every module off. */
  async projectSettings(id: string): Promise<ProjectSettings> {
    return this.projectSettingsStore.read(this.requireProject(id), this.projectStore.list());
  }

  /** Replaces the settings document whole, after validating it. */
  async saveProjectSettings(id: string, input: unknown): Promise<ProjectSettings> {
    const record = this.requireProject(id);
    const settings = parseProjectSettings(input);
    const active = this.projectStore.list();
    const before = await this.projectSettingsStore.read(record, active);
    await this.projectSettingsStore.write(record, settings, active);
    this.projectUpdated(record, settingsChanges(before, settings), settings.modules);
    return settings;
  }

  /**
   * What the team writes: only its team and its flow. The team hands back the whole document it
   * read, and writing all of it would put back a module switched since that read, and replace a part
   * a hand edit broke with the default the read answered for it.
   */
  private async saveTeamSettings(id: string, settings: ProjectSettings): Promise<ProjectSettings> {
    const record = this.requireProject(id);
    const { before, after } = await this.projectSettingsStore.update(
      record,
      (current) => {
        const { team: _team, flow: _flow, ...rest } = current;
        return parseProjectSettings({ ...rest, ...(settings.team ? { team: settings.team } : {}), ...(settings.flow ? { flow: settings.flow } : {}) });
      },
      this.projectStore.list(),
    );
    this.projectUpdated(record, settingsChanges(before, after), after.modules);
    return after;
  }

  /** 404 for a project that is not imported; the docs routes check it before they touch the registry. */
  assertProjectDocsProject(projectId: string): void {
    if (!this.projectStore.get(projectId)) throw new ProjectDocsError('project not found', 404);
  }

  /**
   * "Ask Claude about this document": a normal chat in the project, with the document's link in the
   * prompt, so the person drives any change in a chat they can watch. The Docs connector reaches it
   * through the account's own claude.ai connectors; nothing is pre-approved.
   */
  async askAboutProjectDoc(projectId: string, docId: string, language: ClaudioLanguage = 'en'): Promise<ChatSummary> {
    this.assertProjectDocsProject(projectId);
    const record = this.requireProject(projectId);
    const doc = this.projectDocs.find(projectId, docId);
    if (!existsSync(record.path)) throw new ProjectDocsError(`the project's directory ${record.path} is missing`, 409);
    const lead = language === 'es' ? `Hablemos del documento «${doc.title}»` : `Let's talk about the document "${doc.title}"`;
    const prompt = [
      lead,
      `The document lives in Claude Docs: ${doc.url}`,
      'Use the Claude Docs connector to read it first. Change it only if I ask you to.',
    ].join('\n\n');
    return this.chats.create({ prompt, cwd: record.path });
  }

  private requireProject(id: string): ProjectRecord {
    const record = this.projectStore.get(id);
    if (!record) throw new Error('project not found');
    return record;
  }

  private projectUpdated(project: ProjectRecord, changes: ProjectChange[], modules: ProjectModule[]): void {
    this.lessons.invalidate();
    if (!changes.length) return;
    this.events.emit({ type: 'project.updated', title: `${project.name} updated`, projectId: project.id, projectName: project.name, changes, modules });
  }

  /**
   * Forgets a project in Claudio. What Claude Code keeps about it is `purgeProject`, and is not
   * touched; neither are its settings document and work items, which importing it again brings back.
   */
  async removeProject(id: string): Promise<void> {
    const record = this.projectStore.get(id);
    await this.projectStore.remove(id);
    if (record) this.events.emit({ type: 'project.removed', title: `${record.name} removed`, projectId: record.id, projectName: record.name });
  }

  // ---------- journal and memory proposals ----------

  /**
   * The settings of a project whose journal or memory proposals are read or decided. Both need the
   * project imported; a change also needs its Memory module on. With the module off everything
   * stays, only hidden (decision 4).
   */
  async memoryProject(projectId: string, access: 'read' | 'write'): Promise<ProjectSettings> {
    const settings = await this.projectSettings(projectId);
    if (access === 'write' && !settings.modules.includes('memory')) {
      throw new WorkItemError("the Memory module is off in this project: switch it on in the project's settings to change its memory", 409);
    }
    return settings;
  }

  // ---------- the flow by column ----------

  /** `GET /projects/:id/flow`: readable with the flow off, as a project's other modules are. */
  projectFlow(projectId: string) {
    this.requireProject(projectId);
    return this.flow.projectFlow(projectId);
  }

  /** `GET /projects/:id/flow/waiting`: the cards switching the flow on left waiting; none while it is off. */
  projectFlowWaiting(projectId: string): FlowWaiting {
    this.requireProject(projectId);
    return this.flow.waiting(projectId);
  }

  /**
   * `POST /projects/:id/flow/start-waiting`: a person starts the waiting cards, one run each, as if
   * each had entered its column. 409 while the flow is off.
   */
  /** The person lets a held card's run start past today's cap; the flow dispatches once the gate hears of it. */
  grantFlowSpendPass(itemId: string): FlowSpendPass {
    if (!this.workItems.find(itemId)) throw new Error('work item not found');
    return { itemId, day: this.spend.grantItemPass(itemId) };
  }

  startWaitingFlowRuns(projectId: string): FlowStartWaitingResult {
    this.requireProject(projectId);
    return this.flow.startWaiting(projectId);
  }

  /**
   * Keeps the language an `Accept-Language` header names, when it names one of Claudio's: the panel
   * sends the person's with every request. A header that names none (`*`, which a script's fetch
   * sends, or another language) leaves the last one as it was.
   */
  noteLanguage(header: unknown): void {
    if (typeof header !== 'string') return;
    const named = header.split(',').some((tag) => (CLAUDIO_LANGUAGES as readonly string[]).includes(tag.trim().toLowerCase().split(/[-_;]/)[0] ?? ''));
    if (named) this.language = claudioLanguage(header);
  }

  /**
   * `POST /decisions/:id/palette-action`: what the palette's person did with the proposal. Null when
   * the row is gone; the row unchanged on a later report. Throws for a row of another point.
   */
  reportPaletteAction(id: string, commandId: string | null): DecisionRecord | null {
    const row = this.db.decision(id);
    if (!row) return null;
    if (row.point !== 'palette.intent') throw Object.assign(new Error(`decision ${id} is not a palette.intent row`), { statusCode: 400 });
    const updated = this.db.setDecisionPaletteAction(id, commandId, new Date().toISOString());
    this.decisionResolvers.soon();
    return updated;
  }

  /** `POST /decisions/notification-opened`: the app was opened from the push with this key. */
  reportNotificationOpened(key: string): string | null {
    const id = this.db.markNotificationOpened(key, new Date().toISOString());
    if (id) this.decisionResolvers.soon();
    return id;
  }

  /** The person's language as the panel last said it. */
  personLanguage(): ClaudioLanguage {
    return this.language;
  }

  /** `GET /projects/:id/flow/runs`: the team's activity, a page at a time; readable with the flow off. */
  projectFlowRuns(projectId: string, query: FlowRunQuery = {}): FlowRunPage {
    this.requireProject(projectId);
    return this.flow.page(projectId, query);
  }

  /** `GET /work-items/:itemId/runs`: every flow run of an item, newest first, readable as the item is. */
  async workItemRuns(itemId: string): Promise<FlowRun[]> {
    await this.workItemAccess(itemId, 'read');
    return this.flow.itemRuns(itemId);
  }

  /**
   * `POST /flow-runs/:runId/retry`: queues a failed run's step again, as a person's move. Writing to
   * the item, so its project must be imported, as for any change to it.
   */
  async retryFlowRun(runId: string): Promise<FlowRun> {
    const run = this.flow.run(runId);
    if (!run) throw new FlowError('flow run not found', 404);
    await this.workItemAccess(run.itemId, 'write');
    return this.flow.retry(runId);
  }

  // ---------- the project assistant ----------

  private async assistantProject(projectId: string): Promise<AssistantProject> {
    const record = this.projectStore.get(projectId);
    if (!record) throw new AssistantError('project not found', 404);
    if (!existsSync(record.path)) throw new AssistantError("the project's directory is missing on disk", 409);
    return { id: record.id, name: record.name, path: record.path, settings: await this.projectSettings(projectId) };
  }

  /** A project's runs are listed while it is imported, whatever its directory's state. */
  assistantProjectExists(projectId: string): void {
    if (!this.projectStore.get(projectId)) throw new AssistantError('project not found', 404);
  }

  private assistantScope(project: AssistantProject, scope: 'project' | 'user'): ConfigScope {
    return scope === 'project' ? projectScope(project.path) : userScope(this.config);
  }

  /**
   * What a run is handed beside its directory. Each part is read on its own and a part that cannot be
   * read counts as none: the run can still read the directory, which is what it is for.
   */
  private async assistantKnown(project: AssistantProject): Promise<AssistantKnown> {
    const quiet = async <T>(read: () => Promise<T> | T, fallback: T): Promise<T> => {
      try {
        return await read();
      } catch {
        return fallback;
      }
    };
    const scope = projectScope(project.path);
    const [memory, agents, skills, commands, sessions] = await Promise.all([
      quiet(() => this.memory.list(encodeProjectId(project.path)), []),
      quiet(async () => (await this.resources.list(scope, 'agents')).map((r) => r.name), [] as string[]),
      quiet(async () => (await this.resources.list(scope, 'skills')).map((r) => r.name), [] as string[]),
      quiet(async () => (await this.resources.list(scope, 'commands')).map((r) => r.name), [] as string[]),
      quiet(() => this.sessions.listSessions(encodeProjectId(project.path)), []),
    ]);
    const journal = await quiet(() => this.journal.handoff(project.id), { text: '', entries: 0, bytes: 0, lessons: 0, lessonBytes: 0 });
    const items = await quiet(() => this.workItems.list({ projectId: project.id }), []);
    const milestones = await quiet(() => this.workItems.milestones(project.id).filter((m) => m.state === 'open').map((m) => m.name), [] as string[]);
    const commits = !(await isGitRepoAsync(project.path)) ? null : await quiet(async () => Number(await gitAsyncText(project.path, ['rev-list', '--count', 'HEAD'], 10_000)) || 0, 0);
    const chats = [...sessions].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const instructions = await quiet(async () => {
      const file = join(project.path, 'CLAUDE.md');
      return existsSync(file) ? await readFile(file, 'utf8') : null;
    }, null);
    return {
      facts: {
        memoryFiles: memory.length,
        journalEntries: journal.entries,
        workItems: items.length,
        milestones,
        teamMembers: project.settings.team?.members.length ?? 0,
        resources: [...agents, ...skills, ...commands],
        chats: chats.length,
        commits,
      },
      journal: journal.text,
      chats: chats.map((c) => (c.firstPrompt ?? c.title).replace(/\s+/g, ' ').trim().slice(0, 140)).filter(Boolean),
      // No rules are listed yet: the assistant proposes them only once the rules resource is built
      resources: { agents, skills, commands, rules: [] },
      instructions,
      git: await quiet(() => assistantGit(project.path), null),
    };
  }

  /**
   * Starts an assistant run's chat in the project's directory: confined to the read tools (the only
   * ones it has, kept to the directory) in `dontAsk`, with no settings source, MCP server, preset or
   * uploads directory, the journal and CLAUDE.md appended but never recorded, the result held to the
   * run's schema, and one turn. A run a restart cut off continues in its own chat, confined again.
   */
  private async launchAssistantRun(launch: AssistantLaunch, onStart: (chatId: string, provider?: ProviderId, effort?: Effort | null) => void): Promise<void> {
    const resumed = launch.resumeChatId ? this.runtime.get(launch.resumeChatId) : null;
    // A run with no shell cannot push, and says so
    const policy: ToolPolicy = { ...launch.policy, gitPush: 'deny' };
    const options = {
      model: launch.model ?? undefined,
      ...effortOption(this.effortPassed(launch.effort)),
      appendSystemPrompt: launch.appendSystemPrompt || undefined,
      permissionMode: launch.permissionMode,
      allowedTools: launch.allowedTools,
      disallowedTools: launch.disallowedTools,
      toolPreset: null,
      mcp: { servers: [] },
      permissionPrompts: 'none' as const,
    };
    const confine: ChatConfinement = { tools: launch.tools, settingSources: [] };
    // Not recorded, as for a member's run: the CLI would otherwise send the run's prompt, rendered
    // for a confined session, to a person who continues the chat after the run
    const extras = { jsonSchema: launch.jsonSchema, keepAlive: false, confine, systemPromptSnapshot: 'off' as const, purpose: 'assistant' as const };
    if (launch.resumeChatId) {
      onStart(launch.resumeChatId, LEGACY_PROVIDER, this.effortPassed(options.effort) ?? (resumed ? usedEffort(resumed) : null));
      await this.chats.resume(launch.resumeChatId, { ...options, prompt: launch.prompt }, extras);
      return;
    }
    await this.chats.create({ ...options, ...extras, provider: LEGACY_PROVIDER, policy, prompt: launch.prompt, cwd: launch.cwd }, (started) => onStart(started.id, LEGACY_PROVIDER, usedEffort(started)));
  }

  /** The effort a chat starts with, from what was asked: none when it is not one of the levels. */
  private effortPassed(effort: string | null | undefined): Effort | null {
    return isEffort(effort) ? effort : null;
  }

  /**
   * A member the assistant proposed, added through the team service. When the run wrote its own
   * instructions, their file is written first, where no file of that name exists, so the team keeps
   * it as the person's; if the team then refuses the member, the file goes with it.
   */
  private async addAssistantMember(project: AssistantProject, member: ProjectTeamMember, content: string | null): Promise<void> {
    const dir = join(project.path, '.claude', 'agents');
    const file = join(dir, `${member.agent}.md`);
    let wrote = false;
    if (content !== null && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(member.agent) && !existsSync(file)) {
      await mkdir(dir, { recursive: true });
      try {
        await writeFile(file, content, { flag: 'wx' });
        wrote = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    try {
      await this.team.putMember(project.id, member.agent, { ...member, createFile: true });
    } catch (err) {
      if (wrote) await rm(file, { force: true });
      throw err;
    }
  }

  /**
   * A chat Claudio started for a run of its own, the flow's or the assistant's: a person who
   * continues it gets it back without the run's rules (`ChatService.resume`).
   */
  private memberChat(chatId: string): boolean {
    try {
      return this.flow.ranChat(chatId) || !!this.db.connection.prepare('SELECT 1 FROM assistant_runs WHERE chat_id = ? LIMIT 1').get(chatId);
    } catch {
      return false;
    }
  }

  /**
   * Starts a flow run's chat, as the member's agent with its model, the journal appended to the
   * system prompt, the stage's rules and budget, and the result held to the run's schema. Working
   * and verifying happen in the item's own worktree, which first gets the item's tied documents from
   * the checkout, where the refine wrote them (`syncItemDocuments`); refining in the checkout. A
   * Developer's run continues its own chat from an earlier round, or starts one if that chat cannot
   * be continued; a run a restart cut off continues in its chat or fails.
   */
  private async launchFlowRun(launch: FlowLaunch, onStart: (chatId: string, provider?: ProviderId, effort?: Effort | null) => void): Promise<void> {
    const { item, member, run } = launch;
    const record = this.requireProject(item.projectId);
    if (!existsSync(record.path)) throw new Error(`the project's directory ${record.path} is missing`);
    const resumed = launch.resumeChatId ? this.runtime.get(launch.resumeChatId) : null;
    // The member's own, else what the guides recommend for its model at this stage
    const effort = resolveEffort(run.stage, member.model, member.effort);
    const agentsFile = await this.flowAgentsFile(record.path, member);
    const place = launch.inWorktree ? itemWorktree(record.path, item) : null;
    if (place && (place.worktree !== item.worktree || place.branch !== item.branch)) {
      this.workItems.setWorktree(item.id, { worktree: place.worktree, branch: place.branch });
    }
    let prompt = launch.prompt;
    if (place) {
      // Before any chat: a resumed Developer's chat, or one a restart cut off, needs the spec too
      const settings = await this.projectSettings(item.projectId);
      const sync = await syncItemDocuments({
        item,
        links: this.workItems.links(item.id),
        projectPath: record.path,
        documentsRoot: settings.documents?.path ?? DEFAULT_DOCUMENTS_PATH,
        place,
      }).catch((err: unknown) => {
        throw new ItemDocumentsError(`the item's documents could not be brought into its worktree: ${err instanceof Error ? err.message : String(err)}`);
      });
      for (const s of sync.skipped) console.warn(`[flow] ${item.key}: document ${s.path} not brought into the worktree: ${s.reason}`);
      const line = documentsLine(sync.present);
      // The short "carry on" prompt of a restart keeps to itself: the chat was already told
      if (line && !launch.continuing) prompt = withDocumentsLine(prompt, line);
    }
    // Guarded or not by the stage's override, the project and the global settings; a guard that cannot run fails the run before a chat exists
    const guards = await this.guardLauncher.prepare({
      kind: 'flow',
      stage: run.stage,
      cwd: place?.cwd ?? record.path,
      worktree: place?.cwd ?? null,
      mainCheckout: record.path,
      project: await this.projectSettings(item.projectId),
      policy: { commands: launch.policy.commands.allow !== 'none', edits: launch.policy.edit.allow !== 'none' },
    });
    const options = {
      model: member.model,
      ...effortOption(effort),
      appendSystemPrompt: launch.appendSystemPrompt || undefined,
      permissionMode: launch.permissionMode,
      allowedTools: launch.allowedTools,
      disallowedTools: launch.disallowedTools,
      ...(launch.maxBudgetUsd !== null ? { maxBudgetUsd: launch.maxBudgetUsd } : {}),
      toolPreset: null,
      permissionPrompts: 'none' as const,
    };
    const extras = { agent: member.agent, agentsFile, jsonSchema: launch.jsonSchema, systemPromptSnapshot: 'off' as const, uploads: false as const, keepAlive: false, purpose: 'flow' as const, lessons: 'handoff' as const };
    const link = (chatId: string): void => {
      try {
        this.workItems.link(item.id, { kind: 'chat', role: run.stage, chatId, teamRole: member.role }, { actor: { kind: 'agent', role: member.role } });
      } catch {
        // The run knows its chat, and its result still lands; only the item's list of chats misses it
      }
    };
    if (launch.resumeChatId && launch.compactFirst) {
      // Before onStart, so the run never sees the compaction's chat, result or exit. It runs under the
      // run's own policy and budget (so a push stays denied), and never fails the run: one that does
      // not happen leaves the chat as it was
      await this.context.compactAndWait(launch.resumeChatId, { flowRunId: run.id, options: { ...options, agent: member.agent, agentsFile, guards } });
    }
    if (launch.resumeChatId) {
      const chatId = launch.resumeChatId;
      // Told first: the result is matched to the run by its chat, and may not wait for the resume to return
      // A chat goes on with the last execution's effort unless the run gives one
      onStart(chatId, LEGACY_PROVIDER, this.effortPassed(options.effort) ?? (resumed ? usedEffort(resumed) : null));
      try {
        await this.chats.resume(chatId, { ...options, prompt }, { ...extras, guards });
        link(chatId);
        return;
      } catch (err) {
        // A new chat would know nothing of the run it is meant to carry on
        if (launch.continuing) throw err;
        // otherwise falls through to a chat of its own
      }
    }
    await this.chats.create(
      { ...options, ...extras, provider: LEGACY_PROVIDER, policy: launch.policy, prompt, cwd: place?.cwd ?? record.path },
      (started) => {
        onStart(started.id, LEGACY_PROVIDER, usedEffort(started));
        link(started.id);
      },
      undefined,
      guards,
    );
  }

  /** A person's chat in `cwd`: guarded when its project opted in. Null leaves it as it always ran. */
  private async guardsForChat(cwd: string): Promise<ChatGuardPlan | null> {
    const project = this.projectOf(resolve(cwd)).project;
    if (!project) return null;
    const settings = await this.projectSettings(project.id);
    return this.guardLauncher.prepare({ kind: 'chat', cwd: resolve(cwd), mainCheckout: this.projectStore.get(project.id)?.path ?? null, project: settings, interactive: true });
  }

  /**
   * The member's definition for `--agents`, from the agent file in the project's checkout: the item's
   * worktree only has the agent files that were committed, and the file a person edits in Claudio is
   * the one that should run. It carries what the file says of the agent (its tools, the tools it is
   * denied, as a list in either YAML form) and the member's model, which is Claudio's to set, so a
   * file's `model` never runs a role on a model its screen does not show. Named by its content, so
   * the same definition is one file.
   */
  private async flowAgentsFile(projectPath: string, member: ProjectTeamMember): Promise<string> {
    const { agent } = member;
    const source = join(projectPath, '.claude', 'agents', `${agent}.md`);
    let content: string;
    try {
      content = await readFile(source, 'utf8');
    } catch {
      throw new Error(`the agent file .claude/agents/${agent}.md is missing: write it again from the Team screen`);
    }
    return agentsDefinitionFile(content, agent, member.model, join(this.config.dataDir, 'flow-agents'));
  }

  // ---------- work items ----------
  //
  // A project whose Board module is off keeps its items, and they stay readable so nothing looks
  // lost; what it refuses is a change. A project removed from Claudio keeps them too, for the day
  // its directory is imported again, but it is not a place anything is created in.

  /**
   * The settings of a project its work items are read or written in. A write needs the project
   * imported and its Board module on; a read only needs it imported.
   */
  async workItemProject(projectId: string, access: 'read' | 'write'): Promise<ProjectSettings> {
    const settings = await this.projectSettings(projectId);
    if (access === 'write' && !settings.modules.includes('board')) {
      throw new WorkItemError("the Board module is off in this project: switch it on in the project's settings to change its work items", 409);
    }
    return settings;
  }

  /**
   * The documents folder of an imported project. A write needs its Documents module on; a read does
   * not, as the board's reads do not need the Board module.
   */
  private async documentsPlace(projectId: string, access: 'read' | 'write'): Promise<DocumentsPlace> {
    const record = this.requireProject(projectId);
    const settings = await this.projectSettings(projectId);
    if (access === 'write' && !settings.modules.includes('documents')) {
      throw new DocumentError("the Documents module is off in this project: switch it on in the project's settings to change its documents", 409);
    }
    return { projectPath: record.path, root: settings.documents?.path ?? DEFAULT_DOCUMENTS_PATH };
  }

  /** What `MergeService` needs for one row of either table: the host's calls, and the checkouts the branch lives in */
  private async mergeTarget(id: string): Promise<MergeTarget | null> {
    const base = await this.changeRequests.target(id);
    if (!base) return null;
    const sql = this.db.connection;
    const item = sql.prepare('SELECT host, item_id, project_id FROM work_item_pull_requests WHERE id = ?').get(id) as { host: string; item_id: string; project_id: string } | undefined;
    if (item) {
      const adapter = codeHostAdapter(hostOf(item.host));
      if (!adapter) return null;
      const record = this.projectStore.get(item.project_id);
      const work = this.workItems.find(item.item_id);
      // Only a worktree the item already has: reading a merge state makes no branch and no checkout
      const worktree = record && work ? existingItemWorktree(record.path, work) : null;
      const target = mergeTargetOf(base, hostOf(item.host), adapter, record ? { home: mainCheckout(record.path), worktree } : null);
      target.busy = () => this.itemBusy(item.item_id);
      return target;
    }
    const orch = sql.prepare('SELECT host, orchestration_id, cwd FROM orchestration_pull_requests WHERE id = ?').get(id) as { host: string; orchestration_id: string; cwd: string } | undefined;
    if (!orch) return null;
    const adapter = codeHostAdapter(hostOf(orch.host));
    if (!adapter) return null;
    const worktree = this.orchestrator.get(orch.orchestration_id)?.integration?.worktree ?? null;
    const target = mergeTargetOf(base, hostOf(orch.host), adapter, { home: mainCheckout(orch.cwd), worktree: worktree && existsSync(worktree) ? worktree : null });
    // The integration worktree is in use while the fixer Claudio started for this request works in it
    target.busy = () => Boolean(sql.prepare("SELECT 1 FROM orchestration_pull_requests WHERE id = ? AND fix_state = 'fixing'").get(id));
    return target;
  }

  /** A chat or a run is working on the item: what a push or a rewrite of its branch must not meet */
  private itemBusy(itemId: string): boolean {
    if (this.flow.itemRunning(itemId)) return true;
    return this.workItems.links(itemId).some((l) => l.role === 'work' && (l.chatState === 'working' || l.chatState === 'waiting' || l.taskStatus === 'running'));
  }

  /** The item, after the same check on the project it belongs to. Reads of a removed project's items still work. */
  async workItemAccess(itemId: string, access: 'read' | 'write'): Promise<WorkItem> {
    const item = this.workItems.find(itemId);
    if (!item) throw new WorkItemError('work item not found', 404);
    await this.ownerAccess(item.projectId, access);
    return item;
  }

  /** The milestone, after the same check on its project. */
  async milestoneAccess(milestoneId: string, access: 'read' | 'write'): Promise<Milestone> {
    const milestone = this.workItems.milestone(milestoneId);
    await this.ownerAccess(milestone.projectId, access);
    return milestone;
  }

  private async ownerAccess(projectId: string, access: 'read' | 'write'): Promise<void> {
    if (this.projectStore.get(projectId)) await this.workItemProject(projectId, access);
    else if (access === 'write') throw new WorkItemError('its project is not imported: import the directory again to change it', 409);
  }

  /**
   * The All projects list: the items of every imported project whose Board module is on, as cards
   * (descriptions left out).
   */
  async allWorkItems(filter: Omit<WorkItemFilter, 'projectId'> = {}): Promise<WorkItem[]> {
    return this.workItems.cards(filter, await this.boardProjects());
  }

  /** The All projects list a page at a time. */
  async allWorkItemsPage(filter: Omit<WorkItemFilter, 'projectId'> = {}, query: WorkItemPageQuery = {}): Promise<WorkItemPage> {
    return this.workItems.page(filter, query, await this.boardProjects());
  }

  /**
   * The All projects board, counted over the projects shown only: the store's own counts would take
   * in the hidden ones, projects removed or with their board off.
   */
  async allWorkItemsBoard(filter: Omit<WorkItemFilter, 'projectId'> = {}, query: BoardQuery = {}): Promise<Board> {
    return this.workItems.board(null, filter, query, await this.boardProjects());
  }

  /**
   * The item a key names, with its page. An imported project's item wins over a removed project's
   * that had the same prefix; a removed project's item is still found when it is the only one, as
   * it is still readable by id.
   */
  async workItemByKey(key: string): Promise<WorkItemDetail> {
    const imported = new Set(this.projectStore.list().map((p) => p.id));
    const found = this.workItems.withKey(key);
    const item = found.find((i) => imported.has(i.projectId)) ?? found[0];
    if (!item) throw new WorkItemError('work item not found', 404);
    return this.workItemDetail(item.id);
  }

  private async boardProjects(): Promise<Set<string>> {
    const records = this.projectStore.list();
    const settings = await this.projectSettingsStore.readAll(records);
    return new Set([...settings].filter(([, s]) => s.modules.includes('board')).map(([id]) => id));
  }

  /**
   * What a link points at now, from what this process holds in memory: a chat it runs, a task of an
   * orchestration it knows. A chat that is not live here reads with no name and no state.
   */
  private workItemLinkState(link: WorkItemLink): WorkItemLinkState | null {
    const chat = link.chatId ? this.runtime.get(link.chatId) : null;
    const chatState = chat ? stateFromRun({ status: chat.status, pendingPrompts: chat.pendingPrompts }) : null;
    if (link.kind === 'orchestration' && link.orchestrationId) {
      const task = this.orchestrator.get(link.orchestrationId)?.tasks.find((t) => t.id === link.taskId);
      return { name: task?.name ?? null, taskStatus: task?.status ?? null, chatState };
    }
    return { name: chat ? chatLinkName(chat) : null, chatState };
  }

  /**
   * A chat link this process does not run (a terminal chat an item was created from, say) read from
   * the chat list, which is asynchronous and so cannot be what the store fills links with.
   */
  private async namedLinks(links: WorkItemLink[]): Promise<WorkItemLink[]> {
    return Promise.all(
      links.map(async (link) => {
        if (link.kind !== 'chat' || !link.chatId || link.name) return link;
        const chat = await this.chats.summaryOf(link.chatId).catch(() => null);
        return chat ? { ...link, name: chat.title, chatState: chat.state } : link;
      }),
    );
  }

  /**
   * The history with every chat named by its title. A chat link's entry is written with the name
   * this process knew, and a chat it does not run (a terminal chat an item was created from) had
   * none then, so it was written as `chat <id>`: its title is looked up now, when it is read.
   */
  private async namedHistory(entries: WorkItemHistoryEntry[]): Promise<WorkItemHistoryEntry[]> {
    const unnamed = (value: WorkItemHistoryValue): string | null => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !('label' in value) || 'key' in value) return null;
      return /^chat (\S+)$/.exec(value.label)?.[1] ?? null;
    };
    const ids = [...new Set(entries.filter((e) => e.change === 'link').flatMap((e) => [unnamed(e.from), unnamed(e.to)]).filter((id): id is string => !!id))];
    if (!ids.length) return entries;
    const titles = new Map<string, string>();
    await Promise.all(
      ids.map(async (id) => {
        const title = (await this.chats.summaryOf(id).catch(() => null))?.title?.trim();
        if (title) titles.set(id, title);
      }),
    );
    const named = (value: WorkItemHistoryValue): WorkItemHistoryValue => {
      const id = unnamed(value);
      const title = id ? titles.get(id) : undefined;
      return title && value && typeof value === 'object' && 'label' in value ? { ...value, label: title } : value;
    };
    return entries.map((e) => (e.change === 'link' ? { ...e, from: named(e.from), to: named(e.to) } : e));
  }

  /** `GET /work-items/:itemId/history`, with every chat named. */
  async workItemHistory(itemId: string): Promise<WorkItemHistoryEntry[]> {
    await this.workItemAccess(itemId, 'read');
    return this.namedHistory(this.workItems.history(itemId));
  }

  /** The item's page, with every link and every chat of its history named. */
  async workItemDetail(itemId: string): Promise<WorkItemDetail> {
    await this.workItemAccess(itemId, 'read');
    const detail = this.workItems.get(itemId);
    const path = this.projectStore.get(detail.projectId)?.path;
    const [links, history, pullRequestReadiness] = await Promise.all([
      this.namedLinks(detail.links),
      this.namedHistory(detail.history),
      path ? this.pullRequests.readiness(path).catch(() => null) : Promise.resolve(null),
    ]);
    return { ...detail, links, history, pullRequestReadiness };
  }

  /**
   * A project's board, with whether approving opens a pull request and how its checkout stands
   * against the default branch: both from git and gh, the second from local git only.
   */
  async workItemBoard(projectId: string, filter: Omit<WorkItemFilter, 'projectId'> = {}, query: BoardQuery = {}): Promise<Board> {
    await this.workItemProject(projectId, 'read');
    const board = this.workItems.board(projectId, filter, query);
    const path = this.projectStore.get(projectId)?.path;
    const readiness = path ? await this.pullRequests.readiness(path).catch(() => null) : null;
    const checkout = path && readiness?.status === 'ready' && readiness.defaultBranch ? this.pullRequests.checkout(path, readiness.defaultBranch) : null;
    return { ...board, pullRequestReadiness: readiness, checkout };
  }

  /** `GET /projects/:id/code-host`: whether the project can open change requests, and where `origin` points. Null for a project that is not imported. */
  async projectCodeHost(projectId: string): Promise<ProjectCodeHost | null> {
    const record = this.projectStore.get(projectId);
    return record ? this.pullRequests.codeHost(record.path) : null;
  }

  /** `POST /work-items/:itemId/pull-request`: the person's approval opens the item's pull request. */
  async approveWorkItem(itemId: string): Promise<ApproveResult> {
    await this.workItemAccess(itemId, 'write');
    return this.pullRequests.approve(itemId);
  }

  /** A webhook delivery named these change requests: each is read on the pacer's next pass. Nothing else changes. */
  nudgeChangeRequests(ids: readonly string[]): void {
    for (const id of ids) this.pullRequestWatcher.nudge(id);
  }

  /** `POST /work-items/:itemId/pull-request/refresh`: asks the host about the item's open PR now. */
  async refreshWorkItemPullRequest(itemId: string): Promise<WorkItem> {
    await this.workItemAccess(itemId, 'read');
    return this.pullRequests.refresh(itemId);
  }

  async workItemLinks(itemId: string): Promise<WorkItemLink[]> {
    await this.workItemAccess(itemId, 'read');
    return this.namedLinks(this.workItems.links(itemId));
  }

  /**
   * "Work on it": a chat in the project, in the item's own worktree (made the first time, found
   * again after), prompted with the item. The chat is linked in the tick it is spawned, before any
   * of its output can arrive, so the item follows it from its very first status.
   */
  async workOnItem(itemId: string, request?: WorkOnWorkItemRequest): Promise<WorkOnWorkItemResult> {
    const item = await this.workItemAccess(itemId, 'write');
    const record = this.requireProject(item.projectId);
    this.checkWorkable(item);
    const options = startOptions(request);
    if (!existsSync(record.path)) throw new WorkItemError(`the project's directory ${record.path} is missing`, 409);
    const place = itemWorktree(record.path, item);
    if (place && (place.worktree !== item.worktree || place.branch !== item.branch)) {
      this.workItems.setWorktree(itemId, { worktree: place.worktree, branch: place.branch });
    }
    const linked: { link?: WorkItemLink } = {};
    const chat = await this.chats.create({ ...options, prompt: workItemPrompt(item), cwd: place?.cwd ?? record.path }, (started) => {
      try {
        linked.link = this.workItems.link(itemId, { kind: 'chat', role: 'work', chatId: started.id });
      } catch (err) {
        // A chat nobody can find from its item would work unseen: it goes with the failed request
        this.runtime.stop(started.id);
        throw err;
      }
      this.workLinks.chatStarted(started.id);
    });
    if (!linked.link) throw new ChatStartError('the chat started without being linked to its work item');
    return { item: this.workItems.find(itemId) ?? item, chat, link: linked.link };
  }

  /**
   * What "Work on it", a draft and a launch all refuse, the same way: an epic, which groups work
   * rather than being it; an item in done, which nothing an agent does may take out of it; and an
   * item a chat or a node is working on now, which a second one would pull two ways.
   */
  private checkWorkable(item: WorkItem, label = ''): void {
    if (item.type === 'epic') throw new WorkItemError(`${label}${item.key} is an epic, which groups work items: work on one of them instead`, 400);
    if (item.status === 'done') throw new WorkItemError(`${label}${item.key} is already done: move it back first to work on it again`, 409);
    const busy = this.workItems.links(item.id).find((l) => l.role === 'work' && (l.chatState === 'working' || l.chatState === 'waiting' || l.taskStatus === 'running'));
    if (busy) throw new WorkItemError(`${label}${item.key} is already being worked on${busy.name ? ` by ${busy.name}` : ''}`, 409);
  }

  /**
   * The graph a selection of one project's items becomes, for the person to review: nothing is
   * launched. The existing launch route takes it as it is and links each node to its item.
   */
  async orchestrateWorkItems(projectId: string, request?: OrchestrateWorkItemsRequest, language: ClaudioLanguage = 'en'): Promise<WorkItemOrchestrationDraft> {
    await this.workItemProject(projectId, 'write');
    const record = this.requireProject(projectId);
    const ids: unknown = request?.itemIds;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string')) {
      throw new WorkItemError('itemIds must list the work items to orchestrate', 400);
    }
    if (new Set(ids).size !== ids.length) throw new WorkItemError('a work item is selected twice', 400);
    const items = (ids as string[]).map((id) => {
      const item = this.workItems.find(id);
      if (!item || item.projectId !== projectId) throw new WorkItemError(`${id} is not a work item of this project`, 400);
      this.checkWorkable(item);
      return item;
    });
    return orchestrationDraft(record, items, canBranch(record.path), language);
  }

  /**
   * Launches a graph. A node that names a work item must name one that may be changed, and only one
   * node per item: the item follows its node, and two nodes would pull it two ways.
   */
  async launchOrchestration(spec: OrchestrationSpec): Promise<Orchestration> {
    await this.checkWorkItemNodes(spec?.tasks, spec?.cwd);
    return this.orchestrator.create(spec);
  }

  /** A relaunch names its items as the first launch did, and is held to the same checks. */
  async relaunchOrchestration(id: string, changes: RelaunchOrchestrationRequest = {}): Promise<Orchestration> {
    const spec = this.orchestrator.relaunchSpec(id, changes);
    await this.checkWorkItemNodes(spec.tasks, spec.cwd);
    return this.orchestrator.create(spec, { relaunchedFrom: id });
  }

  private async checkWorkItemNodes(tasks: unknown, cwd: unknown): Promise<void> {
    const seen = new Set<string>();
    for (const task of Array.isArray(tasks) ? (tasks as Array<Partial<OrchestrationSpec['tasks'][number]> | null>) : []) {
      if (!task || typeof task !== 'object' || Array.isArray(task)) throw new WorkItemError('every task must be an object with an id and a prompt', 400);
      const itemId: unknown = task?.workItemId;
      if (itemId === undefined) continue;
      const label = `task '${String(task?.id)}'`;
      if (typeof itemId !== 'string' || !itemId) throw new WorkItemError(`${label}: workItemId must name a work item`, 400);
      if (seen.has(itemId)) throw new WorkItemError(`${label}: another node already works on that work item`, 400);
      seen.add(itemId);
      const item = this.workItems.find(itemId);
      if (!item) throw new WorkItemError(`${label}: work item ${itemId} not found`, 400);
      await this.ownerAccess(item.projectId, 'write');
      // A node moves its item as it works, so it must work in the item's project: a link made by
      // hand is held to the same
      const dir = typeof task.cwd === 'string' && task.cwd ? task.cwd : typeof cwd === 'string' && cwd ? cwd : this.config.workspaceDir;
      if (this.projectOf(resolve(dir)).project?.id !== item.projectId) {
        throw new WorkItemError(`${label}: ${item.key} is a work item of another project, and the graph does not run in its project`, 400);
      }
      // As "Work on it" is held to: a launch is the other way to put an agent on the item
      this.checkWorkable(item, `${label}: `);
    }
  }

  /**
   * A chat or a task linked to an item by hand. It must exist and belong to the item's project:
   * a link to nothing reads as work that is not there, and one to another project's chat would move
   * the item with work done elsewhere.
   */
  async linkWorkItem(itemId: string, request: CreateWorkItemLinkRequest): Promise<WorkItemLink> {
    const item = await this.workItemAccess(itemId, 'write');
    const input: Partial<Record<keyof CreateWorkItemLinkRequest, unknown>> = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
    if (input.kind === 'chat' && typeof input.chatId === 'string' && input.chatId) {
      const chat = await this.chats.summaryOf(input.chatId);
      if (!chat) throw new WorkItemError(`chat ${input.chatId} not found`, 400);
      if (chat.project?.id !== item.projectId) throw new WorkItemError(`chat ${input.chatId} is not a chat of this item's project`, 400);
    }
    if (input.kind === 'orchestration' && typeof input.orchestrationId === 'string' && input.orchestrationId) {
      const orch = this.orchestrator.get(input.orchestrationId);
      if (!orch) throw new WorkItemError(`orchestration ${input.orchestrationId} not found`, 400);
      if (typeof input.taskId === 'string' && !orch.tasks.some((t) => t.id === input.taskId)) {
        throw new WorkItemError(`orchestration ${orch.name} has no task ${input.taskId}`, 400);
      }
      if (this.projectOf(orch.cwd).project?.id !== item.projectId) throw new WorkItemError(`orchestration ${orch.name} does not run in this item's project`, 400);
    }
    return this.workItems.link(itemId, request);
  }

  /** "Create a task from this message": an item in `backlog` of the chat's project, linked to the chat it came from. */
  async workItemFromMessage(chatId: string, request?: CreateWorkItemFromMessageRequest): Promise<WorkItem> {
    const text: unknown = request?.text;
    if (typeof text !== 'string' || !text.trim()) throw new WorkItemError('text is required: the message the task is made from', 400);
    const chat = await this.chats.summaryOf(chatId);
    if (!chat) throw new Error('chat not found');
    const projectId = chat.project?.id;
    if (!projectId) throw new WorkItemError('this chat is not in an imported project, so there is no board to add the task to', 409);
    await this.workItemProject(projectId, 'write');
    const cause: WorkItemCause = {
      kind: 'chat',
      chatId,
      orchestrationId: chat.orchestration?.id ?? null,
      taskId: chat.orchestration?.taskId ?? null,
      event: WORK_CAUSE.message,
    };
    const item = this.workItems.create(
      projectId,
      {
        title: typeof request?.title === 'string' && request.title.trim() ? request.title : titleFromMessage(text),
        description: text,
        status: 'backlog',
        ...(request?.type !== undefined ? { type: request.type } : {}),
        ...(request?.priority !== undefined ? { priority: request.priority } : {}),
      },
      { cause },
    );
    this.workItems.link(item.id, { kind: 'chat', role: 'origin', chatId }, { cause });
    return this.workItems.find(item.id) ?? item;
  }

  /**
   * Where an orchestration's time went, computed now from the graph and the executions of the chats
   * Claudio started for it. Null for an unknown id.
   */
  orchestrationTimings(id: string): OrchestrationTimings | null {
    const orch = this.orchestrator.get(id);
    if (!orch) return null;
    return orchestrationTimings(orch, this.runtime.list().filter((c) => c.orchestrationId === id), new Date(), this.reviewRounds(id));
  }

  // ---------- review gate ----------

  /** The rounds a graph's review ran, oldest first; none for a graph without a review */
  reviewRounds(id: string): ReviewRound[] {
    return this.reviewStore.rounds(id);
  }

  /**
   * The review gate of a graph: its summary, every round, and one page of the findings of a round (the
   * latest unless `round` names another). Null for an unknown id.
   */
  reviewDetail(id: string, query: { round?: number; blocking?: boolean; limit?: number; offset?: number } = {}): ReviewGateDetail | null {
    const orch = this.orchestrator.get(id);
    if (!orch) return null;
    const rounds = this.reviewStore.rounds(id);
    const chosen = query.round === undefined ? rounds.at(-1) : rounds.filter((r) => r.round === query.round).at(-1);
    const page = chosen
      ? this.reviewStore.findings(chosen.id, { limit: query.limit ?? 50, offset: query.offset ?? 0, ...(query.blocking !== undefined ? { blocking: query.blocking } : {}) })
      : { findings: [], total: 0 };
    return { state: orch.verification?.review ?? null, rounds, findings: page.findings, totalFindings: page.total };
  }

  acceptReview(id: string, reason: string, actor: string): Orchestration {
    return this.orchestrator.acceptReview(id, reason, actor);
  }

  retryReview(id: string): Orchestration {
    return this.orchestrator.retryReview(id);
  }

  /** Which text each reviewer role runs with in a project: its own file or Claudio's built-in */
  async reviewRoles(projectId: string): Promise<ReviewRoleInfo[] | null> {
    const project = this.projectStore.get(projectId);
    if (!project) return null;
    return Promise.all(
      REVIEW_ROLES.map(async (role): Promise<ReviewRoleInfo> => {
        const r = await readRole(project.path, role);
        return { role, file: `.claude/agents/${roleFileName(role)}`, source: r.source, sha: r.sha, bytes: Buffer.byteLength(r.body), problem: r.problem };
      }),
    );
  }

  /**
   * Writes the built-in text of a role into the project's checkout, only where no file exists (`wx`),
   * as the team's agent files are written: a person's file is never overwritten. Null for an unknown project.
   */
  async writeReviewRole(projectId: string, role: ReviewRole): Promise<{ written: boolean; file: string } | null> {
    const project = this.projectStore.get(projectId);
    if (!project) return null;
    const file = `.claude/agents/${roleFileName(role)}`;
    const full = join(project.path, file);
    await mkdir(dirname(full), { recursive: true });
    try {
      await writeFile(full, `${DEFAULT_ROLE_BODIES[role]}\n`, { flag: 'wx' });
      return { written: true, file };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { written: false, file };
      throw err;
    }
  }

  /** The items a chat worked on or created, for its header. Those of projects no longer imported are left out. */
  workItemsOfChat(chatId: string): WorkItem[] {
    const imported = new Set(this.projectStore.list().map((p) => p.id));
    const ids = [...new Set(this.workItems.linksOfChat(chatId).map((l) => l.itemId))];
    return this.workItems.cardsOf(ids).filter((item) => imported.has(item.projectId));
  }

  /** What the item's own branch changed, read as a chat's worktree is. */
  async workItemChanges(itemId: string, scope: ChangeScope = {}): Promise<WorkItemChanges> {
    const item = await this.workItemAccess(itemId, 'read');
    const path = this.projectStore.get(item.projectId)?.path ?? item.worktree ?? '';
    // The scope-drift point flags in the background; the page never waits for it
    if (!scope.commit && !scope.uncommitted) {
      void this.changes.scopeDrift(path, item, { id: item.id, projectId: item.projectId, title: item.title, criteria: item.acceptanceCriteria.map((c) => c.text) });
    }
    return { worktree: item.worktree, branch: item.branch, summary: await this.changes.itemChanges(path, item, scope) };
  }

  async workItemDiff(itemId: string, path: string, opts: DiffOptions = {}): Promise<FileDiff> {
    const item = await this.workItemAccess(itemId, 'read');
    return this.changes.itemDiff(this.projectStore.get(item.projectId)?.path ?? item.worktree ?? '', item, path, opts);
  }

  /**
   * A project and its chats, oldest first, for an export written one chat at a time. An unknown
   * project fails here, before anything is written, so it can still be answered with a 404.
   */
  async projectExport(id: string): Promise<ProjectExportSource> {
    const project = await this.projectView(id);
    const chats = (await this.chats.list({ project: id, origins: EXPORTED_ORIGINS })).sort(byStart);
    return { exportedAt: new Date().toISOString(), project, chats, load: (chatId) => this.chats.export(chatId) };
  }

  private async projectView(id: string): Promise<Project> {
    const project = (await this.projects()).find((p) => p.id === id);
    if (!project) throw new Error('project not found');
    return project;
  }

  async overview(): Promise<Overview> {
    // The same lists the screens show, so a count can never disagree with the page it links to; read
    // in one pass, not once per kind
    const [system, chats, { tasks, subagents, workflows }] = await Promise.all([
      this.system(),
      this.chats.list({ origins: ['claudio', 'external', 'orchestration'] }),
      this.chats.allActivity(),
    ]);
    return {
      system,
      limits: this.limitReadings(),
      accounts: this.accountsSnapshot(),
      counts: {
        projects: this.projectStore.list().length,
        chats: chats.length,
        chatsWorking: chats.filter((c) => c.state === 'working').length,
        chatsWaiting: chats.filter((c) => c.state === 'waiting').length,
        backgroundTasks: tasks.filter((t) => t.status === 'running').length,
        subagents: subagents.filter((s) => s.status === 'running').length,
        workflows: workflows.filter((w) => w.status === 'running').length,
        orchestrationsRunning: this.orchestrator.runningCount(),
      },
      recentChats: chats.slice(0, 10),
    };
  }

  /** What the dashboard shows of the accounts: how many can take work, and the one new work would start on. */
  private accountsSnapshot(): AccountsSnapshot {
    const list = this.accounts.listed();
    const ready = list.filter((a) => a.enabled && a.signedIn);
    return { total: list.length, ready: ready.length, current: this.accountInUse()?.id ?? null };
  }

  /** A signed-in account other than the CLI's own login, when there is one: Claude can run on it though the CLI itself is signed out. */
  private readyAccountLabel(): string | null {
    const found = this.accounts.list().find((a) => a.id !== DEFAULT_ID && a.enabled && a.signedIn);
    return found ? (found.alias ?? found.email ?? found.id) : null;
  }

  /**
   * Asks the CLI for the real usage of the accounts (`get_usage`, no turn): who they are for a login
   * account, then their windows, per-model limits and credits. One account at a time, each with its
   * own timeout, so one that hangs costs the others nothing. With `ids` only those are read (an
   * unknown id throws); otherwise every enabled one. A failure is reported per account and leaves
   * its last reading as it was.
   */
  async refreshAccountUsage(ids?: string[]): Promise<AccountsRefreshResult> {
    this.accounts.reload();
    const targets = ids ? ids.map((id) => this.accounts.get(id).id) : this.accounts.list().filter((a) => a.enabled).map((a) => a.id);
    const failed: { id: string; error: string }[] = [];
    for (const id of targets) {
      try {
        if (this.accounts.ref(id).kind === 'login') await this.accounts.refresh(id).catch(() => undefined);
        const reading = await this.accounts.fetchUsage(id);
        await this.runtime.noteAccountReading(id, reading);
        if (reading.cli?.available) await this.accounts.confirm(id);
      } catch (e) {
        failed.push({ id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { accounts: this.accounts.listed(), failed };
  }

  /** The account new work would start on, as Settings and the status bar name it; null when none can take work */
  private accountInUse(): AccountInUse | null {
    // The CLI's own login is assumed signed in until read: with no credential at all it is a ghost, not an account
    const ghost = !this.accounts.hasCredential(DEFAULT_ID);
    const id = this.accounts.pick({ current: null, ...(ghost ? { failedOn: [DEFAULT_ID] } : {}) }).account;
    const account = id ? this.accounts.list().find((a) => a.id === id) : undefined;
    if (!account) return null;
    return { id: account.id, label: account.alias ?? account.email ?? account.id, kind: account.kind, signInState: account.signInState, checkedAt: account.checkedAt };
  }

  private checkingInUse = false;
  /**
   * When each account was last checked, whatever the answer. `checkedAt` is set only by a `valid`
   * answer, so an API key, a variable or a credential `get_usage` cannot confirm would otherwise be
   * checked on every provider refresh. In memory: a restart may check once more, which is free.
   */
  private readonly inUseCheckedAt = new Map<string, number>();

  /**
   * The free check (`get_usage`) of the account in use, when it was never checked or not in the last
   * 30 minutes. It confirms a working credential; it cannot refuse one (see `checkCredential`).
   */
  private checkAccountInUse(): void {
    const inUse = this.accountInUse();
    if (!inUse || this.checkingInUse) return;
    if (inUse.checkedAt !== null && Date.now() - Date.parse(inUse.checkedAt) < ACCOUNT_CHECK_MS) return;
    const attempted = this.inUseCheckedAt.get(inUse.id);
    if (attempted !== undefined && Date.now() - attempted < ACCOUNT_CHECK_MS) return;
    this.inUseCheckedAt.set(inUse.id, Date.now());
    this.checkingInUse = true;
    void this.accounts
      .check(inUse.id)
      .catch(() => undefined)
      .finally(() => {
        this.checkingInUse = false;
      });
  }

  /**
   * Idle accounts have no stream: the CLI's own usage cache in each account dir is their last-known
   * reading, taken now and every few minutes. Best-effort, and a fresher stream reading always wins.
   */
  private watchAccounts(): void {
    const refresh = (): void => {
      for (const account of this.accounts.list()) {
        const reading = readCache(this.accounts.ref(account.id).dir);
        if (reading) void this.runtime.noteAccountReading(account.id, reading).catch(() => undefined);
      }
    };
    // An account whose sign-in was never read is skipped by `choose`: ask the CLI who it is
    const identify = (): void => {
      for (const account of this.accounts.list()) {
        if (account.kind === 'login' && !account.signedIn) void this.accounts.refresh(account.id).catch(() => undefined);
      }
    };
    const pass = (): void => {
      try {
        refresh();
        identify();
      } catch {
        // No cache is no reading, and an account that cannot be read stays as it was
      }
    };
    pass();
    this.accountsTimer = setInterval(pass, ACCOUNTS_CACHE_MS);
    this.accountsTimer.unref();
  }

  /** One reading per provider that has one, for the overview and the status bar. */
  private limitReadings(): ProviderLimit[] {
    return this.runtime.providers.list().flatMap((m) => {
      const limit = this.runtime.limits.get(m.id);
      return limit ? [limit] : [];
    });
  }

  /**
   * Stops everything this core runs. What has to happen at once happens before it returns; the
   * promise resolves once the probes and host calls it ended have exited too, which is what a
   * process about to exit waits for: one left running writes its config home after the server is
   * gone (see `ChildProcesses`). Callers that only stop the core may ignore it.
   */
  shutdown(): Promise<void> {
    this.closed = true;
    this.forgetSecrets();
    this.releaseVault();
    this.pullRequestWatcher.stop();
    // First, while the database is still open for the row that says its host left
    this.tunnel.shutdown();
    this.logins.close();
    this.lessons.stop();
    this.cliVersion.stop();
    this.release.stop();
    this.serverUpdates.close();
    this.healthMonitor.stop();
    this.providers.close();
    this.hosts.close();
    this.lessonQueue.stop();
    this.decisionResolvers.stop();
    this.decisions.stop();
    void this.evals.close().catch(() => undefined);
    this.orchestrator.close();
    this.spend.close();
    this.schedules.close();
    this.sessionsWatcher.close();
    this.changeWatcher.close();
    this.permissions.close();
    this.push.close();
    if (this.accountsTimer) clearInterval(this.accountsTimer);
    this.sampler?.stop();
    this.rotation.close();
    // The rows that say the shells ended are written before this returns, while the database is open
    void this.terminals.shutdown();
    void this.collaborators.dispose();
    this.runtime.stopAll();
    this.db.close();
    return this.children.close();
  }
}
