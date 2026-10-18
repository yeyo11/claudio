/**
 * The channels between the preload and the main process. Part of `shellInputs`
 * (docs/plans/unified-updates.md, D2): the payload's web speaks to the shell through them, so a
 * change here needs a new shell, and a payload that needs it says so with `minShell`.
 */
export const IPC = {
  /** page → main: `{ color, symbolColor }` for the title bar's controls */
  titleBarTheme: 'claudio:title-bar-theme',
  /** main → page: an in-app path to open with the page's own router */
  navigate: 'claudio:navigate',
  /** page → main (invoke): the updater's current state */
  updateState: 'claudio:update-state',
  /** main → page: the updater's state, whenever it changes */
  updateChanged: 'claudio:update-changed',
  /** page → main (invoke): check if needed, then download the newest release */
  updateDownload: 'claudio:update-download',
  /** page → main (invoke): `{ whenIdle?, force? }`, answered with an `InstallAnswer` */
  updateInstall: 'claudio:update-install',
  /**
   * page → main (invoke): a `PayloadAction`, which the shell makes on the server's update routes with
   * its own per-launch credential (D8); answered with the route's JSON, or `{ status, code, live }`
   */
  payload: 'claudio:payload',
  /** page → main (send): the web rendered; ends a trial boot's window check */
  pageReady: 'claudio:page-ready',
  /** page → main (invoke): the switch to the AppImage, a `SwitchState` */
  switchState: 'claudio:switch-state',
  /** page → main (invoke): `{ force? }`, answered with an `InstallAnswer` */
  switchAppImage: 'claudio:switch-appimage',
} as const;

/** Only a path inside the app: one slash, no scheme or host, so a message cannot send the page elsewhere */
export function isAppPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && path.length <= 512;
}
