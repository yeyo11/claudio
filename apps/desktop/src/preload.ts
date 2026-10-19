import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './ipc.ts';

// The main process hands the app version over as a renderer argument (see webPreferences.additionalArguments)
const VERSION_ARG = '--claudio-version=';
const version = process.argv.find((arg) => arg.startsWith(VERSION_ARG))?.slice(VERSION_ARG.length) ?? '';

const flags = (options?: { whenIdle?: boolean; force?: boolean }) => ({ whenIdle: options?.whenIdle === true, force: options?.force === true });
/** Sent at most once per page: the first render is what a trial waits for */
let rendered = false;
const pageReady = () => {
  if (rendered) return;
  rendered = true;
  ipcRenderer.send(IPC.pageReady);
};

/*
 * What the UI can reach of the desktop shell, and nothing more: which platform it runs on, the title
 * bar colours to follow its theme, the paths the tray asks it to open, that the page rendered, and
 * the app's own updates (`UpdateState` and `InstallAnswer` in src/updater.ts, `PayloadAction` in
 * src/payload.ts, `SwitchState` in src/switch.ts). No ipcRenderer, no Node. Everything the page
 * passes is reduced again in the main process. Mirrored by `DesktopBridge` in
 * apps/web/src/lib/desktop.ts. Part of `shellInputs`: a change here needs a new shell.
 */
contextBridge.exposeInMainWorld('claudioDesktop', {
  platform: process.platform,
  version,
  setTitleBarTheme: (theme: { color: string; symbolColor: string }) => {
    ipcRenderer.send(IPC.titleBarTheme, { color: String(theme?.color), symbolColor: String(theme?.symbolColor) });
  },
  onNavigate: (listener: (path: string) => void) => {
    const handler = (_event: unknown, path: unknown) => {
      if (typeof path === 'string') listener(path);
    };
    ipcRenderer.on(IPC.navigate, handler);
    return () => void ipcRenderer.off(IPC.navigate, handler);
  },
  pageReady,
  updates: {
    state: (): Promise<unknown> => ipcRenderer.invoke(IPC.updateState),
    onState: (listener: (state: unknown) => void) => {
      const handler = (_event: unknown, state: unknown) => listener(state);
      ipcRenderer.on(IPC.updateChanged, handler);
      return () => void ipcRenderer.off(IPC.updateChanged, handler);
    },
    download: (): Promise<unknown> => ipcRenderer.invoke(IPC.updateDownload),
    install: (options?: { whenIdle?: boolean; force?: boolean }): Promise<unknown> => ipcRenderer.invoke(IPC.updateInstall, flags(options)),
    payload: (action: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.payload, action),
    switchState: (): Promise<unknown> => ipcRenderer.invoke(IPC.switchState),
    switchToAppImage: (options?: { force?: boolean }): Promise<unknown> => ipcRenderer.invoke(IPC.switchAppImage, { force: options?.force === true }),
    // Also here, beside the update calls that wait on it
    pageReady,
  },
});
