/*
 * `destructive`: force pushes, `git reset --hard`, recursive deletes outside the worktree, devices and
 * file systems. A target the guard cannot resolve counts as outside, because it cannot tell.
 */
import { pushForces, resetsHard } from '../git.ts';
import { insideAny, isInside, resolveLexical } from '../paths.ts';
import type { Cmd, Word } from '../shell.ts';
import { type Block, type RuleContext, baseName, gitOf, hasLong, hasShort, normalizedText, positionals, statements, targetPaths } from './common.ts';

const block = (matcher: string, reason: string): Block => ({ matcher, reason });

const SCRATCH_HINT = 'use $TMPDIR for scratch files';

function outside(path: string, ctx: RuleContext): boolean {
  const tmp = ctx.rules.tmpDir;
  if (tmp && path !== tmp && isInside(path, tmp)) return false;
  return !insideAny(path, ctx.rules.roots);
}

function unknownTarget(word: Word): Block {
  return block('destructive.rm-unknown-target', `the target ${word.text.slice(0, 60)} cannot be resolved, so the delete is blocked; use a literal path inside the worktree, or ${SCRATCH_HINT}`);
}

function checkRm(cmd: Cmd, ctx: RuleContext): Block | null {
  const argv = cmd.argv;
  if (hasLong(argv, ['--no-preserve-root'])) return block('destructive.rm-no-preserve-root', 'rm --no-preserve-root is never allowed');
  if (!(hasShort(argv, 'rR') || hasLong(argv, ['--recursive']))) return null;
  if (cmd.xargs) return block('destructive.xargs-rm', 'a recursive rm fed by xargs has targets the guard cannot see');
  for (const word of positionals(argv, 1)) {
    if (cmd.findExec && word.text === '{}') continue;
    const paths = targetPaths(word, cmd.cwd, ctx, false);
    if (paths === null) return unknownTarget(word);
    for (const path of paths) {
      if (path.split('/').includes('.git')) return block('destructive.rm-git', 'deleting a .git directory is not allowed');
      if (ctx.rules.roots.includes(path)) return block('destructive.rm-root', 'deleting the worktree itself is not allowed');
      if (outside(path, ctx)) return block('destructive.rm-outside-root', `recursive delete outside the worktree is not allowed (${path.slice(0, 80)}); ${SCRATCH_HINT}`);
    }
  }
  return null;
}

/** The start paths of a `find`: the words before its first expression */
function findStarts(argv: readonly Word[]): Word[] {
  const out: Word[] = [];
  for (const word of argv.slice(1)) {
    if (word.text.startsWith('-') || word.text === '(' || word.text === '!' || word.text === ',') break;
    out.push(word);
  }
  return out;
}

function checkFind(cmd: Cmd, ctx: RuleContext): Block | null {
  const texts = cmd.argv.map((word) => word.text);
  const exec = texts.findIndex((text, i) => ['-exec', '-execdir', '-ok', '-okdir'].includes(text) && ['rm', 'shred', 'unlink'].includes(baseName(texts[i + 1] ?? '')));
  if (!texts.includes('-delete') && exec < 0) return null;
  const starts = findStarts(cmd.argv);
  const dirs = starts.length === 0 ? [cmd.cwd] : starts.map((word) => (targetPaths(word, cmd.cwd, ctx, true) ?? [null]).at(0) ?? null);
  for (const dir of dirs) {
    if (dir === null || outside(dir, ctx)) return block('destructive.find-delete', `find would delete outside the worktree or from a path the guard cannot resolve; ${SCRATCH_HINT}`);
  }
  return null;
}

const SYSTEM_DIRS = new Set(['/', '/home', '/etc', '/usr']);

export function destructive(ctx: RuleContext): Block | null {
  for (const cmd of ctx.cmds) {
    const head = cmd.argv[0];
    const base = baseName(head?.text ?? '');
    const call = gitOf(cmd);

    if (call && !call.verbDynamic) {
      const args = call.args;
      if (call.verb === 'push' && pushForces(args)) return block('destructive.force-push', 'a forced, mirrored or deleting push is not allowed');
      if (call.verb === 'send-pack' && pushForces(args, 'send-pack')) return block('destructive.force-push', 'a forced push is not allowed');
      if (call.verb === 'reset' && resetsHard(args)) return block('destructive.reset-hard', 'git reset --hard discards work; use git stash or git restore on named files');
      let dir = cmd.cwd;
      for (const word of call.dirs) dir = word.dynamic || dir === null ? null : resolveLexical(word.text, dir);
      if (call.verb === 'clean' && (hasShort(args as Word[], 'f', 0) || hasLong(args as Word[], ['--force'], 0)) && hasShort(args as Word[], 'dxX', 0)) {
        const specs = positionals(args as Word[], 0, ['-e', '--exclude']);
        const targets = specs.length === 0 ? [dir] : specs.map((word) => (word.dynamic || dir === null ? null : resolveLexical(word.text, dir)));
        if (targets.some((path) => path === null || outside(path, ctx))) return block('destructive.git-clean', 'git clean outside the worktree is not allowed');
      }
      if (call.verb === 'worktree' && args[0]?.text === 'remove' && (hasShort(args as Word[], 'f', 0) || hasLong(args as Word[], ['--force'], 0))) {
        const target = positionals(args.slice(1) as Word[], 0)[0];
        const path = !target || target.dynamic || dir === null ? null : resolveLexical(target.text, dir);
        if (path === null || path !== ctx.rules.roots[0]) return block('destructive.worktree-remove', "removing another worktree by force is not allowed; only the run's own may be removed");
      }
    }

    if (base === 'rm') {
      const found = checkRm(cmd, ctx);
      if (found) return found;
    } else if (base === 'find') {
      const found = checkFind(cmd, ctx);
      if (found) return found;
    } else if (base === 'rsync' && cmd.argv.some((word) => word.text.startsWith('--delete'))) {
      const dest = positionals(cmd.argv, 1, ['-e', '--rsh', '--exclude', '--include', '--filter', '-f']).at(-1);
      const paths = dest ? targetPaths(dest, cmd.cwd, ctx, true) : null;
      if (paths === null || paths.length !== 1 || outside(paths[0] ?? '/', ctx)) return block('destructive.rsync-delete', 'rsync --delete outside the worktree is not allowed');
    } else if (base === 'shred' || base === 'srm' || base === 'wipe') {
      for (const word of positionals(cmd.argv, 1)) {
        const paths = targetPaths(word, cmd.cwd, ctx, false);
        if (paths === null || paths.some((path) => outside(path, ctx))) return block('destructive.shred', `${base} outside the worktree is not allowed`);
      }
    } else if (base.startsWith('mkfs') || base === 'wipefs' || base === 'blkdiscard') {
      return block('destructive.device', `${base} writes to a device and is not allowed`);
    } else if (base === 'dd' && cmd.argv.some((word) => word.text.startsWith('of=/dev/'))) {
      return block('destructive.device', 'dd to a device is not allowed');
    } else if (['fdisk', 'sfdisk', 'parted'].includes(base) && !cmd.argv.some((word) => ['-l', '--list', 'print'].includes(word.text))) {
      return block('destructive.device', `${base} can write a partition table and is not allowed`);
    } else if ((base === 'chmod' || base === 'chown' || base === 'chgrp') && (hasShort(cmd.argv, 'R') || hasLong(cmd.argv, ['--recursive']))) {
      for (const word of positionals(cmd.argv, 1)) {
        const text = word.text.replace(/\/+$/, '') || '/';
        if (SYSTEM_DIRS.has(text) || /^(?:\$HOME|\$\{HOME\}|~)$/.test(text)) return block('destructive.device', `recursive ${base} of ${text} is not allowed`);
      }
    }

    for (const redirect of cmd.redirects) {
      if (redirect.target && /^\/dev\/(?:sd|nvme|vd|mmcblk)/.test(redirect.target.text) && redirect.op.includes('>')) {
        return block('destructive.device', 'writing to a block device is not allowed');
      }
    }
  }

  for (const scan of ctx.scans) {
    const text = normalizedText(scan.text);
    if (/reset(?: \S+){0,3} --hard/.test(text) || statements(scan.text).some((s) => /push(?: \S+){0,6} (?:--force\S*|--mirror|--delete|-[a-z]*f[a-z]*)(?: |$)/.test(s)) || /rm -[a-z]*r[a-z]* [/~]/.test(text) || /mkfs/.test(text) || /of=\/dev\//.test(text)) {
      return block('destructive.text-scan', 'the guard cannot see the arguments of this command; write it plainly with literal paths');
    }
  }
  return null;
}
