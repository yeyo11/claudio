import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { assistantLanguage, EvalFileError, EvalStartError, type Core } from '@claudio/core';
import { EVAL_PRESSURES, EVAL_VARIANTS, type EvalPressure, type EvalRunRequest, type Effort, type EvalVariant, type PutEvalFileRequest } from '@claudio/shared';
import { spendGate } from './spend.ts';

/** Per page of the history; the plan's bound. */
const HISTORY_MAX = 50;

const FILE_STATUS = { 'invalid-name': 400, 'too-large': 413, invalid: 400, 'unsupported-version': 400, 'changed-on-disk': 409, 'not-found': 404 } as const;

const START_STATUS = {
  'not-git': 422,
  'no-commit': 422,
  'pin-missing': 422,
  'target-missing': 422,
  'lanes-root-contaminated': 422,
  'user-scope-variant': 422,
  'proposed-required': 400,
  'proposed-too-large': 413,
  'unknown-case': 400,
  'no-variants': 400,
  'ceiling-raised': 400,
  'variant-not-in-run': 400,
  'consent-required': 412,
  'eval-running': 409,
  'cost-not-confirmed': 409,
  'not-resumable': 409,
  'team-off': 409,
} as const;

/** The code a client sees where the plan names it differently from core's. */
const START_CODE: Partial<Record<keyof typeof START_STATUS, string>> = { 'consent-required': 'consent-needed', 'user-scope-variant': 'user-scope-proposal' };

class BadRequest extends Error {}

/** Answers a refusal of the file store or of the runner with its status and code; anything else is the error handler's. */
function refuse(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof EvalFileError) {
    return reply.status(FILE_STATUS[err.code]).send({ error: err.message, code: err.code, ...(err.problems.length ? { problems: err.problems } : {}) });
  }
  if (err instanceof EvalStartError) {
    return reply.status(START_STATUS[err.code]).send({ error: err.message, code: START_CODE[err.code] ?? err.code, ...(err.detail ? { detail: err.detail } : {}) });
  }
  if (err instanceof Phase2Off) return reply.status(409).send({ error: err.message, code: 'evals-phase2-off' });
  if (err instanceof BadRequest) return reply.status(400).send({ error: err.message });
  throw err;
}

/** Raised while the Phase 2 switch is off, for what only Phase 2 does. */
class Phase2Off extends Error {}

const isPressure = (v: unknown): v is EvalPressure => (EVAL_PRESSURES as readonly unknown[]).includes(v);

const isVariant = (v: unknown): v is EvalVariant => (EVAL_VARIANTS as readonly unknown[]).includes(v);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the shape of what a person sent; what the runner decides on (consent, ceiling, pins) is its own. */
function runRequest(body: unknown): EvalRunRequest {
  if (!isRecord(body)) throw new BadRequest('the body must be an object');
  const { variants, pressures, proposed, cases, samples, maxCostUsd, confirmMaxCostUsd, account } = body;
  if (!Array.isArray(variants) || !variants.every(isVariant)) throw new BadRequest(`variants must be a list of ${EVAL_VARIANTS.join(', ')}`);
  if (pressures !== undefined && !(Array.isArray(pressures) && pressures.length > 0 && pressures.every(isPressure))) throw new BadRequest(`pressures must be a list of ${EVAL_PRESSURES.join(', ')}`);
  if (proposed !== undefined && typeof proposed !== 'string') throw new BadRequest('proposed must be a string');
  if (cases !== undefined && !(Array.isArray(cases) && cases.every((c) => typeof c === 'string'))) throw new BadRequest('cases must be a list of case ids');
  if (samples !== undefined && !(Number.isInteger(samples) && (samples as number) > 0)) throw new BadRequest('samples must be a positive integer');
  if (maxCostUsd !== undefined && !(typeof maxCostUsd === 'number' && maxCostUsd > 0)) throw new BadRequest('maxCostUsd must be a positive number');
  if (typeof confirmMaxCostUsd !== 'number' || !Number.isFinite(confirmMaxCostUsd)) throw new BadRequest('confirmMaxCostUsd must be the ceiling the estimate showed');
  if (account !== undefined && typeof account !== 'string') throw new BadRequest('account must be a string');
  return {
    variants,
    confirmMaxCostUsd,
    ...(pressures !== undefined ? { pressures: [...new Set(pressures as EvalPressure[])] } : {}),
    ...(proposed !== undefined ? { proposed } : {}),
    ...(cases !== undefined ? { cases: cases as string[] } : {}),
    ...(samples !== undefined ? { samples: samples as number } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(account !== undefined ? { account } : {}),
  };
}

/**
 * Instruction evals (docs/plans/instruction-evals.md). Nothing here starts a run but a person's
 * request: the chat token is refused on every route that writes, consents, spends or deletes
 * (`security.ts`), and the start repeats the ceiling it was shown. Validation lives in core.
 */
export const evalRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  const { evals } = core;

  /** Phase 2 stays behind its own switch (`evalsPhase2` in the app settings). */
  const phase2 = (): void => {
    if (!core.appSettings.evalsPhase2) throw new Phase2Off('the instruction evals\' Phase 2 is off: turn on evalsPhase2 in the app settings');
  };
  /** Pressure levels beyond `neutral` are Phase 2's. */
  const checkPressures = (request: EvalRunRequest): EvalRunRequest => {
    if (request.pressures?.some((p) => p !== 'neutral')) phase2();
    return request;
  };

  /** Wraps a handler so that core's refusals keep their status and code. */
  const answering =
    <Req>(handler: (req: Req, reply: FastifyReply) => Promise<unknown> | unknown) =>
    async (req: Req, reply: FastifyReply): Promise<unknown> => {
      try {
        return await handler(req, reply);
      } catch (err) {
        return refuse(reply, err);
      }
    };

  app.get<{ Params: { id: string } }>('/projects/:id/evals', answering((req) => evals.files((req as { params: { id: string } }).params.id)));

  app.get<{ Params: { id: string } }>('/projects/:id/eval-head', answering((req) => evals.head((req as { params: { id: string } }).params.id)));

  app.get<{ Params: { id: string; name: string } }>('/projects/:id/evals/:name', answering((req) => {
    const { id, name } = (req as { params: { id: string; name: string } }).params;
    return evals.detail(id, name);
  }));

  app.put<{ Params: { id: string; name: string }; Body: PutEvalFileRequest }>('/projects/:id/evals/:name', answering(async (req) => {
    const { params, body } = req as { params: { id: string; name: string }; body: PutEvalFileRequest };
    if (!isRecord(body) || !('definition' in body)) throw new BadRequest('the body must hold the definition');
    const ifMatch = body.ifMatch ?? null;
    if (ifMatch !== null && typeof ifMatch !== 'string') throw new BadRequest('ifMatch must be the SHA that was read, or null');
    await evals.write(params.id, params.name, body.definition, ifMatch);
    return evals.detail(params.id, params.name);
  }));

  app.delete<{ Params: { id: string; name: string } }>('/projects/:id/evals/:name', answering(async (req) => {
    const { id, name } = (req as { params: { id: string; name: string } }).params;
    if (!(await evals.remove(id, name))) throw new EvalFileError('not-found', `there is no eval named ${name}`);
    return { ok: true as const };
  }));

  app.post<{ Params: { id: string; name: string }; Body: unknown }>('/projects/:id/evals/:name/estimate', answering((req) => {
    const { params, body } = req as { params: { id: string; name: string }; body: unknown };
    return evals.estimate(params.id, params.name, checkPressures(runRequest(body)));
  }));

  app.post<{ Params: { id: string; name: string }; Body: { model?: string; effort?: Effort } }>('/projects/:id/evals/:name/draft-cases', { preHandler: spendGate(core) }, async (req, reply) => {
    try {
      phase2();
      const { params, body } = req;
      const run = await core.assistant.start(params.id, { kind: 'evals', evalName: params.name, ...(body?.model ? { model: body.model } : {}), ...(body?.effort ? { effort: body.effort } : {}) }, assistantLanguage(req.headers['accept-language']));
      return reply.code(201).send(run);
    } catch (err) {
      return refuse(reply, err);
    }
  });

  app.post<{ Params: { id: string; name: string }; Body: { sha?: unknown } }>('/projects/:id/evals/:name/consent', answering((req) => {
    const { params, body } = req as { params: { id: string; name: string }; body: { sha?: unknown } | undefined };
    if (typeof body?.sha !== 'string' || !body.sha) throw new BadRequest('sha must be the SHA of the file that was read');
    return evals.consent(params.id, params.name, body.sha);
  }));

  app.post<{ Params: { id: string; name: string }; Body: unknown }>('/projects/:id/evals/:name/runs', answering(async (req, reply) => {
    const { params, body } = req as { params: { id: string; name: string }; body: unknown };
    return reply.status(201).send(await evals.start(params.id, params.name, checkPressures(runRequest(body))));
  }));

  app.get<{ Params: { id: string }; Querystring: { eval?: string; before?: string; limit?: string } }>('/projects/:id/eval-runs', answering((req) => {
    const { params, query } = req as { params: { id: string }; query: { eval?: string; before?: string; limit?: string } };
    let limit: number | undefined;
    if (query.limit !== undefined) {
      limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new BadRequest('limit must be a positive integer');
      limit = Math.min(limit, HISTORY_MAX);
    }
    return evals.history(params.id, query.eval ?? null, { ...(query.before ? { before: query.before } : {}), ...(limit !== undefined ? { limit } : {}) });
  }));

  app.get<{ Params: { runId: string } }>('/eval-runs/:runId', answering((req) => {
    const run = evals.run((req as { params: { runId: string } }).params.runId);
    if (!run) throw new EvalFileError('not-found', 'eval run not found');
    return run;
  }));

  app.get<{ Params: { runId: string; sampleId: string } }>('/eval-runs/:runId/samples/:sampleId', answering((req) => {
    const { runId, sampleId } = (req as { params: { runId: string; sampleId: string } }).params;
    const sample = evals.sample(runId, sampleId);
    if (!sample) throw new EvalFileError('not-found', 'eval sample not found');
    return sample;
  }));

  app.get<{ Params: { runId: string }; Querystring: { base?: string; other?: string } }>('/eval-runs/:runId/compare', answering((req) => {
    const { params, query } = req as { params: { runId: string }; query: { base?: string; other?: string } };
    const base = query.base ?? 'current';
    const other = query.other ?? 'proposed';
    if (!isVariant(base) || !isVariant(other)) throw new BadRequest(`base and other must be one of ${EVAL_VARIANTS.join(', ')}`);
    const comparison = evals.compare(params.runId, base, other);
    if (!comparison) throw new EvalFileError('not-found', 'eval run not found');
    return comparison;
  }));

  app.post<{ Params: { runId: string } }>('/eval-runs/:runId/cancel', answering(async (req) => {
    const summary = await evals.cancel((req as { params: { runId: string } }).params.runId);
    if (!summary) throw new EvalFileError('not-found', 'eval run not found');
    return summary;
  }));

  app.post<{ Params: { runId: string }; Body: { confirmMaxCostUsd?: unknown } }>('/eval-runs/:runId/resume', answering((req) => {
    const { params, body } = req as { params: { runId: string }; body: { confirmMaxCostUsd?: unknown } | undefined };
    if (typeof body?.confirmMaxCostUsd !== 'number' || !Number.isFinite(body.confirmMaxCostUsd)) throw new BadRequest('confirmMaxCostUsd must be the ceiling that was shown');
    if (!evals.summary(params.runId)) throw new EvalFileError('not-found', 'eval run not found');
    return evals.resume(params.runId, body.confirmMaxCostUsd);
  }));

  app.get<{ Params: { runId: string } }>('/eval-runs/:runId/gate', answering((req) => {
    phase2();
    const { runId } = (req as { params: { runId: string } }).params;
    if (!evals.summary(runId)) throw new EvalFileError('not-found', 'eval run not found');
    const gate = evals.gate(runId);
    if (!gate) throw new EvalFileError('not-found', 'this run has no gate: it needs both current and proposed and must have ended');
    return gate;
  }));

  app.post<{ Params: { runId: string } }>('/eval-runs/:runId/rejudge', answering(async (req) => {
    phase2();
    const { runId } = (req as { params: { runId: string } }).params;
    if (!evals.summary(runId)) throw new EvalFileError('not-found', 'eval run not found');
    const result = await evals.rejudge(runId);
    if (!result) throw new EvalStartError('eval-running', 'a re-judge of this run is already running');
    return result;
  }));

  app.post<{ Params: { runId: string }; Body: { caseId?: unknown; idx?: unknown } }>('/eval-runs/:runId/accept-judge', answering((req) => {
    phase2();
    const { params, body } = req as { params: { runId: string }; body: { caseId?: unknown; idx?: unknown } | undefined };
    if (typeof body?.caseId !== 'string' || !body.caseId || !Number.isInteger(body.idx) || (body.idx as number) < 0) throw new BadRequest('caseId and idx must name the judged expectation to accept');
    if (!evals.summary(params.runId)) throw new EvalFileError('not-found', 'eval run not found');
    const gate = evals.acceptJudge(params.runId, body.caseId, body.idx as number);
    if (!gate) throw new EvalFileError('not-found', 'this run has no gate');
    return gate;
  }));

  app.delete<{ Params: { runId: string } }>('/eval-runs/:runId', answering((req) => {
    const { runId } = (req as { params: { runId: string } }).params;
    const summary = evals.summary(runId);
    if (!summary) throw new EvalFileError('not-found', 'eval run not found');
    if (summary.state !== 'ended' || !evals.deleteRun(runId)) throw new EvalStartError('eval-running', 'the run is still live: cancel it first');
    return { ok: true as const };
  }));

  app.get<{ Params: { runId: string }; Querystring: { format?: string } }>('/eval-runs/:runId/export', answering((req, reply) => {
    const { params, query } = req as { params: { runId: string }; query: { format?: string } };
    const format = query.format ?? 'json';
    if (format !== 'json' && format !== 'markdown') throw new BadRequest('format must be json or markdown');
    const exported = evals.export(params.runId, format);
    if (!exported) throw new EvalFileError('not-found', 'eval run not found');
    return reply.header('content-disposition', `attachment; filename="${exported.filename}"`).type(exported.contentType).send(exported.body);
  }));
};
