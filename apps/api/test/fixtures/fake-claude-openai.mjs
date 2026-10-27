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
//   BACKGROUND    reports a background task started (`task_started`, never ended), then echoes
//   BUDGET        streams the start of an answer, then ends as `--max-budget-usd` does (`error_max_budget_usd`)
//
// Started with `--json-schema`, it answers as the CLI does there: a line of prose, then a call to the
// `StructuredOutput` tool whose input is `{ "answer": "echo: <line>" }`, and a `result` carrying it
// as `structured_output`. Under a schema, `GIVE UP` ends the turn with prose only and no
// `structured_output`, as the CLI reports a model that would not match the schema.
//
// Client tools, as the real CLI handles them (docs/plans/openai-compatible-api-spike.md): with a
// `client` server in `--mcp-config`, it connects to the stub over HTTP with the token the entry
// names (`${CLAUDIO_API_TOKEN}` expanded from its environment) and lists the tools. Then:
//   TOOLS <json>       one API message calling each `{ name, input }` as `mcp__client__<name>`: the
//                      `tool_use` blocks stream, the message ends (`message_delta` stop_reason
//                      `tool_use`), and a `can_use_tool` request per call goes out at once. An allowed
//                      call is made on the stub (`tools/call` with `_meta["claudecode/toolUseId"]`)
//                      and its text becomes the `tool_result`; a denied one an error result. Once all
//                      are answered the turn ends with `results: <text of each, in order>`.
//   TOOLS_TEXT <json>  the same after a line of text, `Calling the tools.`
//   TOOLS_NOMETA <json> the same, but `tools/call` carries no tool call id (the FIFO fallback)
//   TOOLS_SIDE <json>  the calls made by a subagent: the `tool_use` blocks only in a sidechain message
//                      (no main-agent block names them), then a `can_use_tool` request per call
//   TOOLS_HANG <json>  the blocks and the requests, but the message never ends: only an interrupt
//                      ends the turn (the requests withdrawn with `control_cancel_request`)
//   TOOLS_DEAF <json>  TOOLS from a wedged CLI: from then on it ignores interrupts and the answers to
//                      its requests, so the turn never ends
//   BASH [command]     a built-in `Bash` call (`ls` by default). As the CLI does, a call its own
//                      `--allowedTools` rules allow (`Bash`, or `Bash(<prefix>:*)` matching the command)
//                      runs without a `can_use_tool` request; any other is asked for
// The last line of a prompt that starts with `(For this turn:` is the tool_choice instruction: it is
// recorded and skipped when the directive is read.
//
//   FAKE_OPENAI_LINGER_MS=<ms>  exits that long after its input ends, as a real CLI takes a moment to
//   FAKE_OPENAI_PROMPTS=<file>  appends `{ pid, resume, sessionId, prompt, images, schema, prompts, system, stub, instruction }` per turn
import { appendFileSync, readFileSync } from 'node:fs';
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
/** A wedged process (TOOLS_DEAF): interrupts and permission answers go unheard */
let deaf = false;

const schema = flag('--json-schema') ?? null;
const permissionPrompts = flag('--permission-prompts') ?? null;
const mcpConfigArg = args.find((a) => a.startsWith('--mcp-config='))?.slice('--mcp-config='.length) ?? null;
const strictMcp = args.includes('--strict-mcp-config');
const rulesOf = (name) => (args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1).split(',') ?? []).filter(Boolean);
const allowRules = rulesOf('--allowedTools');
const denyRules = rulesOf('--disallowedTools');
/** Whether the CLI's own rules decide a call without asking: what a tool preset becomes */
function ruleMatches(rule, name, input) {
  if (rule === name) return true;
  const scoped = /^([A-Za-z]+)\((.*):\*\)$/.exec(rule);
  return scoped !== null && scoped[1] === name && name === 'Bash' && String(input?.command ?? '').startsWith(scoped[2]);
}
const allowedByRules = (name, input) => !denyRules.some((r) => ruleMatches(r, name, input)) && allowRules.some((r) => ruleMatches(r, name, input));

/** The `client` server of the config, with `${VAR}` expanded from the environment as the CLI does */
function stubServer() {
  if (!mcpConfigArg) return null;
  const servers = JSON.parse(readFileSync(mcpConfigArg, 'utf8')).mcpServers ?? {};
  const entry = servers.client;
  if (!entry) return null;
  const expand = (v) => String(v).replace(/\$\{([A-Z_]+)\}/g, (_, name) => process.env[name] ?? '');
  return { url: expand(entry.url), headers: Object.fromEntries(Object.entries(entry.headers ?? {}).map(([k, v]) => [k, expand(v)])), alwaysLoad: entry.alwaysLoad === true, type: entry.type };
}
const stub = stubServer();
let rpcId = 0;
async function rpc(method, params, auth = stub.headers) {
  const res = await fetch(stub.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...auth }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}
/** What the stub said when the process connected: kept for the prompt log */
let stubSeen = null;
async function connectStub() {
  if (!stub || stubSeen) return;
  const discover = await rpc('server/discover', {});
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } });
  await fetch(stub.url, { method: 'POST', headers: { 'content-type': 'application/json', ...stub.headers }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  const list = await rpc('tools/list', {});
  const unauth = await rpc('tools/list', {}, { Authorization: 'Bearer wrong' });
  stubSeen = { url: stub.url, alwaysLoad: stub.alwaysLoad, type: stub.type, strict: strictMcp, discover: discover.body?.error?.code ?? null, init: init.status, tools: list.body?.result?.tools ?? null, unauthorized: unauth.status };
}

/** `can_use_tool` requests out and not answered yet, by request id */
const asked = new Map();
let askSeq = 0;
/** The tool turn in progress: its calls, in order, and what each came to */
let toolTurn = null;

function askFor(toolUseId, name, input) {
  const requestId = `fake-ask-${String(++askSeq)}`;
  asked.set(requestId, { toolUseId, name, input });
  if (allowedByRules(name, input)) {
    void settleAsk(requestId, { behavior: 'allow' });
    return;
  }
  out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: name, display_name: name, input, tool_use_id: toolUseId } });
}

async function settleAsk(requestId, response) {
  const ask = asked.get(requestId);
  if (!ask) return;
  asked.delete(requestId);
  let text;
  let isError = false;
  if (response?.behavior === 'allow') {
    if (ask.name === 'Bash') text = 'bash ran';
    else {
      const meta = toolTurn?.noMeta ? {} : { _meta: { 'claudecode/toolUseId': ask.toolUseId, progressToken: askSeq } };
      const answer = await rpc('tools/call', { name: ask.name.replace(/^mcp__client__/, ''), arguments: response.updatedInput ?? ask.input, ...meta });
      const result = answer.body?.result;
      text = (result?.content ?? []).map((c) => c.text).join('');
      isError = result?.isError === true;
    }
  } else {
    text = response?.message ?? 'denied';
    isError = true;
  }
  out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: ask.toolUseId, content: [{ type: 'text', text }], is_error: isError }] } });
  if (!toolTurn) return;
  toolTurn.done.set(ask.toolUseId, `${isError ? 'ERROR ' : ''}${text}`);
  if (toolTurn.done.size < toolTurn.calls.length) return;
  const final = `results: ${toolTurn.calls.map((c) => toolTurn.done.get(c.id)).join(' | ')}`;
  toolTurn = null;
  const block = (event) => out({ type: 'stream_event', parent_tool_use_id: null, event });
  block({ type: 'message_start', message: { role: 'assistant' } });
  block({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  block({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: final } });
  block({ type: 'content_block_stop', index: 0 });
  out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: final }], stop_reason: 'end_turn' } });
  result(false, final);
}

function callTools(kind, calls) {
  const block = (event) => out({ type: 'stream_event', parent_tool_use_id: null, event });
  const message = (content) => out({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${String(turns)}`, role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: null } });
  if (kind === 'TOOLS_SIDE') {
    const side = calls.map((call, i) => ({ id: `toolu_side_${String(turns)}_${String(i)}_${String(process.pid)}`, name: `mcp__client__${call.name}`, input: call.input ?? {} }));
    toolTurn = { calls: side, done: new Map(), noMeta: false };
    out({ type: 'assistant', parent_tool_use_id: 'toolu_parent', message: { id: `msg_side_${String(turns)}`, role: 'assistant', model: 'claude-sonnet-5-5', content: side.map((c) => ({ type: 'tool_use', ...c })), stop_reason: null } });
    for (const call of side) askFor(call.id, call.name, call.input);
    return;
  }
  block({ type: 'message_start', message: { role: 'assistant' } });
  let index = 0;
  if (kind === 'TOOLS_TEXT') {
    block({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    block({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: 'Calling the tools.' } });
    block({ type: 'content_block_stop', index });
    message([{ type: 'text', text: 'Calling the tools.' }]);
    index++;
  }
  const made = calls.map((call, i) => ({ id: `toolu_${String(turns)}_${String(i)}_${String(process.pid)}`, name: call.name === 'Bash' ? 'Bash' : `mcp__client__${call.name}`, input: call.input ?? {} }));
  toolTurn = { calls: made, done: new Map(), noMeta: kind === 'TOOLS_NOMETA' };
  for (const call of made) {
    block({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
    block({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
    block({ type: 'content_block_stop', index });
    // The CLI writes the assistant message block by block, each as it closes
    message([{ type: 'tool_use', id: call.id, name: call.name, input: call.input }]);
    index++;
  }
  if (kind === 'TOOLS_HANG') {
    // The calls are asked for, but the message never says it ended
    for (const call of made) askFor(call.id, call.name, call.input);
    hanging = () => {
      for (const id of [...asked.keys()]) {
        asked.delete(id);
        out({ type: 'control_cancel_request', request_id: id });
      }
      toolTurn = null;
      result(true, 'aborted_tools');
    };
    return;
  }
  block({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  block({ type: 'message_stop' });
  // Read-only tools: every request of the turn goes out together
  for (const call of made) askFor(call.id, call.name, call.input);
}

function result(isError, text, structured, subtype) {
  turns++;
  const usage = { inputTokens: 10 * turns, outputTokens: 5 * turns, cacheReadInputTokens: 100 * turns, cacheCreationInputTokens: 20 * turns, costUSD: 0.01 * turns, contextWindow: 200000 };
  out({
    type: 'result',
    subtype: subtype ?? (isError ? 'error_during_execution' : 'success'),
    is_error: isError,
    num_turns: 1,
    total_cost_usd: 0.01 * turns,
    modelUsage: { 'claude-sonnet-5-5': usage },
    result: text,
    ...(structured !== undefined ? { structured_output: structured } : {}),
  });
}

async function answer(prompt) {
  await connectStub();
  const lines = prompt.trim().split('\n').filter((l) => !l.startsWith('(For this turn:')).join('\n').trim().split('\n');
  const last = lines.at(-1) ?? '';
  const tools = /^(TOOLS|TOOLS_TEXT|TOOLS_NOMETA|TOOLS_HANG|TOOLS_SIDE|TOOLS_DEAF) (.*)$/.exec(last);
  if (tools) {
    deaf = tools[1] === 'TOOLS_DEAF';
    callTools(deaf ? 'TOOLS' : tools[1], JSON.parse(tools[2]));
    return;
  }
  const bash = /^BASH(?: (.+))?$/.exec(last);
  if (bash) {
    callTools('TOOLS', [{ name: 'Bash', input: { command: bash[1] ?? 'ls' } }]);
    return;
  }
  if (last === 'HANG') {
    hanging = () => result(true, 'interrupted');
    return;
  }
  if (last === 'EXIT') process.exit(0);
  if (last === 'BUDGET') {
    const cut = 'A long answer that the budget cut';
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { role: 'assistant' } } });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: cut } } });
    out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: cut }], stop_reason: null } });
    result(true, '', undefined, 'error_max_budget_usd');
    return;
  }
  const failure = /^FAIL (.*)$/.exec(last);
  if (failure) {
    result(true, failure[1]);
    return;
  }
  if (last === 'BACKGROUND') out({ type: 'system', subtype: 'task_started', task_id: `task_${String(turns)}`, task_type: 'local_bash', description: 'sleep 600', tool_use_id: null });
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
    if (deaf) return;
    if (subtype === 'interrupt' && toolTurn && !hanging) {
      // Held requests are withdrawn and the turn ends aborted, as the spike recorded
      for (const id of [...asked.keys()]) {
        asked.delete(id);
        out({ type: 'control_cancel_request', request_id: id });
      }
      toolTurn = null;
      result(true, 'aborted_tools');
    }
    if (subtype === 'interrupt' && hanging) {
      const end = hanging;
      hanging = null;
      end();
    }
    return;
  }
  if (msg.type === 'control_response') {
    if (deaf) return;
    void settleAsk(msg.response?.request_id, msg.response?.response);
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
    appendFileSync(process.env.FAKE_OPENAI_PROMPTS, `${JSON.stringify({ pid: process.pid, resume: flag('--resume') ?? null, sessionId, prompt, images: blocks.filter((b) => b.type === 'image').length, schema, prompts: permissionPrompts, system: flag('--append-system-prompt') ?? null, instruction: prompt.split('\n').find((l) => l.startsWith('(For this turn:')) ?? null })}\n`);
  }
  void answer(prompt).then(() => {
    if (process.env.FAKE_OPENAI_PROMPTS && stubSeen) appendFileSync(process.env.FAKE_OPENAI_PROMPTS, `${JSON.stringify({ pid: process.pid, sessionId, stub: stubSeen })}\n`);
  });
});
lines.on('close', () => setTimeout(() => process.exit(0), Number(process.env.FAKE_OPENAI_LINGER_MS ?? 0)));
