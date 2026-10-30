import { readFile } from 'node:fs/promises';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Core } from '@claudio/core';
import { CollaboratorsError } from '@claudio/core';
import { normalizeMessage, TRANSCRIPT_PAGE, TRANSCRIPT_PAGE_MAX } from '@claudio/shared';
import { auditSummary } from '../security.ts';
import type {
  AgentReadList,
  CollaboratorsKind,
  CreateGroupRequest,
  JoinGroupRequest,
  LinkSharedProjectRequest,
  SharedAgentTranscriptPage,
  SharedTranscriptPage,
  TranscriptEntry,
  TransferGroupOwnershipRequest,
  UpdateCollaboratorsRequest,
  UpdateProjectSharingRequest,
} from '@claudio/shared';

/** Types that are safe to show inline in the browser; anything else of an upload is downloaded */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
const SHA256 = /^[0-9a-f]{64}$/;
/** How many copied lines one read of the store hands back (its own ceiling) */
const LINES_BATCH = 5_000;

// A missing body reaches the service as an empty object, so its own validation names what is missing
const bodyOf = <T>(body: T | undefined): T => (body ?? {}) as T;

/** A whole number from 0 in the query, or undefined; anything else is the caller's mistake */
function count(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw Object.assign(new Error(`${name} must be a whole number from 0`), { statusCode: 400 });
  return value;
}

/**
 * A window of a copied transcript as `GET /chats/:id` pages its own: the newest `limit` entries, or
 * the ones just before `before`. The copy holds the CLI's JSONL lines as they were written; they are
 * read as entries here, with the same normalisation as a local transcript, subagents' lines left out
 * of a chat's. `agent` reads a subagent's own transcript, every line of which is a sidechain.
 */
export function transcriptPage(chatId: string, lines: readonly string[], live: boolean, opts: { limit?: number; before?: number; agent?: boolean } = {}): SharedTranscriptPage {
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A torn line is skipped, as the local reader skips one
      continue;
    }
    const entry = normalizeMessage(parsed);
    if (entry && (opts.agent || !entry.isSidechain)) entries.push(entry);
  }
  const total = entries.length;
  const limit = Math.min(Math.max(1, opts.limit ?? TRANSCRIPT_PAGE), TRANSCRIPT_PAGE_MAX);
  const to = opts.before === undefined ? total : Math.min(opts.before, total);
  const from = Math.max(0, to - limit);
  return { chatId, entries: entries.slice(from, to), from, total, live };
}

/** The MCP tool a read came from, as `x-claudio-tool` names it; anything else is not a tool name */
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** The most record ids one audit row keeps: a list of hundreds says no more than its first ones */
const MAX_AUDITED_IDS = 200;

/**
 * Collaborators (docs/plans/collaborators.md §6): the owner's routes, reads included, so a chat's
 * token never pulls a teammate's transcript into its own context unasked. Every route here is in
 * `CHAT_FORBIDDEN_COLLABORATORS` in `security.ts`; the copy reads of `AGENT_READABLE` are let
 * through for a chat in scope (docs/plans/collaborators-agent-access.md), filtered to that scope,
 * never pulling from the owner, and written down as a row each. A share key holds `/` and `#`, so a
 * shared project is named in a path by its `shareId`.
 */
export const collaboratorRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  const collab = core.collaborators;

  // The service's refusals carry their status; anything else goes on to the app's own handler,
  // which an error thrown from here reaches
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const inUse = err as Error & { code?: unknown; body?: unknown };
    if (inUse.code === 'share-key-in-use' && typeof inUse.body === 'function') return reply.status(409).send((inUse.body as () => unknown).call(err));
    if (err instanceof CollaboratorsError) throw Object.assign(err, { statusCode: err.status, reason: err.code, expose: true });
    throw err;
  });

  app.get('/collaborators', () => collab.status());
  app.put<{ Body: UpdateCollaboratorsRequest }>('/collaborators', (req) => collab.update(bodyOf(req.body)));

  // ---- Groups
  app.get('/collaborators/groups', () => collab.groupList());
  app.post<{ Body: CreateGroupRequest }>('/collaborators/groups', async (req, reply) => reply.status(201).send(await collab.createGroup(bodyOf(req.body).name)));
  app.delete<{ Params: { id: string } }>('/collaborators/groups/:id', async (req) => {
    await collab.leaveGroup(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/collaborators/groups/:id/invites', (req, reply) => reply.status(201).send(collab.createInvite(req.params.id)));
  app.delete<{ Params: { id: string; endpointId: string } }>('/collaborators/groups/:id/members/:endpointId', (req) => collab.removeMember(req.params.id, req.params.endpointId));
  app.put<{ Params: { id: string }; Body: TransferGroupOwnershipRequest }>('/collaborators/groups/:id/owner', (req) => collab.transferOwnership(req.params.id, bodyOf(req.body).endpointId));

  // ---- Joins
  // `202` while nobody answered yet: the join is kept and goes on trying, and its outcome arrives as events
  app.post<{ Body: JoinGroupRequest }>('/collaborators/join', async (req, reply) => {
    const result = await collab.join(bodyOf(req.body).invite);
    if (result.state === 'pending') reply.code(202);
    return result;
  });
  app.delete<{ Params: { groupId: string } }>('/collaborators/join/:groupId', async (req) => {
    await collab.cancelJoin(req.params.groupId);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/collaborators/groups/:id/join-requests', (req) => collab.joinRequests(req.params.id));
  app.post<{ Params: { id: string; from: string } }>('/collaborators/groups/:id/join-requests/:from/accept', (req) => collab.acceptJoin(req.params.id, req.params.from));
  app.post<{ Params: { id: string; from: string } }>('/collaborators/groups/:id/join-requests/:from/deny', (req) => {
    collab.denyJoin(req.params.id, req.params.from);
    return { ok: true };
  });

  // ---- A project's sharing
  app.get<{ Params: { id: string } }>('/projects/:id/sharing', (req) => collab.projectSharing(req.params.id));
  app.put<{ Params: { id: string }; Body: UpdateProjectSharingRequest }>('/projects/:id/sharing', (req) => collab.updateProjectSharing(req.params.id, bodyOf(req.body)));

  // ---- What others share with this install
  type Shared = { owner: string; shareId: string };
  /** The chat whose token made the request; null for the person */
  const chatOf = (req: FastifyRequest): string | null => (req.actor?.startsWith('chat:') ? req.actor.slice('chat:'.length) : null);
  /**
   * One audit row for a chat's read of one copy. The guard let the request through, so the copy is
   * in the chat's scope; the tool is what the MCP server says it is, the route's summary otherwise.
   */
  const audit = (req: FastifyRequest, p: Shared, kind: CollaboratorsKind | null, recordIds: readonly string[]): void => {
    const chatId = chatOf(req);
    if (chatId === null) return;
    const share = collab.sharedKey(p.owner, p.shareId);
    if (!share) return;
    const header = req.headers['x-claudio-tool'];
    const tool = typeof header === 'string' && TOOL_NAME.test(header) ? header : auditSummary(req.method, req.routeOptions.url, req.url.split('?')[0] ?? req.url);
    collab.recordAgentRead({ chatId, tool, owner: p.owner, shareKey: share, kind, recordIds: recordIds.slice(0, MAX_AUDITED_IDS) });
  };

  app.get('/collaborators/shared', async (req) => {
    const chatId = chatOf(req);
    if (chatId === null) return collab.shared();
    // The guard checked the chat has a scope; the list is the copies in it, each listing audited
    const decision = core.agentReadScope(chatId);
    if (!('scope' in decision)) return [];
    const listed = await collab.sharedForAgent(decision.scope);
    for (const share of listed) audit(req, share, null, []);
    return listed;
  });
  app.get<{ Params: Shared }>('/collaborators/shared/:owner/:shareId', async (req) => {
    const found = await collab.sharedProject(req.params.owner, req.params.shareId);
    audit(req, req.params, null, []);
    return found;
  });
  app.put<{ Params: Shared; Body: LinkSharedProjectRequest }>('/collaborators/shared/:owner/:shareId/link', (req) => collab.link(req.params.owner, req.params.shareId, bodyOf(req.body).projectId));
  app.delete<{ Params: Shared }>('/collaborators/shared/:owner/:shareId/link', (req) => collab.unlink(req.params.owner, req.params.shareId));

  // `?refresh=1` pulls the kind from its owner first; an owner away leaves the copy as it is. A chat's
  // read never reaches a peer: it reads the copy held, whatever it asks
  const fresh = async (req: FastifyRequest, p: Shared, kind: CollaboratorsKind, refresh: string | undefined): Promise<void> => {
    if (refresh === '1' && chatOf(req) === null) await collab.refresh(p.owner, p.shareId, kind);
  };
  type Copy = { Params: Shared; Querystring: { refresh?: string } };
  app.get<Copy>('/collaborators/shared/:owner/:shareId/chats', async (req) => {
    await fresh(req, req.params, 'chats', req.query.refresh);
    const chats = collab.sharedChats(req.params.owner, req.params.shareId);
    audit(req, req.params, 'chats', chats.map((c) => c.id));
    return chats;
  });
  app.get<Copy>('/collaborators/shared/:owner/:shareId/memory', async (req) => {
    await fresh(req, req.params, 'memory', req.query.refresh);
    const files = collab.sharedMemory(req.params.owner, req.params.shareId);
    audit(req, req.params, 'memory', files.map((f) => f.name));
    return files;
  });
  app.get<Copy>('/collaborators/shared/:owner/:shareId/journal', async (req) => {
    await fresh(req, req.params, 'journal', req.query.refresh);
    const entries = collab.sharedJournal(req.params.owner, req.params.shareId);
    audit(req, req.params, 'journal', entries.map((e) => e.id));
    return entries;
  });
  app.get<Copy>('/collaborators/shared/:owner/:shareId/documents', async (req) => {
    await fresh(req, req.params, 'documents', req.query.refresh);
    const documents = collab.sharedDocuments(req.params.owner, req.params.shareId);
    audit(req, req.params, 'documents', documents.map((d) => d.path));
    return documents;
  });
  app.get<Copy>('/collaborators/shared/:owner/:shareId/work-items', async (req) => {
    await fresh(req, req.params, 'board', req.query.refresh);
    const board = collab.sharedBoard(req.params.owner, req.params.shareId);
    audit(req, req.params, 'board', [...board.items.map((i) => i.id), ...board.milestones.map((m) => m.id)]);
    return board;
  });
  app.get<Copy>('/collaborators/shared/:owner/:shareId/artifacts', async (req) => {
    await fresh(req, req.params, 'artifacts', req.query.refresh);
    const artifacts = collab.sharedArtifacts(req.params.owner, req.params.shareId);
    audit(req, req.params, 'artifacts', artifacts.map((a) => a.id));
    return artifacts;
  });

  // Every line is read: an entry's index depends on the lines before it, and the copy is local
  const copiedLines = (owner: string, shareId: string, chatId: string, agent?: { agentId: string; workflowRunId: string | null }): { lines: string[]; live: boolean } => {
    const lines: string[] = [];
    let live = false;
    for (let after = -1; ; ) {
      const batch = collab.sharedTranscript(owner, shareId, chatId, { after, limit: LINES_BATCH, ...(agent ? { agent } : {}) });
      live = batch.live;
      for (const row of batch.lines) lines.push(row.line);
      const last = batch.lines.at(-1);
      if (!last || batch.lines.length < LINES_BATCH) break;
      after = last.seq;
    }
    return { lines, live };
  };
  const windowOf = (query: { limit?: string; before?: string }): { limit?: number; before?: number } => {
    const limit = count(query.limit, 'limit');
    const before = count(query.before, 'before');
    return { ...(limit !== undefined ? { limit } : {}), ...(before !== undefined ? { before } : {}) };
  };

  app.get<{ Params: Shared & { chatId: string }; Querystring: { limit?: string; before?: string } }>('/collaborators/shared/:owner/:shareId/chats/:chatId/transcript', (req) => {
    const { owner, shareId, chatId } = req.params;
    // The query is checked before the copy is read, so a bad one is 400 whatever is held
    const window = windowOf(req.query);
    const { lines, live } = copiedLines(owner, shareId, chatId);
    audit(req, req.params, 'chats', [chatId]);
    return transcriptPage(chatId, lines, live, window);
  });

  // A subagent's, or with `?workflow=` a workflow agent's, transcript, copied with its chat's
  app.get<{ Params: Shared & { chatId: string; agentId: string }; Querystring: { workflow?: string; limit?: string; before?: string } }>(
    '/collaborators/shared/:owner/:shareId/chats/:chatId/subagents/:agentId',
    (req): SharedAgentTranscriptPage => {
      const { owner, shareId, chatId, agentId } = req.params;
      const workflowRunId = req.query.workflow || null;
      const window = windowOf(req.query);
      const { lines, live } = copiedLines(owner, shareId, chatId, { agentId, workflowRunId });
      audit(req, req.params, 'chats', [chatId, agentId]);
      return { ...transcriptPage(chatId, lines, live, { ...window, agent: true }), agentId, workflowRunId };
    },
  );

  // What agents read of the copies, for Settings → Access & safety and the copy's own "read by" line
  app.get<{ Querystring: { owner?: string; shareId?: string; chatId?: string; since?: string; limit?: string } }>('/collaborators/agent-reads', (req): AgentReadList => {
    const { owner, shareId, chatId, since } = req.query;
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw Object.assign(new Error('since must be a date'), { statusCode: 400 });
    const limit = count(req.query.limit, 'limit');
    return {
      reads: collab.agentReads({
        ...(owner ? { owner } : {}),
        ...(shareId ? { shareId } : {}),
        ...(chatId ? { chatId } : {}),
        ...(since ? { since: new Date(since).toISOString() } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    };
  });

  app.get<{ Params: Shared & { sha256: string } }>('/collaborators/shared/:owner/:shareId/blobs/:sha256', async (req, reply) => {
    const { owner, shareId, sha256 } = req.params;
    if (!SHA256.test(sha256)) throw Object.assign(new Error('sha256 must be 64 lower-case hex characters'), { statusCode: 400 });
    const file = await collab.blob(owner, shareId, sha256);
    const upload = collab.sharedArtifacts(owner, shareId).find((a) => a.kind === 'upload' && a.sha256 === sha256);
    // A document is Markdown or text from the owner's working tree: shown as text, never as a page
    const type = upload?.kind === 'upload' ? (INLINE.has(upload.mediaType) ? upload.mediaType : 'application/octet-stream') : 'text/plain; charset=utf-8';
    if (upload?.kind === 'upload' && !INLINE.has(upload.mediaType)) void reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(upload.name)}`);
    return reply
      .header('content-type', type)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'")
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(await readFile(file));
  });
};

