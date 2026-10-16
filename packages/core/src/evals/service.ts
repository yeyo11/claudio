import type { EvalCase, EvalFile, EvalRun, EvalRunRequest, EvalRunSummary } from '@claudio/shared';
import { EvalFileError, type EvalConsents, type EvalDefinitionStore } from './definition.ts';
import { exportRun, loadEvalRun, type EvalExportFormat } from './export.ts';
import type { EvalRunner } from './runner.ts';
import type { EvalHistoryPage, EvalStore } from './store.ts';

export interface EvalServiceDeps {
  store: EvalStore;
  runner: EvalRunner;
  definitions: EvalDefinitionStore;
  consents: EvalConsents;
  /** The checkout of an imported project; null when it is not one */
  projectPath: (projectId: string) => string | null;
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

  files(projectId: string): Promise<EvalFile[]> {
    return this.deps.definitions.list(this.path(projectId));
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
