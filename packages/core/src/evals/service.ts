import type { EvalCall, EvalComparison, EvalEstimate, EvalFile, EvalFileDetail, EvalFileListItem, EvalRun, EvalRunRequest, EvalRunSummary, EvalSampleDetail, EvalVariant } from '@claudio/shared';
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
