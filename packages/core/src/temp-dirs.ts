import { tmpdir } from 'node:os';

/**
 * The machine's temp directories as this process knows them, which the risk scorer counts as
 * inside the working directory (`/tmp` and `/var/tmp` it knows itself): scratch files are not a
 * reach outside the project. `$TMPDIR` can differ from `os.tmpdir()` on macOS and in sandboxes.
 */
export function systemTempDirs(): string[] {
  const dirs = [tmpdir()];
  const fromEnv = process.env.TMPDIR;
  if (fromEnv) dirs.push(fromEnv);
  return [...new Set(dirs)];
}
