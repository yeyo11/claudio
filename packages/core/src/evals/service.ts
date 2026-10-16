import { existsSync } from 'node:fs';
import { EVAL_DIR, type EvalCall, type EvalCase, type EvalComparison, type EvalEstimate, type EvalFile, type EvalFileDetail, type EvalFileListItem, type EvalGate, type EvalHead, type EvalRun, type EvalRunRequest, type EvalRunSummary, type EvalSampleDetail, type EvalVariant } from '@claudio/shared';
import { gitRaw, headCommit, isGitRepo } from '../git.js';
import { EvalFileError, type EvalConsents, type EvalDefinitionStore } from './definition.ts';
import { exportRun, loadEvalRun, type EvalExportFormat } from './export.ts';
import { EvalStartError, type EvalRunner } from './runner.ts';
import { compareVariants } from './score.ts';
import type { EvalHistoryPage, EvalStore } from './store.ts';

export interface EvalServiceDeps {
  store: EvalStore;
  runner: EvalRunner;
  definitions: EvalDefinitionStore;
  consents: EvalConsents;
  /** The checkout of an imported project; null when it is not one */
  projectPath: (projectId: string) => string | null;
  /** Whether the project has the Team module on: the evals are a section of it */
  teamOn: (projectId: string) => boolean;
}

/**
 * What the API calls: the eval files, the runs and their export, over the store and the runner. It
 * adds no policy of its own; the refusals are the runner's and the file store's.
 */
export class EvalService {
  constructor(private readonly deps: EvalServiceDeps) {}

  private path(projectId: string): string {
    const path = this.deps.projectPath(projectId);
    if (!path) throw new EvalFileError('not-found', 'the project is not imported');
    return path;
  }

  /** The project's evals, each with its newest run; refused while the Team module is off. */
  async files(projectId: string): Promise<EvalFileListItem[]> {
    const path = this.path(projectId);
    if (!this.deps.teamOn(projectId)) throw new EvalStartError('team-off', "the Team module is off in this project: switch it on in the project's settings to use evals");
    const files = await this.deps.definitions.list(path);
    return files.map((file) => ({ ...file, latestRun: this.deps.store.history(projectId, file.name, { limit: 1 }).runs[0] ?? null }));
  }

  /** The checkout's repository state: what "Pin to HEAD" pins, and which eval files the repository does not have as they are. */
  head(projectId: string): EvalHead {
    const path = this.path(projectId);
    if (!existsSync(path) || !isGitRepo(path)) return { git: false, sha: null, subject: null, uncommitted: [] };
    let sha: string;
    try {
      sha = headCommit(path).trim();
    } catch {
      return { git: true, sha: null, subject: null, uncommitted: [] };
    }
    const subject = gitRaw(path, ['log', '-1', '--format=%s', sha], { timeout: 10_000 }).trim();
    // Hooks and the fsmonitor are off, as in every call an eval makes (decision 15)
    const status = gitRaw(path, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=all', '--', EVAL_DIR], { timeout: 10_000 });
    const uncommitted = status
      .split('\n')
      .map((line) => /^.. "?.*claudio-evals\/([^/"]+)\.json"?$/.exec(line)?.[1])
      .filter((name): name is string => !!name);
    return { git: true, sha, subject, uncommitted };
  }

  /** One file and whether the person accepted this very content. */
  async detail(projectId: string, name: string): Promise<EvalFileDetail> {
    const file = await this.file(projectId, name);
    return { ...file, consented: file.sha !== '' && (await this.deps.consents.has(this.path(projectId), name, file.sha)) };
  }

  /** Strict write; `ifMatch` is the SHA the editor read. */
  write(projectId: string, name: string, definition: unknown, ifMatch: string | null): Promise<EvalFile> {
    return this.deps.definitions.write(this.path(projectId), name, definition, { ifMatch });
  }

  /** Removes the file and its consent; the history stays. False when there was no file. */
  async remove(projectId: string, name: string): Promise<boolean> {
    const path = this.path(projectId);
    const live = this.deps.store.liveRun(projectId);
    if (live && live.evalName === name) throw new EvalStartError('eval-running', 'this eval is running: stop it first');
    const removed = await this.deps.definitions.remove(path, name);
    if (removed) await this.deps.consents.revoke(path, name);
    return removed;
  }

  /** Records consent for `sha`, which must be the content on disk now. */
  async consent(projectId: string, name: string, sha: string): Promise<EvalFileDetail> {
    const file = await this.file(projectId, name);
    if (!file.definition) throw new EvalFileError('invalid', 'the eval file cannot run', file.problems);
    if (file.sha !== sha) throw new EvalFileError('changed-on-disk', 'the file changed on disk since it was read');
    await this.deps.consents.grant(this.path(projectId), name, sha);
    return { ...file, consented: true };
  }

  /** What a start would cost and need. Starts nothing. */
  async estimate(projectId: string, evalName: string, request: EvalRunRequest): Promise<EvalEstimate> {
    const file = await this.file(projectId, evalName);
    if (!file.definition) throw new EvalFileError('invalid', 'the eval file cannot run', file.problems);
    return this.deps.runner.estimate({ projectId, evalName, definition: file.definition, sha: file.sha, request });
  }

  resume(runId: string, confirmMaxCostUsd: number): Promise<EvalRunSummary> {
    return this.deps.runner.resume(runId, confirmMaxCostUsd);
  }

  /** A sample with its calls; null when the run has no such sample. */
  sample(runId: string, sampleId: string): EvalSampleDetail | null {
    const sample = this.deps.store.sample(sampleId);
    if (!sample || sample.runId !== runId) return null;
    const calls: EvalCall[] = this.deps.store.calls(sampleId);
    return { ...sample, calls };
  }

  /** Two variants of one run; null when the run does not exist. Both must be in the run. */
  compare(runId: string, base: EvalVariant, other: EvalVariant): EvalComparison | null {
    const summary = this.deps.store.summary(runId);
    if (!summary) return null;
    for (const v of [base, other]) if (!summary.variants.includes(v)) throw new EvalStartError('variant-not-in-run', `the run has no ${v} variant`);
    return compareVariants(runId, base, other, this.deps.store.samples(runId));
  }

  async file(projectId: string, name: string): Promise<EvalFile> {
    const file = await this.deps.definitions.read(this.path(projectId), name);
    if (!file) throw new EvalFileError('not-found', `there is no eval named ${name}`);
    return file;
  }

  /**
   * Appends a case through the strict write, for an accepted draft. `ifMatch` is the SHA the person
   * saw. A version 1 file becomes version 2 only when the case carries a version 2 field.
   */
  async appendCase(projectId: string, name: string, evalCase: EvalCase, ifMatch: string): Promise<EvalFile> {
    const file = await this.file(projectId, name);
    if (file.sha !== ifMatch) throw new EvalFileError('changed-on-disk', 'the file changed on disk since it was read');
    if (!file.definition) throw new EvalFileError('invalid', 'the eval file cannot take a case', file.problems);
    if (file.definition.cases.some((c) => c.id === evalCase.id)) throw new EvalFileError('invalid', `the eval already has a case ${evalCase.id}`, [`cases: duplicates another case (${evalCase.id})`]);
    const v2 = evalCase.prompts !== undefined || evalCase.mustHold !== undefined || evalCase.expect.some((e) => e.kind === 'judged');
    const definition = { ...file.definition, version: v2 ? 2 : file.definition.version, cases: [...file.definition.cases, evalCase] };
    return this.deps.definitions.write(this.path(projectId), name, definition, { ifMatch: file.sha });
  }

  /** Reads the file as it is on disk now: the SHA the run records is the one of the bytes it ran. */
  async start(projectId: string, evalName: string, request: EvalRunRequest, startedBy: 'person' | 'desktop' = 'person'): Promise<EvalRunSummary> {
    const file = await this.file(projectId, evalName);
    if (!file.definition) throw new EvalFileError('invalid', 'the eval file cannot run', file.problems);
    return this.deps.runner.start({ projectId, evalName, definition: file.definition, sha: file.sha, request, startedBy });
  }

  cancel(runId: string): Promise<EvalRunSummary | null> {
    return this.deps.runner.cancel(runId);
  }

  summary(runId: string): EvalRunSummary | null {
    return this.deps.store.summary(runId);
  }

  run(runId: string): EvalRun | null {
    return loadEvalRun(this.deps.store, runId);
  }

  live(projectId: string): EvalRunSummary | null {
    return this.deps.store.liveRun(projectId);
  }

  history(projectId: string, evalName: string | null, opts: { before?: string; limit?: number } = {}): EvalHistoryPage {
    this.path(projectId);
    return this.deps.store.history(projectId, evalName, opts);
  }

  /** False when the run does not exist or is still live. */
  deleteRun(runId: string): boolean {
    return this.deps.store.deleteRun(runId);
  }

  export(runId: string, format: EvalExportFormat): { body: string; contentType: string; filename: string } | null {
    return exportRun(this.deps.store, runId, format);
  }

  /** The promotion gate of a run with `current` and `proposed`; null before it ended or when it does not apply. */
  gate(runId: string): EvalGate | null {
    return this.deps.runner.gate(runId);
  }

  /** Judges again the samples a judge could not decide, without running them again. */
  rejudge(runId: string): Promise<{ rejudged: number; unjudged: number } | null> {
    return this.deps.runner.rejudge(runId);
  }

  /** Accepts an unreliable judge as it is. */
  acceptJudge(runId: string, caseId: string, idx: number): EvalGate | null {
    return this.deps.runner.acceptJudge(runId, caseId, idx);
  }

  isSample(chatId: string): boolean {
    return this.deps.runner.isSample(chatId);
  }

  /** After the chats are restored: runs whose owner is gone end `interrupted`. */
  load(): Promise<void> {
    return this.deps.runner.load();
  }

  close(): Promise<void> {
    return this.deps.runner.close();
  }
}
