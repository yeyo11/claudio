/** What a caught value says: an `Error`'s message, or the value as text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Something asked for by id or name that does not exist: the API answers 404 with its message. The
 * one way to say "not found"; an error's words never decide its status.
 */
export class NotFoundError extends Error {
  readonly statusCode = 404;
}
