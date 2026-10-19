import assert from 'node:assert/strict';
import test from 'node:test';
import { isServerVariable, withoutServerEnv } from '../src/server-env.ts';

test("CLAUDIO_* reaches a child only when it is on the allow-list, so a variable the server adds later is dropped too", () => {
  for (const name of ['CLAUDIO_DATA_DIR', 'CLAUDIO_WEB_DIST', 'CLAUDIO_WORKSPACE_DIR', 'CLAUDIO_MCP_ENTRY', 'CLAUDIO_GUARD_ENTRY', 'CLAUDIO_SOMETHING_NEW']) {
    assert.ok(isServerVariable(name), name);
  }
  for (const name of ['CLAUDIO_API_URL', 'CLAUDIO_API_TOKEN', 'CLAUDIO_CHAT_ID', 'CLAUDIO_FAKE_CLI_SCRIPTS', 'HOME', 'PATH', 'CLAUDIOX']) {
    assert.ok(!isServerVariable(name), name);
  }
});

test('where the server listens never reaches a child', () => {
  assert.deepEqual(withoutServerEnv({ PORT: '41985', HOST: '127.0.0.1', CLAUDIO_DATA_DIR: '/data', CLAUDIO_CHAT_ID: 'chat-1', LANG: 'C.UTF-8' }), {
    CLAUDIO_CHAT_ID: 'chat-1',
    LANG: 'C.UTF-8',
  });
});
