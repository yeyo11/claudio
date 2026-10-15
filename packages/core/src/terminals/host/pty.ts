import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** A PTY, as the host needs it: the one place that knows the native module's shape */
export interface Pty {
  readonly pid: number;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  /** The output as the bytes the shell wrote: `encoding: null` makes node-pty hand over `Buffer`s */
  onData(listener: (data: Buffer) => void): void;
  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): void;
}

export interface PtySpawn {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyBackend {
  spawn(options: PtySpawn): Pty;
}

/** The loader failed; `detail` is the real cause, which node-pty's own error hides */
export class PtyMissingError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'PtyMissingError';
  }
}

/** The shape of the part of node-pty that is used. Its `onData` is typed `string` but hands `Buffer`s with `encoding: null`. */
interface NodePty {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string>; encoding: null },
  ): {
    pid: number;
    write(data: string | Buffer): void;
    resize(cols: number, rows: number): void;
    pause(): void;
    resume(): void;
    onData(listener: (data: unknown) => void): unknown;
    onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown;
  };
}

/** The signal names by number, for the few a shell dies of */
const SIGNALS: Record<number, string> = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 6: 'SIGABRT', 9: 'SIGKILL', 13: 'SIGPIPE', 15: 'SIGTERM' };

/**
 * Loads node-pty, once and only when the first terminal is asked for, never at start-up. A binary
 * that will not load (a glibc mismatch, a missing prebuild) makes this throw `PtyMissingError`; the
 * `.node` file it expected is loaded by hand to say why, since node-pty reports only the last path it tried.
 */
export function loadNodePty(require: NodeRequire = createRequire(import.meta.url)): PtyBackend {
  let native: NodePty;
  try {
    native = require('node-pty') as NodePty;
  } catch (error) {
    throw new PtyMissingError('node-pty did not load', loadError(require, error));
  }
  return {
    spawn(options) {
      const term = native.spawn(options.file, options.args, {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
        encoding: null,
      });
      return {
        pid: term.pid,
        write: (data) => term.write(data),
        resize: (cols, rows) => term.resize(cols, rows),
        pause: () => term.pause(),
        resume: () => term.resume(),
        onData: (listener) => {
          term.onData((data) => listener(Buffer.isBuffer(data) ? data : Buffer.from(String(data))));
        },
        onExit: (listener) => {
          term.onExit(({ exitCode, signal }) => listener({ code: exitCode, signal: signal ? (SIGNALS[signal] ?? String(signal)) : null }));
        },
      };
    },
  };
}

function loadError(require: NodeRequire, first: unknown): string {
  const message = first instanceof Error ? first.message : String(first);
  try {
    const root = dirname(require.resolve('node-pty/package.json'));
    const dir = join(root, 'prebuilds', `${process.platform}-${process.arch}`);
    const file = join(dir, 'pty.node');
    if (!existsSync(file)) return `${message} (no prebuilt binary at ${file})`;
    try {
      require(file);
    } catch (error) {
      return `${message}; ${file}: ${error instanceof Error ? error.message : String(error)}`;
    }
  } catch {
    // not resolvable at all: the first message says so
  }
  return message;
}
