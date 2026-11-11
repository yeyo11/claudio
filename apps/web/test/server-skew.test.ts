// A hub driving a remote on a newer Claudio (docs/servers.md, "A remote on a newer Claudio"): the
// page is the hub's own build, so the notice names the remote's version and this one's, and says
// nothing on this server's own pages or when either version is unknown.
import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteAhead } from '../src/components/ServerSkew.tsx';

test("a remote on a newer Claudio than this page's build is named", () => {
  assert.equal(remoteAhead(true, '0.16.0', '0.15.0'), '0.16.0');
});

test('the same, an older remote, or this server\'s own pages say nothing', () => {
  assert.equal(remoteAhead(true, '0.16.0', '0.16.0'), null);
  // An older remote is the scope gate's (its routes may not fit), never a notice to update this one
  assert.equal(remoteAhead(true, '0.15.0', '0.16.0'), null);
  assert.equal(remoteAhead(false, '0.17.0', '0.16.0'), null);
});

test('a version nobody knows is no skew', () => {
  assert.equal(remoteAhead(true, undefined, '0.15.0'), null);
  assert.equal(remoteAhead(true, '0.16.0', ''), null, 'the unit tests and pnpm dev run unbuilt');
});
