// The figures a result reports, kept the way Claude Code keeps them (spike S1 of
// docs/plans/decision-engine-v2.md, CLI 2.1.322): `total_cost_usd` and `modelUsage` are cumulative
// over the session, not the process. `--resume` goes on from the session's last totals, and
// `--resume --fork-session` starts the copy from its parent's. The real CLI keeps them in the
// session's transcript (a `cost-state` line); the fakes keep them in a file per session, named by the
// process that spawned them as well, so a test run never reads what an earlier run left behind.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const file = (session) => join(tmpdir(), `fake-claude-totals-${String(process.ppid)}-${session}.json`);

const read = (session) => {
  if (!session || !existsSync(file(session))) return null;
  try {
    return JSON.parse(readFileSync(file(session), 'utf8'));
  } catch {
    return null;
  }
};

/**
 * The totals of `session`: its own when it already has some (a resume), else its parent's (a fork),
 * else nothing. `add` puts one turn on them and answers what the result reports.
 */
export function sessionTotals(session, parent = null) {
  const kept = read(session) ?? read(parent) ?? { costUsd: 0, models: {}, results: 0 };
  return {
    /** Results the session has reported so far, every process of it */
    get results() {
      return kept.results;
    },
    /**
     * One turn: its cost and, per model, its tokens and cost. Answers the session's totals after it, as
     * `total_cost_usd` and `modelUsage` report them; a turn with no cost leaves the cost where it was.
     */
    add(turnCostUsd, turnModels = {}) {
      kept.results++;
      if (typeof turnCostUsd === 'number') kept.costUsd += turnCostUsd;
      for (const [model, usage] of Object.entries(turnModels)) {
        const into = (kept.models[model] ??= {});
        for (const [key, value] of Object.entries(usage)) {
          // The window and the model's names are facts about it, not counts
          const count = typeof value === 'number' && key !== 'contextWindow' && key !== 'maxOutputTokens';
          into[key] = count ? (into[key] ?? 0) + value : value;
        }
      }
      writeFileSync(file(session), JSON.stringify(kept));
      return { totalCostUsd: kept.costUsd, modelUsage: structuredClone(kept.models) };
    },
  };
}

/** The session a fork copies, from the flags the CLI is given; null for a process that is no fork. */
export function forkedFrom(args) {
  if (!args.includes('--fork-session') || !args.includes('--resume')) return null;
  return args[args.indexOf('--resume') + 1] ?? null;
}
