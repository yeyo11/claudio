#!/usr/bin/env node
// Stands in for `claude -p` under the OpenAI-compatible routes: a stream-json process that takes
// several turns, streams each answer as text deltas and then as the whole assistant message, and
// reports `total_cost_usd` and `modelUsage` cumulative over the process, as the CLI does.
//
// The answer is `echo: <the prompt's last line>`, unless that line is a directive:
//   HANG          never answers; an interrupt ends the turn as the CLI does (an error result)
//   FAIL <text>   ends the turn with an error result
//   EXIT          the process exits without a result
//   SLOW <ms>     waits that long, then echoes
//
// Started with `--json-schema`, it answers as the CLI does there: a line of prose, then a call to the
// `StructuredOutput` tool whose input is `{ "answer": "echo: <line>" }`, and a `result` carrying it
// as `structured_output`. Under a schema, `GIVE UP` ends the turn with prose only and no
// `structured_output`, as the CLI reports a model that would not match the schema.
//
//   FAKE_OPENAI_PROMPTS=<file>  appends `{ pid, resume, sessionId, prompt, images, schema }` per turn
import { appendFileSync } from 'node:fs';
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
const out = (msg) => process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...msg })}\n`);

let turns = 0;
let initialised = false;
/** The turn waiting for an interrupt, when one hangs */
let hanging = null;

const schema = flag('--json-schema') ?? null;

function result(isError, text, structured) {
  turns++;
  const usage = { inputTokens: 10 * turns, outputTokens: 5 * turns, cacheReadInputTokens: 100 * turns, cacheCreationInputTokens: 20 * turns, costUSD: 0.01 * turns, contextWindow: 200000 };
  out({
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    num_turns: 1,
    total_cost_usd: 0.01 * turns,
    modelUsage: { 'claude-sonnet-5-5': usage },
    result: text,
    ...(structured !== undefined ? { structured_output: structured } : {}),
  });
}

async function answer(prompt) {
  const last = prompt.trim().split('\n').at(-1) ?? '';
  if (last === 'HANG') {
    hanging = () => result(true, 'interrupted');
    return;
  }
  if (last === 'EXIT') process.exit(0);
  const failure = /^FAIL (.*)$/.exec(last);
  if (failure) {
    result(true, failure[1]);
    return;
  }
  const slow = /^SLOW (\d+)$/.exec(last);
  if (slow) await new Promise((r) => setTimeout(r, Number(slow[1])));
  const text = `echo: ${last}`;
  const half = Math.ceil(text.length / 2);
  const block = (event) => out({ type: 'stream_event', parent_tool_use_id: null, event });
  if (schema !== null) {
    const prose = 'Here is the structured answer.';
    block({ type: 'message_start', message: { role: 'assistant' } });
    block({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    block({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: prose } });
    block({ type: 'content_block_stop', index: 0 });
    if (last === 'GIVE UP') {
      const refusal = 'I cannot match that schema.';
      out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: refusal }], stop_reason: 'end_turn' } });
      result(false, refusal);
      return;
    }
    const output = { answer: text };
    const json = JSON.stringify(output);
    block({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `toolu_${String(turns)}`, name: 'StructuredOutput', input: {} } });
    block({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json } });
    block({ type: 'content_block_stop', index: 1 });
    out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: prose }, { type: 'tool_use', id: `toolu_${String(turns)}`, name: 'StructuredOutput', input: output }], stop_reason: 'tool_use' } });
    result(false, json, output);
    return;
  }
  block({ type: 'message_start', message: { role: 'assistant' } });
  block({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  block({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } });
  block({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } });
  block({ type: 'content_block_stop', index: 0 });
  out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
  result(false, text);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    const subtype = msg.request?.subtype;
    const models = [
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
      { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'Haiku 5.5', supportsEffort: false },
    ];
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: subtype === 'initialize' ? { commands: [], models, account: { apiProvider: 'firstParty' } } : {} } });
    if (subtype === 'interrupt' && hanging) {
      const end = hanging;
      hanging = null;
      end();
    }
    return;
  }
  if (msg.type !== 'user') return;
  if (!initialised) {
    initialised = true;
    out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: flag('--model') ?? 'sonnet', tools: [] });
  }
  const content = msg.message?.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []);
  const prompt = blocks.map((b) => b.text ?? '').join('\n');
  if (process.env.FAKE_OPENAI_PROMPTS) {
    appendFileSync(process.env.FAKE_OPENAI_PROMPTS, `${JSON.stringify({ pid: process.pid, resume: flag('--resume') ?? null, sessionId, prompt, images: blocks.filter((b) => b.type === 'image').length, schema })}\n`);
  }
  void answer(prompt);
});
lines.on('close', () => process.exit(0));
