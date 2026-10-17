import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollaboratorsSettings, UpdateCollaboratorsRequest } from '@claudio/shared';
import { writeAtomic } from '../config/files.ts';
import type { CoreConfig } from '../paths.ts';

/*
 * `<dataDir>/collaborators/settings.json` (docs/plans/collaborators.md §4.3): on or off, the display
 * name and label teammates see, a self-hosted relay, and whether the assistant reads the copies. Read from disk on every call, like the
 * project settings: several wrapper processes may share the data directory, and the file is tiny.
 */

const MAX_NAME = 100;
const MAX_LABEL = 50;
const MAX_URL = 500;

export const DEFAULT_COLLABORATORS_SETTINGS: CollaboratorsSettings = { enabled: false, displayName: '', label: '', relayUrl: null, assistantReads: true };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field} must be at most ${String(max)} characters`);
  if (/\p{Cc}/u.test(trimmed)) throw new Error(`${field} must not contain control characters`);
  return trimmed;
}

/** An `iroh-relay` is reached over HTTPS, or HTTP for one on the local network; empty means n0's relays. */
export function parseRelayUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = text(value, 'relayUrl', MAX_URL);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('relayUrl must be a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('relayUrl must be an http or https URL');
  if (url.username || url.password) throw new Error('relayUrl must not carry credentials');
  return url.toString();
}

/** Validates a change a person sent (`PUT /collaborators`): a bad value is refused, unknown fields dropped. */
export function parseCollaboratorsUpdate(input: unknown): UpdateCollaboratorsRequest {
  if (!isObject(input)) throw new Error('collaborators settings must be a JSON object');
  const patch: UpdateCollaboratorsRequest = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be true or false');
    patch.enabled = input.enabled;
  }
  if (input.displayName !== undefined) patch.displayName = text(input.displayName, 'displayName', MAX_NAME);
  if (input.label !== undefined) patch.label = text(input.label, 'label', MAX_LABEL);
  if (input.relayUrl !== undefined) patch.relayUrl = parseRelayUrl(input.relayUrl);
  if (input.assistantReads !== undefined) {
    if (typeof input.assistantReads !== 'boolean') throw new Error('assistantReads must be true or false');
    patch.assistantReads = input.assistantReads;
  }
  return patch;
}

/** What a stored file is worth: each field that does not validate falls back to its default on its own. */
function sanitize(value: unknown): CollaboratorsSettings {
  const raw = isObject(value) ? value : {};
  const attempt = <T>(parse: () => T, fallback: T): T => {
    try {
      return parse();
    } catch {
      return fallback;
    }
  };
  const d = DEFAULT_COLLABORATORS_SETTINGS;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled,
    displayName: attempt(() => (raw.displayName === undefined ? d.displayName : text(raw.displayName, 'displayName', MAX_NAME)), d.displayName),
    label: attempt(() => (raw.label === undefined ? d.label : text(raw.label, 'label', MAX_LABEL)), d.label),
    relayUrl: attempt(() => parseRelayUrl(raw.relayUrl), d.relayUrl),
    assistantReads: typeof raw.assistantReads === 'boolean' ? raw.assistantReads : d.assistantReads,
  };
}

export class CollaboratorsSettingsStore {
  readonly file: string;
  /** Writes run one at a time: two changes made together both land, and never share a temp file */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(config: CoreConfig) {
    this.file = join(config.dataDir, 'collaborators', 'settings.json');
  }

  /**
   * The settings, the defaults when there is no file. A file that does not parse is answered as the
   * defaults and left on disk as it is, so a hand edit with a typo is not lost to a read.
   */
  read(): CollaboratorsSettings {
    if (!existsSync(this.file)) return { ...DEFAULT_COLLABORATORS_SETTINGS };
    try {
      return sanitize(JSON.parse(readFileSync(this.file, 'utf8')) as unknown);
    } catch {
      return { ...DEFAULT_COLLABORATORS_SETTINGS };
    }
  }

  /** Applies a validated change to what is stored now, read under the lock; answers the result. */
  update(patch: UpdateCollaboratorsRequest): Promise<{ before: CollaboratorsSettings; after: CollaboratorsSettings }> {
    const run = this.lock.then(async () => {
      const before = this.read();
      const after: CollaboratorsSettings = { ...before };
      if (patch.enabled !== undefined) after.enabled = patch.enabled;
      if (patch.displayName !== undefined) after.displayName = patch.displayName;
      if (patch.label !== undefined) after.label = patch.label;
      if (patch.relayUrl !== undefined) after.relayUrl = patch.relayUrl;
      if (patch.assistantReads !== undefined) after.assistantReads = patch.assistantReads;
      if (JSON.stringify(before) !== JSON.stringify(after) || !existsSync(this.file)) {
        await writeAtomic(this.file, `${JSON.stringify(after, null, 2)}\n`);
      }
      return { before, after };
    });
    this.lock = run.catch(() => undefined);
    return run;
  }
}
