import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { rmSync } from 'node:fs';
import { decide } from '../src/guards/decide.ts';
import { CORPUS, type CorpusEnv, makeCorpusEnv } from './guards-corpus.ts';

describe('guards bypass corpus', () => {
  let env: CorpusEnv;
  before(() => {
    env = makeCorpusEnv();
  });
  after(() => rmSync(env.base, { recursive: true, force: true }));

  for (const row of CORPUS) {
    const label = `${row.expect === 'pass' ? 'passes' : `blocks (${row.expect})`}: ${row.tool} ${row.name.slice(0, 90).replace(/\n/g, '⏎')}${row.off ? ` [off: ${row.off.join(',')}]` : ''}`;
    it(label, row.knownBypass ? { todo: `known bypass (${row.severity}): docs/reports/guards-audit.md` } : {}, () => {
      const decision = decide(env.rules({ off: row.off, tmp: row.tmp }), {
        hook_event_name: 'PreToolUse',
        tool_name: row.tool,
        tool_input: row.input(env),
        cwd: env.worktree,
      });
      if (row.expect === 'pass') {
        assert.equal(decision.verdict, 'pass', `blocked by ${decision.rule}/${decision.matcher}: ${decision.reason}`);
        return;
      }
      assert.equal(decision.verdict, 'block', 'expected a block');
      assert.equal(decision.rule, row.expect, `matcher ${decision.matcher}: ${decision.reason}`);
      if (row.matcher) assert.ok(decision.matcher?.startsWith(row.matcher), `matcher ${decision.matcher} should start with ${row.matcher}`);
      assert.ok(decision.matcher?.startsWith(`${row.expect}.`), `matcher ${decision.matcher} names its rule`);
    });
  }

  it('lets every "must pass" row through with every rule on', () => {
    const rules = env.rules();
    for (const row of CORPUS.filter((r) => r.expect === 'pass' && !r.off)) {
      const decision = decide({ ...rules, tmpDir: row.tmp ? env.tmpDir : null }, { hook_event_name: 'PreToolUse', tool_name: row.tool, tool_input: row.input(env), cwd: env.worktree });
      assert.equal(decision.verdict, 'pass', `${row.name}: ${decision.rule}/${decision.matcher}`);
    }
  });

  it('never puts a secret in a reason', () => {
    const rules = env.rules();
    const decision = decide(rules, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: "git commit -m 'k=sk-ant-api03-Zq8W2e4R6t8Y1u3I5o7P9a1S3d5F7g9H1j3K5l7M' --no-verify" },
      cwd: env.worktree,
    });
    assert.equal(decision.verdict, 'block');
    assert.ok(!decision.reason?.includes('sk-ant-api03'));
  });
});
