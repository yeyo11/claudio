#!/usr/bin/env node
// Stands in for `claude -p` in orchestration tests: enough of the stream-json protocol for the
// runner, and just enough behaviour, driven by the prompt, to leave real git work behind.
//
//   FAKE-WRITE <file> <content>   writes a file and leaves it uncommitted, like most workers
//   (integrator prompt)           merges the listed branches, taking the incoming side on conflict
//   FAKE-HANG                     never answers, like a worker someone has to stop
//   FAKE-SLEEP <ms>               waits that long before the turn goes on, so a test can act while it works
//   FAKE-WAIT-FOR <file>          waits until <file> exists before the turn goes on: a turn that is
//                                 still working whatever the test does first, however loaded the machine
//   FAKE-FAIL <message>           ends the turn with an error result
//   FAKE-FAIL-ONCE <message>      fails like that, and every later turn of the session succeeds and
//                                 answers `retried: <the prompt it got>`
//   FAKE-FAIL-ALWAYS <message>    fails like that, and so does every later turn of the session: a
//                                 fault a retry cannot mend, which the resumed prompt no longer names
//   FAKE-BUDGET                   ends the turn as the CLI does when --max-budget-usd ran out
//   FAKE-LIMIT-ONCE               the session's first turn dies against the rate limit (a 429), and
//                                 the same prompt sent again (the rotation's replay) goes on as usual
//   FAKE-LIMIT-REPORTED-ONCE      the same, with the rejected rate_limit_event the CLI sends before the 429
//                                 (replay/rate-limit.jsonl), which is what records the provider's limit
//
//   FAKE-TEXT-ONCE <text>         the session's first turn ends with that text as its result, and every
//                                 later turn answers `continued: <the prompt it got>`: a worker that
//                                 stops with a report while work is still owed
//   FAKE-BG-AGENT                 with FAKE-TEXT-ONCE: that first turn also starts a background subagent
//                                 and ends with it still running, as a lead that delegated and stopped
//   FAKE-MAX-TOKENS               before its result, streams the message_delta that says the turn
//                                 stopped on max_tokens, as the CLI's stream-json does
//
//   FAKE-RESULT-<STAGE> <json>    with --json-schema, ends with that structured output; the stage
//                                 (REFINE, WORK, VERIFY) is read off the schema as a flow run's
//                                 differs by stage, so one item's description can script each role;
//                                 ASSISTANT is an assistant run's, whose schema asks for `read`
//   FAKE-RESULT-DECISION <json>   the same for a decision chat, whatever its schema asks for
//   FAKE-MCP-CALL <server> <tool> <json>
//                                 makes one MCP tool call as the CLI does: reads --mcp-config, refuses
//                                 the call (a denial, as in dontAsk) unless mcp__<server>__<tool> is in
//                                 --allowedTools, else starts the server from the file (expanding ${VAR}
//                                 from its own environment), asks it with initialize and tools/call,
//                                 and ends with a result that quotes what came back. <server> and
//                                 <tool> may name a built-in, such as `- Bash`'s: FAKE-MCP-CALL - Bash {}
//   FAKE-STREAM-HOLD <file>       with a FAKE-RESULT, streams it first as the CLI does, as the input of
//                                 its StructuredOutput tool call: the first half, then, once <file>
//                                 exists, the rest, and only then the result
//
//   FAKE-TOOL <tool> <json>       makes one tool call as the CLI does with `--settings`: the assistant's tool_use, the
//                                 PreToolUse command of the settings file run with the hook input on stdin (its hook
//                                 events streamed with --include-hook-events), then the tool_result: an error for exit 2
//   FAKE-TOOL-UNGUARDED <tool> <json>
//                                 the same call with its hook never run: a guard that was not there
//   FAKE-FOREIGN-HOOK             streams the hook events of a hook that is the person's own
//   FAKE_CLAUDE_NO_ARM=1          the SessionStart hook never runs: a guard that cannot arm
//   FAKE_CLAUDE_ARM_DELAY_MS=<ms> waits that long before the SessionStart hook runs
//   FAKE_CLAUDE_TIMELINE=<file>   appends `armed` when SessionStart ran and `message` when the first message was read
//   FAKE_CLAUDE_INTERRUPTS=<file> appends a line per interrupt control request it is sent
//   The review gate (docs/plans/review-gate.md), scripted by lines of the graph's objective, which every
//   review prompt carries:
//   FAKE-RESULT-REVIEW[-<DIMENSION>] <json>  the findings a reviewer answers (the dimension in lower
//                                 case, as the prompt names it); without a line, zero findings
//   FAKE-REVIEW-CLEAN-IF <file>   a reviewer whose checkout has that file answers zero findings: a fix landed
//   FAKE-REVIEW-IF <file> <json> a reviewer whose checkout has that file answers that instead: a fix made it worse
//   FAKE-REVIEW-INVALID           a reviewer ends successfully with no structured output
//   FAKE-REVIEW-SLOW <ms>         a reviewer or verifier waits that long before answering
//   FAKE-REVIEW-VERDICT <status>  what the verifier answers for every claim; default confirmed
//   FAKE-REVIEW-FIX <file> <content>  the review fixer's prompt makes it write that file
//
//   --model fake-refused          exits 1 at once with an error on stderr, as the CLI does with an
//                                 option it refuses: a chat that never starts its turn
//
//   FAKE_CLAUDE_SPAWNS=<file>     appends `<pid> <argv>` to <file> as it starts, so a test can count
//                                 every process spawned, tracked or not
//   FAKE_CLAUDE_ENVS=<file>       appends one JSON line `{ url, token, chat, claudio }` per spawn: the
//                                 CLAUDIO_API_URL, CLAUDIO_API_TOKEN and CLAUDIO_CHAT_ID the process was
//                                 given, and the names of every CLAUDIO_*, PORT and HOST it holds
//   FAKE_CLAUDE_ACCOUNTS=<file>   appends one JSON line `{ dir, oauth, apiKey, authToken }` per spawn: the account variables
//                                 the process was given, which are the account it runs on
//   FAKE_CLAUDE_LIMITED_DIRS=<a,b> every turn of a process whose CLAUDE_CONFIG_DIR is one of these dies against
//                                 the rate limit (a 429): an account that is out
//   FAKE_CLAUDE_LIMIT_RESETS_IN=<s> with FAKE_CLAUDE_LIMITED_DIRS, that 429 comes after the rejected
//                                 rate_limit_event the CLI sends, with its reset <s> seconds from now
//   FAKE_CLAUDE_EXPIRED_DIRS=<a,b> every turn of a process whose CLAUDE_CONFIG_DIR is one of these dies on the
//                                 sign-in (a 401, replay/auth-expired.jsonl): an account whose session expired
//   FAKE_CLAUDE_PROMPTS=<file>    appends one JSON line `{ cwd, resume, prompt }` per turn it is sent, so a
//                                 test can read what a run was told and where
//   FAKE_CLAUDE_LINGER_MS=<ms>    stays up that long after stdin closes, the way the CLI does while
//                                 background work finishes
//
// It reports the files it could see and its working directory, which is what the tests check.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
// Reading an account's model list (the `initialize` handshake and the version before it) is not a
// chat's process: the logs below count what chats spawn. Nor are the CLI's own subcommands: the
// session listing (`agents --json`) fires on its own clock after a chat starts, so a test reading
// the last account a chat ran on would otherwise read the listing's whenever it landed last
const probe =
  args[0] === '--version' || args[0] === 'agents' || args[0] === 'auth' || args.join(' ') === '-p --input-format stream-json --output-format stream-json --verbose';
if (process.env.FAKE_CLAUDE_ENVS && !probe) {
  // `claudio`: every CLAUDIO_* name it was given, and PORT and HOST, which must never be the server's
  const claudio = Object.keys(process.env).filter((name) => name.startsWith('CLAUDIO_') || name === 'PORT' || name === 'HOST').sort();
  appendFileSync(process.env.FAKE_CLAUDE_ENVS, `${JSON.stringify({ url: process.env.CLAUDIO_API_URL ?? null, token: process.env.CLAUDIO_API_TOKEN ?? null, chat: process.env.CLAUDIO_CHAT_ID ?? null, claudio })}\n`);
}
if (process.env.FAKE_CLAUDE_ACCOUNTS && !probe) appendFileSync(process.env.FAKE_CLAUDE_ACCOUNTS, `${JSON.stringify({ dir: process.env.CLAUDE_CONFIG_DIR ?? null, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, apiKey: process.env.ANTHROPIC_API_KEY ?? null, authToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null })}\n`);
if (process.env.FAKE_CLAUDE_SPAWNS && !probe) appendFileSync(process.env.FAKE_CLAUDE_SPAWNS, `${process.pid} ${args.join(' ')}\n`);
// Core lists the CLI's own sessions with this; without an answer it waits for stdin to close, and a
// chat started through the API waits a minute for it
if (args[0] === 'agents') {
  process.stdout.write('[]\n');
  process.exit(0);
}
// The same for what building the API asks first: unanswered, each waits out the 20 s timeout of
// `execCli`, which a test file with the API in its `before` paid on its first test
if (args[0] === '--version') {
  // $FAKE_CLAUDE_VERSION stands for a CLI updated under a running server
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.0 (Claude Code)'}\n`);
  process.exit(0);
}
if (args[0] === 'auth') {
  // Automated work starts only on a provider that proved it is signed in: tests that run it say so
  process.stdout.write(process.env.FAKE_CLAUDE_LOGGED_IN === '1' ? '{"loggedIn":true,"authMethod":"claude.ai","email":"fake@example.com"}\n' : '{"loggedIn":false}\n');
  process.exit(0);
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
// As the CLI does with an option it refuses: a line on stderr and out, before any turn
if (flag('--model') === 'fake-refused') {
  process.stderr.write("error: model 'fake-refused' not found\n");
  process.exit(1);
}
const worktree = flag('--worktree');
// Like the CLI, adopt the worktree of that name, which lives under the main checkout's top level
// whichever subdirectory, or linked worktree, it is started in, and work at its root; unlike it,
// refuse to create one, so a test fails if the wrapper did not prepare it where the CLI looks
const topLevel = () =>
  dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
const dir = worktree ? join(topLevel(), '.claude', 'worktrees', worktree) : process.cwd();
if (!existsSync(dir)) {
  process.stderr.write(`fake-claude: worktree ${dir} was not prepared\n`);
  process.exit(1);
}
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

// The hooks of --settings, run as the CLI does: a shell command with the hook input on stdin
const settingsFile = flag('--settings');
const hookCommands = settingsFile ? (JSON.parse(readFileSync(settingsFile, 'utf8')).hooks ?? {}) : {};
const hookEvents = args.includes('--include-hook-events');
function runHook(event, name, input, sessionId, streamed) {
  const command = hookCommands[event]?.[0]?.hooks?.[0]?.command;
  if (!command) return null;
  const hookId = randomUUID();
  if (streamed) out({ type: 'system', subtype: 'hook_started', hook_id: hookId, hook_name: name, hook_event: event, uuid: randomUUID(), session_id: sessionId });
  const run = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify({ session_id: sessionId, cwd: process.cwd(), hook_event_name: event, ...input }), encoding: 'utf8' });
  const code = run.status ?? 1;
  if (streamed) {
    out({ type: 'system', subtype: 'hook_response', hook_id: hookId, hook_name: name, hook_event: event, output: `${run.stdout}${run.stderr}`, stdout: run.stdout, stderr: run.stderr, exit_code: code, outcome: code === 0 ? 'success' : 'error', uuid: randomUUID(), session_id: sessionId });
  }
  return { code, stderr: run.stderr };
}
const startedSession = flag('--session-id') ?? flag('--resume') ?? randomUUID();
// SessionStart runs at the process's start, before any message and before `init` (g0, F9)
const mark = (what) => process.env.FAKE_CLAUDE_TIMELINE && appendFileSync(process.env.FAKE_CLAUDE_TIMELINE, `${what}\n`);
if (settingsFile && process.env.FAKE_CLAUDE_NO_ARM !== '1') {
  if (process.env.FAKE_CLAUDE_ARM_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_CLAUDE_ARM_DELAY_MS));
  runHook('SessionStart', `SessionStart:${flag('--resume') ? 'resume' : 'startup'}`, { source: flag('--resume') ? 'resume' : 'startup' }, startedSession, true);
  mark('armed');
}
const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=Worker', '-c', 'user.email=w@example.com', ...a], { stdio: 'pipe' });

// One tool call, in the events the CLI streams for it: the assistant's tool_use, the user's tool_result, the result
async function mcpCall(server, tool, input, sessionId) {
  const name = server === '-' ? tool : `mcp__${server}__${tool}`;
  const id = `toolu_${randomUUID().slice(0, 8)}`;
  const finish = (text, isError) => {
    out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.01, result: isError ? `${name} failed: ${text}` : `${name} answered: ${text}` });
  };
  out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  const allowed = (flag('--allowedTools') ?? args.find((a) => a.startsWith('--allowedTools='))?.slice('--allowedTools='.length) ?? '').split(',');
  if (!allowed.includes(name)) return finish(`Permission to use ${name} was denied`, true);
  const file = args.find((a) => a.startsWith('--mcp-config='))?.slice('--mcp-config='.length);
  const def = file ? JSON.parse(readFileSync(file, 'utf8')).mcpServers?.[server] : undefined;
  if (!def) return finish(`no MCP server '${server}' in the config`, true);
  const expand = (v) => v.replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] ?? '');
  const env = { ...process.env, ...Object.fromEntries(Object.entries(def.env ?? {}).map(([k, v]) => [k, expand(v)])) };
  const child = spawn(def.command, def.args ?? [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = createInterface({ input: child.stdout });
  const pending = new Map();
  replies.on('line', (l) => {
    const m = JSON.parse(l);
    pending.get(m.id)?.(m);
  });
  let next = 0;
  const ask = (method, params) =>
    new Promise((resolve) => {
      pending.set(++next, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
    });
  child.on('error', (err) => finish(`the server did not start: ${err.message}`, true));
  await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const reply = await ask('tools/call', { name: tool, arguments: input });
  child.stdin.end();
  const text = (reply.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  finish(reply.error ? reply.error.message : text, reply.error !== undefined || reply.result?.isError === true);
}

const lines = createInterface({ input: process.stdin });
let handled = false;
lines.on('line', async (line) => {
  if (!line.trim()) return;
  // The handshake, no turn: the models the account offers. FAKE_CLAUDE_LITE_DIRS lists the config dirs
  // of accounts without opus, as a Pro plan is; $FAKE_CLAUDE_INIT_MODELS replaces the whole list (JSON)
  const hello = line.includes('"initialize"') ? JSON.parse(line) : null;
  if (hello?.type === 'control_request' && hello.request?.subtype === 'initialize') {
    const lite = (process.env.FAKE_CLAUDE_LITE_DIRS ?? '').split(',').includes(process.env.CLAUDE_CONFIG_DIR ?? '');
    const models = process.env.FAKE_CLAUDE_INIT_MODELS ? JSON.parse(process.env.FAKE_CLAUDE_INIT_MODELS) : [
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
      ...(lite ? [] : [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] }]),
      { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'Haiku 5.5', supportsEffort: false },
    ];
    out({ type: 'control_response', response: { subtype: 'success', request_id: hello.request_id, response: { commands: [], models, account: { apiProvider: 'firstParty' } } } });
    return;
  }
  if (line.includes('"interrupt"') && process.env.FAKE_CLAUDE_INTERRUPTS) appendFileSync(process.env.FAKE_CLAUDE_INTERRUPTS, `${line}\n`);
  if (line.includes('"interrupt"')) {
    const asked = JSON.parse(line);
    out({ type: 'control_response', response: { subtype: 'success', request_id: asked.request_id, response: {} } });
  }
  if (handled) return;
  handled = true;
  mark('message');
  const content = JSON.parse(line).message?.content;
  const prompt = typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('\n');
  const sessionId = startedSession;
  out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: dir, model: flag('--model') ?? 'fake', tools: [] });
  if (process.env.FAKE_CLAUDE_PROMPTS) appendFileSync(process.env.FAKE_CLAUDE_PROMPTS, `${JSON.stringify({ cwd: dir, resume: flag('--resume') ?? null, prompt })}\n`);

  for (const [, file, text] of prompt.matchAll(/^FAKE-WRITE (\S+) (.*)$/gm)) writeFileSync(join(dir, file), `${text}\n`);
  if (prompt.startsWith('You are the review fixer')) {
    for (const [, file, text] of prompt.matchAll(/^FAKE-REVIEW-FIX (\S+) (.*)$/gm)) writeFileSync(join(dir, file), `${text}\n`);
  }
  if (prompt.includes('You are integrating the work')) {
    for (const [, branch] of prompt.matchAll(/^- (worktree-[\w-]+)$/gm)) {
      try {
        git('merge', '--no-ff', '--no-edit', branch);
      } catch {
        git('checkout', '--theirs', '.');
        git('add', '-A');
        git('commit', '--no-edit', '-q');
      }
    }
  }

  const nap = /^FAKE-SLEEP (\d+)$/m.exec(prompt);
  if (nap) await new Promise((resolve) => setTimeout(resolve, Number(nap[1])));
  const gate = /^FAKE-WAIT-FOR (\S+)$/m.exec(prompt);
  if (gate) {
    await new Promise((resolve) => {
      const wait = setInterval(() => {
        if (!existsSync(gate[1])) return;
        clearInterval(wait);
        resolve();
      }, 20);
    });
  }
  if (/^FAKE-FOREIGN-HOOK$/m.test(prompt)) {
    out({ type: 'system', subtype: 'hook_started', hook_id: 'person-1', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', uuid: randomUUID(), session_id: sessionId });
    out({ type: 'system', subtype: 'hook_response', hook_id: 'person-1', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', output: 'lint ok\n', stdout: '', stderr: 'lint ok\n', exit_code: 0, outcome: 'success', uuid: randomUUID(), session_id: sessionId });
  }
  const calls = [...prompt.matchAll(/^FAKE-TOOL(-UNGUARDED)? (\S+) (.*)$/gm)];
  for (const [, unguarded, tool, json] of calls) {
    const id = `toolu_${randomUUID().slice(0, 8)}`;
    const input = JSON.parse(json);
    out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] } });
    const verdict = unguarded ? null : runHook('PreToolUse', `PreToolUse:${tool}`, { tool_name: tool, tool_input: input, tool_use_id: id, permission_mode: 'acceptEdits' }, sessionId, hookEvents);
    const blocked = verdict?.code === 2;
    out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: blocked ? `PreToolUse:${tool} hook error: ${verdict.stderr}` : 'ok', is_error: blocked }] } });
  }
  if (calls.length && !/^FAKE-HANG$/m.test(prompt)) {
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.01, result: `tools: ${calls.length}` });
    return;
  }

  if (/^FAKE-HANG$/m.test(prompt)) return;
  if (/^FAKE-BUDGET$/m.test(prompt)) {
    out({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, num_turns: 1, total_cost_usd: 0.01, result: 'budget reached' });
    return;
  }
  if (process.env.CLAUDE_CONFIG_DIR && (process.env.FAKE_CLAUDE_LIMITED_DIRS ?? '').split(',').includes(process.env.CLAUDE_CONFIG_DIR)) {
    const resetsIn = Number(process.env.FAKE_CLAUDE_LIMIT_RESETS_IN ?? '');
    if (Number.isFinite(resetsIn) && resetsIn > 0) {
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + resetsIn, unifiedWindows: { five_hour: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + resetsIn } } } });
    }
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, num_turns: 1, total_cost_usd: 0.01, result: "You've hit your usage limit" });
    return;
  }
  if (process.env.CLAUDE_CONFIG_DIR && (process.env.FAKE_CLAUDE_EXPIRED_DIRS ?? '').split(',').includes(process.env.CLAUDE_CONFIG_DIR)) {
    for (const recorded of readFileSync(new URL('./replay/auth-expired.jsonl', import.meta.url), 'utf8').trim().split('\n')) out(JSON.parse(recorded));
    return;
  }
  const limited = join(tmpdir(), `fake-claude-limit-${sessionId}`);
  const reported = /^FAKE-LIMIT-REPORTED-ONCE$/m.test(prompt);
  if ((reported || /^FAKE-LIMIT-ONCE$/m.test(prompt)) && !existsSync(limited)) {
    writeFileSync(limited, '1');
    if (reported) {
      const resetsAt = Math.floor(Date.now() / 1000) + 3600;
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt, unifiedWindows: { '5h': { utilization: 1 } } } });
    }
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, num_turns: 1, total_cost_usd: 0.01, result: "You've hit your usage limit" });
    return;
  }
  // What a session was told to keep failing with outlives the process, as its history does
  const fault = join(tmpdir(), `fake-claude-fault-${sessionId}`);
  const sticky = /^FAKE-FAIL-(ONCE|ALWAYS) (.*)$/m.exec(prompt);
  if (sticky) writeFileSync(fault, JSON.stringify({ mode: sticky[1], message: sticky[2] }));
  const known = existsSync(fault) ? JSON.parse(readFileSync(fault, 'utf8')) : null;
  if (known && (sticky || known.mode === 'ALWAYS')) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, total_cost_usd: 0.01, result: known.message });
    return;
  }
  if (known && !sticky) {
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: `retried: ${prompt}` });
    return;
  }
  const early = join(tmpdir(), `fake-claude-text-${sessionId}`);
  const text = /^FAKE-TEXT-ONCE (.*)$/m.exec(prompt);
  if (text && !existsSync(early)) {
    writeFileSync(early, '1');
    if (/^FAKE-BG-AGENT$/m.test(prompt)) {
      out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'survey the routes', subagent_type: 'general-purpose', run_in_background: true } }] } });
      out({ type: 'system', subtype: 'task_started', session_id: sessionId, task_id: 'agent-bg', task_type: 'local_agent', tool_use_id: 'toolu_bg', is_backgrounded: true, description: 'survey the routes' });
    }
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: text[1].replaceAll('\\n', '\n') });
    return;
  }
  if (existsSync(early)) {
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: `continued: ${prompt}` });
    return;
  }
  if (/^FAKE-MAX-TOKENS$/m.test(prompt)) {
    out({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null } } });
  }
  const failure = /^FAKE-FAIL (.*)$/m.exec(prompt);
  if (failure) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, total_cost_usd: 0.01, result: failure[1] });
    return;
  }

  const mcp = /^FAKE-MCP-CALL (\S+) (\S+) (.*)$/m.exec(prompt);
  if (mcp) {
    void mcpCall(mcp[1], mcp[2], JSON.parse(mcp[3]), sessionId);
    return;
  }

  const schema = flag('--json-schema');
  if (schema && !JSON.parse(schema).properties?.read && (JSON.parse(schema).properties?.findings || JSON.parse(schema).properties?.verdicts)) {
    const reviewing = JSON.parse(schema).properties.findings !== undefined;
    const answer = () => {
      if (reviewing) {
        if (/^FAKE-REVIEW-INVALID$/m.test(prompt)) return out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: 'no structure' });
        const clean = /^FAKE-REVIEW-CLEAN-IF (\S+)$/m.exec(prompt);
        const dimension = /Your dimension is `(\w+)`/.exec(prompt)?.[1] ?? '';
        const scripted = new RegExp(`^FAKE-RESULT-REVIEW-${dimension.toUpperCase()} (.*)$`, 'm').exec(prompt) ?? /^FAKE-RESULT-REVIEW (.*)$/m.exec(prompt);
        const zero = { findings: [], coverage: { complete: true } };
        const worse = /^FAKE-REVIEW-IF (\S+) (.*)$/m.exec(prompt);
        let output = scripted && !(clean && existsSync(join(dir, clean[1]))) ? JSON.parse(scripted[1]) : zero;
        if (worse && existsSync(join(dir, worse[1]))) output = JSON.parse(worse[2]);
        return out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: '', structured_output: output });
      }
      // A claim re-asked after a fix, with the file the fix leaves behind present, is gone
      const mended = /^FAKE-REVIEW-CLEAN-IF (\S+)$/m.exec(prompt);
      const gone = mended && existsSync(join(dir, mended[1])) && prompt.includes('still present at the current head');
      const status = gone ? 'refuted' : (/^FAKE-REVIEW-VERDICT (\w+)$/m.exec(prompt)?.[1] ?? 'confirmed');
      const verdicts = [...prompt.matchAll(/^Claim (f\d+)\./gm)].map((m) => ({ id: m[1], status, reason: `fake verifier: ${status}` }));
      return out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: '', structured_output: { verdicts } });
    };
    const slow = /^FAKE-REVIEW-SLOW (\d+)$/m.exec(prompt);
    if (slow) setTimeout(answer, Number(slow[1]));
    else answer();
    return;
  }
  if (schema) {
    const props = JSON.parse(schema).properties ?? {};
    const stage = props.read ? 'ASSISTANT' : props.verdict ? 'VERIFY' : props.acceptanceCriteria ? 'REFINE' : 'WORK';
    const scripted = /^FAKE-RESULT-DECISION (.*)$/m.exec(prompt) ?? new RegExp(`^FAKE-RESULT-${stage} (.*)$`, 'm').exec(prompt);
    if (scripted) {
      const hold = /^FAKE-STREAM-HOLD (\S+)$/m.exec(prompt);
      if (hold) {
        const json = scripted[1];
        const half = Math.floor(json.length / 2);
        const block = (event) => out({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event });
        const deltas = (text) => {
          for (let i = 0; i < text.length; i += 24) block({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: text.slice(i, i + 24) } });
        };
        block({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fake', name: 'StructuredOutput', input: {} } });
        deltas(json.slice(0, half));
        const wait = setInterval(() => {
          if (!existsSync(hold[1])) return;
          clearInterval(wait);
          deltas(json.slice(half));
          block({ type: 'content_block_stop', index: 0 });
          out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: '', structured_output: JSON.parse(json) });
        }, 20);
        return;
      }
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: '', structured_output: JSON.parse(scripted[1]) });
      return;
    }
  }

  const files = readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: `cwd=${dir} files=${files.join(',')}` });
});
lines.on('close', () => setTimeout(() => process.exit(0), Number(process.env.FAKE_CLAUDE_LINGER_MS ?? 0)));
