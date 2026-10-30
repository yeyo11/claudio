import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ClaudioEvent } from '@claudio/shared';
import { Db } from '../src/db.ts';
import { SessionsWatcher } from '../src/event-sources.ts';
import { EventBus } from '../src/events.ts';
import type { CoreConfig } from '../src/paths.ts';
import { SessionStore } from '../src/sessions.ts';
import { TranscriptFolds } from '../src/transcript-folds.ts';
import { tempConfig } from './helpers.ts';

// The incremental listing (docs/plans/regression-fixes-2026-10-29.md, D8 and C7): what a restart
// reads, what a watcher's report makes the listing read, and that callers share one look.

const line = (o: object) => JSON.stringify(o);
const message = (uuid: string, cwd: string, text = `message ${uuid}`) =>
  line({ type: 'user', uuid, timestamp: `2026-01-01T10:00:${uuid.padStart(2, '0').slice(-2)}Z`, cwd, message: { role: 'user', content: text } });

/** A transcript of `count` messages under the project directory `dir`. */
function transcript(config: CoreConfig, dir: string, id: string, count: number, cwd = `/work/${dir}`): string {
  mkdirSync(join(config.projectsDir, dir), { recursive: true });
  const file = join(config.projectsDir, dir, `${id}.jsonl`);
  writeFileSync(file, `${Array.from({ length: count }, (_, i) => message(String(i), cwd)).join('\n')}\n`);
  return file;
}

const countOf = async (store: SessionStore, id: string) => (await store.listSessions()).find((s) => s.id === id)?.messageCount;

/** A store whose looks at every project directory are counted. */
class Counting extends SessionStore {
  looks = 0;
  protected override async projectDirs(): Promise<string[]> {
    this.looks += 1;
    return super.projectDirs();
  }
}

/** Rewrites bytes in place, far from the end: only a pass that reads the file from its start sees it. */
async function editInPlace(file: string, from: string, to: string): Promise<void> {
  assert.equal(from.length, to.length);
  const handle = await open(file, 'r+');
  await handle.write(to, readFileSync(file, 'utf8').indexOf(from));
  await handle.close();
}

const root = process.getuid?.() === 0;

test('a restart reads the stored folds, not the transcripts that did not change', { skip: root ? 'root reads any file' : false }, async () => {
  const config = tempConfig();
  const db = new Db(config);
  try {
    const a = transcript(config, '-work-a', 'aaaa-1111', 3);
    transcript(config, '-work-b', 'bbbb-2222', 5);
    const first = new SessionStore(config, { folds: new TranscriptFolds(db.connection) });
    assert.deepEqual((await first.listSessions()).map((s) => s.messageCount).sort(), [3, 5]);
    first.flush();

    // Unreadable now: a store that opened it would lose it from the list
    chmodSync(a, 0o000);
    const restarted = new SessionStore(config, { folds: new TranscriptFolds(db.connection) });
    const listed = await restarted.listSessions();
    assert.deepEqual(listed.map((s) => [s.id, s.messageCount]).sort(), [['aaaa-1111', 3], ['bbbb-2222', 5]]);
    assert.equal(listed.find((s) => s.id === 'aaaa-1111')?.firstPrompt, 'message 0');
    chmodSync(a, 0o644);
  } finally {
    db.close();
  }
});

test('after a restart a transcript that grew is read only past where its stored fold stopped', async () => {
  const config = tempConfig();
  const db = new Db(config);
  try {
    const file = transcript(config, '-work-grow', 'cccc-3333', 2, '/work/idx');
    const first = new SessionStore(config, { folds: new TranscriptFolds(db.connection) });
    assert.equal(await countOf(first, 'cccc-3333'), 2);
    first.flush();

    // Edited far from the end, then appended to: a pass from the start would see the edit
    await editInPlace(file, '/work/idx', '/work/xdi');
    appendFileSync(file, `${message('2', '/work/xdi')}\n${line({ type: 'custom-title', customTitle: 'Grown' })}\n`);
    const restarted = new SessionStore(config, { folds: new TranscriptFolds(db.connection) });
    const [grown] = await restarted.listSessions();
    assert.equal(grown?.messageCount, 3);
    assert.equal(grown?.title, 'Grown');
    assert.equal(grown?.projectPath, '/work/idx', 'the start of the file was not read again');
  } finally {
    db.close();
  }
});

test('a fold stored by another version of the listing is not trusted: the transcript is read again whole', async () => {
  const config = tempConfig();
  const db = new Db(config);
  try {
    const file = transcript(config, '-work-old', 'dddd-4444', 2, '/work/idx');
    const first = new SessionStore(config, { folds: new TranscriptFolds(db.connection) });
    await first.listSessions();
    first.flush();
    const stored = db.connection.prepare('SELECT summary_json FROM transcript_folds WHERE path = ?').get(file) as { summary_json: string };
    db.connection.prepare('UPDATE transcript_folds SET summary_json = ? WHERE path = ?').run(stored.summary_json.replace(/"v":\d+/, '"v":0'), file);

    await editInPlace(file, '/work/idx', '/work/xdi');
    const restarted = new SessionStore(config, { folds: new TranscriptFolds(db.connection) });
    const [read] = await restarted.listSessions();
    assert.equal(read?.projectPath, '/work/xdi');
    restarted.flush();
    const rewritten = db.connection.prepare('SELECT summary_json FROM transcript_folds WHERE path = ?').get(file) as { summary_json: string };
    assert.match(rewritten.summary_json, /"v":1/);
  } finally {
    db.close();
  }
});

test("a transcript deleted while the server was down leaves the list and its row", async () => {
  const config = tempConfig();
  const db = new Db(config);
  try {
    const gone = transcript(config, '-work-gone', 'eeee-5555', 1);
    transcript(config, '-work-kept', 'ffff-6666', 1);
    const first = new SessionStore(config, { folds: new TranscriptFolds(db.connection) });
    assert.equal((await first.listSessions()).length, 2);
    first.flush();

    rmSync(gone);
    const restarted = new SessionStore(config, { folds: new TranscriptFolds(db.connection) });
    assert.deepEqual((await restarted.listSessions()).map((s) => s.id), ['ffff-6666']);
    restarted.flush();
    const rows = db.connection.prepare('SELECT path FROM transcript_folds').all() as Array<{ path: string }>;
    assert.deepEqual(rows.map((r) => r.path), [join(config.projectsDir, '-work-kept', 'ffff-6666.jsonl')]);
  } finally {
    db.close();
  }
});

test('while a watcher reports every change, a listing reads what it named and nothing else', async () => {
  const config = tempConfig();
  const a = transcript(config, '-work-a', 'aaaa-1111', 1);
  const b = transcript(config, '-work-b', 'bbbb-2222', 1);
  const store = new Counting(config);
  store.noteWatching(true);
  assert.equal((await store.listSessions()).length, 2);
  assert.equal(store.looks, 1, 'the watch began unwatched changes in: every file is looked at once');

  // Nothing reported: nothing is read, not even a stat, so a change nobody reported is not seen
  appendFileSync(a, `${message('1', '/work/-work-a')}\n`);
  appendFileSync(b, `${message('1', '/work/-work-b')}\n`);
  assert.equal(await countOf(store, 'aaaa-1111'), 1);
  assert.equal(store.looks, 1);

  // One file reported: that one is read, and the other stays as it was
  store.noteChanged('-work-a/aaaa-1111.jsonl');
  assert.equal(await countOf(store, 'aaaa-1111'), 2);
  assert.equal(await countOf(store, 'bbbb-2222'), 1);
  assert.equal(store.looks, 1, 'no directory was listed for it');

  // A sidecar of a session changed: the listing does not read sidecars
  store.noteChanged('-work-b/bbbb-2222/subagents/agent-x.jsonl');
  assert.equal(await countOf(store, 'bbbb-2222'), 1);

  // The watch could not say what changed: every file is looked at again
  store.noteChanged(null);
  assert.equal(await countOf(store, 'bbbb-2222'), 2);
  assert.equal(store.looks, 2);
});

test('a project directory the watcher names is listed again: what it gained appears and what it lost goes', async () => {
  const config = tempConfig();
  const kept = transcript(config, '-work-a', 'aaaa-1111', 1);
  const store = new Counting(config);
  store.noteWatching(true);
  await store.listSessions();

  transcript(config, '-work-new', 'nnnn-7777', 2);
  store.noteChanged('-work-new');
  assert.deepEqual((await store.listSessions()).map((s) => s.id).sort(), ['aaaa-1111', 'nnnn-7777']);

  rmSync(kept);
  store.noteChanged('-work-a/aaaa-1111.jsonl');
  assert.deepEqual((await store.listSessions()).map((s) => s.id), ['nnnn-7777']);
  assert.equal(await store.summary('aaaa-1111'), null);
  assert.equal(store.looks, 1);

  // The watch stopped: every listing looks at every file's stat again
  store.noteWatching(false);
  appendFileSync(join(config.projectsDir, '-work-new', 'nnnn-7777.jsonl'), `${message('2', '/work/-work-new')}\n`);
  assert.equal(await countOf(store, 'nnnn-7777'), 3);
  assert.equal(store.looks, 2);
});

test('callers that ask while a listing runs share it', async () => {
  const config = tempConfig();
  for (let i = 0; i < 20; i++) transcript(config, `-work-${i}`, `0000-${String(i).padStart(4, '0')}`, 3);
  const store = new Counting(config);
  const [one, two, three] = await Promise.all([store.listSessions(), store.listSessions(), store.listSessions()]);
  assert.equal(store.looks, 1);
  assert.equal(one.length, 20);
  assert.deepEqual(two, one);
  assert.deepEqual(three, one);
  const generation = store.generation;
  // Unwatched, the next listing looks at every stat, and a listing that found nothing new leaves the generation alone
  await store.listSessions();
  assert.equal(store.looks, 2);
  assert.equal(store.generation, generation);
});

test("the watcher names the transcript that changed, and the listing reads only it", async () => {
  const config = tempConfig();
  const a = transcript(config, '-work-a', 'aaaa-1111', 1);
  transcript(config, '-work-b', 'bbbb-2222', 1);
  const store = new Counting(config);
  const bus = new EventBus();
  const watcher = new SessionsWatcher(config.projectsDir, bus, { windowMs: 30, changes: store });
  const seen: ClaudioEvent[] = [];
  // Someone follows the feed: the watch begins, and the listing knows what it missed is unknown
  const stop = bus.subscribe((e) => seen.push(e));
  try {
    await store.listSessions();
    const looks = store.looks;
    assert.equal(looks, 1);
    // The watch reaches every directory before it reports what changes in it
    await new Promise((r) => setTimeout(r, 200));
    appendFileSync(a, `${message('1', '/work/-work-a')}\n`);
    for (let waited = 0; seen.length === 0 && waited < 5000; waited += 20) await new Promise((r) => setTimeout(r, 20));
    assert.ok(seen.some((e) => e.type === 'sessions.changed'), 'the change reached the feed');
    assert.equal(await countOf(store, 'aaaa-1111'), 2);
    assert.equal(await countOf(store, 'bbbb-2222'), 1);
    assert.equal(store.looks, looks, 'only the file the watcher named was read');
  } finally {
    stop();
    watcher.close();
  }
});
