import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { answerOpenAiStub, ClientToolSession, clientToolsServerEntry, CLIENT_TOOLS_SERVER, type Core, type OpenAiClientTool } from '@claudio/core';

/** Where the stub MCP server of one chat's client tools answers, under `/api` */
export const stubPath = (sessionId: string): string => `/openai/client-tools/${sessionId}/mcp`;

/**
 * The client-tool sessions of the OpenAI surface, by chat and by the id in the stub's URL. Shared by
 * the `/v1` routes, which create and drive them, and the stub route the CLI calls.
 */
export class ClientToolRegistry {
  private readonly byChat = new Map<string, ClientToolSession>();
  private readonly byId = new Map<string, ClientToolSession>();

  create(tools: OpenAiClientTool[]): ClientToolSession {
    const session = new ClientToolSession(tools);
    this.byId.set(session.id, session);
    return session;
  }

  bind(session: ClientToolSession, chatId: string): void {
    session.chatId = chatId;
    this.byChat.set(chatId, session);
  }

  ofChat(chatId: string): ClientToolSession | undefined {
    return this.byChat.get(chatId);
  }

  ofId(id: string): ClientToolSession | undefined {
    return this.byId.get(id);
  }

  /**
   * A session whose turn never started (the start was refused or threw), bound to its chat already
   * or not: nothing else would ever drop a session whose chat was not created.
   */
  discard(session: ClientToolSession): void {
    this.byId.delete(session.id);
    if (session.chatId !== null && this.byChat.get(session.chatId) === session) this.byChat.delete(session.chatId);
    session.dispose();
  }

  /** How many sessions are kept, by stub id and by chat: for tests */
  get size(): { byId: number; byChat: number } {
    return { byId: this.byId.size, byChat: this.byChat.size };
  }

  drop(chatId: string): void {
    const session = this.byChat.get(chatId);
    if (!session) return;
    session.dispose();
    this.byChat.delete(chatId);
    this.byId.delete(session.id);
  }

  /** The `--mcp-config` servers that hand a chat its stub; null while the API's address is unknown */
  servers(core: Core, session: ClientToolSession): Record<string, Record<string, unknown>> | null {
    const api = core.runtime.apiUrl;
    return api ? { [CLIENT_TOOLS_SERVER]: clientToolsServerEntry(`${api}${stubPath(session.id)}`) } : null;
  }
}

function bearer(header: string | undefined): string | undefined {
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1];
}

/**
 * The stub MCP server the CLI loads for a chat with client tools, over HTTP with plain JSON answers.
 * Only the chat's own process may call it: its `CLAUDIO_API_TOKEN`, which the CLI sends from the
 * config entry's `${CLAUDIO_API_TOKEN}`, must belong to the chat the session is bound to. The stub
 * never waits for anything: results are known before the CLI is let through to call it.
 */
export const openAiStubRoutes: FastifyPluginAsync<{ core: Core; registry: ClientToolRegistry }> = async (app, { core, registry }) => {
  app.post<{ Params: { id: string } }>('/openai/client-tools/:id/mcp', async (req, reply) => {
    const session = registry.ofId(req.params.id);
    const token = bearer(req.headers.authorization);
    const chatId = token === undefined ? null : core.security.chatTokens.verify(token);
    // The same answer for an unknown session and a wrong token: neither says which sessions exist
    if (!session || chatId === null || session.chatId !== chatId) return reply.status(401).send({ error: "only the chat's own process may call its client-tool server" });
    const answered = answerOpenAiStub(req.body, session);
    if (answered.status === 202) return reply.status(202).send();
    return reply.status(answered.status).header('content-type', 'application/json').send(answered.body);
  });
  // Streamable HTTP's GET (a server-initiated stream) and DELETE (ending a session): the stub has
  // neither, and 405 is the answer the CLI accepts (spike)
  const none = async (_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => reply.status(405).send();
  app.get('/openai/client-tools/:id/mcp', none);
  app.delete('/openai/client-tools/:id/mcp', none);
};
