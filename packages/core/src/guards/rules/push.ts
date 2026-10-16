/*
 * `push`: nothing writes to a remote. The git push family, and the code-host CLI commands that write
 * (D9). Opaque input is read as text.
 */
import type { Scan, Word } from '../shell.ts';
import { type Block, type RuleContext, baseName, gitOf, normalizedText, positionals, statements } from './common.ts';

const block = (matcher: string, reason: string): Block => ({ matcher, reason });

const GH: Record<string, readonly string[] | 'all-but-read'> = {
  pr: ['create', 'merge', 'close', 'reopen', 'edit', 'comment', 'review', 'ready'],
  repo: ['sync', 'create', 'delete', 'edit', 'fork', 'rename', 'archive'],
  release: 'all-but-read',
  issue: ['create', 'edit', 'close', 'reopen', 'comment', 'delete'],
  workflow: ['run'],
  run: ['rerun', 'cancel'],
  secret: ['set', 'delete'],
  variable: ['set', 'delete'],
};
const GLAB: Record<string, readonly string[]> = {
  mr: ['create', 'merge', 'close', 'reopen', 'update', 'note', 'approve'],
  repo: ['create', 'delete', 'fork', 'archive'],
  release: ['create', 'delete', 'upload'],
  issue: ['create', 'update', 'close', 'note', 'delete'],
  ci: ['run', 'retry', 'cancel'],
};

/** `gh api`/`glab api`: a writing method, or fields (which make the CLI send a POST) */
function apiWrites(args: readonly Word[]): boolean {
  let method: string | null = null;
  let fields = false;
  for (let i = 0; i < args.length; i++) {
    const text = args[i]?.text ?? '';
    if (text === '-X' || text === '--method') method = args[++i]?.text ?? '';
    else if (text.startsWith('--method=')) method = text.slice(9);
    else if (/^-X./.test(text)) method = text.slice(2);
    else if (['-f', '-F', '--field', '--raw-field', '--input'].includes(text) || /^--(?:field|raw-field|input)=/.test(text) || /^-[fF]./.test(text)) fields = true;
  }
  if (method !== null) return /^(?:POST|PUT|PATCH|DELETE)$/i.test(method);
  return fields;
}

function codeHostWrite(cmd: { argv: Word[] }): boolean {
  const head = baseName(cmd.argv[0]?.text ?? '');
  if (head !== 'gh' && head !== 'glab') return false;
  const args = cmd.argv.slice(1);
  const words = positionals(args, 0, ['-R', '--repo', '--hostname', '-h']).map((word) => word.text);
  const [group, sub] = words;
  if (group === 'api') return apiWrites(args);
  if (!group || !sub) return false;
  if (head === 'gh') {
    const verbs = GH[group];
    if (verbs === 'all-but-read') return !['view', 'list', 'download'].includes(sub);
    return verbs?.includes(sub) ?? false;
  }
  return GLAB[group]?.includes(sub) ?? false;
}

const PUSH_SCAN = /(?:^|[^a-z0-9])git(?: (?:-\S*|\S*[=/.]\S*)){0,4} push(?![a-z0-9-])|(?:^|[^a-z0-9])git-push(?![a-z0-9])|send-pack/;

function scanPushes(scan: Scan): boolean {
  if (scan.kind === 'dynamic' || scan.kind === 'xargs') {
    const text = normalizedText(scan.text);
    return /(?:^|[^a-z0-9])push(?![a-z0-9])/.test(text) && text.includes('git');
  }
  return statements(scan.text).some((statement) => PUSH_SCAN.test(statement));
}

export function push(ctx: RuleContext): Block | null {
  for (const cmd of ctx.cmds) {
    const call = gitOf(cmd);
    if (call) {
      if (call.verbDynamic) return block('push.dynamic-verb', 'the guard cannot see the git subcommand; run git with literal arguments');
      const first = call.args[0]?.text;
      if (call.verb === 'push') return block('push.git-verb', 'pushing is not allowed; the person pushes');
      if (call.verb === 'send-pack') return block('push.send-pack', 'pushing is not allowed; the person pushes');
      if ((call.verb === 'subtree' || call.verb === 'lfs') && first === 'push') return block('push.git-verb', 'pushing is not allowed; the person pushes');
    }
    if (codeHostWrite(cmd)) return block('push.code-host', 'writing to a code host is not allowed; the person does that');
  }
  for (const scan of ctx.scans) {
    if (scanPushes(scan)) return block('push.text-scan', 'the guard cannot see the arguments of this command; run git with literal arguments');
  }
  return null;
}
