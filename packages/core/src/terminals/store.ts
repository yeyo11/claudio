import type { DatabaseSync } from 'node:sqlite';
import type { TerminalAttachmentEntry, TerminalEndReason, TerminalHistoryEntry, TerminalHistoryPage, TerminalScope } from '@claudio/shared';

/** The newest rows kept, as the audit log is pruned: the history is for looking back, not an archive */
const KEEP_SESSIONS = 2000;
const KEEP_ATTACHMENTS = 10_000;

export interface SessionRow {
  id: string;
  scope: TerminalScope;
  cwd: string;
  shell: string;
  actor: string;
  client: string;
  serverPid: number;
  startedAt: string;
}

/** A shell a previous server started that is still recorded as running: the input of `reapStrays` */
export interface StraySession {
  id: string;
  pid: number;
  pidStarted: number;
  serverPid: number;
}

interface SessionDb {
  id: string;
  scope: string;
  project_id: string | null;
  chat_id: string | null;
  cwd: string;
  shell: string;
  actor: string;
  client: string;
  started_at: string;
  ended_at: string | null;
  ended_reason: string | null;
  exit_code: number | null;
}

interface AttachmentDb {
  id: number;
  session_id: string;
  actor: string;
  client: string;
  origin: string | null;
  attached_at: string;
  detached_at: string | null;
  bytes_in: number;
  bytes_out: number;
  refused: string | null;
}

const attachment = (row: AttachmentDb): TerminalAttachmentEntry => ({
  actor: row.actor,
  client: row.client,
  origin: row.origin,
  attachedAt: row.attached_at,
  detachedAt: row.detached_at,
  bytesIn: row.bytes_in,
  bytesOut: row.bytes_out,
  refused: row.refused,
});

/**
 * The rows of `terminal_sessions` and `terminal_attachments` (docs/plans/terminal.md, 3.9): who opened
 * which shell and when, how it ended, who attached and how many bytes went each way, and every
 * attempt the gate refused. **Never what was typed or printed**: it can hold passwords.
 */
export class TerminalStore {
  constructor(private readonly db: DatabaseSync) {
    this.prune();
  }

  startSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO terminal_sessions (id, scope, project_id, chat_id, cwd, shell, actor, client, server_pid, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.scope.kind,
        row.scope.kind === 'project' ? row.scope.projectId : null,
        row.scope.kind === 'chat' ? row.scope.chatId : null,
        row.cwd,
        row.shell,
        row.actor,
        row.client,
        row.serverPid,
        row.startedAt,
      );
  }

  /** The shell's pid and when it started, which together tell it from a pid the system reuses */
  setProcess(id: string, pid: number, pidStarted: number | null): void {
    this.db.prepare('UPDATE terminal_sessions SET pid = ?, pid_started = ? WHERE id = ?').run(pid, pidStarted, id);
  }

  /** Records how a session ended; the first ending stands */
  endSession(id: string, reason: TerminalEndReason, exitCode: number | null, at: string): void {
    this.db.prepare('UPDATE terminal_sessions SET ended_at = ?, ended_reason = ?, exit_code = ? WHERE id = ? AND ended_at IS NULL').run(at, reason, exitCode, id);
  }

  /** Sessions still open in the rows: at start-up, before this server owns any, those of a server that is gone */
  strays(): StraySession[] {
    const rows = this.db
      .prepare('SELECT id, pid, pid_started, server_pid FROM terminal_sessions WHERE ended_at IS NULL')
      .all() as Array<{ id: string; pid: number | null; pid_started: number | null; server_pid: number }>;
    return rows.map((r) => ({ id: r.id, pid: r.pid ?? 0, pidStarted: r.pid_started ?? 0, serverPid: r.server_pid }));
  }

  /** An attach, as it opens; returns the row to close when it ends */
  attach(entry: { sessionId: string; actor: string; client: string; origin: string | null; at: string }): number {
    const result = this.db
      .prepare('INSERT INTO terminal_attachments (session_id, actor, client, origin, attached_at) VALUES (?, ?, ?, ?, ?)')
      .run(entry.sessionId, entry.actor, entry.client, entry.origin, entry.at);
    return Number(result.lastInsertRowid);
  }

  detach(id: number, bytesIn: number, bytesOut: number, at: string): void {
    this.db.prepare('UPDATE terminal_attachments SET detached_at = ?, bytes_in = ?, bytes_out = ? WHERE id = ? AND detached_at IS NULL').run(at, bytesIn, bytesOut, id);
  }

  /** Attachments still open when the server stopped: closed with no byte counts, which are lost with the process */
  detachAll(at: string): void {
    this.db.prepare('UPDATE terminal_attachments SET detached_at = ? WHERE detached_at IS NULL AND refused IS NULL').run(at);
  }

  /** An attempt the gate or the socket refused, for the owner to see an injection that tried. `sessionId` is empty when no terminal was named. */
  refuse(entry: { sessionId: string | null; actor: string; client: string; origin: string | null; reason: string; at: string }): void {
    this.db
      .prepare('INSERT INTO terminal_attachments (session_id, actor, client, origin, attached_at, detached_at, refused) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(entry.sessionId ?? '', entry.actor, entry.client, entry.origin, entry.at, entry.at, entry.reason);
  }

  /**
   * The newest sessions first, each with its attachments and refusals. A refusal that named no
   * terminal (a refused `POST /terminals`) is its own entry with an empty id and an empty directory.
   */
  history(limit: number, offset: number): TerminalHistoryPage {
    const sessions = this.db.prepare('SELECT * FROM terminal_sessions ORDER BY started_at DESC, rowid DESC').all() as unknown as SessionDb[];
    const rows = this.db.prepare('SELECT * FROM terminal_attachments ORDER BY id ASC').all() as unknown as AttachmentDb[];
    const bySession = new Map<string, TerminalAttachmentEntry[]>();
    const orphans: TerminalHistoryEntry[] = [];
    for (const row of rows) {
      if (row.session_id === '') {
        orphans.push({
          id: '',
          scope: { kind: 'project', projectId: '', worktree: null },
          cwd: '',
          shell: '',
          actor: row.actor,
          client: row.client,
          startedAt: row.attached_at,
          endedAt: row.attached_at,
          endReason: null,
          exitCode: null,
          attachments: [attachment(row)],
        });
        continue;
      }
      bySession.set(row.session_id, [...(bySession.get(row.session_id) ?? []), attachment(row)]);
    }
    const entries: TerminalHistoryEntry[] = sessions.map((s) => ({
      id: s.id,
      scope: s.scope === 'chat' ? { kind: 'chat', chatId: s.chat_id ?? '' } : { kind: 'project', projectId: s.project_id ?? '', worktree: null },
      cwd: s.cwd,
      shell: s.shell,
      actor: s.actor,
      client: s.client,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      endReason: s.ended_reason as TerminalEndReason | null,
      exitCode: s.exit_code,
      attachments: bySession.get(s.id) ?? [],
    }));
    const all = [...entries, ...orphans].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return { entries: all.slice(offset, offset + limit), total: all.length };
  }

  /** Keeps the newest sessions and attachments, and drops the attachments of a session that went */
  prune(): void {
    this.db
      .prepare('DELETE FROM terminal_sessions WHERE id IN (SELECT id FROM terminal_sessions ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?)')
      .run(KEEP_SESSIONS);
    this.db
      .prepare('DELETE FROM terminal_attachments WHERE id <= COALESCE((SELECT id FROM terminal_attachments ORDER BY id DESC LIMIT 1 OFFSET ?), -1)')
      .run(KEEP_ATTACHMENTS);
  }
}
