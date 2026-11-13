import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { decisionPoint, DECISION_POINTS, labelsFromOutcomes, parseQuestions, redactState, ReplayRunner, type Core } from '@claudio/core';
import type {
  DecisionCredentialsResult,
  DecisionFeedback,
  DecisionLabel,
  DecisionLabelImportResult,
  DecisionLabelOutcomesResult,
  DecisionReplayList,
  DecisionReplayRequest,
  DecisionReplayStarted,
  DecisionNotificationOpenedResult,
  DecisionPageQuery,
  DecisionPaletteResult,
  DecisionPointId,
  DecisionPreview,
  DecisionProviderId,
  DecisionSubjectKind,
} from '@claudio/shared';

/**
 * The decision engine over HTTP: its settings and its Jev key, what each point would send and the
 * person's consent to it, the history, and the palette's one live call. Validation lives in core.
 * The routes that widen what leaves the machine are refused to a chat's token in `security.ts`.
 */

/** Said on every write of the key (D12): the general notice, before any point's own preview */
const PRIVACY_NOTICE =
  'A decision point set to Jev sends a redacted summary of its state (titles, descriptions, short excerpts) to TypeSafe, which runs the model. Nothing is sent until you consent to that point after previewing what it sends, and secrets are masked before anything leaves this machine.';

const SUBJECT_KINDS: readonly DecisionSubjectKind[] = ['work_item', 'change_request', 'flow_run', 'task', 'chat', 'memory_proposal', 'assistant_run', 'notification', 'palette', 'tracker_issue', 'model'];

const DEFAULT_STATS_DAYS = 30;
const DAY_MS = 86_400_000;

const fail = (status: number, message: string): Error => Object.assign(new Error(message), { statusCode: status });

function pointOf(id: string): DecisionPointId {
  const found = DECISION_POINTS.find((p) => p.id === id);
  if (!found) throw fail(404, `decision point ${id} not found`);
  return found.id;
}

const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | undefined => {
  if (value === undefined || value === '') return undefined;
  const found = allowed.find((a) => a === value);
  if (!found) throw fail(400, `${name} must be one of ${allowed.join(', ')}`);
  return found;
};

const isoOf = (value: string | undefined, name: string): string | undefined => {
  if (value === undefined || value === '') return undefined;
  if (Number.isNaN(Date.parse(value))) throw fail(400, `${name} must be an ISO timestamp`);
  return value;
};

type FilterQuery = Record<string, string | undefined>;

function filterOf(query: FilterQuery): Omit<DecisionPageQuery, 'cursor' | 'limit'> {
  const point = query.point === undefined || query.point === '' ? undefined : pointOf(query.point);
  const provider = oneOf<DecisionProviderId>(query.provider, ['cli', 'jev'], 'provider');
  const mode = oneOf(query.mode, ['shadow', 'active'] as const, 'mode');
  const status = oneOf(query.status, ['answered', 'unavailable'] as const, 'status');
  const since = isoOf(query.since, 'since');
  const until = isoOf(query.until, 'until');
  const subjectKind = oneOf<DecisionSubjectKind>(query.subjectKind, SUBJECT_KINDS, 'subjectKind');
  return {
    ...(point ? { point } : {}),
    ...(subjectKind ? { subjectKind } : {}),
    ...(query.subjectId ? { subjectId: query.subjectId } : {}),
    ...(query.visible === 'true' || query.visible === '1' ? { visible: true } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(provider ? { provider } : {}),
    ...(mode ? { mode } : {}),
    ...(status ? { status } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  };
}

export const decisionRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  const credentials = (): DecisionCredentialsResult => ({ ...core.decisionCredentials.status(), notice: PRIVACY_NOTICE });

  app.get('/decisions/settings', () => core.decisionSettings.get());
  app.put<{ Body: unknown }>('/decisions/settings', (req) => core.decisionSettings.set(req.body));

  app.put<{ Body: unknown }>('/decisions/credentials', async (req) => {
    await core.decisionCredentials.set(req.body);
    return credentials();
  });
  app.delete('/decisions/credentials', () => {
    core.decisionCredentials.clear();
    return credentials();
  });

  app.post<{ Body: { provider?: unknown } | undefined }>('/decisions/test', (req) => {
    const provider = oneOf<DecisionProviderId>(typeof req.body?.provider === 'string' ? req.body.provider : undefined, ['cli', 'jev'], 'provider');
    if (!provider) throw fail(400, 'provider must be one of cli, jev');
    return core.decisions.test(provider);
  });

  app.get<{ Querystring: { projectId?: string } }>('/decisions/points', (req) => core.decisions.catalogue(req.query.projectId || null));

  app.get<{ Params: { point: string }; Querystring: { projectId?: string } }>('/decisions/points/:point/preview', async (req): Promise<DecisionPreview> => {
    const id = pointOf(req.params.point);
    const def = decisionPoint(id);
    if (!def) throw fail(404, `decision point ${id} not found`);
    const provider = core.decisions.effective(id, req.query.projectId || null).provider;
    const last = core.decisions.lastState(id);
    if (last) return { point: id, provider: last.provider, stateVersion: def.stateVersion, source: 'last', state: last.state, bytes: last.bytes };
    // Nothing was sent yet: show what the point may carry, field by field, without asking anything
    const data = Object.fromEntries(def.fields.map((field) => [field, null]));
    const built = await core.decisions.previewState(id, { kind: 'palette', id: null, data });
    if (!built) throw fail(404, `decision point ${id} not found`);
    return { point: id, provider, stateVersion: def.stateVersion, source: 'built', state: built.state, bytes: built.bytes };
  });

  app.put<{ Params: { point: string }; Body: { granted?: unknown; stateVersion?: unknown; providers?: unknown } | undefined }>(
    '/decisions/points/:point/consent',
    async (req) => {
      const id = pointOf(req.params.point);
      const body = req.body;
      if (typeof body?.granted !== 'boolean') throw new Error('granted must be true or false');
      if (typeof body.stateVersion !== 'number' || !Number.isInteger(body.stateVersion)) throw new Error('stateVersion must be a whole number');
      if (!Array.isArray(body.providers) || !body.providers.every((p): p is DecisionProviderId => p === 'cli' || p === 'jev')) {
        throw new Error('providers must be a list of cli or jev');
      }
      // Consent is to what was previewed: a state that changed since is a new question
      const current = decisionPoint(id)?.stateVersion;
      if (body.granted && body.stateVersion !== current) throw fail(409, `the state of ${id} is now version ${current}: preview it again before consenting`);
      return core.decisionSettings.setConsent(id, { granted: body.granted, stateVersion: body.stateVersion, providers: body.providers });
    },
  );

  app.get<{ Querystring: FilterQuery & { cursor?: string; limit?: string } }>('/decisions', (req) => {
    const limit = req.query.limit === undefined || req.query.limit === '' ? undefined : Number(req.query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw fail(400, 'limit must be a whole number from 1');
    return core.db.listDecisions({ ...filterOf(req.query), ...(req.query.cursor ? { cursor: req.query.cursor } : {}), ...(limit ? { limit } : {}) });
  });

  app.delete<{ Querystring: FilterQuery }>('/decisions', (req) => ({ deleted: core.db.clearDecisions(filterOf(req.query)) }));

  app.get<{ Querystring: { since?: string; days?: string } }>('/decisions/stats', (req) => {
    const since = isoOf(req.query.since, 'since');
    const days = req.query.days === undefined || req.query.days === '' ? DEFAULT_STATS_DAYS : Number(req.query.days);
    if (!since && (!Number.isFinite(days) || days <= 0)) throw fail(400, 'days must be a number above 0');
    return core.decisions.stats(since ?? new Date(Date.now() - days * DAY_MS).toISOString());
  });

  app.post<{ Body: { query?: unknown; commands?: unknown } | undefined }>('/decisions/palette', async (req): Promise<DecisionPaletteResult> => {
    const { query, commands } = req.body ?? {};
    if (typeof query !== 'string' || query.trim() === '') throw new Error('query must be a non-empty string');
    if (!Array.isArray(commands) || !commands.every((c): c is { id: string; title: string } => typeof c?.id === 'string' && typeof c?.title === 'string')) {
      throw new Error('commands must be a list of { id, title }');
    }
    const outcome = await core.decisions.ask('palette.intent', { kind: 'palette', id: null, data: { query, commands } }, { projectId: null });
    const answer = outcome.act ? outcome.answers?.command : undefined;
    const value = answer?.kind === 'choice' ? answer.value : null;
    // `none` and an id the caller never listed both mean "no command": the palette falls back on its own search
    const commandId = value !== null && commands.some((c) => c.id === value) ? value : null;
    return { commandId, confidence: commandId ? (answer?.confidence ?? null) : null, decisionId: outcome.decisionId };
  });

  app.post<{ Body: { key?: unknown } | undefined }>('/decisions/notification-opened', (req): DecisionNotificationOpenedResult => {
    const key = req.body?.key;
    if (typeof key !== 'string' || key === '') throw new Error('key must be a non-empty string');
    return { decisionId: core.reportNotificationOpened(key) };
  });

  app.get<{ Params: { id: string } }>('/decisions/:id', (req) => {
    const found = core.db.decision(req.params.id);
    if (!found) throw fail(404, `decision ${req.params.id} not found`);
    return found;
  });

  app.post<{ Params: { id: string }; Body: { feedback?: unknown } | undefined }>('/decisions/:id/feedback', (req) => {
    const feedback = req.body?.feedback;
    if (feedback !== 'useful' && feedback !== 'not_useful') throw new Error('feedback must be useful or not_useful');
    if (!core.db.setDecisionFeedback(req.params.id, feedback satisfies DecisionFeedback, new Date().toISOString())) {
      throw fail(404, `decision ${req.params.id} not found`);
    }
    return core.db.decision(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: { commandId?: unknown } | undefined }>('/decisions/:id/palette-action', (req) => {
    const commandId = req.body?.commandId;
    if (commandId !== null && typeof commandId !== 'string') throw new Error('commandId must be a string or null');
    const found = core.reportPaletteAction(req.params.id, commandId);
    if (!found) throw fail(404, `decision ${req.params.id} not found`);
    return found;
  });

  app.delete<{ Params: { id: string } }>('/decisions/:id', (req) => {
    if (!core.db.deleteDecision(req.params.id)) throw fail(404, `decision ${req.params.id} not found`);
    return { ok: true };
  });

  // ---- The golden set and replays (docs/plans/decision-engine-v2.md, M5). Writes are a person's.

  const labelFields = (note: unknown): string | null => {
    if (note === undefined || note === null) return null;
    if (typeof note !== 'string' || note.length > 500) throw new Error('note must be a string of at most 500 characters');
    return note.trim() === '' ? null : note;
  };

  app.get<{ Querystring: { point?: string } }>('/decisions/labels', (req): DecisionLabel[] => {
    const point = req.query.point === undefined || req.query.point === '' ? undefined : pointOf(req.query.point);
    return core.db.decisionLabels(point);
  });

  app.post<{ Body: { decisionId?: unknown; positive?: unknown; note?: unknown } | undefined }>('/decisions/labels', (req): DecisionLabel => {
    const { decisionId, positive, note } = req.body ?? {};
    if (typeof decisionId !== 'string' || decisionId === '') throw new Error('decisionId must be a decision id');
    if (typeof positive !== 'boolean') throw new Error('positive must be true or false');
    const text = labelFields(note);
    const row = core.db.decision(decisionId);
    if (!row) throw fail(404, `decision ${decisionId} not found`);
    // The row's state was redacted when it was stored; the label keeps exactly that
    core.db.saveDecisionLabel({ id: randomUUID(), point: row.point, decisionId: row.id, state: row.state, questions: row.questions, positive, answers: null, source: 'person', note: text, at: new Date().toISOString() });
    const saved = core.db.decisionLabels(row.point).find((l) => l.decisionId === row.id);
    if (!saved) throw fail(500, 'the label was not saved');
    return saved;
  });

  app.delete<{ Params: { id: string } }>('/decisions/labels/:id', (req) => {
    if (!core.db.deleteDecisionLabel(req.params.id)) throw fail(404, `label ${req.params.id} not found`);
    return { ok: true };
  });

  const MAX_IMPORT = 500;
  app.post<{ Body: { labels?: unknown } | undefined }>('/decisions/labels/import', (req): DecisionLabelImportResult => {
    const labels = req.body?.labels;
    if (!Array.isArray(labels) || labels.length === 0 || labels.length > MAX_IMPORT) throw new Error(`labels must be a list of 1 to ${MAX_IMPORT} items`);
    // Validated whole before anything is written: a set is imported entirely or not at all
    const parsed: Array<Omit<DecisionLabel, 'id' | 'at'>> = (labels as unknown[]).map((item, i) => {
      const entry = typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
      if (!entry) throw new Error(`labels[${i}] must be an object`);
      const id = typeof entry.point === 'string' ? pointOf(entry.point) : null;
      const def = id ? decisionPoint(id) : undefined;
      if (!id || !def) throw new Error(`labels[${i}].point must be a decision point`);
      if (typeof entry.state !== 'object' || entry.state === null || Array.isArray(entry.state)) throw new Error(`labels[${i}].state must be an object`);
      const questions = parseQuestions(entry.questions);
      if (!questions) throw new Error(`labels[${i}].questions must be valid questions with unique ids`);
      if (typeof entry.positive !== 'boolean') throw new Error(`labels[${i}].positive must be true or false`);
      // A set built outside was never redacted: it is held to the point's own limits and masks before it is stored
      return { point: id, decisionId: null, state: redactState(entry.state as Record<string, unknown>, def.maxStateBytes), questions, positive: entry.positive, answers: null, source: 'person', note: labelFields(entry.note) };
    });
    const at = new Date().toISOString();
    for (const label of parsed) core.db.saveDecisionLabel({ ...label, id: randomUUID(), at });
    return { imported: parsed.length };
  });

  app.post<{ Body: { point?: unknown; days?: unknown } | undefined }>('/decisions/labels/outcomes', (req): DecisionLabelOutcomesResult => {
    const { point, days } = req.body ?? {};
    if (typeof point !== 'string') throw new Error('point must be a decision point id');
    const id = pointOf(point);
    const window = days === undefined ? DEFAULT_STATS_DAYS : days;
    if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) throw new Error('days must be a number above 0');
    return labelsFromOutcomes(core.db, id, { since: new Date(Date.now() - window * DAY_MS).toISOString() });
  });

  const replays = new ReplayRunner({ db: core.db, engine: core.decisions, settings: core.decisionSettings });
  app.addHook('onClose', () => {
    replays.stop();
  });

  app.post<{ Body: Record<string, unknown> | undefined }>('/decisions/replays', (req): DecisionReplayStarted => {
    const body = req.body ?? {};
    if (typeof body.point !== 'string') throw new Error('point must be a decision point id');
    const request: DecisionReplayRequest = { point: pointOf(body.point) };
    const provider = oneOf<DecisionProviderId>(typeof body.provider === 'string' ? body.provider : undefined, ['cli', 'jev'], 'provider');
    if (body.provider !== undefined && typeof body.provider !== 'string') throw new Error('provider must be one of cli, jev');
    if (provider) request.provider = provider;
    if (body.questions !== undefined) {
      const questions = parseQuestions(body.questions);
      if (!questions) throw new Error('questions must be valid questions with unique ids');
      request.questions = questions;
    }
    if (body.limit !== undefined) {
      if (typeof body.limit !== 'number') throw new Error('limit must be a whole number');
      request.limit = body.limit;
    }
    if (body.concurrency !== undefined) {
      if (typeof body.concurrency !== 'number') throw new Error('concurrency must be a whole number');
      request.concurrency = body.concurrency;
    }
    if (body.note !== undefined) {
      const note = labelFields(body.note);
      if (note) request.note = note;
    }
    return replays.start(request);
  });

  app.get<{ Querystring: { point?: string } }>('/decisions/replays', (req): DecisionReplayList => {
    const point = req.query.point === undefined || req.query.point === '' ? undefined : pointOf(req.query.point);
    return { items: core.db.decisionReplays(point), ...replays.state() };
  });
};
