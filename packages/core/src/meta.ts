import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_VERSION, API_VERSION_MIN, errorMessage, type ServerMeta } from '@claudio/shared';

/**
 * Who this server is to another Claudio (docs/plans/claudio-servers.md, D3 and D5): an id made once
 * and kept, the version, the API range it answers, and what it can do. Every Claudio is a possible
 * remote, so this is part of every one.
 */

/** What every server offers from stage 1 on; the others are declared by their own code (`declare`) */
export const BASE_CAPABILITIES: readonly string[] = ['server-links'];

/** `<data dir>/instance.json` */
export const INSTANCE_FILE = 'instance.json';

interface InstanceDocument {
  instanceId: string;
  createdAt: string;
}

/**
 * The id in `instance.json`, made on the first start. An unreadable file stops the start rather than
 * being replaced: a new id is a different server to every hub that paired with this one, which then
 * refuses it as a changed identity, and a person should see why before that happens.
 */
export function readInstanceId(dataDir: string): string {
  const file = join(dataDir, INSTANCE_FILE);
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`${file} is not readable as JSON (${errorMessage(error)}); fix it, or delete it to give this server a new identity`);
    }
    const id = (parsed as { instanceId?: unknown } | null)?.instanceId;
    if (typeof id !== 'string' || !id) throw new Error(`${file} has no instanceId; fix it, or delete it to give this server a new identity`);
    return id;
  }
  const document: InstanceDocument = { instanceId: randomUUID(), createdAt: new Date().toISOString() };
  mkdirSync(dataDir, { recursive: true });
  // Renamed into place, so a start that dies halfway leaves no half-written identity behind
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`);
  renameSync(tmp, file);
  return document.instanceId;
}

/**
 * The SHA-256 of the LAN listener's certificate, which a grant hands the hub to pin (§9.1); null while
 * the listener has never made one (it was never turned on).
 */
export function lanTlsFingerprint(lan: object): string | null {
  const read = (lan as { tlsFingerprint?: unknown }).tlsFingerprint;
  if (typeof read !== 'function') return null;
  const value: unknown = read.call(lan);
  return typeof value === 'string' && value ? value : null;
}

export interface ServerIdentityOptions {
  dataDir: string;
  version: string;
  /** The LAN certificate's fingerprint, or null without TLS */
  tlsFingerprint: () => string | null;
}

export class ServerIdentity {
  readonly instanceId: string;
  private readonly version: string;
  private readonly capabilities = new Set<string>(BASE_CAPABILITIES);
  private readonly fingerprint: () => string | null;

  constructor(options: ServerIdentityOptions) {
    this.instanceId = readInstanceId(options.dataDir);
    this.version = options.version;
    this.fingerprint = options.tlsFingerprint;
  }

  /** The one list of capabilities: a feature that a hub may rely on adds its name here, in its own code */
  declare(capability: string): void {
    this.capabilities.add(capability);
  }

  tlsFingerprint(): string | null {
    return this.fingerprint();
  }

  /** `GET /meta`: nothing about accounts, paths or hosts, because anyone who reaches the port may read it */
  get meta(): ServerMeta {
    return {
      instanceId: this.instanceId,
      version: this.version,
      apiVersion: { current: API_VERSION, min: API_VERSION_MIN },
      capabilities: [...this.capabilities].sort(),
    };
  }
}
