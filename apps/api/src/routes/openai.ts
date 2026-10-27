import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Core, FetchImageOptions, OpenAiFailure, RunResult } from '@claudio/core';
import {
  abandonsClientCalls,
  allowedToolNames,
  CHAT_COMPLETION_RESULTS,
  ChatCompletionTranslator,
  CLIENT_TOOL_PREFIX,
  clientToolsProblem,
  effectiveSystemPrompt,
  hasSystemMessages,
  listedCallIds,
  renderOpenAiResultsCold,
  RESPONSES_RESULTS,
  resultsProblem,
  sameClientTools,
  toolChoiceInstruction,
  trailingResults,
  type ClientToolSession,
  failureOfSpendCap,
  failureOfThrown,
  fetchOpenAiImage,
  isOpenAiTurnError,
  listedInputItems,
  OPENAI_CONVERSATION_TTL_MS,
  openAiError,
  openAiHttpErrorOf,
  openAiImageDigest,
  openAiKeyAfterAnswer,
  parseChatCompletionRequest,
  RunSlotRefusal,
  sameJsonSchema,
  STREAM_DONE,
  storedInputItems,
  sweepOpenAiChats,
  systemPromptParts,
  translateOpenAiRequest,
  UPLOAD_LIMITS,
  uploadOpenAiImages,
  type ChatCompletionRequest,
  type ChatCompletionStreamItem,
  type ConversationBase,
  type OpenAiChatTurn,
  type OpenAiClientCall,
  type OpenAiErrorResponse,
  type OpenAiToolCall,
  type OpenAiToolChoice,
  type OpenAiTurnError,
  type OpenAiTurnTranslator,
  openAiKeyAfterPrevious,
  parseResponsesRequest,
  ResponsesTranslator,
  responsesTurnOf,
  withPreviousOutput,
  type ResponseDeleted,
  type ResponseStreamEvent,
  type ResultsVocabulary,
  type SystemPromptParts,
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
/**
 * How long a turn the client walked away from (or whose tool calls it dropped) may take to wind down
 * before its locks go. `CLAUDIO_OPENAI_INTERRUPT_GRACE_MS`, for tests that cannot wait 30 s.
 */
export const interruptGraceMs = (): number => {
  const set = Number(process.env.CLAUDIO_OPENAI_INTERRUPT_GRACE_MS);
  return Number.isFinite(set) && set > 0 ? set : 30_000;
};
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
 * How each API names the fields a refusal points at and `x-claudio-ignored` lists: the two shapes put
 * the format, the tool names, the history and the effort in different places, and a client must be
 * told in the words of the shape it sent.
 */
interface ParamNames {
  format: string;
  toolName: (index: number) => string;
  /** Where the history is (`messages`, `input`) and how its results and calls are named */
  results: ResultsVocabulary;
  /** The effort parameter, named in `x-claudio-ignored` when a live process cannot take it */
  effort: string;
  /** Where the images are, named by a refusal of one (an upload that failed): `messages`, `input` */
  images: string;
  /** Responses' `instructions`, which Chat Completions does not have */
  instructions: string | null;
}
const CHAT_COMPLETION_PARAMS: ParamNames = { format: 'response_format', toolName: (i) => `tools[${String(i)}].function.name`, results: CHAT_COMPLETION_RESULTS, effort: 'reasoning_effort', images: 'messages', instructions: null };
const RESPONSES_PARAMS: ParamNames = { format: 'text.format', toolName: (i) => `tools[${String(i)}].name`, results: RESPONSES_RESULTS, effort: 'reasoning.effort', images: 'input', instructions: 'instructions' };

/**
 * What this surface refuses although the parser reads it: the legacy `functions`, tools it cannot
 * serve under the stub's prefix, and client tools together with `response_format` (both would be the
 * answer; not supported yet, the owner's call). `tool_choice: none` makes the tools context the model
 * is told not to use: they are left out and named in `x-claudio-ignored`.
 */
function refusalOf(request: ChatCompletionRequest, body: unknown, ignored: string[], names: ParamNames): OpenAiFailure | null {
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
    return { kind: 'unsupported-parameter', param: names.format, message: `Client \`tools\` together with \`${names.format}\` are not supported yet: send one or the other.` };
  }
  return clientToolsProblem(request.tools, names.toolName);
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
 * Feeds one turn's events to the translator (Chat Completions chunks or Responses events) and hands
 * what it says to whoever writes the answer.
 * Subscribed before the turn is sent, so nothing of it is missed; what arrives before the answer is
 * open waits in `pending`.
 */
export class TurnRun<Item> {
  chatId: string | null = null;
  /** What this turn alone cost, from the process's cumulative figure (`ChatManager.lastTurn`) */
  costUsd: number | null = null;
  private pending: Item[] = [];
  private writer: ((item: Item) => void) | null = null;
  private cut: () => void = () => {};
  private unsubscribe: () => void = () => {};
  private readonly seen = new Set<number>();
  private since = 0;
  private lastSign = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private settle: () => void = () => {};
  readonly done: Promise<void>;

  constructor(
    private readonly core: Core,
    readonly translator: OpenAiTurnTranslator<Item>,
    /** The turns open now, by chat: where the end of each API message is told (`chat-stop-reason`) */
    private readonly open: Map<string, { stopReason(reason: string): void }>,
    /**
     * Where a throw from the writer goes. The writer runs inside the chat's event emitter, which must
     * never see it, and the turn must still release its locks and settle (a stuck request would hold
     * its conversation's queue for ever)
     */
    private readonly report: (err: unknown) => void,
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
    if (this.session && event.kind === 'message') {
      const fresh = this.translator.takeNewClientCalls();
      if (fresh.length) this.session.claim(fresh);
    }
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

  /** A turn that finished releases whatever its delivery throws: its locks and its conversation's queue wait on it. */
  private out(items: Item[]): void {
    try {
      if (items.length > 0) {
        if (this.writer) this.deliver(this.writer, items);
        else this.pending.push(...items);
      }
    } finally {
      if (this.finished) this.release();
    }
  }

  /**
   * Each item on its own: one that cannot be written (and is reported) must not take the ones after
   * it along, the event that ends the turn above all. An item of the turn's end (`endsTurn`) is tried
   * once more. Then, for a turn that completed, it is left out: the stream never ends with a failure
   * the turn did not have, since the stored response and the conversation key already say it
   * completed and a client would run it again. For a turn that failed, the connection is cut: a
   * stream that just ends reads as a complete answer to the SDKs, a broken one as an error.
   */
  private deliver(write: (item: Item) => void, items: Item[]): void {
    const one = (item: Item): boolean => {
      try {
        write(item);
        return true;
      } catch (err) {
        this.report(err);
        return false;
      }
    };
    for (const item of items) {
      if (one(item) || !endsTurn(item) || one(item)) continue;
      if (this.translator.answered() === null) this.cut();
    }
  }

  private release(): void {
    this.unsubscribe();
    if (this.chatId !== null && this.open.get(this.chatId) === this) this.open.delete(this.chatId);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.settle();
  }

  /**
   * Hands `opening`, what was said so far, and everything after, to `write`, one item at a time.
   * `cut` breaks the connection, for a failed turn whose end could not be written.
   */
  stream(write: (item: Item) => void, opening: Item[] = [], cut: () => void = () => {}): void {
    this.writer = write;
    this.cut = cut;
    const waiting = [...opening, ...this.pending.splice(0)];
    if (waiting.length > 0) this.deliver(write, waiting);
  }

  /** Lets go of the chat without an answer: the turn never started. */
  detach(): void {
    this.release();
  }
}

/**
 * Whether a stream item ends its turn: Chat Completions' finish chunk, error body and `[DONE]`, or
 * Responses' terminal event. Only these are worth a second write; the rest of a batch is not.
 */
function endsTurn(item: unknown): boolean {
  if (item === STREAM_DONE) return true;
  if (typeof item !== 'object' || item === null) return false;
  if ('error' in item) return true;
  if ('choices' in item && Array.isArray(item.choices)) {
    return item.choices.some((c: unknown) => typeof c === 'object' && c !== null && 'finish_reason' in c && c.finish_reason !== null);
  }
  return 'type' in item && (item.type === 'response.completed' || item.type === 'response.incomplete' || item.type === 'response.failed');
}

/** Two system prompts as a process runs them: none and an empty one are the same. */
const sameSystemPrompt = (a: string | undefined, b: string | undefined): boolean => (a ?? '') === (b ?? '');

/** The chat a request continues, or none: a new one starts. */
type Target = { kind: 'new' } | { kind: 'existing'; chatId: string };

/** The chat a stored response (`previous_response_id`) leads to, and what to answer when it may not be continued. */
interface Previous {
  chatId: string;
  refusal: OpenAiFailure;
  /** The conversation part of the system prompt its chain reached; null for a row from before it was kept */
  conversation: string | null;
}

/**
 * What a route tells `runTurn`: the request in Chat Completions' terms, and how its answer is made
 * and written. Everything between (queue, target, tools, images, start, wait) is the same for both.
 */
interface TurnPlan<Item, T extends OpenAiTurnTranslator<Item>> {
  request: ChatCompletionRequest;
  turn: OpenAiChatTurn;
  /** Names for `x-claudio-ignored` the route found beside the translator's */
  ignored: string[];
  previous: Previous | null;
  /** Responses' `instructions`: the system prompt's part that holds for this request only */
  instructions: string | null;
  /** The API's names for the refusals and `x-claudio-ignored` */
  names: ParamNames;
  make(options: { structured: boolean; clientTools?: { prefix: string; names: ReadonlySet<string>; single: boolean } }): T;
  /** What a stream opens with before anything of the turn (Responses' `response.created`) */
  opening(translator: T): Item[];
  write(stream: SseStream, item: Item): void;
  /** The conversation key the client's next request carries, after this answer */
  keyAfter(answered: { text: string; toolCalls: OpenAiToolCall[] }): string;
  /**
   * After a turn that answered (completed or cut short), with its chat, key, the system prompt it
   * asked for and the uploads this turn saved its images to
   */
  completed?(translator: T, chatId: string, key: string, system: SystemPromptParts | null, images: ReadonlyMap<string, string>): void;
  whole(translator: T): WholeAnswer;
}

type WholeAnswer = { kind: 'error'; error: OpenAiErrorResponse } | { kind: 'ok'; body: unknown };

/**
 * A turn's end as a whole HTTP answer, for both APIs: the error it failed with, or the body the
 * route makes of its success. A turn that settled without an end (the client went) is a 500.
 */
function wholeAnswer<E extends { kind: string }>(end: E | null, body: (end: Exclude<E, OpenAiTurnError>) => unknown): WholeAnswer {
  if (!end) return { kind: 'error', error: openAiError({ kind: 'server', message: 'The turn ended without an answer.' }) };
  if (isOpenAiTurnError(end)) return { kind: 'error', error: openAiHttpErrorOf(end) };
  // The guard cannot narrow a type parameter: what is not a TurnError is the success variant
  return { kind: 'ok', body: body(end as Exclude<E, OpenAiTurnError>) };
}

// ---------- the routes ----------

export const openAiRoutes: FastifyPluginAsync<OpenAiRouteOptions> = async (app, { core, conversationTtlMs, images, clientTools }) => {
  const locks = new KeyedLocks();
  const ttl = conversationTtlMs ?? OPENAI_CONVERSATION_TTL_MS;
  const registry = clientTools ?? new ClientToolRegistry();
  const openTurns = new Map<string, { stopReason(reason: string): void }>();
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
    void sweepOpenAiChats({ conversations: core.openaiConversations, responses: core.openaiResponses, runtime: core.runtime, remove: (id) => core.chats.remove(id) }, Date.now(), ttl).catch((err: unknown) =>
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
    const ignored: string[] = [];
    const refusal = refusalOf(request, req.body, ignored, CHAT_COMPLETION_PARAMS);
    if (refusal) throw fail(refusal);
    const turn = translateOpenAiRequest(request);
    const id = `chatcmpl-${randomUUID().replaceAll('-', '')}`;
    const created = Math.floor(Date.now() / 1000);
    return runTurn<ChatCompletionStreamItem, ChatCompletionTranslator>(req, reply, {
      request,
      turn,
      ignored,
      previous: null,
      instructions: null,
      names: CHAT_COMPLETION_PARAMS,
      make: (options) => new ChatCompletionTranslator({ id, model: request.model, created, includeUsage: turn.includeUsage, ...options }),
      opening: () => [],
      write: (stream, item) => (item === STREAM_DONE ? stream.sendData(STREAM_DONE) : stream.send(item)),
      keyAfter: (answered) => openAiKeyAfterAnswer(turn.keySeed, request.messages, answered),
      whole: (translator) => wholeAnswer(translator.end(), (end) => end.completion),
    });
  });

  // ---------- the Responses API ----------

  const responseNotFound = (id: string, param: string | null = null): OpenAiFailure => ({ kind: 'not-found', message: `No response found with id '${id}'.`, param });

  app.post('/responses', { preHandler: spendGate(core), bodyLimit: COMPLETION_BODY_LIMIT }, async (req, reply) => {
    const parsed = parseResponsesRequest(req.body);
    if (!parsed.ok) return answer(reply, parsed.error);
    const fresh = parsed.value;
    const ignored: string[] = [];
    const refusal = refusalOf(fresh.chat, req.body, ignored, RESPONSES_PARAMS);
    if (refusal) throw fail(refusal);
    let request = fresh;
    let previous: Previous | null = null;
    let previousKey: string | null = null;
    if (fresh.previousResponseId !== null) {
      // An unknown id, one deleted, one sent with `store: false` (never written) and one whose chat
      // is gone or not this surface's all read the same: there is no such response to continue
      const notFound = responseNotFound(fresh.previousResponseId, 'previous_response_id');
      const stored = core.openaiResponses.find(fresh.previousResponseId);
      if (!stored) throw fail(notFound);
      const named = header(req, CHAT_ID_HEADER);
      if (named !== undefined && named !== stored.chatId) {
        throw fail({ kind: 'invalid-request', param: 'previous_response_id', message: `The previous response belongs to another chat than the one ${CHAT_ID_HEADER} names.` });
      }
      previous = { chatId: stored.chatId, refusal: notFound, conversation: stored.conversationSystem };
      previousKey = stored.conversationKey;
      // Its output goes before the new items, so their results are checked against its calls
      request = withPreviousOutput(fresh, stored.response.output);
    }
    const turn = responsesTurnOf(request);
    const id = `resp_${randomUUID().replaceAll('-', '')}`;
    const createdAt = Math.floor(Date.now() / 1000);
    return runTurn<ResponseStreamEvent, ResponsesTranslator>(req, reply, {
      request: request.chat,
      turn,
      ignored,
      previous,
      instructions: request.instructions,
      names: RESPONSES_PARAMS,
      make: (options) =>
        new ResponsesTranslator({
          id,
          model: request.chat.model,
          createdAt,
          instructions: request.instructions,
          previousResponseId: request.previousResponseId,
          store: request.store,
          metadata: request.metadata,
          echo: request.echo,
          ...options,
        }),
      opening: (translator) => translator.open(),
      // The reference's stream names each event on an `event:` line as well as in its `type`
      write: (stream, event) => stream.send(event, { event: event.type }),
      keyAfter: (answered) =>
        previousKey !== null ? openAiKeyAfterPrevious(previousKey, fresh.chat.messages, answered) : openAiKeyAfterAnswer(turn.keySeed, request.chat.messages, answered),
      completed: (translator, chatId, key, system, images) => {
        if (!request.store) return;
        const end = translator.end();
        if (end?.kind !== 'response') return;
        // Each digest is looked up once per turn, however often the input carries the image
        const known = new Map<string, string | null>(images);
        const inputItems = storedInputItems(request.inputItems, (digest) => {
          if (!known.has(digest)) known.set(digest, earlierUpload(chatId, digest));
          return known.get(digest) ?? null;
        });
        // The chain's part as the client asked for it, taken or not by a held turn: the next turn of the chain applies it
        core.openaiResponses.save({ id, chatId, conversationKey: key, response: end.response, conversationSystem: system?.conversation ?? null, inputItems });
      },
      whole: (translator) => wholeAnswer(translator.end(), (end) => end.response),
    });
  });

  app.get<{ Params: { id: string } }>('/responses/:id', async (req) => {
    const stored = core.openaiResponses.find(req.params.id);
    if (!stored) throw fail(responseNotFound(req.params.id));
    return stored.response;
  });

  app.delete<{ Params: { id: string } }>('/responses/:id', async (req) => {
    // The stored response goes; its chat stays, and a client resending the history still finds it
    if (!core.openaiResponses.delete(req.params.id)) throw fail(responseNotFound(req.params.id));
    const deleted: ResponseDeleted = { id: req.params.id, object: 'response.deleted', deleted: true };
    return deleted;
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string; order?: string } }>('/responses/:id/input_items', async (req) => {
    const stored = core.openaiResponses.inputItems(req.params.id);
    if (!stored) throw fail(responseNotFound(req.params.id));
    const { after, order = 'desc' } = req.query;
    if (order !== 'asc' && order !== 'desc') throw fail({ kind: 'invalid-request', param: 'order', message: '`order` must be `asc` or `desc`.' });
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail({ kind: 'invalid-request', param: 'limit', message: '`limit` must be a whole number from 1 to 100.' });
    const items = order === 'asc' ? stored : [...stored].reverse();
    let start = 0;
    if (after !== undefined) {
      const at = items.findIndex((item) => item.id === after);
      if (at < 0) throw fail({ kind: 'invalid-request', param: 'after', message: `No input item '${after}' in this response.` });
      start = at + 1;
    }
    // Only the page's images are read back from their uploads
    const data = listedInputItems(items.slice(start, start + limit), readUpload);
    return { object: 'list' as const, data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: start + limit < items.length };
  });

  /** An upload's bytes and type, or null when it is gone. */
  function readUpload(id: string): { bytes: Buffer; mediaType: string } | null {
    try {
      const { attachment, bytes } = core.uploads.read(id);
      return { bytes, mediaType: attachment.mediaType };
    } catch {
      return null;
    }
  }

  /** An upload an earlier stored response of the chat saved the image to, if it is still there (its metadata, not its bytes). */
  function earlierUpload(chatId: string, digest: string): string | null {
    return (
      core.openaiResponses.uploadsOfImage(chatId, digest).find((upload) => {
        try {
          core.uploads.get(upload);
          return true;
        } catch {
          return false;
        }
      }) ?? null
    );
  }

  /**
   * One request's turn, whichever API shape it came in: the conversation's queue, the target chat,
   * the client-tool handoff, the images, the start or continuation, the answer whole or streamed.
   * The two routes differ only in what `plan` says: how the request reads and how the answer is written.
   */
  async function runTurn<Item, T extends OpenAiTurnTranslator<Item>>(req: FastifyRequest, reply: FastifyReply, plan: TurnPlan<Item, T>): Promise<FastifyReply> {
    const { request, turn, names } = plan;
    // The results the request ends with must answer the calls of its last assistant message, all of them
    const trailing = trailingResults(request.messages);
    const mismatch = trailing.calls.length > 0 || trailing.results.length > 0 ? resultsProblem(trailing, names.results) : null;
    if (mismatch) throw fail(mismatch);
    const model = await findModel(core, request.model);
    if (!model) throw fail({ kind: 'model-not-found', model: request.model });
    const named = header(req, CHAT_ID_HEADER);
    const cwdHeader = header(req, CWD_HEADER);
    const cwd = cwdHeader === undefined ? undefined : cwdOf(core, cwdHeader);
    const toolPreset = header(req, TOOL_PRESET_HEADER);
    if (toolPreset !== undefined && !core.toolPresets.get(toolPreset)) throw fail({ kind: 'invalid-request', message: `${TOOL_PRESET_HEADER}: no tool preset '${toolPreset}' (see GET /api/config/tool-presets).`, param: null });
    const ignored = [...turn.ignored, ...plan.ignored];
    const wantsTools = request.tools.length > 0 && request.toolChoice.kind !== 'none';

    // The client may go while it waits: a turn nobody reads is interrupted, one not started never starts
    let gone = false;
    let run: TurnRun<Item> | null = null;
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
    const settled = async (current: TurnRun<Item>): Promise<void> => {
      await Promise.race([current.done, left]);
      if (!current.finished) await Promise.race([current.done, new Promise((r) => setTimeout(r, interruptGraceMs()).unref())]);
    };

    const releases: Array<() => void> = [];
    try {
      const key = named !== undefined ? `chat:${named}` : plan.previous ? `chat:${plan.previous.chatId}` : turn.historyKey !== null ? `key:${turn.historyKey}` : null;
      if (key) releases.push(await locks.acquire(key));
      if (gone) return reply;
      const target = await targetOf(named, turn, plan.previous);
      if (target.kind === 'existing' && key !== `chat:${target.chatId}`) releases.push(await locks.acquire(`chat:${target.chatId}`));
      if (gone) return reply;

      const existing = target.kind === 'existing' ? target.chatId : null;
      const session = existing !== null ? registry.ofChat(existing) : undefined;
      const late = session ? trailing.results.filter((r) => session.expired(r.toolCallId)).map((r) => r.toolCallId) : [];
      if (late.length) throw fail({ kind: 'invalid-request', param: names.results.param, message: names.results.late(listedCallIds(late)) });
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
      const heldRefusal = held && session ? session.heldProblem(trailing, names.results) : null;
      if (heldRefusal) throw fail(heldRefusal);
      const base = conversationBaseOf(named, plan.previous, target);
      // A chat from before the parts were kept, continued without system messages: its conversation
      // part is unknown (its process only has the join), so the process keeps the prompt it has and
      // no row is written from a guess
      const unknownPart = base === null && !hasSystemMessages(request.messages) && existing !== null;
      const systemParts = unknownPart ? null : systemPromptParts(request.messages, plan.instructions, base ?? { kind: 'whole' });
      const system = systemParts ? effectiveSystemPrompt(systemParts) : (core.runtime.systemPromptOf(existing ?? '') ?? '');

      const prompt = held ? { prompt: '', images: [] } : target.kind === 'new' ? turn.cold : cold ? renderOpenAiResultsCold(request.messages) : turn.delta;
      const uploaded = await uploadOpenAiImages(prompt.images, {
        fetch: (url, maxBytes) => fetchOpenAiImage(url, maxBytes, images),
        save: (name, bytes) => core.uploads.save(name, bytes),
      }, UPLOAD_LIMITS.image, names.images);
      if (!uploaded.ok) return answer(reply, uploaded.error);
      // By digest, which the stored input names its data URL images by, so a stored row finds the
      // upload this turn made for each. Only the API that stores responses needs them
      const turnImages = new Map(
        plan.completed
          ? prompt.images.flatMap((image, i): Array<[string, string]> => {
              const upload = uploaded.value[i];
              return upload === undefined || image.kind !== 'data' ? [] : [[openAiImageDigest(image), upload]];
            })
          : [],
      );

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

      const translator = plan.make({
        structured: turn.jsonSchema !== undefined,
        ...(tools ? { clientTools: { prefix: CLIENT_TOOL_PREFIX, names: allowedToolNames(choice, listed), single: !parallel } } : {}),
      });
      const report = (err: unknown): void => req.log.error({ err, scope: 'openai' }, 'writing the answer failed');
      const current = new TurnRun<Item>(core, translator, openTurns, report, tools, tools ? (calls) => handOff(tools, calls) : null);
      run = current;
      const startOpts = { provider: model.provider, cwd, toolPreset, ignored, effortName: names.effort, tools, wantsTools, requestTools: request.tools, apply, system };
      /** Whether the chat's process runs with `system` now; false when it had to keep its own */
      let applied: boolean;
      try {
        if (abandoning && tools && existing !== null) {
          // What would refuse the new message is checked while the calls are still held, so a refused
          // request leaves them and the turn holding them as they were
          existingTurnPlan(existing, turn, startOpts, true);
          await abandon(existing, tools);
          try {
            applied = await startTurn(current, target, turn, text, uploaded.value, startOpts);
          } catch (err) {
            throw afterDropping(err);
          }
        } else if (held && tools && existing !== null) {
          // The held turn goes on in the process that started it, with the system prompt it started with
          applied = sameSystemPrompt(core.runtime.systemPromptOf(existing), system);
          continueHeld(current, existing, tools, trailing, apply);
        } else applied = await startTurn(current, target, turn, text, uploaded.value, startOpts);
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
      if (systemParts) {
        if (!applied) ignored.push(...keptPromptNames(chatId, systemParts, names));
        // Taken or not: a process that had to keep its prompt is restarted with the row's parts by
        // the next turn that can, which a named request without system messages rebuilds from
        rememberSystemPrompt(req, chatId, systemParts);
      } else if (plan.instructions && names.instructions) ignored.push(names.instructions);
      if (gone && !current.finished) void core.chats.interrupt(chatId).catch(() => undefined);

      let remembered = false;
      /**
       * Once per turn, and before the event that ends it is written: a client that reads
       * `response.completed` (or `[DONE]`) and sends its follow-up at once must find the stored
       * response and the conversation key already there.
       *
       * A write that fails (SQLITE_BUSY from another process on the data dir, a full disk) is logged
       * and the answer is still served: the turn ran, cost money and may have changed files, and a
       * failed answer would make the client retry it. What is lost is only the shortcut back to the
       * chat: a resent history without its key starts cold, an unsaved response answers 404 later.
       */
      const remember = (): void => {
        if (remembered || !translator.finished) return;
        remembered = true;
        const answered = translator.answered();
        if (!answered) return;
        const after = plan.keyAfter(answered);
        try {
          core.openaiConversations.remember(after, chatId, turn.user);
        } catch (err) {
          req.log.error({ err, scope: 'openai', chatId }, 'storing the conversation key failed; the answer is served without it');
        }
        try {
          plan.completed?.(translator, chatId, after, systemParts, turnImages);
        } catch (err) {
          req.log.error({ err, scope: 'openai', chatId }, 'storing the response failed; the answer is served without it');
        }
      };
      const out: Record<string, string> = {
        [CHAT_ID_HEADER]: chatId,
        ...(ignored.length ? { [IGNORED_HEADER]: [...new Set(ignored)].join(', ') } : {}),
        ...(cold ? { [RESUME_HEADER]: 'cold' } : {}),
      };

      if (turn.stream) {
        const stream: SseStream = openStream(req, reply, { headers: out, trailers: [COST_HEADER], retry: false });
        // The stream drops what comes after the client left or after its end (`SseStream.closed`)
        const write = (item: Item): void => {
          remember();
          plan.write(stream, item);
        };
        current.stream(write, plan.opening(translator), () => reply.raw.destroy());
        await settled(current);
        remember();
        stream.end(current.costUsd !== null ? { [COST_HEADER]: String(current.costUsd) } : {});
        return reply;
      }

      await settled(current);
      remember();
      void reply.headers(out);
      const whole = plan.whole(translator);
      if (whole.kind === 'error') return answer(reply, whole.error);
      if (current.costUsd !== null) void reply.header(COST_HEADER, String(current.costUsd));
      return reply.send(whole.body);
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

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
    // Whichever side of the race loses is taken down: the grace timer, and the result listener on
    // the chat, which would otherwise stay until a result that may never come
    const lost = new AbortController();
    let grace: NodeJS.Timeout | undefined;
    let settled: boolean;
    try {
      const ended = core.runtime.nextResult(chatId, lost.signal).then(
        () => true,
        () => true,
      );
      await core.chats.interrupt(chatId).catch(() => undefined);
      const timedOut = new Promise<false>((r) => {
        grace = setTimeout(() => r(false), interruptGraceMs());
        grace.unref();
      });
      settled = await Promise.race([ended, timedOut]);
    } finally {
      clearTimeout(grace);
      lost.abort();
    }
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
  function continueHeld<Item>(current: TurnRun<Item>, chatId: string, tools: ClientToolSession, trailing: ReturnType<typeof trailingResults>, apply: () => void): void {
    apply();
    current.attach(chatId);
    tools.deliver(trailing.results);
    current.replay();
  }

  /**
   * The conversation part a chat runs with: its row, or null for a chat from before the rows. Never
   * read back from the process's prompt, which is the join and would carry old `instructions` along.
   */
  function chatConversation(chatId: string): string | null {
    return core.openaiChatPrompts.find(chatId)?.conversation ?? null;
  }

  /** What the request's system and developer messages build on (`ConversationBase`); null when that part is unknown. */
  function conversationBaseOf(named: string | undefined, previous: Previous | null, target: Target): ConversationBase | null {
    if (previous) {
      const conversation = previous.conversation ?? chatConversation(previous.chatId);
      return conversation === null ? null : { kind: 'chain', conversation };
    }
    if (named !== undefined && target.kind === 'existing') {
      const conversation = chatConversation(target.chatId);
      return conversation === null ? null : { kind: 'named', conversation };
    }
    return { kind: 'whole' };
  }

  /** The parts the request asked for, which the chat's next process runs with. A failed write is logged: the turn already runs. */
  function rememberSystemPrompt(req: FastifyRequest, chatId: string, parts: SystemPromptParts): void {
    try {
      core.openaiChatPrompts.save(chatId, parts);
    } catch (err) {
      req.log.error({ err, scope: 'openai', chatId }, 'storing the system prompt failed; the turn goes on without it');
    }
  }

  /**
   * What `x-claudio-ignored` names when the process keeps its prompt, in the request's API's words:
   * `instructions` (Responses only) and the history's field (`messages`, `input`), each when the
   * process does not run the value the request asked for. Read against the live process's joined
   * prompt, not the row: the row holds the parts last asked for, which a held turn saves without
   * running them. The process's own parts are not kept, so the join is read: a wanted part runs when
   * the join starts (instructions) or ends (conversation) with it, and an empty one when the other
   * part does not run, which then is the whole difference. A part with a blank line of its own can be
   * taken for the wrong side; when nothing can be told apart, both are named.
   */
  function keptPromptNames(chatId: string, parts: SystemPromptParts, names: ParamNames): string[] {
    const running = core.runtime.systemPromptOf(chatId) ?? '';
    if (running === effectiveSystemPrompt(parts)) return [];
    const history = names.results.param;
    const { instructions } = names;
    const { instructions: wanted, conversation } = parts;
    const startsWith = wanted !== '' && (running === wanted || running.startsWith(`${wanted}\n\n`));
    const endsWith = conversation !== '' && (running === conversation || running.endsWith(`\n\n${conversation}`));
    const runsInstructions = wanted === '' ? !endsWith && conversation !== '' : startsWith;
    const runsConversation = conversation === '' ? !startsWith && wanted !== '' : endsWith;
    const changed = [...(instructions && !runsInstructions ? [instructions] : []), ...(runsConversation ? [] : [history])];
    return changed.length ? changed : [...(instructions ? [instructions] : []), history];
  }

  /** A chat the OpenAI surface started, that still exists. */
  async function isApiChat(id: string): Promise<boolean> {
    return core.runtime.get(id)?.origin === 'api' && (await core.chats.get(id)) !== null;
  }

  /**
   * The chat the request continues: the one it names, or the one its history leads to. A row whose
   * chat was deleted since (or pruned) is a miss, and the conversation starts again from the history.
   */
  async function targetOf(named: string | undefined, turn: OpenAiChatTurn, previous: Previous | null): Promise<Target> {
    if (previous) {
      // A stored response of a chat that is no longer this surface's (or no longer there) is not one
      // this client may continue: the same 404 as an unknown id
      if (!(await isApiChat(previous.chatId))) throw fail(previous.refusal);
      return { kind: 'existing', chatId: previous.chatId };
    }
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
   * start with the stub while the API's address is unknown. `keepsPrompt`: the live process goes on
   * with its own system prompt, since the restart a new one needs cannot happen.
   */
  function existingTurnPlan(
    id: string,
    turn: OpenAiChatTurn,
    opts: { tools: ClientToolSession | null; wantsTools: boolean; requestTools: OpenAiChatTurn['tools']; system: string },
    ending: boolean,
  ): { runtime: NonNullable<ReturnType<Core['runtime']['get']>>; restart: boolean; keepsPrompt: boolean } {
    const { tools } = opts;
    const runtime = core.runtime.get(id);
    if (!runtime) throw fail({ kind: 'not-found', message: `No chat ${id}.` });
    if (runtime.pid !== null && runtime.status !== 'idle' && !ending) {
      // A live process keeps how it was started: only a turn on an idle one is ours to send
      throw fail({ kind: 'conflict', message: 'The chat is working on another turn; try again when it ends.' });
    }
    // `--json-schema`, `--mcp-config` and `--append-system-prompt` are fixed when the process starts: a
    // turn asking for another schema (or for none after one), for client tools the live process does
    // not serve, or with another effective system prompt (`systemPromptParts`: Responses'
    // `instructions` may change on every request) ends the idle process and resumes the chat with its
    // own. The same ones keep it. So every turn runs with the prompt its request asks for, whether its
    // process was alive or not
    const toolsChanged = opts.wantsTools && tools !== null && (tools.servedPid !== runtime.pid || !sameClientTools(tools.tools, opts.requestTools));
    const schemaChanged = !sameJsonSchema(core.runtime.jsonSchemaOf(id), turn.jsonSchema);
    const systemChanged = !sameSystemPrompt(core.runtime.systemPromptOf(id), opts.system);
    const restart = runtime.pid !== null && (schemaChanged || toolsChanged || systemChanged);
    if (tools && (restart || runtime.pid === null) && !registry.servers(core, tools)) {
      // A new prompt alone is not worth refusing the turn for: the live process, which serves the
      // stub already, answers it with the prompt it has, and `x-claudio-ignored` says so
      if (runtime.pid !== null && !schemaChanged && !toolsChanged) return { runtime, restart: false, keepsPrompt: true };
      throw fail({ kind: 'unavailable', message: "Client tools need the API's own address, which is not known yet." });
    }
    return { runtime, restart, keepsPrompt: false };
  }

  /**
   * Sends the turn: a new chat, a message to a live process that is idle, or a resume of one nobody
   * holds. The run is attached before anything is sent, so no event of the turn is missed. A chat
   * with client tools runs with `permissionPrompts: 'host'` and its session as the host, which holds
   * the client's calls and refuses everything else at once, as `'none'` would (spike change 1).
   * Resolves to whether the chat's process runs with `opts.system`: false only when a live process
   * had to keep its own (`existingTurnPlan`).
   */
  async function startTurn<Item>(
    current: TurnRun<Item>,
    target: Target,
    turn: OpenAiChatTurn,
    prompt: string,
    attachments: string[],
    opts: {
      provider: string;
      cwd: string | undefined;
      toolPreset: string | undefined;
      ignored: string[];
      /** What `x-claudio-ignored` calls the effort a live process cannot take */
      effortName: string;
      tools: ClientToolSession | null;
      wantsTools: boolean;
      requestTools: OpenAiChatTurn['tools'];
      apply: () => void;
      /** The effective system prompt the request asks for (`effectiveSystemPrompt`) */
      system: string;
    },
  ): Promise<boolean> {
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
          ...(opts.system ? { appendSystemPrompt: opts.system } : {}),
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
      return true;
    }
    const id = target.chatId;
    const { runtime, restart, keepsPrompt } = existingTurnPlan(id, turn, opts, false);
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
      if (turn.effort) opts.ignored.push(opts.effortName);
      if (turn.model !== runtime.model) await core.runtime.updateSettings(id, { model: turn.model });
      current.attach(id);
      await core.chats.send(id, { text: prompt, attachments });
      current.replay();
      return !keepsPrompt;
    }
    current.attach(id);
    await core.chats.resume(id, {
      prompt,
      ...(attachments.length ? { attachments } : {}),
      model: turn.model,
      ...(turn.effort ? { effort: turn.effort } : {}),
      // Always set, a resume keeping the chat's earlier prompt for a field left out: the effective
      // prompt holds the conversation's part whether or not this request resent it, so it is empty
      // only when the conversation has none and the request no `instructions`
      appendSystemPrompt: opts.system,
      ...(opts.toolPreset ? { toolPreset: opts.toolPreset } : {}),
      permissionMode,
      permissionPrompts: prompts,
    }, { jsonSchema: turn.jsonSchema ?? null, extraMcpServers: tools ? servers() : null });
    served(id);
    current.replay();
    return true;
  }
};
