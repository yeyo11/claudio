import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeAtomic(file: string, content: string, mode?: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  await rename(tmp, file);
}

