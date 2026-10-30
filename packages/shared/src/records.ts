/**
 * A plain JSON object: not null and not an array. The one guard every package reads untyped JSON
 * through (a file, a request body, a CLI line), so "is this an object?" means the same everywhere.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The object itself, or an empty one for anything else: for reading optional fields without a guard at every step. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
