import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ClaudioEvent, FlowMemoryProposal, WorkItemActor } from '@claudio/shared';
import { Db } from '../src/db.ts';
import { EventBus, type ClaudioEventInput } from '../src/events.ts';
import { JOURNAL_HANDOFF_BYTES, JournalService } from '../src/journal.ts';
import { renderSection } from '../src/lessons/render.ts';
import { MemoryProposalService, withText } from '../src/memory-proposals.ts';
import { MemoryStore } from '../src/memory.ts';
import { WorkItemError, WorkItemService } from '../src/work-items.ts';
import { PASTED_NOTE } from '../src/prompt-rules.ts';
import { tempConfig } from './helpers.ts';

const PERSON: WorkItemActor = { kind: 'person', role: null };
const QA: WorkItemActor = { kind: 'agent', role: 'qa' };

function setup() {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const events: ClaudioEventInput[] = [];
  const emit = (event: ClaudioEventInput) => void events.push(event);
  const items = new WorkItemService({ db, project: (id) => (id === 'p1' ? { keyPrefix: 'AGN', columnLimits: {} } : null), emit });
  const ref = (id: string) => {
    const item = items.find(id);
    return item ? { id: item.id, key: item.key, title: item.title, type: item.type, status: item.status } : null;
  };
  const journal = new JournalService({
    db,
    emit,
    item: ref,
    sources: (id) => items.links(id).map((l) => ({ kind: 'chat' as const, chatId: l.chatId, orchestrationId: null, taskId: null })),
  });
  const memory = new MemoryStore(config);
  const projectDir = mkdtempSync(join(tmpdir(), 'claudio-journal-project-'));
  const projects = new Map([['p1', { path: projectDir, memoryKey: 'p1-key' }]]);
  const proposals = new MemoryProposalService({ db, journal, memory, project: (id) => projects.get(id) ?? null, emit, item: ref });
  const memoryDir = join(config.projectsDir, 'p1-key', 'memory');
  return { config, db, events, items, journal, memory, proposals, projectDir, memoryDir, projects };
}

const refusal = (statusCode: number) => (err: unknown) => err instanceof WorkItemError && err.statusCode === statusCode;
const proposal = (target: FlowMemoryProposal['target'], text = 'Run the tests with --test-concurrency=1', reason = 'Parallel runs share the port'): FlowMemoryProposal => ({
  target,
  text,
  reason,
});

// ---------- the journal ----------

test('entries are read newest first and paged by the cursor each page hands out', () => {
  const { journal } = setup();
  for (let i = 1; i <= 5; i++) journal.create('p1', { text: `Note ${String(i)}` });
  journal.create('p2', { text: 'Elsewhere' });

  const first = journal.page('p1', { limit: 2 });
  assert.deepEqual(first.entries.map((e) => e.text), ['Note 5', 'Note 4']);
  assert.equal(first.total, 5);
  assert.ok(first.nextBefore);
  const second = journal.page('p1', { limit: '2', before: first.nextBefore });
  assert.deepEqual(second.entries.map((e) => e.text), ['Note 3', 'Note 2']);
  const last = journal.page('p1', { limit: 2, before: second.nextBefore });
  assert.deepEqual(last.entries.map((e) => e.text), ['Note 1']);
  assert.equal(last.nextBefore, null);

  assert.throws(() => journal.page('p1', { limit: 0 }), refusal(400));
  assert.throws(() => journal.page('p1', { before: 'nope' }), refusal(400));
});

test('a person writes decisions and notes only, as the person, with a relative document path', () => {
  const { journal, events } = setup();
  const entry = journal.create('p1', { text: '  Keep the board columns fixed  ', kind: 'decision', documentPath: 'docs/adr/0001.md' });
  assert.equal(entry.kind, 'decision');
  assert.equal(entry.text, 'Keep the board columns fixed');
  assert.deepEqual(entry.author, PERSON);
  assert.equal(entry.approvedBy, null);
  assert.equal(entry.documentPath, 'docs/adr/0001.md');
  assert.deepEqual(
    events.map((e) => e.type),
    ['journal.changed'],
  );

  assert.throws(() => journal.create('p1', { text: 'x', kind: 'closed' as 'note' }), refusal(400));
  assert.throws(() => journal.create('p1', { text: '   ' }), refusal(400));
  assert.throws(() => journal.create('p1', { text: 'x', documentPath: '../outside.md' }), refusal(400));
  assert.throws(() => journal.create('p1', { text: 'x', documentPath: '/etc/passwd' }), refusal(400));
  // The shape every document path has: no hidden part, no control character, nothing to clean up
  for (const documentPath of ['.git/config', 'docs/.env', 'docs/a\u0000.md', 'docs//a.md', 'docs/./a.md', 'docs\\a.md']) {
    assert.throws(() => journal.create('p1', { text: 'x', documentPath }), refusal(400), documentPath);
  }
  assert.equal(journal.create('p1', { text: 'x', documentPath: 'docs/disen\u0303o.md' }).documentPath, 'docs/dise\u00f1o.md');
  assert.throws(() => journal.create('p1', { text: 'x', itemId: 'missing' }), refusal(404));
});

test('an item reaching done is journalled once, with who approved it and the chats that worked on it', () => {
  const { journal, items, events } = setup();
  const item = items.create('p1', { title: 'Board drag and drop' });
  items.link(item.id, { kind: 'chat', role: 'work', chatId: 'chat-1' });
  const hear = () => {
    for (const event of events.splice(0)) journal.observe({ ...event, id: 0, at: '' } as ClaudioEvent);
  };

  items.move(item.id, { status: 'in_review' });
  hear();
  assert.equal(journal.page('p1').total, 0);

  items.move(item.id, { status: 'done' });
  hear();
  const [closed] = journal.page('p1').entries;
  assert.equal(closed?.kind, 'closed');
  assert.equal(closed?.text, 'Board drag and drop');
  assert.equal(closed?.item?.key, 'AGN-1');
  assert.deepEqual(closed?.approvedBy, PERSON);
  assert.equal(closed?.author.kind, 'system');
  assert.deepEqual(closed?.sources.map((s) => s.chatId), ['chat-1']);

  // Reopened and closed again: the first entry stands, and no second one is written
  items.move(item.id, { status: 'in_progress' });
  items.move(item.id, { status: 'done' });
  hear();
  assert.equal(journal.page('p1').total, 1);
  assert.equal(journal.recordClosed(item.id, PERSON), null);
});

test('a client hears the move to done before the journal entry it causes, as core wires them', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const bus = new EventBus();
  const emit = (event: ClaudioEventInput) => void bus.emit(event);
  const items = new WorkItemService({ db, project: () => ({ keyPrefix: 'AGN', columnLimits: {} }), emit });
  const journal = new JournalService({ db, emit, item: () => null, sources: () => [] });
  bus.observe((event) => journal.observe(event));
  const heard: ClaudioEvent[] = [];
  bus.subscribe((event) => heard.push(event));

  const item = items.create('p1', { title: 'Close me' });
  items.move(item.id, { status: 'done' });

  // The web drops an id older than one it has seen, so an earlier one arriving late is lost
  assert.deepEqual(heard.map((e) => e.id), heard.map((_, i) => i + 1));
  const kinds = heard.map((e) => e.type);
  assert.ok(kinds.indexOf('workitem.moved') < kinds.indexOf('journal.changed'), kinds.join(', '));
  db.close();
});

test('a flow run is handed the newest entries that fit the cap, newest first and without a hole', () => {
  const { journal } = setup();
  assert.deepEqual(journal.handoff('p1'), { text: '', entries: 0, bytes: 0, lessons: 0, lessonBytes: 0 });

  const big = 'x'.repeat(6_000);
  journal.create('p1', { text: `oldest ${big}` });
  journal.create('p1', { text: `older ${big}` });
  journal.create('p1', { text: `middle ${big}` });
  journal.create('p1', { text: 'small, and newest' });
  const handed = journal.handoff('p1');
  assert.equal(handed.entries, 3);
  assert.ok(handed.bytes <= JOURNAL_HANDOFF_BYTES);
  assert.ok(handed.text.indexOf('small, and newest') < handed.text.indexOf('middle'));
  assert.ok(!handed.text.includes('oldest'));
  assert.deepEqual(journal.page('p1').handed, { entries: 3, bytes: handed.bytes, lessons: 0, lessonBytes: 0 });
  // The entries are people's words and runs' summaries: one pasted block, and the note after it
  assert.match(handed.text, /^# Project journal\n[^]*\n<pasted_content id="([0-9a-f]{8})">\n- [^]*small, and newest[^]*\n<\/pasted_content id="\1">\n\n/);
  assert.ok(handed.text.includes(PASTED_NOTE));
  assert.equal(handed.bytes, Buffer.byteLength(handed.text));
});

test('removing an entry announces it and unknown ones are refused', () => {
  const { journal, events } = setup();
  const entry = journal.create('p1', { text: 'Gone soon' });
  events.length = 0;
  journal.remove(entry.id);
  assert.equal(journal.find(entry.id), null);
  assert.deepEqual(
    events.map((e) => (e.type === 'journal.changed' ? e.action : e.type)),
    ['removed'],
  );
  assert.throws(() => journal.remove(entry.id), refusal(404));
});

// ---------- memory proposals ----------

const RULE_ORIGIN = { proposedBy: QA, source: { kind: 'chat' as const, chatId: 'qa-chat', orchestrationId: null, taskId: null }, flowRunId: 'run-1' };
const rule = (file: string, paths: string[] | null, text?: string) => proposal({ kind: 'rule', file, section: null, paths }, text);

test('a rule target is validated: a rule file name and 1 to 10 relative globs', () => {
  const { proposals } = setup();
  const refused = (file: string, paths: string[] | null, message: RegExp) =>
    assert.throws(
      () => proposals.propose('p1', rule(file, paths), RULE_ORIGIN),
      (err: unknown) => err instanceof WorkItemError && err.statusCode === 400 && message.test(err.message),
    );
  refused('tests.md', ['../src/**'], /\.\./);
  refused('tests.md', ['/etc/**'], /absolute/);
  refused('tests.md', Array.from({ length: 11 }, (_, i) => `d${String(i)}/**`), /more than 10/);
  refused('tests.md', [], /at least one glob/);
  refused('tests.md', null, /at least one glob/);
  refused('tests.md', ['a"b'], /character/);
  refused('tests', ['src/**'], /rule file/);
  refused('../tests.md', ['src/**'], /rule file/);
  assert.equal(proposals.list('p1', 'pending').length, 0);
});

test('a rule proposal keeps its paths, and approving it writes .claude/rules/<file> with them as front matter', async () => {
  const { proposals, projectDir } = setup();
  const made = proposals.propose('p1', rule('migrations.md', ['packages/core/src/db.ts', 'apps/**/*.{ts,tsx}']), RULE_ORIGIN);
  assert.deepEqual(made.target, { kind: 'rule', file: 'migrations.md', section: null, paths: ['packages/core/src/db.ts', 'apps/**/*.{ts,tsx}'] });
  assert.deepEqual(proposals.list('p1')[0]?.target.paths, ['packages/core/src/db.ts', 'apps/**/*.{ts,tsx}']);
  assert.equal(existsSync(join(projectDir, '.claude', 'rules', 'migrations.md')), false);

  const approved = await proposals.approve(made.id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.target.paths?.length, 2);
  assert.equal(
    readFileSync(join(projectDir, '.claude', 'rules', 'migrations.md'), 'utf8'),
    '---\npaths:\n  - "packages/core/src/db.ts"\n  - "apps/**/*.{ts,tsx}"\n---\n\nRun the tests with --test-concurrency=1\n',
  );
  assert.equal(existsSync(join(projectDir, 'CLAUDE.md')), false, 'a rule never touches CLAUDE.md');
});

test('approving a rule appends to a rule with the same paths and refuses one with other paths, until it is renamed', async () => {
  const { proposals, projectDir } = setup();
  const file = join(projectDir, '.claude', 'rules', 'tests.md');
  await proposals.approve(proposals.propose('p1', rule('tests.md', ['src/**', 'test/**']), RULE_ORIGIN).id);

  // The same paths in another order: the text is appended
  const same = proposals.propose('p1', rule('tests.md', ['test/**', 'src/**'], 'Name tests after the behaviour'), RULE_ORIGIN);
  await proposals.approve(same.id);
  assert.match(readFileSync(file, 'utf8'), /Run the tests with --test-concurrency=1\n\nName tests after the behaviour\n$/);

  // Other paths: 409, the proposal stays pending and nothing is written
  const other = proposals.propose('p1', rule('tests.md', ['docs/**'], 'Docs are English'), RULE_ORIGIN);
  const before = readFileSync(file, 'utf8');
  await assert.rejects(
    proposals.approve(other.id),
    (err: unknown) => err instanceof WorkItemError && err.statusCode === 409 && /\.claude\/rules\/tests\.md exists with other paths; approve it under another name/.test(err.message),
  );
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(proposals.find(other.id)?.status, 'pending');

  // Renamed in the approval: written to the new file, and the proposal says where it went
  const renamed = await proposals.approve(other.id, { file: 'docs.md' });
  assert.equal(renamed.target.file, 'docs.md');
  assert.match(readFileSync(join(projectDir, '.claude', 'rules', 'docs.md'), 'utf8'), /^---\npaths:\n {2}- "docs\/\*\*"\n---\n\nDocs are English\n$/);
  await assert.rejects(proposals.approve(proposals.propose('p1', rule('x.md', ['a/**']), RULE_ORIGIN).id, { file: '../x.md' }), refusal(400));
});

test('a rule file that has no paths counts as a rule with other paths', async () => {
  const { proposals, projectDir } = setup();
  mkdirSync(join(projectDir, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(projectDir, '.claude', 'rules', 'all.md'), 'Applies everywhere\n');
  await assert.rejects(proposals.approve(proposals.propose('p1', rule('all.md', ['src/**']), RULE_ORIGIN).id), refusal(409));
});

test('a proposal writes nothing anywhere until a person approves it', () => {
  const { proposals, journal, projectDir, memoryDir, events } = setup();
  const origin = { proposedBy: QA, source: { kind: 'chat' as const, chatId: 'qa-chat', orchestrationId: null, taskId: null }, flowRunId: 'run-1' };
  const a = proposals.propose('p1', proposal({ kind: 'instructions', file: null, section: 'Testing' }), origin);
  proposals.propose('p1', proposal({ kind: 'memory', file: 'tests.md', section: null }), origin);
  proposals.propose('p1', proposal({ kind: 'journal', file: null, section: null }), origin);

  assert.equal(a.status, 'pending');
  assert.deepEqual(a.proposedBy, QA);
  assert.equal(a.source?.chatId, 'qa-chat');
  assert.equal(a.flowRunId, 'run-1');
  assert.equal(existsSync(join(projectDir, 'CLAUDE.md')), false);
  assert.equal(existsSync(memoryDir), false);
  assert.equal(journal.page('p1').total, 0);
  assert.equal(proposals.list('p1', 'pending').length, 3);
  assert.deepEqual(
    events.map((e) => (e.type === 'memory.proposal' ? `${e.action}:${e.target.kind}:${String(e.role)}` : e.type)),
    ['created:instructions:qa', 'created:memory:qa', 'created:journal:qa'],
  );
});

test('the same entry proposed again, waiting or decided, is the proposal already there', async () => {
  const { proposals, events } = setup();
  const origin = { proposedBy: QA };
  const target = { kind: 'memory' as const, file: 'tests.md', section: null };
  const first = proposals.propose('p1', proposal(target, 'Run the tests with --test-concurrency=1'), origin);
  // The same words with other case and spacing, from another run
  const again = proposals.propose('p1', proposal(target, '  run the tests   with --test-concurrency=1 '), { proposedBy: QA, flowRunId: 'run-2' });
  assert.equal(again.id, first.id);
  // Another target, or other words, is another proposal
  const journal = proposals.propose('p1', proposal({ kind: 'journal', file: null, section: null }, 'Run the tests with --test-concurrency=1'), origin);
  assert.notEqual(journal.id, first.id);
  assert.notEqual(proposals.propose('p1', proposal(target, 'Run the tests serially'), origin).id, first.id);

  // Decided: approved with the person's edit, or rejected, it does not come back either
  await proposals.approve(first.id, { text: 'Run the tests one file at a time' });
  assert.equal(proposals.propose('p1', proposal(target, 'Run the tests with --test-concurrency=1'), origin).id, first.id);
  assert.equal(proposals.propose('p1', proposal(target, 'run the tests one file at a time'), origin).id, first.id);
  proposals.reject(journal.id);
  assert.equal(proposals.propose('p1', proposal({ kind: 'journal', file: null, section: null }, 'Run the tests with --test-concurrency=1'), origin).id, journal.id);

  assert.equal(proposals.list('p1').length, 3);
  assert.equal(events.filter((e) => e.type === 'memory.proposal' && e.action === 'created').length, 3);
});

test('a proposal whose target could never be written is refused when it is made', () => {
  const { proposals } = setup();
  const origin = { proposedBy: QA };
  assert.throws(() => proposals.propose('p1', proposal({ kind: 'memory', file: '../escape.md', section: null }), origin), refusal(400));
  assert.throws(() => proposals.propose('p1', proposal({ kind: 'memory', file: 'MEMORY.md', section: null }), origin), refusal(400));
  assert.throws(() => proposals.propose('p1', proposal({ kind: 'memory', file: null, section: null }), origin), refusal(400));
  assert.throws(() => proposals.propose('p1', proposal({ kind: 'nowhere' as 'journal', file: null, section: null }), origin), refusal(400));
  assert.throws(() => proposals.propose('p1', proposal({ kind: 'journal', file: null, section: null }, '  '), origin), refusal(400));
  assert.throws(() => proposals.list('p1', 'maybe'), refusal(400));
});

test('approving to the journal adds a memory entry by the member, approved by the person', async () => {
  const { proposals, journal, events } = setup();
  const p = proposals.propose('p1', proposal({ kind: 'journal', file: null, section: null }), { proposedBy: QA });
  events.length = 0;
  const approved = await proposals.approve(p.id);
  assert.equal(approved.status, 'approved');
  assert.deepEqual(approved.decidedBy, PERSON);
  assert.ok(approved.decidedAt);
  assert.equal(approved.approvedText, null);
  const [entry] = journal.page('p1').entries;
  assert.equal(entry?.kind, 'memory');
  assert.equal(entry?.id, approved.journalEntryId);
  assert.equal(entry?.proposalId, p.id);
  assert.deepEqual(entry?.author, QA);
  assert.deepEqual(entry?.approvedBy, PERSON);
  assert.deepEqual(
    events.map((e) => e.type),
    ['journal.changed', 'memory.proposal'],
  );

  // Deleting the entry keeps the decision and drops the reference
  journal.remove(entry?.id ?? '');
  assert.equal(proposals.find(p.id)?.journalEntryId, null);
});

test('approving to a memory file creates it with frontmatter and indexes it, then appends to it', async () => {
  const { proposals, memoryDir } = setup();
  const first = proposals.propose('p1', proposal({ kind: 'memory', file: 'tests.md', section: null }), { proposedBy: QA });
  await proposals.approve(first.id);
  const file = readFileSync(join(memoryDir, 'tests.md'), 'utf8');
  assert.match(file, /^---\nname: tests\ndescription: "Parallel runs share the port"\nmetadata:\n {2}type: project\n---\n\nRun the tests with --test-concurrency=1\n$/);
  assert.equal(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), '- [tests](tests.md) — Parallel runs share the port\n');

  const second = proposals.propose('p1', proposal({ kind: 'memory', file: 'tests.md', section: null }, 'Seed with the fake CLI'), { proposedBy: QA });
  const approved = await proposals.approve(second.id, { text: 'Seed the store with the fake CLI' });
  assert.equal(approved.approvedText, 'Seed the store with the fake CLI');
  assert.ok(readFileSync(join(memoryDir, 'tests.md'), 'utf8').endsWith('--test-concurrency=1\n\nSeed the store with the fake CLI\n'));
  // Indexed once, when it was created
  assert.equal(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8').split('\n').filter(Boolean).length, 1);
});

test("approving to the instructions writes under the heading it names in the project's CLAUDE.md", async () => {
  const { proposals, projectDir } = setup();
  const path = join(projectDir, 'CLAUDE.md');
  writeFileSync(path, '# Project\n\n## Testing\n\nUse node:test.\n\n## Style\n\nNo any.\n');
  const p = proposals.propose('p1', proposal({ kind: 'instructions', file: null, section: '## testing' }), { proposedBy: QA });
  assert.equal(p.target.section, 'testing');
  await proposals.approve(p.id);
  assert.equal(readFileSync(path, 'utf8'), '# Project\n\n## Testing\n\nUse node:test.\n\nRun the tests with --test-concurrency=1\n\n## Style\n\nNo any.\n');
});

test('a proposal is decided once, and a target that cannot be written leaves it pending', async () => {
  const { proposals, projects, projectDir } = setup();
  const p = proposals.propose('p1', proposal({ kind: 'journal', file: null, section: null }), { proposedBy: QA });
  const rejected = proposals.reject(p.id, { reason: '  Not a team fact  ' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectReason, 'Not a team fact');
  await assert.rejects(proposals.approve(p.id), refusal(409));
  assert.throws(() => proposals.reject(p.id), refusal(409));
  await assert.rejects(proposals.approve('missing'), refusal(404));

  // CLAUDE.md is a directory here, so writing it fails: the person can try again once it is fixed
  const q = proposals.propose('p1', proposal({ kind: 'instructions', file: null, section: null }), { proposedBy: QA });
  mkdirSync(join(projectDir, 'CLAUDE.md'));
  await assert.rejects(proposals.approve(q.id));
  const after = proposals.find(q.id);
  assert.equal(after?.status, 'pending');
  assert.equal(after?.decidedBy, null);

  projects.delete('p1');
  await assert.rejects(proposals.approve(q.id), refusal(409));
  assert.equal(proposals.find(q.id)?.status, 'pending');
});

test('text lands at the end of its section, in a new section, or at the end of the file', () => {
  assert.equal(withText('', 'Fact', null), 'Fact\n');
  assert.equal(withText('', 'Fact', 'Testing'), '## Testing\n\nFact\n');
  assert.equal(withText('# A\n\nIntro\n', 'Fact', null), '# A\n\nIntro\n\nFact\n');
  assert.equal(withText('# A\n\nIntro\n', 'Fact', 'Testing'), '# A\n\nIntro\n\n## Testing\n\nFact\n');
  // A deeper heading belongs to the section; one of the same level ends it
  assert.equal(withText('## T\n\na\n\n### sub\n\nb\n\n## U\n\nc\n', 'Fact', 'T'), '## T\n\na\n\n### sub\n\nb\n\nFact\n\n## U\n\nc\n');
  // A heading inside a code fence is not one
  assert.equal(withText('## T\n\n```\n## U\n```\n', 'Fact', 'U'), '## T\n\n```\n## U\n```\n\n## U\n\nFact\n');
  // The last section of the file
  assert.equal(withText('# A\n\n## T\n\nold\n', 'Fact', 'T'), '# A\n\n## T\n\nold\n\nFact\n');
});

test('lessons open the handoff and count against its cap; the note is written once', () => {
  const { journal: plain, db, events } = setup();
  const section = renderSection(
    [{ id: 'a', key: 'L-1', projectId: 'p1', status: 'active', trigger: 'When adding a dependency', action: 'use pnpm.', confidence: 0.9, effectiveConfidence: 0.9, delivered: true, seenCount: 1, pinned: false, overrides: null, lastConfirmedAt: '2026-10-01T00:00:00.000Z' } as never],
    2048,
  );
  const journal = new JournalService({ db, emit: (e) => void events.push(e), lessons: (id) => (id === 'p1' ? section : { text: '', lessons: [], bytes: 0, overBudget: 0 }) });
  // Lessons and no entries: the section and the note, where the journal alone would be empty
  const only = journal.handoff('p1');
  assert.equal(only.entries, 0);
  assert.equal(only.lessons, 1);
  assert.equal(only.lessonBytes, section.bytes);
  assert.equal(only.text, `${section.text}\n${PASTED_NOTE}\n`);
  assert.deepEqual(journal.handoff('p2'), { text: '', entries: 0, bytes: 0, lessons: 0, lessonBytes: 0 });

  const big = 'x'.repeat(3_800);
  for (const text of [`oldest ${big}`, `older ${big}`, `middle ${big}`, `newer ${big}`]) plain.create('p1', { text });
  assert.equal(plain.handoff('p1').entries, 4);
  const handed = journal.handoff('p1');
  assert.ok(handed.text.startsWith('## Lessons\n'));
  assert.ok(handed.text.indexOf('## Lessons') < handed.text.indexOf('# Project journal'));
  assert.equal(handed.text.split(PASTED_NOTE).length - 1, 1);
  assert.ok(handed.bytes <= JOURNAL_HANDOFF_BYTES);
  assert.equal(handed.bytes, Buffer.byteLength(handed.text));
  // The lessons took bytes the entries would have had: the oldest big one no longer fits
  assert.equal(handed.entries, 3);
  assert.ok(!handed.text.includes('oldest'));
  assert.deepEqual(journal.page('p1').handed, { entries: 3, bytes: handed.bytes, lessons: 1, lessonBytes: section.bytes });
  db.close();
});
