import assert from 'node:assert/strict';
import test from 'node:test';
import { teammateRead } from '../src/lib/teammate-reads';

// A tool row of Claudio's teammate-read tools names whose share went into the chat
// (docs/plans/collaborators-agent-access.md): the install from `owner`, the share from `shareId`.

test('a per-copy read names the install and the share', () => {
  assert.deepEqual(teammateRead('mcp__claudio__collab_read_transcript', { owner: 'ana', shareId: 's1', chatId: 'c1' }), { kind: 'copy', owner: 'ana', shareId: 's1' });
  assert.deepEqual(teammateRead('mcp__claudio__collab_read_memory', { owner: 'ana' }), { kind: 'copy', owner: 'ana', shareId: null });
});

test('the list reads every share and names nobody', () => {
  assert.deepEqual(teammateRead('mcp__claudio__collab_list_shared', {}), { kind: 'list' });
});

test('any other tool, or a read that names no install, is no teammate read', () => {
  assert.equal(teammateRead('Bash', { owner: 'ana' }), null);
  assert.equal(teammateRead('mcp__other__collab_read_memory', { owner: 'ana' }), null);
  assert.equal(teammateRead('mcp__claudio__collab_read_board', { owner: '  ' }), null);
  assert.equal(teammateRead('mcp__claudio__collab_read_board', null), null);
  assert.equal(teammateRead(null, { owner: 'ana' }), null);
});
