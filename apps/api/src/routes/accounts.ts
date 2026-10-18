import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@claudio/core';
import type {
  Account,
  AccountLoginSession,
  AccountsRefreshResult,
  AccountsSettings,
  ModelFallback,
  ModelFallbackSuggestion,
  ModelOption,
  RotationEvent,
  RotationPolicy,
  RotationPolicyRequest,
  UsageHistoryPoint,
} from '@claudio/shared';
import { DEFAULT_ID } from '@claudio/accounts';
import { AccountLogins } from '../account-logins.ts';

/**
 * The Claude accounts (docs/plans/claude-only-fork.md, section 2): who they are, the usage each
 * reported, the sign-in of a `login` account, and the settings and policies that decide when work
 * moves to another. Validation lives in `@claudio/accounts`. A token or key travels in the body of
 * `POST /accounts/token` only and is never answered back or logged; every write is refused to a
 * chat's token in `security.ts`.
 */

const TIER_RANK = { fast: 0, balanced: 1, strong: 2 } as const;
const LINES = ['opus', 'sonnet', 'haiku', 'fable'];

/** The model line a name belongs to (`opus` for `claude-opus-5-5`), where it names one. */
const lineOf = (option: Pick<ModelOption, 'value' | 'resolvedModel' | 'ids'>): string | null => {
  const names = [option.value, option.resolvedModel, ...(option.ids ?? [])].map((n) => (n ?? '').toLowerCase());
  return LINES.find((line) => names.some((n) => n.includes(line))) ?? null;
};

/**
 * The models a fallback may map to: the same line first, then the tier below it (nearest first).
 * A higher tier is never offered, and neither is a model the CLI lists but cannot run.
 */
export function fallbackCandidates(model: ModelOption | null, wanted: string, offered: ModelOption[]): ModelOption[] {
  const line = model ? lineOf(model) : lineOf({ value: wanted });
  const rank = model?.tier ? TIER_RANK[model.tier] : null;
  const usable = offered.filter((o) => !o.disabled && o.value !== 'default' && o.value !== wanted && o.resolvedModel !== wanted);
  const sameLine = usable.filter((o) => line !== null && lineOf(o) === line);
  const below = usable
    .filter((o) => !sameLine.includes(o) && o.tier !== undefined && rank !== null && TIER_RANK[o.tier] < rank)
    .sort((a, b) => TIER_RANK[b.tier ?? 'fast'] - TIER_RANK[a.tier ?? 'fast']);
  return [...sameLine, ...below];
}

const WINDOWS:ReadonlyArray<UsageHistoryPoint['window']> = ['five_hour', 'seven_day'];

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
  const logins = new AccountLogins(core.accounts, core.config.claudeBin, (accountId) => (accountId === DEFAULT_ID ? core.defaultSignedIn() : Promise.resolve()));
  app.addHook('onClose', async () => logins.close());

  // The terminal's `claudio-accounts` shares the data dir and may have written since the last read
  app.get('/accounts', (): Account[] => {
    core.accounts.reload();
    // The CLI's own login is left out while it has no credential at all: an empty ghost beside the real accounts
    return core.accounts.listed();
  });

  app.post<{ Body: unknown }>('/accounts', async (req, reply): Promise<AccountLoginSession> => {
    const b = req.body === undefined || req.body === null ? {} : body(req.body);
    const alias = optionalString(b.alias, 'alias');
    const email = optionalString(b.email, 'email');
    const session = await logins.start({ ...(alias ? { alias } : {}), ...(email ? { email } : {}) });
    void reply.status(201);
    return session;
  });

  // Reads the CLI itself (`get_usage`, no turn, no tokens), one account at a time, each with its own timeout
  app.post('/accounts/refresh', (): Promise<AccountsRefreshResult> => core.refreshAccountUsage());

  app.post<{ Params: { id: string } }>('/accounts/:id/refresh', async (req, reply): Promise<Account | { error: string; code: string }> => {
    core.accounts.reload();
    core.accounts.get(req.params.id); // 404 before the CLI is asked anything
    const { accounts, failed } = await core.refreshAccountUsage([req.params.id]);
    const error = failed[0]?.error;
    // The CLI could not answer at all (no network, a timeout): the account is left as it was. A client acts on the code
    if (error) return reply.status(502).send({ error: `the CLI could not read the usage of ${req.params.id}: ${error}`, code: 'accounts.check-failed' });
    const account = accounts.find((a) => a.id === req.params.id);
    if (!account) throw new Error(`account ${req.params.id} not found`);
    return account;
  });

  app.post<{ Params: { id: string } }>('/accounts/:id/login', async (req, reply): Promise<AccountLoginSession> => {
    const session = await logins.restart(req.params.id);
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

  app.get('/accounts/model-fallbacks', (): ModelFallback[] => core.modelFallbacks.list());

  app.put<{ Body: unknown }>('/accounts/model-fallbacks', (req): Promise<ModelFallback[]> => core.modelFallbacks.set(req.body));

  app.post<{ Body: unknown }>('/accounts/model-fallbacks/suggest', async (req): Promise<ModelFallbackSuggestion> => {
    const model = body(req.body).model;
    if (typeof model !== 'string' || model.trim() === '') throw new Error('model must be a non-empty string');
    await core.accounts.warmModels();
    const ready = core.accounts.list().filter((a) => a.enabled && a.signedIn);
    const listed = ready.flatMap((a) => core.accounts.cachedModels(a.id) ?? []);
    // Only the models the accounts with headroom offer can be a target, and each once
    const offered = [...new Map(listed.map((o) => [o.value, o])).values()];
    const own = listed.find((o) => o.value === model || o.resolvedModel === model || o.ids?.includes(model)) ?? null;
    const candidates = fallbackCandidates(own, model, offered);
    const base: ModelFallbackSuggestion = { model, candidates, suggestion: null, confidence: null, decisionId: null };
    if (candidates.length === 0) return base;
    const outcome = await core.decisions.ask(
      'account.model-fallback',
      { kind: 'model', id: model, data: { model, candidates: candidates.map((c) => ({ id: c.value, displayName: c.label ?? c.value, tier: c.tier ?? '' })) } },
      { projectId: null },
    );
    const answer = outcome.act ? outcome.answers?.model : undefined;
    const value = answer?.kind === 'choice' ? answer.value : null;
    // `none` and a value the caller never listed both mean "no suggestion": the chat waits
    const suggestion = value !== null && candidates.some((c) => c.value === value) ? value : null;
    return { ...base, suggestion, confidence: suggestion ? (answer?.confidence ?? null) : null, decisionId: outcome.decisionId };
  });

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

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/accounts/:id/models', (req): Promise<ModelOption[]> => {
    core.accounts.get(req.params.id); // 404 before the CLI is asked anything
    return core.accounts.models(req.params.id, { refresh: req.query.refresh === 'true' || req.query.refresh === '1' });
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
