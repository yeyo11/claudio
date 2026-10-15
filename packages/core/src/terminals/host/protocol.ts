/*
 * What the service and the terminal host say to each other over the fork's IPC channel. The channel
 * uses structured clone (`serialization: 'advanced'`), so output travels as a `Buffer`, not as text.
 */

export interface SpawnMessage {
  type: 'spawn';
  id: string;
  shell: string;
  args: string[];
  cwd: string;
  /** The whole environment of the shell: the host holds no other */
  env: Record<string, string>;
  cols: number;
  rows: number;
  scrollbackLines: number;
}

/** Service to host */
export type HostRequest =
  | SpawnMessage
  | { type: 'write'; id: string; data: Buffer }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'pause'; id: string }
  | { type: 'resume'; id: string }
  | { type: 'snapshot'; id: string; reqId: number; replayLines: number; maxBytes: number }
  /** Ends one terminal: SIGHUP, SIGTERM, then SIGKILL after `graceMs` to what still is the same process */
  | { type: 'kill'; id: string; graceMs: number }
  | { type: 'killAll'; graceMs: number }
  /** An exited terminal's screen is kept for the person to see how it ended; this lets it go */
  | { type: 'forget'; id: string };

export type HostFailure = 'pty-missing' | 'spawn-failed';

/** Host to service */
export type HostReply =
  | { type: 'ready' }
  | { type: 'spawned'; id: string; pid: number; pidStarted: number | null }
  | { type: 'spawn-error'; id: string; reason: HostFailure; message: string }
  | { type: 'data'; id: string; data: Buffer }
  | { type: 'exit'; id: string; code: number | null; signal: string | null }
  | { type: 'snapshot'; reqId: number; id: string; snapshot: string; tail: Buffer; cols: number; rows: number }
  | { type: 'snapshot-error'; reqId: number; id: string };
