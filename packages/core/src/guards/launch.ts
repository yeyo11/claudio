/*
 * What every launch path does to guard a run (docs/plans/guards.md, "Core"): resolve the rules for
 * its kind, check that a guard can run, write its files, and hand the chat a plan. A path that
 * cannot be guarded fails with a `GuardUnavailableError` before any process spawns.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlowStage, GuardOverride, ProjectSettings, ProviderCapability } from '@claudio/shared';
import type { ChatGuardPlan } from '../live-chat.ts';
import type { GuardLaunch } from './command.ts';
import { writeGuardFiles } from './files.ts';
import { DEFAULT_LIMITS, type GuardRulesFile } from './input.ts';
import { GUARD_ENTRY_ENV, GuardPreflight, GuardUnavailableError, type GuardUnavailableCode, type PreflightInput } from './preflight.ts';
import { type GuardRunKind, type ResolvedGuards, resolveGuards } from './resolve.ts';
import type { GuardSettingsStore } from './settings.ts';

export interface GuardRequest {
  kind: GuardRunKind;
  /** Where the process starts; the root of the rules when the run has no worktree of its own */
  cwd: string;
  /** The run's own worktree, when it has one: the root `destructive` treats as the run's */
  worktree?: string | null;
  /** The project's checkout, for rules that also look at the main repository */
  mainCheckout?: string | null;
  graph?: GuardOverride | null;
  stage?: FlowStage;
  project?: Pick<ProjectSettings, 'guards' | 'flow'> | null;
  policy?: { commands?: boolean; edits?: boolean } | null;
  confined?: boolean;
  /** A person is in the chat */
  interactive?: boolean;
}

export interface GuardLauncherDeps {
  dataDir: string;
  settings: GuardSettingsStore;
  capabilities: () => readonly ProviderCapability[];
  preflight?: GuardPreflight;
  /** The guard's entry, when the caller knows it; else `CLAUDIO_GUARD_ENTRY`, the bundle's `guard.mjs`, or the source's `main.ts` */
  entry?: string;
}

const realOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** The bundled `guard.mjs` beside the code that runs, else the source file of a checkout */
function defaultEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, 'guard.mjs');
  return existsSync(bundled) ? bundled : join(here, 'main.ts');
}

export class GuardLauncher {
  private readonly preflight: GuardPreflight;

  constructor(private readonly deps: GuardLauncherDeps) {
    this.preflight = deps.preflight ?? new GuardPreflight();
  }

  /** The rules this run gets, or null for no guard. Pure over the stored settings. */
  resolve(request: GuardRequest): ResolvedGuards | null {
    return resolveGuards({
      kind: request.kind,
      settings: this.deps.settings.get(),
      graph: request.graph,
      ...(request.stage ? { stage: request.stage } : {}),
      project: request.project,
      policy: request.policy,
      confined: request.confined,
    });
  }

  private launch(): GuardLaunch {
    const entry = process.env[GUARD_ENTRY_ENV] || this.deps.entry || defaultEntry();
    return { execPath: process.execPath, entry, electron: !!process.versions.electron, nodeVersion: process.versions.node };
  }

  private claudeConfigDirs(): string[] {
    return [...new Set([process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')].filter((dir): dir is string => !!dir).map(realOrSelf))];
  }

  private input(launch: GuardLaunch, request: GuardRequest): PreflightInput {
    const operator = process.env[GUARD_ENTRY_ENV];
    return {
      launch,
      dataDir: this.deps.dataDir,
      roots: [request.worktree || request.cwd],
      installDirs: [dirname(dirname(dirname(realOrSelf(launch.entry))))],
      operatorEntry: operator || null,
      claudeConfigDirs: this.claudeConfigDirs(),
      cwd: request.cwd,
      capabilities: this.deps.capabilities(),
    };
  }

  private plan(resolved: ResolvedGuards, request: GuardRequest, launch: GuardLaunch): ChatGuardPlan {
    const roots = [...new Set([request.worktree || request.cwd, ...resolved.extraRoots].map(realOrSelf))];
    // The run's own scratch dir (Resolved question 1); the chat exports it as TMPDIR and removes it when the run ends
    const tmpDir = join(resolve(this.deps.dataDir), 'tmp', randomUUID());
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const rules: GuardRulesFile = {
      version: 1,
      mode: resolved.mode,
      rules: resolved.rules,
      roots,
      mainCheckout: request.mainCheckout ? realOrSelf(request.mainCheckout) : null,
      hooksPathDir: null,
      tmpDir: realOrSelf(tmpDir),
      allowDir: null,
      dataDir: realOrSelf(this.deps.dataDir),
      guardDir: realOrSelf(dirname(launch.entry)),
      claudeConfigDirs: this.claudeConfigDirs(),
      protectConfigs: resolved.protectConfigs,
      knownSecretSha256: [],
      limits: { ...DEFAULT_LIMITS },
    };
    const files = writeGuardFiles(this.deps.dataDir, rules, launch);
    return {
      rules: resolved.rules,
      mode: resolved.mode,
      settingsPath: files.settingsPath,
      rulesSha256: files.rulesSha256,
      ...(request.interactive ? { interactive: true } : {}),
      tmpDir,
    };
  }

  /** For a path that is asynchronous anyway (the flow, a chat): runs the self-test if it is due. */
  async prepare(request: GuardRequest): Promise<ChatGuardPlan | null> {
    const resolved = this.resolve(request);
    if (!resolved) return null;
    const launch = this.launch();
    await this.preflight.verify(this.input(launch, request));
    return this.plan(resolved, request, launch);
  }

  /**
   * For a path that starts its process in the same tick (the orchestrator). The self-test cannot be
   * awaited there, so it must have passed before (the server runs one at start); a launch that finds
   * none fails and starts one.
   */
  prepareNow(request: GuardRequest): ChatGuardPlan | null {
    const resolved = this.resolve(request);
    if (!resolved) return null;
    const launch = this.launch();
    this.preflight.verifyNow(this.input(launch, request));
    return this.plan(resolved, request, launch);
  }

  /** Whether a guard can run here, for Settings: the same checks a launch makes, against the data dir */
  async status(): Promise<{ available: boolean; problem: GuardUnavailableCode | null }> {
    try {
      await this.preflight.verify(this.input(this.launch(), { kind: 'chat', cwd: this.deps.dataDir }));
      return { available: true, problem: null };
    } catch (error) {
      if (error instanceof GuardUnavailableError) return { available: false, problem: error.code };
      throw error;
    }
  }

  /** At server start, so a broken guard is known before the first launch */
  warm(): void {
    void this.preflight.selfTest(this.launch()).catch(() => {});
  }
}

/** The failure a task or flow run records when its guard cannot run */
export function guardFailure(error: unknown): { code: 'guard-unavailable'; problem: string; message: string } | null {
  if (!(error instanceof GuardUnavailableError)) return null;
  return { code: 'guard-unavailable', problem: error.code, message: error.message };
}
