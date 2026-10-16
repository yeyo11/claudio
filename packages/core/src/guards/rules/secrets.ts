/*
 * `secrets`: no high-confidence secret is written to a file, committed or left in a config. The reason
 * names the pattern, never the secret.
 */
import { findSecrets } from '../secrets.ts';
import { type Block, type RuleContext, bashWrites, gitOf } from './common.ts';

const WRITERS = new Set(['redirect', 'tee', 'sed-i', 'perl-i', 'dd', 'cp', 'mv', 'install', 'rsync', 'patch', 'git-apply']);
const PERSISTING_VERBS = new Set(['commit', 'config', 'notes', 'tag']);

const found = (id: string): Block => ({ matcher: `secrets.${id}`, reason: `this would write a secret (${id}) to a file or commit; keep secrets in the environment or the vault` });

export function secrets(ctx: RuleContext): Block | null {
  for (const target of ctx.tool.writes) {
    const old = new Set<string>();
    for (const content of target.oldContents) for (const match of findSecrets(content, ctx.known)) old.add(match.value);
    for (const content of target.contents) {
      for (const match of findSecrets(content, ctx.known)) if (!old.has(match.value)) return found(match.id);
    }
  }

  for (const cmd of ctx.cmds) {
    const call = gitOf(cmd);
    const persists = call?.verb != null && PERSISTING_VERBS.has(call.verb);
    if (!persists && !bashWrites(cmd, ctx).some((hit) => WRITERS.has(hit.kind))) continue;
    const texts = [
      cmd.argv.map((word) => word.text).join(' '),
      ...cmd.assigns.map((assign) => assign.value.text),
      ...cmd.redirects.flatMap((redirect) => (redirect.body === null ? [] : [redirect.body])),
      cmd.stdin ?? '',
      cmd.pipeRaw,
    ];
    for (const text of texts) {
      const match = findSecrets(text, ctx.known)[0];
      if (match) return found(match.id);
    }
  }

  for (const scan of ctx.scans) {
    if (scan.kind !== 'interpreter') continue;
    const match = findSecrets(scan.text, ctx.known)[0];
    if (match) return found(match.id);
  }
  return null;
}
