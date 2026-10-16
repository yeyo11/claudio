/*
 * `protect-configs` (off by default): existing lint, format and CI configs are not edited, moved or
 * deleted. Creating a new file passes, and so does a target the guard cannot resolve.
 */
import { existsSync } from 'node:fs';
import { isInside, matchesGlob } from '../paths.ts';
import { type Block, type RuleContext, bashWrites, toolPath } from './common.ts';

const SKIPPED_KINDS = new Set(['chmod', 'touch', 'ln']);

function protectedFile(path: string, ctx: RuleContext): boolean {
  if (!existsSync(path)) return false;
  const bases = ctx.rules.mainCheckout ? [...ctx.rules.roots, ctx.rules.mainCheckout] : ctx.rules.roots;
  for (const root of bases) {
    if (!isInside(path, root) || path === root) continue;
    const relative = path.slice(root === '/' ? 1 : root.length + 1);
    if (ctx.rules.protectConfigs.some((glob) => matchesGlob(relative, glob))) return true;
  }
  return false;
}

export function protectConfigs(ctx: RuleContext): Block | null {
  const blocked = (): Block => ({ matcher: 'protect-configs.edit', reason: 'this lint, format or CI config is protected; fix the code instead of changing the config, or ask the person' });
  for (const target of ctx.tool.writes) {
    const path = toolPath(target, ctx);
    if (path !== null && protectedFile(path, ctx)) return blocked();
  }
  for (const cmd of ctx.cmds) {
    for (const hit of bashWrites(cmd, ctx)) {
      if (SKIPPED_KINDS.has(hit.kind) || !hit.paths) continue;
      if (hit.paths.some((path) => protectedFile(path, ctx))) return blocked();
    }
  }
  return null;
}
