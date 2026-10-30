import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionSettings } from '@claudio/shared';
import { decisionRoute } from '../src/decisions/providers/cli.ts';

/*
 * Whether every account is out is the account view's to say (`AccountView.atLimit`, covered by
 * account-view.test.ts with the readings that make it so): the route only acts on it.
 */

const cli = { model: 'sonnet', effort: 'medium', maxCostUsd: 0.5 } as DecisionSettings['cli'];

test('a decision runs on Claude while an account can take it', () => {
  assert.deepEqual(decisionRoute(cli, false), { provider: 'claude-code', model: 'sonnet', effort: 'medium' });
});

test('a decision is rate-limited when every ready account is at its limit', () => {
  assert.deepEqual(decisionRoute(cli, true), { unavailable: 'rate-limited' });
});
