import { existsSync } from 'node:fs';
import { ChatNotFoundError } from './chat-errors.ts';
import { systemTempDirs } from './temp-dirs.ts';
import type {
  ChangeSummary,
  ChatChanges,
  ChatSummary,
  Checklist,
  DiffContext,
  EditStep,
  FileDiff,
  Orchestration,
  OrchestrationTaskState,
  TranscriptEntry,
} from '@claudio/shared';
import type { ChatService } from './chat-service.ts';
import type { DecisionEngine } from './decisions/engine.ts';
import type { ChatManager } from './chats.ts';
import { editStepsFromEntries, editStepsOf } from './edit-steps.ts';
import {
  aheadCountAsync,
  branchExistsAsync,
  commitsBetweenAsync,
  currentBranchAsync,
  diffFilesAsync,
  fileDiffAsync,
  headCommitAsync,
  isAncestorAsync,
  isGitRepoAsync,
  isUntrackedAsync,
  lineCountAsync,
  mainCheckoutAsync,
  mainTopLevelAsync,
  mergeBaseAsync,
  parentOfAsync,
  resolveCommitAsync,
  topLevelAsync,
  uncommittedFilesAsync,
  untrackedDiffAsync,
  workingFilesAsync,
  pathInside,
} from './git.ts';
import type { Orchestrator } from './orchestrator.ts';
import type { SessionStore } from './sessions.ts';
import { checklistOf, CHECKLIST_TOOLS, toolCallsOf, touchedFilesOf, WRITING_TOOLS, type ToolCall } from './tool-calls.ts';

/** Where the work of one branch lives and what it is measured against. */
interface Site {
  /** The main checkout: where the branch can still be read once its worktree is gone */
  repo: string;
  worktree: string | null;
  branch: string | null;
  base: string | null;
}

/** Which part of a branch's work to show: all of it, one of its commits, or what is not committed. */
export interface ChangeScope {
  commit?: string;
  uncommitted?: boolean;
}

export interface DiffOptions extends ChangeScope {
  context?: DiffContext;
}

const DEFAULT_CONTEXT = 3;
const MAX_CONTEXT = 500;
/** Past this a whole file is more than anyone reads in a diff, and more than a page should draw */
const FULL_LIMIT = 20_000;

/** `?context=` as a request sends it: a count of lines or `full`; anything else is the default. */
export function parseDiffContext(raw: unknown): DiffContext {
  if (raw === 'full') return 'full';
  // A repeated parameter arrives as a list: not a count either
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return DEFAULT_CONTEXT;
  return Math.min(MAX_CONTEXT, Number(raw.trim()));
}

/** `?commit=` and `?uncommitted=` as a request sends them; asking for both at once is refused. */
export function parseChangeScope(query: { commit?: unknown; uncommitted?: unknown }): ChangeScope {
  if (Array.isArray(query.commit) || Array.isArray(query.uncommitted)) throw new Error('commit and uncommitted are given once each');
  const uncommitted = query.uncommitted === '1' || query.uncommitted === 'true';
  const commit = (typeof query.commit === 'string' ? query.commit.trim() : '') || undefined;
  if (commit && uncommitted) throw new Error('commit and uncommitted cannot be asked for together');
  return { ...(commit ? { commit } : {}), ...(uncommitted ? { uncommitted } : {}) };
}

const emptySummary = (site: Site): ChangeSummary => ({ branch: site.branch, base: site.base, ahead: 0, commits: [], files: [], uncommitted: [] });

/** The worktree when it is still on disk: the CLI removes one that changed nothing. */
const liveWorktree = (site: Site): string | null => (site.worktree && existsSync(site.worktree) ? site.worktree : null);

/** What to read the branch through: its worktree's HEAD, or the branch by name once the worktree is gone. */
async function reader(site: Site): Promise<{ dir: string; ref: string } | null> {
  const live = liveWorktree(site);
  if (live) return { dir: live, ref: 'HEAD' };
  if (site.branch && (await branchExistsAsync(site.repo, site.branch))) return { dir: site.repo, ref: site.branch };
  return null;
}

/**
 * The commit a request names, as a full hash, once it is known to be on the branch since its base.
 * Checked by ancestry both ways rather than against the commit list, which stops at 200.
 */
async function commitOnBranch(dir: string, ref: string, base: string | null, sha: string): Promise<string> {
  const commit = await resolveCommitAsync(dir, sha);
  const since = base ? await resolveCommitAsync(dir, base) : null;
  if (!commit || !since || commit === since || !(await isAncestorAsync(dir, since, commit)) || !(await isAncestorAsync(dir, commit, ref))) {
    throw new Error(`commit ${sha} is not on this branch since its base`);
  }
  return commit;
}

async function summarize(site: Site, scope: ChangeScope = {}): Promise<ChangeSummary> {
  const at = await reader(site);
  if (!at || !site.base) {
    if (scope.commit) throw new Error(`commit ${scope.commit} is not on this branch since its base`);
    return emptySummary(site);
  }
  const live = liveWorktree(site);
  const uncommitted = live ? await uncommittedFilesAsync(live) : [];
  const [current, ahead, commits] = await Promise.all([
    live ? currentBranchAsync(live) : Promise.resolve(null),
    aheadCountAsync(at.dir, site.base, at.ref),
    commitsBetweenAsync(at.dir, site.base, at.ref),
  ]);
  const branch: Omit<ChangeSummary, 'files'> = { branch: current ?? site.branch, base: site.base, ahead, commits, uncommitted };
  // A scope narrows the files and nothing else: the rest describes the branch, which the scope menu lists
  if (scope.commit) {
    const commit = await commitOnBranch(at.dir, at.ref, site.base, scope.commit);
    return { ...branch, files: await diffFilesAsync(at.dir, await parentOfAsync(at.dir, commit), commit) };
  }
  if (scope.uncommitted) return { ...branch, files: uncommitted };
  const files = await diffFilesAsync(at.dir, site.base, at.ref);
  return { ...branch, files, working: live ? await workingFilesAsync(live, site.base) : files };
}

/**
 * The `--unified` count for `context`, and whether it carries the whole file: `full` becomes a
 * count above the longest side's lines, unless the file is too long to be worth it.
 */
async function unifiedFor(context: DiffContext, sides: () => Promise<number[]>): Promise<{ unified: number; full: boolean }> {
  if (context !== 'full') return { unified: Number.isFinite(context) ? Math.min(MAX_CONTEXT, Math.max(0, Math.trunc(context))) : DEFAULT_CONTEXT, full: false };
  const longest = Math.max(0, ...(await sides()));
  return longest > FULL_LIMIT ? { unified: DEFAULT_CONTEXT, full: false } : { unified: longest + 1, full: true };
}

/**
 * One file as the panel opens it. By default everything the branch did to it against the base,
 * committed or not, since a worker's last edit is usually the interesting part and it is not
 * committed yet; or what one commit did to it, or what is not committed yet.
 */
async function diffOf(site: Site, path: string, opts: DiffOptions = {}): Promise<FileDiff> {
  const at = await reader(site);
  if (!at || !site.base) throw new Error(`nothing to compare ${path} against: the branch has no worktree or base`);
  const live = liveWorktree(site);
  const rel = pathInside(at.dir, path);
  const context = opts.context ?? DEFAULT_CONTEXT;

  let dir = at.dir;
  let from = site.base;
  let to: string | undefined = live ? undefined : at.ref;
  if (opts.commit) {
    to = await commitOnBranch(at.dir, at.ref, site.base, opts.commit);
    from = await parentOfAsync(at.dir, to);
  } else if (opts.uncommitted) {
    if (!live) throw new Error(`${rel} not found among the uncommitted changes: the worktree is gone`);
    dir = live;
    from = 'HEAD';
  }

  // A file that was created and never added is invisible to `git diff`
  if (live && to === undefined && (await isUntrackedAsync(live, rel))) {
    const { full } = await unifiedFor(context, async () => [await lineCountAsync(live, undefined, rel)]);
    return { path: rel, diff: await untrackedDiffAsync(live, rel), full };
  }
  const known = (await diffFilesAsync(dir, from, to)).find((f) => f.path === rel);
  const paths = known?.previousPath ? [known.previousPath, rel] : [rel];
  const { unified, full } = await unifiedFor(context, () => Promise.all([lineCountAsync(dir, from, paths[0] as string), lineCountAsync(dir, to, rel)]));
  const diff = await fileDiffAsync(dir, from, to, paths, unified);
  if (!diff) throw new Error(`${rel} not found among the changes against ${from.slice(0, 8)}`);
  return { path: rel, diff, full };
}

/** The commit a checkout is on, or null when it is gone or not a repository any more. */
async function tipOf(dir: string | null): Promise<string | null> {
  if (!dir || !existsSync(dir) || !(await isGitRepoAsync(dir))) return null;
  try {
    return await headCommitAsync(dir);
  } catch {
    return null;
  }
}

const EMPTY_CHECKLIST: Checklist = { items: [], updatedAt: null };

export interface ChangesDeps {
  orchestrator: Orchestrator;
  chats: ChatService;
  sessions: SessionStore;
  runtime: ChatManager;
  /**
   * The directory a chat's worktree left from, when that is not the main checkout: the project of
   * the work item the chat works on, which may itself be a linked worktree on another branch
   */
  forkedFrom?: (chatId: string) => string | null;
  /** The decision engine: both points here are suggestions, prepared in the background and never waited for */
  decisions?: Pick<DecisionEngine, 'ask' | 'effective'>;
}

/** What a question was already asked about, so a page that polls does not pay for the same answer twice */
const MAX_ASKED = 2000;
/** Steps asked about per read, and what is sent of one: a hunk must leave room for the sentence before it */
const HUNKS_PER_READ = 5;
const HUNK_CHARS = 3000;
const COMMITS_ASKED = 20;
const PATHS_PER_COMMIT = 40;

/**
 * What a branch or a chat has actually done on disk, read from git and from the transcript rather
 * than from what the agent says it did.
 */
export class Changes {
  private readonly asked = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: ChangesDeps) {}

  /** Resolves once every question asked in the background is over: what a test waits on instead of a clock */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** True the first time a key is seen */
  private firstTime(key: string): boolean {
    if (this.asked.has(key)) return false;
    this.asked.add(key);
    if (this.asked.size > MAX_ASKED) for (const old of [...this.asked].slice(0, MAX_ASKED / 2)) this.asked.delete(old);
    return true;
  }

  /**
   * `flow.scope-drift`: which commits of a work item's branch do more than the card asks. Nothing
   * compares a commit with its card today, so this only adds a flag: the answer is a row a person
   * reads (and rates), never a change to the branch. Returns the hashes it flagged, and nothing
   * unless the point acted.
   */
  async scopeDrift(
    projectPath: string,
    place: { worktree: string | null; branch: string | null },
    item: { id: string; projectId: string; title: string; criteria: readonly string[] },
  ): Promise<string[]> {
    const engine = this.deps.decisions;
    if (!engine || engine.effective('flow.scope-drift', item.projectId).mode === 'off') return [];
    let commits: Array<{ id: string; message: string; paths: string[] }>;
    try {
      const summary = await this.itemChanges(projectPath, place);
      const tip = summary?.commits[0];
      if (!summary || !tip || !this.firstTime(`drift:${item.id}:${tip.hash}`)) return [];
      // Paths only, never the diff: what a commit touched says enough about what it set out to do
      commits = await Promise.all(
        summary.commits.slice(0, COMMITS_ASKED).map(async (c) => ({
          id: c.hash,
          message: c.subject,
          paths: ((await this.itemChanges(projectPath, place, { commit: c.hash }))?.files ?? []).slice(0, PATHS_PER_COMMIT).map((f) => f.path),
        })),
      );
    } catch {
      return [];
    }
    const outcome = await engine.ask(
      'flow.scope-drift',
      { kind: 'work_item', id: item.id, data: { title: item.title, criteria: item.criteria, commits } },
      { projectId: item.projectId },
    );
    if (!outcome.act) return [];
    return commits.filter((c) => {
      const answer = outcome.answers?.[c.id];
      return answer?.kind === 'noul' && answer.value;
    }).map((c) => c.id);
  }

  /**
   * `changes.unexplained-hunk`: asks, in the background, whether the sentence a chat wrote before
   * an edit explains it. The answer is a row the review reads; nothing here waits for it.
   */
  private flagHunks(chat: ChatSummary, steps: readonly EditStep[]): void {
    const engine = this.deps.decisions;
    const projectId = chat.project?.id ?? null;
    if (!engine || engine.effective('changes.unexplained-hunk', projectId).mode === 'off') return;
    const fresh = steps.filter((s) => s.diff && !s.pending && this.firstTime(`hunk:${chat.id}:${s.id}`)).slice(0, HUNKS_PER_READ);
    for (const step of fresh) {
      const work = engine.ask(
        'changes.unexplained-hunk',
        { kind: 'chat', id: chat.id, data: { hunk: step.diff.slice(0, HUNK_CHARS), step: step.intent ?? '', title: chat.firstPrompt ?? chat.title } },
        { projectId },
      );
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    }
  }

  private orchestration(id: string): Orchestration {
    const orch = this.deps.orchestrator.get(id);
    if (!orch) throw new Error('orchestration not found');
    return orch;
  }

  private task(id: string, taskId: string): { orch: Orchestration; task: OrchestrationTaskState } {
    const orch = this.orchestration(id);
    const task = orch.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('task not found');
    return { orch, task };
  }

  /** The repository a graph's worktrees hang off; refused plainly when the graph never had one. */
  private async repoOf(orch: Orchestration): Promise<string> {
    if (!orch.worktree) throw new Error(`orchestration ${orch.name} has no worktrees: its tasks share one checkout, so there is no branch to compare`);
    if (!existsSync(orch.cwd) || !(await isGitRepoAsync(orch.cwd))) throw new Error(`${orch.cwd} is no longer a git repository`);
    return mainTopLevelAsync(orch.cwd);
  }

  private async taskSite(orch: Orchestration, task: OrchestrationTaskState): Promise<Site> {
    return { repo: await this.repoOf(orch), worktree: task.worktree ?? null, branch: task.branch ?? null, base: task.baseCommit ?? orch.baseCommit ?? null };
  }

  private async integrationSite(orch: Orchestration): Promise<Site> {
    const repo = await this.repoOf(orch);
    const { integration } = orch;
    return { repo, worktree: integration?.worktree ?? null, branch: integration?.branch ?? null, base: orch.baseCommit ?? null };
  }

  async taskChanges(id: string, taskId: string, scope: ChangeScope = {}): Promise<ChangeSummary> {
    const { orch, task } = this.task(id, taskId);
    return summarize(await this.taskSite(orch, task), scope);
  }

  async taskDiff(id: string, taskId: string, path: string, opts: DiffOptions = {}): Promise<FileDiff> {
    const { orch, task } = this.task(id, taskId);
    return diffOf(await this.taskSite(orch, task), path, opts);
  }

  async integrationChanges(id: string, scope: ChangeScope = {}): Promise<ChangeSummary> {
    return summarize(await this.integrationSite(this.orchestration(id)), scope);
  }

  async integrationDiff(id: string, path: string, opts: DiffOptions = {}): Promise<FileDiff> {
    return diffOf(await this.integrationSite(this.orchestration(id)), path, opts);
  }

  private async chatOf(id: string): Promise<ChatSummary> {
    const chat = await this.deps.chats.summaryOf(id);
    if (!chat) throw new ChatNotFoundError();
    return chat;
  }

  /**
   * The site of a chat that works in a worktree of its own. A worker of an orchestration is
   * measured from where its own branch was cut, which is not where the main checkout is now.
   */
  private async siteOf(chat: ChatSummary): Promise<Site | null> {
    if (chat.orchestration?.taskId) {
      const { orch, task } = this.task(chat.orchestration.id, chat.orchestration.taskId);
      if (orch.worktree && task.branch) return this.taskSite(orch, task);
    }
    const tree = chat.worktree;
    if (!tree || !existsSync(tree.path) || !(await isGitRepoAsync(tree.path))) return null;
    const repo = await mainTopLevelAsync(tree.path);
    // Where the worktree left the checkout it was cut from, whatever has landed there since
    const from = this.deps.forkedFrom?.(chat.id);
    const base = await mergeBaseAsync(tree.path, 'HEAD', (await tipOf(from ?? null)) ?? (await headCommitAsync(repo)));
    return { repo, worktree: tree.path, branch: tree.branch, base };
  }

  /**
   * The site of a work item's own worktree and branch, measured from where it left the project's
   * checkout (a linked worktree's HEAD is not the main checkout's), as a chat's is. Once the worktree is gone the branch is still read by name, from the
   * project's repository; null when neither is left.
   */
  private async itemSite(projectPath: string, place: { worktree: string | null; branch: string | null }): Promise<Site | null> {
    const live = place.worktree && existsSync(place.worktree) && (await isGitRepoAsync(place.worktree)) ? place.worktree : null;
    const from = live ?? (existsSync(projectPath) && (await isGitRepoAsync(projectPath)) ? projectPath : null);
    if (!from) return null;
    const repo = await mainCheckoutAsync(from);
    if (!live && !(place.branch && (await branchExistsAsync(repo, place.branch)))) return null;
    const tip = (await tipOf(projectPath)) ?? (await headCommitAsync(repo));
    const base = live ? await mergeBaseAsync(live, 'HEAD', tip) : await mergeBaseAsync(repo, place.branch ?? 'HEAD', tip);
    return { repo, worktree: live, branch: place.branch, base };
  }

  /** What a work item's branch changed; null while nothing has worked on it in a worktree. */
  async itemChanges(projectPath: string, place: { worktree: string | null; branch: string | null }, scope: ChangeScope = {}): Promise<ChangeSummary | null> {
    if (!place.worktree && !place.branch) return null;
    const site = await this.itemSite(projectPath, place);
    return site ? summarize(site, scope) : null;
  }

  async itemDiff(projectPath: string, place: { worktree: string | null; branch: string | null }, path: string, opts: DiffOptions = {}): Promise<FileDiff> {
    const site = await this.itemSite(projectPath, place);
    if (!site) throw new Error('this work item has no worktree or branch left to compare');
    return diffOf(site, path, opts);
  }

  /** A worktree gives a summary; a chat anywhere else has only what its own calls wrote. */
  async chatChanges(id: string, scope: ChangeScope = {}): Promise<ChatChanges> {
    const site = await this.siteOf(await this.chatOf(id));
    return {
      summary: site ? await summarize(site, scope) : null,
      touched: touchedFilesOf(await this.calls(id, WRITING_TOOLS)),
    };
  }

  async chatDiff(id: string, path: string, opts: DiffOptions = {}): Promise<FileDiff> {
    const site = await this.siteOf(await this.chatOf(id));
    if (!site) throw new Error('this chat has no worktree of its own, so there is no diff to show: see the files it touched');
    return diffOf(site, path, opts);
  }

  /**
   * What a step's path is relative to: the git top level of where the chat works, so it matches a
   * `ChangedFile.path`, or the chat's own directory outside git.
   */
  private async stepRoot(chat: ChatSummary): Promise<string> {
    const site = await this.siteOf(chat);
    const dir = (site && liveWorktree(site)) ?? (chat.worktree && existsSync(chat.worktree.path) ? chat.worktree.path : chat.cwd);
    if (existsSync(dir) && (await isGitRepoAsync(dir))) {
      try {
        return await topLevelAsync(dir);
      } catch {
        /* a bare or broken checkout: the directory itself will do */
      }
    }
    return dir;
  }

  /** Every edit of a chat's main transcript, oldest first, each with its patch and its why. */
  async chatSteps(id: string): Promise<EditStep[]> {
    const chat = await this.chatOf(id);
    const root = await this.stepRoot(chat);
    // The checkout counts as inside beside the chat's directory and its worktree: a chat in a subdirectory edits its siblings
    const risk = { cwd: chat.cwd, roots: [root, ...(chat.worktree ? [chat.worktree.path] : [])], tempDirs: systemTempDirs() };
    const opts = { root, running: chat.execution !== null, risk };
    const fromDisk = await this.deps.sessions.editSteps(id);
    let steps: EditStep[];
    if (fromDisk) steps = editStepsOf(fromDisk, opts);
    else {
      // No transcript yet, or never one: what the process streamed names the edits, without patches
      const streamed: TranscriptEntry[] | null = this.deps.runtime.messages(id);
      steps = streamed ? editStepsOf(editStepsFromEntries(streamed), opts) : [];
    }
    this.flagHunks(chat, steps);
    return steps;
  }

  /** A task's edits are its chat's; a task that has not started has made none. */
  async taskSteps(id: string, taskId: string): Promise<EditStep[]> {
    const { task } = this.task(id, taskId);
    const chat = task.sessionId ?? task.runId;
    return chat ? this.chatSteps(chat) : [];
  }

  private async calls(chatId: string, names: ReadonlySet<string>): Promise<ToolCall[]> {
    const fromDisk = await this.deps.sessions.toolCalls(chatId, names);
    if (fromDisk) return fromDisk;
    // A chat that has not written its transcript yet, or never will (housekeeping): what it streamed
    const streamed: TranscriptEntry[] | null = this.deps.runtime.messages(chatId);
    if (!streamed) throw new ChatNotFoundError();
    return toolCallsOf(streamed, names);
  }

  async chatChecklist(id: string): Promise<Checklist> {
    return checklistOf(await this.calls(id, CHECKLIST_TOOLS));
  }

  /** A task's own plan is the one its chat kept; a task that has not started has none. */
  async taskChecklist(id: string, taskId: string): Promise<Checklist> {
    const { task } = this.task(id, taskId);
    const chat = task.sessionId ?? task.runId;
    return chat ? this.chatChecklist(chat) : EMPTY_CHECKLIST;
  }
}
