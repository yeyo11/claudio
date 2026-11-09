import assert from 'node:assert/strict';
import test from 'node:test';
import { setActiveServer } from '@claudio/ui/lib/server-scope';

// The index is built when its module loads, and the scope is fixed for a page: this file pins a
// remote scope before the module is first imported, so it is the only one that sees that scope.
test('in a remote scope, search and the palette do not offer the hub’s own door', async () => {
  setActiveServer('srv_1');
  const { SETTINGS_INDEX } = await import('../src/pages/config/settingsIndex.ts');
  const sections = new Set(SETTINGS_INDEX.map((entry) => entry.section));
  assert.equal(sections.has('remote'), false);
  assert.equal(sections.has('access'), false);
  assert.equal(sections.has('servers'), false);
  // What describes the remote itself stays searchable
  assert.equal(sections.has('guards'), true);
  assert.equal(sections.has('hosts'), true);
  setActiveServer(null);
});
