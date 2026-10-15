import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { PROVIDER_MANIFESTS, ProviderRegistry } from '../src/providers/registry.ts';
import { tempConfig } from './helpers.ts';

test('the shipped manifests share no id and no command', () => {
  const ids = PROVIDER_MANIFESTS.map((m) => m.id);
  const commands = PROVIDER_MANIFESTS.flatMap((m) => m.commands.names);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(commands).size, commands.length);
  assert.doesNotThrow(() => new ProviderRegistry());
});

test('the registry lists Claude Code and finds it by id', () => {
  const registry = new ProviderRegistry();
  assert.deepEqual(registry.list().map((m) => m.id), ['claude-code']);
  assert.equal(registry.get('claude-code')?.commands.names[0], 'claude');
  assert.equal(registry.get('nope'), undefined);
});

test('the registry rejects a repeated id or command', () => {
  const [claude] = PROVIDER_MANIFESTS;
  assert.ok(claude);
  assert.throws(() => new ProviderRegistry([claude, { ...claude }]), /declared twice/);
  assert.throws(() => new ProviderRegistry([claude, { ...claude, id: 'other' }]), /claimed by both/);
});

test('Claude Code declares its capabilities and a tested range', () => {
  for (const manifest of PROVIDER_MANIFESTS) {
    assert.ok(manifest.capabilities.length > 0 && manifest.versions.range, manifest.id);
    assert.equal(manifest.transport, 'stream-json', manifest.id);
  }
});

test('driverFor finds the drivers the registry was given and nothing for a provider without one', () => {
  const driver = new ClaudeCodeDriver('claude');
  const registry = new ProviderRegistry(PROVIDER_MANIFESTS, [driver]);
  assert.equal(registry.driverFor('claude-code'), driver);
  assert.equal(registry.driverFor('other'), null);
  assert.equal(new ProviderRegistry().driverFor('claude-code'), null);
  const orphan = Object.assign(new ClaudeCodeDriver('claude'), { manifest: { ...driver.manifest, id: 'nope' } });
  assert.throws(() => new ProviderRegistry(PROVIDER_MANIFESTS, [orphan]), /has no manifest/);
});

test('the default session provider is Claude Code when it can run chats', () => {
  const registry = new ProviderRegistry(PROVIDER_MANIFESTS, [new ClaudeCodeDriver('claude')]);
  assert.equal(registry.defaultSessionProvider({ order: ['claude-code'], defaultProvider: null }), 'claude-code');
  assert.equal(registry.defaultSessionProvider({ order: ['claude-code'], defaultProvider: 'claude-code' }), 'claude-code');
  assert.equal(registry.defaultSessionProvider({ order: [], defaultProvider: null }), null);
});

test('a provider with a manifest and no driver cannot start a chat', () => {
  const config = tempConfig();
  const chats = new ChatManager(config, new Db(config), []);
  assert.throws(() => chats.start({ prompt: 'hi', provider: 'other' }), /cannot run chats yet/);
  assert.throws(() => chats.start({ prompt: 'hi' }), /cannot run chats yet/);
});
