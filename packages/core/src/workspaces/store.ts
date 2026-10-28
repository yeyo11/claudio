import type { DatabaseSync } from 'node:sqlite';
import type { Workspace } from '@claudio/shared';

interface Row {
  id: string;
  source: string;
  host: string | null;
  bytes: number;
  files: number;
  top_dir: string | null;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  state: string;
  removed_at: string | null;
}

/** A workspace with what only the server reads: its working directory inside the folder, and when it went */
export interface WorkspaceRecord extends Workspace {
  topDir: string | null;
  removedAt: string | null;
}

const recordOf = (r: Row): WorkspaceRecord => ({
  id: r.id,
  source: r.source === 'url' ? 'url' : 'upload',
  host: r.host,
  bytes: r.bytes,
  files: r.files,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
  state: r.state === 'ready' ? 'ready' : r.state === 'removing' ? 'removing' : 'creating',
  topDir: r.top_dir,
  removedAt: r.removed_at,
});

/**
 * The `workspaces` rows. Rows rather than a file, since workspaces come and go and two processes
 * may share the data dir. A removed workspace keeps its row (with `removed_at`) for a while, so a
 * chat that names it learns it expired (`410`) rather than that it never was (`404`).
 */
export class WorkspaceStore {
  constructor(private readonly sql: DatabaseSync) {}

  /**
   * Inserts a `creating` row when fewer than `max` workspaces exist, the ones being created
   * included. One immediate transaction, so two creations at the cap cannot both pass the count,
   * from one process or two.
   */
  reserve(row: { id: string; source: Workspace['source']; host: string | null; at: string; expiresAt: string }, max: number): boolean {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const { n } = this.sql.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE removed_at IS NULL').get() as { n: number };
      if (n >= max) {
        this.sql.exec('ROLLBACK');
        return false;
      }
      this.sql
        .prepare(`INSERT INTO workspaces (id, source, host, bytes, files, top_dir, created_at, last_used_at, expires_at, state) VALUES (?, ?, ?, 0, 0, NULL, ?, ?, ?, 'creating')`)
        .run(row.id, row.source, row.host, row.at, row.at, row.expiresAt);
      this.sql.exec('COMMIT');
      return true;
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
  }

  ready(id: string, done: { bytes: number; files: number; topDir: string | null; at: string; expiresAt: string }): void {
    this.sql
      .prepare(`UPDATE workspaces SET state = 'ready', bytes = ?, files = ?, top_dir = ?, last_used_at = ?, expires_at = ? WHERE id = ?`)
      .run(done.bytes, done.files, done.topDir, done.at, done.expiresAt, id);
  }

  get(id: string): WorkspaceRecord | null {
    const row = this.sql.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined;
    return row ? recordOf(row) : null;
  }

  /** The workspaces that still have a folder, or are making one */
  current(): WorkspaceRecord[] {
    return (this.sql.prepare('SELECT * FROM workspaces WHERE removed_at IS NULL ORDER BY created_at').all() as unknown as Row[]).map(recordOf);
  }

  /** Bytes of the finished workspaces; the ones being created are counted by whoever creates them */
  readyBytes(): number {
    const { total } = this.sql.prepare(`SELECT COALESCE(SUM(bytes), 0) AS total FROM workspaces WHERE removed_at IS NULL AND state = 'ready'`).get() as { total: number };
    return total;
  }

  touch(id: string, at: string, expiresAt: string): void {
    this.sql.prepare(`UPDATE workspaces SET last_used_at = ?, expires_at = ? WHERE id = ? AND state = 'ready' AND removed_at IS NULL`).run(at, expiresAt, id);
  }

  /** Claims the removal: false when another caller already did, or the workspace is gone */
  startRemoving(id: string): boolean {
    return Number(this.sql.prepare(`UPDATE workspaces SET state = 'removing' WHERE id = ? AND state != 'removing' AND removed_at IS NULL`).run(id).changes) === 1;
  }

  removed(id: string, at: string): void {
    this.sql.prepare(`UPDATE workspaces SET state = 'removing', removed_at = ? WHERE id = ?`).run(at, id);
  }

  /** A creation that failed leaves nothing behind, its row included */
  forget(id: string): void {
    this.sql.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  pruneRemoved(before: string): number {
    return Number(this.sql.prepare('DELETE FROM workspaces WHERE removed_at IS NOT NULL AND removed_at < ?').run(before).changes);
  }
}
