import assert from 'node:assert/strict';
import test from 'node:test';
import { chatTurnOf, parseChatCompletionRequest, renderCold, renderDelta, sameJsonSchema, translateRequest, uploadImages, type ChatTurn, type ImageUploads } from '../src/openai/request.ts';
import type { ChatCompletionRequest } from '../src/openai/wire.ts';

// The request half of the OpenAI-compatible surface (docs/openai-compatible-api.md): a client's body
// becomes what a chat start needs, or an OpenAI-shaped 400, and never a throw.

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a20000000049454e44ae426082', 'hex');
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`;

function parsed(body: unknown): ChatCompletionRequest {
  const result = parseChatCompletionRequest(body);
  if (!result.ok) assert.fail(`expected a valid request, got ${JSON.stringify(result.error.body)}`);
  return result.value;
}

function turn(body: unknown): ChatTurn {
  const result = chatTurnOf(body);
  if (!result.ok) assert.fail(`expected a valid request, got ${JSON.stringify(result.error.body)}`);
  return result.value;
}

function refused(body: unknown, options: Parameters<typeof parseChatCompletionRequest>[1] = {}) {
  const result = parseChatCompletionRequest(body, options);
  assert.equal(result.ok, false, 'the request should have been refused');
  if (result.ok) throw new Error('unreachable');
  return result.error;
}

const user = (content: unknown) => ({ role: 'user', content });

test('a malformed body is a 400 in OpenAI shape, never a throw', () => {
  for (const body of [null, 'text', 42, [], { messages: [user('hi')] }, { model: '', messages: [user('hi')] }, { model: 'm' }, { model: 'm', messages: [] }, { model: 'm', messages: 'hi' }]) {
    const error = refused(body);
    assert.equal(error.status, 400);
    assert.equal(error.body.error.type, 'invalid_request_error');
    assert.equal(typeof error.body.error.message, 'string');
    assert.ok('param' in error.body.error && 'code' in error.body.error);
  }
  assert.equal(refused({ messages: [user('hi')] }).body.error.param, 'model');
});

test('a bad message names where it is, by path', () => {
  assert.equal(refused({ model: 'm', messages: [user('hi'), 7] }).body.error.param, 'messages[1]');
  assert.equal(refused({ model: 'm', messages: [{ role: 'wizard', content: 'x' }] }).body.error.param, 'messages[0].role');
  assert.equal(refused({ model: 'm', messages: [{ role: 'tool', content: 'x' }] }).body.error.param, 'messages[0].tool_call_id');
  assert.equal(refused({ model: 'm', messages: [user([{ type: 'text' }])] }).body.error.param, 'messages[0].content[0]');
  const audio = refused({ model: 'm', messages: [user([{ type: 'input_audio', input_audio: {} }])] });
  assert.equal(audio.body.error.code, 'unsupported_parameter');
  assert.equal(audio.body.error.param, 'messages[0].content[0].type');
});

test('a history that ends with the assistant is refused: the CLI cannot continue a reply the client began', () => {
  const error = refused({ model: 'm', messages: [user('hi'), { role: 'assistant', content: 'Hel' }] });
  assert.equal(error.body.error.param, 'messages');
});

test('n above one is a 400, and n of one is fine', () => {
  const error = refused({ model: 'm', n: 2, messages: [user('hi')] });
  assert.equal(error.status, 400);
  assert.equal(error.body.error.type, 'invalid_request_error');
  assert.equal(error.body.error.param, 'n');
  assert.equal(refused({ model: 'm', n: 0, messages: [user('hi')] }).body.error.param, 'n');
  assert.equal(parsed({ model: 'm', n: 1, messages: [user('hi')] }).ignored.length, 0);
});

test('parameters the CLI cannot honour are named back, not refused', () => {
  const request = parsed({
    model: 'm',
    messages: [user('hi')],
    max_tokens: 100,
    max_completion_tokens: 100,
    temperature: 0,
    top_p: 1,
    stop: ['x'],
    logprobs: true,
    seed: 3,
    presence_penalty: null,
  });
  assert.deepEqual(request.ignored, ['max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'logprobs', 'seed']);
  assert.deepEqual(parsed({ model: 'm', messages: [user('hi')], logprobs: false }).ignored, [], 'logprobs: false asks for nothing');
});

test('audio output is refused rather than silently answered in text', () => {
  assert.equal(refused({ model: 'm', messages: [user('hi')], modalities: ['text', 'audio'] }).body.error.code, 'unsupported_parameter');
});

test('system and developer messages become the appended system prompt, wherever they stand', () => {
  const t = turn({
    model: 'sonnet',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'developer', content: [{ type: 'text', text: 'Answer in English.' }] },
      user('hi'),
    ],
  });
  assert.equal(t.appendSystemPrompt, 'Be brief.\n\nAnswer in English.');
  assert.equal(t.cold.prompt, 'hi');
  assert.ok(!t.cold.prompt.includes('Be brief'), 'the system prompt is not repeated in the prompt');
  assert.equal(turn({ model: 'm', messages: [user('hi')] }).appendSystemPrompt, undefined);
});

test('the model passes through, and string and array text content read the same', () => {
  const a = turn({ model: 'claude-sonnet-4-5', messages: [user('hello there')] });
  const b = turn({ model: 'claude-sonnet-4-5', messages: [user([{ type: 'text', text: 'hello there' }])] });
  assert.equal(a.model, 'claude-sonnet-4-5');
  assert.equal(a.cold.prompt, b.cold.prompt);
});

test('reasoning_effort maps to effort, and an unknown level is a 400', () => {
  assert.equal(turn({ model: 'm', messages: [user('x')], reasoning_effort: 'high' }).effort, 'high');
  assert.equal(turn({ model: 'm', messages: [user('x')], reasoning_effort: 'minimal' }).effort, 'low');
  assert.equal(turn({ model: 'm', messages: [user('x')] }).effort, undefined);
  assert.equal(refused({ model: 'm', messages: [user('x')], reasoning_effort: 'toString' }).body.error.param, 'reasoning_effort');
});

test('response_format json_schema becomes the jsonSchema, and json_object an object schema', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  assert.deepEqual(turn({ model: 'm', messages: [user('x')], response_format: { type: 'json_schema', json_schema: { name: 'out', schema } } }).jsonSchema, schema);
  assert.deepEqual(turn({ model: 'm', messages: [user('x')], response_format: { type: 'json_object' } }).jsonSchema, { type: 'object' });
  assert.equal(turn({ model: 'm', messages: [user('x')], response_format: { type: 'text' } }).jsonSchema, undefined);
  assert.equal(refused({ model: 'm', messages: [user('x')], response_format: { type: 'json_schema', json_schema: { name: 'out' } } }).status, 400);
});

test('stream_options.include_usage counts only on a streamed request', () => {
  assert.equal(parsed({ model: 'm', messages: [user('x')], stream: true, stream_options: { include_usage: true } }).includeUsage, true);
  assert.equal(parsed({ model: 'm', messages: [user('x')], stream: true }).includeUsage, false);
  assert.equal(parsed({ model: 'm', messages: [user('x')], stream_options: { include_usage: true } }).includeUsage, false);
  assert.equal(refused({ model: 'm', messages: [user('x')], stream: 'yes' }).body.error.param, 'stream');
});

test('user is kept for the conversation row', () => {
  assert.equal(turn({ model: 'm', messages: [user('x')], user: 'alice' }).user, 'alice');
  assert.equal(turn({ model: 'm', messages: [user('x')] }).user, null);
});

test('client tools are parsed and carried, with tool_choice validated against them', () => {
  const tools = [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
  const t = turn({ model: 'm', messages: [user('x')], tools, tool_choice: { type: 'function', function: { name: 'get_weather' } }, parallel_tool_calls: false });
  assert.equal(t.tools.length, 1);
  assert.equal(t.tools[0]?.name, 'get_weather');
  assert.deepEqual(t.toolChoice, { kind: 'function', name: 'get_weather' });
  assert.equal(t.parallelToolCalls, false);
  assert.deepEqual(turn({ model: 'm', messages: [user('x')], tools }).toolChoice, { kind: 'auto' });
  assert.deepEqual(turn({ model: 'm', messages: [user('x')], tools, tool_choice: 'none' }).toolChoice, { kind: 'none' });
  assert.deepEqual(turn({ model: 'm', messages: [user('x')], tools: [{ type: 'function', function: { name: 'f' } }] }).tools[0]?.parameters, { type: 'object', properties: {} });

  assert.equal(refused({ model: 'm', messages: [user('x')], tools, tool_choice: { type: 'function', function: { name: 'other' } } }).body.error.param, 'tool_choice');
  assert.equal(refused({ model: 'm', messages: [user('x')], tool_choice: 'required' }).body.error.param, 'tool_choice');
  assert.equal(refused({ model: 'm', messages: [user('x')], tools: [...tools, ...tools] }).body.error.param, 'tools');
  assert.equal(refused({ model: 'm', messages: [user('x')], tools: [{ type: 'function', function: { name: 'bad name' } }] }).body.error.param, 'tools[0].function.name');
  assert.equal(refused({ model: 'm', messages: [user('x')], tools: [{ type: 'web_search' }] }).body.error.code, 'unsupported_parameter');
});

test('the legacy functions and function_call read as tools and tool_choice', () => {
  const t = turn({ model: 'm', messages: [user('x')], functions: [{ name: 'lookup', parameters: { type: 'object' } }], function_call: { name: 'lookup' } });
  assert.equal(t.tools[0]?.name, 'lookup');
  assert.deepEqual(t.toolChoice, { kind: 'function', name: 'lookup' });
  assert.equal(refused({ model: 'm', messages: [user('x')], functions: [{ name: 'a' }], tools: [{ type: 'function', function: { name: 'b' } }] }).status, 400);
});

// ---------- images ----------

test('image parts become image references in prompt order, named in the prompt', () => {
  const t = turn({ model: 'm', messages: [user([{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: PNG_URL } }, { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }])] });
  assert.equal(t.cold.prompt, 'What is this?\n[image 1]\n[image 2]');
  assert.equal(t.cold.images.length, 2);
  assert.deepEqual(t.cold.images[0], { kind: 'data', mediaType: 'image/png', base64: PNG.toString('base64'), sizeBytes: PNG.length });
  assert.deepEqual(t.cold.images[1], { kind: 'url', url: 'https://example.com/cat.png' });
});

test('an image URL with another scheme, a non-image type or bad base64 is refused', () => {
  const image = (url: string) => ({ model: 'm', messages: [user([{ type: 'image_url', image_url: { url } }])] });
  assert.equal(refused(image('file:///etc/passwd')).body.error.code, 'unsupported_parameter');
  assert.equal(refused(image('ftp://example.com/a.png')).body.error.code, 'unsupported_parameter');
  assert.equal(refused(image('data:image/svg+xml;base64,PHN2Zz4=')).body.error.code, 'unsupported_parameter');
  assert.equal(refused(image('data:image/png,rawbytes')).status, 400);
  assert.equal(refused(image('data:image/png;base64,***')).status, 400);
  assert.equal(refused(image('not a url')).status, 400);
});

test('a data URL over the size cap is refused before it is decoded', () => {
  const error = refused({ model: 'm', messages: [user([{ type: 'image_url', image_url: { url: PNG_URL } }])] }, { maxImageBytes: PNG.length - 1 });
  assert.equal(error.status, 400);
  assert.equal(error.body.error.param, 'messages[0].content[0].image_url');
  parsed({ model: 'm', messages: [user([{ type: 'image_url', image_url: { url: PNG_URL } }])] });
});

function fakeUploads(fetched: Record<string, Buffer>): ImageUploads & { saved: Array<{ name: string; bytes: Buffer }>; asked: Array<{ url: string; maxBytes: number }> } {
  const saved: Array<{ name: string; bytes: Buffer }> = [];
  const asked: Array<{ url: string; maxBytes: number }> = [];
  return {
    saved,
    asked,
    fetch: (url, maxBytes) => {
      asked.push({ url, maxBytes });
      const bytes = fetched[url];
      return bytes ? Promise.resolve({ bytes, mediaType: 'image/png' }) : Promise.reject(new Error('404 Not Found'));
    },
    save: (name, bytes) => {
      saved.push({ name, bytes });
      return { id: `upload-${String(saved.length)}` };
    },
  };
}

test('image references become uploads in order, data decoded and URLs fetched with the cap', async () => {
  const uploads = fakeUploads({ 'https://example.com/a.png': PNG });
  const t = turn({ model: 'm', messages: [user([{ type: 'image_url', image_url: { url: PNG_URL } }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }])] });
  const result = await uploadImages(t.cold.images, uploads, 1000);
  assert.deepEqual(result, { ok: true, value: ['upload-1', 'upload-2'] });
  assert.deepEqual(uploads.saved[0]?.bytes, PNG);
  assert.equal(uploads.saved[1]?.name, 'openai-image-2.png');
  assert.deepEqual(uploads.asked, [{ url: 'https://example.com/a.png', maxBytes: 1000 }]);
});

test('a fetched image that fails, is too large or is not an image is a 400, and nothing more is saved', async () => {
  const url = (u: string) => [{ kind: 'url' as const, url: u }];
  const failing = await uploadImages(url('https://example.com/missing.png'), fakeUploads({}));
  assert.equal(failing.ok, false);
  if (!failing.ok) assert.match(failing.error.body.error.message, /could not be fetched: 404/);

  const big = fakeUploads({ 'https://example.com/big.png': Buffer.concat([PNG, Buffer.alloc(100)]) });
  const tooLarge = await uploadImages(url('https://example.com/big.png'), big, PNG.length);
  assert.equal(tooLarge.ok, false);
  assert.equal(big.saved.length, 0);

  const html = fakeUploads({ 'https://example.com/page.png': Buffer.from('<html></html>') });
  const notImage = await uploadImages(url('https://example.com/page.png'), html);
  assert.equal(notImage.ok, false);
  if (!notImage.ok) assert.equal(notImage.error.body.error.code, 'unsupported_parameter');
  assert.equal(html.saved.length, 0);
});

// ---------- cold and delta ----------

const conversation = [
  { role: 'system', content: 'Be brief.' },
  user('What is the capital of France?'),
  { role: 'assistant', content: 'Paris.' },
  user('And of Spain?'),
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"country":"Spain"}' } }] },
  { role: 'tool', tool_call_id: 'call_1', content: 'Madrid' },
  user('Thanks. And Italy?'),
];

test('a cold start carries the earlier turns as a transcript, then the new messages', () => {
  const { prompt } = renderCold(parsed({ model: 'm', messages: conversation }).messages);
  assert.match(prompt, /^This conversation began in another client/);
  const transcript = prompt.slice(prompt.indexOf('<earlier-turns>'), prompt.indexOf('</earlier-turns>'));
  assert.ok(transcript.includes('<user>\nWhat is the capital of France?\n</user>'));
  assert.ok(transcript.includes('<assistant>\nParis.\n</assistant>'));
  assert.ok(transcript.includes('<tool-call id="call_1" name="lookup">\n{"country":"Spain"}\n</tool-call>'));
  assert.ok(!transcript.includes('Thanks. And Italy?'), 'the new messages are not part of the earlier turns');
  assert.ok(!prompt.includes('Be brief.'), 'the system prompt is not in the transcript');
  assert.ok(prompt.endsWith('<tool-result id="call_1">\nMadrid\n</tool-result>\n\nThanks. And Italy?'));
});

test('a resume carries only the messages after the last assistant message', () => {
  const request = parsed({ model: 'm', messages: conversation });
  assert.equal(renderDelta(request.messages).prompt, '<tool-result id="call_1">\nMadrid\n</tool-result>\n\nThanks. And Italy?');
  assert.equal(renderDelta(parsed({ model: 'm', messages: [user('a'), { role: 'assistant', content: 'b' }, user('c')] }).messages).prompt, 'c');
});

test('a first message is its own prompt, cold or not: no transcript wrapper around nothing', () => {
  const t = turn({ model: 'm', messages: [user('  hello  ')] });
  assert.equal(t.cold.prompt, 'hello');
  assert.equal(t.delta.prompt, 'hello');
  assert.equal(t.historyKey, null, 'a history with no answer in it has nothing to look up');
});

test('images number per prompt: the cold one counts the earlier turns, the delta only its own', () => {
  const t = turn({
    model: 'm',
    messages: [
      user([{ type: 'image_url', image_url: { url: 'https://example.com/1.png' } }]),
      { role: 'assistant', content: 'A cat.' },
      user([{ type: 'text', text: 'And this?' }, { type: 'image_url', image_url: { url: 'https://example.com/2.png' } }]),
    ],
  });
  assert.equal(t.cold.images.length, 2);
  assert.ok(t.cold.prompt.endsWith('And this?\n[image 2]'));
  assert.deepEqual(t.delta.images, [{ kind: 'url', url: 'https://example.com/2.png' }]);
  assert.equal(t.delta.prompt, 'And this?\n[image 1]');
});

test('the translation carries the history key the route looks the chat up by', () => {
  const request = parsed({ model: 'm', messages: conversation, user: 'alice' });
  const t = translateRequest(request);
  assert.equal(typeof t.historyKey, 'string');
  assert.deepEqual(t.keySeed, { model: 'm', systemPrompt: 'Be brief.', user: 'alice' });
});

test('json_schema strict is recorded on the turn, and schemas compare with their keys sorted', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  assert.equal(turn({ model: 'm', messages: [user('x')], response_format: { type: 'json_schema', json_schema: { name: 'o', schema, strict: true } } }).schemaStrict, true);
  assert.equal(turn({ model: 'm', messages: [user('x')], response_format: { type: 'json_schema', json_schema: { name: 'o', schema } } }).schemaStrict, false);
  assert.equal(turn({ model: 'm', messages: [user('x')], response_format: { type: 'json_object' } }).schemaStrict, null);
  assert.equal(sameJsonSchema(schema, { properties: { a: { type: 'string' } }, type: 'object' }), true);
  assert.equal(sameJsonSchema(schema, { type: 'object' }), false);
  assert.equal(sameJsonSchema(undefined, null), true);
  assert.equal(sameJsonSchema(undefined, schema), false);
});
