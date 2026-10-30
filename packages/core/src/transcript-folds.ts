import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { errorMessage } from '@claudio/shared';

/**
 * What one pass over a transcript left, as `transcript_folds` keeps it: the file as it was read
 * (inode, size, mtime), the offset past its last complete line with the bytes just before it, and
 * the listing's fold over the lines up to there. A restart reads the rows instead of the files, and
 * goes on from `end` for a file that only grew (docs/plans/regression-fixes-2026-10-29.md, C7).
 */
export interface TranscriptFoldRow {
  path: string;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Offset just past the last complete line: everything before it is folded */
  end: number;
  /** The bytes just before `end`, which a file that only grew still has there */
  fingerprint: Buffer;
  /** The fold, as `sessions.ts` serialises it; a row it cannot read is folded again */
  fold: string;
}

/**
 * The rows of `transcript_folds`. A listing writes hundreds of rows at once after a cold start, so
 * writes wait for the next tick and go in one transaction, like the placements of `repos.ts`; they
 * are a cache of the files, and one that is lost costs a read of that file again, never a wrong list.
 */
export class TranscriptFolds {
  private readonly allStmt: StatementSync;
  private readonly upsertStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly pending = new Map<string, TranscriptFoldRow | null>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly db: DatabaseSync) {
    this.allStmt = db.prepare('SELECT path, ino, size, mtime_ms, end_offset, fingerprint, summary_json FROM transcript_folds');
    this.upsertStmt = db.prepare(
      `INSERT INTO transcript_folds (path, ino, size, mtime_ms, end_offset, fingerprint, summary_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         ino = excluded.ino, size = excluded.size, mtime_ms = excluded.mtime_ms, end_offset = excluded.end_offset,
         fingerprint = excluded.fingerprint, summary_json = excluded.summary_json, updated_at = excluded.updated_at`,
    );
    this.deleteStmt = db.prepare('DELETE FROM transcript_folds WHERE path = ?');
  }

  /** Every row, read once when a listing starts from nothing; writes still waiting win over what is stored. */
  all(): Map<string, TranscriptFoldRow> {
    const rows = new Map<string, TranscriptFoldRow>();
    for (const row of this.allStmt.all() as Array<Record<string, unknown>>) {
      const fingerprint = row.fingerprint;
      if (typeof row.path !== 'string' || typeof row.summary_json !== 'string' || !(fingerprint instanceof Uint8Array)) continue;
      rows.set(row.path, {
        path: row.path,
        ino: Number(row.ino),
        size: Number(row.size),
        mtimeMs: Number(row.mtime_ms),
        end: Number(row.end_offset),
        fingerprint: Buffer.from(fingerprint),
        fold: row.summary_json,
      });
    }
    for (const [path, row] of this.pending) {
      if (row) rows.set(path, row);
      else rows.delete(path);
    }
    return rows;
  }

  put(row: TranscriptFoldRow): void {
    this.pending.set(row.path, row);
    this.schedule();
  }

  drop(path: string): void {
    this.pending.set(path, null);
    this.schedule();
  }

  private schedule(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 0);
    this.flushTimer.unref();
  }

  /** Writes what is waiting now; a failure is logged, never thrown at a list. */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pending.size) return;
    const rows = [...this.pending];
    this.pending.clear();
    const at = new Date().toISOString();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const [path, row] of rows) {
          if (row) this.upsertStmt.run(path, row.ino, row.size, row.mtimeMs, row.end, row.fingerprint, row.fold, at);
          else this.deleteStmt.run(path);
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      // A fold is a cache of the file: the next start reads these transcripts again
      console.warn(`transcript_folds: ${rows.length} rows were not recorded: ${errorMessage(err)}`);
    }
  }
}
