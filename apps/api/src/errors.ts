/**
 * A failure the caller cannot act on: its text is for us, not for them.
 *
 * Core refuses on purpose with a hand-thrown `Error` — or with one that declares its status, the
 * way `ChatConflictError` does — and that text is the answer. Everything else (a `TypeError`, a
 * `SyntaxError`, an `ENOENT` carrying the absolute path it tried to open) is a bug in this
 * process, and its message spells out where the host keeps its files and who runs it.
 */
export function deliberate(err: Error & { statusCode?: number; code?: string; validation?: unknown }): boolean {
  if (typeof err.statusCode === 'number') return true;
  if (err.validation !== undefined) return true;
  // Node stamps what it raises itself with `code` / `syscall`; only `new Error(...)` arrives bare
  return Object.getPrototypeOf(err) === Error.prototype && err.code === undefined && !('syscall' in err);
}
