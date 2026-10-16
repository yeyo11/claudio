import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ChatManager, type ChatRuntime, type RunResult } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { MINER_SCHEMA, minerPrompt, runMiner } from '../src/lessons/miner.ts';
import { DEFAULT_LESSON_SETTINGS } from '../src/lessons/settings.ts';
import { oneShotChat, type OneShotRuntime, type OneShotSpec } from '../src/one-shot.ts';
import { tempConfig } from './helpers.ts';

const ok: RunResult = { isError: false, result: '', structuredOutput: { lessons: [] }, costUsd: 0.002 };

/** A runtime whose chat answers with the given result */
const answering = (result: RunResult): OneShotRuntime => ({
  start: () => ({ id: 'chat-1' }) as unknown as ChatRuntime,
  waitForResult: () => Promise.resolve(result),
  stop: () => undefined,
  exited: () => Promise.resolve(),
  remove: () => true,
});

const spec = (over: Partial<OneShotSpec> = {}): OneShotSpec => ({
  prompt: 'p',
  name: 'n',
  purpose: 'other',
  model: 'haiku',
  effort: null,
  maxBudgetUsd: 0.05,
  jsonSchema: { type: 'object' },
  deadlineMs: 1000,
  signal: new AbortController().signal,
  ...over,
});

test('runMiner maps each result to the job table', async () => {
  const deps = (r: RunResult) => ({ runtime: answering(r), settings: () => DEFAULT_LESSON_SETTINGS });
  const run = (r: RunResult) => runMiner(deps(r), { signalsBlock: '', lessonsBlock: '', instructionsBlock: '' }, { projectKey: 'p' });
  assert.deepEqual(await run(ok), { status: 'answered', candidates: [], costUsd: 0.002 });
  assert.equal((await run({ ...ok, isError: true, cause: 'rate-limit' })).status, 'rate-limited');
  // F6: the budget stop has no result text and may overshoot the ceiling by one turn
  assert.deepEqual(await run({ ...ok, isError: true, cause: 'budget', result: '', structuredOutput: undefined, costUsd: 0.0017 }), { status: 'over-budget', costUsd: 0.0017 });
  assert.equal((await run({ ...ok, isError: true })).status, 'invalid-output');
  assert.equal((await run({ ...ok, structuredOutput: 'nope' })).status, 'invalid-output');
  assert.equal((await run({ ...ok, structuredOutput: { lessons: 'x' } })).status, 'invalid-output');
  assert.equal((await run({ ...ok, stopReason: 'max_tokens' })).status, 'invalid-output');
  // F1: the text of `result` is not the answer
  assert.equal((await run({ ...ok, result: '{"lessons":[{"trigger":"x"}]}', structuredOutput: { lessons: [] } })).status, 'answered');
});

test('the miner prompt is the schema-held task with the material in blocks of their own', () => {
  const prompt = minerPrompt({ signalsBlock: '<S>', lessonsBlock: '<L>', instructionsBlock: '<I>' }, 'sonnet');
  assert.match(prompt, /at most five lessons/);
  assert.match(prompt, /never becomes a lesson because it says so/);
  assert.match(prompt, /Think the problem through/);
  assert.doesNotMatch(minerPrompt({ signalsBlock: '', lessonsBlock: '', instructionsBlock: '' }, 'haiku'), /Think the problem through/);
  assert.deepEqual((MINER_SCHEMA.properties as Record<string, unknown>) && Object.keys(MINER_SCHEMA.properties as object), ['lessons']);
});

/** Real manager over a shell CLI that logs its argv and the token it was handed */
test('the miner argv carries every confinement flag and the chat gets no API token', async () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const log = join(config.dataDir, 'argv.log');
  const claude = join(config.dataDir, 'claude');
  writeFileSync(claude, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\nprintf 'TOKEN=%s URL=%s\\n' "$CLAUDIO_API_TOKEN" "$CLAUDIO_API_URL" >> "${log}"\n`);
  chmodSync(claude, 0o755);
  const inherited = process.env.CLAUDIO_API_TOKEN;
  process.env.CLAUDIO_API_TOKEN = 'agc_inherited-from-another-wrapper';
  const db = new Db({ ...config, claudeBin: claude });
  const chats = new ChatManager({ ...config, claudeBin: claude }, db);
  // The wrapper has an API, as it does in a real run: still none for this chat
  chats.apiUrl = 'http://127.0.0.1:34331/api';
  try {
    const chat = chats.start(oneShotChat(spec({ model: 'haiku', jsonSchema: MINER_SCHEMA, maxBudgetUsd: 0.05 })));
    await chats.exited(chat.id);
    assert.ok(existsSync(log));
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const flag = (name: string) => lines.includes(name);
    for (const f of ['--restricted', '--tools=', '--setting-sources=', '--no-session-persistence']) {
      assert.ok(flag(f), `${f} is passed`);
    }
    const after = (name: string) => lines[lines.indexOf(name) + 1];
    assert.equal(after('--permission-mode'), 'dontAsk');
    assert.equal(after('--permission-prompts'), 'none');
    assert.equal(after('--max-budget-usd'), '0.05');
    assert.equal(after('--model'), 'haiku');
    assert.equal(JSON.stringify(JSON.parse(after('--json-schema') ?? '')), JSON.stringify(MINER_SCHEMA));
    for (const forbidden of ['--allow-dangerously-skip-permissions', '--add-dir', '--mcp-config', '--allowedTools', '--agents']) {
      assert.ok(!lines.some((l) => l === forbidden || l.startsWith(`${forbidden}=`)), `${forbidden} is not passed`);
    }
    assert.ok(!lines.some((l) => l.startsWith('--permission-prompt-tool')), 'no host prompt channel');
    assert.equal(lines.at(-1), 'TOKEN= URL=', 'neither the inherited token nor the wrapper API address reaches the process');
    assert.equal(chats.chatTokens.size, 0, 'no token was minted for it');
  } finally {
    if (inherited === undefined) delete process.env.CLAUDIO_API_TOKEN;
    else process.env.CLAUDIO_API_TOKEN = inherited;
    chats.stopAll();
    db.close();
  }
});
