/** What the service refuses with, in the codes the API answers with (`terminal.limit` is a 409, and so on). */
export type TerminalErrorCode =
  | 'terminal.off'
  | 'terminal.unavailable'
  | 'terminal.limit'
  | 'terminal.clients'
  | 'terminal.no-project'
  | 'terminal.not-found'
  | 'terminal.bad-cwd'
  | 'terminal.bad-settings'
  | 'terminal.env-locked'
  | 'terminal.ended'
  | 'terminal.input-too-large';

export class TerminalError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string,
    /** The HTTP status the API answers with */
    readonly status: number,
  ) {
    super(message);
    this.name = 'TerminalError';
  }
}
