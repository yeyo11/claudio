import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, safeStorage, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { AppImageUpdater, DebUpdater } from 'electron-updater';
import { loadKeys } from '@claudio/core/launcher/protocol';
import { attachDecision, DaemonClient, hasUserManager, NODE_RUNNER, startDaemon } from './daemon-launch.ts';
import { DAEMON_PROTOCOL, daemonUnitName, readDaemonRecord, recordAlive, type DaemonBoot, type DaemonState, type FromDaemon, type LaunchFacts } from './daemon-protocol.ts';
import { RELEASE_DOWNLOADS, packageFileName, verifyDownload } from './desktop-manifest.ts';
import { IPC, isAppPath } from './ipc.ts';
import { EMPTY_SNAPSHOT, progressOf, sameSnapshot, type LiveSnapshot, type TrayAction, type TrayRestart } from './live.ts';
import { LiveMonitor, monitorHeaders } from './live-monitor.ts';
import { LogFile } from './log.ts';
import { buildMenu } from './menu.ts';
import { ACTION_SCHEME, errorUrl, splashUrl } from './pages.ts';
import { parsePayloadAction, parsePayloadFacts, payloadAnswer, payloadRequest, readShellJson, type PayloadAction, type PayloadFacts } from './payload.ts';
import { NATIVE_NOTICE, nativeQuitDialog, parseQuitAnswer, quitAction, quitPlan, type QuitAnswer, type QuitNotice } from './quit.ts';
import { SPLASH_HANDOFF_MAX_MS } from '@claudio/ui/splash';
import { missingResources, resolveResources } from './resources.ts';
import { secretKeyFor } from './secret-key.ts';
import { rememberPort } from './server-port.ts';
import { resolveUserPath } from '@claudio/core/providers/path';
import { DPKG_RECORD, appImagePaths, downloadTo, fuseUsable, installAppImage, sandboxRootless, switchState, type SwitchState } from './switch.ts';
import { isTerminalWindowUrl, navigationFor } from './terminal-window.ts';
import { SPLASH_TITLE_BAR, parseTitleBarTheme, titleBarOptions, type TitleBarTheme } from './title-bar.ts';
import { LiveTray } from './tray.ts';
import {
  aptManaged,
  appImageRelaunch,
  appImageWritable,
  DesktopUpdater,
  distributionOf,
  installDecision,
  liveWorkOf,
  parseInstallRequest,
  readPackageType,
  updateSupport,
  workWords,
  type InstallAnswer,
  type InstallRequest,
  type LiveWork,
  type UpdaterEngine,
  type UpdateState,
} from './updater.ts';
import { restoreWindowState } from './window-state.ts';
import { errorMessage } from '@claudio/shared';

const isDev = !app.isPackaged || process.argv.includes('--dev');

// Name before anything reads it: it decides the userData dir. (The X11 WM class the launcher matches on
// comes from the packaged package.json name instead; see extraMetadata in electron-builder.yml.)
// Dev gets its own userData so experiments never touch the installed app's data.
app.setName('Claudio');
app.setPath('userData', join(app.getPath('appData'), isDev ? 'Claudio-dev' : 'Claudio'));

const userData = app.getPath('userData');
const dataDir = join(userData, 'data');
// Projects the agent works on live where the user can see them, not hidden under ~/.config
const workspaceDir = process.env.CLAUDIO_WORKSPACE_DIR ?? join(homedir(), 'Claudio', 'workspace');
const logsDir = join(userData, 'logs');
const RELEASES_URL = 'https://github.com/yeyo11/claudio/releases/latest';
/** Settings → General → Updates, where both update zones and the `.deb` command are */
const SETTINGS_UPDATES = '/settings/general#updates';

// Which package this is, the way electron-updater tells: the AppImage runtime sets APPIMAGE, and
// electron-builder writes resources/package-type into the .deb
const packageFacts = { appImage: process.env.APPIMAGE, packageType: readPackageType(process.resourcesPath) };
const distribution = distributionOf(packageFacts);
/**
 * What this shell is, read once: the payload it bundles has its version, and an overlay is judged
 * against it. A `shell.json` of another version already at start would be a broken package; the
 * shell then boots only what it bundles.
 */
const shellAtStart = ((): { version: string; shellInputs: string } | null => {
  const read = readShellJson(resolveResources().shellJson);
  return read && read.version === app.getVersion() ? read : null;
})();

let win: BrowserWindow | undefined;
/** The connection to the daemon that supervises the server (layer 1 of docs/plans/survive-restarts.md) */
let daemon: DaemonClient | undefined;
/** What the daemon said last */
let daemonState: DaemonState | null = null;
/** Finding or starting the daemon is under way */
let connecting: Promise<void> | undefined;
/** The window is stopping or replacing the daemon itself: its going is no surprise */
let leavingDaemon = false;
/** Reconnections after the daemon went on its own, so a daemon that cannot stay up is not chased for ever */
let reconnects = 0;
let serverOrigin: string | undefined;
let quitting = false;
/** The quit question is on screen */
let askingQuit = false;
let monitor: LiveMonitor | undefined;
let tray: LiveTray | undefined;
let live: LiveSnapshot = EMPTY_SNAPSHOT;
let updater: DesktopUpdater;
/** What the server said of its payload update last, for the tray and the menus */
let payloadFacts: PayloadFacts | null = null;
/** The page a restarted server's window goes back to */
let restorePath: string | null = null;
/** A restart to install an update, or a relaunch, is under way: the server is going down on purpose */
let updating = false;
let switching = false;
/** The page in the window registered for the quit question (`onQuitAsk`) */
let pageAsksQuit = false;
const quitAnswers = new Map<string, (raw: unknown) => void>();

// Opened once the single-instance lock is ours, so a rejected second launch never rotates the running one's logs
let desktopLog: LogFile;

/** The window controls' colours; also the window background, seen while a page loads */
function paintTitleBar(theme: TitleBarTheme): void {
  if (!win) return;
  win.setBackgroundColor(theme.color);
  if (process.platform !== 'darwin') win.setTitleBarOverlay(theme);
}

/** Navigation superseded by a newer load rejects with ERR_ABORTED; that is not an error */
const load = (url: string) => win?.loadURL(url).catch(() => undefined);

const serverLogPath = () => daemonState?.serverLog ?? join(logsDir, 'server.log');

function showError(title: string, detail: string): void {
  desktopLog.line(`${title}: ${detail}`);
  serverOrigin = undefined;
  stopMonitor();
  // The splash and error pages are dark whatever the UI's theme was
  paintTitleBar(SPLASH_TITLE_BAR);
  void load(errorUrl(title, detail, serverLogPath()));
}

function showSplash(): void {
  paintTitleBar(SPLASH_TITLE_BAR);
  void load(splashUrl());
}

/**
 * Lets the splash finish before the UI replaces it: its intro always plays to the end, pauses on the
 * finished lockup and fades out. The server never waits on it (it started alongside), and the UI
 * waits at most SPLASH_HANDOFF_MAX_MS, even if the page never answers.
 */
async function handOffSplash(): Promise<void> {
  if (!win) return;
  const finished = win.webContents.executeJavaScript('window.claudioSplash?.handOff()', true).catch(() => undefined);
  await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, SPLASH_HANDOFF_MAX_MS))]);
}

/** Finds the daemon or starts one, and attaches the window to it; one attempt at a time */
function startServer(): void {
  connecting ??= connectDaemon().finally(() => {
    connecting = undefined;
  });
}

/** The facts the daemon needs to start a server, which only this process has: the keyring's key above all */
async function launchFacts(): Promise<LaunchFacts> {
  const res = resolveResources();
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const env: Record<string, string> = {};
  // Electron's own switches and the secrets are never handed on: the daemon sets what the server needs
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('ELECTRON_') && k !== 'CLAUDIO_SECRET_KEY' && k !== 'CLAUDIO_DESKTOP_TOKEN') env[k] = v;
  }
  return {
    env,
    PATH: await resolveUserPath(),
    secretKey: secretKeyFor(join(userData, 'secret-key.bin'), safeStorage),
    userData,
    dataDir,
    workspaceDir,
    logsDir,
    bundledDir: dirname(res.serverEntry),
    bundledWeb: res.webDist,
    guardEntry: res.guardEntry,
    keysDir: res.keysDir,
    shellJson: res.shellJson,
    version: app.getVersion(),
    distribution: distribution ?? null,
    aptManaged: updater.aptManaged,
    ignoreOverlays: process.env.CLAUDIO_PAYLOAD === 'bundled',
  };
}

/** The daemon of this data directory, if one answers */
async function reachDaemon(): Promise<DaemonClient | undefined> {
  const record = readDaemonRecord(dataDir);
  if (!record || !recordAlive(record)) return undefined;
  return DaemonClient.connect(record.socket, onDaemonMessage).catch(() => undefined);
}

/** Polls for the daemon this window just started: its record, then its socket */
async function awaitDaemon(timeoutMs = 20_000): Promise<DaemonClient | undefined> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const client = await reachDaemon();
    if (client) return client;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
}

async function connectDaemon(): Promise<void> {
  if (!serverOrigin) showSplash();
  const res = resolveResources();
  const missing = missingResources(res);
  if (missing.length) {
    showError('Claudio is missing files', `Not found:\n${missing.join('\n')}`);
    return;
  }
  let facts: LaunchFacts;
  try {
    facts = await launchFacts();
  } catch (err) {
    showError('Claudio could not start its server', errorMessage(err));
    return;
  }
  let client = await reachDaemon();
  if (client) desktopLog.line('attaching to the running daemon');
  else {
    const how = await startDaemon(
      {
        userManager: hasUserManager(),
        unit: daemonUnitName(dataDir),
        execPath: process.execPath,
        daemonEntry: res.daemonEntry,
        appImage: distribution === 'appimage' ? process.env.APPIMAGE : undefined,
        dataDir,
        logsDir,
        env: process.env,
      },
      NODE_RUNNER,
      (line) => desktopLog.line(line),
    );
    desktopLog.line(`started the daemon (${how === 'unit' ? `user unit ${daemonUnitName(dataDir)}` : 'setsid'})`);
    client = await awaitDaemon();
  }
  if (!client) {
    showError('Claudio could not start its server', `The process that supervises the server did not answer. See ${join(logsDir, 'daemon.log')}.`);
    return;
  }
  daemon?.close();
  daemon = client;
  leavingDaemon = false;
  client.onClose(() => {
    if (daemon !== client) return;
    daemon = undefined;
    daemonGone();
  });
  client.send({ type: 'hello', protocol: DAEMON_PROTOCOL, version: app.getVersion(), launch: facts });
}

/** The daemon went without this window asking: it is found or started again, a few times */
function daemonGone(): void {
  daemonState = null;
  if (quitting || leavingDaemon || updating) return;
  if (serverOrigin) {
    rememberPath();
    stopMonitor();
    serverOrigin = undefined;
  }
  reconnects += 1;
  if (reconnects > 3) {
    showError('The Claudio server stopped unexpectedly', `The process that supervises it went away. See ${join(logsDir, 'daemon.log')}.`);
    return;
  }
  desktopLog.line('the daemon went away; finding or starting it again');
  setTimeout(startServer, 1_000);
}

/** Asks the daemon to end, and waits until it did: with all its work (`stop-work`), or letting parked work go (`detach`) */
async function stopDaemon(work: 'stop-work' | 'detach'): Promise<void> {
  stopMonitor();
  const client = daemon;
  if (!client?.open) return;
  leavingDaemon = true;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 60_000);
    client.onClose(() => {
      clearTimeout(timer);
      resolve();
    });
    client.send({ type: 'stop', work });
  });
  if (daemon === client) daemon = undefined;
  daemonState = null;
  serverOrigin = undefined;
}

/** The current page, for the window to go back to once the server is there again */
function rememberPath(): void {
  const current = win?.webContents.getURL() ?? '';
  if (serverOrigin && current.startsWith(`${serverOrigin}/`)) restorePath = current.slice(serverOrigin.length);
}

function onDaemonMessage(message: FromDaemon): void {
  if (message.type === 'relaunch-window') {
    // 76 is a restart the person asked for from the Updates card, on this device or another (D4 of
    // docs/plans/remote-updates.md): the daemon starts its server again, this window starts anew
    desktopLog.line('the server asked for the app to start again (exit 76)');
    relaunchShell();
    return;
  }
  if (message.type === 'stopped') return;
  const first = daemonState === null;
  daemonState = message.state;
  if (first) {
    const decision = attachDecision(message.state, { protocol: DAEMON_PROTOCOL, version: app.getVersion() });
    if (decision === 'replace') {
      desktopLog.line(`the daemon is ${message.state.version} (protocol ${String(message.state.protocol)}); handing its work over to a new one`);
      void stopDaemon('detach').then(startServer);
      return;
    }
    if (decision === 'restart-server') {
      desktopLog.line(`the daemon serves the bundled Claudio ${message.state.boot?.version ?? '?'}; starting its server again on ${app.getVersion()}`);
      daemon?.send({ type: 'restart-server' });
    }
  }
  showDaemonState(message.state);
}

/** The window follows the daemon: the splash while a server starts, the UI once it listens, the error page when it cannot */
function showDaemonState(state: DaemonState): void {
  setMenu(state.boot);
  if (state.phase === 'ready' && state.url) {
    reconnects = 0;
    const origin = new URL(state.url).origin;
    if (serverOrigin !== origin) void showServer(state.url, state.boot);
    return;
  }
  if (state.phase === 'failed') {
    showError('Claudio could not start its server', state.detail ?? 'The server did not start.');
    return;
  }
  if (serverOrigin) {
    rememberPath();
    stopMonitor();
    serverOrigin = undefined;
    showSplash();
  }
}

async function showServer(url: string, boot: DaemonBoot | null): Promise<void> {
  const origin = new URL(url).origin;
  serverOrigin = origin;
  // What it bound, not what it was asked for: a taken port makes the server pick another
  rememberPort(userData, Number(new URL(url).port));
  desktopLog.line(`server ready at ${url}: Claudio ${boot?.version ?? '?'}${boot && !boot.bundled ? ' from the data dir' : ''}${boot?.trial ? ', on trial' : ''}`);
  startMonitor(origin);
  void refreshPayloadFacts();
  if (!win) return;
  await handOffSplash();
  if (serverOrigin !== origin) return;
  const path = restorePath && isAppPath(restorePath) ? restorePath : null;
  restorePath = null;
  daemon?.send({ type: 'window-loading' });
  await load(path ? `${origin}${path}` : url);
}

/** The desktop credential: the daemon's, new for each daemon (it replaced the per-launch one) */
const desktopSecret = (): string | undefined => daemonState?.token;

/** The shell's own request to its server, with the desktop credential (D8) */
async function shellApi(method: string, path: string, body?: unknown): Promise<Response> {
  if (!serverOrigin) throw new Error('the server is not running');
  return fetch(`${serverOrigin}${path}`, {
    method,
    headers: { ...monitorHeaders(desktopSecret(), process.env), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

async function refreshPayloadFacts(): Promise<void> {
  try {
    const res = await shellApi('GET', '/api/system/server-update');
    payloadFacts = res.ok ? parsePayloadFacts(await res.json()) : null;
  } catch {
    payloadFacts = null;
  }
  redrawTray();
}

/** A payload action made for the page, the tray or the menu; a server that does not answer is a 503 with no code */
async function runPayloadAction(action: PayloadAction): Promise<unknown> {
  const request = payloadRequest(action);
  let answer: unknown;
  try {
    answer = await payloadAnswer(await shellApi(request.method, request.path, request.body));
  } catch {
    answer = { status: 503, code: null };
  }
  void refreshPayloadFacts();
  return answer;
}

/** `{ status, code, live }` from `runPayloadAction`, or null when the action succeeded */
function refusalOf(answer: unknown): { status: number; code: string | null; live: LiveWork | null } | null {
  if (!answer || typeof answer !== 'object') return null;
  const r = answer as Record<string, unknown>;
  if (typeof r.status !== 'number') return null;
  const l = r.live && typeof r.live === 'object' ? (r.live as Record<string, unknown>) : null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { status: r.status, code: typeof r.code === 'string' ? r.code : null, live: l ? { working: n(l.working), waiting: n(l.waiting), running: n(l.running), terminals: n(l.terminals) } : null };
}

/** The open terminals: a restart ends their shells, so they count as live work (D6) */
async function openTerminals(): Promise<number> {
  try {
    const res = await shellApi('GET', '/api/terminal');
    const running = res.ok ? ((await res.json()) as { running?: unknown }).running : 0;
    return typeof running === 'number' ? running : 0;
  } catch {
    return 0;
  }
}

const liveWork = async (): Promise<LiveWork> => liveWorkOf(live, await openTerminals());

/** The one restart the tray offers: the shell apt replaced, a verified AppImage, or a downloaded payload */
function trayRestart(): TrayRestart | undefined {
  const s = updater.state;
  if (s.status === 'shell-replaced') return { version: s.version, finish: true };
  if (s.status === 'ready') return { version: s.version, finish: false };
  if (payloadFacts?.target && (payloadFacts.state === 'ready' || payloadFacts.state === 'scheduled')) return { version: payloadFacts.target, finish: false };
  return undefined;
}

function redrawTray(): void {
  tray?.update(live, trayRestart());
}

/** Tray, taskbar progress and badge, redrawn only when what they show changed */
function showLive(snapshot: LiveSnapshot): void {
  if (sameSnapshot(snapshot, live)) return;
  live = snapshot;
  redrawTray();
  const progress = progressOf(snapshot);
  if (progress.mode === 'none') win?.setProgressBar(-1);
  else if (progress.mode === 'indeterminate') win?.setProgressBar(2, { mode: 'indeterminate' });
  else win?.setProgressBar(progress.value);
  // Where the platform has no badge (most Linux docks, Windows) this does nothing and says so
  app.setBadgeCount(snapshot.waiting);
}

function startMonitor(origin: string): void {
  stopMonitor();
  monitor = new LiveMonitor({
    origin,
    headers: monitorHeaders(desktopSecret(), process.env),
    onSnapshot: showLive,
    onEvent: (type) => {
      if (type === 'system.server-update' || type === 'system.release') void refreshPayloadFacts();
    },
    log: (line) => desktopLog.line(line),
  });
  monitor.start();
}

function stopMonitor(): void {
  monitor?.stop();
  monitor = undefined;
  showLive(EMPTY_SNAPSHOT);
}

/** Brings the window back: a closed one is opened again on the running server */
function showWindow(): void {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Opens an in-app path with the page's own router, so the UI keeps its state; a fresh load otherwise */
function openPath(path: string): void {
  if (!serverOrigin || !isAppPath(path)) return;
  if (!win) {
    // A window opened for the path goes straight there once the server's page loads
    restorePath = path;
    createWindow();
    return;
  }
  showWindow();
  const next = navigationFor(win.webContents.getURL(), path, serverOrigin);
  if (next.kind === 'ipc') win.webContents.send(IPC.navigate, next.path);
  else void load(next.url);
}

function trayAction(action: TrayAction): void {
  if (action.kind === 'show') showWindow();
  else if (action.kind === 'open') openPath(action.path);
  else if (action.kind === 'update') void confirmRestart();
  else app.quit();
}

/** Only the local server's own page may drive the shell; a page it navigated to elsewhere may not */
function fromLocalPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (!win || event.sender !== win.webContents || !serverOrigin) return false;
  return event.senderFrame?.url.startsWith(`${serverOrigin}/`) ?? false;
}

function createUpdater(): DesktopUpdater {
  const next = new DesktopUpdater({
    support: updateSupport({ ...packageFacts, dev: isDev, appImageWritable }),
    // Picked the way electron-updater's own autoUpdater picks, from the same facts. The .deb's engine
    // only checks and downloads: its install() asks for a password, and the app never escalates
    engine: () => (distribution === 'deb' ? new DebUpdater() : new AppImageUpdater()) satisfies UpdaterEngine,
    aptManaged: () => aptManaged(),
    running: app.getVersion(),
    installed: () => readShellJson(resolveResources().shellJson)?.version,
    verify: (version, file, kind) => verifyDownload({ version, kind, file, keys: loadKeys(resolveResources().keysDir), running: app.getVersion() }),
    log: (line) => desktopLog.line(line),
  });
  next.onState((state) => {
    desktopLog.line(`update state: ${JSON.stringify(state)}`);
    redrawTray();
    if (win && serverOrigin && win.webContents.getURL().startsWith(`${serverOrigin}/`)) {
      win.webContents.send(IPC.updateChanged, state);
    }
  });
  return next;
}

/**
 * apt replaced the package under the running app: `<resources>/shell.json` says another version
 * than this process (D3). Looked at every minute, on focus, and when the folder changes where the
 * file system says so.
 */
function lookForReplacedShell(): void {
  if (distribution !== 'deb' || isDev) return;
  const now = readShellJson(resolveResources().shellJson);
  if (now && now.version !== app.getVersion() && updater.state.status !== 'shell-replaced') {
    desktopLog.line(`the system installed the desktop app ${now.version} under the running ${app.getVersion()}`);
    updater.markReplaced(now.version);
  }
}

function watchShell(): void {
  if (distribution !== 'deb' || isDev) return;
  setInterval(lookForReplacedShell, 60_000).unref();
  try {
    watch(process.resourcesPath, () => lookForReplacedShell()).on('error', () => undefined);
  } catch {
    // The minute's look still runs
  }
}

/** A full relaunch: the window, the tray and Electron go too, and the binary on disk starts */
function relaunchShell(): void {
  updating = true;
  desktopLog.line('relaunching the desktop app');
  app.relaunch();
  app.quit();
}

/** Runs a new AppImage once this process has exited; quits */
function relaunchInto(appImage: string): void {
  updating = true;
  const relaunch = appImageRelaunch(process.pid, appImage, process.argv.slice(1));
  spawn(relaunch.command, relaunch.args, { detached: true, stdio: 'ignore', cwd: process.env.OWD ?? homedir() }).unref();
  app.quit();
}

/**
 * Restarts into the downloaded AppImage, or starts the shell apt installed. After apt, only the
 * window starts again: the daemon follows the files apt put in place, and the new window has it start
 * its server on them (`attachDecision`). For the AppImage the daemon goes first, letting parked work
 * go as on any restart, so nothing runs from the file the updater replaces; the new version starts
 * once this process has exited, so it gets the single-instance lock.
 */
async function restartToUpdate(): Promise<void> {
  if (updating || quitting) return;
  updating = true;
  const replaced = updater.state.status === 'shell-replaced';
  desktopLog.line(`restarting to ${replaced ? 'start' : 'update to'} ${updater.readyVersion ?? '?'}`);
  if (replaced) {
    relaunchShell();
    return;
  }
  await stopDaemon('detach');
  if (!(await updater.install())) {
    updating = false;
    desktopLog.line('the update could not be installed; starting the server again');
    startServer();
    return;
  }
  // The AppImage's own path, not process.execPath: that points inside its mount, gone after the exit
  const appImage = distribution === 'appimage' ? (updater.installedAppImage ?? process.env.APPIMAGE) : undefined;
  if (appImage) relaunchInto(appImage);
  else relaunchShell();
}

/** What the page's install() does: restart, schedule for the next quit, or say what is live */
async function requestInstall(request: InstallRequest): Promise<InstallAnswer> {
  const answer = installDecision(updater.state, await liveWork(), request);
  if (answer.status === 'scheduled') {
    updater.requestInstallOnQuit();
    desktopLog.line(`update to ${answer.version} will apply on quit`);
  } else if (answer.status === 'restarting') {
    void restartToUpdate();
  }
  return answer;
}

/** The busy dialog: what is live, and the person's three choices; resolves 0 now, 1 later, 2 cancel */
async function askOverLiveWork(question: string, work: LiveWork, later: string): Promise<number> {
  showWindow();
  return message({
    type: 'question',
    message: question,
    detail: `${workWords(work) ?? 'Work is running'}. Restarting now stops it.`,
    buttons: ['Restart now', later, 'Cancel'],
    defaultId: 1,
    cancelId: 2,
  });
}

/** The shell's own restart (tray, Help menu): asks first when a restart would stop live work */
async function confirmRestart(): Promise<void> {
  const s = updater.state;
  if (s.status !== 'ready' && s.status !== 'shell-replaced') {
    if (payloadFacts?.target && (payloadFacts.state === 'ready' || payloadFacts.state === 'scheduled')) await restartPayload('apply', payloadFacts.target);
    return;
  }
  const answer = installDecision(s, await liveWork(), {});
  if (answer.status === 'restarting') {
    void restartToUpdate();
    return;
  }
  if (answer.status !== 'busy') return;
  const question = s.status === 'shell-replaced' ? `Restart Claudio to finish the update to ${answer.version}?` : `Restart to update to Claudio ${answer.version}?`;
  const response = await askOverLiveWork(question, answer.live, 'Update when I quit');
  if (response === 0) await requestInstall({ force: true });
  else if (response === 1) await requestInstall({ whenIdle: true });
}

/** A payload restart through the server's routes: onto the downloaded version, or back to the bundled one */
async function restartPayload(action: 'apply' | 'revert', version: string): Promise<void> {
  const refused = refusalOf(await runPayloadAction({ action }));
  if (!refused) return;
  if (refused.code === 'update.live-work' && refused.live) {
    const question = action === 'apply' ? `Restart to update to Claudio ${version}?` : `Go back to the bundled Claudio ${version}?`;
    const response = await askOverLiveWork(question, refused.live, 'Restart when nothing is running');
    if (response === 2) return;
    const again = refusalOf(await runPayloadAction({ action, ...(response === 0 ? { force: true } : { whenIdle: true }) }));
    if (!again) return;
    refused.code = again.code;
  }
  if (action === 'revert') {
    await revertLocally(version);
    return;
  }
  await message({ type: 'error', message: 'Claudio could not restart to update', detail: `The server refused it (${refused.code ?? 'no answer'}).` });
}

/**
 * Help → Use the bundled Claudio when the server cannot be asked (it does not answer, or refuses):
 * the shell forgets the overlays itself and starts its own payload, with no page involved.
 */
async function revertLocally(version: string): Promise<void> {
  const go = await ask({
    type: 'question',
    message: `Go back to the bundled Claudio ${version}?`,
    detail: 'The server did not take the request, so the desktop app restarts it onto the version it bundles. Anything running stops.',
    buttons: ['Restart', 'Cancel'],
  });
  if (!go) return;
  // The daemon forgets them and starts the bundled payload; one that does not answer is started anew
  if (daemon?.open) daemon.send({ type: 'use-bundled' });
  else startServer();
}

async function useBundled(): Promise<void> {
  await restartPayload('revert', app.getVersion());
}

/** A dialog on the window when there is one; resolves with the index of the button pressed */
async function message(options: Electron.MessageBoxOptions): Promise<number> {
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response;
}

/** Asks with two buttons; true for the first */
async function ask(options: Omit<Electron.MessageBoxOptions, 'defaultId' | 'cancelId'>): Promise<boolean> {
  return (await message({ ...options, defaultId: 0, cancelId: 1 })) === 0;
}

async function openSettingsAsked(options: Omit<Electron.MessageBoxOptions, 'defaultId' | 'cancelId' | 'buttons'>): Promise<void> {
  if (await ask({ ...options, buttons: ['Open Settings', 'Close'] })) openPath(SETTINGS_UPDATES);
}

/**
 * Help → Check for updates…, the payload's part: what most releases change. True when it had
 * something to say; false leaves the word to the desktop app's own check.
 */
async function checkPayloadFromMenu(): Promise<boolean> {
  if (!serverOrigin) return false;
  // Refused under a guard (the shell's credential only reads there): the daily check answers instead
  await shellApi('POST', '/api/system/release/check').catch(() => undefined);
  await refreshPayloadFacts();
  const f = payloadFacts;
  // Under auth `none` the status says `needs-auth`, but the shell's own requests are accepted (D8)
  if (!f || (f.unsupportedReason !== null && f.unsupportedReason !== 'needs-auth')) return false;
  if (f.target && (f.state === 'ready' || f.state === 'scheduled')) {
    if (await ask({ type: 'info', message: `Claudio ${f.target} is ready`, detail: 'Restart now to use it, or later from the tray.', buttons: ['Restart', 'Later'] })) {
      await restartPayload('apply', f.target);
    }
    return true;
  }
  if (f.state === 'downloading' || f.state === 'verifying') {
    await message({ type: 'info', message: `Downloading Claudio ${f.target ?? ''}`.trim(), detail: 'The tray offers the restart when it is done.' });
    return true;
  }
  if (f.needsShell) {
    await openSettingsAsked({
      type: 'info',
      message: `Claudio ${f.needsShell.version} needs a newer desktop app`,
      detail: `It needs the desktop app ${f.needsShell.minShell} or later. Update the desktop app first; Claudio follows on its own.`,
    });
    return true;
  }
  if (f.offer?.installable) {
    const download = await ask({
      type: 'info',
      message: `Claudio ${f.offer.version} is available`,
      detail: `You are running ${f.running}. It downloads in the background, and you choose when to restart.`,
      buttons: ['Download', 'Later'],
    });
    if (!download) return true;
    const refused = refusalOf(await runPayloadAction({ action: 'download', version: f.offer.version }));
    if (refused) await message({ type: 'error', message: 'The update could not be downloaded', detail: `The server refused it (${refused.code ?? 'no answer'}).` });
    return true;
  }
  return false;
}

const shellErrorWords = (state: Extract<UpdateState, { status: 'error' }>) =>
  state.code === 'bad-signature' ? 'The download has no valid signature and was discarded.' : state.message;

/** Help → Check for updates…: the person asked, so this is where both updaters talk to GitHub */
async function checkForUpdatesFromMenu(): Promise<void> {
  if (await checkPayloadFromMenu()) return;
  const state: UpdateState = await updater.check();
  await shellStateDialog(state);
}

async function shellStateDialog(state: UpdateState): Promise<void> {
  const current = app.getVersion();
  switch (state.status) {
    case 'unsupported':
      if (await ask({ type: 'info', message: 'Claudio cannot update itself here', detail: state.message, buttons: ['Open releases page', 'Close'] })) {
        void shell.openExternal(RELEASES_URL);
      }
      return;
    case 'idle':
      await message({ type: 'info', message: 'Claudio is up to date', detail: `You are running ${current}, the newest release.` });
      return;
    case 'apt-managed':
      await message({
        type: 'info',
        message: 'Your system updates the desktop app through apt',
        detail: state.latest
          ? `Desktop app ${state.latest} is out; it arrives with the system's next update.`
          : `You are running ${current}. A newer one arrives with the system's other updates.`,
      });
      return;
    case 'available': {
      const download = await ask({
        type: 'info',
        message: `Desktop app ${state.version} is available`,
        detail: `You are running ${current}. It downloads in the background and its signature is checked before anything installs.`,
        buttons: ['Download', 'Later'],
      });
      if (!download) return;
      const done = await updater.download();
      if (done.status === 'available') return;
      await shellStateDialog(done);
      return;
    }
    case 'downloading':
      await message({ type: 'info', message: `Downloading Claudio ${state.version}`, detail: `${state.percent}% so far. The tray offers the restart when it is done.` });
      return;
    case 'verifying':
      await message({ type: 'info', message: `Checking the signature of Claudio ${state.version}`, detail: 'The tray offers the restart when it is done.' });
      return;
    case 'ready':
      if (await ask({ type: 'info', message: `Claudio ${state.version} is ready to install`, detail: 'Restart now to use it, or later from the tray.', buttons: ['Restart', 'Later'] })) {
        await confirmRestart();
      }
      return;
    case 'copy-command':
      // A dialog cannot hold a command to copy well; Settings shows it with a copy button
      await openSettingsAsked({
        type: 'info',
        message: `Desktop app ${state.version} is ready to install`,
        detail: 'Install it from a terminal with the command Settings shows. It asks for your password, and apt shows what it will change before it does.',
      });
      return;
    case 'shell-replaced':
      if (await ask({ type: 'info', message: `The system installed desktop app ${state.version}`, detail: 'Restart Claudio to use it.', buttons: ['Restart Claudio', 'Later'] })) {
        await confirmRestart();
      }
      return;
    case 'error':
      await message({ type: 'error', message: 'Could not update the desktop app', detail: shellErrorWords(state) });
      return;
    case 'checking':
      return;
  }
}

function currentSwitchState(): SwitchState {
  return switchState({ distribution, sandboxRootless: sandboxRootless(), fuse: fuseUsable(), debInstalled: existsSync(DPKG_RECORD) });
}

/**
 * The switch from the `.deb` to the AppImage (D5): downloads the AppImage of the newest release
 * known (this one when none is newer), checks it against the signed desktop manifest, installs it
 * where `install.sh` would, and restarts from it. Asks first over live work, like any restart.
 */
async function switchToAppImage(request: InstallRequest): Promise<InstallAnswer> {
  const state = currentSwitchState();
  if (switching || updating || !state.available) return { status: 'not-ready', state: updater.state };
  const version = updater.latest ?? app.getVersion();
  const work = await liveWork();
  if (!request.force && workWords(work) !== null) return { status: 'busy', version, live: work };
  switching = true;
  const paths = appImagePaths();
  const file = join(dirname(paths.appImage), `.Claudio-${version}.download`);
  const failed = (code: 'bad-signature' | 'fetch-failed' | 'other', text: string): InstallAnswer => {
    desktopLog.line(`switch to the AppImage: ${text}`);
    rmSync(file, { force: true });
    switching = false;
    return { status: 'not-ready', state: { status: 'error', code, message: text } };
  };
  try {
    desktopLog.line(`switching to the AppImage ${version}`);
    await downloadTo(`${RELEASE_DOWNLOADS}/v${version}/${packageFileName(version, 'appimage')}`, file);
  } catch (err) {
    return failed('fetch-failed', errorMessage(err));
  }
  const res = resolveResources();
  const checked = await verifyDownload({ version, kind: 'appimage', file, keys: loadKeys(res.keysDir), running: app.getVersion(), allowSame: true });
  if (!checked.ok) return failed(checked.code, checked.message);
  try {
    installAppImage(file, paths, res.icon, (line) => desktopLog.line(line));
  } catch (err) {
    return failed('other', errorMessage(err));
  }
  void (async () => {
    await stopDaemon('detach');
    relaunchInto(paths.appImage);
  })();
  return { status: 'restarting', version };
}

async function restartServer(): Promise<void> {
  if (updater.state.status === 'shell-replaced') {
    await restartToUpdate();
    return;
  }
  if (daemon?.open) daemon.send({ type: 'restart-server' });
  else startServer();
}

// Anything that is not the local server goes to the system browser
const openExternal = (url: string) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
};

/** The main window's and a terminal window's navigation: the local server stays, the rest leaves */
function guardNavigation(webContents: WebContents): void {
  webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(ACTION_SCHEME)) {
      event.preventDefault();
      const action = url.slice(ACTION_SCHEME.length);
      if (action === 'restart') void restartServer();
      else if (action === 'logs') void shell.openPath(logsDir);
      return;
    }
    if (serverOrigin && new URL(url).origin === serverOrigin) return;
    event.preventDefault();
    openExternal(url);
  });
}

/** The application menu; Help offers the bundled payload back while an overlay runs */
function setMenu(boot: Pick<DaemonBoot, 'bundled'> | null = daemonState?.boot ?? null): void {
  Menu.setApplicationMenu(
    buildMenu(
      { data: dataDir, workspace: workspaceDir, logs: logsDir },
      isDev,
      {
        quit: () => app.quit(),
        checkForUpdates: () => void checkForUpdatesFromMenu(),
        useBundled: () => void useBundled(),
      },
      boot && !boot.bundled ? app.getVersion() : undefined,
    ),
  );
}

function createWindow(): void {
  const state = restoreWindowState();
  win = new BrowserWindow({
    ...state.bounds,
    minWidth: 720,
    minHeight: 480,
    title: 'Claudio',
    // The dock and the window switcher show this; the launcher entry's icon only covers the menu
    icon: resolveResources().icon,
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    // The web's top bar is the title bar; dark until the page says which theme it shows (the splash is dark)
    ...titleBarOptions(process.platform, SPLASH_TITLE_BAR),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--claudio-version=${app.getVersion()}`],
    },
  });
  if (state.maximized) win.maximize();
  state.track(win);

  const { webContents } = win;
  // The web UI sets its own <title>; the window keeps the app name
  webContents.on('page-title-updated', (event) => event.preventDefault());

  guardNavigation(webContents);
  // A terminal detached from the panel: the web app's own route, in a native window as locked down as
  // this one. It has no preload, because the bridge it carries only drives the main window.
  webContents.setWindowOpenHandler(({ url }) => {
    if (isTerminalWindowUrl(url, serverOrigin)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1000,
          height: 640,
          minWidth: 420,
          minHeight: 260,
          // Replaced by the page's own title, "Terminal — <project>"
          title: 'Terminal',
          icon: resolveResources().icon,
          backgroundColor: '#0b1020',
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('did-create-window', (child) => {
    guardNavigation(child.webContents);
    child.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
    // The server goes with the main window: nothing is left for a terminal window to attach to
    win?.once('closed', () => {
      if (!child.isDestroyed()) child.close();
    });
  });

  // The server can vanish under a loaded page (e.g. reload after a crash): offer a restart instead of Chromium's error page
  webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && serverOrigin && url.startsWith(serverOrigin)) {
      showError('Cannot reach the Claudio server', `${description} (${code})`);
    }
  });
  // A new page has to say again that it can ask the quit question
  webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) pageAsksQuit = false;
  });

  win.on('focus', lookForReplacedShell);
  win.on('closed', () => {
    win = undefined;
    pageAsksQuit = false;
    // A question the page was asking has nobody to answer it
    for (const resolve of quitAnswers.values()) resolve({ answer: 'cancel' });
    quitAnswers.clear();
  });
  // A window opened again finds the server already running; the first one finds or starts the daemon
  const known = daemonState;
  if (known?.phase === 'ready' && known.url) {
    serverOrigin = undefined;
    void showServer(known.url, known.boot);
  } else if (known?.phase === 'failed') {
    showError('Claudio could not start its server', known.detail ?? 'The server did not start.');
  } else {
    showSplash();
  }
  if (!daemon) startServer();
}

/** The live work right now, or null when no daemon serves this window (then nothing is there to keep or stop) */
async function quitWork(): Promise<LiveWork | null> {
  if (!daemon?.open || !serverOrigin) return null;
  // Read now: the tray's snapshot may predate a chat started a moment ago, and stopping it unasked loses work
  const fresh = await monitor?.snapshot();
  return liveWorkOf(fresh ?? live, await openTerminals());
}

/** Waits until the window shows the server's page and the page says it can ask, for at most `ms` */
async function pageReadyToAsk(ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pageAsksQuit && win && serverOrigin && win.webContents.getURL().startsWith(`${serverOrigin}/`)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * The quit question (D1): in the page, a dialog of the design system in the person's language; the
 * native dialog where the page cannot ask (an older payload, the splash or error page)
 */
async function askQuit(work: LiveWork): Promise<{ answer: QuitAnswer; notice: QuitNotice | null }> {
  showWindow();
  if (await pageReadyToAsk(8_000)) {
    const id = randomUUID();
    const raw = await new Promise<unknown>((resolve) => {
      quitAnswers.set(id, resolve);
      win?.webContents.send(IPC.quitAsk, { id, live: work });
    });
    quitAnswers.delete(id);
    return parseQuitAnswer(raw);
  }
  const native = nativeQuitDialog(work);
  const response = await message({ type: 'question', message: native.message, detail: native.detail, buttons: native.buttons, defaultId: native.defaultId, cancelId: native.cancelId });
  return { answer: native.answers[response] ?? 'cancel', notice: null };
}

/** Quitting: asks over live work, keeps it running by default, or stops everything */
async function quitAsked(): Promise<void> {
  if (askingQuit) return;
  askingQuit = true;
  try {
    const work = await quitWork();
    const plan = quitPlan(work);
    let keep = false;
    let notice: QuitNotice | null = null;
    if (plan === 'ask' && work) {
      const asked = await askQuit(work);
      const action = quitAction(asked.answer);
      if (action === null) {
        desktopLog.line('quit cancelled');
        return;
      }
      keep = action === 'keep';
      notice = asked.notice;
    }
    quitting = true;
    desktopLog.line(keep ? 'quitting; the work goes on in the background' : plan === 'leave' ? 'quitting' : 'quitting and stopping the server');
    await shutdown(plan === 'leave' ? 'leave' : keep ? 'keep' : 'stop-work');
    if (keep) showNotice(notice ?? NATIVE_NOTICE);
    app.quit();
  } finally {
    askingQuit = false;
  }
}

function showNotice(notice: QuitNotice): void {
  try {
    if (Notification.isSupported()) new Notification({ title: notice.title, body: notice.body, icon: resolveResources().icon }).show();
  } catch {
    // The tray and the next start say it too
  }
}

/**
 * What the window leaves behind as it goes: the daemon and its work (`keep`, and every update or
 * relaunch, which arranged the daemon itself), or nothing (`stop-work`). Logs close last.
 */
async function shutdown(mode: 'keep' | 'stop-work' | 'leave'): Promise<void> {
  stopMonitor();
  if (mode === 'stop-work') await stopDaemon('stop-work');
  else {
    leavingDaemon = true;
    daemon?.close();
    daemon = undefined;
  }
  // install({ whenIdle }) left the update for now. The AppImage's daemon runs from its own mount of
  // the file, which the kernel keeps for it however the file on disk is replaced
  if (!updating && updater?.installOnQuit) {
    desktopLog.line(`installing update to ${updater.readyVersion ?? '?'} on quit`);
    await updater.install();
  }
  await desktopLog.close();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  // The page follows its theme (light, dark, or the system's) and tells the title bar to match
  ipcMain.on(IPC.titleBarTheme, (event, value: unknown) => {
    if (!fromLocalPage(event)) return;
    const theme = parseTitleBarTheme(value);
    if (theme) paintTitleBar(theme);
  });
  // The page rendered: what a trial boot waits for, besides /api/health
  ipcMain.on(IPC.pageReady, (event) => {
    if (fromLocalPage(event)) daemon?.send({ type: 'page-ready' });
  });
  // The quit question: the page says it can ask it, and answers it
  ipcMain.on(IPC.quitReady, (event, value: unknown) => {
    if (fromLocalPage(event)) pageAsksQuit = value === true;
  });
  ipcMain.on(IPC.quitAnswer, (event, value: unknown) => {
    if (!fromLocalPage(event) || !value || typeof value !== 'object') return;
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string') quitAnswers.get(id)?.(value);
  });

  // window.claudioDesktop.updates: the same local-page rule as the title bar
  const denied = () => Promise.reject(new Error('not allowed from this page'));
  ipcMain.handle(IPC.updateState, (event) => (fromLocalPage(event) ? updater.state : denied()));
  ipcMain.handle(IPC.updateDownload, (event) => (fromLocalPage(event) ? updater.download() : denied()));
  ipcMain.handle(IPC.updateInstall, (event, value: unknown) => (fromLocalPage(event) ? requestInstall(parseInstallRequest(value)) : denied()));
  ipcMain.handle(IPC.payload, (event, value: unknown) => {
    if (!fromLocalPage(event)) return denied();
    const action = parsePayloadAction(value);
    return action ? runPayloadAction(action) : { status: 400, code: null };
  });
  ipcMain.handle(IPC.switchState, (event) => (fromLocalPage(event) ? currentSwitchState() : denied()));
  ipcMain.handle(IPC.switchAppImage, (event, value: unknown) => (fromLocalPage(event) ? switchToAppImage({ force: parseInstallRequest(value).force }) : denied()));

  app.on('before-quit', (event) => {
    if (quitting) return;
    // Held until the person answered and the daemon did what they chose, then re-entered
    event.preventDefault();
    if (updating) {
      // An update or relaunch arranged the daemon itself: the window just goes
      quitting = true;
      desktopLog.line('quitting for a restart');
      void shutdown('leave').finally(() => app.quit());
      return;
    }
    void quitAsked();
  });
  // Closing the window is not quitting (D1): the tray stays, and the daemon and its work run on.
  // Without a tray there is no other way back, so it is a quit, with its question
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });

  void app.whenReady().then(() => {
    desktopLog = new LogFile(logsDir, 'desktop.log');
    updater = createUpdater();
    if (!shellAtStart && app.isPackaged) desktopLog.line('no shell.json for this version: only the bundled Claudio boots');
    setMenu(null);
    watchShell();
    createWindow();
    try {
      tray = new LiveTray(resolveResources().icon, trayAction);
      redrawTray();
    } catch (err) {
      // A desktop without a status area is no reason to fail: the window still has everything
      desktopLog.line(`no tray: ${errorMessage(err)}`);
    }
  });
}
