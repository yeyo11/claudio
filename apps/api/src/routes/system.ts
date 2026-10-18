import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@claudio/core';
import type { SetCredentialsRequest, SystemSample } from '@claudio/shared';
import { refuseNonOwner, sendRefusal } from './server-update.ts';

const positive = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
};

const moment = (value: string | undefined, name: string): string | undefined => {
  if (!value) return undefined;
  if (Number.isNaN(Date.parse(value))) throw new Error(`${name} must be a date (ISO 8601)`);
  return new Date(value).toISOString();
};

export const systemRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  // The only route reachable with no credential: it reports the last state observed and never goes
  // and measures, or a burst against it becomes a burst of `claude` processes. The authenticated
  // routes, which do measure, are what keeps that reading fresh.
  app.get('/health', () => {
    const { cli, loggedIn } = core.claudeHealth();
    return { ok: cli && loggedIn, cli, loggedIn };
  });

  app.get<{ Querystring: { refresh?: string } }>('/system', (req) => core.system(req.query.refresh === '1'));

  // Reading is free; the registry is only asked by the POST (and once a day by the server itself)
  app.get('/system/cli-version', () => core.cliVersionInfo());
  app.post('/system/cli-version/check', () => core.checkCliVersion());
  // The same for Claudio itself, against its GitHub releases
  app.get('/system/release', () => core.releaseInfo());
  app.post('/system/release/check', () => core.checkRelease());
  // Claude Code installed in-app inside the container, under /data/cli (docs/plans/container-polish.md, D4): the owner's alone
  app.post<{ Body: { version?: string } }>('/system/cli-version/install', async (req, reply) => {
    if (refuseNonOwner(core, req, reply, 'cli')) return reply;
    const version = (req.body as { version?: unknown } | undefined)?.version;
    if (version !== undefined && typeof version !== 'string') throw new Error('version must be a string');
    try {
      core.cliInstaller.install(version);
    } catch (err) {
      return sendRefusal(reply, err);
    }
    return reply.status(202).send(await core.cliVersionInfo());
  });
  app.delete('/system/cli-version/install', async (req, reply) => {
    if (refuseNonOwner(core, req, reply, 'cli')) return reply;
    try {
      await core.cliInstaller.uninstall();
    } catch (err) {
      return sendRefusal(reply, err);
    }
    return core.cliVersionInfo();
  });

  // Whether the folders that hold the state would survive replacing the container (Docker only)
  app.get('/system/storage', () => core.storageInfo());

  // What the machine is doing and whether it admits a chat: the same reading the admission takes
  app.get('/system/load', () => core.systemLoad());
  // What each live chat's process tree uses; a rate, not a reading, is the difference between two of these
  app.get('/system/processes', () => core.processUsage());

  // The sampler's stored readings, for the Machine page's charts: a stream, so rows in SQLite
  app.get<{ Querystring: { since?: string; until?: string; limit?: string; bucket?: string } }>('/system/history', (req): SystemSample[] => {
    const { since, until, limit, bucket } = req.query;
    const from = moment(since, 'since');
    const to = moment(until, 'until');
    const max = positive(limit, 'limit');
    const seconds = positive(bucket, 'bucket');
    return core.systemHistory({ ...(from ? { since: from } : {}), ...(to ? { until: to } : {}), ...(max ? { limit: max } : {}), ...(seconds ? { bucketSeconds: seconds } : {}) });
  });

  app.get('/overview', () => core.overview());

  // Account credentials. The token itself is never returned by any endpoint.
  app.get('/auth', async () => (await core.system(true)).auth);
  app.put<{ Body: SetCredentialsRequest }>('/auth/credentials', async (req) => (await core.setCredentials(req.body ?? {})).auth);
  app.delete('/auth/credentials', async () => (await core.clearCredentials()).auth);
  app.post('/auth/verify', () => core.verifyAuth());
};
