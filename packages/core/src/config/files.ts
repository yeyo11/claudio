import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ConfigFileVariant, InstructionsDoc, SettingsDoc } from '@claudio/shared';
import { restoreSecrets } from '../security/redact.ts';
import { instructionsPath, settingsPath, type ConfigScope } from './scope.ts';
import { isRecord } from '@claudio/shared';

/**
 * A JSON object file: null when it does not exist or is empty. Throws when it holds something that
 * is not a JSON object, so a config the CLI cannot read either is reported rather than overwritten.
 */
export async function readJson(file: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  if (!text.trim()) return null;
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error(`${file} does not hold a JSON object`);
  return value;
}

/**
 * Write through a temp file so the CLI never reads a half-written config. `mode` is given to the
 * temp file at creation rather than applied afterwards: a document that holds a secret must never
 * exist, not even for an instant, at whatever the umask allows.
 */
export async function writeAtomic(file: string, content: string, mode?: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  await rename(tmp, file);
}

/** settings.json / CLAUDE.md for any scope (user, project shared, project local). */
export class SettingsFiles {
  async getSettings(scope: ConfigScope, variant: ConfigFileVariant = 'shared'): Promise<SettingsDoc> {
    const path = settingsPath(scope, variant);
    return { path, exists: existsSync(path), settings: (await readJson(path)) ?? {} };
  }

  async setSettings(scope: ConfigScope, variant: ConfigFileVariant, settings: unknown): Promise<SettingsDoc> {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('settings must be a JSON object');
    }
    // `env` holds credentials the CLI passes to every process, and the API returns a placeholder
    // for each one; a write that sends the placeholder back keeps what is on disk.
    const path = settingsPath(scope, variant);
    const merged = restoreSecrets(settings as Record<string, unknown>, (await readJson(path)) ?? {});
    await writeAtomic(path, `${JSON.stringify(merged, null, 2)}\n`);
    return this.getSettings(scope, variant);
  }

  async getInstructions(scope: ConfigScope, variant: ConfigFileVariant = 'shared'): Promise<InstructionsDoc> {
    const path = instructionsPath(scope, variant);
    const exists = existsSync(path);
    return { path, exists, content: exists ? await readFile(path, 'utf8') : '' };
  }

  async setInstructions(scope: ConfigScope, variant: ConfigFileVariant, content: unknown): Promise<InstructionsDoc> {
    if (typeof content !== 'string') throw new Error('content must be a string');
    await writeAtomic(instructionsPath(scope, variant), content);
    return this.getInstructions(scope, variant);
  }
}
