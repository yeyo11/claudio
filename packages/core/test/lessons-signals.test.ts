import assert from 'node:assert/strict';
import test from 'node:test';
import type { PermissionRequest } from '@claudio/shared';
import { RESUME_PROMPT } from '../src/assistant-answer.ts';
import { CANCEL_NOTICE_PREFIX, CHAT_HINT_PREFIX } from '../src/chat-service.ts';
import { Db } from '../src/db.ts';
import { PERMISSION_TIMEOUT_MESSAGE } from '../src/permissions.ts';
import { CONTINUATION_PREFIX, continuationPrompt } from '../src/open-items.ts';
import { ORCHESTRATION_HINT_PREFIX } from '../src/orchestrator.ts';
import {
  CORRECTION_FOLD,
  SignalRecorder,
  matchesLexicon,
  normalizeError,
  signalsOf,
  type CorrectionContext,
  type CorrectionSignal,
  type CorrectionState,
} from '../src/lessons/signals.ts';
import { tempConfig } from './helpers.ts';

let n = 0;
const at = () => `2026-10-16T10:00:${String(n).padStart(2, '0')}.000Z`;
const user = (text: string) => ({ type: 'user', uuid: `u${++n}`, timestamp: at(), message: { role: 'user', content: text } });
const marker = (text: string) => ({ type: 'user', uuid: `u${++n}`, timestamp: at(), message: { role: 'user', content: [{ type: 'text', text }] } });
const call = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  uuid: `a${++n}`,
  timestamp: at(),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: string, isError = false) => ({
  type: 'user',
  uuid: `r${++n}`,
  timestamp: at(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});

function fold(lines: Array<Record<string, unknown>>): CorrectionState {
  const state = CORRECTION_FOLD.init();
  for (const line of lines) CORRECTION_FOLD.add(state, line);
  return state;
}
const kinds = (signals: CorrectionSignal[]) => signals.map((s) => s.kind);
const person: CorrectionContext = { driven: false };
const edit = (id: string, path: string, from: string, to: string) => call(id, 'Edit', { file_path: path, old_string: from, new_string: to });

test('the lexicon matches English and Spanish, whole words only', () => {
  for (const text of ["don't do that", 'Never use npm', 'use pnpm instead', 'I said pnpm', 'no uses npm', 'así no', 'en vez de eso', 'deshaz el cambio', 'ya te dije que no']) {
    assert.ok(matchesLexicon(text), text);
  }
  // "know", "now", "another" and "notes" hold "no" or "not" without being one
  for (const text of ['I know the answer', 'run it now', 'add another test', 'update the notes', 'looks good, thanks']) {
    assert.equal(matchesLexicon(text), false, text);
  }
});

test('a correction needs an agent action before it, and a lexicon hit, an interrupt or an opening negation', () => {
  const signals = signalsOf(
    fold([
      user('add a cart total'),
      call('t1', 'Edit', { file_path: 'src/cart.ts', old_string: 'a', new_string: 'b' }),
      result('t1', 'ok'),
      user('No, keep it in cents'),
      user('thanks, that works'),
    ]),
    person,
  );
  assert.deepEqual(kinds(signals), ['correction']);
  assert.equal(signals[0]?.quote, 'No, keep it in cents');
  assert.equal(signals[0]?.context, 'Edit src/cart.ts');
});

test('a first prompt that says "no" is not a correction: nothing came before it', () => {
  assert.deepEqual(kinds(signalsOf(fold([user("don't touch the lockfile, just read it")]), person)), []);
});

test('a message after an interrupt counts and is weighed; the interrupt alone is not a signal', () => {
  const state = fold([user('run the tests'), call('t1', 'Bash', { command: 'npm test' }), marker('[Request interrupted by user for tool use]')]);
  assert.deepEqual(kinds(signalsOf(state, person)), []);
  const after = signalsOf(fold([user('run the tests'), call('t1', 'Bash', { command: 'npm test' }), marker('[Request interrupted by user]'), user('use pnpm')]), person);
  assert.deepEqual(kinds(after), ['correction']);
  assert.equal(after[0]?.afterInterrupt, true);
});

test('hints and cancels are recognised by the prefixes their writers export, and the prefix stays out of the quote', () => {
  const signals = signalsOf(
    fold([
      user('start'),
      call('t1', 'Bash', { command: 'sleep 100' }),
      user(`${CHAT_HINT_PREFIX}\n\nlook at the config first`),
      user(`${ORCHESTRATION_HINT_PREFIX}\n\nuse the staging db`),
      user(`${CANCEL_NOTICE_PREFIX} \`sleep 100\` while it was running: too slow. It did not fail by itself.`),
    ]),
    // In a driven chat the plain first prompt is Claudio's, but hints and cancels are the person's
    { driven: true },
  );
  assert.deepEqual(kinds(signals), ['hint', 'hint', 'cancelled']);
  assert.equal(signals[0]?.quote, 'look at the config first');
  assert.equal(signals[1]?.quote, 'use the staging db');
  assert.ok(signals[2]?.quote.includes('too slow'));
});

test("Claudio's nudges are nobody's words", () => {
  const state = fold([
    user('refine this item'),
    call('t1', 'Read', { file_path: 'a.md' }),
    user(continuationPrompt(['an open item'], 1)),
    user(RESUME_PROMPT),
    user(`${CONTINUATION_PREFIX}, never stop`),
  ]);
  assert.deepEqual(kinds(signalsOf(state, person)), []);
  assert.deepEqual(state.messages.map((m) => m.text), ['refine this item']);
});

test("a flow chat's first prompt is not a person message; lines after a hand-back are", () => {
  const state = fold([
    user('Refine the item. Never move it to done.'),
    call('t1', 'Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }),
    result('t1', 'ok'),
    user("no, don't edit that file"),
  ]);
  assert.deepEqual(kinds(signalsOf(state, { driven: true })), []);
  const handedBackAt = state.messages[1]?.at ?? '';
  assert.deepEqual(kinds(signalsOf(state, { driven: true, handedBackAt })), ['correction']);
  assert.deepEqual(kinds(signalsOf(state, { driven: true, handedBackAt: '2099-01-01T00:00:00.000Z' })), []);
});

test('an edit swapped back is a revert, but only after a person message', () => {
  const before = fold([user('rename foo'), edit('t1', 'src/a.ts', 'foo', 'bar'), edit('t2', 'src/a.ts', 'bar', 'foo')]);
  assert.equal(kinds(signalsOf(before, { driven: true })).includes('reverted'), false);
  const after = fold([user('rename foo'), edit('t1', 'src/a.ts', 'foo', 'bar'), user('undo that'), edit('t2', 'src/a.ts', 'bar', 'foo')]);
  assert.equal(kinds(signalsOf(after, person)).includes('reverted'), true);
  // Another path is another file
  const other = fold([user('rename foo'), edit('t1', 'src/a.ts', 'foo', 'bar'), user('undo that'), edit('t2', 'src/b.ts', 'bar', 'foo')]);
  assert.equal(kinds(signalsOf(other, person)).includes('reverted'), false);
});

test('git restore, checkout --, revert, reset --hard and stash count after a person message only', () => {
  for (const command of ['git restore src/a.ts', 'git checkout -- src/a.ts', 'git revert HEAD', 'git reset --hard HEAD~1', 'git stash']) {
    const early = fold([user('fix it'), call('t1', 'Bash', { command })]);
    assert.equal(kinds(signalsOf(early, { driven: true })).includes('reverted'), false, `${command} before any person message`);
    const late = fold([user('fix it'), call('t0', 'Read', { file_path: 'a' }), user('that is wrong'), call('t1', 'Bash', { command })]);
    assert.equal(kinds(signalsOf(late, person)).includes('reverted'), true, command);
  }
  const plain = fold([user('fix it'), user('that is wrong'), call('t1', 'Bash', { command: 'git status' })]);
  assert.equal(kinds(signalsOf(plain, person)).includes('reverted'), false);
});

test('errors are normalised, and the same failure three times is a repeated error that triggers only when asked', () => {
  assert.equal(normalizeError("ENOENT: no such file '/home/me/a.ts' line 12 at 0xdeadbeef"), normalizeError("ENOENT: no such file '/tmp/x/b.ts' line 99 at 0xcafe1234"));
  const lines: Array<Record<string, unknown>> = [user('build it')];
  for (const [i, file] of ['/a/1.ts', '/b/22.ts', '/c/333.ts'].entries()) {
    lines.push(call(`t${i}`, 'Read', { file_path: file }), result(`t${i}`, `ENOENT: no such file ${file} (code ${i})`, true));
  }
  const state = fold(lines);
  const quiet = signalsOf(state, person).filter((s) => s.kind === 'repeated-error');
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0]?.triggers, false);
  assert.equal(signalsOf(state, { ...person, repeatedErrorsTrigger: true }).find((s) => s.kind === 'repeated-error')?.triggers, true);
});

test('the same Bash command failing twice in a row is a repeated error; a person decline is not a failure', () => {
  const twice = fold([user('go'), call('t1', 'Bash', { command: 'pnpm lint' }), result('t1', 'exit 1', true), call('t2', 'Bash', { command: 'pnpm lint' }), result('t2', 'exit 1', true)]);
  assert.equal(signalsOf(twice, person).filter((s) => s.kind === 'repeated-error').length, 1);
  const declined = fold([
    user('go'),
    call('t1', 'Bash', { command: 'npm i' }),
    result('t1', "The user doesn't want to proceed with this tool use.", true),
    call('t2', 'Bash', { command: 'npm i' }),
    result('t2', "The user doesn't want to proceed with this tool use.", true),
  ]);
  assert.equal(signalsOf(declined, person).filter((s) => s.kind === 'repeated-error').length, 0);
});

test('the fold keeps no tool output, and a clone folds on without touching the original', () => {
  const state = fold([user('go'), call('t1', 'Read', { file_path: 'secret.env' }), result('t1', 'TOKEN=abc123 very long file body')]);
  assert.equal(JSON.stringify(state.messages).includes('abc123'), false);
  const copy = CORRECTION_FOLD.clone(state);
  CORRECTION_FOLD.add(copy, user('no, wrong file'));
  assert.equal(state.messages.length, 1);
  assert.equal(copy.messages.length, 2);
});

// ---------- rows ----------

function recorder(mode: 'off' | 'shadow' | 'active') {
  const db = new Db(tempConfig());
  return { db, recorder: new SignalRecorder({ db, mode: () => mode }) };
}

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'p1',
  runId: 'chat-1',
  toolName: 'Bash',
  toolUseId: 'toolu_1',
  input: { command: 'npm install lodash' },
  requestedAt: '2026-10-16T10:00:00.000Z',
  ...over,
});

test('with lesson.mine off, no lesson_signals row is written', () => {
  const { db, recorder: off } = recorder('off');
  try {
    const chat = { chatId: 'chat-1', projectId: 'proj-1' };
    assert.equal(off.denied(request(), { behavior: 'deny', message: 'use pnpm' }, chat), null);
    assert.equal(off.rewound(chat, 'uuid-1'), null);
    assert.equal(off.rejectedProposal(chat, 'not our style', 'Proposal'), null);
    const count = db.connection.prepare('SELECT COUNT(*) AS n FROM lesson_signals').get() as { n: number };
    assert.equal(count.n, 0);
  } finally {
    db.close();
  }
});

test('a deny a person wrote is recorded, redacted; automatic denies, allows and withdrawals are not', () => {
  const { db, recorder: shadow } = recorder('shadow');
  try {
    const chat = { chatId: 'chat-1', projectId: 'proj-1' };
    const row = shadow.denied(
      request({ input: { command: 'curl -H "Authorization: Bearer sk-ant-abcdefghijklmnop" x' } }),
      { behavior: 'deny', message: 'No uses npm, SECRET_TOKEN=hunter2hunter2' },
      chat,
    );
    assert.ok(row);
    assert.equal(row.kind, 'denied');
    assert.ok(row.quote.startsWith('No uses npm'));
    assert.equal(row.quote.includes('hunter2'), false);
    assert.equal(row.context.includes('sk-ant-abcdefghijklmnop'), false);
    assert.equal(shadow.denied(request(), { behavior: 'deny', message: PERMISSION_TIMEOUT_MESSAGE }, chat), null);
    assert.equal(shadow.denied(request(), { behavior: 'allow' }, chat), null);
    assert.equal(shadow.denied(request(), null, chat), null);
    assert.equal(shadow.denied(request(), { behavior: 'deny', message: 'no' }, { chatId: 'chat-1', projectId: null }), null);
    assert.equal(shadow.forChat('chat-1').length, 1);
  } finally {
    db.close();
  }
});

test('a rewind keeps the abandoned text cut to 500 bytes; a rejection needs a reason', () => {
  const { db, recorder: active } = recorder('active');
  try {
    const chat = { chatId: 'chat-1', projectId: 'proj-1' };
    const rewound = active.rewound(chat, 'uuid-9', 'x'.repeat(2_000));
    assert.equal(rewound?.kind, 'rewound');
    assert.equal(rewound?.entryUuid, 'uuid-9');
    assert.ok((rewound?.context.length ?? 0) <= 500);
    assert.equal(active.rejectedProposal(chat, '   ', 'Proposal: X'), null);
    assert.equal(active.rejectedProposal(chat, undefined, 'Proposal: X'), null);
    const rejected = active.rejectedProposal(chat, 'We never mock the database', 'Proposal: mock db');
    assert.equal(rejected?.quote, 'We never mock the database');
    assert.deepEqual(active.forChat('chat-1').map((r) => r.kind), ['rewound', 'rejected-proposal']);
  } finally {
    db.close();
  }
});
