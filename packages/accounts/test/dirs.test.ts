import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AccountStore, planAccountDir, reconcileAccountDir } from '../src/index.ts';
import { writeAtomic as writeAtomicThroughLinks } from '../src/fs.ts';

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'claudio-dirs-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

/** A default dir and an account dir of their own, so no test shares a link or a log line with another */
function fresh(name: string): { defaultDir: string; dir: string; dataDir: string } {
  const base = join(root, name);
  const defaultDir = join(base, 'default');
  const dir = join(base, 'data', 'accounts', 'acc-test0001');
  mkdirSync(defaultDir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return { defaultDir, dir, dataDir: join(base, 'data') };
}

const isLink = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;

describe('reconcileAccountDir', () => {
  it('links an item whose source was created after the account, on the next pass', () => {
    const { defaultDir, dir } = fresh('late-source');
    writeFileSync(join(defaultDir, 'settings.json'), '{}');
    const first = reconcileAccountDir(dir, defaultDir);
    assert.ok(first.linked.includes('settings.json'));
    assert.ok(!existsSync(join(dir, 'agents')) && !isLink(join(dir, 'agents')), 'nothing to link while the default has no agents/');

    mkdirSync(join(defaultDir, 'agents'));
    writeFileSync(join(defaultDir, 'CLAUDE.md'), 'be brief');
    mkdirSync(join(defaultDir, 'tasks'));
    const second = reconcileAccountDir(dir, defaultDir);
    assert.deepEqual([...second.linked].sort(), ['CLAUDE.md', 'agents', 'tasks']);
    assert.equal(readlinkSync(join(dir, 'agents')), join(defaultDir, 'agents'));
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'be brief');
  });

  it('links the history items and the whole configuration list that exist, and projects/ even on a fresh install', () => {
    const { defaultDir, dir } = fresh('lists');
    for (const name of ['agent-memory', 'file-history', 'plans', 'rules', 'output-styles', 'workflows', 'themes', 'hooks', 'commands', 'skills']) mkdirSync(join(defaultDir, name));
    writeFileSync(join(defaultDir, 'keybindings.json'), '{}');
    const report = reconcileAccountDir(dir, defaultDir);
    for (const item of ['projects', 'agent-memory', 'file-history', 'plans', 'rules', 'output-styles', 'workflows', 'themes', 'hooks', 'commands', 'skills', 'keybindings.json']) {
      assert.ok(isLink(join(dir, item)), `${item} is linked`);
    }
    assert.ok(!report.linked.includes('plugins'), 'plugins are the CLI installer\'s, not a link');
    assert.ok(!isLink(join(dir, '.credentials.json')) && !existsSync(join(dir, '.claude.json')), 'identity is never touched');
  });

  it('writes nothing when every link is in place', () => {
    const { defaultDir, dir } = fresh('quiet');
    writeFileSync(join(defaultDir, 'settings.json'), '{}');
    const first = reconcileAccountDir(dir, defaultDir);
    const again = reconcileAccountDir(dir, defaultDir, { recorded: first.linked });
    assert.deepEqual([again.linked, again.adopted, again.conflicts], [[], [], []]);
    assert.ok(planAccountDir(dir, defaultDir).every((step) => step.action === 'keep' || step.action === 'skip'));
  });

  it('adopts a hand-made link, absolute or relative, and leaves it as it is', () => {
    const { defaultDir, dir } = fresh('adopt');
    writeFileSync(join(defaultDir, 'CLAUDE.md'), 'x');
    mkdirSync(join(defaultDir, 'agents'));
    symlinkSync(join(defaultDir, 'CLAUDE.md'), join(dir, 'CLAUDE.md'));
    symlinkSync(relative(dir, join(defaultDir, 'agents')), join(dir, 'agents'));
    const report = reconcileAccountDir(dir, defaultDir, { recorded: [] });
    assert.deepEqual([...report.adopted].sort(), ['CLAUDE.md', 'agents']);
    assert.deepEqual(report.conflicts, []);
    assert.equal(readlinkSync(join(dir, 'CLAUDE.md')), join(defaultDir, 'CLAUDE.md'));
    assert.deepEqual(reconcileAccountDir(dir, defaultDir, { recorded: ['projects', 'CLAUDE.md', 'agents'] }).adopted, [], 'adopted once it is recorded');
  });

  it('reports a real file, a real dir and a link elsewhere in the way, and leaves each as it was', () => {
    const { defaultDir, dir } = fresh('conflict');
    writeFileSync(join(defaultDir, 'settings.json'), '{"from":"default"}');
    mkdirSync(join(defaultDir, 'skills'));
    mkdirSync(join(defaultDir, 'agent-memory'));
    writeFileSync(join(dir, 'settings.json'), '{"own":true}');
    mkdirSync(join(dir, 'skills'));
    writeFileSync(join(dir, 'skills', 'mine.md'), 'mine');
    const elsewhere = join(root, 'lead-elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dir, 'agent-memory'));

    const report = reconcileAccountDir(dir, defaultDir);
    assert.deepEqual(
      Object.fromEntries(report.conflicts.map((c) => [c.item, c.reason])),
      { 'agent-memory': 'link-elsewhere', 'settings.json': 'real-file', skills: 'real-dir' },
    );
    assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), '{"own":true}');
    assert.equal(readFileSync(join(dir, 'skills', 'mine.md'), 'utf8'), 'mine');
    assert.equal(readlinkSync(join(dir, 'agent-memory')), elsewhere);
    assert.ok(!isLink(join(dir, 'settings.json')));
  });

  it('keeps an item of its own when the default has none to offer', () => {
    const { defaultDir, dir } = fresh('own');
    mkdirSync(join(dir, 'agents'));
    const report = reconcileAccountDir(dir, defaultDir);
    assert.deepEqual(report.conflicts, []);
    assert.ok(!isLink(join(dir, 'agents')));
  });

  it('does nothing for the default account\'s own dir', () => {
    const { defaultDir } = fresh('self');
    assert.deepEqual(planAccountDir(defaultDir, defaultDir), []);
  });
});

describe('the store keeps the links in sync', () => {
  const store = (defaultDir: string, dataDir: string, log: string[] = []): AccountStore => new AccountStore({ dataDir, defaultDir, claude: '/nonexistent', env: { PATH: process.env.PATH }, log: (line) => log.push(line) });

  it('links what appeared in the default dir before a spawn, and records the link so removing the account undoes it', async () => {
    const { defaultDir, dataDir } = fresh('store-late');
    writeFileSync(join(defaultDir, 'settings.json'), '{}');
    const s = store(defaultDir, dataDir);
    const a = await s.add({ kind: 'login' });
    const dir = s.ref(a.id).dir;
    assert.ok(!existsSync(join(dir, 'CLAUDE.md')));
    writeFileSync(join(defaultDir, 'CLAUDE.md'), 'later');
    assert.equal(readFileSync(join(s.ref(a.id).dir, 'CLAUDE.md'), 'utf8'), 'later', 'the next ref() is the next pass');
    await s.remove(a.id);
    assert.equal(readFileSync(join(defaultDir, 'CLAUDE.md'), 'utf8'), 'later', 'the default\'s file is not followed');
    assert.ok(!existsSync(dir));
  });

  it('reconciles every account at start-up, adopting a link made by hand', async () => {
    const { defaultDir, dataDir } = fresh('store-start');
    mkdirSync(join(defaultDir, 'agents'));
    const first = store(defaultDir, dataDir);
    const a = await first.add({ kind: 'login' });
    // The person's own fix of 2026-11-13: a link the record does not know of
    const accountDir = join(dataDir, 'accounts', a.id);
    rmSync(join(accountDir, 'agents'), { force: true });
    writeFileSync(join(defaultDir, 'CLAUDE.md'), 'x');
    symlinkSync(join(defaultDir, 'CLAUDE.md'), join(accountDir, 'CLAUDE.md'));
    const stored = JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf8')) as { accounts: { links: string[] }[] };
    stored.accounts[0]!.links = stored.accounts[0]!.links.filter((item) => item !== 'CLAUDE.md');
    writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify(stored));

    const second = store(defaultDir, dataDir);
    await new Promise((r) => setTimeout(r, 50));
    const dir = second.ref(a.id).dir;
    assert.ok(isLink(join(dir, 'agents')), 'the missing link is made at start-up');
    const after = JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf8')) as { accounts: { links: string[] }[] };
    assert.ok(after.accounts[0]?.links.includes('CLAUDE.md'), 'the hand-made link is recorded');
  });

  it('says once that a real file is in the way, and leaves it', async () => {
    const { defaultDir, dataDir } = fresh('store-conflict');
    writeFileSync(join(defaultDir, 'CLAUDE.md'), 'default');
    const log: string[] = [];
    const s = store(defaultDir, dataDir, log);
    const a = await s.add({ kind: 'login' });
    const own = join(s.ref(a.id).dir, 'keybindings.json');
    writeFileSync(join(defaultDir, 'keybindings.json'), '[]');
    writeFileSync(own, 'mine');
    s.ref(a.id);
    s.ref(a.id);
    assert.equal(readFileSync(own, 'utf8'), 'mine');
    assert.equal(log.filter((line) => line.includes('keybindings.json')).length, 1, 'logged once, not at every spawn');
  });

  it('lists an orphan dir in the log and leaves it', () => {
    const { defaultDir, dataDir } = fresh('store-orphan');
    const orphan = join(dataDir, 'accounts', 'acc-79ffec12');
    mkdirSync(join(orphan, 'projects'), { recursive: true });
    writeFileSync(join(orphan, 'projects', 'transcript.jsonl'), '{}');
    const log: string[] = [];
    const s = store(defaultDir, dataDir, log);
    assert.ok(log.some((line) => line.includes(orphan)));
    assert.ok(s.orphans().includes(orphan));
    assert.ok(existsSync(join(orphan, 'projects', 'transcript.jsonl')), 'whatever it holds stays');
  });
});

describe('writeAtomic through links', () => {
  it('keeps a symlinked file a link and writes the file it points at', async () => {
    const dir = mkdtempSync(join(root, 'write-'));
    const real = join(dir, 'real.md');
    const link = join(dir, 'link.md');
    writeFileSync(real, 'old');
    symlinkSync(real, link);
    await writeAtomicThroughLinks(link, 'new');
    assert.ok(isLink(link), 'an editor\'s save does not replace the link with a copy');
    assert.equal(readFileSync(real, 'utf8'), 'new');
    assert.equal(readFileSync(link, 'utf8'), 'new');
  });

  it('follows a chain of links and a link whose target does not exist yet', async () => {
    const dir = mkdtempSync(join(root, 'write-'));
    mkdirSync(join(dir, 'repo'));
    symlinkSync(join(dir, 'repo', 'agent.md'), join(dir, 'middle'));
    symlinkSync(join(dir, 'middle'), join(dir, 'top'));
    await writeAtomicThroughLinks(join(dir, 'top'), 'created');
    assert.ok(isLink(join(dir, 'top')) && isLink(join(dir, 'middle')));
    assert.equal(readFileSync(join(dir, 'repo', 'agent.md'), 'utf8'), 'created');
  });

  it('still writes a plain file, and leaves no temp file behind', async () => {
    const dir = mkdtempSync(join(root, 'write-'));
    await writeAtomicThroughLinks(join(dir, 'sub', 'plain.json'), '{}', 0o600);
    assert.equal(readFileSync(join(dir, 'sub', 'plain.json'), 'utf8'), '{}');
    assert.equal(lstatSync(join(dir, 'sub', 'plain.json')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(dir, 'sub')), ['plain.json']);
  });
});
