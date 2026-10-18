import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';

export interface Resources {
  /** Bundled API server (single-file ESM) */
  serverEntry: string;
  /** Bundled MCP server a chat's CLI starts (single-file ESM, next to serverEntry) */
  mcpEntry: string;
  /** Bundled guard program, the hook the CLI runs before each tool call (single-file ESM, next to serverEntry) */
  guardEntry: string;
  /** Built UI served by the API */
  webDist: string;
  /** The Ed25519 public keys a payload and the desktop manifest must verify against */
  keysDir: string;
  /** `{ version, shellInputs }`, written by the package; apt replacing it says the shell changed underneath */
  shellJson: string;
  /** Window icon */
  icon: string;
}

/**
 * Packaged: electron-builder extraResources put the bundle in <resources>/server, the UI in <resources>/web,
 * the public keys in <resources>/keys and the shell's identity in <resources>/shell.json. These are the
 * shell's, inside the AppImage's read-only mount or root-owned /opt/Claudio: a payload in the data dir
 * brings its own server and web, never its own guard or keys.
 * Dev: the compiled main lives in apps/desktop/dist, so the repo root is three levels up.
 */
export function resolveResources(): Resources {
  if (app.isPackaged) {
    return {
      serverEntry: join(process.resourcesPath, 'server', 'server.mjs'),
      mcpEntry: join(process.resourcesPath, 'server', 'mcp.mjs'),
      guardEntry: join(process.resourcesPath, 'server', 'guard.mjs'),
      webDist: join(process.resourcesPath, 'web'),
      keysDir: join(process.resourcesPath, 'keys'),
      shellJson: join(process.resourcesPath, 'shell.json'),
      icon: join(process.resourcesPath, 'icon.png'),
    };
  }
  const repoRoot = resolve(__dirname, '..', '..', '..');
  return {
    serverEntry: join(repoRoot, 'apps', 'api', 'dist', 'server.mjs'),
    mcpEntry: join(repoRoot, 'apps', 'api', 'dist', 'mcp.mjs'),
    guardEntry: join(repoRoot, 'apps', 'api', 'dist', 'guard.mjs'),
    webDist: join(repoRoot, 'apps', 'web', 'dist'),
    keysDir: join(repoRoot, 'docker', 'keys'),
    // Staged by `package:stage`; a dev build without it boots the bundled payload only
    shellJson: join(repoRoot, 'apps', 'desktop', 'dist', 'package', 'shell.json'),
    icon: join(repoRoot, 'apps', 'desktop', 'build', 'icon.png'),
  };
}

/** Names what is absent so a broken build or package fails with a readable message */
export function missingResources(res: Resources): string[] {
  const missing: string[] = [];
  if (!existsSync(res.serverEntry)) missing.push(res.serverEntry);
  if (!existsSync(res.mcpEntry)) missing.push(res.mcpEntry);
  if (!existsSync(res.guardEntry)) missing.push(res.guardEntry);
  if (!existsSync(join(res.webDist, 'index.html'))) missing.push(join(res.webDist, 'index.html'));
  return missing;
}
