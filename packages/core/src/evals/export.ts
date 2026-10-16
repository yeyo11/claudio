import type { EvalCall, EvalRun } from '@claudio/shared';
import type { EvalStore } from './store.ts';

export type EvalExportFormat = 'json' | 'markdown';

/** The JSON document of a run: its rows as stored, so reading it back gives the same run. */
export interface EvalExport {
  version: 1;
  run: EvalRun;
  /** Per sample id, in call order */
  calls: Record<string, EvalCall[]>;
}

/** The whole run as stored: the file as run, the variants, every sample with its checks. */
export function loadEvalRun(store: EvalStore, runId: string): EvalRun | null {
  const summary = store.summary(runId);
  const definition = store.definition(runId);
  if (!summary || !definition) return null;
  return { ...summary, definition, variantInfo: store.variants(runId), samples: store.samples(runId) };
}

/** Everything is already masked when it is stored, so nothing here masks again. */
export function exportRunJson(store: EvalStore, runId: string): EvalExport | null {
  const run = loadEvalRun(store, runId);
  if (!run) return null;
  const calls: Record<string, EvalCall[]> = {};
  for (const s of run.samples) calls[s.id] = store.calls(s.id);
  return { version: 1, run, calls };
}

/** A table cell: no pipe or line break may end it early. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** A fence longer than any run of backticks inside, so stored output cannot close it. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

export function exportRunMarkdown(store: EvalStore, runId: string): string | null {
  const run = loadEvalRun(store, runId);
  if (!run) return null;
  const out: string[] = [];
  out.push(`# Eval ${run.evalName}`, '');
  out.push(`- Run: \`${run.id}\``);
  out.push(`- State: ${run.state}${run.outcome ? ` (${run.outcome})` : ''}${run.reason ? `: ${run.reason}` : ''}`);
  out.push(`- Definition SHA-256: \`${run.definitionSha}\``);
  out.push(`- Samples per case: ${run.samplesPerCase}`);
  out.push(`- Cost: $${run.costUsd.toFixed(4)} of $${run.maxCostUsd.toFixed(2)}`);
  out.push(`- Created: ${run.createdAt}${run.endedAt ? `, ended: ${run.endedAt}` : ''}`, '');

  out.push('## Variants', '');
  for (const v of run.variantInfo) {
    out.push(`- **${v.variant}**: \`${v.targetPath}\`, ${v.present ? `sha \`${v.contentSha ?? 'unknown'}\`` : 'no file'}`);
  }
  out.push('');

  out.push('## Scored', '');
  for (const variant of run.variants) {
    const tally = run.scored[variant];
    out.push(`- **${variant}**: ${tally ? `${tally.passed} of ${tally.of} cases` : 'nothing scored'}`);
  }
  out.push('');

  out.push('## Cases', '');
  for (const c of run.definition.cases) {
    out.push(`### ${c.id}`, '');
    const samples = run.samples.filter((s) => s.caseId === c.id);
    if (!samples.length) {
      out.push('No samples.', '');
      continue;
    }
    out.push('| Variant | Attempt | Try | Outcome | Cost | Duration | Reason |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const s of samples) {
      const outcome = s.outcome ?? s.state;
      const cost = s.costUsd === null ? '' : `$${s.costUsd.toFixed(4)}`;
      const time = s.durationMs === null ? '' : `${(s.durationMs / 1000).toFixed(1)} s`;
      out.push(`| ${s.variant} | ${s.attempt} | ${s.try} | ${outcome} | ${cost} | ${time} | ${cell(s.reason ?? '')} |`);
    }
    out.push('');
    const failing = samples.flatMap((s) => s.checks.filter((k) => !k.passed).map((k) => ({ s, k })));
    if (failing.length) {
      out.push('Failing checks:', '');
      for (const { s, k } of failing) {
        out.push(`- ${s.variant} attempt ${s.attempt}, check ${k.idx} (${k.kind}): ${cell(k.detail)}${k.evidenceSeq === null ? '' : ` (call #${k.evidenceSeq})`}`);
        if (k.output) out.push('', fenced(k.output), '');
      }
      out.push('');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** The body, type and file name the download route sends. Null when the run does not exist. */
export function exportRun(store: EvalStore, runId: string, format: EvalExportFormat): { body: string; contentType: string; filename: string } | null {
  if (format === 'markdown') {
    const body = exportRunMarkdown(store, runId);
    return body === null ? null : { body, contentType: 'text/markdown; charset=utf-8', filename: `eval-run-${runId}.md` };
  }
  const doc = exportRunJson(store, runId);
  return doc === null ? null : { body: `${JSON.stringify(doc, null, 2)}\n`, contentType: 'application/json; charset=utf-8', filename: `eval-run-${runId}.json` };
}
