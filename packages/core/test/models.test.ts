import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ModelOption } from '@claudio/shared';
import { Core } from '../src/index.ts';
import { modelNames, modelOptions } from '../src/providers/claude-code/models.ts';
import { tempConfig } from './helpers.ts';

// The CLI's `initialize` list is the only model list: what `/model` shows, in its order, with its
// names. Before it has been read there is no list at all, never one of Claudio's own guesses.

const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');

/** Names the CLI never lists in the fake, which the old fallback (aliases, `.claude.json`) offered. */
const GUESSES = ['fable', 'Fable 5.1', 'Opus 5.5', 'Haiku 5.5'];

async function until<T>(read: () => T | null | undefined | false | Promise<T | null | undefined | false>, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const listed: ModelOption[] = [
  { value: 'default', resolvedModel: 'claude-haiku-5-5', label: 'Default (recommended)', description: 'Haiku 5.5' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', label: 'Sonnet', description: 'Sonnet 5.5' },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', label: 'Haiku', description: 'Haiku 5.5' },
];

test('with no list read yet there are no options, never guessed ones', () => {
  assert.deepEqual(modelOptions(null), []);
  assert.deepEqual(modelOptions([]), []);
});

test("the CLI's list is the answer as given: its order, its names, and `default` beside `haiku`", () => {
  const options = modelOptions(listed);
  assert.deepEqual(options, listed);
  assert.notEqual(options, listed, 'a copy, so a caller cannot change the cache');
});

test('an alias and the id it resolves to name the same model', () => {
  assert.deepEqual(modelNames(listed, 'sonnet').sort(), ['claude-sonnet-5-5', 'sonnet']);
  assert.deepEqual(modelNames(listed, 'claude-sonnet-5-5').sort(), ['claude-sonnet-5-5', 'sonnet']);
  // Two options resolve to the same id: either is a name of it
  assert.deepEqual(modelNames(listed, 'claude-haiku-5-5').sort(), ['claude-haiku-5-5', 'default', 'haiku']);
  assert.deepEqual(modelNames(null, 'opus'), ['opus']);
});

test('the server reads the list at boot with no account action, and again when the CLI version changes', async () => {
  const saved = { version: process.env.FAKE_CLAUDE_VERSION, models: process.env.FAKE_CLAUDE_INIT_MODELS };
  process.env.FAKE_CLAUDE_VERSION = '2.1.0 (Claude Code)';
  delete process.env.FAKE_CLAUDE_INIT_MODELS;
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  try {
    // Whatever moment the overview is read at, it holds the CLI's list or nothing
    const early = core.runtime.providers.driverFor('claude-code')?.models() ?? [];
    assert.ok(early.length === 0 || early.every((m) => ['sonnet', 'opus', 'haiku'].includes(m.value)), `no guess while loading (got ${early.map((m) => m.value).join(',')})`);
    for (const guess of GUESSES) assert.ok(!early.some((m) => m.value === guess || m.label === guess), guess);

    const first = await until(() => core.accounts.cachedModels('default'), 'the boot read of the default account');
    assert.deepEqual(first.map((m) => m.value), ['sonnet', 'opus', 'haiku']);
    assert.deepEqual((await core.system()).models.map((m) => m.value), ['sonnet', 'opus', 'haiku']);

    // The CLI is updated under the server, and its `/model` now lists something else
    await core.system(true);
    process.env.FAKE_CLAUDE_VERSION = '2.2.0 (Claude Code)';
    process.env.FAKE_CLAUDE_INIT_MODELS = JSON.stringify([
      { value: 'default', resolvedModel: 'claude-haiku-5-5', displayName: 'Default (recommended)', description: 'Haiku 5.5' },
      { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'Haiku 5.5' },
    ]);
    await core.system(true);
    const next = await until(() => {
      const models = core.accounts.cachedModels('default');
      return models?.some((m) => m.value === 'default') && models;
    }, 'the list read again under the new CLI');
    assert.deepEqual(next.map((m) => m.value), ['default', 'haiku'], 'both survive, in the CLI order');
    assert.deepEqual(next.map((m) => m.label), ['Default (recommended)', 'Haiku']);
  } finally {
    if (saved.version === undefined) delete process.env.FAKE_CLAUDE_VERSION;
    else process.env.FAKE_CLAUDE_VERSION = saved.version;
    if (saved.models === undefined) delete process.env.FAKE_CLAUDE_INIT_MODELS;
    else process.env.FAKE_CLAUDE_INIT_MODELS = saved.models;
    core.shutdown();
  }
});
