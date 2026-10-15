import assert from 'node:assert/strict';
import test from 'node:test';
import type { AccountLimit, DecisionSettings } from '@claudio/shared';
import { decisionRoute } from '../src/decisions/providers/cli.ts';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const cli = { model: 'sonnet', effort: 'medium', maxCostUsd: 0.5 } as DecisionSettings['cli'];

const limit = (state: AccountLimit['state'], resetsAt: string | null): AccountLimit => ({
  state,
  window: 'five_hour',
  utilization: state === 'exhausted' ? 1 : 0.2,
  resetsAt,
  windows: {},
  observedAt: new Date(NOW - 60_000).toISOString(),
  source: 'stream',
});
const account = (limits: AccountLimit | null, extra: { enabled?: boolean; signedIn?: boolean } = {}) => ({ enabled: true, signedIn: true, limits, ...extra });
const AHEAD = new Date(NOW + 3_600_000).toISOString();
const PAST = new Date(NOW - 3_600_000).toISOString();

test('a decision runs on Claude while another account has room, though one account is at its limit', () => {
  const route = decisionRoute(cli, [account(limit('exhausted', AHEAD)), account(limit('ok', AHEAD))], NOW);
  assert.deepEqual(route, { provider: 'claude-code', model: 'sonnet', effort: 'medium' });
});

test('a decision is rate-limited when every ready account is at its limit', () => {
  assert.deepEqual(decisionRoute(cli, [account(limit('exhausted', AHEAD)), account(limit('exhausted', null))], NOW), { unavailable: 'rate-limited' });
});

test('a disabled or signed-out account with room does not keep the decision running', () => {
  const route = decisionRoute(cli, [account(limit('exhausted', AHEAD)), account(null, { enabled: false }), account(null, { signedIn: false })], NOW);
  assert.deepEqual(route, { unavailable: 'rate-limited' });
});

test('an account whose limit reset in the past can take the decision again', () => {
  assert.equal('unavailable' in decisionRoute(cli, [account(limit('exhausted', PAST))], NOW), false);
});

test('no ready account is not reported as a limit', () => {
  assert.equal('unavailable' in decisionRoute(cli, [account(null, { signedIn: false })], NOW), false);
});
