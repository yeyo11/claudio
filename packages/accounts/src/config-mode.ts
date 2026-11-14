import { cpSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AccountConfig, AccountConfigItem, AccountConfigItemState, AccountConfigMode, AccountConfigReason, AccountConfigStart, AccountConfigStep } from '@claudio/shared';
import { ASIDE_DIR, CONFIG_ITEMS, FILE_ITEMS, HISTORY_ITEMS, planAccountDir, type ReconcileStep } from './dirs.ts';

/**
 * An account's configuration mode (plan account-configuration-and-project-rules §6.1): what a switch
 * between `shared` and `independent` would do, and doing it. Each switch is planned from `lstat`
 * calls first, so a caller can show it, and applied second, one item at a time; every step is
 * atomic for its item and a second run after an interruption finishes what the first left.
 *
 * Nothing of the default dir is ever written. Nothing of the account's is ever deleted: what a
 * link replaces goes to `<dir>/.claudio-own/<time>/`, and a copy is made beside its place under
 * `<dir>/.claudio-switch/` and renamed in only once it is whole.
 */

/** Where a copy is built before it takes its item's place; a `.partial` suffix while it is being written */
export const STAGING_DIR = '.claudio-switch';

const ALL_ITEMS: readonly { name: string; class: 'config' | 'history' }[] = [
  ...CONFIG_ITEMS.map((name) => ({ name, class: 'config' as const })),
  ...HISTORY_ITEMS.map((name) => ({ name, class: 'history' as const })),
];

/** Whether `name` is an item of the lists, and its class */
export function itemClass(name: string): 'config' | 'history' | null {
  return ALL_ITEMS.find((i) => i.name === name)?.class ?? null;
}

function stat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Whether `dest` is a link that ends where `source` does, a dangling one included */
function linksTo(dest: string, source: string): boolean {
  let raw: string;
  try {
    raw = readlinkSync(dest);
  } catch {
    return false;
  }
  if ((isAbsolute(raw) ? resolve(raw) : resolve(dirname(dest), raw)) === resolve(source)) return true;
  try {
    return realpathSync(dest) === realpathSync(source);
  } catch {
    return false;
  }
}

const historyStep = (s: ReconcileStep): AccountConfigStep => ({ name: s.item, class: s.class, action: s.action, ...(s.reason ? { reason: s.reason } : {}) });

/**
 * What switching the account's dir to `to` would do, item by item. History items are what the
 * reconciliation would do with them, the same in both modes (D3).
 *
 * To `independent`: a link to the default's item becomes a copy of it (`copy`), or is removed
 * (`unlink`) with `start: 'empty'`; an item missing in the account is copied too, so the account
 * starts from the whole shared configuration of the moment (D2). What the account already holds of
 * its own stays.
 *
 * To `shared`: the account's own item is moved aside and the default's linked (`replace`), or only
 * moved aside where the default has none (`move-aside`): an account that shares has the default's
 * configuration and nothing else. `aside` is the dir the moves would go to, to tell an item already
 * kept there (a second run of an interrupted switch) from one that would be.
 */
export function planSwitch(dir: string, defaultDir: string, to: AccountConfigMode, start: AccountConfigStart, aside: string): AccountConfigStep[] {
  const history = planAccountDir(dir, defaultDir, { config: false }).map(historyStep);
  const config = CONFIG_ITEMS.map((name): AccountConfigStep => {
    const source = join(defaultDir, name);
    const dest = join(dir, name);
    const there = stat(dest);
    const sourceExists = stat(source) !== null;
    const step = (action: AccountConfigStep['action'], reason?: AccountConfigReason): AccountConfigStep => ({ name, class: 'config', action, ...(reason ? { reason } : {}) });
    if (to === 'independent') {
      const shared = there === null || (there.isSymbolicLink() && linksTo(dest, source));
      // A copy already whole from a run that was cut short is put in place, whatever the start
      if (shared && stat(join(dir, STAGING_DIR, name)) !== null) return step('copy');
      if (!shared) return step('keep', 'own-item');
      if (start === 'empty' || !sourceExists) return there === null ? step('skip', sourceExists ? undefined : 'no-source') : step('unlink');
      return step('copy');
    }
    if (there === null) return sourceExists ? step('link') : step('skip', 'no-source');
    if (there.isSymbolicLink() && linksTo(dest, source)) return step('keep');
    if (stat(join(aside, name)) !== null) return step('conflict', 'aside-taken');
    return sourceExists ? step('replace', there.isSymbolicLink() ? 'link-elsewhere' : there.isDirectory() ? 'real-dir' : 'real-file') : step('move-aside');
  });
  return [...config, ...history];
}

/**
 * What "use shared" would do for one item: the account's item moved aside and the default's linked.
 * A history item, or a configuration item of a shared account, only: an independent account's
 * configuration is its own by choice.
 */
export function planUseShared(dir: string, defaultDir: string, name: string, aside: string): AccountConfigStep {
  const kind = itemClass(name) ?? 'config';
  const source = join(defaultDir, name);
  const dest = join(dir, name);
  const there = stat(dest);
  const step = (action: AccountConfigStep['action'], reason?: AccountConfigReason): AccountConfigStep => ({ name, class: kind, action, ...(reason ? { reason } : {}) });
  if (stat(source) === null && name !== 'projects') return step('skip', 'no-source');
  if (there === null) return step('link');
  if (there.isSymbolicLink() && linksTo(dest, source)) return step('keep');
  if (stat(join(aside, name)) !== null) return step('conflict', 'aside-taken');
  return step('replace', there.isSymbolicLink() ? 'link-elsewhere' : there.isDirectory() ? 'real-dir' : 'real-file');
}

/** A copy of `source` at `dest`, built under the staging dir and renamed in whole */
function copyIn(dir: string, source: string, name: string): void {
  const stagingDir = join(dir, STAGING_DIR);
  const staged = join(stagingDir, name);
  const partial = `${staged}.partial`;
  if (stat(staged) === null) {
    // A `.partial` is only ever a copy of Claudio's own that was cut short: built again from the source
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    // Links inside the item stay links (an agent file linked into the person's own repository keeps
    // pointing there), made absolute so they still resolve from the account's dir
    // The item itself is followed: a `~/.claude/agents` that is a link to elsewhere is copied, not relinked
    cpSync(realpathSync(source), partial, { recursive: true, dereference: false, verbatimSymlinks: false, errorOnExist: true, force: false });
    renameSync(partial, staged);
  }
  const dest = join(dir, name);
  const there = stat(dest);
  // A dir cannot be renamed over a link, so the link goes first; a run cut here finds the copy staged
  if (there?.isSymbolicLink()) unlinkSync(dest);
  renameSync(staged, dest);
  try {
    rmdirSync(stagingDir);
  } catch {
    // Another item's copy is still staged there
  }
}

export interface ApplySwitchOptions {
  /** The dir moved items go to; made only when one moves */
  aside: string;
  /** Hears of a step that could not be carried out, with why */
  onError?: (step: AccountConfigStep, error: unknown) => void;
}

/**
 * Carries out the steps of a plan, one item at a time. A step that fails is reported as a
 * `conflict` with `reason: 'failed'` and the next item goes on: a problem blocks only its item.
 */
export function applySteps(dir: string, defaultDir: string, steps: readonly AccountConfigStep[], opts: ApplySwitchOptions): AccountConfigStep[] {
  const done: AccountConfigStep[] = [];
  for (const step of steps) {
    const source = join(defaultDir, step.name);
    const dest = join(dir, step.name);
    try {
      switch (step.action) {
        case 'copy':
          copyIn(dir, source, step.name);
          break;
        case 'unlink':
          if (stat(dest)?.isSymbolicLink()) unlinkSync(dest);
          break;
        case 'replace':
        case 'move-aside': {
          const kept = join(opts.aside, step.name);
          if (stat(kept) !== null) throw new Error(`${kept} already exists`);
          mkdirSync(opts.aside, { recursive: true, mode: 0o700 });
          // One rename: the item is either in its place or aside, never half-way
          if (stat(dest) !== null) renameSync(dest, kept);
          if (step.action === 'replace') symlinkSync(source, dest);
          break;
        }
        case 'link':
          if (step.name === 'projects') mkdirSync(source, { recursive: true });
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          symlinkSync(source, dest);
          break;
        default:
          break;
      }
      done.push(step);
    } catch (error) {
      const failed: AccountConfigStep = { name: step.name, class: step.class, action: 'conflict', reason: 'failed' };
      opts.onError?.(failed, error);
      done.push(failed);
    }
  }
  return done;
}

const stateOf = (s: ReconcileStep): { state: AccountConfigItemState; reason?: AccountConfigReason } => {
  switch (s.action) {
    case 'keep':
      return { state: 'linked' };
    case 'link':
      return { state: 'missing' };
    case 'replace':
      return { state: 'missing', ...(s.reason ? { reason: s.reason } : {}) };
    case 'conflict':
      return { state: 'conflict', ...(s.reason ? { reason: s.reason } : {}) };
    default:
      return s.reason === 'own-item' ? { state: 'own', reason: 'own-item' } : { state: 'not-in-default' };
  }
};

/** The dirs that hold what was moved aside, oldest first */
export function keptAside(dir: string): string[] {
  try {
    return readdirSync(join(dir, ASIDE_DIR), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * How the account's dir stands against its mode, from `lstat` calls alone. An independent account's
 * configuration items are `own` or `absent`; one still linked to the default's (a switch cut short)
 * reads `linked`, and the account `repair`.
 */
export function describeConfig(dir: string, defaultDir: string, mode: AccountConfigMode, switching: AccountConfig['switching']): AccountConfig {
  const steps = planAccountDir(dir, defaultDir, { config: mode === 'shared' });
  const view = (s: ReconcileStep): AccountConfigItem => ({ name: s.item, kind: FILE_ITEMS.has(s.item) ? 'file' : 'dir', class: s.class, ...stateOf(s) });
  const history = steps.filter((s) => s.class === 'history').map(view);
  const config =
    mode === 'shared'
      ? steps.filter((s) => s.class === 'config').map(view)
      : CONFIG_ITEMS.map((name): AccountConfigItem => {
          const dest = join(dir, name);
          const there = stat(dest);
          const kind = FILE_ITEMS.has(name) ? 'file' : 'dir';
          if (there === null) return { name, kind, class: 'config', state: 'absent' };
          if (there.isSymbolicLink() && linksTo(dest, join(defaultDir, name))) return { name, kind, class: 'config', state: 'linked' };
          return { name, kind, class: 'config', state: 'own' };
        });
  const items = [...config, ...history];
  const conflict = items.some((i) => i.state === 'conflict');
  const repair = switching !== null || items.some((i) => i.state === 'missing') || (mode === 'independent' && config.some((i) => i.state === 'linked'));
  return { mode, state: conflict ? 'conflict' : repair ? 'repair' : 'ok', items, switching, keptAside: keptAside(dir) };
}
