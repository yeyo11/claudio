import { accessSync, constants, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { VERSION, compareVersions } from './launcher/protocol.ts';
import { satisfiesRange } from './providers/detector.ts';

export interface ClaudeBinOptions {
  /** `config.claudeBin` as configured (`CLAUDE_BIN`, else `claude`): looked up on the server's own PATH */
  configured: string;
  dataDir: string;
  distribution: string | undefined;
  /** The Claude Code binary the person set in Settings → Claude Code, an absolute path */
  override: () => string | null;
  /** The version the image pins; an overlay must be newer */
  pinned: () => string | null;
  /** The driver's range (`>=2.1 <3`) */
  range: string;
}

/**
 * The one decision of which Claude Code binary Claudio runs (docs/plans/container-polish.md, D4).
 * The person's override wins; then the overlay `/data/cli/current` when it is valid (a version
 * newer than the image's pin, inside the driver's range, an executable file); else the configured
 * name, found on the server's own PATH. The overlay is returned as an absolute path on purpose:
 * Claudio puts the login shell's PATH first for what it starts, and that PATH leads to the image's
 * CLI, so a lookup by name after that merge would run the old binary.
 */
export function resolveClaudeBin(o: ClaudeBinOptions): string {
  const override = o.override();
  if (override) return override;
  return overlayBinary(o) ?? o.configured;
}

/** The overlay's binary when it can be used, else null */
export function overlayBinary(o: Pick<ClaudeBinOptions, 'dataDir' | 'distribution' | 'pinned' | 'range'>): string | null {
  if (o.distribution !== 'docker') return null;
  const root = join(o.dataDir, 'cli');
  let version: string;
  try {
    version = basename(readlinkSync(join(root, 'current')));
  } catch {
    return null;
  }
  if (!VERSION.test(version) || satisfiesRange(version, o.range) !== 'in') return null;
  const pinned = o.pinned();
  if (pinned !== null && compareVersions(version, pinned) <= 0) return null;
  const binary = join(root, version, 'bin', 'claude');
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    return null;
  }
  return binary;
}
