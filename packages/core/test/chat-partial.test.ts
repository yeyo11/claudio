import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunEvent } from '@claudio/shared';
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
          id: 'c1', name: 'c1', cwd: config.workspaceDir, workingDir: null, origin: 'claudio', orchestrationId: null,
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
      if (e.kind === 'partial') seen.push(e.text ?? `+${e.append}@${e.at}`);
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
    assert.deepEqual(seen, ['He', '+llo@2'], 'the trailing one carries what is new since the last, and where it starts');
    assert.equal(chat.partialSnapshot()?.text, 'Hello', 'a late subscriber is handed the whole text');
    // A new block starts again with its whole text
    chat.partial = { block: 'text', text: 'Yo' };
    chat.partialSent = null;
    await pause(120);
    chat.emitPartial();
    assert.deepEqual(seen, ['He', '+llo@2', 'Yo']);
    chat.partial = null;
    assert.equal(chat.partialSnapshot(), null);
  } finally {
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  }
});
