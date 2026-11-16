// Bringing the window back once it was closed. Since the daemon (t6 of docs/plans/survive-restarts.md)
// the Electron process outlives its window for the tray, and a second main window created in that
// process came up as garbage on the owner's Wayland desktops (docs/reports/desktop-reopen-garbled.md).
// A process only ever shows one main window: reopening after a close starts a fresh process, which
// attaches to the running daemon like any start. Free of Electron, so the rules are tested alone.
import { isAppPath } from './ipc.ts';

/** The switch that carries the page to open into the relaunched process */
export const OPEN_PATH_SWITCH = '--claudio-open=';

export interface ReopenFacts {
  /** A main window exists now */
  hasWindow: boolean;
  /** Main windows this process has created so far */
  windowsCreated: number;
  /** The app is quitting, updating or relaunching already */
  leaving: boolean;
}

/**
 * What a request to show the window does (a second launch, the tray, a dialog that needs the window):
 * `focus` the window there is, `create` the first one of this process, `relaunch` the process when its
 * window was closed, or `none` while the app is on its way out.
 */
export type ReopenPlan = 'focus' | 'create' | 'relaunch' | 'none';

export function reopenPlan(facts: ReopenFacts): ReopenPlan {
  if (facts.hasWindow) return 'focus';
  if (facts.leaving) return 'none';
  return facts.windowsCreated === 0 ? 'create' : 'relaunch';
}

/**
 * The arguments of the relaunched process: this one's, without a page an earlier relaunch carried,
 * plus the page to open when there is one.
 */
export function relaunchArgs(argv: readonly string[], path: string | null): string[] {
  const kept = argv.filter((arg) => !arg.startsWith(OPEN_PATH_SWITCH));
  return path && isAppPath(path) ? [...kept, `${OPEN_PATH_SWITCH}${path}`] : kept;
}

/** The page a relaunch asked this process to open, if it is an in-app path */
export function openPathFromArgv(argv: readonly string[]): string | null {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const arg = argv[i];
    if (arg?.startsWith(OPEN_PATH_SWITCH)) {
      const path = arg.slice(OPEN_PATH_SWITCH.length);
      return isAppPath(path) ? path : null;
    }
  }
  return null;
}
