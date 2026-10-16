// electron-builder `afterPack` hook: drops group and other write permission from everything packed,
// before the .deb and the AppImage are made. Files keep the mode they had on the machine that built
// them, so a build under umask 002 shipped a group-writable `guard.mjs`, and the guards refuse to run
// a program anyone but its owner could change (docs/guards.md). Clearing it here makes the package the
// same whatever the builder's umask.
import { chmodSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function dropGroupWrite(root) {
  let changed = 0;
  const walk = (path) => {
    const stat = lstatSync(path);
    // A symlink's own mode is not used; following it could leave the tree
    if (stat.isSymbolicLink()) return;
    if ((stat.mode & 0o022) !== 0) {
      chmodSync(path, stat.mode & 0o7755);
      changed += 1;
    }
    if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(root);
  return changed;
}

export default async function afterPack(context) {
  dropGroupWrite(context.appOutDir);
}
