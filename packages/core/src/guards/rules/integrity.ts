/*
 * `integrity` (always on): protects the guard itself. Claudio's state, the settings that could switch
 * hooks off, git's control files, git configuration injection, unknown git verbs and nested Claude
 * Code. Where `no-verify` is on it names the hook-related cases itself, so the reason is the right one.
 */
import { KNOWN_GIT_VERBS, configKeyKind, configSectionKind, configWrite, isGitConfigEnv } from '../git.ts';
import { insideAny, realResolve, resolveLexical, segments } from '../paths.ts';
import { type Block, type RuleContext, baseName, bashWrites, envAssignments, gitOf, isHookPath, protectedMatch, snippet, toolPath } from './common.ts';

const block = (matcher: string, reason: string): Block => ({ matcher, reason });

const isGitHook = (path: string, ctx: RuleContext): boolean => segments(path).includes('.git') && isHookPath(path, ctx);

function checkPath(path: string, how: 'tool' | 'bash', ctx: RuleContext): Block | null {
  const matcher = protectedMatch(path, how, ctx);
  const deferHooks = ctx.enabled.has('no-verify');
  if (matcher && !(matcher === 'integrity.git-control' && deferHooks && isGitHook(path, ctx))) {
    return block(matcher, `writing to ${matcher === 'integrity.own-state' ? "Claudio's own files" : matcher === 'integrity.claude-settings' ? "Claude Code's settings" : "git's control files"} is not allowed under guards`);
  }
  if (!deferHooks && how === 'bash' && isGitHook(path, ctx) && segments(path).includes('.git')) {
    return block('integrity.git-control', "writing to git's hooks is not allowed under guards");
  }
  return null;
}

export function integrity(ctx: RuleContext): Block | null {
  const deferHooks = ctx.enabled.has('no-verify');

  for (const target of ctx.tool.writes) {
    if (target.path !== null && /[\0�]/.test(target.path)) return block('integrity.bad-path', 'the path holds an invalid character');
    const path = toolPath(target, ctx);
    if (path === null) continue;
    const found = checkPath(path, 'tool', ctx);
    if (found) return found;
  }

  const env = envAssignments(ctx.cmds);
  for (const assign of env) {
    const name = assign.name;
    const value = assign.value.text;
    if (name === 'GIT_DIR') {
      const abs = assign.value.dynamic ? null : resolveLexical(value, assign.cmd.cwd);
      const real = abs === null ? null : realResolve(abs, true, ctx.links);
      const gitDirs = ctx.rules.mainCheckout ? [...ctx.rules.roots, ctx.rules.mainCheckout] : ctx.rules.roots;
      if (real === null || !insideAny(real, gitDirs)) return block('integrity.git-config-env', 'GIT_DIR must stay inside the project under guards');
    } else if (isGitConfigEnv(name)) {
      if (deferHooks && /hookspath/i.test(value)) continue;
      return block('integrity.git-config-env', `${name} changes how git behaves and is not allowed under guards`);
    }
  }

  for (const cmd of ctx.cmds) {
    for (const hit of bashWrites(cmd, ctx)) {
      if (hit.paths === null) {
        // A recursive delete of an unknown target is `destructive`'s to name
        if (hit.kind === 'rm' && ctx.enabled.has('destructive')) continue;
        return block('integrity.unknown-target', `the target of this write cannot be determined (${snippet(hit.raw)}); write to a literal path`);
      }
      for (const path of hit.paths) {
        const found = checkPath(path, 'bash', ctx);
        if (found) return found;
      }
    }

    const head = cmd.argv[0];
    if (head) {
      const base = baseName(head.text);
      const args = cmd.argv.slice(1).map((word) => word.text);
      const outer = cmd.orig.map((word) => word.text);
      const nested =
        (base === 'claude' && !(args.length > 0 && args.every((arg) => ['--version', '-v', '--help', '-h'].includes(arg)))) ||
        (['npx', 'bunx', 'pnpm', 'yarn', 'npm'].includes(baseName(outer[0] ?? '')) && outer.some((word) => word.includes('@anthropic-ai/claude-code'))) ||
        (['node', 'nodejs', 'bun', 'deno'].includes(base) && args.some((arg) => /claude-code\/(?:cli|bin)/.test(arg)));
      if (nested) return block('integrity.nested-claude', 'a nested Claude Code would not carry the guards; do not start one');
    }

    const call = gitOf(cmd);
    if (!call) continue;
    for (const config of call.configs) {
      const kind = configKeyKind(config.key);
      if (kind === null || (kind === 'hooks-path' && deferHooks)) continue;
      return block('integrity.git-config-key', `git config key ${config.key.toLowerCase()} is not allowed under guards`);
    }
    if (call.verb === 'config') {
      const write = configWrite(call.args);
      if (write) {
        if (write.edit) return block('integrity.git-config-key', 'editing git configuration is not allowed under guards');
        for (const key of write.keys) {
          const kind = configKeyKind(key);
          if (kind !== null && !(kind === 'hooks-path' && deferHooks)) return block('integrity.git-config-key', `git config key ${key.toLowerCase()} is not allowed under guards`);
        }
        for (const section of write.sections) {
          const kind = configSectionKind(section);
          if (kind !== null && !(kind === 'hooks-path' && deferHooks)) return block('integrity.git-config-key', `git config section ${section.toLowerCase()} is not allowed under guards`);
        }
      }
    }
    if ((ctx.enabled.has('push') || ctx.enabled.has('no-verify')) && call.verb !== null && (call.verbDynamic || !KNOWN_GIT_VERBS.has(call.verb))) {
      return block('integrity.unknown-git-verb', 'unknown git subcommand; aliases are not allowed under guards');
    }
  }
  return null;
}
