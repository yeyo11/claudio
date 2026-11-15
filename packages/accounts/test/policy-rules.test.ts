import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AccountStore, allowsAccount, reserveAccountOf } from '../src/index.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');

let root: string;
let defaultDir: string;
let dataDir: string;
const open = (): AccountStore => new AccountStore({ dataDir, defaultDir, claude: FAKE, env: { PATH: process.env.PATH } });

before(() => {
  root = mkdtempSync(join(tmpdir(), 'accounts-rules-'));
  defaultDir = join(root, 'default-claude');
  dataDir = join(root, 'data');
  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(join(defaultDir, 'settings.json'), '{}');
});
after(() => rmSync(root, { recursive: true, force: true }));

async function withAccounts(): Promise<{ s: AccountStore; a: string; b: string }> {
  const s = open();
  const a = await s.add({ kind: 'token', alias: `a-${s.list().length}`, secret: 'tok-a' });
  const b = await s.add({ kind: 'token', alias: `b-${s.list().length}`, secret: 'tok-b' });
  return { s, a: a.id, b: b.id };
}

describe('project rules in a policy', () => {
  it('a policy with none of the new fields stays exactly as it was stored', async () => {
    const { s, a } = await withAccounts();
    const p = await s.createPolicy({ projects: ['plain'], order: [a], threshold: 70 });
    assert.deepEqual(p, { id: p.id, threshold: 70, projects: ['plain'], order: [a] });
    assert.equal('preferred' in p || 'reserve' in p || 'strictConfig' in p, false);
  });

  it('keeps the preferred account, the reserve and strictConfig, and a second store reads them back', async () => {
    const { s, a, b } = await withAccounts();
    const p = await s.createPolicy({ projects: ['full'], order: [a, b], preferred: b, reserve: { percent: 20 }, strictConfig: true });
    assert.equal(p.preferred, b);
    assert.deepEqual(p.reserve, { percent: 20 });
    assert.equal(p.strictConfig, true);
    const read = open().policyFor('full');
    assert.deepEqual(read, p);
    // The listing is a copy: changing it never changes the stored rule
    const listed = s.policies().find((x) => x.id === p.id);
    assert.ok(listed?.reserve);
    listed.reserve.percent = 1;
    assert.equal(s.policyFor('full')?.reserve?.percent, 20);
  });

  it('a preferred account must be one of the order, or a known account when there is no order', async () => {
    const { s, a, b } = await withAccounts();
    await assert.rejects(s.createPolicy({ projects: ['pf1'], order: [a], preferred: b }), /preferred must be one of order/);
    await assert.rejects(s.createPolicy({ projects: ['pf2'], preferred: 'ghost' }), /preferred must be an account id/);
    const ok = await s.createPolicy({ projects: ['pf3'], preferred: b });
    assert.equal(ok.preferred, b);
  });

  it('a reserve is 1 to 30 points, and needs an account to sit on', async () => {
    const { s, a } = await withAccounts();
    for (const percent of [0, 31, -5, Number.NaN, Infinity]) {
      await assert.rejects(s.createPolicy({ projects: [`pc${percent}`], order: [a], reserve: { percent } }), /reserve percent must be between 1 and 30/);
    }
    await assert.rejects(s.createPolicy({ projects: ['pc-str'], order: [a], reserve: { percent: '10' as unknown as number } }), /reserve percent/);
    await assert.rejects(s.createPolicy({ projects: ['pc-none'], reserve: { percent: 10 } }), /a reserve needs a preferred account or an order/);
    assert.equal((await s.createPolicy({ projects: ['pc-edge1'], order: [a], reserve: { percent: 1 } })).reserve?.percent, 1);
  });

  it('only one rule reserves on an account, and a rule may change its own reserve', async () => {
    const { s, a, b } = await withAccounts();
    const first = await s.createPolicy({ projects: ['r1'], order: [a, b], reserve: { percent: 10 } });
    // `a` is the first of this one's order too
    await assert.rejects(s.createPolicy({ projects: ['r2'], order: [a], reserve: { percent: 5 } }), new RegExp(`account ${a} already has the reserve of policy ${first.id}`));
    // The preferred account is where a reserve sits, so this one is on `b`
    const second = await s.createPolicy({ projects: ['r2'], order: [a, b], preferred: b, reserve: { percent: 5 } });
    assert.equal(reserveAccountOf(second), b);
    assert.equal((await s.updatePolicy(first.id, { projects: ['r1'], order: [a, b], reserve: { percent: 25 } })).reserve?.percent, 25);
    // A rule without a reserve takes none of the account's
    await s.createPolicy({ projects: ['r3'], order: [a] });
  });

  it('strictConfig must be a boolean, and false is not stored', async () => {
    const { s, a } = await withAccounts();
    await assert.rejects(s.createPolicy({ projects: ['sc1'], order: [a], strictConfig: 'yes' as unknown as boolean }), /strictConfig must be a boolean/);
    const p = await s.createPolicy({ projects: ['sc2'], order: [a], strictConfig: false });
    assert.equal('strictConfig' in p, false);
  });

  it('removing an account takes it out of preferred, and drops a reserve with no account left to sit on', async () => {
    const { s, a, b } = await withAccounts();
    const p = await s.createPolicy({ projects: ['rm'], order: [a, b], preferred: b, reserve: { percent: 10 } });
    await s.remove(b);
    const after = s.policyFor('rm');
    assert.equal(after?.preferred, undefined);
    assert.deepEqual(after?.order, [a]);
    // The reserve sits on the first of the order now
    assert.deepEqual(after?.reserve, { percent: 10 });
    await s.remove(a);
    const empty = s.policyFor('rm');
    assert.equal(empty?.id, p.id);
    assert.equal(empty?.reserve, undefined);
  });

  it('reads a hand-edited file defensively: a bad preferred or reserve is dropped, not trusted', async () => {
    const { s, a } = await withAccounts();
    const p = await s.createPolicy({ projects: ['hand'], order: [a] });
    const { readFileSync } = await import('node:fs');
    const file = join(dataDir, 'accounts.json');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { policies: Record<string, unknown>[] };
    const mine = doc.policies.find((x) => x.id === p.id);
    assert.ok(mine);
    Object.assign(mine, { preferred: 7, reserve: { percent: 99 }, strictConfig: 'yes' });
    writeFileSync(file, JSON.stringify(doc));
    const read = open().policyFor('hand');
    assert.equal(read?.preferred, undefined);
    assert.equal(read?.reserve, undefined);
    assert.equal(read?.strictConfig, undefined);
  });

  it('allowsAccount: no rule allows every account, a rule allows what its order lists', () => {
    assert.equal(allowsAccount(null, 'x'), true);
    assert.equal(allowsAccount({}, 'x'), true);
    assert.equal(allowsAccount({ order: ['a'] }, 'a'), true);
    assert.equal(allowsAccount({ order: ['a'] }, 'x'), false);
  });
});
