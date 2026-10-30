/**
 * Keeps a long-lived process (the API server, the container's launcher) up through an error nothing
 * caught: it is logged, with its stack, and the process goes on. Node's default ends the process,
 * and on 2026-10-25 one fold that threw on a removed account (`account … not found`, out of a stream
 * line handler) took the whole server down with every chat it ran. A fault of one chat or one
 * request is that chat's or that request's; the code that should have caught it is the fix, and the
 * log line is how it is found.
 *
 * Returns the uninstall, which tests and a process about to exit call.
 */
export function installProcessGuards(log: (line: string, error: unknown) => void): () => void {
  const describe = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : String(error));
  const onRejection = (reason: unknown): void => {
    try {
      log(`unhandled promise rejection, the process goes on: ${describe(reason)}`, reason);
    } catch {
      // A logger that fails cannot be told about it; the process still goes on
    }
  };
  const onException = (error: Error): void => {
    try {
      log(`uncaught exception, the process goes on: ${describe(error)}`, error);
    } catch {
      // As above
    }
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
}
