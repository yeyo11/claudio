import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AccountStore, applySteps, planSwitch, reconcileAccountDir, STAGING_DIR } from '../src/index.ts';

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'claudio-config-mode-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const isLink = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;

/** Every entry under `dir` with its kind and content (or link target): what "untouched" is checked against */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const key = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path);
      if (st.isSymbolicLink()) out[key] = `link:${readlinkSync(path)}`;
      else if (st.isDirectory()) {
        out[key] = 'dir';
        walk(path, key);
      } else out[key] = `file:${readFileSync(path, 'utf8')}`;
    }
  };
  walk(dir, '');
  return out;
}

/** A default dir with some configuration and history, and a data dir of its own */
function fresh(name: string): { defaultDir: string; dataDir: string } {
  const base = join(root, name);
  const defaultDir = join(base, 'default');
  mkdirSync(join(defaultDir, 'agents'), { recursive: true });
  writeFileSync(join(defaultDir, 'agents', 'reviewer.md'), 'review');
  writeFileSync(join(defaultDir, 'settings.json'), '{"model":"opus"}');
  writeFileSync(join(defaultDir, 'CLAUDE.md'), 'be brief');
  mkdirSync(join(defaultDir, 'agent-memory'));
  mkdirSync(join(defaultDir, 'projects'));
  return { defaultDir, dataDir: join(base, 'data') };
}

const storeOf = (defaultDir: string, dataDir: string, log: string[] = [], live: string[] = []): AccountStore =>
  new AccountStore({ dataDir, defaultDir, claude: '/nonexistent', env: { PATH: process.env.PATH }, log: (line) => log.push(line), liveChatsOn: () => live });

const stateOf = (s: AccountStore, id: string, item: string): string | undefined => s.configOf(id)?.items.find((i) => i.name === item)?.state;

describe('the configuration mode', () => {
  it('a new account takes the install default: shared unless a person chose independent', async () => {
    const { defaultDir, dataDir } = fresh('default-mode');
    const s = storeOf(defaultDir, dataDir);
    const shared = await s.add({ kind: 'login' });
    assert.equal(s.configOf(shared.id)?.mode, 'shared');
    assert.equal(s.withConfig(s.list()).find((x) => x.id === shared.id)?.config?.mode, 'shared', 'served on the account');

    await s.setSettings({ newAccountConfig: 'independent' });
    const own = await s.add({ kind: 'login' });
    const dir = s.ref(own.id).dir;
    assert.equal(s.getWithConfig(own.id).config?.mode, 'independent');
    assert.ok(!isLink(join(dir, 'settings.json')), 'an independent account starts from a copy, not a link');
    assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), '{"model":"opus"}');
    assert.ok(isLink(join(dir, 'projects')), 'its history is shared all the same');
    assert.equal(s.getWithConfig('default').config, undefined, 'the default account has no mode');
    await assert.rejects(() => s.setSettings({ newAccountConfig: 'neither' as 'shared' }), /newAccountConfig/);
  });

  it("a shared account's configuration is links, and an independent account's is left alone by the reconciliation", async () => {
    const { defaultDir, dataDir } = fresh('reconcile-modes');
    const s = storeOf(defaultDir, dataDir);
    const a = await s.add({ kind: 'login' });
    const dir = s.ref(a.id).dir;
    assert.ok(isLink(join(dir, 'settings.json')) && isLink(join(dir, 'agents')));
    assert.equal(stateOf(s, a.id, 'settings.json'), 'linked');
    assert.equal(s.configOf(a.id)?.state, 'ok');

    await s.setConfigMode(a.id, 'independent', 'empty');
    // A source that appears later reaches a shared account at its next run, never an independent one
    mkdirSync(join(defaultDir, 'commands'));
    writeFileSync(join(defaultDir, 'keybindings.json'), '[]');
    s.ref(a.id);
    assert.ok(!existsSync(join(dir, 'commands')) && !existsSync(join(dir, 'keybindings.json')));
    assert.equal(stateOf(s, a.id, 'commands'), 'absent');
    writeFileSync(join(dir, 'CLAUDE.md'), 'mine');
    s.ref(a.id);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'mine');
    assert.equal(stateOf(s, a.id, 'CLAUDE.md'), 'own');
    assert.equal(s.configOf(a.id)?.state, 'ok');
  });

  it('history stays linked in both modes', async () => {
    const { defaultDir, dataDir } = fresh('history');
    const s = storeOf(defaultDir, dataDir);
    const a = await s.add({ kind: 'login' });
    const dir = s.ref(a.id).dir;
    for (const to of ['independent', 'shared', 'independent'] as const) {
      await s.setConfigMode(a.id, to);
      s.ref(a.id);
      assert.ok(isLink(join(dir, 'projects')) && isLink(join(dir, 'agent-memory')), `history linked when ${to}`);
      assert.equal(stateOf(s, a.id, 'agent-memory'), 'linked');
    }
  });

  it('shared to independent copies what each link pointed to and leaves the default dir untouched', async () => {
    const { defaultDir, dataDir } = fresh('to-own-copy');
    // An agent linked into the person's own repository stays a link to it in the copy
    const repo = join(root, 'to-own-copy', 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'shipcast.md'), 'ship');
    symlinkSync(join(repo, 'shipcast.md'), join(defaultDir, 'agents', 'shipcast.md'));
    const s = storeOf(defaultDir, dataDir);
    const a = await s.add({ kind: 'login' });
    const dir = s.ref(a.id).dir;
    const before = snapshot(defaultDir);

    const { steps, aside } = await s.setConfigMode(a.id, 'independent');
    assert.equal(aside, null, 'nothing moves aside when turning independent');
    assert.deepEqual(steps.filter((x) => x.action === 'copy').map((x) => x.name).sort(), ['CLAUDE.md', 'agents', 'settings.json']);
    assert.ok(!isLink(join(dir, 'agents')) && !isLink(join(dir, 'settings.json')));
    assert.equal(readFileSync(join(dir, 'agents', 'reviewer.md'), 'utf8'), 'review');
    assert.equal(readlinkSync(join(dir, 'agents', 'shipcast.md')), join(repo, 'shipcast.md'));

    writeFileSync(join(dir, 'settings.json'), '{"model":"haiku"}');
    assert.equal(readFileSync(join(defaultDir, 'settings.json'), 'utf8'), '{"model":"opus"}', 'the copy is the account\'s own');
    assert.deepEqual(snapshot(defaultDir), { ...before, 'projects': 'dir' }, 'nothing of the default dir changed');
    assert.ok(!existsSync(join(dir, STAGING_DIR)), 'no staging left behind');
    const stored = JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf8')) as { accounts: { config: unknown; links: string[] }[] };
    assert.deepEqual(stored.accounts[0]?.config, { mode: 'independent' });
    assert.ok(!stored.accounts[0]?.links.includes('settings.json'), 'a copy is no link of Claudio\'s to undo');
  });

  it('shared to independent with "empty" removes the links and puts nothing in their place', async () => {
    const { defaultDir, dataDir } = fresh('to-own-empty');
    const s = storeOf(defaultDir, dataDir);
    const a = await s.add({ kind: 'login' });
    const dir = s.ref(a.id).dir;
    const before = snapshot(defaultDir);
    const { steps } = await s.setConfigMode(a.id, 'independent', 'empty');
    assert.deepEqual(steps.filter((x) => x.action === 'unlink').map((x) => x.name).sort(), ['CLAUDE.md', 'agents', 'settings.json']);
    for (const item of ['CLAUDE.md', 'agents', 'settings.json']) assert.ok(!existsSync(join(dir, item)) && !isLink(join(dir, item)), item);
    assert.deepEqual(snapshot(defaultDir), before);
    assert.equal(s.configOf(a.id)?.state, 'ok');
  });

  it("independent to shared moves the account's own items aside and links, deleting nothing", async () => {
    const { defaultDir, dataDir } = fresh('to-shared');
    const s = storeOf(defaultDir, dataDir);
    const a = await s.add({ kind: 'login' });
    const dir = s.ref(a.id).dir;
    await s.setConfigMode(a.id, 'independent');
    writeFileSync(join(dir, 'settings.json'), '{"model":"haiku"}');
    writeFileSync(join(dir, 'agents', 'mine.md'), 'mine');
    mkdirSync(join(dir, 'themes'));
    writeFileSync(join(dir, 'themes', 'dusk.json'), '{}');
    const before = snapshot(defaultDir);

    const { steps, aside } = await s.setConfigMode(a.id, 'shared');
    assert.ok(aside?.startsWith('.claudio-own/'));
    const by = Object.fromEntries(steps.filter((x) => x.class === 'config').map((x) => [x.name, x.action]));
    assert.equal(by['settings.json'], 'replace');
    assert.equal(by.agents, 'replace');
    assert.equal(by.themes, 'move-aside', 'the default has no themes: kept aside, nothing linked');
    const kept = join(dir, aside ?? '');
    assert.equal(readFileSync(join(kept, 'settings.json'), 'utf8'), '{"model":"haiku"}');
    assert.equal(readFileSync(join(kept, 'agents', 'mine.md'), 'utf8'), 'mine');
    assert.equal(readFileSync(join(kept, 'themes', 'dusk.json'), 'utf8'), '{}');
    assert.ok(isLink(join(dir, 'settings.json')) && isLink(join(dir, 'agents')));
    assert.ok(!existsSync(join(dir, 'themes')));
    assert.deepEqual(snapshot(defaultDir), before);
    assert.deepEqual(s.configOf(a.id)?.keptAside, [aside?.slice('.claudio-own/'.length)]);
    assert.equal(s.configOf(a.id)?.mode, 'shared');
    assert.equal(s.configOf(a.id)?.state, 'ok');
  });

  it('the plan says what would happen and changes nothing', async () => {
    const { defaultDir, dataDir } = fresh('plan');
    const s = storeOf(defaultDir, dataDir);
    const a = await s.add({ kind: 'login' });
    const dir = s.ref(a.id).dir;
    const beforeAccount = snapshot(dir);
    const beforeDefault = snapshot(defaultDir);
    const beforeFile = readFileSync(join(dataDir, 'accounts.json'), 'utf8');

    const plan = s.planConfig(a.id, 'independent');
    assert.equal(plan.from, 'shared');
    assert.equal(plan.start, 'copy');
    assert.deepEqual(plan.steps.filter((x) => x.action === 'copy').map((x) => x.name).sort(), ['CLAUDE.md', 'agents', 'settings.json']);
    assert.ok(plan.steps.filter((x) => x.class === 'history').every((x) => x.action === 'keep' || x.action === 'skip'));
    assert.equal(s.planConfig(a.id, 'shared').steps.filter((x) => x.action !== 'keep' && x.action !== 'skip').length, 0, 'already shared: nothing to do');
    s.planItem(a.id, 'agent-memory');

    assert.deepEqual(snapshot(dir), beforeAccount);
    assert.deepEqual(snapshot(defaultDir), beforeDefault);
    assert.equal(readFileSync(join(dataDir, 'accounts.json'), 'utf8'), beforeFile);
    assert.throws(() => s.planConfig('default', 'independent'), /no configuration mode/);
  });

  it('a switch interrupted half-way finishes when run again', async () => {
    const { defaultDir, dataDir } = fresh('interrupted');
    const s = storeOf(defaultDir, dataDir);
    const a = await s.add({ kind: 'login' });
    const dir = s.ref(a.id).dir;
    // Cut short: the first item done, the second's copy staged whole, the third's half-written
    const steps = planSwitch(dir, defaultDir, 'independent', 'copy', join(dir, '.claudio-own', 'x'));
    const copies = steps.filter((x) => x.action === 'copy');
    assert.equal(copies.length, 3);
    assert.deepEqual(copies.map((x) => x.name), ['settings.json', 'CLAUDE.md', 'agents']);
    applySteps(dir, defaultDir, [copies[0]!], { aside: join(dir, '.claudio-own', 'x') });
    mkdirSync(join(dir, STAGING_DIR), { recursive: true });
    writeFileSync(join(dir, STAGING_DIR, 'CLAUDE.md'), 'be brief');
    writeFileSync(join(dir, STAGING_DIR, 'agents.partial'), 'half');
    // and the record says a switch was under way, as a server killed mid-way leaves it
    const file = join(dataDir, 'accounts.json');
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { accounts: { config: unknown }[] };
    stored.accounts[0]!.config = { mode: 'shared', switching: { to: 'independent', start: 'copy', aside: '2026-11-14T00-00-00-000Z' } };
    writeFileSync(file, JSON.stringify(stored));

    const log: string[] = [];
    const again = storeOf(defaultDir, dataDir, log);
    assert.ok(log.some((line) => line.includes('finishing the switch')));
    assert.equal(again.configOf(a.id)?.mode, 'independent');
    assert.equal(again.configOf(a.id)?.switching, null);
    for (const item of ['CLAUDE.md', 'agents', 'settings.json']) assert.ok(existsSync(join(dir, item)) && !isLink(join(dir, item)), `${item} is a copy`);
    assert.equal(readFileSync(join(dir, 'agents', 'reviewer.md'), 'utf8'), 'review', 'a half-written copy is built again, never put in place');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'be brief');
    assert.ok(!existsSync(join(dir, STAGING_DIR)));
    // Run once more: nothing left to do
    const { steps: rerun } = await again.setConfigMode(a.id, 'independent');
    assert.ok(rerun.every((x) => x.action === 'keep' || x.action === 'skip'), JSON.stringify(rerun));
  });

  it('a conflict is reported and blocks only its item', async () => {
    const { defaultDir, dataDir } = fresh('conflict');
    const s = storeOf(defaultDir, dataDir);
    const a = await s.add({ kind: 'login' });
    const dir = s.ref(a.id).dir;
    await s.setConfigMode(a.id, 'independent');
    // An older account's own agent memory, where the shared one would be linked
    rmSync(join(dir, 'agent-memory'));
    mkdirSync(join(dir, 'agent-memory'));
    writeFileSync(join(dir, 'agent-memory', 'notes.md'), 'remember');

    const { steps } = await s.setConfigMode(a.id, 'shared');
    assert.deepEqual(steps.filter((x) => x.action === 'conflict').map((x) => [x.name, x.reason]), [['agent-memory', 'real-dir']]);
    assert.ok(isLink(join(dir, 'settings.json')), 'the other items switched');
    assert.equal(readFileSync(join(dir, 'agent-memory', 'notes.md'), 'utf8'), 'remember', 'the conflict is left as it was');
    assert.equal(s.configOf(a.id)?.state, 'conflict');
    assert.equal(stateOf(s, a.id, 'agent-memory'), 'conflict');
  });

  it('"use shared" moves a real history dir aside and links the shared one', async () => {
    const { defaultDir, dataDir } = fresh('use-shared');
    const s = storeOf(defaultDir, dataDir);
    const a = await s.add({ kind: 'login' });
    const dir = s.ref(a.id).dir;
    rmSync(join(dir, 'agent-memory'));
    mkdirSync(join(dir, 'agent-memory'));
    writeFileSync(join(dir, 'agent-memory', 'notes.md'), 'remember');

    const plan = s.planItem(a.id, 'agent-memory');
    assert.deepEqual(plan.steps.map((x) => [x.action, x.reason]), [['replace', 'real-dir']]);
    assert.ok(!isLink(join(dir, 'agent-memory')), 'planning moved nothing');
    const { aside } = await s.useShared(a.id, 'agent-memory');
    assert.ok(isLink(join(dir, 'agent-memory')));
    assert.equal(readFileSync(join(dir, aside ?? '', 'agent-memory', 'notes.md'), 'utf8'), 'remember');
    assert.equal(stateOf(s, a.id, 'agent-memory'), 'linked');
    assert.throws(() => s.planItem(a.id, '.credentials.json'), /not a configuration or history item/);
    await s.setConfigMode(a.id, 'independent');
    assert.throws(() => s.planItem(a.id, 'settings.json'), /keeps its own configuration/);
  });

  it('an empty dir or an identical file in the way is moved aside and linked before a run, and said once', async () => {
    const { defaultDir, dataDir } = fresh('auto-move');
    const log: string[] = [];
    const s = storeOf(defaultDir, dataDir, log);
    const a = await s.add({ kind: 'login' });
    const dir = s.ref(a.id).dir;
    // The account's CLI made its own empty agent-memory/, and a settings file equal to the default's appeared
    rmSync(join(dir, 'agent-memory'));
    mkdirSync(join(dir, 'agent-memory'));
    rmSync(join(dir, 'settings.json'));
    writeFileSync(join(dir, 'settings.json'), '{"model":"opus"}');
    s.ref(a.id);
    assert.ok(isLink(join(dir, 'agent-memory')) && isLink(join(dir, 'settings.json')));
    const moved = log.filter((line) => line.includes('moved it to'));
    assert.equal(moved.length, 2, moved.join('\n'));
    assert.ok(moved.some((line) => line.includes('an empty agent-memory')));
    const kept = s.configOf(a.id)?.keptAside ?? [];
    assert.equal(kept.length, 1);
    assert.equal(readFileSync(join(dir, '.claudio-own', kept[0]!, 'settings.json'), 'utf8'), '{"model":"opus"}');
    s.ref(a.id);
    assert.equal(log.filter((line) => line.includes('moved it to')).length, 2, 'nothing more to move');
  });

  it('a file is not moved while a live chat of the account may hold it open, and a dir that is not empty never is', async () => {
    const { defaultDir, dataDir } = fresh('auto-move-live');
    const s = storeOf(defaultDir, dataDir, [], ['chat-1']);
    const a = await s.add({ kind: 'login' });
    const dir = s.ref(a.id).dir;
    rmSync(join(dir, 'settings.json'));
    writeFileSync(join(dir, 'settings.json'), '{"model":"opus"}');
    const report = reconcileAccountDir(dir, defaultDir, { moves: { aside: () => join(dir, '.claudio-own', 'y'), files: false } });
    assert.deepEqual(report.conflicts.map((c) => [c.item, c.reason]), [['settings.json', 'real-file']]);
    assert.ok(!isLink(join(dir, 'settings.json')));
    s.ref(a.id);
    assert.ok(!isLink(join(dir, 'settings.json')), 'the store holds it back too while the chat runs');
  });
});
