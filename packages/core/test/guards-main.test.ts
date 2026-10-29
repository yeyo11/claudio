import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { GuardRulesFile } from '../src/guards/input.ts';
import { type CorpusEnv, makeCorpusEnv } from './guards-corpus.ts';

const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '../src/guards/main.ts');
const NODE_ARGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Options {
  event?: string;
  rulesPath?: string;
  sha?: string;
  /** Written to stdin; `null` leaves stdin open */
  stdin?: string | Buffer | null;
  cleanEnv?: boolean;
  env?: NodeJS.ProcessEnv;
}

function runGuard(options: Options): Promise<Run> {
  const args = [...NODE_ARGS, ENTRY, '--rules', options.rulesPath ?? '', '--sha256', options.sha ?? '', '--event', options.event ?? 'pre-tool-use'];
  const [command, argv] = options.cleanEnv
    ? ['/usr/bin/env', ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8', process.execPath, ...args]]
    : [process.execPath, args];
  return new Promise((done, fail) => {
    const child = spawn(command as string, argv as string[], { env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    if (options.stdin === null) return;
    child.stdin.end(options.stdin ?? '');
  });
}

describe('guard program', () => {
  let env: CorpusEnv;
  let seq = 0;
  before(() => {
    env = makeCorpusEnv();
  });
  after(() => rmSync(env.base, { recursive: true, force: true }));

  /** Writes a rules file and returns the arguments that name it */
  function rulesFile(rules: GuardRulesFile | string): { rulesPath: string; sha: string } {
    const path = join(env.dataDir, 'guards', `r${seq++}.rules.json`);
    const text = typeof rules === 'string' ? rules : JSON.stringify(rules);
    writeFileSync(path, text);
    return { rulesPath: path, sha: createHash('sha256').update(text).digest('hex') };
  }

  const hook = (tool: string, toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, tool_use_id: 'toolu_01', session_id: 'sess-1', cwd: env.worktree, ...extra });

  it('passes: exit 0, empty stdout, a pass marker', async () => {
    const run = await runGuard({ ...rulesFile(env.rules()), stdin: hook('Bash', { command: 'ls -la' }) });
    assert.deepEqual([run.code, run.stdout, run.stderr], [0, '', 'claudio-guard/1 pass toolu_01\n']);
  });

  it('blocks: exit 2, the reason line, then the block marker', async () => {
    const run = await runGuard({ ...rulesFile(env.rules()), stdin: hook('Bash', { command: 'git push origin main' }) });
    assert.equal(run.code, 2);
    assert.equal(run.stdout, '');
    const [first, second, rest] = run.stderr.split('\n');
    assert.match(first ?? '', /^Claudio guard blocked this \(push\): .+/);
    assert.match(second ?? '', /^claudio-guard\/1 block toolu_01 push push\.\S+$/);
    assert.equal(rest, '');
  });

  it('never prints the matched secret or more than 120 characters of the command', async () => {
    const secret = `sk-ant-api03-${'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC2dE4fG'}`;
    const run = await runGuard({ ...rulesFile(env.rules()), stdin: hook('Write', { file_path: join(env.worktree, 'a.txt'), content: `key ${secret}` }) });
    assert.equal(run.code, 2);
    assert.ok(!run.stderr.includes(secret));
    const long = await runGuard({ ...rulesFile(env.rules()), stdin: hook('Bash', { command: `git push ${'origin '.repeat(60)}` }) });
    assert.equal(long.code, 2);
    assert.ok(!long.stderr.includes('origin '.repeat(30)));
  });

  it('observe mode: would-block passes with an observe marker', async () => {
    const run = await runGuard({ ...rulesFile({ ...env.rules(), mode: 'observe' }), stdin: hook('Bash', { command: 'git push' }) });
    assert.equal(run.code, 0);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^claudio-guard\/1 observe toolu_01 push push\.\S+\n$/);
  });

  it('declared-tools blocks in observe mode too, and takes no "Allow once"', async () => {
    const allowDir = join(env.dataDir, 'allow-declared');
    mkdirSync(allowDir, { recursive: true });
    const rules = { ...env.declared(['Bash(cat *)']), mode: 'observe' as const, allowDir };
    const run = await runGuard({ ...rulesFile(rules), stdin: hook('Bash', { command: 'cat /data/auth.json' }, { cwd: env.workspace }) });
    assert.equal(run.code, 2);
    assert.match(run.stderr, /^Claudio guard blocked this \(declared-tools\): `cat \/data\/auth\.json`: \/data\/auth\.json is outside/);
    assert.match(run.stderr, /\nclaudio-guard\/1 block toolu_01 declared-tools declared-tools\.path\n$/);
    const passes = await runGuard({ ...rulesFile(rules), stdin: hook('Bash', { command: 'cat README.md' }, { cwd: env.workspace }) });
    assert.equal(passes.code, 0);
  });

  it('a tampered declared policy blocks every call', async () => {
    const rules = { ...env.declared(['Bash(cat *)']), declared: { tools: 'Bash(*)', root: '/' } };
    const run = await runGuard({ ...rulesFile(JSON.stringify(rules)), stdin: hook('Bash', { command: 'ls' }, { cwd: env.workspace }) });
    assert.equal(run.code, 2);
    assert.match(run.stderr, /integrity\.rules-unavailable/);
  });

  it('session-start: armed marker with the session id, the rules hash prefix and the rule ids', async () => {
    const file = rulesFile(env.rules());
    const run = await runGuard({ ...file, event: 'session-start', stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'sess-9' }) });
    assert.deepEqual([run.code, run.stdout], [0, '']);
    assert.equal(run.stderr, `claudio-guard/1 armed sess-9 ${file.sha.slice(0, 16)} ${env.rules().rules.join(',')}\n`);
  });

  it('a missing tool_use_id prints a dash, and an unsafe one too', async () => {
    const file = rulesFile(env.rules());
    const none = await runGuard({ ...file, stdin: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }) });
    assert.equal(none.stderr, 'claudio-guard/1 pass -\n');
    const unsafe = await runGuard({ ...file, stdin: hook('Bash', { command: 'ls' }, { tool_use_id: 'a b\nc' }) });
    assert.equal(unsafe.stderr, 'claudio-guard/1 pass -\n');
  });

  describe('fails closed with rule integrity', () => {
    const expectBlock = (run: Run, matcher: string, reason: RegExp): void => {
      assert.equal(run.code, 2);
      assert.equal(run.stdout, '');
      const lines = run.stderr.trimEnd().split('\n');
      assert.match(lines[0] ?? '', reason);
      assert.match(lines[0] ?? '', /^Claudio guard blocked this \(integrity\): /);
      assert.match(lines[1] ?? '', new RegExp(`^claudio-guard/1 block \\S+ integrity ${matcher.replace('.', '\\.')}$`));
    };

    it('a rules-file hash mismatch blocks every call, and session-start too', async () => {
      const file = rulesFile(env.rules());
      const wrong = { ...file, sha: '0'.repeat(64) };
      expectBlock(await runGuard({ ...wrong, stdin: hook('Bash', { command: 'ls' }) }), 'integrity.rules-unavailable', /rules-unavailable/);
      expectBlock(await runGuard({ ...wrong, event: 'session-start', stdin: '{}' }), 'integrity.rules-unavailable', /rules-unavailable/);
    });

    it('a rules file that was rewritten after the hash was taken blocks', async () => {
      const file = rulesFile(env.rules());
      writeFileSync(file.rulesPath, JSON.stringify({ ...env.rules(), rules: ['integrity'] }));
      expectBlock(await runGuard({ ...file, stdin: hook('Bash', { command: 'git push' }) }), 'integrity.rules-unavailable', /rules-unavailable/);
    });

    it('a missing file, invalid JSON, an unknown version and a missing argument block', async () => {
      const missing = { rulesPath: join(env.dataDir, 'guards', 'gone.rules.json'), sha: '0'.repeat(64) };
      expectBlock(await runGuard({ ...missing, stdin: hook('Bash', { command: 'ls' }) }), 'integrity.rules-unavailable', /rules-unavailable/);
      expectBlock(await runGuard({ ...rulesFile('{not json'), stdin: hook('Bash', { command: 'ls' }) }), 'integrity.rules-unavailable', /rules-unavailable/);
      expectBlock(await runGuard({ ...rulesFile({ ...env.rules(), version: 2 } as unknown as GuardRulesFile), stdin: hook('Bash', { command: 'ls' }) }), 'integrity.rules-unavailable', /rules-unavailable/);
      expectBlock(await runGuard({ stdin: hook('Bash', { command: 'ls' }) }), 'integrity.rules-unavailable', /rules-unavailable/);
    });

    it('bad input blocks: not JSON, no tool name, tool_input not an object, a wrong event flag', async () => {
      const file = rulesFile(env.rules());
      for (const stdin of ['', 'nope', '[]', '{"hook_event_name":"PreToolUse","tool_input":{}}', '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":"ls"}']) {
        expectBlock(await runGuard({ ...file, stdin }), 'integrity.bad-input', /bad-input/);
      }
      expectBlock(await runGuard({ ...file, event: 'post-tool-use', stdin: hook('Bash', { command: 'ls' }) }), 'integrity.bad-input', /bad-input/);
    });

    it('one byte over maxInputBytes blocks, and the limit itself does not', async () => {
      const rules = env.rules();
      rules.limits.maxInputBytes = 4096;
      const file = rulesFile(rules);
      const base = hook('Bash', { command: 'ls', pad: '' });
      const pad = (size: number): string => hook('Bash', { command: 'ls', pad: 'x'.repeat(size - base.length) });
      assert.equal(Buffer.byteLength(pad(4096)), 4096);
      const exact = await runGuard({ ...file, stdin: pad(4096) });
      assert.equal(exact.code, 0, exact.stderr);
      expectBlock(await runGuard({ ...file, stdin: pad(4097) }), 'integrity.input-too-large', /input-too-large/);
    });

    it('an exception inside the decision gives exit 2 with the error class only', async () => {
      const rules = { ...env.rules(), claudeConfigDirs: 5 } as unknown as GuardRulesFile;
      const run = await runGuard({ ...rulesFile(rules), stdin: hook('Bash', { command: 'rm -rf build' }) });
      expectBlock(run, 'integrity.guard-error', /guard-error: TypeError/);
      assert.match(run.stderr, /toolu_01 integrity/);
    });

    it('the deadline gives exit 2 when stdin never ends', async () => {
      const rules = env.rules();
      rules.limits.deadlineMs = 300;
      const started = Date.now();
      const run = await runGuard({ ...rulesFile(rules), stdin: null });
      expectBlock(run, 'integrity.deadline', /deadline/);
      assert.ok(Date.now() - started < 2500);
    });
  });

  describe('allow once', () => {
    it('consumes one valid allowance, once, and never for integrity', async () => {
      const allowDir = join(env.dataDir, 'guards', 'allow');
      mkdirSync(allowDir, { recursive: true });
      const file = rulesFile({ ...env.rules(), allowDir });
      const toolInput = { command: 'git push origin main' };
      const hash = createHash('sha256').update(`{"input":{"command":"git push origin main"},"tool":"Bash"}`).digest('hex').slice(0, 32);
      const path = join(allowDir, `sess-1.push.${hash}.json`);
      writeFileSync(path, JSON.stringify({ expiresAt: Date.now() + 60_000 }));
      const first = await runGuard({ ...file, stdin: hook('Bash', toolInput) });
      assert.equal(first.code, 0);
      assert.match(first.stderr, /^claudio-guard\/1 allowed-once toolu_01 push push\.\S+\n$/);
      assert.equal((await runGuard({ ...file, stdin: hook('Bash', toolInput) })).code, 2);

      writeFileSync(path, JSON.stringify({ expiresAt: Date.now() - 1 }));
      assert.equal((await runGuard({ ...file, stdin: hook('Bash', toolInput) })).code, 2);

      const integrityHash = createHash('sha256').update(`{"input":{"command":"git config alias.p push"},"tool":"Bash"}`).digest('hex').slice(0, 32);
      writeFileSync(join(allowDir, `sess-1.integrity.${integrityHash}.json`), JSON.stringify({ expiresAt: Date.now() + 60_000 }));
      assert.equal((await runGuard({ ...file, stdin: hook('Bash', { command: 'git config alias.p push' }) })).code, 2);
    });
  });

  describe('under env -i', () => {
    it('NODE_OPTIONS in the parent environment has no effect', async () => {
      const file = rulesFile(env.rules());
      const parent = { ...process.env, NODE_OPTIONS: `--require ${join(env.base, 'does-not-exist.cjs')}` };
      const stdin = hook('Bash', { command: 'ls' });
      // The control: without env -i the bad option stops Node before the guard runs
      const bare = await runGuard({ ...file, stdin, env: parent });
      assert.notEqual(bare.code, 0);
      assert.ok(!bare.stderr.includes('claudio-guard/1'));
      const clean = await runGuard({ ...file, stdin, env: parent, cleanEnv: true });
      assert.deepEqual([clean.code, clean.stderr], [0, 'claudio-guard/1 pass toolu_01\n']);
    });
  });
});
