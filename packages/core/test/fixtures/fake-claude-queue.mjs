#!/usr/bin/env node
// Stands in for `claude -p --input-format stream-json` in the message-delivery audit
// (docs/reports/chat-audit/server.md). It keeps the queue the real CLI keeps, as its own transcripts
// show it (`queue-operation` lines): a user message that arrives while a turn runs is enqueued, and
// when the turn ends, or an interrupt ends it, every queued message is dequeued and read as one
// prompt, their texts joined by a newline.
//
//   HOLD <file>      the turn emits nothing until <file> exists, then answers and ends
//   SILENT <file>    the same, but the turn first streams a `message_start` partial, the way a turn
//                    that is thinking looks before its first whole message
//   AGENT <file>     the turn calls a foreground `Agent` and waits on it until <file> exists or the
//                    call is sent to the background (`background_tasks`); at that tool boundary it
//                    takes in what was queued (reading each back), then answers and ends
//   BG <file>        the turn starts a command in the background and ends; the task runs until
//                    <file> exists, then its notification comes (and the process stays up for it
//                    after its input closes, as the CLI does)
//   DROP …           queued during a turn, it is dropped when the turn ends, as a `UserPromptSubmit`
//                    hook that ends the prompt drops it: never read back, never run
//   (anything)       the turn answers and ends at once
//
//   FAKE_QUEUE_LOG=<file>   appends one JSON line per thing it did: { op: 'turn', prompt },
//                           { op: 'enqueue', text }, { op: 'control', subtype }, { op: 'eof' },
//                           { op: 'absorb', uuid }, { op: 'dropped', text }, { op: 'cancelled', uuid },
//                           { op: 'background', toolUseId }
//   FAKE_LINGER_MS=<ms>     stays up that long after stdin closes, as the CLI does while it finishes
//   FAKE_QUEUE_LOG_IDS=1    also logs { op: 'stdin', uuid } for every user line, with the `uuid` the
//                           line carried (null when it had none): how a test sees whether the wrapper
//                           gave the CLI an id it could match the message by
//   FAKE_CLOSE_GAP_MS=<ms>  on its way out, leaves a child holding its stdout open that long: the
//                           process has exited and its pipes have not closed yet
//   FAKE_INIT_VERSION=<v>   reports that CLI version in its init (`claude_code_version`), as the real
//                           CLI does; without it the init names none
//   FAKE_NO_RECEIPT=1       answers an interrupt with nothing, as a CLI older than `still_queued` did
//   FAKE_SKIP_FIRST_REPLAY=1  reads back nothing of its first turn, as a local command's turn does
//
// With `--replay-user-messages` it reads each message back as the CLI does (checked on CLI 2.1.288,
// docs/reports/chat-audit/server.md): a `user` line with `isReplay: true` and the `uuid` it was sent
// with, the moment a turn takes it. A merged prompt reads back every message in it. An interrupt is
// answered with `still_queued`, the uuids still in its queue, before the interrupted turn's result.
import { appendFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args[0] === 'agents') {
  process.stdout.write('[]\n');
  process.exit(0);
}
if (args[0] === '--version') {
  process.stdout.write('2.1.0 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth') {
  process.stdout.write('{"loggedIn":false}\n');
  process.exit(0);
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sessionId = flag('--session-id') ?? flag('--resume') ?? randomUUID();
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const log = (entry) => {
  if (process.env.FAKE_QUEUE_LOG) appendFileSync(process.env.FAKE_QUEUE_LOG, `${JSON.stringify(entry)}\n`);
};

/** The turn running now: how to end it early, and the foreground call it waits on */
let running = null;
const queue = [];
const replays = args.includes('--replay-user-messages');
let inputClosed = false;
let turns = 0;
let calls = 0;
/** Background tasks still running, by task id */
const background = new Set();

const replay = (uuid, content) => out({ type: 'user', isReplay: true, uuid, session_id: sessionId, message: { role: 'user', content } });

function startTurn(prompt, ids = []) {
  log({ op: 'turn', prompt });
  turns++;
  const silentReplay = turns === 1 && process.env.FAKE_SKIP_FIRST_REPLAY === '1';
  if (replays && !silentReplay) for (const uuid of ids) replay(uuid, prompt);
  out({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: process.cwd(),
    model: 'fake',
    permissionMode: 'default',
    tools: [],
    ...(process.env.FAKE_INIT_VERSION ? { claude_code_version: process.env.FAKE_INIT_VERSION } : {}),
  });
  const hold = /^(HOLD|SILENT|AGENT|BG) (\S+)/m.exec(prompt);
  let timer = null;
  const finish = (interrupted) => {
    if (timer) clearInterval(timer);
    running = null;
    if (interrupted) {
      out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, total_cost_usd: 0.01 });
    } else {
      out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: `answered: ${prompt}` }] } });
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: `answered: ${prompt}` });
    }
    next();
  };
  running = { finish, call: null };
  if (!hold) return finish(false);
  if (hold[1] === 'BG') return backgroundCommand(hold[2], finish);
  if (hold[1] === 'AGENT') return foregroundAgent(hold[2], finish);
  if (hold[1] === 'SILENT') out({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { role: 'assistant' } } });
  timer = setInterval(() => {
    if (existsSync(hold[2])) finish(false);
  }, 20);
}

/** A tool boundary: what waits in the queue is taken into the turn under way, each read back as it is */
function absorb() {
  for (const message of queue.splice(0)) {
    if (/^DROP\b/.test(message.text)) {
      log({ op: 'dropped', text: message.text });
      continue;
    }
    log({ op: 'absorb', uuid: message.uuid });
    if (replays && message.uuid) replay(message.uuid, message.text);
  }
}

function foregroundAgent(file, finish) {
  const id = `toolu_agent_${++calls}`;
  out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'look around the repository', prompt: 'look around', subagent_type: 'general-purpose' } }] } });
  const settle = (text) => {
    clearInterval(timer);
    if (!running || running.call?.id !== id) return;
    running.call = null;
    out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
    absorb();
    finish(false);
  };
  const timer = setInterval(() => {
    if (existsSync(file)) settle('the agent is done');
  }, 20);
  running.call = { id, background: () => settle('Agent is running in the background; you will be told when it finishes.') };
  const previous = running.finish;
  running.finish = (interrupted) => {
    clearInterval(timer);
    previous(interrupted);
  };
}

function backgroundCommand(file, finish) {
  const id = `toolu_bg_${++calls}`;
  const taskId = `bg_${calls}`;
  out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 999', description: 'wait in the background', run_in_background: true } }] } });
  out({ type: 'system', subtype: 'task_started', session_id: sessionId, task_id: taskId, task_type: 'local_bash', tool_use_id: id, description: 'wait in the background' });
  out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${taskId}.` }] } });
  background.add(taskId);
  const timer = setInterval(() => {
    if (!existsSync(file)) return;
    clearInterval(timer);
    background.delete(taskId);
    out({ type: 'system', subtype: 'task_notification', session_id: sessionId, task_id: taskId, status: 'completed', summary: 'done waiting' });
    if (inputClosed && !running && queue.length === 0 && background.size === 0) leave();
  }, 20);
  finish(false);
}

/** What the CLI does once a turn is over: everything queued is read as the next prompt */
function next() {
  for (const message of queue.filter((m) => /^DROP\b/.test(m.text))) log({ op: 'dropped', text: message.text });
  const taken = queue.splice(0).filter((m) => !/^DROP\b/.test(m.text));
  if (taken.length > 0) {
    const prompt = taken.map((m) => m.text).join('\n');
    setImmediate(() => startTurn(prompt, taken.flatMap((m) => (m.uuid ? [m.uuid] : []))));
    return;
  }
  if (inputClosed && background.size === 0) leave();
}

function leave() {
  setTimeout(() => {
    const gap = Number(process.env.FAKE_CLOSE_GAP_MS ?? 0);
    if (gap > 0) spawn('sleep', [String(gap / 1000)], { stdio: ['ignore', 'inherit', 'ignore'], detached: true }).unref();
    process.exit(0);
  }, Number(process.env.FAKE_LINGER_MS ?? 0));
}

function control(msg) {
  const request = msg.request ?? {};
  const subtype = request.subtype;
  log({ op: 'control', subtype });
  const answer = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
  if (subtype === 'interrupt') {
    // Written before the interrupted turn's result: what survives the interrupt is what is queued
    answer(process.env.FAKE_NO_RECEIPT === '1' ? {} : { still_queued: queue.flatMap((m) => (m.uuid ? [m.uuid] : [])) });
    if (running) running.finish(true);
    return;
  }
  if (subtype === 'background_tasks') {
    const call = running?.call;
    if (!call || call.id !== request.tool_use_id) return answer({ backgrounded: false });
    log({ op: 'background', toolUseId: call.id });
    answer({ backgrounded: true });
    call.background();
    return;
  }
  if (subtype === 'cancel_async_message') {
    const at = queue.findIndex((m) => m.uuid === request.message_uuid);
    if (at === -1) return answer({ cancelled: false });
    queue.splice(at, 1);
    log({ op: 'cancelled', uuid: request.message_uuid });
    return answer({ cancelled: true });
  }
  answer({});
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'user') {
    const content = msg.message?.content;
    const text = typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('\n');
    if (process.env.FAKE_QUEUE_LOG_IDS === '1') log({ op: 'stdin', text, uuid: typeof msg.uuid === 'string' ? msg.uuid : null });
    const uuid = typeof msg.uuid === 'string' ? msg.uuid : null;
    if (running) {
      log({ op: 'enqueue', text });
      queue.push({ text, uuid });
    } else startTurn(text, uuid ? [uuid] : []);
    return;
  }
  if (msg.type === 'control_request') control(msg);
});
lines.on('close', () => {
  log({ op: 'eof' });
  inputClosed = true;
  if (!running && queue.length === 0 && background.size === 0) leave();
});
