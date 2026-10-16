import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddProjectDocRequest, ClaudioLanguage, ConnectorsOverview, ProjectDoc, ProjectDocsOverview, ProjectDocStatus, ToolPolicy } from '@claudio/shared';
import type { ChatRuntime, NewChat, RunResult } from './chats.ts';
import { writeAtomic } from './config/files.ts';
import { stoppedOnMaxTokens } from './open-items.ts';
import type { CoreConfig } from './paths.ts';
import { PASTED_NOTE, pasted } from './prompt-rules.ts';

/*
 * The documents a project knows, from Claude Docs. The Docs connector has no "list my documents"
 * tool, so a project keeps a registry (a JSON document, like its other settings) of the ids and
 * links Claudio created or a person pasted, and the connector is how each one is read and written.
 *
 * Claudio never opens a socket to the connector and never holds its token. Every operation is one
 * confined `claude` session whose only tools are the Docs connector's, driven over the CLI; the
 * CLI owns the sign-in and Claudio owns the prompt and the structured result.
 */

export class ProjectDocsError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 502,
  ) {
    super(message);
  }

  /** The message is written for the person, also on a 502: the API shows it instead of "internal error" */
  readonly expose = true;
}

const PROJECT_ID = /^[\w-]{1,300}$/;
const MAX_DOCS = 100;
const MAX_TITLE = 300;
const MAX_BODY = 50_000;
const MAX_URL = 2000;
/** A session that has not answered by then is cut: the connector reads a document in seconds */
const SESSION_TIMEOUT_MS = 180_000;
const EXIT_GRACE_MS = 5_000;

/** Only the Docs connector's tools: no file, no shell, no network of the session's own */
const DOCS_POLICY: ToolPolicy = { read: { allow: false }, edit: { allow: 'none' }, commands: { allow: 'none' }, network: 'deny', gitPush: 'deny' };

/** The part of the chat runtime a docs session drives; the tests hand it the real one over a fake CLI */
export interface DocsRuntime {
  start(opts: NewChat): ChatRuntime;
  waitForResult(id: string): Promise<RunResult>;
  stop(id: string): unknown;
  exited(id: string): Promise<void>;
  remove(id: string): boolean;
}

export interface ProjectDocsDeps {
  config: Pick<CoreConfig, 'dataDir'>;
  runtime: DocsRuntime;
  connectors: { overview(refresh?: boolean): Promise<ConnectorsOverview> };
  /** Model for the sessions; unset lets the CLI choose */
  model?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isStatus = (value: unknown): value is ProjectDocStatus => value === 'unread' || value === 'ok' || value === 'unavailable';

/**
 * The tool prefix the CLI gives a server's tools: `mcp__` and the server's name with every character
 * outside letters, digits, `_` and `-` replaced by `_` (`claude.ai Claude Docs` → `mcp__claude_ai_Claude_Docs`).
 * Allowing the prefix alone allows every tool of that server and no other.
 */
export function mcpServerPrefix(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** A claude.ai link, normalised; throws a 400 for anything else, since a session is only to open Claude's own documents */
export function parseDocUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL) throw new ProjectDocsError('url must be a link to a Claude Doc', 400);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProjectDocsError('url must be a link to a Claude Doc', 400);
  }
  if (url.protocol !== 'https:' || (url.hostname !== 'claude.ai' && !url.hostname.endsWith('.claude.ai'))) {
    throw new ProjectDocsError('url must be a claude.ai link', 400);
  }
  url.hash = '';
  return url.toString();
}

function entryOf(raw: unknown): ProjectDoc | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.url !== 'string') return null;
  return {
    id: raw.id,
    url: raw.url,
    title: typeof raw.title === 'string' ? raw.title : raw.id,
    kind: 'doc',
    createdBy: raw.createdBy === 'claudio' ? 'claudio' : 'person',
    addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : new Date(0).toISOString(),
    status: isStatus(raw.status) ? raw.status : 'unread',
    checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : null,
  };
}

/** One JSON file per project in the data directory, read and written whole. */
export class ProjectDocsStore {
  private readonly dir: string;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(config: Pick<CoreConfig, 'dataDir'>) {
    this.dir = join(config.dataDir, 'project-docs');
    mkdirSync(this.dir, { recursive: true });
  }

  private file(projectId: string): string {
    // Ids are ours, but they end up in a path
    if (!PROJECT_ID.test(projectId)) throw new Error('invalid project id');
    return join(this.dir, `${projectId}.json`);
  }

  read(projectId: string): ProjectDocsOverview {
    const file = this.file(projectId);
    if (!existsSync(file)) return { docs: [], refreshedAt: null };
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!isObject(raw) || !Array.isArray(raw.docs)) return { docs: [], refreshedAt: null };
      return { docs: raw.docs.flatMap((d) => entryOf(d) ?? []), refreshedAt: typeof raw.refreshedAt === 'string' ? raw.refreshedAt : null };
    } catch {
      return { docs: [], refreshedAt: null };
    }
  }

  /** Changes run one at a time, each on what the one before wrote */
  update<T>(projectId: string, change: (current: ProjectDocsOverview) => { next: ProjectDocsOverview; value: T }): Promise<T> {
    const run = this.lock.then(async () => {
      const { next, value } = change(this.read(projectId));
      await writeAtomic(this.file(projectId), `${JSON.stringify(next, null, 2)}\n`);
      return value;
    });
    this.lock = run.catch(() => undefined);
    return run;
  }
}

const READ_RULES = 'Only read: do not create, change, comment on or delete anything.';

function languageName(language: ClaudioLanguage): string {
  return language === 'es' ? 'Spanish (Spain)' : 'English';
}

/** What a session reports of one document. */
interface DocReport {
  id: string;
  found: boolean;
  title: string;
  url: string;
}

const REPORT_PROPERTIES = {
  id: { type: 'string', description: 'The document id as the connector reports it; empty when not found' },
  found: { type: 'boolean' },
  title: { type: 'string' },
  url: { type: 'string', description: 'The canonical link of the document; empty when not found' },
};

const docsSchema = (): Record<string, unknown> => ({
  type: 'object',
  properties: { docs: { type: 'array', items: { type: 'object', properties: REPORT_PROPERTIES, required: ['id', 'found', 'title', 'url'], additionalProperties: false } } },
  required: ['docs'],
  additionalProperties: false,
});

function parseReports(raw: unknown): DocReport[] | null {
  if (!isObject(raw) || !Array.isArray(raw.docs)) return null;
  const reports: DocReport[] = [];
  for (const item of raw.docs) {
    if (!isObject(item) || typeof item.id !== 'string' || typeof item.found !== 'boolean' || typeof item.title !== 'string' || typeof item.url !== 'string') return null;
    reports.push({ id: item.id, found: item.found, title: item.title.slice(0, MAX_TITLE), url: item.url });
  }
  return reports;
}

/** The prompt that looks documents up. Titles and links are material, never orders. */
export function readPrompt(refs: ReadonlyArray<{ ref: string }>): string {
  return [
    'Use the Claude Docs connector to look up each document below by its id or link, and report in the structured result, in the same order, its id, its link and its current title. If one cannot be found or opened, report it with found false and empty strings.',
    READ_RULES,
    PASTED_NOTE,
    pasted(refs.map((r) => r.ref).join('\n')),
  ].join('\n\n');
}

/** The prompt that creates a document. The title and body are the person's words, kept as written. */
export function createPrompt(create: { title: string; body: string }, language: ClaudioLanguage): string {
  const body = create.body.trim()
    ? ['Use exactly this body as the first content of the document:', pasted(create.body)]
    : [`The person gave no body: write a short first outline that fits the title, in ${languageName(language)}.`];
  return [
    'Use the Claude Docs connector to create exactly one new document, with the title and body below, and report its id, link and title in the structured result (docs has one entry). Create nothing else and do not change any other document.',
    PASTED_NOTE,
    'Title:',
    pasted(create.title),
    ...body,
  ].join('\n\n');
}

export class ProjectDocsService {
  readonly store: ProjectDocsStore;

  constructor(private readonly deps: ProjectDocsDeps) {
    this.store = new ProjectDocsStore(deps.config);
  }

  overview(projectId: string): ProjectDocsOverview {
    return this.store.read(projectId);
  }

  /** Adds a document by link, or creates one through the connector. Returns the entry. */
  async add(projectId: string, request: AddProjectDocRequest, language: ClaudioLanguage = 'en'): Promise<ProjectDoc> {
    const hasUrl = request.url !== undefined;
    const hasCreate = request.create !== undefined;
    if (hasUrl === hasCreate) throw new ProjectDocsError('send either url or create', 400);
    if (this.store.read(projectId).docs.length >= MAX_DOCS) throw new ProjectDocsError(`a project holds at most ${String(MAX_DOCS)} documents`, 409);

    let createdBy: ProjectDoc['createdBy'];
    let prompt: string;
    if (hasUrl) {
      const url = parseDocUrl(request.url);
      createdBy = 'person';
      prompt = readPrompt([{ ref: url }]);
    } else {
      const create = request.create;
      const title = typeof create?.title === 'string' ? create.title.trim() : '';
      const body = typeof create?.body === 'string' ? create.body : '';
      if (!title || title.length > MAX_TITLE) throw new ProjectDocsError(`title must be 1 to ${String(MAX_TITLE)} characters`, 400);
      if (body.length > MAX_BODY) throw new ProjectDocsError(`body must be at most ${String(MAX_BODY)} characters`, 400);
      createdBy = 'claudio';
      prompt = createPrompt({ title, body }, language);
    }

    const [report] = await this.session(prompt);
    if (!report?.found || !report.id) throw new ProjectDocsError('Claude Docs could not open that document', 404);
    const url = report.url ? parseDocUrl(report.url) : hasUrl ? parseDocUrl(request.url) : null;
    if (!url) throw new ProjectDocsError('Claude Docs did not return a link for the document', 502);

    return this.store.update(projectId, (current) => {
      const existing = current.docs.find((d) => d.id === report.id);
      if (existing) throw new ProjectDocsError('that document is already in the project', 409);
      const entry: ProjectDoc = { id: report.id, url, title: report.title || report.id, kind: 'doc', createdBy, addedAt: new Date().toISOString(), status: 'ok', checkedAt: new Date().toISOString() };
      return { next: { ...current, docs: [...current.docs, entry] }, value: entry };
    });
  }

  /** Removes the entry; the document on claude.ai is never touched. */
  async remove(projectId: string, docId: string): Promise<void> {
    await this.store.update(projectId, (current) => {
      if (!current.docs.some((d) => d.id === docId)) throw new ProjectDocsError('document not found in this project', 404);
      return { next: { ...current, docs: current.docs.filter((d) => d.id !== docId) }, value: undefined };
    });
  }

  find(projectId: string, docId: string): ProjectDoc {
    const doc = this.store.read(projectId).docs.find((d) => d.id === docId);
    if (!doc) throw new ProjectDocsError('document not found in this project', 404);
    return doc;
  }

  /** Reads every entry's current title through the connector; one that no longer resolves is marked, not dropped. */
  async refresh(projectId: string): Promise<ProjectDocsOverview> {
    const before = this.store.read(projectId).docs;
    // Nothing to read means no session to pay for
    const reports = before.length === 0 ? [] : await this.session(readPrompt(before.map((d) => ({ ref: d.url }))), before.length);
    const now = new Date().toISOString();
    return this.store.update(projectId, (current) => {
      const docs = current.docs.map((doc) => {
        // The session answers in the order it was asked; the id is the fallback if it reordered
        const index = before.findIndex((d) => d.id === doc.id);
        const report = (index >= 0 && reports[index]?.id === doc.id ? reports[index] : undefined) ?? reports.find((r) => r.id === doc.id) ?? (index >= 0 ? reports[index] : undefined);
        if (!report) return doc;
        if (!report.found) return { ...doc, status: 'unavailable' as const, checkedAt: now };
        return { ...doc, title: report.title || doc.title, status: 'ok' as const, checkedAt: now };
      });
      const next = { docs, refreshedAt: now };
      return { next, value: next };
    });
  }

  /**
   * One confined session: the Docs connector's tools and nothing else, one turn, the answer held to
   * a schema. Whether it reads or creates is the prompt's word; the tools are the same.
   */
  private async session(prompt: string, expected = 1): Promise<DocReport[]> {
    const overview = await this.deps.connectors.overview();
    const docs = overview.connectors.find((c) => c.kind === 'docs');
    if (!docs) throw new ProjectDocsError('the Claude Docs connector is not available on this account', 409);
    if (docs.status !== 'connected') throw new ProjectDocsError('the Claude Docs connector is not connected: authorise it, then try again', 409);

    let chat: ChatRuntime;
    try {
      chat = this.deps.runtime.start({
        prompt,
        name: 'project docs',
        provider: 'claude-code',
        ...(this.deps.model ? { model: this.deps.model } : {}),
        jsonSchema: docsSchema(),
        internal: true,
        keepAlive: false,
        uploads: false,
        api: false,
        // No built-in tool and no settings source: nothing of the person's applies, and the connector is the only way out
        confine: { tools: [], settingSources: [] },
        // No `--mcp-config`: a strict one would also leave out the claude.ai connectors the account is signed in with
        toolConfig: { preset: null, allowedTools: [mcpServerPrefix(docs.id)], disallowedTools: [], mcp: null, policy: DOCS_POLICY },
        allowedTools: [mcpServerPrefix(docs.id)],
        permissionMode: 'dontAsk',
        permissionPrompts: 'none',
      });
    } catch (err) {
      throw new ProjectDocsError(`could not start the session: ${err instanceof Error ? err.message : String(err)}`, 502);
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      const cut = new Promise<'cut'>((resolve) => {
        timer = setTimeout(() => resolve('cut'), SESSION_TIMEOUT_MS);
      });
      const result = await Promise.race([this.deps.runtime.waitForResult(chat.id), cut]);
      if (result === 'cut') throw new ProjectDocsError('Claude Docs took too long to answer', 502);
      if (result.isError) throw new ProjectDocsError(`Claude Docs session failed: ${result.result.slice(0, 300)}`, 502);
      if (stoppedOnMaxTokens(result)) throw new ProjectDocsError('Claude Docs session was cut off before it finished', 502);
      const reports = parseReports(result.structuredOutput);
      if (!reports || reports.length !== expected) throw new ProjectDocsError('Claude Docs gave an answer Claudio could not read', 502);
      return reports;
    } finally {
      if (timer) clearTimeout(timer);
      await this.dispose(chat.id);
    }
  }

  /** Stops what is still running and removes the chat: the registry is the record, the session leaves nothing */
  private async dispose(id: string): Promise<void> {
    try {
      this.deps.runtime.stop(id);
    } catch {
      // already over
    }
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([this.deps.runtime.exited(id), new Promise((r) => (grace = setTimeout(r, EXIT_GRACE_MS)))]).catch(() => undefined);
    if (grace) clearTimeout(grace);
    this.deps.runtime.remove(id);
  }
}
