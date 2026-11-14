import { lstat, mkdir, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * Where a write to `file` must land: the file a chain of links ends at. A rename over the link
 * itself would replace it with a plain copy and cut the account (or an agent file linked into the
 * person's own repository) off from the one file it shares. A link that points nowhere yet is
 * followed to the place its target will be made.
 */
export async function throughLinks(file: string): Promise<string> {
  let path = file;
  for (let hops = 0; hops < 16; hops += 1) {
    try {
      return await realpath(path);
    } catch {
      // Missing, or a link that dangles: follow it one step if it is one
    }
    try {
      if (!(await lstat(path)).isSymbolicLink()) return path;
      const raw = await readlink(path);
      path = isAbsolute(raw) ? raw : resolve(dirname(path), raw);
    } catch {
      return path;
    }
  }
  return path;
}

/**
 * Write through a temp file so a reader never sees a half-written file. The temp file is made
 * beside the real target, on its filesystem, because a rename does not cross one.
 */
export async function writeAtomic(file: string, content: string, mode?: number): Promise<void> {
  const target = await throughLinks(file);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  await rename(tmp, target);
}
