import { randomUUID } from 'node:crypto';
import { PERMISSION_MODES, type ContextDetail, type LiveMcpServer, type ModelOption, type PermissionDecision, type PermissionMode, type PolicyTranslation, type ToolPolicy } from '@claudio/shared';
import { drivesSession, streamJsonProcesses } from '../../processes.ts';
import { composeContent } from '../../uploads.ts';
import { modelNames, modelOptions } from './models.ts';
import { SessionStoreTranscripts, type TranscriptStore } from '../transcripts.ts';
import type { SessionStore } from '../../sessions.ts';
import type {
  AttachedGuard,
  BranchTracker,
  CapabilityConfirmation,
  DriverEvent,
  DriverSession,
  InterruptReceipt,
  LaunchPlan,
  McpSetServersResult,
  ProviderDriver,
  ReattachReport,
  SessionAdoption,
  SessionInit,
  SessionIO,
  SessionLaunch,
  UserTurn,
} from '../driver.ts';
import { buildArgs, resumeEnv } from './args.ts';
import { ClaudeBranches } from './branches.ts';
import { ControlChannel, stillQueuedOf, type BackgroundTasksRequest, type CancelAsyncMessageRequest, type InterruptRequest } from './control.ts';
import { liveMcpServers, mcpSetServersResult } from './mcp.ts';
import { claudeReadsBack, confirmClaudeInit } from './handshake.ts';
import { claudeCodeManifest } from './manifest.ts';
import { translateClaudePolicy } from './policy.ts';
import { ClaudeStream } from './stream.ts';
import { childEnv } from '../../child-env.ts';
import type { OverlayLaunch } from '../../account-overlay.ts';

/** The session a `claude -p --input-format stream-json` process drives, read from its arguments. */
function sessionOf(argv: readonly string[]): string | null {
  const flag = (name: string) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  if (flag('--input-format') !== 'stream-json') return null;
  if (argv.includes('--fork-session')) return flag('--session-id') ?? null;
  return flag('--resume') ?? flag('--session-id') ?? null;
}

/**
 * The permission requests an `initialize` answer says the CLI still waits on (`pending_permission_requests`,
 * beside the inner `response`: spike S2). Each entry is read as the control request it was, or as its
 * request alone with the id beside it, since only one shape was ever seen and neither is typed in prose.
 */
export function pendingPermissionRequests(whole: Record<string, unknown>): Array<{ id: string; request: Record<string, unknown> }> | null {
  const listed = whole.pending_permission_requests;
  if (!Array.isArray(listed)) return null;
  return listed.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const raw = entry as Record<string, unknown>;
    const id = raw.request_id;
    const request = raw.request && typeof raw.request === 'object' ? (raw.request as Record<string, unknown>) : raw;
    return typeof id === 'string' && request.subtype === 'can_use_tool' ? [{ id, request }] : [];
  });
}

class ClaudeCodeSession implements DriverSession {
  private readonly control: ControlChannel;
  private readonly stream: ClaudeStream;
  /** Adopted, and its replay not over: the prompts it reads wait for the CLI's own list (`reattach`) */
  private replaying: boolean;
  /** The prompts the replay found unanswered and not withdrawn, by request id */
  private readonly replayed = new Map<string, Extract<DriverEvent, { kind: 'permission-request' }>>();
  /** The prompts handed to the host by this session: a request in the replay and in the list is asked once */
  private readonly asked = new Set<string>();

  constructor(
    private readonly io: SessionIO,
    private readonly sink: (event: DriverEvent) => void,
    branches: BranchTracker,
    guard?: AttachedGuard,
    adoption?: SessionAdoption,
  ) {
    this.replaying = adoption !== undefined;
    this.control = adoption ? new ControlChannel(io, `claudio-${randomUUID().slice(0, 8)}`, adoption.answered) : new ControlChannel(io);
    const held = (event: DriverEvent): void => {
      if (event.kind === 'permission-withdrawn') this.replayed.delete(event.id);
      if (event.kind === 'permission-request') {
        if (this.control.hasAnswered(event.question.id) || this.asked.has(event.question.id)) return;
        if (this.replaying) {
          this.replayed.set(event.question.id, event);
          return;
        }
        this.asked.add(event.question.id);
      }
      sink(event);
    };
    this.stream = new ClaudeStream(adoption ? held : sink, branches, this.control, guard);
  }

  /**
   * The vendor's re-attach after a transport gap (the Agent SDK's `reinitialize()`): `initialize` again,
   * whose answer lists the permission requests the process has issued and not resolved. Those are asked
   * again; when the list is empty or missing, the unanswered ones of the replay are (spikes S1, S3).
   */
  async reattach(): Promise<ReattachReport> {
    this.replaying = false;
    let listed: Array<{ id: string; request: Record<string, unknown> }> | null = null;
    try {
      listed = pendingPermissionRequests(await this.control.request({ subtype: 'initialize' }, { whole: true }));
    } catch {
      // An older CLI, or one that did not answer in time: the replay is all there is
    }
    const asked: string[] = [];
    if (listed && listed.length > 0) {
      for (const { id, request } of listed) {
        if (this.control.hasAnswered(id) || this.asked.has(id)) continue;
        asked.push(id);
        this.stream.request(id, request);
      }
      this.replayed.clear();
      return { source: 'list', asked };
    }
    for (const [id, event] of this.replayed) {
      if (this.control.hasAnswered(id) || this.asked.has(id)) continue;
      asked.push(id);
      this.asked.add(id);
      this.sink(event);
    }
    this.replayed.clear();
    return { source: 'replay', asked };
  }

  send(turn: UserTurn): string {
    const { id, text, attachments, read } = turn;
    const content = attachments.length && read ? composeContent(text, attachments, read) : text;
    // The CLI keeps the line's `uuid` as the message's: its transcript line, the `source_uuid` of a
    // message it reads mid-turn, and the replay that says it took the message all carry it
    this.control.write({ type: 'user', ...(id ? { uuid: id } : {}), message: { role: 'user', content } });
    return Array.isArray(content) ? String((content.at(-1) as { text: string }).text) : text;
  }

  async interrupt(): Promise<InterruptReceipt> {
    // The guard watcher excuses the calls this interrupt cuts short, until the CLI answers it
    this.stream.interrupting();
    try {
      const response = await this.control.request({ subtype: 'interrupt' } satisfies InterruptRequest);
      return { stillQueued: stillQueuedOf(response, this.stream.capabilities()) };
    } finally {
      this.stream.interruptAnswered();
    }
  }

  async backgroundCall(toolUseId: string): Promise<boolean> {
    const response = await this.control.request({ subtype: 'background_tasks', tool_use_id: toolUseId } satisfies BackgroundTasksRequest);
    return response.backgrounded !== false;
  }

  async cancelMessage(id: string): Promise<boolean> {
    const response = await this.control.request({ subtype: 'cancel_async_message', message_uuid: id } satisfies CancelAsyncMessageRequest);
    return response.cancelled === true;
  }

  async setOption(option: { permissionMode: PermissionMode } | { model: string } | { maxThinkingTokens: number | null }): Promise<void> {
    if ('permissionMode' in option) await this.control.request({ subtype: 'set_permission_mode', mode: option.permissionMode });
    // `null` lifts the ceiling, as the CLI reads it
    else if ('maxThinkingTokens' in option) await this.control.request({ subtype: 'set_max_thinking_tokens', max_thinking_tokens: option.maxThinkingTokens });
    else await this.control.request({ subtype: 'set_model', model: option.model });
  }

  async mcpStatus(): Promise<LiveMcpServer[]> {
    return liveMcpServers(await this.control.request({ subtype: 'mcp_status' }));
  }

  async contextUsage(detail?: ContextDetail): Promise<Record<string, unknown>> {
    // The CLI answers `full` when none is given, which counts every category with a call of its own
    return await this.control.request({ subtype: 'get_context_usage', ...(detail ? { detail } : {}) });
  }

  async mcpToggle(name: string, enabled: boolean): Promise<void> {
    // The CLI writes the choice to the folder's `disabledMcpServers`, as `/mcp` does in a terminal
    await this.control.request({ subtype: 'mcp_toggle', serverName: name, enabled });
  }

  async mcpSetServers(servers: Record<string, Record<string, unknown>>): Promise<McpSetServersResult> {
    return mcpSetServersResult(await this.control.request({ subtype: 'mcp_set_servers', servers }));
  }

  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    // `SDKControlApplyFlagSettingsRequest` in the Agent SDK's sdk.d.ts (0.3.312): merged into the flag layer, never written to a file
    await this.control.request({ subtype: 'apply_flag_settings', settings });
  }

  answerPermission(requestId: string, decision: PermissionDecision): void {
    this.control.answer(requestId, decision);
  }

  readLine(line: string): void {
    this.stream.line(line);
  }

  readError(line: string): void {
    this.stream.error(line);
  }

  endInput(): void {
    this.io.end();
  }

  dispose(reason: string): void {
    this.control.dispose(reason);
  }
}

/**
 * Claude Code behind the driver interface: the CLI's own stream-json protocol, moved here as it was.
 * The binary is the one the configuration names; the account is the one the CLI is signed in with.
 */
export class ClaudeCodeDriver implements ProviderDriver {
  readonly manifest = claudeCodeManifest;
  /** Claudio names the session and the CLI takes the name (`--session-id`), so the native id is the chat id */
  readonly sessionIds = 'imposed';
  /** `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` (`resumeEnv`) */
  readonly continuesCutTurns = true;
  /** stream-json over any byte stream, and `initialize` re-sent "after a transport gap" (Agent SDK, `reinitialize()`) */
  readonly parkable = true;
  /** Claude's JSONL transcripts, once Core has handed over the store it reads them with */
  transcripts: TranscriptStore | null = null;

  /** The default account's list from the CLI's `initialize`, null before it was read; set by the manager */
  modelSource: { listed: () => ModelOption[] | null } | null = null;
  /** What a shared account's process adds to its launch (`account-overlay.ts`); set by the manager, like `modelSource` */
  accountOverlay: { launch: (spec: SessionLaunch) => OverlayLaunch | null } | null = null;

  /** A function when the binary can change under a running server (an in-app CLI update) */
  constructor(private readonly claudeBin: string | (() => string)) {}

  translatePolicy(policy: ToolPolicy): PolicyTranslation {
    return translateClaudePolicy(policy);
  }

  models(): ModelOption[] {
    return modelOptions(this.modelSource?.listed() ?? null);
  }

  modelNames(model: string): string[] {
    return modelNames(this.modelSource?.listed() ?? null, model);
  }

  /** Where the transcripts are read from; set by the manager, like `modelSource` */
  useSessions(sessions: SessionStore): void {
    this.transcripts = new SessionStoreTranscripts(sessions);
  }

  /** Every mode of today's list is Claude's own, so the native value is the mode itself */
  permissionModes(): Array<{ mode: PermissionMode; native: string }> {
    return PERMISSION_MODES.map((mode) => ({ mode, native: mode }));
  }

  launch(spec: SessionLaunch): LaunchPlan {
    const launched = { ...spec, ...(this.accountOverlay?.launch(spec) ?? {}) };
    return { bin: typeof this.claudeBin === 'function' ? this.claudeBin() : this.claudeBin, args: buildArgs(launched), env: resumeEnv(launched, childEnv('claude-code', process.env, spec.account)), unsetEnv: [] };
  }

  attach(io: SessionIO, sink: (event: DriverEvent) => void, branches: BranchTracker, guard?: AttachedGuard, adoption?: SessionAdoption): DriverSession {
    return new ClaudeCodeSession(io, sink, branches, guard, adoption);
  }

  createBranches(): BranchTracker {
    return new ClaudeBranches();
  }

  sessionHolders(sessionId: string): number[] {
    return streamJsonProcesses()
      .filter((p) => drivesSession(p.argv, sessionId))
      .map((p) => p.pid);
  }

  liveSessions(): Array<{ pid: number; sessionId: string }> {
    return streamJsonProcesses().flatMap((p) => {
      const sessionId = sessionOf(p.argv);
      return sessionId ? [{ pid: p.pid, sessionId }] : [];
    });
  }

  confirm(init: SessionInit): CapabilityConfirmation {
    return confirmClaudeInit(init);
  }

  readsBack(init: SessionInit): boolean | null {
    return claudeReadsBack(init.version);
  }
}
