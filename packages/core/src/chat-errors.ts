// The refusals the chat runtime and service throw, typed so a caller decides by class and status,
// never by reading the message: the OpenAI-compatible routes answer each kind with its own status.

/** A request the chat runtime refuses on purpose; `statusCode` is the HTTP answer it stands for. */
export class ChatRefusal extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 503 = 400,
  ) {
    super(message);
  }
}

/** The chat a call names is not one Claudio knows. */
export class ChatNotFoundError extends ChatRefusal {
  readonly code = 'chat-not-found';
  constructor(message = 'chat not found') {
    super(message, 404);
  }
}

/**
 * Every run slot (`maxConcurrentRuns`) is taken. Still a 400 for the REST API, as it always was; the
 * OpenAI routes answer it with a 429 a client retries by itself, since a slot frees within moments.
 */
export class RunSlotRefusal extends ChatRefusal {
  readonly code = 'run-slot';
  constructor(readonly limit: number) {
    super(`Concurrent run limit reached (${String(limit)})`);
  }
}
