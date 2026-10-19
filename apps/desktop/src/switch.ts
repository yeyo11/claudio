// Switching a `.deb` install to the AppImage (docs/plans/unified-updates.md, D5): a one-time offer, only
// where the AppImage keeps Chromium's sandbox without root, at the paths `scripts/install.sh` uses,
// so the AppImage then updates itself without a password. The `.deb` stays installed: removing it
// needs root, and the app never escalates. Free of Electron, so the rules are tested with fake files.
import { accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { downloadFile, type DownloadTuning } from '@claudio/core/updates/download';

export interface SwitchState {
  /** The offer is shown: a `.deb` on a host where the AppImage sandboxes without root and FUSE works */
  available: boolean;
  reason: 'not-deb' | 'sandbox-restricted' | 'no-fuse' | null;
  /** Running the AppImage while the `.deb` is still installed: the card shows how to remove it */
  debStillInstalled: boolean;
}

const readProc = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
};

/**
 * Whether Chromium's namespace sandbox starts without root, the same test as `install.sh`'s
 * `sandbox_rootless`. Where unprivileged user namespaces are restricted (Ubuntu 24.04 and later),
 * only the `.deb`'s root-installed AppArmor profile lets the app start sandboxed; an AppImage in a
 * user dir would abort, and turning the sandbox off is never an option.
 */
export function sandboxRootless(proc = '/proc', read: (path: string) => string | null = readProc): boolean {
  const restrict = read(join(proc, 'sys/kernel/apparmor_restrict_unprivileged_userns'));
  if (restrict !== null && restrict !== '0') return false;
  const clone = read(join(proc, 'sys/kernel/unprivileged_userns_clone'));
  if (clone !== null && clone !== '1') return false;
  const max = read(join(proc, 'sys/user/max_user_namespaces'));
  return max !== null && /^\d+$/.test(max) && Number(max) > 0;
}

/** The static AppImage runtime mounts itself through `fusermount3` (or `fusermount`): `/dev/fuse` and one of them on PATH */
export function fuseUsable(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): boolean {
  if (!exists('/dev/fuse')) return false;
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  return ['fusermount3', 'fusermount'].some((tool) =>
    dirs.some((dir) => {
      try {
        accessSync(join(dir, tool), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

/** dpkg's record of the installed package, readable by everyone; nothing is run */
export const DPKG_RECORD = '/var/lib/dpkg/info/claudio.list';

export interface SwitchFacts {
  distribution: 'appimage' | 'deb' | undefined;
  sandboxRootless: boolean;
  fuse: boolean;
  debInstalled: boolean;
}

export function switchState(f: SwitchFacts): SwitchState {
  if (f.distribution !== 'deb') return { available: false, reason: 'not-deb', debStillInstalled: f.distribution === 'appimage' && f.debInstalled };
  if (!f.sandboxRootless) return { available: false, reason: 'sandbox-restricted', debStillInstalled: false };
  if (!f.fuse) return { available: false, reason: 'no-fuse', debStillInstalled: false };
  return { available: true, reason: null, debStillInstalled: false };
}

/** The command the card shows once the AppImage runs: removing the `.deb` also removes the apt source (its postrm) */
export const DEB_REMOVE_COMMAND = '/usr/bin/sudo /usr/bin/apt remove claudio';

export interface AppImagePaths {
  appImage: string;
  desktopFile: string;
  icon: string;
  link: string;
}

/** `install.sh`'s paths, so an install made either way is the same install */
export function appImagePaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): AppImagePaths {
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  return {
    appImage: join(data, 'claudio', 'Claudio.AppImage'),
    // Same name as the .deb's /usr/share/applications/claudio.desktop, so this entry shadows it
    desktopFile: join(data, 'applications', 'claudio.desktop'),
    icon: join(data, 'icons', 'hicolor', '512x512', 'apps', 'claudio.png'),
    link: join(home, '.local', 'bin', 'claudio'),
  };
}

/** A path in a desktop entry's `Exec`, quoted the way the Desktop Entry Specification asks */
const execArg = (path: string) => `"${path.replace(/(["`$\\])/g, '\\$1')}"`;

export function desktopEntry(appImage: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Claudio',
    'GenericName=Claude Code Control Panel',
    'Comment=Desktop UI for Claude Code agents: runs, sessions and multi-agent orchestration',
    `Exec=${execArg(appImage)} %U`,
    'Icon=claudio',
    'Terminal=false',
    'Categories=Development;',
    'Keywords=Claude;Claude Code;AI;agents;orchestration;',
    'StartupWMClass=claudio',
    '',
  ].join('\n');
}

/**
 * Downloads `url` into `file`, through core's downloader: retried and resumed when the connection
 * drops, and never through `fetch`, whose parser can throw from a socket listener on a
 * close-delimited body (docs/updates.md). Throws once every retry failed or the answer is not the file.
 */
export async function downloadTo(url: string, file: string, tuning: DownloadTuning = {}): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  await downloadFile(url, file, { headers: { 'user-agent': 'claudio-desktop' }, ...tuning });
}

/**
 * Puts a verified AppImage in place, with the menu entry, the icon and the CLI link. The file goes
 * in by a rename inside its own folder, so a running AppImage at that path is never half written.
 * An existing `~/.local/bin/claudio` that is not a link is the person's, and is left alone.
 */
export function installAppImage(verified: string, paths: AppImagePaths, iconSource: string, log: (line: string) => void): void {
  mkdirSync(dirname(paths.appImage), { recursive: true });
  const staged = `${paths.appImage}.${String(process.pid)}.new`;
  try {
    if (dirname(verified) === dirname(paths.appImage)) renameSync(verified, staged);
    else copyFileSync(verified, staged);
    chmodSync(staged, 0o755);
    renameSync(staged, paths.appImage);
  } catch (err) {
    rmSync(staged, { force: true });
    throw err;
  }
  try {
    mkdirSync(dirname(paths.icon), { recursive: true });
    copyFileSync(iconSource, paths.icon);
  } catch (err) {
    log(`switch: no icon: ${err instanceof Error ? err.message : String(err)}`);
  }
  mkdirSync(dirname(paths.desktopFile), { recursive: true });
  writeFileSync(paths.desktopFile, desktopEntry(paths.appImage));
  mkdirSync(dirname(paths.link), { recursive: true });
  let link: ReturnType<typeof lstatSync> | null = null;
  try {
    link = lstatSync(paths.link);
  } catch {
    // Not there yet
  }
  if (link && !link.isSymbolicLink()) {
    log(`switch: ${paths.link} is not a link, so it is left as it is`);
    return;
  }
  if (link) rmSync(paths.link, { force: true });
  symlinkSync(paths.appImage, paths.link);
}
