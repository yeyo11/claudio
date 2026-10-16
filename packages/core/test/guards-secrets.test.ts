import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { __testing } from '../src/decisions/redact.ts';
import { decide } from '../src/guards/decide.ts';
import { DEFAULT_LIMITS } from '../src/guards/input.ts';
import { SECRET_PATTERNS, findSecrets } from '../src/guards/secrets.ts';
import { ANTHROPIC, AWS, CHAT_TOKEN, GITHUB, GITLAB, SLACK } from './guards-corpus.ts';

describe('guard secret patterns', () => {
  it('matches every pattern and no near miss', () => {
    const positives: [string, string][] = [
      ['private-key', '-----BEGIN RSA PRIVATE KEY-----'], ['anthropic-key', ANTHROPIC], ['openai-like-key', 'sk-proj1234567890abcdefgh'],
      ['github-token', GITHUB], ['gitlab-token', GITLAB], ['slack-token', SLACK], ['aws-access-key', AWS],
      ['google-api-key', `AIza${'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC2dE4fG'}`], ['stripe-key', 'sk_live_aB3dE5gH7jK9mN1pQ3sT5vW7'],
      ['npm-token', `npm_${'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC2dE4fGh'}`], ['claudio-chat-token', CHAT_TOKEN],
    ];
    for (const [id, text] of positives) assert.ok(findSecrets(`x ${text} y`).some((m) => m.id === id), id);
    assert.deepEqual([...new Set(SECRET_PATTERNS.map((p) => p.id))].sort(), positives.map(([id]) => id).sort());
    for (const text of ['sk-learn-pipeline-stage-name', 'ghp_short', 'AKIA123', 'array.push(1)', 'npm_install_script']) assert.equal(findSecrets(text).length, 0, text);
  });
  it('lets placeholders through', () => {
    for (const text of ['AKIAIOSFODNN7EXAMPLE', 'ghp_xxxxxxxxxxxxxxxxxxxxxxxx', 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx', 'sk-ant-api03-your_key_goes_here_12345']) {
      assert.equal(findSecrets(text).length, 0, text);
    }
  });
  it('finds known secrets by hash, and escapes after decoding', () => {
    const value = 'MyVaultValue0123456789abcdefghij';
    const known = new Set([createHash('sha256').update(value).digest('hex')]);
    assert.equal(findSecrets(`a ${value} b`, known)[0]?.id, 'known-secret');
    assert.equal(findSecrets(`a ${value} b`).length, 0);
    assert.equal(findSecrets(ANTHROPIC.replace('s', '\\x73'))[0]?.id, 'anthropic-key');
  });
  it('is a superset of the masker for its high-confidence patterns', () => {
    const samples = [ANTHROPIC, 'sk-abc123def456ghi789jkl', GITHUB, SLACK, AWS, CHAT_TOKEN, '-----BEGIN PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----'];
    for (const sample of samples) {
      const maskerHit = __testing.SECRET_PATTERNS.some((p) => new RegExp(p.source, p.flags.replace('g', '')).test(sample));
      assert.ok(maskerHit, `masker should match ${sample.slice(0, 12)}`);
      assert.ok(findSecrets(sample).length > 0, `guard should match ${sample.slice(0, 12)}`);
    }
  });
  it('runs every pattern over 16 MiB of adversarial input in under 500 ms', () => {
    const size = 16 * 1024 * 1024;
    const inputs = [
      'a'.repeat(size), '-----BEGIN '.repeat(size / 11), 'sk-'.repeat(size / 3), 'sk-ant-api03-'.repeat(size / 13), 'ghp_'.repeat(size / 4),
      'AKIA'.repeat(size / 4), 'a-'.repeat(size / 2 - 1), 'xox'.repeat(size / 3), `${'A'.repeat(size - 1)}\n`,
    ];
    for (const text of inputs) {
      const started = performance.now();
      findSecrets(text);
      const took = performance.now() - started;
      assert.ok(took < 500, `${text.slice(0, 12)} took ${Math.round(took)} ms`);
    }
  });
  it('decides a 16 MiB write within the budget', () => {
    const started = performance.now();
    const decision = decide(
      { version: 1, mode: 'enforce', rules: ['integrity', 'secrets'], roots: ['/work'], mainCheckout: null, hooksPathDir: null, dataDir: '/d', guardDir: '/d/g', claudeConfigDirs: [], protectConfigs: [], knownSecretSha256: [], limits: { ...DEFAULT_LIMITS } },
      { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/work/a.txt', content: 'abc def '.repeat(2 * 1024 * 1024) }, cwd: '/work' },
    );
    assert.equal(decision.verdict, 'pass');
    assert.ok(performance.now() - started < 500);
  });
});

describe('guard engine imports', () => {
  it('imports nothing outside node: and guards/, and uses erasable syntax only', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src/guards');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name.endsWith('.ts')) files.push(join(dir, entry.name));
      }
    };
    walk(root);
    assert.ok(files.length >= 10);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^\s*(?:import|export)\b[^'"\n]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
        const spec = match[1] ?? match[2] ?? '';
        const ok = spec.startsWith('node:') || (spec.startsWith('.') && resolve(dirname(file), spec).startsWith(root));
        assert.ok(ok, `${file} imports ${spec}`);
      }
      assert.ok(!/^\s*(?:enum|namespace)\s/m.test(source) && !/constructor\([^)]*\b(?:public|private|protected|readonly)\s/.test(source), `${file} uses non-erasable syntax`);
    }
  });
});
