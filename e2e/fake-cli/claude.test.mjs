// The fake CLI's own test: `node --test e2e/fake-cli/claude.test.mjs`. It speaks to the fake the way
// the wrapper does (stream-json on stdin and stdout), so a spec that fails can be told apart from a
// fake that stopped answering. Needs no build, no browser and no server.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), 'claude');
const linux = existsSync('/proc/self/stat');
/** A pid and every process under it, read from /proc: what the wrapper's cancel signals. */
function tree(root) {
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    for (const name of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === out[i]) out.push(Number(name));
      } catch {
        // gone in between
      }
    }
  }
  return out;
}
const alive = (pid) => {
  try {
    return !readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\)\s+/s, '').startsWith('Z');
  } catch {
    return false;
  }
};

/** A chat with the fake: `send` writes a line, `next(match)` waits for the first event after the last one read that matches. */
function chat(env = {}, { args = [], setup } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-fake-cli-'));
  const logFile = join(dir, 'log.jsonl');
  setup?.(dir);
  const proc = spawn(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', 'fake-session', '--model', 'haiku', ...(typeof args === 'function' ? args(dir) : args)], {
    cwd: dir,
    env: { ...process.env, CLAUDIO_FAKE_CLI_LOG: logFile, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const events = [];
  const waiters = [];
  createInterface({ input: proc.stdout }).on('line', (line) => {
    events.push(JSON.parse(line));
    for (const w of waiters.splice(0)) w();
  });
  let read = 0;
  const exited = new Promise((r) => proc.on('exit', r));
  return {
    proc,
    dir,
    events,
    exited,
    log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    send: (message) => proc.stdin.write(`${JSON.stringify(message)}\n`),
    say: (text) => proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`),
    async next(match, timeout = 5000) {
      const end = Date.now() + timeout;
      for (;;) {
        const at = events.slice(read).findIndex(match);
        if (at !== -1) {
          read += at + 1;
          return events[read - 1];
        }
        if (Date.now() > end) throw new Error(`no matching event; saw ${JSON.stringify(events.slice(read))}`);
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
    },
    done() {
      proc.kill('SIGTERM');
      return exited.finally(() => rmSync(dir, { recursive: true, force: true }));
    },
  };
}

const toolUse = (e) => e.type === 'assistant' && e.message.content.some((b) => b.type === 'tool_use');
const text = (e) => (e.type === 'assistant' ? e.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');

test('answers the subcommands the wrapper runs, and refuses the rest', () => {
  assert.match(spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout, /^2\.1\.1-fake \(Claude Code\)/);
  assert.equal(JSON.parse(spawnSync(bin, ['auth', 'status', '--json'], { encoding: 'utf8' }).stdout).loggedIn, true);
  assert.deepEqual(JSON.parse(spawnSync(bin, ['agents', '--json'], { encoding: 'utf8' }).stdout), []);
  assert.deepEqual(JSON.parse(spawnSync(bin, ['plugin', 'list', '--json'], { encoding: 'utf8' }).stdout), []);
  const unknown = spawnSync(bin, ['update'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /not part of the fake/);
});

test('a turn runs its commands for real and ends with a result', async () => {
  const c = chat();
  const init = await c.next((e) => e.type === 'system' && e.subtype === 'init');
  assert.equal(init.session_id, 'fake-session');
  assert.equal(init.model, 'claude-haiku-5');
  c.say('run: echo one\nrun: echo two');
  const first = await c.next(toolUse);
  assert.equal(first.message.content[0].input.command, 'echo one');
  const result1 = await c.next((e) => e.type === 'user');
  assert.equal(result1.message.content[0].content, 'one');
  assert.equal(result1.message.content[0].is_error, false);
  await c.next((e) => toolUse(e) && e.message.content[0].input.command === 'echo two');
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.is_error, false);
  c.say('thanks');
  assert.equal(text(await c.next((e) => e.type === 'assistant')), 'Heard: thanks');
  await c.next((e) => e.type === 'result');
  await c.done();
});

test('the init lists the subagent tool, so a session never reads as a CLI missing subagents', async () => {
  const c = chat();
  const init = await c.next((e) => e.type === 'system' && e.subtype === 'init');
  assert.ok(init.tools.includes('Agent') || init.tools.includes('Task'), `tools: ${init.tools.join(', ')}`);
  await c.done();
});

test('a running command beats with the elapsed time offset, and hears messages at its next step', { skip: !linux && 'needs /proc' }, async () => {
  const c = chat({ CLAUDIO_FAKE_CLI_HEARTBEAT_MS: '100' });
  c.say('elapsed: 200\nrun: sleep 30\nrun: sleep 31');
  const call = await c.next(toolUse);
  const id = call.message.content[0].id;
  const beat = await c.next((e) => e.type === 'tool_progress');
  assert.equal(beat.tool_use_id, id);
  assert.ok(beat.elapsed_time_seconds >= 200);
  c.say('a hint');
  // What the wrapper's cancel does: the command's tree goes, the turn goes on
  const started = c.log().find((l) => l.event === 'command');
  assert.ok(alive(started.commandPid));
  for (const pid of tree(started.commandPid).reverse()) process.kill(pid, 'SIGTERM');
  const failed = await c.next((e) => e.type === 'user');
  assert.equal(failed.message.content[0].is_error, true);
  assert.equal(text(await c.next((e) => e.type === 'assistant' && text(e) !== '')), 'Heard: a hint');
  await c.next((e) => toolUse(e) && e.message.content[0].input.command === 'sleep 31');
  assert.ok(c.log().some((l) => l.event === 'stdin' && l.text === 'a hint'));

  // An interrupt ends the turn and takes its command down with it
  const second = c.log().filter((l) => l.event === 'command')[1];
  const secondTree = tree(second.commandPid);
  assert.ok(secondTree.every(alive));
  c.send({ type: 'control_request', request_id: 'r-1', request: { subtype: 'interrupt' } });
  const answer = await c.next((e) => e.type === 'control_response');
  assert.deepEqual(answer.response, { subtype: 'success', request_id: 'r-1', response: {} });
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.is_error, true);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(secondTree.filter(alive), []);
  await c.done();
});

test('closing stdin ends the turn with a result and leaves no command behind', { skip: !linux && 'needs /proc' }, async () => {
  const c = chat();
  c.say('run: sleep 30');
  await c.next(toolUse);
  const started = c.log().find((l) => l.event === 'command');
  c.proc.stdin.end();
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.is_error, true);
  assert.equal(await c.exited, 0);
  assert.equal(alive(started.commandPid), false);
  await c.done();
});

test('an unknown control request gets an error answer, never silence', async () => {
  const c = chat();
  c.send({ type: 'control_request', request_id: 'r-2', request: { subtype: 'reload_plugins' } });
  const answer = await c.next((e) => e.type === 'control_response');
  assert.equal(answer.response.subtype, 'error');
  await c.done();
});

test('say: lines are the assistant\'s own prose, in their place among the calls', async () => {
  const c = chat();
  c.say('say: Looking at the routes first.\nrun: echo routes\nsay: Two handlers, both tested.');
  assert.equal(text(await c.next((e) => e.type === 'assistant')), 'Looking at the routes first.');
  await c.next((e) => toolUse(e) && e.message.content[0].input.command === 'echo routes');
  assert.equal(text(await c.next((e) => e.type === 'assistant' && text(e) !== '')), 'Two handlers, both tested.');
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.result, 'Two handlers, both tested.');
  assert.ok(!c.events.some((e) => /^Running|^All done/.test(text(e))), 'a scripted turn has none of the fake\'s own words');
  await c.done();
});

test('a review.triage question is answered without a script: the first thread to the agent, the rest to a person', async () => {
  const c = chat();
  c.say('Answer the questions below.\n\nQuestions:\n\nPRRT_a: Who should take this review comment on src/cart.ts?\n  - agent: An agent\n\nPRRT_b: Who should take this review comment?\n  - agent: An agent');
  const result = await c.next((e) => e.type === 'result');
  assert.deepEqual(result.structured_output, { PRRT_a: 'agent', PRRT_b: 'person' });
  await c.done();
});

test('an issue.triage question is answered without a script: the marks go round in the order asked', async () => {
  const c = chat();
  c.say('Answer the questions below.\n\nQuestions:\n\n32: Can an agent start on issue 32 ("Coupon") as written?\n  - ready: Ready\n\n33: Can an agent start on issue 33 as written?\n  - ready: Ready\n\n34: Can an agent start on issue 34 as written?\n  - ready: Ready\n\n35: Can an agent start on issue 35 as written?\n  - ready: Ready');
  const result = await c.next((e) => e.type === 'result');
  assert.deepEqual(result.structured_output, { 32: 'ready', 33: 'needs-refining', 34: 'not-for-agents', 35: 'ready' });
  await c.done();
});

test('a lesson.mine question is answered true without a script', async () => {
  const c = chat();
  c.say('Answer the questions below from the state that follows, in the structured result.\n\nQuestions:\n\nmine: Do these signals show a person correcting, stopping or overruling the agent in a way that should change how agents work in this project from now on, beyond this one task? Answer true or false.');
  const result = await c.next((e) => e.type === 'result');
  assert.deepEqual(result.structured_output, { mine: true });
  await c.done();
});

test('the lesson miner\'s prompt is answered with the scripts file\'s "@lesson-miner" line, or with no lessons', async () => {
  const prompt = 'You review part of a chat between a person and a coding agent working in one project. The person corrected the agent.\n\nSignals, newest first:\n\nS1 no, usa pnpm siempre';
  const dir = mkdtempSync(join(tmpdir(), 'fake-miner-'));
  const scripts = join(dir, 'scripts.json');
  const lesson = { trigger: 'When installing dependencies', action: 'Use `pnpm`.', signals: ['S1'], quote: 'no, usa pnpm siempre', confidence: 0.8, restates: '', contradicts: '', instructions: 'none', mechanical: false };
  writeFileSync(scripts, JSON.stringify({ '@lesson-miner': `json: ${JSON.stringify({ lessons: [lesson] })}` }));
  const scripted = chat({ CLAUDIO_FAKE_CLI_SCRIPTS: scripts });
  scripted.say(prompt);
  assert.deepEqual((await scripted.next((e) => e.type === 'result')).structured_output, { lessons: [lesson] });
  await scripted.done();
  const bare = chat();
  bare.say(prompt);
  assert.deepEqual((await bare.next((e) => e.type === 'result')).structured_output, { lessons: [] });
  await bare.done();
});

test('read: holds a Read call open, and json: is the structured output of the result', async () => {
  const c = chat({ CLAUDIO_FAKE_CLI_READ_MS: '50' }, { setup: (dir) => writeFileSync(join(dir, 'README.md'), '# hello\n') });
  c.say('read: README.md\nread: missing.md\njson: {"summary":"ok","workItems":[]}');
  const first = await c.next((e) => toolUse(e) && e.message.content[0].name === 'Read');
  assert.match(first.message.content[0].input.file_path, /README\.md$/);
  const answer = await c.next((e) => e.type === 'user' && e.message.content[0].type === 'tool_result');
  assert.equal(answer.message.content[0].content, '# hello\n');
  await c.next((e) => toolUse(e) && /missing\.md$/.test(e.message.content[0].input.file_path));
  const missing = await c.next((e) => e.type === 'user' && e.message.content[0].type === 'tool_result');
  assert.equal(missing.message.content[0].content, '(file not found)');
  const result = await c.next((e) => e.type === 'result');
  assert.deepEqual(result.structured_output, { summary: 'ok', workItems: [] });
  assert.equal(result.is_error, false);
  await c.done();
});

test('stream: hands the structured output over as StructuredOutput deltas, and hold: keeps it half-written', async () => {
  const c = chat();
  const json = '{"resources":[{"kind":"agents","name":"glossary-reviewer","content":"---\\nname: glossary-reviewer\\n---\\n"}]}';
  c.say(`stream: ${json}\nhold: release\nsay: Written.`);
  const start = await c.next((e) => e.type === 'stream_event' && e.event.type === 'content_block_start');
  assert.equal(start.event.content_block.name, 'StructuredOutput');
  const partial = () =>
    c.events
      .filter((e) => e.type === 'stream_event' && e.event.delta?.type === 'input_json_delta')
      .map((e) => e.event.delta.partial_json)
      .join('');
  await new Promise((r) => setTimeout(r, 300));
  // Held: half the file is out, and no result yet
  assert.equal(partial(), json.slice(0, Math.floor(json.length / 2)));
  assert.ok(!c.events.some((e) => e.type === 'result'));
  writeFileSync(join(c.dir, 'release'), '');
  const result = await c.next((e) => e.type === 'result');
  assert.equal(partial(), json);
  assert.ok(c.events.some((e) => e.type === 'stream_event' && e.event.type === 'content_block_stop'));
  assert.deepEqual(result.structured_output, JSON.parse(json));
  assert.equal(result.result, 'Written.');
  await c.done();
});

test('type: streams an answer as text deltas, hold: keeps it half-written, then it is handed over whole', async () => {
  const c = chat();
  c.say('type: Here is the fix:\\n\\n```ts\\nconst answer = 42;\\n```\\nThat is all.\nhold: release');
  const start = await c.next((e) => e.type === 'stream_event' && e.event.type === 'content_block_start');
  assert.equal(start.event.content_block.type, 'text');
  const typed = () =>
    c.events
      .filter((e) => e.type === 'stream_event' && e.event.delta?.type === 'text_delta')
      .map((e) => e.event.delta.text)
      .join('');
  const whole = 'Here is the fix:\n\n```ts\nconst answer = 42;\n```\nThat is all.';
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(typed(), whole.slice(0, Math.floor(whole.length / 2)));
  assert.ok(!c.events.some((e) => e.type === 'assistant' || e.type === 'result'));
  writeFileSync(join(c.dir, 'release'), '');
  const said = await c.next((e) => e.type === 'assistant');
  assert.equal(typed(), whole);
  assert.equal(text(said), whole);
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.result, whole);
  await c.done();
});

test('an interrupt during a read ends the turn at once', async () => {
  const c = chat({ CLAUDIO_FAKE_CLI_READ_MS: '60000' });
  c.say('read: README.md');
  await c.next((e) => toolUse(e) && e.message.content[0].name === 'Read');
  c.send({ type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } });
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.is_error, true);
  await c.done();
});

test('a message holding a key of the scripts file is played as its script', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-fake-cli-scripts-'));
  const scripts = join(dir, 'scripts.json');
  writeFileSync(scripts, JSON.stringify({ 'Tidy the imports': 'say: Sorted them.\nrun: echo sorted' }));
  const c = chat({ CLAUDIO_FAKE_CLI_SCRIPTS: scripts });
  c.say('You are a worker.\n\nYour task (tidy):\nTidy the imports\n\nFinish with a report.');
  assert.equal(text(await c.next((e) => e.type === 'assistant')), 'Sorted them.');
  await c.next((e) => toolUse(e) && e.message.content[0].input.command === 'echo sorted');
  await c.next((e) => e.type === 'result');
  c.say('anything else');
  assert.equal(text(await c.next((e) => e.type === 'assistant')), 'Heard: anything else');
  await c.done();
  rmSync(dir, { recursive: true, force: true });
});

test('FAKE-LIMIT reports a rejected window, then a 429 result, every time it is sent', async () => {
  const c = chat();
  for (let i = 0; i < 2; i++) {
    c.say('FAKE-LIMIT');
    const event = await c.next((e) => e.type === 'rate_limit_event');
    assert.equal(event.rate_limit_info.status, 'rejected');
    assert.ok(event.rate_limit_info.resetsAt > Date.now() / 1000);
    const result = await c.next((e) => e.type === 'result');
    assert.equal(result.is_error, true);
    assert.equal(result.api_error_status, 429);
  }
  await c.done();
});

test('FAKE-LIMIT-CLEAR reports the window allowed again at no use, and the turn ends well', async () => {
  const c = chat();
  c.say('FAKE-LIMIT-CLEAR');
  const event = await c.next((e) => e.type === 'rate_limit_event');
  assert.equal(event.rate_limit_info.status, 'allowed');
  assert.equal(event.rate_limit_info.unifiedWindows['5h'].utilization, 0);
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.is_error, false);
  await c.done();
});

test('--worktree works in a worktree of the repository, on its own branch, as the CLI does', async () => {
  const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fake', GIT_AUTHOR_EMAIL: 'fake@example.com', GIT_COMMITTER_NAME: 'Fake', GIT_COMMITTER_EMAIL: 'fake@example.com' } });
  const c = chat({}, {
    args: ['--worktree', 'tidy'],
    setup: (dir) => {
      git(dir, 'init', '-q');
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'start');
    },
  });
  const init = await c.next((e) => e.type === 'system' && e.subtype === 'init');
  assert.match(init.cwd, /\/\.claude\/worktrees\/tidy$/);
  assert.equal(git(init.cwd, 'branch', '--show-current').stdout.trim(), 'worktree-tidy');
  c.say('run: pwd');
  await c.next(toolUse);
  assert.equal((await c.next((e) => e.type === 'user')).message.content[0].content, init.cwd);
  await c.done();
});

test('with --replay-user-messages each message is read back under its id when a turn takes it', async () => {
  const c = chat({}, { args: ['--replay-user-messages'] });
  const send = (said, uuid) => c.send({ type: 'user', uuid, message: { role: 'user', content: said } });
  send('run: sleep 1\nrun: true', 'u-first');
  assert.equal((await c.next((e) => e.type === 'user' && e.isReplay)).uuid, 'u-first');
  await c.next(toolUse);
  // Sent during the call: read back right after its result, inside the same turn
  send('and one more', 'u-second');
  await c.next((e) => e.type === 'user' && !e.isReplay);
  assert.equal((await c.next((e) => e.type === 'user' && e.isReplay)).uuid, 'u-second');
  assert.ok(c.log().some((l) => l.event === 'stdin' && l.uuid === 'u-second'));
  await c.next((e) => e.type === 'result');
  await c.done();
});

test('mcp_status lists the servers and mcp_toggle switches one, as the CLI does', async () => {
  const c = chat();
  c.send({ type: 'control_request', request_id: 'm-1', request: { subtype: 'mcp_status' } });
  const listed = await c.next((e) => e.type === 'control_response' && e.response.request_id === 'm-1');
  assert.deepEqual(listed.response.response.mcpServers.map((s) => [s.name, s.status]), [['docs', 'connected'], ['claude.ai Calendar', 'needs-auth']]);
  c.send({ type: 'control_request', request_id: 'm-2', request: { subtype: 'mcp_toggle', serverName: 'docs', enabled: false } });
  assert.equal((await c.next((e) => e.type === 'control_response' && e.response.request_id === 'm-2')).response.subtype, 'success');
  c.send({ type: 'control_request', request_id: 'm-3', request: { subtype: 'mcp_status' } });
  const after = await c.next((e) => e.type === 'control_response' && e.response.request_id === 'm-3');
  assert.equal(after.response.response.mcpServers[0].status, 'disabled');
  await c.done();
});

const control = (c, id, request) => {
  c.send({ type: 'control_request', request_id: id, request });
  return c.next((e) => e.type === 'control_response' && e.response.request_id === id);
};
const status = (e) => e.type === 'system' && e.subtype === 'status';

test('get_usage answers the plan, both windows, a model-scoped weekly limit and the credits', async () => {
  const c = chat();
  const usage = (await control(c, 'g-1', { subtype: 'get_usage' })).response.response;
  assert.equal(usage.subscription_type, 'max');
  assert.equal(usage.rate_limits_available, true);
  assert.equal(usage.rate_limits.five_hour.utilization, 5);
  assert.equal(usage.rate_limits.limits.find((l) => l.kind === 'weekly_scoped').scope.model.display_name, 'Fable');
  assert.equal(usage.rate_limits.extra_usage.is_enabled, false);
});

test('get_usage answers the recorded refusal for an invalid token or key', async () => {
  for (const variable of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    const c = chat({ [variable]: 'invalid' });
    const usage = (await control(c, 'g-bad', { subtype: 'get_usage' })).response.response;
    const recorded = JSON.parse(readFileSync(join(dirname(bin), '../../packages/accounts/test/fixtures/get-usage-refused-api-key.json'), 'utf8'));
    assert.equal(usage.rate_limits_available, false);
    assert.deepEqual(Object.keys(usage), Object.keys(recorded));
    c.done();
  }
});

test('auth login prints the link, takes the code on stdin and writes the credentials; a bad code fails', async () => {
  const run = (code) =>
    new Promise((resolve) => {
      const dir = mkdtempSync(join(tmpdir(), 'claudio-fake-login-'));
      const proc = spawn(bin, ['auth', 'login'], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      proc.stdout.on('data', (d) => {
        out += d;
        if (out.includes('authorize?fake=1') && proc.stdin.writable) proc.stdin.write(`${code}\n`);
      });
      proc.on('exit', (exit) => resolve({ exit, dir, out }));
    });
  const good = await run('abc#123');
  assert.equal(good.exit, 0);
  assert.match(good.out, /https:\/\/claude\.ai\/oauth\/authorize\?fake=1/);
  const credentials = JSON.parse(readFileSync(join(good.dir, '.credentials.json'), 'utf8'));
  assert.ok(credentials.claudeAiOauth.refreshToken);
  const bad = await run('bad');
  assert.equal(bad.exit, 1);
  assert.equal(existsSync(join(bad.dir, '.credentials.json')), false);
});

test('get_context_usage answers the recorded shape, with 93 MCP tools on two servers, and refuses a bad detail', async () => {
  const c = chat({ CLAUDIO_FAKE_CLI_COMPACT_MS: '50' });
  const summary = (await control(c, 'u-1', { subtype: 'get_context_usage', detail: 'summary' })).response.response;
  const recorded = JSON.parse(readFileSync(join(dirname(bin), '../../packages/core/test/fixtures/recordings/claude/context-usage-summary.json'), 'utf8'));
  assert.deepEqual(Object.keys(summary), Object.keys(recorded));
  assert.equal(summary.mcpTools.length, 93);
  assert.deepEqual([...new Set(summary.mcpTools.map((t) => t.serverName))], ['alpha', 'beta']);
  assert.equal(summary.mcpTools.filter((t) => t.isLoaded).length, 93);
  const loaded = summary.categories.find((cat) => cat.name === 'MCP tools');
  assert.equal(loaded.tokens, summary.mcpTools.reduce((n, t) => n + t.tokens, 0));
  assert.ok(summary.categories.some((cat) => cat.kind === 'deferred'));
  // No detail is `full`, as the CLI does
  const bare = (await control(c, 'u-2', { subtype: 'get_context_usage' })).response.response;
  const full = (await control(c, 'u-3', { subtype: 'get_context_usage', detail: 'full' })).response.response;
  assert.deepEqual(bare, full);
  const bad = await control(c, 'u-4', { subtype: 'get_context_usage', detail: 'bogus' });
  assert.equal(bad.response.subtype, 'error');
  assert.equal(bad.response.error, "get_context_usage: detail must be 'summary' or 'full'");
  // After a compaction the total is the boundary's post_tokens
  const before = summary.totalTokens;
  c.say('/compact');
  await c.next((e) => e.type === 'result');
  const after = (await control(c, 'u-5', { subtype: 'get_context_usage', detail: 'summary' })).response.response;
  assert.ok(after.totalTokens < before);
  assert.equal(after.totalTokens, 1655);
  await c.done();
});

test('/compact plays the recorded sequence: status, boundary, summary, stdout, result', async () => {
  const c = chat({ CLAUDIO_FAKE_CLI_COMPACT_MS: '50' }, { args: ['--replay-user-messages'] });
  c.send({ type: 'user', uuid: 'u-compact', message: { role: 'user', content: '/compact Keep the plan' } });
  assert.equal((await c.next(status)).status, 'compacting');
  const ended = await c.next(status);
  assert.deepEqual([ended.status, ended.compact_result], [null, 'success']);
  const boundary = await c.next((e) => e.type === 'system' && e.subtype === 'compact_boundary');
  assert.equal(boundary.compact_metadata.trigger, 'manual');
  assert.equal(boundary.compact_metadata.post_tokens, 1655);
  assert.ok(boundary.compact_metadata.pre_tokens > boundary.compact_metadata.post_tokens);
  const summary = await c.next((e) => e.type === 'user' && e.uuid !== 'u-compact' && !e.isReplay);
  assert.match(summary.message.content, /^This session is being continued from a previous conversation/);
  const stdout = await c.next((e) => e.type === 'user' && e.isReplay && e.uuid !== 'u-compact');
  assert.match(stdout.message.content, /<local-command-stdout>Compacted/);
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.is_error, false);
  // Not a turn of the model: it said nothing in words of its own
  assert.ok(!c.events.some((e) => text(e)));
  await c.done();
});

test('/compact writes the boundary and the summary to the transcript when one is kept', async () => {
  const config = mkdtempSync(join(tmpdir(), 'claudio-fake-cli-config-'));
  try {
    const c = chat({ CLAUDIO_FAKE_CLI_COMPACT_MS: '50', CLAUDIO_FAKE_CLI_TRANSCRIPT: '1', CLAUDE_CONFIG_DIR: config });
    c.say('/compact');
    await c.next((e) => e.type === 'result');
    const files = [];
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).forEach((d) => (d.isDirectory() ? walk(join(dir, d.name)) : files.push(join(dir, d.name))));
    walk(config);
    const lines = readFileSync(files[0], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const boundary = lines.find((l) => l.subtype === 'compact_boundary');
    assert.equal(boundary.compactMetadata.postTokens, 1655);
    const summary = lines.find((l) => l.isCompactSummary);
    assert.equal(summary.parentUuid, boundary.uuid);
    await c.done();
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test('a /compact that says FAKE-COMPACT-FAIL fails as the recording does, and the process goes on', async () => {
  const c = chat({ CLAUDIO_FAKE_CLI_COMPACT_MS: '50' });
  c.say('/compact FAKE-COMPACT-FAIL');
  assert.equal((await c.next(status)).status, 'compacting');
  const failed = await c.next(status);
  assert.deepEqual([failed.status, failed.compact_result, failed.compact_error], [null, 'failed', 'API Error: Request was aborted.']);
  await c.next((e) => e.type === 'system' && e.subtype === 'init');
  assert.equal(text(await c.next((e) => e.type === 'assistant')), 'Compaction canceled.');
  const result = await c.next((e) => e.type === 'result');
  assert.equal(result.is_error, false);
  assert.ok(!c.events.some((e) => e.subtype === 'compact_boundary'));
  c.say('after the failure');
  assert.equal(text(await c.next((e) => e.type === 'assistant')), 'Heard: after the failure');
  await c.done();
});

test('an interrupt during a compaction fails it, and a message sent meanwhile is answered after', async () => {
  const c = chat();
  c.say('/compact FAKE-COMPACT-SLOW');
  assert.equal((await c.next(status)).status, 'compacting');
  c.say('and then this');
  c.send({ type: 'control_request', request_id: 'i-1', request: { subtype: 'interrupt' } });
  assert.equal((await c.next(status)).compact_result, 'failed');
  assert.equal(text(await c.next((e) => e.type === 'assistant' && text(e) === 'Heard: and then this')), 'Heard: and then this');
  await c.done();
});

const toolResultOf = (e) => (e.type === 'user' && Array.isArray(e.message.content) ? e.message.content.find((b) => b.type === 'tool_result') : undefined);
const system = (subtype) => (e) => e.type === 'system' && e.subtype === subtype;

test('read: and run: results carry tool_use_result in the shapes the CLI writes', async () => {
  const c = chat({ CLAUDIO_FAKE_CLI_READ_MS: '50' }, { setup: (dir) => writeFileSync(join(dir, 'notes.txt'), 'one\ntwo\n') });
  c.say('read: notes.txt\nrun: echo out; echo err >&2\nrun: exit 3');
  const read = await c.next((e) => toolResultOf(e) !== undefined);
  assert.equal(read.tool_use_result.type, 'text');
  assert.match(read.tool_use_result.file.filePath, /notes\.txt$/);
  const { content, numLines, startLine, totalLines } = read.tool_use_result.file;
  assert.deepEqual([content, numLines, startLine, totalLines], ['one\ntwo\n', 2, 1, 2]);
  const ran = await c.next((e) => toolResultOf(e) !== undefined);
  assert.deepEqual(ran.tool_use_result, { stdout: 'out', stderr: 'err', interrupted: false, isImage: false, noOutputExpected: false });
  // A call that failed records the error as a string, not an object
  const failed = await c.next((e) => toolResultOf(e) !== undefined);
  assert.equal(toolResultOf(failed).is_error, true);
  assert.equal(typeof failed.tool_use_result, 'string');
  await c.next((e) => e.type === 'result');
  await c.done();
});

test('agent: plays a subagent: the call, task_started, its sidechain, then its result and task_notification', async () => {
  const c = chat({ CLAUDIO_FAKE_CLI_READ_MS: '50' }, { setup: (dir) => writeFileSync(join(dir, 'a.txt'), 'a\n') });
  c.say('agent: Look at a | read: a.txt; run: echo inside');
  const call = await c.next((e) => toolUse(e) && e.message.content[0].name === 'Agent');
  const { id, input } = call.message.content[0];
  assert.deepEqual(input, { description: 'Look at a', subagent_type: 'Explore', prompt: 'Look around' });
  assert.equal(call.parent_tool_use_id, null);
  const started = await c.next(system('task_started'));
  assert.deepEqual([started.task_type, started.tool_use_id, started.is_backgrounded], ['local_agent', id, false]);
  const agentId = started.task_id;
  const inner = await c.next((e) => toolUse(e) && e.message.content[0].name === 'Read');
  assert.deepEqual([inner.parent_tool_use_id, inner.isSidechain], [id, true]);
  const innerRead = await c.next((e) => toolResultOf(e) !== undefined);
  assert.deepEqual([innerRead.parent_tool_use_id, innerRead.isSidechain, innerRead.tool_use_result.type], [id, true, 'text']);
  await c.next((e) => toolUse(e) && e.parent_tool_use_id === id && e.message.content[0].name === 'Bash');
  const innerRun = await c.next((e) => toolResultOf(e) !== undefined);
  assert.equal(innerRun.tool_use_result.stdout, 'inside');
  const done = await c.next((e) => toolResultOf(e)?.tool_use_id === id);
  assert.equal(done.parent_tool_use_id, null);
  const { agentId: reported, status, description, prompt } = done.tool_use_result;
  assert.deepEqual([reported, status, description, prompt], [agentId, 'completed', 'Look at a', 'Look around']);
  const ended = await c.next(system('task_notification'));
  assert.deepEqual([ended.task_id, ended.status], [agentId, 'completed']);
  assert.ok(ended.summary);
  await c.next((e) => e.type === 'result');
  assert.ok(c.log().some((l) => l.event === 'agent' && l.agentId === agentId && l.background === false));
  assert.ok(c.log().some((l) => l.event === 'agent-ended' && l.agentId === agentId));
  await c.done();
});

test('a background agent answers at once and runs after the next step; background: runs a command beside the turn', async () => {
  const c = chat({ CLAUDIO_FAKE_CLI_READ_MS: '50' });
  c.say('agent: background: Watch it | read: a.txt; hold: go\nbackground: sleep 0.3\nsay: Both started.');
  const call = await c.next((e) => toolUse(e) && e.message.content[0].name === 'Agent');
  const agentCall = call.message.content[0].id;
  const started = await c.next(system('task_started'));
  assert.deepEqual([started.task_type, started.is_backgrounded], ['local_agent', true]);
  const launched = await c.next((e) => toolResultOf(e)?.tool_use_id === agentCall);
  assert.deepEqual([launched.tool_use_result.status, launched.tool_use_result.isAsync, launched.tool_use_result.agentId], ['async_launched', true, started.task_id]);
  // The next step comes before anything of the sidechain
  const bash = await c.next((e) => toolUse(e));
  assert.equal(bash.parent_tool_use_id, null);
  assert.deepEqual(bash.message.content[0].input, { command: 'sleep 0.3', description: 'Run sleep 0.3', run_in_background: true });
  const answered = await c.next((e) => toolResultOf(e) !== undefined);
  const taskId = answered.tool_use_result.backgroundTaskId;
  assert.match(taskId, /^b\w+$/);
  assert.deepEqual([answered.tool_use_result.stdout, answered.tool_use_result.stderr, answered.tool_use_result.interrupted], ['', '', false]);
  const task = await c.next(system('task_started'));
  assert.deepEqual([task.task_id, task.task_type, task.is_backgrounded, task.tool_use_id], [taskId, 'local_bash', true, bash.message.content[0].id]);
  // The sidechain's read is held open by its hold, and the turn ends meanwhile
  await c.next((e) => toolUse(e) && e.parent_tool_use_id === agentCall);
  await c.next((e) => e.type === 'result');
  const until = Date.now() + 5000;
  while (!c.events.some((e) => e.subtype === 'task_notification' && e.task_id === taskId) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.events.find((e) => e.subtype === 'task_notification' && e.task_id === taskId)?.status, 'completed');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!c.events.some((e) => toolResultOf(e) !== undefined && e.parent_tool_use_id === agentCall), 'the held read is still open');
  writeFileSync(join(c.dir, 'go'), '');
  const read = await c.next((e) => toolResultOf(e) !== undefined && e.parent_tool_use_id === agentCall);
  assert.equal(read.tool_use_result, '(file not found)');
  const agentEnded = await c.next((e) => e.subtype === 'task_notification' && e.task_id === started.task_id);
  assert.equal(agentEnded.status, 'completed');
  assert.ok(c.log().some((l) => l.event === 'background-ended' && l.taskId === taskId && l.code === 0));
  await c.done();
});

test('a transcript records toolUseResult, the subagent in its own file, and the notifications a reload reads', async () => {
  const config = mkdtempSync(join(tmpdir(), 'claudio-fake-cli-config-'));
  try {
    const c = chat({ CLAUDIO_FAKE_CLI_READ_MS: '50', CLAUDIO_FAKE_CLI_TRANSCRIPT: '1', CLAUDE_CONFIG_DIR: config });
    c.say('agent: Look | run: echo inside\nbackground: true');
    const started = await c.next(system('task_started'));
    await c.next((e) => e.type === 'result');
    const until = Date.now() + 5000;
    while (c.events.filter((e) => e.subtype === 'task_notification').length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    const files = [];
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).forEach((d) => (d.isDirectory() ? walk(join(dir, d.name)) : files.push(join(dir, d.name))));
    walk(config);
    const read = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const session = files.find((f) => f.endsWith('/fake-session.jsonl'));
    const agentFile = files.find((f) => f.endsWith(`/fake-session/subagents/agent-${started.task_id}.jsonl`));
    const meta = files.find((f) => f.endsWith(`/fake-session/subagents/agent-${started.task_id}.meta.json`));
    assert.ok(session && agentFile && meta, files.join(', '));
    const lines = read(session);
    assert.ok(lines.some((l) => l.toolUseResult?.agentId === started.task_id && l.toolUseResult.status === 'completed'));
    assert.ok(lines.some((l) => typeof l.toolUseResult?.backgroundTaskId === 'string'));
    assert.ok(!lines.some((l) => l.isSidechain), 'the sidechain stays out of the session file');
    const notes = lines.filter((l) => l.type === 'queue-operation' && /<task-notification>/.test(l.content ?? ''));
    assert.ok(notes.some((l) => l.content.includes(`<task-id>${started.task_id}</task-id>`) && l.content.includes('<status>completed</status>')));
    assert.equal(notes.length, 2);
    const own = read(agentFile);
    assert.ok(own.every((l) => l.isSidechain === true && l.agentId === started.task_id && l.parentToolUseID === started.tool_use_id));
    assert.ok(own.some((l) => l.toolUseResult?.stdout === 'inside'));
    assert.deepEqual(JSON.parse(readFileSync(meta, 'utf8')), { agentType: 'Explore', description: 'Look', toolUseId: started.tool_use_id });
    await c.done();
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

/** A settings file like the guard's: SessionStart and PreToolUse run one script, which blocks a command that contains `push` */
function guardSetup(dir) {
  const script = join(dir, 'hook.sh');
  writeFileSync(script, 'input=$(cat)\ncase "$input" in *\'"hook_event_name":"SessionStart"\'*) echo "claudio-guard/1 armed" >&2; exit 0;; esac\ncase "$input" in *push*) echo "Claudio guard blocked this (push): no pushing" >&2; exit 2;; esac\necho "claudio-guard/1 pass" >&2\nexit 0\n');
  const hook = { matcher: '*', hooks: [{ type: 'command', command: `sh ${script}` }] };
  const settings = join(dir, 'settings.json');
  writeFileSync(settings, JSON.stringify({ disableAllHooks: false, hooks: { SessionStart: [hook], PreToolUse: [hook] } }));
  return ['--settings', settings, '--include-hook-events'];
}
const hookResponse = (event) => (e) => e.type === 'system' && e.subtype === 'hook_response' && e.hook_event === event;

test('--settings: SessionStart runs before init, a passing command runs and a hook_response follows its call', async () => {
  const c = chat({}, { args: guardSetup });
  const start = await c.next(hookResponse('SessionStart'));
  assert.equal(start.exit_code, 0);
  const init = await c.next((e) => e.subtype === 'init');
  assert.equal(c.events.indexOf(init), c.events.indexOf(start) + 1);
  c.say('run: echo fine');
  await c.next(toolUse);
  const pass = await c.next(hookResponse('PreToolUse'));
  assert.equal(pass.hook_name, 'PreToolUse:Bash');
  assert.match(pass.stderr, /claudio-guard\/1 pass/);
  const result = await c.next((e) => e.type === 'user');
  assert.deepEqual([result.message.content[0].content, result.message.content[0].is_error], ['fine', false]);
  await c.done();
});

test('--settings: exit 2 blocks the command, which never runs, and the tool_result carries the CLI\'s text', async () => {
  const c = chat({}, { args: guardSetup });
  await c.next(hookResponse('SessionStart'));
  c.say('run: touch ran-push && git push');
  const call = await c.next(toolUse);
  const response = await c.next(hookResponse('PreToolUse'));
  assert.equal(response.exit_code, 2);
  assert.equal(response.outcome, 'error');
  const result = await c.next((e) => e.type === 'user');
  assert.equal(result.message.content[0].tool_use_id, call.message.content[0].id);
  assert.equal(result.message.content[0].is_error, true);
  assert.match(result.message.content[0].content, /^PreToolUse:Bash hook error: \[sh .*hook\.sh\]: Claudio guard blocked this \(push\): no pushing/);
  assert.ok(!existsSync(join(c.dir, 'ran-push')), 'a blocked command never runs');
  assert.ok(c.log().some((l) => l.event === 'command-blocked'));
  await c.done();
});

test('--settings: CLAUDIO_FAKE_CLI_NO_HOOKS=1 leaves a call with no hook_response, and NO_ARM=1 no SessionStart', async () => {
  const c = chat({ CLAUDIO_FAKE_CLI_NO_HOOKS: '1', CLAUDIO_FAKE_CLI_NO_ARM: '1' }, { args: guardSetup });
  await c.next((e) => e.subtype === 'init');
  c.say('run: echo push');
  await c.next(toolUse);
  const result = await c.next((e) => e.type === 'user');
  assert.equal(result.message.content[0].is_error, false);
  assert.ok(!c.events.some((e) => e.subtype === 'hook_response'), 'no hook ran');
  await c.done();
});

test('edit:, write: and skill: emit the Edit, Write and Skill shapes and touch the disk', async () => {
  const c = chat({ CLAUDIO_FAKE_CLI_READ_MS: '50' }, { setup: (dir) => writeFileSync(join(dir, 'a.txt'), 'one\n') });
  c.say('edit: a.txt\nwrite: sub/b.txt hello there\nskill: review\nedit: missing.txt');
  const call = async (name) => {
    const e = await c.next((x) => x.type === 'assistant' && x.message.content.some((b) => b.type === 'tool_use' && b.name === name));
    return e.message.content.find((b) => b.type === 'tool_use');
  };
  const edit = await call('Edit');
  assert.match(edit.input.file_path, /\/a\.txt$/);
  assert.deepEqual([edit.input.old_string, edit.input.new_string, edit.input.replace_all], ['one\n', 'one\nedited by the fake CLI\n', false]);
  const edited = await c.next((e) => toolResultOf(e) !== undefined);
  assert.equal(edited.tool_use_result.originalFile, 'one\n');
  assert.equal(edited.tool_use_result.userModified, false);
  const write = await call('Write');
  assert.deepEqual([write.input.content, /\/sub\/b\.txt$/.test(write.input.file_path)], ['hello there', true]);
  const written = await c.next((e) => toolResultOf(e) !== undefined);
  assert.equal(written.tool_use_result.type, 'create');
  assert.equal(readFileSync(write.input.file_path, 'utf8'), 'hello there');
  assert.equal(readFileSync(edit.input.file_path, 'utf8'), 'one\nedited by the fake CLI\n');
  const skill = await call('Skill');
  assert.deepEqual(skill.input, { skill: 'review' });
  const launched = await c.next((e) => toolResultOf(e) !== undefined);
  assert.deepEqual(launched.tool_use_result, { success: true, commandName: 'review' });
  await call('Edit');
  const failed = await c.next((e) => toolResultOf(e) !== undefined);
  assert.equal(toolResultOf(failed).is_error, true);
  await c.next((e) => e.type === 'result');
  await c.done();
});
