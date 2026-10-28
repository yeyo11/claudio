import type { FastifyInstance, RouteOptions } from 'fastify';

/**
 * The routes a headless Claudio serves (docs/plans/headless-image.md, D1), as Fastify names them
 * (`METHOD url`, parameters as registered). The one source of truth: every other route is still
 * registered by its plugin, and answers `404 route not found` and is left out of the OpenAPI
 * document. Routes, not plugins: a plugin that serves more than this keeps only the listed routes.
 */
export const HEADLESS_ROUTES: ReadonlySet<string> = new Set([
  // Probes, unauthenticated (D11)
  'GET /api/health',
  'GET /api/ready',
  // Carries `profile`
  'GET /api/system',
  // The chats a program runs; not resume, fork, PATCH, MCP switches, permissions, workflows (D14)
  'GET /api/chats',
  'POST /api/chats',
  'GET /api/chats/:id',
  'POST /api/chats/:id/messages',
  'POST /api/chats/:id/stop',
  'DELETE /api/chats/:id',
  // A chat's attachment upload
  'POST /api/uploads',
  // The client-tool stub the CLI calls for `/v1` client tools
  'GET /api/openai/client-tools/:id/mcp',
  'POST /api/openai/client-tools/:id/mcp',
  'DELETE /api/openai/client-tools/:id/mcp',
  // Ephemeral workspaces (D7)
  'POST /api/workspaces',
  'GET /api/workspaces/:id',
  'DELETE /api/workspaces/:id',
  // The model list
  'GET /api/providers',
  'GET /api/providers/:id/models',
  // Read only: no PUT, DELETE or restore
  'GET /api/config/tool-presets',
  // Sign-in without UI, several accounts and rotation (D3)
  'GET /api/accounts',
  'POST /api/accounts',
  'POST /api/accounts/refresh',
  'POST /api/accounts/:id/refresh',
  'POST /api/accounts/:id/login',
  'GET /api/accounts/logins/:id',
  'POST /api/accounts/logins/:id/code',
  'DELETE /api/accounts/logins/:id',
  'DELETE /api/accounts/:id',
  'GET /api/accounts/settings',
  'PUT /api/accounts/settings',
  'GET /api/accounts/policies',
  'POST /api/accounts/policies',
  'PUT /api/accounts/policies/:id',
  'DELETE /api/accounts/policies/:id',
  // The guard as far as the token needs it: its mode, and replacing a token (the first-run one included)
  'GET /api/security/auth',
  'POST /api/security/token',
  // The OpenAPI document and its reference, which describe only what is served
  'GET /openapi.json',
]);

/** Whole subtrees: the OpenAI-compatible surface (D8) and the API reference's own assets */
const HEADLESS_PREFIXES = ['/api/v1/', '/docs'];

const NOT_FOUND = { error: 'route not found' } as const;

/** Whether a headless Claudio serves this route, named as Fastify registered it */
export function servedInHeadless(method: string, url: string): boolean {
  // CORS answers its preflights on a route of its own, and they reveal nothing
  if (method === 'OPTIONS') return true;
  // Fastify adds a HEAD beside every GET, which runs the GET's handler: it is served only with it
  const as = method === 'HEAD' ? 'GET' : method;
  return HEADLESS_ROUTES.has(`${as} ${url}`) || HEADLESS_PREFIXES.some((prefix) => url === prefix || url.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
}

/**
 * Turns every route outside the allowlist into a hidden `404`, at `onRoute`, before its plugin's own
 * handler, hooks or body parser can run: an `onRequest` of the route's own answers first. Registered
 * before any route, so nothing slips past it. A route with several methods is hidden whole when any
 * of them is not served; Claudio registers none like that.
 */
export function enforceHeadless(app: FastifyInstance): void {
  app.addHook('onRoute', (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (methods.every((method) => servedInHeadless(method, route.url))) return;
    const hidden = async (): Promise<typeof NOT_FOUND> => NOT_FOUND;
    route.handler = hidden;
    route.onRequest = [async (_req, reply) => reply.status(404).send(NOT_FOUND)];
    route.preParsing = undefined;
    route.preValidation = undefined;
    route.preHandler = undefined;
    route.schema = { hide: true };
    // A socket route without its plugin is a plain GET, and this one answers 404 like the rest
    delete (route as { websocket?: unknown }).websocket;
    delete (route as { wsHandler?: unknown }).wsHandler;
  });
}

/** What an unregistered path answers in headless: the same body as a hidden route */
export function headlessNotFound(app: FastifyInstance): void {
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(NOT_FOUND));
}
