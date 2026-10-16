import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContentBlock, PermissionRequest, TranscriptEntry } from '@claudio/shared';
import { Db } from '../src/db.ts';
import { recognizeSecrets, redactState, SECRET_MASK } from '../src/decisions/redact.ts';
import { assembleMinerInput } from '../src/lessons/input.ts';
import { CORRECTION_FOLD, SignalRecorder } from '../src/lessons/signals.ts';
import { tempConfig } from './helpers.ts';

// The three points where lessons redact (docs/plans/lessons.md, "Security and privacy"), with
// Claudio's own secrets registered: the signal rows, the state the gate sends through the decision
// engine, and what the miner is shown. One secret is kept in plain (like the Jev key), one only as a
// hash (like the owner's token), so it is recognised only as a whole word.

const PLAIN = 'jev-live-0123456789abcdef';
const HASHED = 'Zk9QmX4tR7vLw2NcBd8HsYe5JuAa3GfTq6PoIn1K';

function own(): () => void {
  return recognizeSecrets({ values: () => [PLAIN], isSecret: (word) => word === HASHED });
}

const entry = (uuid: string, role: 'user' | 'assistant', blocks: ContentBlock[]): TranscriptEntry => ({
  uuid,
  role,
  timestamp: null,
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks,
});
const say = (uuid: string, role: 'user' | 'assistant', text: string) => entry(uuid, role, [{ type: 'text', text }]);

test('point 1, signal rows: a deny, a rewind and a rejection hold none of the secrets', () => {
  const forget = own();
  const db = new Db(tempConfig());
  try {
    const recorder = new SignalRecorder({ db, mode: () => 'active' });
    const chat = { chatId: 'chat-1', projectId: 'proj-1' };
    const request: PermissionRequest = {
      id: 'p1',
      runId: 'chat-1',
      toolName: 'Bash',
      toolUseId: 'toolu_1',
      input: { command: `T="${HASHED}"; deploy --key ${PLAIN}` },
      requestedAt: '2026-10-16T10:00:00.000Z',
    };
    const rows = [
      recorder.denied(request, { behavior: 'deny', message: `no, not with ${PLAIN} or ${HASHED}` }, chat),
      recorder.rewound(chat, 'uuid-1', `ran ${PLAIN} and ${HASHED}`),
      recorder.rejectedProposal(chat, `it wrote ${HASHED}`, `Proposal with ${PLAIN}`),
    ];
    assert.ok(rows.every((r) => r !== null));
    const stored = (db.connection.prepare('SELECT detail FROM lesson_signals').all() as Array<{ detail: string }>).map((r) => r.detail).join('\n');
    for (const secret of [PLAIN, HASHED]) assert.equal(stored.includes(secret), false);
    assert.ok(stored.includes(SECRET_MASK));
  } finally {
    db.close();
    forget();
  }
});

test('point 1, signal rows: a secret across the cut of an error is masked before the cut, not left as a prefix', () => {
  const forget = own();
  try {
    const state = CORRECTION_FOLD.init();
    const call = (id: string) => ({ type: 'assistant', uuid: `a-${id}`, timestamp: '2026-10-16T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'make' } }] } });
    // The token starts 20 characters before the 300-character cut: 20 of 40 are kept by a plain slice, which no mask recognises
    const failure = `${'e'.repeat(280)} ${HASHED} tail`;
    const result = (id: string) => ({
      type: 'user',
      uuid: `r-${id}`,
      timestamp: '2026-10-16T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: failure, is_error: true }] },
    });
    for (const line of [call('t1'), result('t1'), call('t2'), result('t2')]) CORRECTION_FOLD.add(state, line);
    assert.equal(state.repeated.length, 1);
    const context = state.repeated[0]?.context ?? '';
    assert.equal(context.includes(HASHED.slice(0, 15)), false, context);
    // The command is cut at 120 characters the same way
    const long = CORRECTION_FOLD.init();
    CORRECTION_FOLD.add(long, { type: 'assistant', uuid: 'a1', timestamp: '2026-10-16T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: `${'c'.repeat(100)} ${HASHED}` } }] } });
    assert.equal((long.lastAction ?? '').includes(HASHED.slice(0, 15)), false, String(long.lastAction));
  } finally {
    forget();
  }
});

test('point 2, the engine state: the gate signals are masked and cut by redactState', () => {
  const forget = own();
  try {
    const state = redactState(
      { signals: [{ id: 'S1', kind: 'correction', quote: `use ${PLAIN} then ${HASHED}`, context: `Bash: echo ${HASHED}` }], token: HASHED },
      4096,
    );
    const text = JSON.stringify(state);
    for (const secret of [PLAIN, HASHED]) assert.equal(text.includes(secret), false);
    assert.ok(text.includes(SECRET_MASK));
  } finally {
    forget();
  }
});

test('point 3, the miner input: quote, agent text, tool lines, context, lessons and CLAUDE.md are masked', () => {
  const forget = own();
  try {
    const entries = [
      say('a1', 'assistant', `I will use ${PLAIN} for this`),
      entry('a2', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `deploy --key ${HASHED}` } }]),
      say('u1', 'user', `no, never ${HASHED}`),
      say('a3', 'assistant', `Understood, dropping ${PLAIN}`),
    ];
    const input = assembleMinerInput({
      entries,
      sinceUuid: null,
      signals: [
        { kind: 'correction', entryUuid: 'u1', quote: `no, never ${HASHED}` },
        { kind: 'repeated-error', entryUuid: null, quote: '', context: `Bash failed: ${PLAIN}` },
      ],
      lessons: [{ key: 'L-1', trigger: `When using ${PLAIN}`, action: 'Ask first' }],
      instructions: `Keys: ${HASHED}\nUse ${PLAIN}`,
    });
    const all = input.signalsBlock + input.lessonsBlock + input.instructionsBlock;
    for (const secret of [PLAIN, HASHED]) assert.equal(all.includes(secret), false);
    assert.ok(all.includes(SECRET_MASK));
  } finally {
    forget();
  }
});
