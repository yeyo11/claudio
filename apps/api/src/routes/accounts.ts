import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type {
  Account,
  AccountLoginSession,
  AccountsSettings,
  RotationEvent,
  RotationPolicy,
  RotationPolicyRequest,
  UsageHistoryPoint,
} from '@agentry/shared';
import { AccountLogins } from '../account-logins.ts';

/**
 * The Claude accounts (docs/plans/claude-only-fork.md, section 2): who they are, the usage each
 * reported, the sign-in of a `login` account, and the settings and policies that decide when work
 * moves to another. Validation lives in `@agentry/accounts`. A token or key travels in the body of
 * `POST /accounts/token` only and is never answered back or logged; every write is refused to a
 * chat's token in `security.ts`.
 */

const WINDOWS: ReadonlyArray<UsageHistoryPoint['window']> = ['five_hour', 'seven_day'];

const body = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('the body must be a JSON object');
  return value as Record<string, unknown>;
};

const optionalString = (value: unknown, name: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
};

const count = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
};

const moment = (value: string | undefined, name: string): string | undefined => {
  if (!value) return undefined;
  if (Number.isNaN(Date.parse(value))) throw new Error(`${name} must be a date (ISO 8601)`);
  return value;
};

export const accountRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  const logins = new AccountLogins(core.accounts, core.config.claudeBin);
  app.addHook('onClose', async () => logins.close());

  // The terminal's `claudio-accounts` shares the data dir and may have written since the last read
  app.get('/accounts', (): Account[] => {
    core.accounts.reload();
    return core.accounts.list();
  });

  app.post<{ Body: unknown }>('/accounts', async (req, reply): Promise<AccountLoginSession> => {
    const b = req.body === undefined || req.body === null ? {} : body(req.body);
    const alias = optionalString(b.alias, 'alias');
    const email = optionalString(b.email, 'email');
    const session = await logins.start({ ...(alias ? { alias } : {}), ...(email ? { email } : {}) });
    void reply.status(201);
    return session;
  });

  app.post<{ Body: unknown }>('/accounts/token', async (req, reply): Promise<Account> => {
    const b = body(req.body);
    if (b.kind !== 'token' && b.kind !== 'api-key') throw new Error('kind must be token or api-key');
    if (typeof b.secret !== 'string') throw new Error('secret must be a string');
    const account = await core.accounts.add({ kind: b.kind, alias: optionalString(b.alias, 'alias') ?? null, secret: b.secret });
    void reply.status(201);
    return account;
  });

  app.get<{ Params: { id: string } }>('/accounts/logins/:id', (req): AccountLoginSession => logins.get(req.params.id));

  app.post<{ Params: { id: string }; Body: unknown }>('/accounts/logins/:id/code', (req): AccountLoginSession =>
    logins.submitCode(req.params.id, body(req.body).code),
  );

  app.delete<{ Params: { id: string } }>('/accounts/logins/:id', (req): AccountLoginSession => logins.cancel(req.params.id));

  app.get('/accounts/settings', (): AccountsSettings => {
    core.accounts.reload();
    return core.accounts.settings();
  });

  app.put<{ Body: unknown }>('/accounts/settings', (req): Promise<AccountsSettings> => core.accounts.setSettings(body(req.body) as Partial<AccountsSettings>));

  app.get('/accounts/policies', (): RotationPolicy[] => {
    core.accounts.reload();
    return core.accounts.policies();
  });

  app.post<{ Body: unknown }>('/accounts/policies', async (req, reply): Promise<RotationPolicy> => {
    const policy = await core.accounts.createPolicy(body(req.body) as unknown as RotationPolicyRequest);
    void reply.status(201);
    return policy;
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/accounts/policies/:id', (req): Promise<RotationPolicy> =>
    core.accounts.updatePolicy(req.params.id, body(req.body) as unknown as RotationPolicyRequest),
  );

  app.delete<{ Params: { id: string } }>('/accounts/policies/:id', async (req): Promise<{ deleted: true }> => {
    await core.accounts.deletePolicy(req.params.id);
    return { deleted: true };
  });

  app.get<{ Querystring: { account?: string; window?: string; since?: string; until?: string; limit?: string } }>('/accounts/usage-history', (req): UsageHistoryPoint[] => {
    const { account, window, since, until, limit } = req.query;
    const wanted = window ? WINDOWS.find((w) => w === window) : undefined;
    if (window && !wanted) throw new Error(`window must be one of ${WINDOWS.join(', ')}`);
    const from = moment(since, 'since');
    const to = moment(until, 'until');
    const max = count(limit, 'limit');
    return core.db.usageHistory({ ...(account ? { account } : {}), ...(wanted ? { window: wanted } : {}), ...(from ? { since: from } : {}), ...(to ? { until: to } : {}), ...(max ? { limit: max } : {}) });
  });

  app.get<{ Querystring: { limit?: string; since?: string } }>('/accounts/events', (req): RotationEvent[] => {
    const max = count(req.query.limit, 'limit');
    const since = moment(req.query.since, 'since');
    return core.db.rotationEvents({ ...(max ? { limit: max } : {}), ...(since ? { since } : {}) });
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/accounts/:id', async (req): Promise<Account> => {
    const b = body(req.body);
    const { id } = req.params;
    core.accounts.get(id); // 404 before anything changes
    if (b.alias !== undefined && b.alias !== null && typeof b.alias !== 'string') throw new Error('alias must be a string or null');
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    if (b.alias === undefined && b.enabled === undefined) throw new Error('give alias or enabled');
    let account = core.accounts.get(id);
    if (b.alias !== undefined) account = await core.accounts.setAlias(id, b.alias);
    if (b.enabled !== undefined) account = await core.accounts.setEnabled(id, b.enabled);
    return account;
  });

  app.delete<{ Params: { id: string } }>('/accounts/:id', async (req): Promise<{ deleted: true }> => {
    await core.accounts.remove(req.params.id);
    return { deleted: true };
  });
};
