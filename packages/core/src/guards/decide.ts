/*
 * The decision: pure, from a rules file and a hook input to pass or block. Rules run in a fixed order
 * and the first block wins. Only `node:` imports.
 */
import { type Decision, type GuardRuleId, type GuardRulesFile, type HookInput, classify } from './input.ts';
import { type Block, type RuleContext, snippet } from './rules/common.ts';
import { destructive } from './rules/destructive.ts';
import { integrity } from './rules/integrity.ts';
import { noVerify } from './rules/no-verify.ts';
import { protectConfigs } from './rules/protect-configs.ts';
import { push } from './rules/push.ts';
import { secrets } from './rules/secrets.ts';
import { type Cmd, type Scan, readShell } from './shell.ts';

const ORDER: readonly [GuardRuleId, (ctx: RuleContext) => Block | null][] = [
  ['integrity', integrity],
  ['no-verify', noVerify],
  ['push', push],
  ['destructive', destructive],
  ['secrets', secrets],
  ['protect-configs', protectConfigs],
];

const blockOf = (matcher: string, reason: string): Decision => ({ verdict: 'block', rule: 'integrity', reason, matcher });

export function decide(rules: GuardRulesFile, input: HookInput): Decision {
  const tool = classify(input, rules.limits.maxInputBytes);
  if (tool.oversize) return blockOf('integrity.input-too-large', 'the tool input is too large to check');

  const cmds: Cmd[] = [];
  const scans: Scan[] = [];
  const links: [string, string][] = [];
  const cwd = input.cwd ?? rules.roots[0] ?? null;
  for (const command of tool.commands) {
    const view = readShell(command, {
      cwd,
      roots: rules.roots,
      maxDepth: rules.limits.maxDepth,
      maxFilesRead: rules.limits.maxFilesRead,
      maxScriptBytes: rules.limits.maxScriptBytes,
    });
    if (view.error === 'unparseable') return blockOf('integrity.unparseable', `the guard cannot parse this command line (${snippet(command)}); write it more plainly`);
    if (view.error === 'too-deep') return blockOf('integrity.too-deep', 'this command nests shells or scripts too deeply for the guard');
    cmds.push(...view.commands);
    scans.push(...view.scans);
    links.push(...view.links);
  }

  const enabled = new Set<GuardRuleId>(rules.rules);
  enabled.add('integrity');
  const ctx: RuleContext = { rules, enabled, input, tool, cmds, scans, links, cwd, known: new Set(rules.knownSecretSha256) };
  for (const [id, check] of ORDER) {
    if (!enabled.has(id)) continue;
    const found = check(ctx);
    if (found) return { verdict: 'block', rule: id, reason: found.reason, matcher: found.matcher };
  }
  return { verdict: 'pass' };
}
