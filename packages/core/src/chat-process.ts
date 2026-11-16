import type { EventEmitter } from 'node:events';

/** What is written to a chat's process: its stdin, as a pipe or as a parked process's FIFO. */
export interface ChatProcessInput {
  write(text: string): boolean;
  /** No more input: the agent reads EOF once nothing else writes to it */
  end(): void;
  readonly writableEnded: boolean;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/**
 * The process a chat drives, as `ChatManager` sees it: a child on pipes (`ChildProcessWithoutNullStreams`
 * fits it as it is) or a parked process (`parked/process.ts`), which can outlive the server. It
 * emits `exit` and then `close` (`code`, `signal`) once its output has been read to the end, and
 * `error` when it could not be started.
 */
export interface ChatProcess extends EventEmitter {
  /** The process Claudio started; undefined when the start failed */
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdin: ChatProcessInput;
  kill(signal?: NodeJS.Signals): boolean;
}
