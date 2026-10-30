import { isRecord } from '@claudio/shared';
/*
 * Paths into a settings document (`['miner', 'model']`), for the stores' `resetKeys`: a Reset removes
 * what the person stored, so the default applies again, and a default that changes later too
 * (docs/plans/settings-reset-and-polish.md, D6).
 */

export type SettingPath = readonly string[];


/** The value at `path`, or undefined when any step of it is missing */
export function valueAt(doc: unknown, path: SettingPath): unknown {
  let at: unknown = doc;
  for (const key of path) {
    if (!isRecord(at) || !Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

/** Whether the document holds a value at `path`; `null` is a value (no cap, no shell of its own) */
export const storedAt = (doc: unknown, path: SettingPath): boolean => valueAt(doc, path) !== undefined;

/**
 * A copy of the document without the values at `paths`. A group the removal leaves empty goes
 * too, so the file reads exactly as one that never named it. What is not on a path is kept as it
 * is, even keys this build does not know.
 */
export function withoutPaths(doc: Record<string, unknown>, paths: readonly SettingPath[]): Record<string, unknown> {
  const out = structuredClone(doc);
  for (const path of paths) {
    const parents: Array<Record<string, unknown>> = [];
    let at: unknown = out;
    for (const key of path.slice(0, -1)) {
      if (!isRecord(at)) break;
      parents.push(at);
      at = at[key];
    }
    const last = path.at(-1);
    if (last === undefined || !isRecord(at) || parents.length !== path.length - 1) continue;
    delete at[last];
    // Prune upwards: an empty group says nothing, and a store that reads it may refuse `{}`
    let child: Record<string, unknown> = at;
    for (let i = parents.length - 1; i >= 0; i--) {
      const parent = parents[i];
      const key = path[i];
      if (!parent || key === undefined || Object.keys(child).length > 0) break;
      delete parent[key];
      child = parent;
    }
  }
  return out;
}
