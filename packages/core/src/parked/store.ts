import type { DatabaseSync } from 'node:sqlite';

/** A process as the kernel names it for good: a pid alone may have been reused by the time anyone reads it. */
export interface ProcessIdentity {
  pid: number;
  /** Clock ticks after boot, `/proc/<pid>/stat` field 22 */
  started: number;
}

/** One parked CLI process, as its row in `cli_processes` holds it. */
export interface CliProcessRow {
  id: string;
  chatId: string;
  layout: number;
  dir: string;
  /** The systemd user scope it runs in; null where it runs under `setsid` */
  scope: string | null;
  wrapper: ProcessIdentity;
  /** Null until the wrapper wrote it */
  cli: ProcessIdentity | null;
  /** The server holding it; null once released */
  owner: ProcessIdentity | null;
  leaseUntil: string;
  committedOffset: number;
  stdinSeq: number;
  /** Where the open turn's output starts in `out.jsonl`; null between turns */
  turnOffset: number | null;
  /**
   * What a restart must keep of what the process was given (t5, D5): the SHA-256 of its chat token as
   * hex (never the token), the payload directory its MCP server runs from, and the CLI's version.
   * Null for a row written before, or one that had none of them.
   */
  tokenHash: string | null;
  payloadDir: string | null;
  cliVersion: string | null;
  startedAt: string;
}

interface Row {
  id: string;
  chat_id: string;
  layout: number;
  dir: string;
  scope: string | null;
  wrapper_pid: number;
  wrapper_started: number;
  cli_pid: number | null;
  cli_started: number | null;
  owner_pid: number | null;
  owner_started: number | null;
  lease_until: string;
  committed_offset: number;
  stdin_seq: number;
  turn_offset: number | null;
  token_hash: string | null;
  payload_dir: string | null;
  cli_version: string | null;
  started_at: string;
}

const fromRow = (r: Row): CliProcessRow => ({
  id: r.id,
  chatId: r.chat_id,
  layout: Number(r.layout),
  dir: r.dir,
  scope: r.scope,
  wrapper: { pid: Number(r.wrapper_pid), started: Number(r.wrapper_started) },
  cli: r.cli_pid === null || r.cli_started === null ? null : { pid: Number(r.cli_pid), started: Number(r.cli_started) },
  owner: r.owner_pid === null || r.owner_started === null ? null : { pid: Number(r.owner_pid), started: Number(r.owner_started) },
  leaseUntil: r.lease_until,
  committedOffset: Number(r.committed_offset),
  stdinSeq: Number(r.stdin_seq),
  turnOffset: r.turn_offset === null ? null : Number(r.turn_offset),
  tokenHash: r.token_hash,
  payloadDir: r.payload_dir,
  cliVersion: r.cli_version,
  startedAt: r.started_at,
});

/**
 * The rows of `cli_processes` (db.ts). Every write that only its holder may make names the owner in
 * its `WHERE`: a server that lost the lease to another (t4's takeover) changes nothing.
 */
export class CliProcessStore {
  constructor(private readonly sql: DatabaseSync) {}

  insert(row: CliProcessRow): void {
    this.sql
      .prepare(
        `INSERT INTO cli_processes (id, chat_id, layout, dir, scope, wrapper_pid, wrapper_started, cli_pid, cli_started,
           owner_pid, owner_started, lease_until, committed_offset, stdin_seq, turn_offset, token_hash, payload_dir, cli_version, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.chatId,
        row.layout,
        row.dir,
        row.scope,
        row.wrapper.pid,
        row.wrapper.started,
        row.cli?.pid ?? null,
        row.cli?.started ?? null,
        row.owner?.pid ?? null,
        row.owner?.started ?? null,
        row.leaseUntil,
        row.committedOffset,
        row.stdinSeq,
        row.turnOffset,
        row.tokenHash,
        row.payloadDir,
        row.cliVersion,
        row.startedAt,
      );
  }

  get(id: string): CliProcessRow | null {
    const row = this.sql.prepare('SELECT * FROM cli_processes WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  all(): CliProcessRow[] {
    return (this.sql.prepare('SELECT * FROM cli_processes ORDER BY started_at, id').all() as unknown as Row[]).map(fromRow);
  }

  /** The process a chat token's hash was stored for, if its row is still there. */
  byTokenHash(hash: string): CliProcessRow | null {
    const row = this.sql.prepare('SELECT * FROM cli_processes WHERE token_hash = ?').get(hash) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** The CLI's own pid, once the wrapper has written it. */
  setCli(id: string, owner: ProcessIdentity, cli: ProcessIdentity): boolean {
    return this.changed(
      this.sql
        .prepare('UPDATE cli_processes SET cli_pid = ?, cli_started = ? WHERE id = ? AND owner_pid = ? AND owner_started = ?')
        .run(cli.pid, cli.started, id, owner.pid, owner.started),
    );
  }

  /** Moves the lease of every row this server holds; returns how many it still holds. */
  renew(owner: ProcessIdentity, leaseUntil: string): number {
    const result = this.sql.prepare('UPDATE cli_processes SET lease_until = ? WHERE owner_pid = ? AND owner_started = ?').run(leaseUntil, owner.pid, owner.started);
    return Number(result.changes);
  }

  /** A turn opened (`turnOffset`: where its output starts) or ended (null). */
  setTurn(id: string, owner: ProcessIdentity, turnOffset: number | null): boolean {
    return this.changed(
      this.sql.prepare('UPDATE cli_processes SET turn_offset = ? WHERE id = ? AND owner_pid = ? AND owner_started = ?').run(turnOffset, id, owner.pid, owner.started),
    );
  }

  /** The fold has read `out.jsonl` up to `offset`, a line's end, at a turn boundary; the offset never goes back. */
  commit(id: string, owner: ProcessIdentity, offset: number): boolean {
    return this.changed(
      this.sql
        .prepare('UPDATE cli_processes SET committed_offset = MAX(committed_offset, ?), turn_offset = NULL WHERE id = ? AND owner_pid = ? AND owner_started = ?')
        .run(offset, id, owner.pid, owner.started),
    );
  }

  /** The sequence number of the last line written to the process's stdin. */
  setStdinSeq(id: string, owner: ProcessIdentity, seq: number): boolean {
    return this.changed(
      this.sql.prepare('UPDATE cli_processes SET stdin_seq = MAX(stdin_seq, ?) WHERE id = ? AND owner_pid = ? AND owner_started = ?').run(seq, id, owner.pid, owner.started),
    );
  }

  delete(id: string): void {
    this.sql.prepare('DELETE FROM cli_processes WHERE id = ?').run(id);
  }

  private changed(result: { changes: number | bigint }): boolean {
    return Number(result.changes) > 0;
  }
}
