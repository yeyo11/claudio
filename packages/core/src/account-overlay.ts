/*
 * The spawn-time overlay of a shared account, turned into what a `claude` process is given: one
 * `--mcp-config` file and one `--settings` file per chat under `<dataDir>/mcp/`, both 0600 since a
 * server's definition carries its headers and tokens. The overlay itself is derived in
 * `@claudio/accounts` (`McpOverlay`); this decides when it applies and joins it to what the chat
 * already passes, because the CLI takes one `--mcp-config` file from Claudio and the last
 * `--settings` flag only (S3f).
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpOverlay, type Overlay } from '@claudio/accounts';
import { removeChatOverlayFiles } from './chat-tools.ts';
import type { SessionLaunch } from './providers/driver.ts';

export const OVERLAY_PREFIX = 'overlay-';
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `CLAUDIO_ACCOUNT_OVERLAY=off` gives shared accounts nothing but their links, as before T3 */
export function overlayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDIO_ACCOUNT_OVERLAY?.trim().toLowerCase() !== 'off';
}

export type OverlayLaunch = Pick<SessionLaunch, 'mcpConfig' | 'mcpConfigAdds' | 'settingsFile'>;

export interface AccountOverlayOptions {
  dataDir: string;
  /** The default account's state file (`CoreConfig.globalConfigFile`) */
  stateFile: string;
  log?: (message: string) => void;
  enabled?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export class AccountOverlay {
  private readonly overlay: McpOverlay;
  private readonly said = new Set<string>();

  constructor(private readonly opts: AccountOverlayOptions) {
    this.overlay = new McpOverlay({ stateFile: opts.stateFile, ...(opts.log ? { log: opts.log } : {}) });
  }

  private say(message: string): void {
    if (this.said.has(message)) return;
    this.said.add(message);
    this.opts.log?.(message);
  }

  /**
   * What replaces the launch's MCP and settings fields, or null to leave the launch as it is. Only a
   * shared account's process that loads the servers the CLI finds on its own gets one: a chat that
   * chose its servers runs strict with definitions read from the default's files already, and a
   * confined chat loads nothing it did not declare.
   */
  launch(spec: SessionLaunch): OverlayLaunch | null {
    if (this.opts.enabled === false || !spec.account?.sharedConfig) return null;
    if (spec.confine || spec.strictMcpConfig || (spec.mcpConfig && !spec.mcpConfigAdds)) return null;
    // The files are found again by the chat's id (`removeChatExtrasConfigs`), which only knows UUIDs
    if (!CHAT_ID.test(spec.id)) return null;
    const overlay = this.overlay.for(spec.cwd);
    if (!overlay) {
      removeChatOverlayFiles(this.opts.dataDir, spec.id, []);
      return null;
    }
    const out: OverlayLaunch = {};
    const keep: string[] = [];
    if (Object.keys(overlay.mcpServers).length) {
      const base = spec.mcpConfig ? this.readJson(spec.mcpConfig, 'mcpServers') : {};
      if (base) {
        // What Claudio adds (its own server, a caller's extras) wins over a same-named shared one
        const file = this.write(spec.id, '.json', { mcpServers: { ...overlay.mcpServers, ...base } });
        keep.push(file.name);
        out.mcpConfig = file.path;
        out.mcpConfigAdds = true;
      }
    }
    const settings = this.settings(spec, overlay);
    if (settings) {
      const file = this.write(spec.id, '.settings.json', settings);
      keep.push(file.name);
      out.settingsFile = file.path;
    }
    removeChatOverlayFiles(this.opts.dataDir, spec.id, keep);
    return Object.keys(out).length ? out : null;
  }

  /** The guard's settings with the overlay's keys under them: the guard's hooks are the file's reason to exist */
  private settings(spec: SessionLaunch, overlay: Overlay): Record<string, unknown> | null {
    if (!Object.keys(overlay.settings).length) return null;
    if (!spec.guard) return { ...overlay.settings };
    const guard = this.readJson(spec.guard.settingsPath, null);
    // A guarded process never starts without its hooks: without the guard's file, no overlay settings
    return guard ? { ...overlay.settings, ...guard } : null;
  }

  /** A JSON file of ours; `key` picks one object out of it. Null and one log line when it cannot be read */
  private readJson(path: string, key: string | null): Record<string, unknown> | null {
    try {
      const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const value = key === null ? doc : isRecord(doc) ? doc[key] : undefined;
      if (isRecord(value)) return value;
    } catch {
      // reported below
    }
    this.say(`accounts: the overlay for shared accounts left ${path} as it was: it could not be read`);
    return null;
  }

  /** Named by chat and content, so an unchanged overlay rewrites nothing a live process reads */
  private write(chatId: string, suffix: string, doc: unknown): { name: string; path: string } {
    const body = `${JSON.stringify(doc, null, 2)}\n`;
    const name = `${OVERLAY_PREFIX}${chatId}-${createHash('sha256').update(body).digest('hex').slice(0, 16)}${suffix}`;
    const dir = join(this.opts.dataDir, 'mcp');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, name);
    writeFileSync(path, body, { mode: 0o600 });
    chmodSync(path, 0o600);
    return { name, path };
  }
}
