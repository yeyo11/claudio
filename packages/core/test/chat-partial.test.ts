import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunEvent } from '@agentry/shared';
import { LiveChat } from '../src/live-chat.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { tempConfig } from './helpers.ts';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the first partial of a block goes out at once, the rest at most one per throttle, ending on the latest text', async () => {
  const config = tempConfig();
  try {
    const at = '2026-10-08T12:00:00.000Z';
    const chat = LiveChat.restore(
      {
        record: {
          id: 'c1', name: 'c1', cwd: config.workspaceDir, workingDir: null, origin: 'agentry', orchestrationId: null,
          orchestrationTaskId: null, derivedFrom: null, prompt: 'first', lastText: null, model: null,
          permissionMode: 'manual', permissionPrompts: 'none', createdAt: at, updatedAt: at,
        },
        executions: [],
      },
      config,
      new ClaudeCodeDriver('claude'),
    );
    const seen: string[] = [];
    chat.emitter.on('event', (e: RunEvent) => {
      if (e.kind === 'partial') seen.push(e.text ?? '');
    });
    chat.partial = { block: 'text', text: 'He' };
    chat.emitPartial();
    assert.deepEqual(seen, ['He'], 'emitted synchronously');
    chat.partial = { block: 'text', text: 'Hell' };
    chat.emitPartial();
    chat.partial = { block: 'text', text: 'Hello' };
    chat.emitPartial();
    assert.deepEqual(seen, ['He'], 'inside the throttle nothing more goes out yet');
    await pause(120);
    assert.deepEqual(seen, ['He', 'Hello'], 'the trailing one carries the latest text');
  } finally {
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  }
});
