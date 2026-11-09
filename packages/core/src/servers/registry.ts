import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage, isRecord, type ServerAddress, type ServersSettings } from '@claudio/shared';
import { writeAtomic } from '../config/files.ts';
import type { SecretVault } from '../secret-vault.ts';
import { parseAddresses } from './addresses.ts';
import { ServersError } from './errors.ts';

/** `<data dir>/servers.json`: the servers this hub drives, settings-shaped (docs/plans/claudio-servers.md, §4.2) */
export const SERVERS_FILE = 'servers.json';
/** `<data dir>/servers-settings.json`: the switch, apart from the list so turning it off leaves the list as it was (D8) */
export const SERVERS_SETTINGS_FILE = 'servers-settings.json';
/** The vault's name for the server tokens: one variable per server id. No CLI goes by it, so none is ever handed one */
export const SERVERS_VAULT_TOOL = 'claudio-servers';

/** One server as `servers.json` keeps it: never its token, which is in the vault */
export interface StoredServer {
  id: string;
  name: string;
  color: string | null;
  monogram: string | null;
  addresses: ServerAddress[];
  identity: {
    instanceId: string;
    /** The grant's: SHA-256 of the remote's LAN certificate, null while it had none */
    tlsFingerprint: string | null;
    /** SHA-256 of that certificate's public key, so a certificate remade on the same key is still this server */
    publicKey: string | null;
  };
  /** The remote's id for the token it gave this hub, for the person to match it with the remote's list */
  tokenId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface ServersDocument {
  servers: StoredServer[];
}

const nullableString = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** A stored entry, or null for one a hand edit broke: that one is left out rather than failing the rest */
function storedServer(value: unknown): StoredServer | null {
  if (!isRecord(value) || !isRecord(value.identity)) return null;
  const { id, name, tokenId, createdAt } = value;
  const instanceId = value.identity.instanceId;
  if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id) || typeof name !== 'string' || !name || typeof tokenId !== 'string' || typeof createdAt !== 'string' || typeof instanceId !== 'string' || !instanceId) return null;
  let addresses: ServerAddress[];
  try {
    addresses = parseAddresses(value.addresses);
  } catch {
    return null;
  }
  return {
    id,
    name,
    color: nullableString(value.color),
    monogram: nullableString(value.monogram),
    addresses,
    identity: { instanceId, tlsFingerprint: nullableString(value.identity.tlsFingerprint), publicKey: nullableString(value.identity.publicKey) },
    tokenId,
    createdAt,
    lastUsedAt: nullableString(value.lastUsedAt),
  };
}

const copy = (server: StoredServer): StoredServer => ({ ...server, addresses: server.addresses.map((each) => ({ ...each })), identity: { ...server.identity } });

/**
 * The list, its switch and the tokens. Each write is the whole document, written atomically and one
 * at a time, as the vault writes `secrets.json`. A `servers.json` that cannot be read is never
 * written over: the hub starts with no servers and refuses changes until a person fixes or removes
 * the file, so a typo cannot cost every pairing.
 */
export class ServerRegistry {
  private readonly file: string;
  private readonly settingsFile: string;
  private servers: StoredServer[];
  private enabled: boolean;
  private unreadable: string | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly vault: SecretVault,
  ) {
    this.file = join(dataDir, SERVERS_FILE);
    this.settingsFile = join(dataDir, SERVERS_SETTINGS_FILE);
    this.servers = this.readServers();
    this.enabled = this.readEnabled();
  }

  get settings(): ServersSettings {
    return { enabled: this.enabled };
  }

  list(): StoredServer[] {
    return this.servers.map(copy);
  }

  get(id: string): StoredServer | null {
    const found = this.servers.find((each) => each.id === id);
    return found ? copy(found) : null;
  }

  /** The token this hub holds for a server, opened; null when the vault has none (or cannot open it) */
  tokenOf(id: string): string | null {
    return this.vault.get(SERVERS_VAULT_TOOL)[id] ?? null;
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.queue(async () => {
      await writeAtomic(this.settingsFile, `${JSON.stringify({ enabled }, null, 2)}\n`);
      this.enabled = enabled;
    });
  }

  /** Adds or replaces a server; with a token, the token first, so a server is never on record without one */
  put(server: StoredServer, token?: string): Promise<void> {
    return this.queue(async () => {
      this.writable();
      if (token !== undefined) await this.vault.set(SERVERS_VAULT_TOOL, { [server.id]: token });
      const next = this.servers.filter((each) => each.id !== server.id);
      const at = this.servers.findIndex((each) => each.id === server.id);
      next.splice(at === -1 ? next.length : at, 0, copy(server));
      await this.write(next);
    });
  }

  /**
   * Changes one server as it is when the write's turn comes, so two changes that race (a selection
   * writing `lastUsedAt`, a connection learning a renewed certificate) do not undo each other
   */
  change(id: string, apply: (server: StoredServer) => StoredServer): Promise<StoredServer> {
    let saved: StoredServer | null = null;
    return this.queue(async () => {
      this.writable();
      const at = this.servers.findIndex((each) => each.id === id);
      const current = this.servers[at];
      if (at === -1 || !current) throw new ServersError(404, 'servers.not-found', `no server with id ${id}`);
      const next = [...this.servers];
      saved = copy(apply(copy(current)));
      next[at] = saved;
      await this.write(next);
    }).then(() => {
      if (!saved) throw new ServersError(404, 'servers.not-found', `no server with id ${id}`);
      return copy(saved);
    });
  }

  /** Forgets a server, then its token: a stop between the two leaves a sealed secret nobody reads, not a server without one */
  remove(id: string): Promise<void> {
    return this.queue(async () => {
      this.writable();
      await this.write(this.servers.filter((each) => each.id !== id));
      await this.vault.clear(SERVERS_VAULT_TOOL, [id]);
    });
  }

  private queue(work: () => Promise<void>): Promise<void> {
    const next = this.writing.then(work);
    this.writing = next.catch(() => undefined);
    return next;
  }

  private writable(): void {
    if (this.unreadable !== null) throw new ServersError(500, 'servers.file-unreadable', this.unreadable);
  }

  private async write(servers: StoredServer[]): Promise<void> {
    const document: ServersDocument = { servers };
    await writeAtomic(this.file, `${JSON.stringify(document, null, 2)}\n`);
    this.servers = servers;
  }

  private readServers(): StoredServer[] {
    if (!existsSync(this.file)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      this.unreadable = `${this.file} is not readable as JSON (${errorMessage(error)}); fix it, or remove it to start the list again`;
      return [];
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.servers)) {
      this.unreadable = `${this.file} holds no { servers: [...] }; fix it, or remove it to start the list again`;
      return [];
    }
    return parsed.servers.map(storedServer).filter((each): each is StoredServer => each !== null);
  }

  private readEnabled(): boolean {
    if (!existsSync(this.settingsFile)) return false;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.settingsFile, 'utf8'));
      return isRecord(parsed) && parsed.enabled === true;
    } catch {
      return false;
    }
  }
}
