import { createReadStream, existsSync, type Stats } from 'node:fs';
import { open, readFile, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { createInterface } from 'node:readline';
import {
  entrySearchText,
  entryText,
  isModelName,
  isWaitingOnBackground,
  normalizeMessage,
  runsElapsedMs,
  searchPattern,
  TranscriptSearch,
  TRANSCRIPT_PAGE,
  TRANSCRIPT_PAGE_MAX,
  type AgentTranscript,
  type BackgroundTaskOutput,
  type ChatBranchRun,
  type TranscriptEntry,
  type TranscriptSearchResult,
} from '@claudio/shared';
import { toChatTask } from './chat-branches.ts';
import { AGENT_FOLD, AGENT_ID_RE, WORKFLOW_RUN_ID_RE, agentRead, emptyAgentRead } from './agents.ts';
import type { BackgroundTask, SubagentInfo, TranscriptPage, TranscriptSummary, WorkflowRun } from './cli-facts.ts';
import { EDIT_STEPS_FOLD, type EditStepsState } from './edit-steps.ts';
import { CORRECTION_FOLD, type CorrectionState } from './lessons/signals.ts';
import { JsonlCache, type JsonlFold } from './jsonl-cache.ts';
import type { CoreConfig } from './paths.ts';
import { toolCallsOf, type ToolCall } from './tool-calls.ts';
import type { TranscriptFoldRow, TranscriptFolds } from './transcript-folds.ts';
import { EntryIndex, fingerprint, parseLine, readLines, scanLines, type JsonLine } from './transcript-index.ts';
import { UsageFold, type UsageFoldJson } from './usage.ts';
import { readSessionWorkflows, readWorkflowAgent, WorkflowMemo } from './workflows.ts';
import { readJournalTasks, type JournalRead } from './workflow-journal.ts';

/** The slash command inside a synthetic user message, e.g. `<command-name>/resume</command-name>`. */
const COMMAND_RE = /<command-name>\s*([^<]+)<\/command-name>/;

/** A summary over the lines read so far, before what only the end of the file decides. */
interface SummaryFold {
  /** `usage` is filled when the fold is finished; the running figures are in `spent` */
  summary: Omit<TranscriptSummary, 'usage'>;
  customTitle: string | null;
  command: string | undefined;
  spent: UsageFold;
}

/** A copy a half-written last line can be folded into without touching the original. */
function cloneFold(fold: SummaryFold): SummaryFold {
  const { spent, ...plain } = fold;
  return { ...structuredClone(plain), spent: spent.clone() };
}

function foldLine(fold: SummaryFold, o: JsonLine, entry: TranscriptEntry | null): void {
  const { summary } = fold;
  if (typeof o.timestamp === 'string') {
    summary.startedAt ??= o.timestamp;
    summary.updatedAt = o.timestamp;
  }
  if (!summary.projectPath && typeof o.cwd === 'string') summary.projectPath = o.cwd;
  if (typeof o.gitBranch === 'string') summary.gitBranch = o.gitBranch;
  if (typeof o.version === 'string') summary.cliVersion = o.version;
  if (o.type === 'summary' && typeof o.summary === 'string') fold.customTitle = o.summary;
  if (o.type === 'custom-title' && typeof o.customTitle === 'string') fold.customTitle = o.customTitle;
  // Written when the CLI starts a session in a worktree it created: which one, and whose
  if (o.type === 'worktree-state' && !summary.worktree) {
    const w = o.worktreeSession as Record<string, unknown> | null | undefined;
    if (w && typeof w.worktreePath === 'string' && typeof w.originalCwd === 'string') {
      summary.worktree = {
        path: w.worktreePath,
        parentPath: w.originalCwd,
        name: typeof w.worktreeName === 'string' ? w.worktreeName : null,
        branch: typeof w.worktreeBranch === 'string' ? w.worktreeBranch : null,
      };
    }
  }

  if (entry) fold.spent.add(o, entry);
  // A compaction is the CLI's marker and the summary it continued from, never something the person typed
  if (!entry || entry.isSidechain || entry.compaction) return;
  summary.messageCount++;
  if (isModelName(entry.model)) summary.model = entry.model;
  if (!summary.firstPrompt && entry.role === 'user') {
    const text = entryText(entry).trim();
    // Skip synthetic messages (<command-name>, <system-reminder>, …)
    if (text && !text.startsWith('<')) summary.firstPrompt = text.slice(0, 300);
    // …but remember the command, the only readable thing a session nobody typed in ever has
    else fold.command ??= COMMAND_RE.exec(text)?.[1]?.trim();
  }
}

function finishSummary(fold: SummaryFold, info: Stats): TranscriptSummary | null {
  const summary = { ...fold.summary, sizeBytes: info.size, usage: fold.spent.snapshot() };
  if (summary.messageCount === 0) return null;
  // A session with no user turn (the spare `claude attach` pre-warms) would otherwise be
  // titled with its own uuid, which reads like an id and tells nobody what it is.
  summary.title = fold.customTitle ?? summary.firstPrompt?.split('\n')[0]?.slice(0, 100) ?? fold.command ?? summary.id;
  summary.updatedAt ??= info.mtime.toISOString();
  return summary;
}

function emptyFold(projectId: string, file: string): SummaryFold {
  return {
    summary: {
      id: basename(file, '.jsonl'),
      projectId,
      projectPath: '',
      title: '',
      firstPrompt: null,
      messageCount: 0,
      startedAt: null,
      updatedAt: null,
      model: null,
      gitBranch: null,
      cliVersion: null,
      sizeBytes: 0,
      worktree: null,
    },
    customTitle: null,
    command: undefined,
    spent: new UsageFold(),
  };
}

/**
 * The version of the listing's fold `transcript_folds` keeps: raised whenever what `foldLine` or the
 * usage fold reads of a line changes, so a row folded by older code is folded again, never trusted.
 */
const FOLD_VERSION = 1;
/** Spend is put on days of the server's zone: a fold made in another zone would put it on the wrong ones */
const FOLD_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

interface SummaryFoldJson {
  v: number;
  zone: string;
  summary: SummaryFold['summary'];
  customTitle: string | null;
  command: string | null;
  spent: UsageFoldJson;
}

function foldToJson(fold: SummaryFold): string {
  const json: SummaryFoldJson = { v: FOLD_VERSION, zone: FOLD_ZONE, summary: fold.summary, customTitle: fold.customTitle, command: fold.command ?? null, spent: fold.spent.toJSON() };
  return JSON.stringify(json);
}

/** A stored fold, or null when it was made by another version or in another zone, or does not parse: the file is folded again. */
function foldFromJson(text: string): SummaryFold | null {
  try {
    const json = JSON.parse(text) as Partial<SummaryFoldJson>;
    if (json.v !== FOLD_VERSION || json.zone !== FOLD_ZONE || !json.summary || !json.spent) return null;
    return { summary: json.summary, customTitle: json.customTitle ?? null, command: json.command ?? undefined, spent: UsageFold.fromJSON(json.spent) };
  } catch {
    return null;
  }
}

/**
 * What the listing learned of one transcript, kept so the next look only reads what was appended
 * since: a live session grows by a line at a time, and re-reading tens of megabytes for each one is
 * what made a long session slow to list. Persisted in `transcript_folds`, so a restart does not
 * read every transcript on the machine again either.
 */
interface Listed {
  projectId: string;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Offset just past the last complete line: everything before it is folded */
  end: number;
  /** The bytes just before `end`, which a file that only grew still has */
  fingerprint: Buffer;
  /** Over the complete lines only, so the next pass can go on from `end` */
  fold: SummaryFold;
  /**
   * At `size`, a half-written last line included when it already parses. Undefined for a fold
   * restored from the table until the file is looked at, since its tail may not have been folded.
   */
  summary: TranscriptSummary | null | undefined;
}

/** The byte offset of each entry of a transcript, for a chat being read: only the ones open are kept. */
interface Paged {
  ino: number;
  size: number;
  mtimeMs: number;
  end: number;
  fingerprint: Buffer;
  entries: EntryIndex;
}

const unchanged = (known: { ino: number; size: number; mtimeMs: number }, info: Stats): boolean =>
  known.ino === info.ino && known.size === info.size && known.mtimeMs === info.mtimeMs;

/** Whether a file still holds, where it was, the part a pass already read up to `end`: only then is it read on from there. */
async function goesOn(handle: FileHandle, known: { ino: number; end: number; fingerprint: Buffer } | null, info: Stats): Promise<boolean> {
  return known !== null && known.ino === info.ino && info.size >= known.end && (await fingerprint(handle, known.end)).equals(known.fingerprint);
}

/** A line's text whether the CLI stored it as a plain string or as content blocks. */
function lineText(o: Record<string, unknown>): string {
  if (typeof o.content === 'string') return o.content;
  const message = o.message as { content?: unknown } | undefined;
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('\n');
  }
  return '';
}

/**
 * A stop notification is written to the parent just after the agent's last write, so an agent only
 * counts as resumed once it writes clearly later than that — otherwise a clock tick between the two
 * would read a finished agent as running.
 */
const RESUMED_AFTER_MS = 2000;

/** How much of a subagent's transcript is read for its working directory, which the first lines carry */
const CWD_PROBE_BYTES = 64 * 1024;

/**
 * The directory an agent works in, from the first transcript line that records one. A subagent
 * started with `isolation: worktree` works in its own worktree, not its parent's directory.
 */
async function firstCwd(file: string): Promise<string | null> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(CWD_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CWD_PROBE_BYTES, 0);
    for (const raw of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      try {
        const cwd = (JSON.parse(raw) as { cwd?: unknown }).cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        /* a line cut off by the probe */
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** Only the end of a long task output is returned: it is what says how the command finished. */
const MAX_TASK_OUTPUT = 64 * 1024;

/** One field out of a `<task-notification>` block. */
function tag(text: string, name: string): string | null {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? null;
}

/**
 * Every task a notification names. After a session restart the CLI reports what the old process
 * left behind in one block, listing several ids (shell tasks, and a `__orphan_summary__:shell`
 * marker that is not a task at all).
 */
function taskIds(text: string): string[] {
  const ids = [...text.matchAll(/<task-id>([\s\S]*?)<\/task-id>/g)].map((m) => m[1]?.trim() ?? '');
  return ids.filter((id) => id !== '' && !id.startsWith('__orphan_summary__:'));
}

/**
 * Where the CLI keeps a session's task output: its own temp dir, per user, project and session.
 * The wrapper runs as the same user as the CLI, in and out of the container, so it resolves the
 * same directory.
 */
function taskDir(projectId: string, sessionId: string): string {
  return join(tmpdir(), `claude-${String(process.getuid?.() ?? 0)}`, projectId, sessionId, 'tasks');
}

/**
 * How many leading bytes of a buffer end on a character boundary. A read that stops mid-character
 * (a chunk cap, a file still being written) would otherwise decode to a replacement character and
 * make the next read, which starts at the same byte, print the rest of it as garbage.
 */
function completeUtf8(buffer: Buffer): number {
  let i = buffer.length - 1;
  for (let back = 0; i >= 0 && back < 3 && ((buffer[i] ?? 0) & 0xc0) === 0x80; back++) i--;
  if (i < 0) return buffer.length;
  const lead = buffer[i] ?? 0;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buffer.length - i < need ? i : buffer.length;
}

interface TaskLaunch {
  at: string;
  /** `local_bash` for a backgrounded command, `monitor` for a Monitor watch */
  type: string;
  toolUseId: string | null;
  command: string | null;
  description: string | null;
  backgroundedByUser: boolean;
  /** When a monitor stops on its own if nothing else stopped it first; null for no limit */
  expiresAt: string | null;
  /** The subagent whose transcript recorded the launch */
  ownerAgentId?: string;
}

interface AgentStop {
  at: string;
  status: string;
  summary: string | null;
  /** `completed`, but the agent only ended its turn: its own background work still runs */
  waiting?: boolean;
}

/** Where an agent stands, from the stop its parent was notified of and how recently it wrote. */
function agentState(
  stop: AgentStop | undefined,
  mtime: Date | null,
  live: boolean,
  /** When its parent last resumed it (SendMessage), where the transcript says so */
  resumedAt?: string,
): { status: SubagentInfo['status']; endedAt: string | null } {
  const lastActivityAt = mtime ? mtime.toISOString() : null;
  const resumed = stop ? (resumedAt !== undefined && resumedAt > stop.at) || (mtime ? mtime.getTime() > Date.parse(stop.at) + RESUMED_AFTER_MS : false) : false;
  if (!stop || resumed) return { status: live ? 'running' : 'stopped', endedAt: live ? null : lastActivityAt };
  // The background work that kept it waiting went down with a session that is no longer held
  if (stop.waiting) return live ? { status: 'waiting', endedAt: null } : { status: 'stopped', endedAt: stop.at };
  return { status: stopStatus(stop.status), endedAt: stop.at };
}

/** An agent's state and runs from the folded activity of its session. */
function agentFacts(activity: SessionActivity, agentId: string, mtime: Date | null, live: boolean, fallbackStart: string | null) {
  const resumes = activity.resumes.get(agentId) ?? [];
  const state = agentState(activity.stops.get(agentId), mtime, live, resumes.at(-1));
  const launch = activity.agents.get(agentId) ?? fallbackStart;
  const runs = launch ? agentRuns([launch, ...resumes], activity.stopLog.get(agentId) ?? [], activity.waitLog.get(agentId) ?? [], state) : [];
  return { state, launch, runs };
}

/** `stopped` and `killed` are an agent someone stopped, which is not a failure (warn, not bad). */
function stopStatus(status: string): SubagentInfo['status'] {
  if (status === 'completed') return 'completed';
  return status === 'stopped' || status === 'killed' ? 'stopped' : 'failed';
}

/**
 * The stretches an agent worked, from its launch and each resume against each time it stopped.
 * A run with no stop of its own ended when the next began (its notification was lost); the last one
 * is open while the agent runs.
 */
function agentRuns(starts: string[], stops: string[], waits: string[], state: { status: SubagentInfo['status']; endedAt: string | null }): ChatBranchRun[] {
  const ordered = [...starts].sort();
  const ends = [...stops].sort();
  const runs: ChatBranchRun[] = ordered.map((startedAt, i) => {
    const next = ordered[i + 1];
    const end = ends.find((at) => at >= startedAt && (next === undefined || at < next));
    return { startedAt, endedAt: end ?? next ?? null };
  });
  // An agent that resumed by itself leaves no marker, only the stop of its next run: a stop that
  // ended no run began one right after the stop before it
  for (const [i, end] of ends.entries()) {
    if (runs.some((run) => run.endedAt === end)) continue;
    const before = ends[i - 1];
    if (before !== undefined && waits.includes(before)) runs.push({ startedAt: before, endedAt: end });
  }
  runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const last = runs.at(-1);
  if (!last) return runs;
  // Written to after its last stop with no resume on record: it is working again
  if (state.status === 'running' && last.endedAt !== null) runs.push({ startedAt: last.endedAt, endedAt: null });
  else if (state.status !== 'running' && last.endedAt === null) last.endedAt = state.endedAt ?? last.startedAt;
  return runs;
}

interface SessionActivity {
  /** agentId → when it was launched */
  agents: Map<string, string>;
  /** backgroundTaskId → the call that sent it to the background */
  tasks: Map<string, TaskLaunch>;
  /** id → the latest time it stopped, for agents and tasks alike */
  stops: Map<string, AgentStop>;
  /** agentId → every time it stopped, oldest first, for the runs of an agent that was resumed */
  stopLog: Map<string, string[]>;
  /** agentId → every time it stopped only to wait for its own background work, oldest first */
  waitLog: Map<string, string[]>;
  /** agentId → every time its parent resumed it with SendMessage, oldest first */
  resumes: Map<string, string[]>;
}

/** The activity folded so far, with what a later line needs of an earlier one. */
interface ActivityFold extends SessionActivity {
  /**
   * Inputs of the calls that can leave a task running, a backgrounded Bash command or a Monitor,
   * until their result is read: a call has one, and the fold is kept for as long as its transcript
   */
  launchInputs: Map<string, { tool: string; input: Record<string, unknown> }>;
}

function recordStop(activity: ActivityFold, id: string, stop: AgentStop): void {
  activity.stops.set(id, stop);
  activity.stopLog.set(id, [...(activity.stopLog.get(id) ?? []), stop.at]);
  if (stop.waiting) activity.waitLog.set(id, [...(activity.waitLog.get(id) ?? []), stop.at]);
}

const ACTIVITY_FOLD: JsonlFold<ActivityFold> = {
  init: () => ({ agents: new Map(), tasks: new Map(), stops: new Map(), stopLog: new Map(), waitLog: new Map(), resumes: new Map(), launchInputs: new Map() }),
  clone: (a) => ({
    agents: new Map(a.agents),
    tasks: new Map(a.tasks),
    stops: new Map(a.stops),
    stopLog: new Map([...a.stopLog].map(([id, at]) => [id, [...at]])),
    waitLog: new Map([...a.waitLog].map(([id, at]) => [id, [...at]])),
    resumes: new Map([...a.resumes].map(([id, at]) => [id, [...at]])),
    launchInputs: new Map(a.launchInputs),
  }),
  add: (activity, o) => {
    const at = typeof o.timestamp === 'string' ? o.timestamp : null;
    const message = o.message as { content?: unknown } | undefined;
    let resultFor: string | null = null;
    const answered: string[] = [];
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      const b = block as { type?: string; name?: string; id?: unknown; input?: unknown; tool_use_id?: unknown };
      if (b.type === 'tool_use' && (b.name === 'Bash' || b.name === 'Monitor') && typeof b.id === 'string') {
        activity.launchInputs.set(b.id, { tool: b.name, input: (b.input ?? {}) as Record<string, unknown> });
      }
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        resultFor = b.tool_use_id;
        answered.push(b.tool_use_id);
      }
    }
    const result = o.toolUseResult as Record<string, unknown> | undefined;
    if (at && result && typeof result === 'object') {
      if (typeof result.agentId === 'string' && !activity.agents.has(result.agentId)) activity.agents.set(result.agentId, at);
      // A foreground agent never gets a notification: its call's own result is how it reports back,
      // with `status: 'completed'` (a background one's says `async_launched`, and its notification ends it)
      if (typeof result.agentId === 'string' && result.status === 'completed') {
        recordStop(activity, result.agentId, { at, status: 'completed', summary: null });
      }
      // The parent sent a stopped agent a message: it works again, under the id it always had
      if (typeof result.resumedAgentId === 'string') {
        activity.resumes.set(result.resumedAgentId, [...(activity.resumes.get(result.resumedAgentId) ?? []), at]);
      }
      // A task stopped on request never gets a notification: all it leaves is TaskStop's result.
      // Without this it would read as running for as long as its session lived.
      if (typeof result.task_id === 'string' && typeof result.message === 'string' && /stopped/i.test(result.message)) {
        recordStop(activity, result.task_id, { at, status: 'stopped', summary: result.message });
      }
      const launch = resultFor ? activity.launchInputs.get(resultFor) : undefined;
      // A Monitor's result names its task `taskId`, not `backgroundTaskId` like a Bash call's
      const taskId =
        typeof result.backgroundTaskId === 'string'
          ? result.backgroundTaskId
          : launch?.tool === 'Monitor' && typeof result.taskId === 'string'
            ? result.taskId
            : null;
      if (taskId && !activity.tasks.has(taskId)) {
        const input = launch?.input ?? {};
        const timeoutMs = launch?.tool === 'Monitor' && typeof result.timeoutMs === 'number' ? result.timeoutMs : 0;
        activity.tasks.set(taskId, {
          at,
          type: launch?.tool === 'Monitor' ? 'monitor' : 'local_bash',
          toolUseId: resultFor,
          command: typeof input.command === 'string' ? input.command : null,
          description: typeof input.description === 'string' ? input.description : null,
          backgroundedByUser: result.backgroundedByUser === true,
          // A persistent monitor reports a timeout of 0: it runs until stopped or its session ends
          expiresAt: timeoutMs > 0 && result.persistent !== true ? new Date(Date.parse(at) + timeoutMs).toISOString() : null,
        });
      }
    }
    for (const id of answered) activity.launchInputs.delete(id);
    const text = lineText(o);
    if (!at || !text.includes('<task-notification>')) return;
    // Later lines win: an agent can be resumed and stop again, notifying each time
    const status = tag(text, 'status') ?? 'completed';
    const summary = tag(text, 'summary');
    const waiting = status === 'completed' && isWaitingOnBackground({ summary, note: tag(text, 'note') });
    for (const id of taskIds(text)) recordStop(activity, id, { at, status, summary, ...(waiting ? { waiting } : {}) });
  },
};

/**
 * The entries of a transcript that call a tool or carry a result, which is all a checklist or a
 * file list needs. Only lines that mention a tool at all are parsed.
 */
const TOOL_ENTRIES_FOLD: JsonlFold<TranscriptEntry[]> = {
  init: () => [],
  clone: (entries) => [...entries],
  add: (entries, o) => {
    const entry = normalizeMessage(o);
    if (entry?.blocks.some((b) => b.type === 'tool_use' || b.type === 'tool_result')) entries.push(entry);
  },
  mentions: 'tool_use',
};

/** Transcripts whose tool calls are kept: each holds whole entries, and only a chat being looked at needs them. */
const TOOL_ENTRIES_FILES = 8;
/** Transcripts whose edits are kept, patches included: only a chat under review needs them */
const EDIT_STEPS_FILES = 8;
const CORRECTION_FILES = 8;
/** Agent transcripts kept whole, for the panels following one */
const AGENT_FILES = 32;
/** Project directories listed at once, and transcripts opened at once, when every session is read */
const LIST_DIRS_AT_ONCE = 16;
const LIST_FILES_AT_ONCE = 32;
/**
 * How often every transcript is looked at again even while a watcher reports each change: a watch
 * whose kernel queue overflowed misses events without saying so. Done in the background.
 */
const SWEEP_EVERY_MS = 60_000;
/** Transcripts whose entry offsets are kept for paging: the chats being read, the least recently read going first */
const PAGED_FILES = 32;

/** `work` over every item, no more than `limit` at a time, results in order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await work(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function* readJsonl(file: string): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      // half-written line from a live session
    }
  }
}

/** What a caller's `limit` is allowed to be: a page, never the whole conversation by accident. */
export function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return TRANSCRIPT_PAGE;
  return Math.min(Math.max(1, Math.trunc(limit)), TRANSCRIPT_PAGE_MAX);
}

/** Options of a {@link SessionStore}. */
export interface SessionStoreOptions {
  /** Where each transcript's fold is kept across restarts; without it a restart folds every transcript again */
  folds?: TranscriptFolds | null;
}

/**
 * Reads projects and sessions from ~/.claude/projects (.jsonl transcripts written by the CLI).
 *
 * The listing is incremental (docs/plans/regression-fixes-2026-10-29.md, D8 and C7). It keeps what it
 * last learned of every transcript and, while the {@link SessionsWatcher} reports every change under
 * the projects directory, looks again only at the files and directories it named; without a watcher
 * it looks at every file's stat and reads only the ones that changed. A file that changed is read on
 * from where its last pass stopped, and that pass is kept in `transcript_folds`, so a restart reads
 * rows rather than every transcript on the machine. Callers asking while a look is under way share it.
 */
export class SessionStore {
  /** Subagent transcript → its working dir; written once at its start, so never re-read */
  private readonly cwdCache = new Map<string, string | null>();
  private readonly activities = new JsonlCache(ACTIVITY_FOLD);
  private readonly toolEntries = new JsonlCache(TOOL_ENTRIES_FOLD, TOOL_ENTRIES_FILES);
  private readonly editStepFolds = new JsonlCache(EDIT_STEPS_FOLD, EDIT_STEPS_FILES);
  private readonly correctionFolds = new JsonlCache(CORRECTION_FOLD, CORRECTION_FILES);
  private readonly agentFiles = new JsonlCache(AGENT_FOLD, AGENT_FILES);
  private readonly workflowMemo = new WorkflowMemo();
  /**
   * Session id → where its transcript was last seen. Every per-chat read starts by finding the
   * file, and looking in every project directory for it is a stat per project each time.
   */
  private readonly files = new Map<string, { projectId: string; file: string }>();

  private readonly folds: TranscriptFolds | null;
  /** Transcript file → what the listing learned of it */
  private readonly listed = new Map<string, Listed>();
  /** A look at one file under way, shared by whoever asks about that file meanwhile */
  private readonly reading = new Map<string, Promise<Listed | null>>();
  /** Rows of `transcript_folds` no file has claimed yet: read once, at the first look */
  private restored: Map<string, TranscriptFoldRow> | null = null;
  /** A watcher reports every change under the projects directory */
  private watched = false;
  /** Something may have changed that nobody reported (the watch just started, or could not say what): every file is looked at */
  private unknown = true;
  private readonly reportedFiles = new Set<string>();
  /** Project directories a file came into or left, by name */
  private readonly reportedDirs = new Set<string>();
  /** When the last look at every file began; -Infinity before the first */
  private sweptAt = -Infinity;
  /** A look at every file is under way: until it ends, what the listing holds may predate the watch */
  private sweeping = false;
  private refreshing: Promise<void> | null = null;
  /** The listing, newest first; null when an entry changed since it was sorted */
  private sorted: TranscriptSummary[] | null = null;
  private gen = 0;
  /** Transcript file → its entry offsets, for the chats being read; most recently read last */
  private readonly pages = new Map<string, Promise<Paged | null>>();

  constructor(
    private readonly config: CoreConfig,
    opts: SessionStoreOptions = {},
  ) {
    this.folds = opts.folds ?? null;
  }

  /** Protected so a test can count the looks at every directory. */
  protected async projectDirs(): Promise<string[]> {
    if (!existsSync(this.config.projectsDir)) return [];
    const entries = await readdir(this.config.projectsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  // ---------- the listing ----------

  /** Raised whenever what {@link listSessions} returns changes: what a result derived from the listing is kept against. */
  get generation(): number {
    return this.gen;
  }

  /** The watcher started (every change from now on is reported) or stopped. Either way, what happened unwatched is unknown. */
  noteWatching(on: boolean): void {
    this.watched = on;
    this.unknown = true;
  }

  /**
   * A path under the projects directory changed, relative to it, as the watcher names it; null when
   * it could not say which. A transcript is `<dir>/<session>.jsonl`; a bare `<dir>` is a project
   * directory that came or went; anything deeper is a session's sidecar, which the listing never reads.
   */
  noteChanged(path: string | null): void {
    if (path === null) {
      this.unknown = true;
      return;
    }
    const [dir, name, ...deeper] = path.split(/[\\/]/);
    if (!dir) return;
    if (name === undefined) this.reportedDirs.add(dir);
    else if (deeper.length === 0 && name.endsWith('.jsonl')) this.reportedFiles.add(join(this.config.projectsDir, dir, name));
  }

  /** Whether the listing knows every transcript as it is, but for what was reported since: watched since before a finished look at every file. */
  private trusted(): boolean {
    return this.watched && !this.unknown && !this.sweeping && this.sweptAt !== -Infinity;
  }

  /** Whether what the listing holds of a file is current without looking at it: a watcher reports every change, and none was for it. */
  private current(file: string): boolean {
    const entry = this.listed.get(file);
    return (
      this.trusted() &&
      entry !== undefined &&
      entry.summary !== undefined &&
      !this.reportedFiles.has(file) &&
      !this.reportedDirs.has(entry.projectId)
    );
  }

  async listSessions(projectId?: string): Promise<TranscriptSummary[]> {
    const reported = () => this.reportedFiles.size > 0 || this.reportedDirs.size > 0;
    if (this.refreshing) {
      await this.refreshing;
      // What the watcher reported while that look ran is read now, not at the next call
      if (this.watched && (this.unknown || reported())) await this.refresh();
    } else if (!this.watched || this.unknown || this.sweptAt === -Infinity || reported()) await this.refresh();
    // Watched and nothing reported: what was listed is current. The look at every file that a
    // missed event would need is due now and then, and goes on behind this answer
    else if (Date.now() - this.sweptAt > SWEEP_EVERY_MS) void this.refresh().catch(() => undefined);
    // ISO times, so their text sorts as their instants do
    this.sorted ??= [...this.listed.values()]
      .map((entry) => entry.summary)
      .filter((s): s is TranscriptSummary => s !== null && s !== undefined)
      .sort((a, b) => ((b.updatedAt ?? '') > (a.updatedAt ?? '') ? 1 : (b.updatedAt ?? '') < (a.updatedAt ?? '') ? -1 : 0));
    return projectId === undefined ? [...this.sorted] : this.sorted.filter((s) => s.projectId === projectId);
  }

  /** One look, shared by every caller that arrives while it runs. */
  private refresh(): Promise<void> {
    this.refreshing ??= this.look().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async look(): Promise<void> {
    const everything = !this.watched || this.unknown || this.sweptAt === -Infinity || Date.now() - this.sweptAt > SWEEP_EVERY_MS;
    const files = [...this.reportedFiles];
    const dirs = [...this.reportedDirs];
    // Taken before the look: a change reported while it runs is looked at by the next one
    this.reportedFiles.clear();
    this.reportedDirs.clear();
    if (!everything) {
      await mapLimit(dirs, LIST_DIRS_AT_ONCE, (dir) => this.lookInto(dir));
      await mapLimit(files, LIST_FILES_AT_ONCE, (file) => this.check(basename(dirname(file)), file));
      return;
    }
    this.unknown = false;
    this.sweeping = true;
    const started = Date.now();
    try {
      await this.sweep();
      this.sweptAt = started;
    } catch (err) {
      this.unknown = true;
      throw err;
    } finally {
      this.sweeping = false;
    }
  }

  /** Every transcript's stat; only the ones that changed are read, from where their last pass stopped. */
  private async sweep(): Promise<void> {
    const dirs = await this.projectDirs();
    // Directories are listed, and transcripts opened, a bounded number at a time: one after the
    // other made a cold start as slow as the sum of them, all at once can run out of descriptors
    const listed = await mapLimit(dirs, LIST_DIRS_AT_ONCE, async (dir) => ((await this.transcriptsIn(dir)) ?? []).map((file) => ({ projectId: dir, file })));
    const found = listed.flat();
    const present = new Set(found.map((at) => at.file));
    for (const file of [...this.listed.keys()]) if (!present.has(file)) this.drop(file);
    await mapLimit(found, LIST_FILES_AT_ONCE, (at) => this.check(at.projectId, at.file));
    // What no transcript on disk claimed is of files deleted while this process did not run
    for (const path of this.restoredRows().keys()) if (!present.has(path)) this.folds?.drop(path);
    this.restored = new Map();
  }

  /** A project directory a file came into or left: its transcripts now, and none it no longer holds. */
  private async lookInto(dir: string): Promise<void> {
    const files = (await this.transcriptsIn(dir)) ?? [];
    const present = new Set(files);
    for (const [file, entry] of [...this.listed]) if (entry.projectId === dir && !present.has(file)) this.drop(file);
    await mapLimit(files, LIST_FILES_AT_ONCE, (file) => this.check(dir, file));
  }

  /** The transcripts of one project directory; null when it is not there. */
  private async transcriptsIn(dir: string): Promise<string[] | null> {
    const full = join(this.config.projectsDir, dir);
    const names = await readdir(full).catch(() => null);
    return names ? names.filter((f) => f.endsWith('.jsonl')).map((f) => join(full, f)) : null;
  }

  private restoredRows(): Map<string, TranscriptFoldRow> {
    this.restored ??= this.folds?.all() ?? new Map();
    return this.restored;
  }

  /** The stored pass over a file this process has not looked at yet; null when there is none it can go on from. */
  private restore(projectId: string, file: string): Listed | null {
    const rows = this.restoredRows();
    const row = rows.get(file);
    if (!row) return null;
    rows.delete(file);
    const fold = foldFromJson(row.fold);
    if (!fold) return null;
    return { projectId, ino: row.ino, size: row.size, mtimeMs: row.mtimeMs, end: row.end, fingerprint: row.fingerprint, fold, summary: undefined };
  }

  /** One transcript as it is on disk now; null once it is gone. A look already under way for it is shared. */
  private check(projectId: string, file: string): Promise<Listed | null> {
    const pending = this.reading.get(file);
    if (pending) return pending;
    const next = this.load(projectId, file).finally(() => {
      if (this.reading.get(file) === next) this.reading.delete(file);
    });
    this.reading.set(file, next);
    return next;
  }

  private async load(projectId: string, file: string): Promise<Listed | null> {
    const info = await stat(file).catch(() => null);
    if (!info) {
      this.drop(file);
      return null;
    }
    this.files.set(basename(file, '.jsonl'), { projectId, file });
    const known = this.listed.get(file) ?? this.restore(projectId, file);
    if (known && unchanged(known, info)) {
      // A stored pass that reached the end of the file is the whole of it: nothing is read
      if (known.summary === undefined && known.end === known.size) known.summary = finishSummary(known.fold, info);
      if (known.summary !== undefined) {
        if (this.listed.get(file) !== known) this.keep(file, known);
        return known;
      }
    }
    const next = await this.fold(projectId, file, known).catch(() => null);
    if (!next) {
      this.drop(file);
      return null;
    }
    this.keep(file, next);
    // Only a pass that folded more lines is worth a row; a tail that is still being written is read again anyway
    if (!known || known.fold !== next.fold) {
      this.folds?.put({ path: file, ino: next.ino, size: next.size, mtimeMs: next.mtimeMs, end: next.end, fingerprint: next.fingerprint, fold: foldToJson(next.fold) });
    }
    return next;
  }

  /**
   * Folds what a transcript holds past `known.end` when it still has what was folded there, or the
   * whole of it when it was replaced: the only part of a transcript parsed is the part not read yet.
   */
  private async fold(projectId: string, file: string, known: Listed | null): Promise<Listed | null> {
    const handle = await open(file, 'r').catch(() => null);
    if (!handle) return null;
    try {
      const info = await handle.stat();
      const base = (await goesOn(handle, known, info)) ? known : null;
      const fold = base ? cloneFold(base.fold) : emptyFold(projectId, file);
      let folded = 0;
      const { end, tail } = await scanLines(handle, base?.end ?? 0, info.size, (o) => {
        foldLine(fold, o, normalizeMessage(o));
        folded++;
      });
      // A last line without its newline yet counts if it parses, as it did when read line by line,
      // but stays out of the fold: the next pass reads it again once it is finished
      const tailLine = parseLine(tail);
      let summary: TranscriptSummary | null;
      if (tailLine) {
        const withTail = cloneFold(fold);
        foldLine(withTail, tailLine, normalizeMessage(tailLine));
        summary = finishSummary(withTail, info);
      } else summary = finishSummary(fold, info);
      // Nothing complete was added: the pass it went on from stays the one kept, and stored
      const same = base !== null && folded === 0 && end === base.end;
      return {
        projectId,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        end,
        fingerprint: same ? base.fingerprint : await fingerprint(handle, end),
        fold: same ? base.fold : fold,
        summary,
      };
    } finally {
      await handle.close();
    }
  }

  private keep(file: string, entry: Listed): void {
    this.listed.set(file, entry);
    this.sorted = null;
    this.gen++;
  }

  private drop(file: string): void {
    const had = this.listed.delete(file);
    if (had || this.restored?.delete(file)) this.folds?.drop(file);
    const id = basename(file, '.jsonl');
    if (this.files.get(id)?.file === file) this.files.delete(id);
    if (!had) return;
    this.sorted = null;
    this.gen++;
  }

  /** Writes the folds still waiting, before the database closes. */
  flush(): void {
    this.folds?.flush();
  }

  private async findFile(sessionId: string): Promise<{ projectId: string; file: string } | null> {
    if (!/^[\w-]+$/.test(sessionId)) return null;
    const known = this.files.get(sessionId);
    if (known) {
      if (this.current(known.file) || (await stat(known.file).then(() => true, () => false))) return known;
      this.files.delete(sessionId);
    }
    // While a watcher reports every change, a session the listing does not know has no transcript
    // yet, unless it was just reported: a chat that never writes one (housekeeping) would otherwise
    // cost a look into every project directory on each read
    if (this.trusted()) {
      const name = `${sessionId}.jsonl`;
      const reported = [...this.reportedFiles].find((file) => basename(file) === name);
      if (!reported) return null;
      const at = { projectId: basename(dirname(reported)), file: reported };
      return (await stat(reported).then(() => true, () => false)) ? at : null;
    }
    const dirs = await this.projectDirs();
    const hits = await mapLimit(dirs, LIST_FILES_AT_ONCE, async (dir) => {
      const file = join(this.config.projectsDir, dir, `${sessionId}.jsonl`);
      return (await stat(file).then((s) => s.isFile(), () => false)) ? { projectId: dir, file } : null;
    });
    const at = hits.find((hit) => hit !== null) ?? null;
    if (at) this.files.set(sessionId, at);
    return at;
  }

  /** What the listing holds of one transcript, looked at again unless a watcher says it is current. */
  private async summaryAt(found: { projectId: string; file: string }): Promise<TranscriptSummary | null> {
    if (this.current(found.file)) return this.listed.get(found.file)?.summary ?? null;
    // Looked at now, so the listing need not look again; a change reported while this runs is kept
    this.reportedFiles.delete(found.file);
    return (await this.check(found.projectId, found.file))?.summary ?? null;
  }

  /**
   * Drops what was read after something outside this store changed the transcripts on disk: of one
   * project's directory when that is all that changed, or of all of them. A project's directory
   * name is also the start of its worktrees', and those go with it: dropping too much only costs a
   * read, keeping a deleted transcript would list it.
   */
  invalidate(projectId?: string): void {
    const prefix = projectId === undefined ? null : join(this.config.projectsDir, projectId);
    const drop = (file: string) => prefix === null || file.startsWith(prefix);
    // The listing looks at every file again; what did not change is not read again
    this.unknown = true;
    for (const file of [...this.pages.keys()]) if (drop(file)) this.pages.delete(file);
    for (const [id, at] of [...this.files]) if (drop(at.file)) this.files.delete(id);
    this.activities.forget(drop);
    this.toolEntries.forget(drop);
    this.editStepFolds.forget(drop);
    this.correctionFolds.forget(drop);
    this.agentFiles.forget(drop);
    this.workflowMemo.forget(drop);
  }

  /** The summary of one session, from the listing: its transcript is read only past where the last pass stopped. */
  async summary(sessionId: string): Promise<TranscriptSummary | null> {
    const found = await this.findFile(sessionId);
    return found ? this.summaryAt(found) : null;
  }

  /**
   * What a session launched in the background and when each piece stopped, folded over its
   * transcript. The lists that use it are polled every couple of seconds and a transcript runs to
   * megabytes, so a file that grew is only read for what was appended.
   */
  private async activity(file: string): Promise<SessionActivity> {
    const activity = await this.activities.read(file);
    if (!activity) throw new Error('session not found');
    return activity;
  }

  /**
   * Background agents a session spawned, read from what the CLI writes beside its transcript. This
   * is what makes them visible for a session started from a terminal, whose live stream the
   * wrapper never sees — and for a run after a restart, whose in-memory list is gone.
   *
   * The CLI gives no explicit "running" flag. It notifies the parent each time an agent stops, and
   * an agent can be resumed and stop again, so the state is: running until the first notification,
   * and running again whenever the agent writes after its latest one. `live` says whether the
   * session is still around: an agent of a session that ended cannot still be working.
   */
  async subagents(sessionId: string, live = true): Promise<SubagentInfo[]> {
    const found = await this.findFile(sessionId);
    if (!found) return [];
    const dir = join(found.file.slice(0, -'.jsonl'.length), 'subagents');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return []; // no subagents yet
    }
    const activity = await this.activity(found.file);

    const out: SubagentInfo[] = [];
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      const agentId = name.slice('agent-'.length, -'.meta.json'.length);
      let meta: { agentType?: string; description?: string; toolUseId?: string; requestShape?: string };
      try {
        meta = JSON.parse(await readFile(join(dir, name), 'utf8')) as typeof meta;
      } catch {
        continue;
      }
      const transcriptFile = join(dir, `agent-${agentId}.jsonl`);
      const transcript = await stat(transcriptFile).catch(() => null);
      let cwd = this.cwdCache.get(transcriptFile);
      if (cwd === undefined && transcript) {
        cwd = await firstCwd(transcriptFile);
        // Only a found value is final: an agent that has not written a line yet will
        if (cwd) this.cwdCache.set(transcriptFile, cwd);
      }
      const lastActivityAt = transcript ? transcript.mtime.toISOString() : null;
      const { state, launch, runs } = agentFacts(activity, agentId, transcript?.mtime ?? null, live, lastActivityAt);
      out.push({
        toolUseId: meta.toolUseId ?? '',
        subagentType: meta.agentType ?? 'agent',
        description: meta.description ?? agentId,
        status: state.status,
        startedAt: launch ?? new Date(0).toISOString(),
        endedAt: state.endedAt,
        runs,
        agentId,
        lastActivityAt,
        cwd: cwd ?? null,
        background: meta.requestShape === 'background',
      });
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Claude Code workflows a session ran, from the records and journals beside its transcript. */
  async workflows(sessionId: string, live = true): Promise<WorkflowRun[]> {
    const found = await this.findFile(sessionId);
    return found ? readSessionWorkflows(found.file, sessionId, live, this.workflowMemo) : [];
  }

  /** A workflow run's tasks as its journal has them, from line `from` on; null when the session is not found. */
  async workflowJournal(sessionId: string, runId: string, from = 0): Promise<JournalRead | null> {
    const found = await this.findFile(sessionId);
    return found ? readJournalTasks(found.file, runId, from) : null;
  }

  /**
   * Shell commands a session sent to the background — by the model or by the person at the
   * terminal — and the monitors it started. Agents are background tasks to the CLI too, under the same ids; they are left to
   * {@link subagents} so nothing is listed twice.
   */
  async backgroundTasks(sessionId: string, live = true): Promise<BackgroundTask[]> {
    const found = await this.findFile(sessionId);
    if (!found) return [];
    const activity = await this.activity(found.file);
    const launches = new Map<string, TaskLaunch>(activity.tasks);
    const stops = new Map(activity.stops);
    // A task a subagent started is launched, and reported back, in that subagent's own transcript:
    // the session's never mentions it. (Inferred from the CLI's transcript format; no real capture
    // of a subagent-owned task was available to check it against.)
    for (const { agentId, activity: own } of await this.subagentActivity(found.file)) {
      for (const [id, launch] of own.tasks) if (!launches.has(id)) launches.set(id, { ...launch, ownerAgentId: agentId });
      for (const [id, stop] of own.stops) {
        const known = stops.get(id);
        if (!known || stop.at > known.at) stops.set(id, stop);
      }
    }
    const out: BackgroundTask[] = [];
    const nowIso = new Date().toISOString();
    // When a session that ended took its commands down with it: the last thing it wrote
    const endedWith = live ? null : ((await stat(found.file).catch(() => null))?.mtime.toISOString() ?? nowIso);
    for (const [id, launch] of launches) {
      const stop = stops.get(id);
      // The CLI kills a monitor at its timeout; should that notice not have reached the transcript,
      // the watch still cannot be running past it
      const expired = !stop && launch.expiresAt !== null && launch.expiresAt <= nowIso;
      out.push({
        id,
        type: launch.type,
        description: launch.description ?? launch.command ?? id,
        // A command whose session ended without reporting it back was taken down with it
        status: stop ? stop.status : expired || !live ? 'stopped' : 'running',
        toolUseId: launch.toolUseId,
        startedAt: launch.at,
        endedAt: stop?.at ?? (expired ? launch.expiresAt : endedWith),
        summary: stop?.summary ?? null,
        sessionId,
        command: launch.command,
        backgroundedByUser: launch.backgroundedByUser,
        ...(launch.ownerAgentId ? { fromSubagent: true, ownerAgentId: launch.ownerAgentId } : {}),
      });
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Which subagent launched each background task, read from the subagents' transcripts. A run's
   * live stream only says a task is `owned_by_subagent`, never by which one.
   */
  async taskOwners(sessionId: string): Promise<Map<string, string>> {
    const found = await this.findFile(sessionId);
    const owners = new Map<string, string>();
    if (!found) return owners;
    for (const { agentId, activity } of await this.subagentActivity(found.file)) {
      for (const id of activity.tasks.keys()) owners.set(id, agentId);
    }
    return owners;
  }

  /** What each of a session's subagents launched and saw stop, from their own transcripts. */
  private async subagentActivity(transcript: string): Promise<Array<{ agentId: string; activity: SessionActivity }>> {
    const dir = join(transcript.slice(0, -'.jsonl'.length), 'subagents');
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: Array<{ agentId: string; activity: SessionActivity }> = [];
    for (const name of names) {
      const agentId = /^agent-(.+)\.jsonl$/.exec(name)?.[1];
      if (!agentId) continue;
      const activity = await this.activity(join(dir, name)).catch(() => null);
      if (activity) out.push({ agentId, activity });
    }
    return out;
  }

  /**
   * What a background task wrote, from the file the CLI keeps under its temp dir. The path is
   * always derived from the ids, never taken from the transcript: a notification is just text in a
   * message, and trusting a path found there would read whatever file someone typed into one.
   */
  async taskOutput(sessionId: string, taskId: string, opts: { offset?: number } = {}): Promise<BackgroundTaskOutput> {
    if (!/^[\w-]+$/.test(taskId)) throw new Error('invalid task id');
    const found = await this.findFile(sessionId);
    if (!found) throw new Error('session not found');
    const file = join(taskDir(found.projectId, sessionId), `${taskId}.output`);
    const info = await stat(file).catch(() => null);
    if (!info) throw new Error('no output was kept for that task (it lives in the temp dir, which a reboot clears)');

    // Following a running task: `offset` is where the last read ended. Past the end means the file
    // was replaced under it, and the caller starts over from the tail.
    const resumed = opts.offset !== undefined && opts.offset <= info.size;
    const reset = opts.offset !== undefined && !resumed;
    const start = resumed ? (opts.offset as number) : Math.max(0, info.size - MAX_TASK_OUTPUT);
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(info.size - start, MAX_TASK_OUTPUT));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const read = buffer.subarray(0, bytesRead);
      const end = completeUtf8(read);
      return {
        taskId,
        output: read.subarray(0, end).toString('utf8'),
        truncated: !resumed && start > 0,
        bytes: info.size,
        offset: start + end,
        ...(reset ? { reset } : {}),
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * One subagent's, or with `runId` one workflow agent's, prompt, outcome and whole conversation.
   * Ids go into file paths, so both are validated first. Null when the session or the agent is not
   * there. `after` skips the entries the caller already has, so a live panel appends instead of
   * re-reading a transcript that can run to megabytes on every update.
   */
  async agentTranscript(
    sessionId: string,
    agentId: string,
    opts: { runId?: string; after?: number; live?: boolean } = {},
  ): Promise<AgentTranscript | null> {
    if (!AGENT_ID_RE.test(agentId)) throw new Error('invalid agent id');
    if (opts.runId !== undefined && !WORKFLOW_RUN_ID_RE.test(opts.runId)) throw new Error('invalid workflow run id');
    const found = await this.findFile(sessionId);
    if (!found) return null;
    const live = opts.live ?? true;
    const base = found.file.slice(0, -'.jsonl'.length);
    const dir = opts.runId ? join(base, 'subagents', 'workflows', opts.runId) : join(base, 'subagents');
    const file = join(dir, `agent-${agentId}.jsonl`);
    const info = await stat(file).catch(() => null);
    let meta: { agentType?: string; description?: string; toolUseId?: string; requestShape?: string; workflowPhase?: string } | null;
    try {
      meta = JSON.parse(await readFile(join(dir, `agent-${agentId}.meta.json`), 'utf8')) as NonNullable<typeof meta>;
    } catch {
      meta = null;
    }
    if (!info && !meta) return null;
    const folded = info ? await this.agentFiles.read(file) : null;
    const read = folded ? agentRead(folded) : emptyAgentRead();
    const lastActivityAt = info?.mtime.toISOString() ?? null;

    let status: AgentTranscript['status'];
    let startedAt: string | null;
    let endedAt: string | null;
    let durationMs: number | null = null;
    let runs: ChatBranchRun[] = [];
    let description = meta?.description ?? null;
    let workflowPhase = meta?.workflowPhase ?? null;
    if (opts.runId) {
      const { agent, journalDone } = await readWorkflowAgent(found.file, opts.runId, agentId);
      status = agent?.state === 'done' || journalDone ? 'completed' : agent?.state === 'error' ? 'failed' : live ? 'running' : 'stopped';
      startedAt = agent?.startedAt ?? read.firstAt;
      const finished = status === 'completed' || status === 'failed';
      durationMs = agent?.durationMs ?? null;
      endedAt = !finished ? (live ? null : lastActivityAt) : startedAt && durationMs !== null ? new Date(Date.parse(startedAt) + durationMs).toISOString() : read.lastAt;
      description ??= agent?.label ?? null;
      workflowPhase ??= agent?.phaseTitle ?? null;
    } else {
      const activity = await this.activity(found.file);
      const facts = agentFacts(activity, agentId, info?.mtime ?? null, live, read.firstAt);
      ({ status, endedAt } = facts.state);
      startedAt = facts.launch;
      runs = facts.runs;
      if (status !== 'running') durationMs = runsElapsedMs(runs, 0);
    }
    if (durationMs === null && startedAt && endedAt) durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));

    const total = read.entries.length;
    const from = opts.after !== undefined && opts.after <= total ? opts.after : 0;
    return {
      agentId,
      sessionId,
      kind: opts.runId ? 'workflow' : 'subagent',
      workflowRunId: opts.runId ?? null,
      subagentType: meta?.agentType ?? null,
      description,
      workflowPhase,
      prompt: read.prompt,
      status,
      background: meta?.requestShape === 'background',
      startedAt,
      endedAt,
      durationMs,
      runs,
      lastActivityAt,
      model: read.model,
      usage: read.usage,
      toolCalls: read.toolCalls,
      cwd: read.cwd,
      result: read.result,
      entries: read.entries.slice(from),
      from,
      total,
      tasks: opts.runId ? [] : (await this.backgroundTasks(sessionId, live)).filter((t) => t.ownerAgentId === agentId).map(toChatTask),
    };
  }

  /** Deletes the transcript and the session's sidecar directory (subagent transcripts, tool results). */
  async deleteSession(sessionId: string): Promise<void> {
    const found = await this.findFile(sessionId);
    if (!found) throw new Error('session not found');
    // The transcript goes last: it is what finds the session, so a deletion cut short can be retried
    await rm(found.file.slice(0, -'.jsonl'.length), { recursive: true, force: true });
    await rm(found.file);
    this.pages.delete(found.file);
    this.drop(found.file);
    this.files.delete(sessionId);
    // Its folds and its sidecar's go too: nothing else would ever let go of them
    const base = found.file.slice(0, -'.jsonl'.length);
    const gone = (file: string) => file === found.file || file.startsWith(`${base}${sep}`);
    this.activities.forget(gone);
    this.toolEntries.forget(gone);
    this.editStepFolds.forget(gone);
    this.correctionFolds.forget(gone);
    this.agentFiles.forget(gone);
    this.workflowMemo.forget(gone);
  }

  /**
   * A window of a session's transcript: the newest `limit` entries, or the ones just before
   * `before` (an index from a previous page) to read further back.
   *
   * A long conversation runs to tens of megabytes, and reading all of it to hand back the last
   * screenful is what made opening one slow. The byte offsets of its entries are indexed once and
   * extended as the session grows, so a page reads the bytes of its own lines and no others.
   */
  async getSession(
    sessionId: string,
    opts: { includeSidechains?: boolean; limit?: number; before?: number } = {},
  ): Promise<TranscriptPage | null> {
    const found = await this.findFile(sessionId);
    if (!found) return null;
    const limit = pageSize(opts.limit);
    const before = opts.before !== undefined && Number.isFinite(opts.before) ? Math.max(0, Math.trunc(opts.before)) : null;
    const sidechains = opts.includeSidechains === true;

    for (let attempt = 0; ; attempt++) {
      const [summary, state] = await Promise.all([this.summaryAt(found), this.paged(found.file, attempt > 0)]);
      if (!summary || !state) return null;
      const total = state.entries.count(sidechains);
      const to = before === null ? total : Math.min(before, total);
      const from = before === null ? Math.max(0, total - limit) : Math.max(0, before - limit);
      // A `before` at the start or past the end has nothing before it in range
      if (from >= to) return { summary, entries: [], from: total, total };

      const ranges = state.entries.ranges(from, to, sidechains);
      const handle = await open(found.file, 'r').catch(() => null);
      if (!handle) return null;
      let lines: (JsonLine | null)[];
      try {
        lines = await readLines(handle, ranges);
      } finally {
        await handle.close();
      }
      const entries: TranscriptEntry[] = [];
      for (const line of lines) {
        const entry = line ? normalizeMessage(line) : null;
        if (entry) entries.push(entry);
      }
      if (entries.length === ranges.length) return { summary, entries, from, total };
      // The file was rewritten between indexing it and reading the page: index it again, once
      if (attempt > 0) return { summary, entries, from, total };
    }
  }

  /**
   * The entry offsets of a transcript as it is on disk now, read on from where the last pass
   * stopped. Requests for one file queue behind each other, so two of them never extend the same
   * index at once; `reindex` starts it over.
   */
  private paged(file: string, reindex: boolean): Promise<Paged | null> {
    const previous = reindex ? undefined : this.pages.get(file);
    const next = (previous ?? Promise.resolve(null)).catch(() => null).then((old) => this.index(file, old));
    this.pages.delete(file);
    this.pages.set(file, next);
    for (const oldest of this.pages.keys()) {
      if (this.pages.size <= PAGED_FILES) break;
      this.pages.delete(oldest);
    }
    return next;
  }

  private async index(file: string, old: Paged | null): Promise<Paged | null> {
    const handle = await open(file, 'r').catch(() => null);
    if (!handle) return null;
    try {
      const info = await handle.stat();
      if (old && unchanged(old, info)) return old;
      const base = (await goesOn(handle, old, info)) ? old : null;
      const added: [number, number, boolean][] = [];
      const { end, tail } = await scanLines(handle, base?.end ?? 0, info.size, (o, start, lineEnd) => {
        const entry = normalizeMessage(o);
        if (entry) added.push([start, lineEnd, entry.isSidechain]);
      });
      // A last line without its newline yet is an entry if it parses, but stays out of what the
      // next pass goes on from: it is read again once it is finished
      const tailLine = parseLine(tail);
      const tailEntry = tailLine ? normalizeMessage(tailLine) : null;
      const entries = base?.entries ?? new EntryIndex();
      for (const [start, lineEnd, sidechain] of added) entries.add(start, lineEnd, sidechain);
      entries.setTail(tailEntry ? { start: end, end: end + tail.length, sidechain: tailEntry.isSidechain } : null);
      return { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, end, fingerprint: await fingerprint(handle, end), entries };
    } finally {
      await handle.close();
    }
  }

  /**
   * Every call of the tools in `names` across a whole transcript, with its result, oldest first.
   * Null when there is no such session. A line is parsed only when it mentions a tool at all, and
   * whatever is not a call or a result is dropped at once, so a transcript of many megabytes is
   * read for what a checklist or a file list needs and no more; after that, only what it appended.
   */
  async toolCalls(sessionId: string, names: ReadonlySet<string>): Promise<ToolCall[] | null> {
    const found = await this.findFile(sessionId);
    if (!found) return null;
    const entries = await this.toolEntries.read(found.file);
    return entries ? toolCallsOf(entries, names) : null;
  }

  /**
   * What a transcript says about its edits: each writing call with its patch and the sentence
   * before it. Null when there is no such session. Read once, streaming; after that, only what the
   * transcript appended.
   */
  async editSteps(sessionId: string): Promise<EditStepsState | null> {
    const found = await this.findFile(sessionId);
    if (!found) return null;
    return this.editStepFolds.read(found.file);
  }

  /**
   * What a transcript says about the person correcting the agent (the lessons' pre-filter): their
   * messages, the edits and commands that undid something, the tool errors that repeated. Null
   * when there is no such session. Read once, streaming; after that, only what it appended.
   */
  async corrections(sessionId: string): Promise<CorrectionState | null> {
    const found = await this.findFile(sessionId);
    if (!found) return null;
    return this.correctionFolds.read(found.file);
  }

  /**
   * The entries of a whole transcript whose text contains `query`, indexed the way `getSession`
   * pages them (same filtering, so the same `total`): the view holds a window, and a search has to
   * reach the pages it has not loaded. Null when there is no such session.
   */
  async searchSession(sessionId: string, query: string, opts: { includeSidechains?: boolean } = {}): Promise<TranscriptSearchResult | null> {
    const pattern = searchPattern(query);
    if (!pattern) throw new Error('q is required');
    const found = await this.findFile(sessionId);
    if (!found) return null;
    const search = new TranscriptSearch(query, pattern);
    for await (const o of readJsonl(found.file)) {
      const entry = normalizeMessage(o);
      if (!entry) continue;
      if (entry.isSidechain && !opts.includeSidechains) continue;
      search.add(entrySearchText(entry));
    }
    return search.result();
  }
}
