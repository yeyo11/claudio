import { asRecord } from './records.ts';
const asCount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

/** The CLI's `structuredPatch` hunks as the unified text git would print for them. */
export function unifiedOf(hunks: unknown[]): string {
  let out = '';
  for (const raw of hunks) {
    const h = asRecord(raw);
    const lines = Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === 'string') : [];
    out += `@@ -${asCount(h.oldStart)},${asCount(h.oldLines)} +${asCount(h.newStart)},${asCount(h.newLines)} @@\n`;
    for (const line of lines) out += `${line}\n`;
  }
  return out;
}

/** A file created from nothing: every line of it is new. */
export function addedDiff(content: string): string {
  if (!content) return '';
  const lines = content.split('\n');
  const newline = content.endsWith('\n');
  if (newline) lines.pop();
  let out = `@@ -0,0 +1,${lines.length} @@\n`;
  for (const line of lines) out += `+${line}\n`;
  return newline ? out : `${out}\\ No newline at end of file\n`;
}
