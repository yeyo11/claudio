#!/usr/bin/env node
// `claudio`, the operator's command beside a server (docs/plans/headless-image.md, D3 and D11):
// `claudio login` signs its Claude account in through the API, `claudio status` says whether it can
// take work. Bundled alone as cli.mjs (apps/api/scripts/bundle.mjs); the headless image links it as
// /usr/local/bin/claudio. It talks to the server over HTTP only, so it works the same inside the
// container and from another machine with --url and --token.
import { createInterface } from 'node:readline';
import { run } from './run.ts';

const interrupt = new AbortController();
const cancel = (): void => interrupt.abort();
// A second Ctrl-C while the cancel is being sent ends the command at once
process.on('SIGINT', () => (interrupt.signal.aborted ? process.exit(130) : cancel()));

let lines: AsyncIterator<string> | null = null;

/**
 * Reads the pasted code. On a terminal, raw mode keeps it off the screen (and turns Ctrl-C into a
 * byte instead of a signal, so it is handled here); from a pipe, one line is read as it comes.
 */
function readSecret(prompt: string, signal: AbortSignal): Promise<string | null> {
  process.stdout.write(prompt);
  const input = process.stdin;
  if (!input.isTTY) {
    lines ??= createInterface({ input, terminal: false })[Symbol.asyncIterator]();
    const next = lines.next().then((r) => (r.done ? null : r.value));
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(signal.reason);
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      void next.then((value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      }, reject);
    });
  }
  return new Promise((resolve, reject) => {
    let typed = '';
    const done = (finish: () => void): void => {
      input.removeListener('data', onData);
      signal.removeEventListener('abort', onAbort);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      finish();
    };
    const onAbort = (): void => done(() => reject(signal.reason));
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003') {
          cancel();
          return;
        }
        if (ch === '\r' || ch === '\n') return done(() => resolve(typed));
        if (ch === '\u0004' && typed === '') return done(() => resolve(null));
        if (ch === '\u007f' || ch === '\b') typed = typed.slice(0, -1);
        else if (ch >= ' ') typed += ch;
      }
    };
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

const code = await run(process.argv.slice(2), {
  env: process.env,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  readSecret,
  interrupt: interrupt.signal,
});
// stdin may still be referenced by the line reader; the answer is final
process.exit(code);
