import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Core, FetchImageOptions, OpenAiFailure, RunResult } from '@claudio/core';
import {
  abandonsClientCalls,
  allowedToolNames,
  ChatCompletionTranslator,
  CLIENT_TOOL_PREFIX,
  clientToolsProblem,
  renderOpenAiResultsCold,
  resultsProblem,
  sameClientTools,
  toolChoiceInstruction,
  trailingResults,
  type ClientToolSession,
  failureOfSpendCap,
  failureOfThrown,
  fetchOpenAiImage,
  OPENAI_CONVERSATION_TTL_MS,
  openAiError,
  openAiKeyAfterAnswer,
  parseChatCompletionRequest,
  RunSlotRefusal,
  sameJsonSchema,
  STREAM_DONE,
  sweepOpenAiChats,
  translateOpenAiRequest,
  UPLOAD_LIMITS,
  uploadOpenAiImages,
  type ChatCompletionRequest,
  type ChatCompletionStreamItem,
  type OpenAiChatTurn,
  type OpenAiClientCall,
  type OpenAiErrorResponse,
  type OpenAiToolChoice,
} from '@claudio/core';
import type { ModelOption, PermissionMode, RunEvent, SpendCapRefusal } from '@claudio/shared';
import { deliberate } from '../errors.ts';
import { openStream, type SseStream } from '../sse.ts';
import { ClientToolRegistry } from './openai-tools.ts';
import { spendGate } from './spend.ts';

/** Claudio's own parameters travel as headers: strict SDKs refuse body fields they do not know. */
export const CHAT_ID_HEADER = 'x-claudio-chat-id';
export const CWD_HEADER = 'x-claudio-cwd';
export const TOOL_PRESET_HEADER = 'x-claudio-tool-preset';
export const COST_HEADER = 'x-claudio-cost-usd';
export const IGNORED_HEADER = 'x-claudio-ignored';
/** `cold` when the client's tool results resumed a chat whose process had gone (decision 2's fallback) */
export const RESUME_HEADER = 'x-claudio-resume';

const SWEEP_EVERY_MS = 60 * 60 * 1000;
/** What `Retry-After` says when every run slot is taken: idle chats give theirs back within moments */
const RUN_SLOT_RETRY_SECONDS = 5;
/** How long a turn the client walked away from may take to wind down before its locks go */
const INTERRUPT_GRACE_MS = 30_000;
/** How many full-size images one request may carry inline before the body itself is refused */
const INLINE_IMAGES = 4;
/**
 * The body a completion may have: four images at the upload cap as base64 data URLs (4/3 of their
 * bytes) and a megabyte for the text around them. Fastify's 1 MiB default would answer 413 before
 * the parser could say which image is too big, and a single 2 MB photo is an ordinary request.
 */
export const COMPLETION_BODY_LIMIT = INLINE_IMAGES * Math.ceil((UPLOAD_LIMITS.image * 4) / 3) + 1024 * 1024;
/**
 * How long a turn may go without any sign of life (an event, a CLI heartbeat for a running command)
 * before it is given up: interrupted, and answered with an error. Nobody can answer a prompt here,
 * so a turn that stops moving would otherwise hold the request for ever. `CLAUDIO_OPENAI_TURN_IDLE_MS`.
 */
export const turnIdleMs = (): number => {
  const set = Number(process.env.CLAUDIO_OPENAI_TURN_IDLE_MS);
  return Number.isFinite(set) && set > 0 ? set : 10 * 60_000;
};

/**
 * How long a client's tool call is held: the `openaiToolCallTimeoutMinutes` setting.
 * `CLAUDIO_OPENAI_TOOL_CALL_WAIT_MS` overrides it in milliseconds, for tests that cannot wait a minute.
 */
export const toolCallWaitMs = (core: Pick<Core, 'appSettings'>): number => {
  const set = Number(process.env.CLAUDIO_OPENAI_TOOL_CALL_WAIT_MS);
  return Number.isFinite(set) && set > 0 ? set : core.appSettings.openaiToolCallTimeoutMinutes * 60_000;
};

export interface OpenAiRouteOptions {
  core: Core;
  /** How long a conversation outlives its last answer; `OPENAI_CONVERSATION_TTL_MS` by default */
  conversationTtlMs?: number;
  /** For tests: what the image fetcher may reach and how long it waits */
  images?: FetchImageOptions;
  /** The client-tool sessions, shared with the stub route; one of its own when absent */
  clientTools?: ClientToolRegistry;
}

// ---------- errors ----------

class V1Failure extends Error {
  constructor(readonly failure: OpenAiFailure) {
    super(failure.kind);
  }
}

const fail = (failure: OpenAiFailure): V1Failure => new V1Failure(failure);

function answer(reply: FastifyReply, error: OpenAiErrorResponse): FastifyReply {
  if (error.retryAfterSeconds !== undefined) void reply.header('retry-after', String(error.retryAfterSeconds));
  return reply.status(error.status).send(error.body);
}

function isSpendCap(value: unknown): value is SpendCapRefusal {
  return typeof value === 'object' && value !== null && (value as { code?: unknown }).code === 'spend-cap';
}

/**
 * What a throw becomes under `/v1`, decided by the error's class and declared status, never by its
 * wording. A typed refusal keeps its status (`ChatNotFoundError` 404, `ChatConflictError` 409…); a
 * plain hand-thrown `Error` from core is a refusal of the request (`deliberate`), so a 400.
 */
export function failureOf(err: unknown): OpenAiFailure {
  if (err instanceof V1Failure) return err.failure;
  // No run slot is free now: a client retries a 429 by itself, where a 400 would read as its own fault
  if (err instanceof RunSlotRefusal) {
    return { kind: 'usage-limit', resetsAt: Math.floor(Date.now() / 1000) + RUN_SLOT_RETRY_SECONDS, message: `${err.message}: try again in a moment.` };
  }
  if (err instanceof Error && typeof (err as { statusCode?: unknown }).statusCode !== 'number' && deliberate(err)) {
    return { kind: 'invalid-request', message: err.message };
  }
  return failureOfThrown(err);
}

// ---------- models ----------

interface ModelEntry {
  /** As the client asked for it, or the catalogue's value when listing */
  id: string;
  provider: string;
  option: ModelOption;
}

/** The models of every provider that can run chats: the ones with a driver. */
function catalogue(core: Core): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const manifest of core.runtime.providers.list()) {
    const driver = core.runtime.providers.driverFor(manifest.id);
    if (!driver) continue;
    for (const option of driver.models()) if (!option.disabled) out.push({ id: option.value, provider: manifest.id, option });
  }
  return out;
}

/**
 * The catalogue, read from the CLI first when no list is cached yet: the server warms the lists at
 * boot, but a request in the first moments after it (or after the CLI changed version) would
 * otherwise find no model at all and answer 404 for every one.
 */
async function loadedCatalogue(core: Core): Promise<ModelEntry[]> {
  const listed = catalogue(core);
  if (listed.length > 0) return listed;
  await core.accounts.warmModels().catch(() => undefined);
  return catalogue(core);
}

/** A model by its value (`sonnet`) or by a concrete id it stands for (`claude-sonnet-5-5`). */
async function findModel(core: Core, id: string): Promise<ModelEntry | null> {
  const entry = (await loadedCatalogue(core)).find((e) => e.option.value === id || e.option.resolvedModel === id || (e.option.ids ?? []).includes(id));
  return entry ? { ...entry, id } : null;
}

// Models carry no creation date in the CLI's catalogue; 0 says "unknown" without inventing one
const modelObject = (entry: ModelEntry) => ({ id: entry.id, object: 'model' as const, created: 0, owned_by: entry.provider });

// ---------- headers in ----------

/** A header's value as the client wrote it: Node reads header bytes as latin1, a path is UTF-8. */
function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value !== 'string') return undefined;
  const text = Buffer.from(value, 'latin1').toString('utf8').trim();
  return text === '' ? undefined : text;
}

/** Two directories, compared as the filesystem resolves them (a symlinked temp dir, say). */
function sameDir(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

function within(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * `X-Claudio-Cwd`: an absolute path to an existing directory inside the wrapper's workspace or an
 * imported project. Stricter than `cwd` on `POST /chats`, which takes any text and creates the
 * directory: a client that may run Bash should not also choose an arbitrary place to run it.
 */
export function cwdOf(core: Pick<Core, 'config' | 'projectOf'>, value: string): string {
  const refuse = (why: string) => fail({ kind: 'invalid-request', message: `${CWD_HEADER} ${why}`, param: null });
  if (!isAbsolute(value)) throw refuse('must be an absolute path');
  let real: string;
  try {
    real = realpathSync(value);
  } catch {
    throw refuse('names no directory on this machine');
  }
  if (!statSync(real).isDirectory()) throw refuse('names no directory on this machine');
  let workspace = resolve(core.config.workspaceDir);
  try {
    workspace = realpathSync(workspace);
  } catch {
    // not created yet: nothing can be inside it
  }
  if (within(real, workspace) || core.projectOf(real).project !== null) return real;
  throw refuse('must be the workspace or inside a project imported into Claudio');
}

/** The tools and permissions every chat of this surface runs with: nobody is there to answer a prompt. */
function permissionModeOf(core: Core): PermissionMode {
  const mode = core.appSettings.defaultPermissionMode;
  // An unattended request that can run anything without asking is the one thing this surface never does
  return mode === 'bypassPermissions' ? 'manual' : mode;
}

/**
 * What this surface refuses although the parser reads it: the legacy `functions`, tools it cannot
 * serve under the stub's prefix, and client tools together with `response_format` (both would be the
 * answer; not supported yet, the owner's call). `tool_choice: none` makes the tools context the model
 * is told not to use: they are left out and named in `x-claudio-ignored`.
 */
function refusalOf(request: ChatCompletionRequest, body: unknown, ignored: string[]): OpenAiFailure | null {
  const fields = (body ?? {}) as Record<string, unknown>;
  if (Array.isArray(fields.functions) && fields.functions.length > 0) {
    return { kind: 'unsupported-parameter', param: 'functions', message: 'The legacy `functions` parameter is not supported: declare the same functions in `tools`.' };
  }
  if (request.tools.length === 0) return null;
  if (request.toolChoice.kind === 'none') {
    ignored.push('tools');
    return null;
  }
  if (request.responseFormat.type !== 'text') {
    return { kind: 'unsupported-parameter', param: 'response_format', message: 'Client `tools` together with `response_format` are not supported yet: send one or the other.' };
  }
  return clientToolsProblem(request.tools);
}

// ---------- serialising one conversation ----------

/**
 * One turn at a time per conversation. A second request on the same key waits for the first to end
 * rather than being refused: the SDKs retry a 409 anyway, and a queue answers it without the round
 * trip. Keyed by the conversation key and by the chat id, so a request that names the chat and one
 * that finds it by its history wait for each other too.
 */
export class KeyedLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    const before = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = before.then(() => mine);
    this.tails.set(key, tail);
    await before;
    return () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }

  /** Requests holding or waiting for a key: for tests */
  get size(): number {
    return this.tails.size;
  }
}

// ---------- one turn ----------

/**
 * Feeds one turn's events to the translator and hands what it says to whoever writes the answer.
 * Subscribed before the turn is sent, so nothing of it is missed; what arrives before the answer is
 * open waits in `pending`.
 */
class TurnRun {
  chatId: string | null = null;
  /** What this turn alone cost, from the process's cumulative figure (`ChatManager.lastTurn`) */
  costUsd: number | null = null;
  private pending: ChatCompletionStreamItem[] = [];
  private writer: ((items: ChatCompletionStreamItem[]) => void) | null = null;
  private unsubscribe: () => void = () => {};
  private readonly seen = new Set<number>();
  private since = 0;
  private lastSign = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private settle: () => void = () => {};
  readonly done: Promise<void>;

  constructor(
    private readonly core: Core,
    readonly translator: ChatCompletionTranslator,
    /** The turns open now, by chat: where the end of each API message is told (`chat-stop-reason`) */
    private readonly open: Map<string, TurnRun>,
    /** The chat's client-tool session: told each call as it streams, and handed the calls at the end */
    private readonly session: ClientToolSession | null = null,
    private readonly onHandOff: ((calls: OpenAiClientCall[]) => void) | null = null,
  ) {
    this.done = new Promise<void>((r) => {
      this.settle = r;
    });
  }

  get finished(): boolean {
    return this.translator.finished;
  }

  /**
   * Starts listening to the chat, before the turn is sent. `since` is the chat's last event before
   * the turn: once the turn is sent, `replay()` reads what came after it from the buffer, so nothing
   * of this turn is lost and nothing of an earlier one (its `result` above all) is taken for it.
   */
  attach(chatId: string): void {
    this.chatId = chatId;
    this.since = this.core.runtime.streamPosition(chatId)?.seq ?? 0;
    this.lastSign = Date.now();
    this.unsubscribe = this.core.chats.subscribe(chatId, (event) => this.take(event));
    this.open.set(chatId, this);
    // The runtime knows when a turn is over without a result (the process died, a person stopped
    // it) and when a stop is only a limit replay changing accounts: its word ends the turn
    this.core.runtime.nextResult(chatId).then(
      (result) => this.ended(result),
      () => this.ended(null),
    );
    this.watchIdle();
  }

  /** What the buffer holds of this turn and the subscription has not delivered; deduplicated by seq. */
  replay(): void {
    if (this.chatId === null) return;
    for (const event of this.core.chats.events(this.chatId, this.since)) this.take(event);
  }

  /**
   * Gives the turn up when it shows no sign of life for `turnIdleMs()`: no event, and no heartbeat
   * of a command it is running. A prompt nobody answers, or a process that stopped talking, would
   * otherwise hold the request (and its conversation's queue) for ever.
   */
  private watchIdle(): void {
    const limit = turnIdleMs();
    const check = (): void => {
      if (this.finished || this.chatId === null) return;
      const pulse = this.core.runtime.pulse(this.chatId);
      const beats = (pulse?.commands ?? []).map((c) => (c.heartbeat ? Date.parse(c.heartbeat.at) : 0));
      const last = Math.max(this.lastSign, pulse ? Date.parse(pulse.lastEventAt) : 0, ...beats);
      if (Date.now() - last >= limit) {
        void this.core.chats.interrupt(this.chatId).catch(() => undefined);
        this.fail({ kind: 'server', message: `The chat showed no activity for ${String(Math.round(limit / 1000))} s and was interrupted.` });
        return;
      }
      this.idleTimer = setTimeout(check, Math.min(limit, Math.max(250, limit - (Date.now() - last))));
      this.idleTimer.unref();
    };
    this.idleTimer = setTimeout(check, limit);
    this.idleTimer.unref();
  }

  /**
   * One API message ended. One that called client tools ends the HTTP turn here, with the calls, while
   * the CLI's process stays up holding them: waiting for one permission request per call would
   * deadlock, since a CLI may ask for the next call only once the first has run (spike change 2).
   */
  stopReason(reason: string): void {
    if (this.finished || reason !== 'tool_use') return;
    const calls = this.translator.clientCalls();
    const items = this.translator.handOff();
    if (!items) return;
    this.onHandOff?.(calls);
    this.out(items);
  }

  private take(event: RunEvent): void {
    if (this.finished || this.chatId === null) return;
    this.lastSign = Date.now();
    // Partials have no sequence number of their own; everything else may come twice (replay and live)
    if (event.kind !== 'partial') {
      if (this.seen.has(event.seq)) return;
      this.seen.add(event.seq);
    }
    if (event.kind === 'result') {
      const turn = this.core.runtime.lastTurn(this.chatId);
      this.costUsd = turn?.costUsd ?? null;
      this.out(this.translator.push(event, { usage: turn?.tokens ?? null }));
      return;
    }
    this.out(this.translator.push(event));
    // Before the CLI can ask for them: it writes a block's message first, and this runs as it arrives
    if (this.session && event.kind === 'message') this.session.claim(this.translator.clientCalls());
  }

  private ended(result: RunResult | null): void {
    if (this.finished) return;
    this.fail(
      result?.cause === 'stopped'
        ? { kind: 'server', message: 'The chat was stopped before it answered.' }
        : result?.cause === 'rate-limit'
          ? { kind: 'usage-limit', resetsAt: null, ...(result.result ? { message: result.result } : {}) }
          : { kind: 'server', message: `The chat's process ended before it answered${result?.result ? `: ${result.result}` : '.'}` },
    );
  }

  fail(failure: OpenAiFailure): void {
    this.out(this.translator.failWith(failure));
  }

  private out(items: ChatCompletionStreamItem[]): void {
    if (items.length > 0) {
      if (this.writer) this.writer(items);
      else this.pending.push(...items);
    }
    if (this.finished) this.release();
  }

  private release(): void {
    this.unsubscribe();
    if (this.chatId !== null && this.open.get(this.chatId) === this) this.open.delete(this.chatId);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.settle();
  }

  /** Hands what was said so far, and everything after, to `write`. */
  stream(write: (items: ChatCompletionStreamItem[]) => void): void {
    this.writer = write;
    const waiting = this.pending.splice(0);
    if (waiting.length > 0) write(waiting);
  }

  /** Lets go of the chat without an answer: the turn never started. */
  detach(): void {
    this.release();
  }
}

/** The chat a request continues, or none: a new one starts. */
type Target = { kind: 'new' } | { kind: 'existing'; chatId: string };

// ---------- the routes ----------

export const openAiRoutes: FastifyPluginAsync<OpenAiRouteOptions> = async (app, { core, conversationTtlMs, images, clientTools }) => {
  const locks = new KeyedLocks();
  const ttl = conversationTtlMs ?? OPENAI_CONVERSATION_TTL_MS;
  const registry = clientTools ?? new ClientToolRegistry();
  const openTurns = new Map<string, TurnRun>();
  // The end of each API message, for the turn reading that chat: where a turn hands its calls over
  const onStopReason = (chatId: string, reason: string): void => openTurns.get(chatId)?.stopReason(reason);
  core.runtime.on('chat-stop-reason', onStopReason);
  app.addHook('onClose', async () => {
    core.runtime.off('chat-stop-reason', onStopReason);
  });

  // Every answer under /v1 is OpenAI's error shape, whoever wrote it: the guard and the spend gate
  // answer before any handler runs, in the rest of the API's `{ error: string }`
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode < 400 || typeof payload !== 'string') return payload;
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return payload;
    }
    const error = (body as { error?: unknown } | null)?.error;
    if (typeof error !== 'string') return payload;
    if (isSpendCap(body)) {
      const shaped = openAiError(failureOfSpendCap(body));
      void reply.status(shaped.status);
      if (shaped.retryAfterSeconds !== undefined) void reply.header('retry-after', String(shaped.retryAfterSeconds));
      return JSON.stringify(shaped.body);
    }
    // The status stays what the writer chose (a 421 for a host, a 405 in read-only); only the body changes
    const shaped = openAiError(failureOfThrown(Object.assign(new Error(error), { statusCode: reply.statusCode, expose: true })));
    void reply.header('content-type', 'application/json; charset=utf-8');
    return JSON.stringify(shaped.body);
  });

  app.setErrorHandler((err, req, reply) => {
    const failure = failureOf(err);
    const shaped = openAiError(failure);
    if (shaped.status >= 500) req.log.error({ err, url: req.url }, 'request failed');
    return answer(reply, shaped);
  });

  app.setNotFoundHandler((req, reply) =>
    answer(reply, openAiError({ kind: 'not-found', message: `No route ${req.method} ${req.url.split('?')[0] ?? ''} in Claudio's OpenAI-compatible API.` })),
  );

  const sweep = setInterval(() => {
    void sweepOpenAiChats({ conversations: core.openaiConversations, runtime: core.runtime, remove: (id) => core.chats.remove(id) }, Date.now(), ttl).catch((err: unknown) =>
      app.log.warn({ err, scope: 'openai' }, 'the conversation sweep failed'),
    );
  }, SWEEP_EVERY_MS);
  sweep.unref();
  // A chat's stub goes with the chat, however it is removed (the sweep, `DELETE /chats/:id`, the
  // history trim): its URL stops answering and nothing it held outlives it
  const unobserve = core.events.observe((event) => {
    if (event.type === 'run.removed') registry.drop(event.runId);
  });
  app.addHook('onClose', async () => {
    clearInterval(sweep);
    unobserve();
  });

  app.get('/models', async () => ({ object: 'list' as const, data: (await loadedCatalogue(core)).map(modelObject) }));

  app.get<{ Params: { id: string } }>('/models/:id', async (req) => {
    const entry = await findModel(core, req.params.id);
    if (!entry) throw fail({ kind: 'model-not-found', model: req.params.id });
    return modelObject(entry);
  });

  app.post('/chat/completions', { preHandler: spendGate(core), bodyLimit: COMPLETION_BODY_LIMIT }, async (req, reply) => {
    const parsed = parseChatCompletionRequest(req.body);
    if (!parsed.ok) return answer(reply, parsed.error);
    const request = parsed.value;
    const ignoredHere: string[] = [];
    const refusal = refusalOf(request, req.body, ignoredHere);
    if (refusal) throw fail(refusal);
    // The results the request ends with must answer the calls of its last assistant message, all of them
    const trailing = trailingResults(request.messages);
    const mismatch = trailing.calls.length > 0 || trailing.results.length > 0 ? resultsProblem(trailing) : null;
    if (mismatch) throw fail(mismatch);
    const model = await findModel(core, request.model);
    if (!model) throw fail({ kind: 'model-not-found', model: request.model });
    const named = header(req, CHAT_ID_HEADER);
    const cwdHeader = header(req, CWD_HEADER);
    const cwd = cwdHeader === undefined ? undefined : cwdOf(core, cwdHeader);
    const toolPreset = header(req, TOOL_PRESET_HEADER);
    if (toolPreset !== undefined && !core.toolPresets.get(toolPreset)) throw fail({ kind: 'invalid-request', message: `${TOOL_PRESET_HEADER}: no tool preset '${toolPreset}' (see GET /api/config/tool-presets).`, param: null });
    const turn = translateOpenAiRequest(request);
    const ignored = [...turn.ignored, ...ignoredHere];
    const wantsTools = request.tools.length > 0 && request.toolChoice.kind !== 'none';

    // The client may go while it waits: a turn nobody reads is interrupted, one not started never starts
    let gone = false;
    let run: TurnRun | null = null;
    let leave: () => void = () => {};
    const left = new Promise<void>((r) => {
      leave = r;
    });
    reply.raw.on('close', () => {
      if (reply.raw.writableFinished) return;
      gone = true;
      leave();
      if (run?.chatId && !run.finished) void core.chats.interrupt(run.chatId).catch(() => undefined);
    });
    /** Waits for the turn; once the client went, only as long as an interrupt takes to land. */
    const settled = async (current: TurnRun): Promise<void> => {
      await Promise.race([current.done, left]);
      if (!current.finished) await Promise.race([current.done, new Promise((r) => setTimeout(r, INTERRUPT_GRACE_MS).unref())]);
    };

    const releases: Array<() => void> = [];
    try {
      const key = named !== undefined ? `chat:${named}` : turn.historyKey !== null ? `key:${turn.historyKey}` : null;
      if (key) releases.push(await locks.acquire(key));
      if (gone) return reply;
      const target = await targetOf(named, turn);
      if (target.kind === 'existing' && key !== `chat:${target.chatId}`) releases.push(await locks.acquire(`chat:${target.chatId}`));
      if (gone) return reply;

      const existing = target.kind === 'existing' ? target.chatId : null;
      const session = existing !== null ? registry.ofChat(existing) : undefined;
      const late = session ? trailing.results.filter((r) => session.expired(r.toolCallId)).map((r) => `\`${r.toolCallId}\``) : [];
      if (late.length) {
        throw fail({ kind: 'invalid-request', param: 'messages', message: `The tool calls ${late.join(', ')} waited longer than the tool-call timeout (openaiToolCallTimeoutMinutes) for their results, and the chat was stopped. Start the conversation again.` });
      }
      const live = existing !== null ? (core.runtime.get(existing) ?? null) : null;
      // The CLI process that asked for the calls, still in that turn and still holding at least one
      // of them, is the one holding them. Another process (a restart, a person's resume) never asked,
      // and one whose turn ended (a person interrupted it, so the CLI withdrew every request) will
      // never call the stub: results sent to either would wait for nothing
      const holding = session !== undefined && live !== null && live.status !== 'idle' && session.holds(live.pid);
      // The client dropped the calls and sent a new message: the turn holding them is interrupted
      const abandoning = holding && abandonsClientCalls(trailing);
      const held = holding && !abandoning;
      // Results that no live process holds: the chat is resumed with them as a message
      const cold = existing !== null && !held && trailing.results.length > 0;
      // Every refusal comes before anything shared is touched. A held request carries no images, so
      // this is its only check of the results against what the CLI waits on
      const heldRefusal = held && session ? session.heldProblem(trailing) : null;
      if (heldRefusal) throw fail(heldRefusal);

      const prompt = held ? { prompt: '', images: [] } : target.kind === 'new' ? turn.cold : cold ? renderOpenAiResultsCold(request.messages) : turn.delta;
      const uploaded = await uploadOpenAiImages(prompt.images, {
        fetch: (url, maxBytes) => fetchOpenAiImage(url, maxBytes, images),
        save: (name, bytes) => core.uploads.save(name, bytes),
      });
      if (!uploaded.ok) return answer(reply, uploaded.error);

      // A chat keeps its session once it had client tools: its process may serve the stub still
      const tools = session ?? (wantsTools ? registry.create(request.tools) : null);
      const choice: OpenAiToolChoice = wantsTools ? request.toolChoice : { kind: 'none' };
      const parallel = request.parallelToolCalls !== false;
      const before = tools ? { choice: tools.choice, parallel: tools.parallel } : null;
      /** This request's rules on the session: applied as the last step before the turn runs, so a refused request changes nothing */
      const apply = (): void => {
        if (!tools) return;
        tools.choice = choice;
        tools.parallel = parallel;
        // A turn that is not the held one starts afresh: calls a process no longer waits on (results
        // going in cold, or a turn that ended without them) must not leave a wait that would stop it
        if (!held) tools.forgetCalls();
      };
      // A live stub lists what it listed when the process started; the results go there all the same
      if (held && wantsTools && tools && !sameClientTools(tools.tools, request.tools)) ignored.push('tools');
      const instruction = !held && wantsTools ? toolChoiceInstruction(request.toolChoice) : null;
      const text = instruction ? `${prompt.prompt}\n\n${instruction}` : prompt.prompt;
      // What the stub will list this turn: the live list when results go to it, else this request's
      const listed = tools && (held || !wantsTools) ? tools.tools : request.tools;

      const translator = new ChatCompletionTranslator({
        id: `chatcmpl-${randomUUID().replaceAll('-', '')}`,
        model: request.model,
        created: Math.floor(Date.now() / 1000),
        includeUsage: turn.includeUsage,
        structured: turn.jsonSchema !== undefined,
        ...(tools ? { clientTools: { prefix: CLIENT_TOOL_PREFIX, names: allowedToolNames(choice, listed), single: !parallel } } : {}),
      });
      const current = new TurnRun(core, translator, openTurns, tools, tools ? (calls) => handOff(tools, calls) : null);
      run = current;
      const startOpts = { provider: model.provider, cwd, toolPreset, ignored, tools, wantsTools, requestTools: request.tools, apply };
      try {
        if (abandoning && tools && existing !== null) {
          // What would refuse the new message is checked while the calls are still held, so a refused
          // request leaves them and the turn holding them as they were
          existingTurnPlan(existing, turn, startOpts, true);
          await abandon(existing, tools);
          try {
            await startTurn(current, target, turn, text, uploaded.value, startOpts);
          } catch (err) {
            throw afterDropping(err);
          }
        } else if (held && tools && existing !== null) continueHeld(current, existing, tools, trailing, apply);
        else await startTurn(current, target, turn, text, uploaded.value, startOpts);
      } catch (err) {
        current.detach();
        if (tools && !session) {
          // A chat that started before the failure must not keep a host the registry no longer knows
          if (tools.chatId !== null) {
            try {
              core.runtime.setPermissionHost(tools.chatId, null);
            } catch {
              // no such chat: it never started
            }
          }
          registry.discard(tools);
        }
        // A turn that did not start leaves the session's rules as the request before it set them
        if (tools && session && before) {
          tools.choice = before.choice;
          tools.parallel = before.parallel;
        }
        throw err;
      }
      const chatId = current.chatId;
      if (chatId === null) throw fail({ kind: 'server', message: 'The chat started without an id.' });
      if (gone && !current.finished) void core.chats.interrupt(chatId).catch(() => undefined);

      const remember = (): void => {
        const end = current.translator.end();
        if (end?.kind !== 'completion') return;
        core.openaiConversations.remember(openAiKeyAfterAnswer(turn.keySeed, request.messages, { text: end.text, toolCalls: end.toolCalls }), chatId, turn.user);
      };
      const out: Record<string, string> = {
        [CHAT_ID_HEADER]: chatId,
        ...(ignored.length ? { [IGNORED_HEADER]: [...new Set(ignored)].join(', ') } : {}),
        ...(cold ? { [RESUME_HEADER]: 'cold' } : {}),
      };

      if (turn.stream) {
        const stream: SseStream = openStream(req, reply, { headers: out, trailers: [COST_HEADER] });
        // The stream drops what comes after the client left or after its end (`SseStream.closed`)
        current.stream((items) => {
          for (const item of items) {
            if (item === STREAM_DONE) stream.sendData(STREAM_DONE);
            else stream.send(item);
          }
        });
        await settled(current);
        remember();
        stream.end(current.costUsd !== null ? { [COST_HEADER]: String(current.costUsd) } : {});
        return reply;
      }

      await settled(current);
      remember();
      void reply.headers(out);
      const end = current.translator.end();
      if (!end) throw fail({ kind: 'server', message: 'The turn ended without an answer.' });
      if (end.kind === 'error') return answer(reply, { status: end.status, body: end.body, ...(end.retryAfterSeconds !== undefined ? { retryAfterSeconds: end.retryAfterSeconds } : {}) });
      if (current.costUsd !== null) void reply.header(COST_HEADER, String(current.costUsd));
      return reply.send(end.completion);
    } finally {
      for (const release of releases.reverse()) release();
    }
  });

  /**
   * The calls are the client's now. The wait is the setting's, read when it starts; a call still owed
   * at its end is answered to the CLI with an error result, and the chat is stopped (decision 2).
   */
  function handOff(tools: ClientToolSession, calls: OpenAiClientCall[]): void {
    const holder = tools.chatId === null ? null : (core.runtime.get(tools.chatId)?.pid ?? null);
    tools.handOff(
      calls,
      toolCallWaitMs(core),
      () => {
        if (tools.chatId === null) return;
        try {
          core.runtime.stop(tools.chatId);
        } catch {
          // already gone
        }
      },
      holder,
    );
  }

  /**
   * Drops the calls the CLI is holding, for a client that sent a new message instead of their
   * results: the turn is interrupted (the CLI withdraws its requests and ends the turn), and the
   * message then goes to the idle process as usual. Waits only as long as an interrupt takes.
   */
  async function abandon(chatId: string, tools: ClientToolSession): Promise<void> {
    const ended = core.runtime.nextResult(chatId).then(
      () => true,
      () => true,
    );
    await core.chats.interrupt(chatId).catch(() => undefined);
    const settled = await Promise.race([ended, new Promise<false>((r) => setTimeout(() => r(false), INTERRUPT_GRACE_MS).unref())]);
    tools.abandon();
    if (!settled) throw fail({ kind: 'conflict', message: 'The chat is still ending the turn whose tool calls were dropped; try again in a moment.' });
  }

  /**
   * A refusal of the new message that could only be known once the calls were dropped (the chat
   * not idle after the interrupt, its process gone and no run slot free to start another): the
   * answer says the calls are gone, so the client does not send their results again.
   */
  function afterDropping(err: unknown): V1Failure {
    const failure = failureOf(err);
    const note = 'The held tool calls were dropped, but the new message was not sent';
    if ('message' in failure && typeof failure.message === 'string') return fail({ ...failure, message: `${note}: ${failure.message}` });
    return fail(failure);
  }

  /**
   * The client's results for the calls the CLI is holding: each held request is allowed with its
   * original input, the stub hands the CLI the text, and the same CLI turn goes on, read from here.
   * The results were checked against the held calls before anything was changed (`heldProblem`).
   */
  function continueHeld(current: TurnRun, chatId: string, tools: ClientToolSession, trailing: ReturnType<typeof trailingResults>, apply: () => void): void {
    apply();
    current.attach(chatId);
    tools.deliver(trailing.results);
    current.replay();
  }

  /** A chat the OpenAI surface started, that still exists. */
  async function isApiChat(id: string): Promise<boolean> {
    return core.runtime.get(id)?.origin === 'api' && (await core.chats.get(id)) !== null;
  }

  /**
   * The chat the request continues: the one it names, or the one its history leads to. A row whose
   * chat was deleted since (or pruned) is a miss, and the conversation starts again from the history.
   */
  async function targetOf(named: string | undefined, turn: OpenAiChatTurn): Promise<Target> {
    if (named !== undefined) {
      // Only a chat this surface started: anyone holding a token would otherwise write into a
      // person's chat, an orchestration's or the assistant's, and run it with this surface's rules.
      // The same 404 as an unknown id, so the answer does not say which chats exist
      if (!(await isApiChat(named))) throw fail({ kind: 'not-found', message: `No chat ${named} (from ${CHAT_ID_HEADER}).` });
      return { kind: 'existing', chatId: named };
    }
    if (turn.historyKey === null) return { kind: 'new' };
    const row = core.openaiConversations.find(turn.historyKey);
    if (!row) return { kind: 'new' };
    if (await isApiChat(row.chatId)) return { kind: 'existing', chatId: row.chatId };
    if (!(await core.chats.get(row.chatId))) core.openaiConversations.forgetChat(row.chatId);
    return { kind: 'new' };
  }

  /**
   * How a turn goes to an existing chat, and its refusals, which change nothing: no such chat, a turn
   * already running (unless it is the one being ended to drop its calls, `ending`), or a process to
   * start with the stub while the API's address is unknown.
   */
  function existingTurnPlan(
    id: string,
    turn: OpenAiChatTurn,
    opts: { tools: ClientToolSession | null; wantsTools: boolean; requestTools: OpenAiChatTurn['tools'] },
    ending: boolean,
  ): { runtime: NonNullable<ReturnType<Core['runtime']['get']>>; restart: boolean } {
    const { tools } = opts;
    const runtime = core.runtime.get(id);
    if (!runtime) throw fail({ kind: 'not-found', message: `No chat ${id}.` });
    if (runtime.pid !== null && runtime.status !== 'idle' && !ending) {
      // A live process keeps how it was started: only a turn on an idle one is ours to send
      throw fail({ kind: 'conflict', message: 'The chat is working on another turn; try again when it ends.' });
    }
    // `--json-schema` and `--mcp-config` are fixed when the process starts: a turn asking for another
    // schema (or for none after one), or for client tools the live process does not serve, ends the
    // idle process and resumes the chat with its own. The same ones keep it
    const toolsChanged = opts.wantsTools && tools !== null && (tools.servedPid !== runtime.pid || !sameClientTools(tools.tools, opts.requestTools));
    const restart = runtime.pid !== null && (!sameJsonSchema(core.runtime.jsonSchemaOf(id), turn.jsonSchema) || toolsChanged);
    if (tools && (restart || runtime.pid === null) && !registry.servers(core, tools)) {
      throw fail({ kind: 'unavailable', message: "Client tools need the API's own address, which is not known yet." });
    }
    return { runtime, restart };
  }

  /**
   * Sends the turn: a new chat, a message to a live process that is idle, or a resume of one nobody
   * holds. The run is attached before anything is sent, so no event of the turn is missed. A chat
   * with client tools runs with `permissionPrompts: 'host'` and its session as the host, which holds
   * the client's calls and refuses everything else at once, as `'none'` would (spike change 1).
   */
  async function startTurn(
    current: TurnRun,
    target: Target,
    turn: OpenAiChatTurn,
    prompt: string,
    attachments: string[],
    opts: { provider: string; cwd: string | undefined; toolPreset: string | undefined; ignored: string[]; tools: ClientToolSession | null; wantsTools: boolean; requestTools: OpenAiChatTurn['tools']; apply: () => void },
  ): Promise<void> {
    const permissionMode = permissionModeOf(core);
    const { tools } = opts;
    const prompts = tools ? 'host' : 'none';
    const servers = (): Record<string, Record<string, unknown>> => {
      const listed = tools ? registry.servers(core, tools) : null;
      if (!listed) throw fail({ kind: 'unavailable', message: "Client tools need the API's own address, which is not known yet." });
      return listed;
    };
    /** The chat answers to its session from now on; called before its process can ask anything */
    const host = (chatId: string): void => {
      if (!tools) return;
      registry.bind(tools, chatId);
      core.runtime.setPermissionHost(chatId, tools);
    };
    const served = (chatId: string): void => {
      if (tools) tools.servedPid = core.runtime.get(chatId)?.pid ?? null;
    };
    if (target.kind === 'new') {
      const extra = tools ? servers() : undefined;
      opts.apply();
      await core.chats.create(
        {
          prompt,
          ...(turn.title ? { name: turn.title } : {}),
          ...(attachments.length ? { attachments } : {}),
          provider: opts.provider,
          model: turn.model,
          ...(turn.effort ? { effort: turn.effort } : {}),
          ...(turn.appendSystemPrompt !== undefined ? { appendSystemPrompt: turn.appendSystemPrompt } : {}),
          ...(turn.jsonSchema ? { jsonSchema: turn.jsonSchema } : {}),
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.toolPreset ? { toolPreset: opts.toolPreset } : {}),
          permissionMode,
          permissionPrompts: prompts,
        },
        (started) => {
          host(started.id);
          current.attach(started.id);
        },
        undefined,
        undefined,
        'api',
        extra,
      );
      if (current.chatId) served(current.chatId);
      return;
    }
    const id = target.chatId;
    const { runtime, restart } = existingTurnPlan(id, turn, opts, false);
    // Where a chat already is, the header cannot move it: said rather than dropped in silence
    if (opts.cwd !== undefined && !sameDir(opts.cwd, runtime.cwd)) opts.ignored.push(CWD_HEADER);
    if (restart) await core.runtime.endBetweenTurns(id);
    if (tools && opts.wantsTools && (restart || runtime.pid === null)) tools.tools = opts.requestTools;
    opts.apply();
    host(id);
    if (runtime.pid !== null && !restart) {
      // The same rules as a start or a resume, on the live process: nobody answers a prompt here
      if (runtime.permissionPrompts !== prompts) core.runtime.setPermissionPrompts(id, prompts);
      if (runtime.permissionMode !== permissionMode) await core.runtime.updateSettings(id, { permissionMode });
      if (turn.effort) opts.ignored.push('reasoning_effort');
      if (turn.model !== runtime.model) await core.runtime.updateSettings(id, { model: turn.model });
      current.attach(id);
      await core.chats.send(id, { text: prompt, attachments });
      current.replay();
      return;
    }
    current.attach(id);
    await core.chats.resume(id, {
      prompt,
      ...(attachments.length ? { attachments } : {}),
      model: turn.model,
      ...(turn.effort ? { effort: turn.effort } : {}),
      ...(turn.appendSystemPrompt !== undefined ? { appendSystemPrompt: turn.appendSystemPrompt } : {}),
      ...(opts.toolPreset ? { toolPreset: opts.toolPreset } : {}),
      permissionMode,
      permissionPrompts: prompts,
    }, { jsonSchema: turn.jsonSchema ?? null, extraMcpServers: tools ? servers() : null });
    served(id);
    current.replay();
  }
};
