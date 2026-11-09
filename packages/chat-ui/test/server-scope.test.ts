import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { setActiveServer } from '@claudio/ui/lib/server-scope';
import { draftKey } from '../src/composer/drafts';
import { readDismissed, writeDismissed } from '../src/composer/queued';

afterEach(() => setActiveServer(null));

test('a draft is kept per server: the hub’s keys are as they were, a remote’s end with its id', () => {
  assert.equal(draftKey('c1', 'main'), 'claudio-composer-draft:c1:main');
  setActiveServer('srv_1');
  assert.equal(draftKey('c1', 'main'), 'claudio-composer-draft:c1:main:srv_1');
});

test('dismissed cards of a chat id on two servers do not meet', () => {
  const data = new Map<string, string>();
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  writeDismissed('c1', new Set(['card']), store);
  setActiveServer('srv_1');
  assert.equal(readDismissed('c1', store).size, 0);
  writeDismissed('c1', new Set(['other']), store);
  assert.deepEqual([...data.keys()].sort(), ['claudio.queued.dismissed.c1', 'claudio.queued.dismissed.c1:srv_1']);
});
