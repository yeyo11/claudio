/*
 * The decision: pure, from a rules file and a hook input to pass or block. Rules run in a fixed order
 * and the first block wins. Only `node:` imports.
 */
import { type Decision, type GuardRuleId, type GuardRulesFile, type HookInput, classify } from './input.ts';
import { type Block, type RuleContext, snippet } from './rules/common.ts';
import { declaredTools } from './rules/declared-tools.ts';
import { destructive } from './rules/destructive.ts';
import { integrity } from './rules/integrity.ts';
import { noVerify } from './rules/no-verify.ts';
import { protectConfigs } from './rules/protect-configs.ts';
import { push } from './rules/push.ts';
import { secrets } from './rules/secrets.ts';
import { type Cmd, type Scan, readShell } from './shell.ts';

const ORDER: readonly [GuardRuleId, (ctx: RuleContext) => Block | null][] = [
  ['integrity', integrity],
  ['declared-tools', declaredTools],
  ['no-verify', noVerify],
  ['push', push],
  ['destructive', destructive],
  ['secrets', secrets],
  ['protect-configs', protectConfigs],
];

const blockOf = (matcher: string, reason: string): Decision => ({ verdict: 'block', rule: 'integrity', reason, matcher });

export function decide(rules: GuardRulesFile, input: HookInput): Decision {
  // Only the rules the file names run (D6): `integrity` too, so a guard whose person switched it off
  // neither refuses what it cannot read nor guards its own files. A declared policy arms its rule by
  // being there: no list or switch can leave it out
  const enabled = new Set<GuardRuleId>(rules.rules);
  if (rules.declared) enabled.add('declared-tools');
  const strict = enabled.has('integrity');
  const tool = classify(input, rules.limits.maxInputBytes);
  if (tool.oversize && strict) return blockOf('integrity.input-too-large', 'the tool input is too large to check');

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
      emitWrappers: !!rules.declared,
    });
    if (view.error === 'unparseable' && strict) return blockOf('integrity.unparseable', `the guard cannot parse this command line (${snippet(command)}); write it more plainly`);
    if (view.error === 'too-deep' && strict) return blockOf('integrity.too-deep', 'this command nests shells or scripts too deeply for the guard');
    cmds.push(...view.commands);
    scans.push(...view.scans);
    links.push(...view.links);
  }

  const ctx: RuleContext = { rules, enabled, input, tool, cmds, scans, links, cwd, known: new Set(rules.knownSecretSha256) };
  for (const [id, check] of ORDER) {
    if (!enabled.has(id)) continue;
    const found = check(ctx);
    if (found) return { verdict: 'block', rule: id, reason: found.reason, matcher: found.matcher };
  }
  return { verdict: 'pass' };
}
