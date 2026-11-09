import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import type { FastifyInstance } from 'fastify';
import { routeSchema, TAGS } from './routes.ts';
// Imported rather than read from disk so the document survives bundling into a single file
import schemas from './schemas.json' with { type: 'json' };

const API_PREFIX = '/api';

/**
 * OpenAPI 3.1 document + Scalar reference UI. Must be registered before the routes so the
 * `onRoute` hook can attach each route's documentation (see routes.ts).
 *   /docs          interactive API reference
 *   /openapi.json  the raw document
 */
export async function registerOpenApi(app: FastifyInstance, version: string): Promise<void> {
  // Route schemas are documentation only. Input validation lives in @claudio/core (single source of
  // truth for error messages) and responses must never be stripped down to the documented fields.
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Claudio API',
        version,
        description:
          'REST + SSE API over the Claude Code CLI: runs, sessions, orchestration, plugins, memory and every ' +
          'piece of user or project configuration.\n\nErrors are `{ "error": "…" }` with a 4xx status.\n\n' +
          'Authentication is off by default (`mode: none`), which is what a local install wants. With `token` ' +
          'or `oidc` (see the Security tag) every route needs `Authorization: Bearer …` except `GET /api/health`; ' +
          'Claudio never terminates TLS itself, so put a reverse proxy in front before exposing the port.\n\n' +
          'With a daily spend cap set (`dailySpendCapUsd`), the routes that start work on a person\'s say-so answer ' +
          '`409 { error, code: "spend-cap", spend }` once the day\'s spend reaches it. A request carrying ' +
          '`X-Claudio-Spend-Override: 1` goes on, and on a route that starts or resumes a graph it gives that graph today\'s pass. ' +
          'A request authenticated by a chat\'s token cannot override: the header is ignored and the 409 stands.',
      },
      servers: [{ url: '/', description: 'This wrapper' }],
      tags: TAGS,
    },
    // The component schemas join the finished document as they are, rather than through
    // `openapi.components`: the plugin resolves each component there against all the others, which
    // with ~1,000 of them took 10 s of CPU on a fast machine and over 30 s on a loaded one, blocking
    // the event loop on the first GET of /openapi.json. They need no resolving: ts-json-schema-generator
    // already wrote them as OpenAPI 3.1 components whose $refs point at each other, and route-level
    // $refs point at them too.
    transformObject: (document) => {
      if (!('openapiObject' in document)) return document.swaggerObject;
      const { openapiObject } = document;
      // The plugin's own components (schemas nested in a route schema) come after the generated ones
      const own: object = openapiObject.components?.schemas ?? {};
      // `never` as for `configuration` below: the 3.0, 3.1 and 3.2 document types the plugin declares
      // do not unify, and this is the 3.1 document it built with the generated schemas added
      return { ...openapiObject, components: { ...openapiObject.components, schemas: { ...schemas, ...own } } } as never;
    },
    refResolver: { buildLocalReference: (json, _base, _fragment, i) => (typeof json.$id === 'string' ? json.$id : `def-${i}`) },
  });

  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith(`${API_PREFIX}/`)) return;
    const path = route.url.slice(API_PREFIX.length);
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      const schema = routeSchema(method, path);
      if (schema) route.schema = { ...schema, ...route.schema };
    }
  });

  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  // The Fastify plugin types only cover part of Scalar's configuration; the object is handed to
  // the reference client as is, so the remaining options are valid at runtime.
  const configuration = {
    url: '/openapi.json',
    theme: 'default',
    layout: 'modern',
    metaData: { title: 'Claudio API' },
    hideClientButton: true,
    // Self-hosted and private: no Scalar cloud features, no telemetry
    showToolbar: 'never',
    showDeveloperTools: 'never',
    telemetry: false,
    mcp: { disabled: true },
    agent: { disabled: true },
  };
  await app.register(scalar, { routePrefix: '/docs', configuration: configuration as never });
}
