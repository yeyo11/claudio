import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** What an item of a config dir is for: configuration follows the person's mode, history never does */
export type ItemClass = 'config' | 'history';

/**
 * What an account's config directory borrows from the default one, by class (plan
 * account-configuration-and-project-rules §2.4). Symlinks: Claude Code writes through them, so
 * editing from inside an account still lands in the one file. Identity (credentials, policy and
 * remote settings, the state file) and the CLI's caches and per-process state are never here, and
 * neither is `plugins/`, which is reconciled with the CLI's own commands (T2).
 */
export const CONFIG_ITEMS = ['settings.json', 'CLAUDE.md', 'keybindings.json', 'agents', 'commands', 'skills', 'rules', 'output-styles', 'workflows', 'themes', 'hooks'] as const;

/**
 * Always linked, whatever the mode: Claudio reads transcripts from one `projects/`, and a session
 * started on one account resumes on another with `--resume` only if they share it and the
 * checkpoints, task lists, plans and agent memory keyed to it.
 */
export const HISTORY_ITEMS = ['projects', 'agent-memory', 'file-history', 'tasks', 'plans'] as const;

/** Kept under their old names for callers of the package */
export const SHARED_SETTINGS: readonly string[] = CONFIG_ITEMS;
export const HISTORY = 'projects';

export type StepAction =
  /** Already a link that ends at the source, Claudio's own or made by hand */
  | 'keep'
  /** Absent, and the source exists: will be linked */
  | 'link'
  /** Nothing to link: the source does not exist (yet), or the account has the item of its own */
  | 'skip'
  /** Something else is in the way: reported, never touched */
  | 'conflict';

export interface ReconcileStep {
  item: string;
  class: ItemClass;
  action: StepAction;
  /** Why, for the log and a person: set for `skip` and `conflict` */
  reason?: 'no-source' | 'own-item' | 'link-elsewhere' | 'real-file' | 'real-dir';
}

export interface ReconcileReport {
  steps: ReconcileStep[];
  /** Links made by this pass */
  linked: string[];
  /** Links that were there but not in `recorded`: made by hand where Claudio would point them, now Claudio's to undo */
  adopted: string[];
  conflicts: ReconcileStep[];
}

function stat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Where a link points, resolved against its own dir; null when `path` is not a link */
function linkTarget(path: string): string | null {
  try {
    const raw = readlinkSync(path);
    return isAbsolute(raw) ? resolve(raw) : resolve(dirname(path), raw);
  } catch {
    return null;
  }
}

function realOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Whether `dest` is a link that ends where `source` does. A relative or roundabout link made by hand
 * counts, not only the exact string Claudio writes.
 */
function pointsAt(dest: string, source: string): boolean {
  const target = linkTarget(dest);
  if (target === null) return false;
  if (target === resolve(source)) return true;
  const a = realOf(dest);
  return a !== null && a === realOf(source);
}

/**
 * What a reconcile pass would do for one account dir, from `lstat` calls alone: nothing is written,
 * so a pass over an account in sync costs a few syscalls and is safe before every spawn.
 * `config: false` leaves out the configuration items, for an account that keeps its own.
 */
export function planAccountDir(dir: string, defaultDir: string, opts: { config?: boolean } = {}): ReconcileStep[] {
  // The default account's own dir needs no links to itself
  if (resolve(dir) === resolve(defaultDir)) return [];
  const items: { item: string; class: ItemClass }[] = [
    ...HISTORY_ITEMS.map((item) => ({ item, class: 'history' as const })),
    ...(opts.config === false ? [] : CONFIG_ITEMS.map((item) => ({ item, class: 'config' as const }))),
  ];
  return items.map(({ item, class: kind }): ReconcileStep => {
    const source = join(defaultDir, item);
    const dest = join(dir, item);
    const there = stat(dest);
    // A fresh install has no projects/ yet, and the link must not dangle
    const sourceExists = stat(source) !== null || item === 'projects';
    if (there === null) return sourceExists ? { item, class: kind, action: 'link' } : { item, class: kind, action: 'skip', reason: 'no-source' };
    if (there.isSymbolicLink()) {
      if (pointsAt(dest, source)) return { item, class: kind, action: 'keep' };
      // A link of the person's own to somewhere else is theirs while the default has nothing to offer
      return stat(source) === null ? { item, class: kind, action: 'skip', reason: 'own-item' } : { item, class: kind, action: 'conflict', reason: 'link-elsewhere' };
    }
    if (stat(source) === null) return { item, class: kind, action: 'skip', reason: 'own-item' };
    return { item, class: kind, action: 'conflict', reason: there.isDirectory() ? 'real-dir' : 'real-file' };
  });
}

/**
 * Makes the links a plan asks for. Only links: nothing already there is replaced, moved or deleted,
 * so a conflict stays exactly as it was and a person decides.
 */
export function applyAccountPlan(dir: string, defaultDir: string, steps: readonly ReconcileStep[], recorded: readonly string[] = []): ReconcileReport {
  const report: ReconcileReport = { steps: [], linked: [], adopted: [], conflicts: [] };
  const wanted = steps.some((s) => s.action === 'link');
  if (wanted) mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const step of steps) {
    let done = step;
    if (step.action === 'link') {
      const source = join(defaultDir, step.item);
      try {
        if (step.item === 'projects') mkdirSync(source, { recursive: true });
        symlinkSync(source, join(dir, step.item));
        report.linked.push(step.item);
      } catch (error) {
        // Another pass or the CLI made it first: judge what is there instead of failing the spawn
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        done = planAccountDir(dir, defaultDir).find((s) => s.item === step.item) ?? step;
      }
    }
    if (done.action === 'keep' && !recorded.includes(done.item)) report.adopted.push(done.item);
    if (done.action === 'conflict') report.conflicts.push(done);
    report.steps.push(done);
  }
  return report;
}

/**
 * Brings an account's dir up to the default one: every configuration and history item of the lists
 * that exists in the default dir and is missing in the account's gets its link (links made once, at
 * creation, for what existed then, were the defect that started this: B1, B2, B10). Idempotent.
 */
export function reconcileAccountDir(dir: string, defaultDir: string, opts: { config?: boolean; recorded?: readonly string[] } = {}): ReconcileReport {
  return applyAccountPlan(dir, defaultDir, planAccountDir(dir, defaultDir, opts), opts.recorded);
}

/**
 * Creates an account's directory (0700) and links the shared items into it. Never over something
 * already there: an existing entry is the account's own. Returns the links it now holds.
 */
export function prepareAccountDir(dir: string, defaultDir: string, shareSettings = true): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const report = reconcileAccountDir(dir, defaultDir, { config: shareSettings });
  return [...report.linked, ...report.adopted];
}

/**
 * The directories under `<data>/accounts/` that no account record names: left by an interrupted
 * sign-in or removal. Only listed; whatever is in them may be a person's transcripts.
 */
export function orphanDirs(accountsDir: string, known: ReadonlySet<string>): string[] {
  try {
    return readdirSync(accountsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('acc-') && !known.has(entry.name))
      .map((entry) => join(accountsDir, entry.name));
  } catch {
    return [];
  }
}

/** Removes the links Claudio made or adopted, and only while they still point where it would point them. */
export function removeLinks(dir: string, defaultDir: string, links: readonly string[]): void {
  for (const item of links) {
    const dest = join(dir, item);
    if (pointsAt(dest, join(defaultDir, item))) unlinkSync(dest);
  }
}
