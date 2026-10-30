import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Orchestration, Project, WorkItem } from '@claudio/shared';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../../../apps/api/src/app.ts';
import { ROUTE_DOCS } from '../../../apps/api/src/openapi/routes.ts';
import { createClient, type FetchLike } from '../src/client.ts';
import { createServer } from '../src/server.ts';

/** The e2e suite's fake CLI: a chat it runs answers without a model, and its control requests are the CLI's */
export const FAKE_CLI = fileURLToPath(new URL('../../../e2e/fake-cli/claude', import.meta.url));

/** One request the client made, as the API saw it */
export interface SeenRequest {
  url: string;
  headers: Record<string, string>;
  method: string;
  /** The JSON body, parsed; undefined for a request without one */
  body?: unknown;
  status?: number;
  /** False when no route of the API matched the request: Fastify's own 404, not a handler's */
  routed?: boolean;
}

/** `METHOD /path` (without `/api` and the query) matched against the documented routes; null when none matches */
export function routeOf(method: string, url: string): string | null {
  const path = new URL(url, 'http://x').pathname.replace(/^\/api(?=\/)/, '');
  const parts = path.split('/');
  for (const key of Object.keys(ROUTE_DOCS)) {
    const [m, pattern] = key.split(' ');
    if (m !== method || !pattern) continue;
    const want = pattern.split('/');
    if (want.length === parts.length && want.every((w, i) => w.startsWith(':') ? (parts[i] ?? '') !== '' : w === parts[i])) return key;
  }
  return null;
}

export interface Seeded {
  app: FastifyInstance;
  core: Core;
  project: Project;
  item: WorkItem;
  orchestration: Orchestration;
  /** The temporary root: `claude/` is the CLI's config dir, `shop/` the project */
  root: string;
  /** Every request the tools' server made, in order */
  seen: SeenRequest[];
  /** Calls the tools of the server against the real API, in process */
  call(name: string, args?: unknown): Promise<{ isError: boolean; text: string; json: unknown }>;
  close(): Promise<void>;
}

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

/** Whether a 404's body is the router's (Fastify's own, or the app's for `/api` with the UI served), not a handler's */
function unrouted(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    return (typeof parsed.message === 'string' && /^Route \w+:\S+ not found$/.test(parsed.message)) || parsed.error === 'route not found';
  } catch {
    return false;
  }
}

/** `fetch` backed by `app.inject`, so the client's own code, its bodies included, runs against the real routes */
export function injectFetch(app: FastifyInstance, seen: SeenRequest[] = []): FetchLike {
  return async (url, init) => {
    const request: SeenRequest = { url, headers: init.headers, method: init.method, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) };
    seen.push(request);
    const { pathname, search } = new URL(url);
    const res = await app.inject({
      method: init.method as 'GET',
      url: pathname + search,
      headers: init.headers,
      ...(init.body === undefined ? {} : { payload: init.body }),
    });
    request.status = res.statusCode;
    // Fastify answers a request no route matched with its own body: that is a tool calling a route that does not exist
    request.routed = !(res.statusCode === 404 && unrouted(res.body));
    return { status: res.statusCode, text: async () => res.body };
  };
}

/** One line of a transcript, as the CLI writes it */
export interface TranscriptLine {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

/** A chat transcript where the CLI keeps it for `cwd`, one entry per line, a second apart */
export function writeTranscript(core: Core, cwd: string, id: string, lines: readonly TranscriptLine[], start = Date.UTC(2026, 9, 1)): void {
  const dir = join(core.config.projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const text = lines
    .map((line, i) =>
      JSON.stringify({ type: line.role, uuid: `${id}-${i}`, timestamp: new Date(start + i * 1000).toISOString(), cwd, sessionId: id, isSidechain: false, message: { role: line.role, content: line.content } }),
    )
    .join('\n');
  writeFileSync(join(dir, `${id}.jsonl`), `${text}\n`);
}

/**
 * A wrapper on a temporary data dir with project Shop (AGN), item AGN-1, an orchestration and a flow
 * run. `claudeBin` is the CLI its chats run (none that starts, unless given), `chatId` the chat the
 * tools' server runs for.
 */
export async function seed(opts: { claudeBin?: string; chatId?: string } = {}): Promise<Seeded> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-mcp-test-'));
  // The default account is listed only once it has a credential (signin-core), so the sandbox gets a signed-in one
  mkdirSync(join(root, 'claude'), { recursive: true });
  writeFileSync(join(root, 'claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: opts.claudeBin ?? '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  const dir = join(root, 'shop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Shop\n');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'plan.md'), '# Shop plan\n');
  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: dir, name: 'Shop', modules: ['board'] }) });
  const project = imported.json<Project>();
  const created = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/work-items`,
    ...json({ title: 'Cart loses items', type: 'bug', status: 'todo', description: 'Items vanish on reload' }),
  });
  const item = created.json<WorkItem>();
  const orch = await app.inject({ method: 'POST', url: '/api/orchestrations', ...json({ name: 'review', cwd: dir, tasks: [{ id: 'a', name: 'a', prompt: 'do it' }] }) });
  const orchestration = orch.json<Orchestration>();
  const raw = new DatabaseSync(join(root, 'data', 'wrapper.db'));
  raw
    .prepare(
      `INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, outcome, error, queued_at)
       VALUES ('run-1', ?, ?, 'developer', 'developer', 'sonnet', 'work', 'in_progress', 'ended', 'done', NULL, '2026-09-28T00:00:00Z')`,
    )
    .run(project.id, item.id);
  raw.close();

  const seen: SeenRequest[] = [];
  const server = createServer({ api: createClient({ baseUrl: 'http://wrapper.test/api', fetch: injectFetch(app, seen), ...(opts.chatId ? { chatId: opts.chatId } : {}) }), version: 'test' });
  let n = 0;
  return {
    app,
    core,
    project,
    item,
    orchestration,
    root,
    seen,
    async call(name, args = {}) {
      const line = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }));
      const result = (JSON.parse(line ?? 'null') as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
      const text = result.content[0]?.text ?? '';
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // an error message or a truncated result
      }
      return { isError: result.isError, text, json: parsed };
    },
    async close() {
      core.runtime.stopAll();
      await app.close();
      core.shutdown();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
