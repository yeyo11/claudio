import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DeclaredToolsError, declaredToolsGuard, declaredToolsProblem, declaredToolsSection } from '../src/guards/declared.ts';
import type { GuardRulesFile } from '../src/guards/input.ts';
import { GuardLauncher } from '../src/guards/launch.ts';
import { GuardPreflight } from '../src/guards/preflight.ts';
import { matchesBashRule, rawExpands, readOnlySedScript } from '../src/guards/rules/declared-tools.ts';
import { GuardSettingsStore, parseRuleSwitches } from '../src/guards/settings.ts';
import { CLIENT_TOOL_PREFIX } from '../src/openai/client-tools.ts';

describe('declared-tools: Bash rule matching (Claude Code wildcard semantics)', () => {
  // The rows of https://code.claude.com/docs/en/permissions, "Wildcard patterns"
  const table: [string, string[], string[]][] = [
    ['npm run build', ['npm run build'], ['npm run build --watch']],
    ['npm run *', ['npm run build', 'npm run test --watch', 'npm run'], ['npm install']],
    ['git log * main', ['git log --oneline main', 'git log -5 main'], ['git log main', 'git push origin main']],
    ['git * main', ['git merge main', 'git push origin main'], ['git log']],
    ['* --version', ['node --version'], ['node -v']],
    ['ls *', ['ls -la', 'ls'], ['lsof']],
    ['ls*', ['ls -la', 'lsof'], []],
    ['* --help *', ['npm --help x'], ['npm --help']],
    ['ls:*', ['ls -la', 'ls'], ['lsof']],
    ['git:* push', [], ['git push']],
    ['sed -n *', ['sed -n 1p f', 'sed -n'], ['sed 1p f', 'sed -nE 1p f']],
  ];
  for (const [rule, yes, no] of table) {
    it(`Bash(${rule})`, () => {
      for (const command of yes) assert.equal(matchesBashRule(rule, command), true, `${rule} should match ${command}`);
      for (const command of no) assert.equal(matchesBashRule(rule, command), false, `${rule} should not match ${command}`);
    });
  }
});

describe('declared-tools: read-only sed scripts', () => {
  it('takes addresses, ranges, negation and p only', () => {
    for (const script of ['p', '1p', '1,20p', '$p', '/a/p', '/a/,/b/p', '\\,a,p', '0,/x/p', '1~2p', '3,+4p', '5,~4p', '1!p', '/a\\/b/Ip', '1p;5p', '1p\n2p', ' 1 , 2 p ', '']) {
      assert.equal(readOnlySedScript(script), true, JSON.stringify(script));
    }
  });
  it('refuses every other command', () => {
    for (const script of ['1w /tmp/x', '1W /tmp/x', '1r /etc/passwd', '1R x', '1e id', 's/a/b/', 's/a/b/w x', 's/a/b/e', '1d', '1q', 'y/a/b/', '1{p}', '/a', '1,p', '1p x', 'n']) {
      assert.equal(readOnlySedScript(script), false, JSON.stringify(script));
    }
  });
});

describe('declared-tools: expansions in the raw line', () => {
  it('finds variables and substitutions outside single quotes only', () => {
    for (const line of ['ls $HOME', 'cat "${X}"', 'cat $(x)', 'cat `x`', 'cat <(x)', 'echo $((1+2))', 'echo "$1"']) assert.equal(rawExpands(line), true, line);
    for (const line of ["grep 'a$' f", "sed -n '$p' f", 'echo \\$HOME', 'echo $', "awk '{print $1}' f", 'ls -la']) assert.equal(rawExpands(line), false, line);
  });
});

describe('declared-tools: the builder', () => {
  let dir: string;
  let cwd: string;
  let entry: string;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'guards-declared-')));
    cwd = join(dir, 'ws');
    mkdirSync(cwd);
    writeFileSync(join(dir, 'upload.txt'), 'x');
    // An installed guard: owner-writable only, under an install of its own (the checkout's mode depends on the umask)
    mkdirSync(join(dir, 'install', 'app', 'dist'), { recursive: true });
    entry = join(dir, 'install', 'app', 'dist', 'guard.mjs');
    writeFileSync(entry, '', { mode: 0o644 });
    chmodSync(entry, 0o644);
  });
  const launcherIn = (dataDir: string, settings = new GuardSettingsStore(dataDir)): GuardLauncher =>
    new GuardLauncher({ dataDir, settings, entry, capabilities: () => ['settingsFlag', 'hookEvents'], preflight: new GuardPreflight({ selfTest: async () => {} }) });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses a bare Bash, Bash(*) and what is not a rule', () => {
    for (const rule of ['Bash', 'Bash(*)', 'Bash(:*)', 'Bash()', ' Bash ( * ) ']) {
      const problem = declaredToolsProblem(['Read', rule]);
      assert.ok(problem instanceof DeclaredToolsError, rule);
      assert.equal(problem.code, 'bash-unrestricted');
      assert.throws(() => declaredToolsSection({ policy: { allowedTools: [rule], schema: false }, cwd, attachments: [] }), DeclaredToolsError);
    }
    assert.equal(declaredToolsProblem(['Bash(ls *)', 'Read', 'mcp__docs__*', 'WebFetch(domain:example.com)'])?.code ?? null, null);
    assert.equal(declaredToolsProblem([''])?.code, 'bad-rule');
  });

  it('fixes the policy: real paths, StructuredOutput and the client-tool stub always allowed', () => {
    const section = declaredToolsSection({ policy: { allowedTools: ['Read'], schema: true }, cwd: join(cwd, '.'), attachments: [join(dir, 'upload.txt'), join(dir, 'upload.txt')] });
    assert.deepEqual(section, { tools: ['Read'], alwaysAllow: ['StructuredOutput'], allowPrefixes: [CLIENT_TOOL_PREFIX], root: cwd, attachments: [join(dir, 'upload.txt')] });
  });

  it('arms integrity and declared-tools, enforcing, whatever the guard settings say', async () => {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir);
    const settings = new GuardSettingsStore(dataDir);
    // A person switched guards off for automated runs and set observe: neither reaches a confined chat
    await settings.update({ automated: false, mode: 'observe', rules: { 'no-verify': false, push: false, destructive: false, secrets: false } });
    const launcher = launcherIn(dataDir, settings);
    const plan = await declaredToolsGuard(launcher, { policy: { allowedTools: ['Bash(cat *)'], schema: true }, cwd, attachments: [join(dir, 'upload.txt')] });
    assert.deepEqual(plan.rules, ['integrity', 'declared-tools']);
    assert.equal(plan.mode, 'enforce');
    assert.equal(plan.interactive, undefined);
    const settingsFile = JSON.parse(readFileSync(plan.settingsPath, 'utf8')) as { permissions?: { blockReadsOutsideWorkingDirectories?: boolean }; hooks: { PreToolUse: [{ hooks: [{ command: string }] }] } };
    assert.equal(settingsFile.permissions?.blockReadsOutsideWorkingDirectories, true);
    const rulesPath = /--rules '([^']+)'/.exec(settingsFile.hooks.PreToolUse[0].hooks[0].command)?.[1] ?? '';
    const rules = JSON.parse(readFileSync(rulesPath, 'utf8')) as GuardRulesFile;
    assert.equal(rules.mode, 'enforce');
    assert.deepEqual(rules.rules, ['integrity', 'declared-tools']);
    assert.equal(rules.allowDir, null);
    assert.deepEqual(rules.declared?.tools, ['Bash(cat *)']);
    assert.equal(rules.declared?.root, cwd);
    assert.deepEqual(rules.declared?.attachments, [join(dir, 'upload.txt')]);
    if (plan.tmpDir) rmSync(plan.tmpDir, { recursive: true, force: true });
  });

  it('cannot be switched off through the guard settings', () => {
    assert.throws(() => parseRuleSwitches({ 'declared-tools': false }), /not a rule that can be switched/);
  });

  it('leaves the settings file of every other guarded run as it was', async () => {
    const dataDir = join(dir, 'data2');
    mkdirSync(dataDir);
    const launcher = launcherIn(dataDir);
    const plan = await launcher.prepare({ kind: 'worker', cwd });
    assert.ok(plan);
    assert.equal((JSON.parse(readFileSync(plan.settingsPath, 'utf8')) as { permissions?: unknown }).permissions, undefined);
    assert.ok(!plan.rules.includes('declared-tools'));
    if (plan.tmpDir) rmSync(plan.tmpDir, { recursive: true, force: true });
  });
});
