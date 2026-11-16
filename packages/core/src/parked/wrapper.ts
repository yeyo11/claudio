/**
 * The `sh` script a parked CLI runs under (D4 of docs/plans/survive-restarts.md: no runner, a FIFO
 * for stdin, an append-only file for stdout). The script, the files beside it and their names are the
 * on-disk contract a later server reads to adopt the process, so they carry a layout version
 * (`PARKED_LAYOUT`, also written to `<dir>/version`); a server that finds a layout it does not know
 * leaves the process alone.
 *
 * Every word of the command is in the script, not on the `sh` command line: the process table then
 * shows `sh <dir>/run.sh`, and nothing that matches a CLI by its arguments (`streamJsonProcesses`)
 * mistakes the wrapper for a second process on the session.
 */

/** The version of the files under `procs/<id>/` and of this script. */
export const PARKED_LAYOUT = 1;

/** The files of one parked process, relative to its directory. */
export const PARKED_FILES = {
  script: 'run.sh',
  version: 'version',
  /** The CLI's stdin. The wrapper holds a writer of its own, so the CLI never reads EOF while no server is there */
  fifo: 'in.fifo',
  /** What the server wrote, one line per message: its sequence number and kind, never its text */
  input: 'in.jsonl',
  /** The CLI's stdout, append-only; read from the committed offset, with holes punched before it */
  output: 'out.jsonl',
  errors: 'err.log',
  /** The script's own errors and those of `systemd-run` */
  wrapperLog: 'wrapper.log',
  /** The CLI's pid, written by the wrapper as soon as it started it */
  pid: 'pid',
  /** The CLI's exit status as `wait` gave it (128 + n for a signal), written when it ended */
  exitCode: 'exit.code',
  /** Epoch seconds until which a server holds the process; renewed while one does */
  lease: 'lease',
  /** Present while a turn is open: the byte of `out.jsonl` where its output starts */
  turn: 'turn',
  /** Written by the watchdog when it ended an open turn: the epoch second it did */
  watchdog: 'watchdog',
} as const;

/** Quotes a word for `sh`: inside single quotes nothing is special but the quote itself. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export interface WrapperSpec {
  /** The process's directory, absolute */
  dir: string;
  /** The CLI and its arguments */
  command: readonly string[];
  /** Seconds between the watchdog's looks at the lease */
  tickSeconds: number;
}

/**
 * The script. In order:
 *
 * - fd 4 opens the FIFO read-write, which never blocks and keeps a writer on it for as long as the
 *   wrapper lives; fd 3 then opens it for reading, which does not block either, since fd 4 is a writer.
 * - The CLI runs in the background, so that the wrapper knows its pid and can watch it, with its stdin
 *   from fd 3. A background job of a non-interactive `sh` reads `/dev/null` unless told otherwise
 *   (spike S1), which is why the redirection is explicit. The CLI keeps neither descriptor of the wrapper's.
 * - SIGUSR1 closes fd 4: that is how a server that wants the CLI to read EOF (an idle timeout, a
 *   one-shot run) gets it, once its own writer is closed too. A trapped signal interrupts `wait`, so
 *   the wait is repeated while the CLI is still there (a zombie answers `kill -0` until it is reaped).
 * - The watchdog (D6, and S2 for "only while a turn is open"): when the lease has run out and a turn
 *   is open, and the CLI wrote no `result` since the turn began, it sends SIGINT, which the vendor
 *   documents as ending the turn rather than abandoning it, once. An idle CLI is never signalled:
 *   SIGINT ends an idle `-p` process.
 * - When the CLI is gone, its status goes to `exit.code`, written whole by a rename.
 */
export function wrapperScript(spec: WrapperSpec): string {
  const dir = shellQuote(spec.dir);
  const f = PARKED_FILES;
  return `# Claudio parked CLI wrapper, layout ${String(PARKED_LAYOUT)} (docs/plans/survive-restarts.md)
umask 077
dir=${dir}
tick=${String(spec.tickSeconds)}
set -- ${spec.command.map(shellQuote).join(' ')}
exec 4<>"$dir/${f.fifo}"
exec 3<"$dir/${f.fifo}"
"$@" <&3 >>"$dir/${f.output}" 2>>"$dir/${f.errors}" 3<&- 4>&- &
cli=$!
echo "$cli" >"$dir/${f.pid}.tmp" && mv -f "$dir/${f.pid}.tmp" "$dir/${f.pid}"
exec 3<&-
trap 'exec 4>&-' USR1
(
  while sleep "$tick"; do
    kill -0 "$cli" 2>/dev/null || exit 0
    [ -f "$dir/${f.turn}" ] || continue
    expiry=$(cat "$dir/${f.lease}" 2>/dev/null) || continue
    [ "$(date +%s)" -gt "\${expiry:-0}" ] || continue
    from=$(cat "$dir/${f.turn}" 2>/dev/null) || continue
    tail -c "+$((\${from:-0} + 1))" "$dir/${f.output}" 2>/dev/null | grep -q '"type":"result"' && continue
    date +%s >"$dir/${f.watchdog}"
    rm -f "$dir/${f.turn}"
    kill -INT "$cli" 2>/dev/null
  done
) 4>&- </dev/null >/dev/null 2>&1 &
watch=$!
while :; do
  wait "$cli"
  code=$?
  if [ "$code" -gt 128 ] && kill -0 "$cli" 2>/dev/null; then continue; fi
  break
done
kill "$watch" 2>/dev/null
echo "$code" >"$dir/${f.exitCode}.tmp" && mv -f "$dir/${f.exitCode}.tmp" "$dir/${f.exitCode}"
`;
}
