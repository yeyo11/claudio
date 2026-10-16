/*
 * `no-verify`: nothing skips git's hooks. The `--no-verify` flags and `-n` on commit, a
 * `core.hooksPath` override, the environment switches of husky, lefthook and pre-commit, and
 * writes that disable hook scripts.
 */
import { configKeyKind, configSectionKind, configWrite, skipsHooks } from '../git.ts';
import { type Block, type RuleContext, bashWrites, envAssignments, gitOf, isHookPath, normalizedText, toolPath } from './common.ts';

const block = (matcher: string, reason: string): Block => ({ matcher, reason });

const SCAN = /--no-ver(?:ify|if|i)?(?![a-z-])|hookspath|husky=0|husky_skip_hooks|lefthook=0/;

export function noVerify(ctx: RuleContext): Block | null {
  const env = envAssignments(ctx.cmds);
  const gitAt = ctx.cmds.map((cmd) => gitOf(cmd) !== null);

  for (const assign of env) {
    const name = assign.name;
    const value = assign.value.text;
    if ((name === 'HUSKY' && value === '0') || name === 'HUSKY_SKIP_HOOKS' || name === 'HUSKY_SKIP_INSTALL' || (name === 'LEFTHOOK' && value === '0') || name === 'LEFTHOOK_EXCLUDE') {
      return block('no-verify.env', `${name} switches git hooks off; hooks must run`);
    }
    if ((name === 'GIT_CONFIG_PARAMETERS' || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) && /hookspath/i.test(value)) {
      return block('no-verify.hooks-path', 'core.hooksPath must not be overridden; hooks must run');
    }
    if (name === 'SKIP' || name === 'PRE_COMMIT_ALLOW_NO_CONFIG') {
      if (assign.exported || gitAt.slice(assign.index).some(Boolean)) return block('no-verify.env', `${name} skips pre-commit hooks; hooks must run`);
    }
  }

  for (const cmd of ctx.cmds) {
    const call = gitOf(cmd);
    if (call) {
      for (const config of call.configs) {
        if (configKeyKind(config.key) === 'hooks-path') return block('no-verify.hooks-path', 'core.hooksPath must not be overridden; hooks must run');
      }
      if (call.verb === 'config') {
        const write = configWrite(call.args);
        if (write && (write.keys.some((key) => configKeyKind(key) === 'hooks-path') || write.sections.some((section) => configSectionKind(section) === 'hooks-path'))) {
          return block('no-verify.hooks-path', 'core.hooksPath must not be changed; hooks must run');
        }
      }
      if (call.verb && !call.verbDynamic && skipsHooks(call.verb, call.args)) {
        return block('no-verify.skip-flag', 'skipping git hooks is not allowed; fix what the hook reports instead');
      }
    }
    for (const hit of bashWrites(cmd, ctx)) {
      if (!hit.paths || (['chmod', 'touch'].includes(hit.kind) && !hit.disables)) continue;
      if (hit.kind === 'touch') continue;
      if (hit.paths.some((path) => isHookPath(path, ctx))) return block('no-verify.disable-hook', 'changing or removing git hook scripts is not allowed');
    }
  }

  for (const target of ctx.tool.writes) {
    const path = toolPath(target, ctx);
    if (path !== null && isHookPath(path, ctx)) return block('no-verify.disable-hook', 'changing or removing git hook scripts is not allowed');
  }

  for (const scan of ctx.scans) {
    if (SCAN.test(normalizedText(scan.text))) {
      return block('no-verify.text-scan', 'the guard cannot see the arguments of this command; run git with literal arguments, without skipping hooks');
    }
  }
  return null;
}
