import type { EffectiveEnvironment } from '@claudio/shared';
import type { Db } from './db.ts';

/** Where a chat's environment came from: its own start, or the last start in its folder */
export type EnvironmentSource = 'chat' | 'folder';

/** What `observe` needs: the fold of a process's `init` hands every snapshot here */
export interface EnvironmentSink {
  observe(env: EffectiveEnvironment): void;
}

/**
 * What Claude loaded at each chat's start (tools, MCP servers, agents, skills, slash commands,
 * model), which only a run's `init` event says and the transcript does not keep. Keyed by chat: two
 * chats in one folder load different servers and models, and each shows its own
 * (docs/plans/regression-fixes-2026-10-29.md, C5). A chat that never started here (one from a
 * terminal) is shown the folder's last, labelled as such. The rows live in SQLite, which two
 * processes share; this keeps only the folders' latest, for the panels that ask per folder.
 */
export class EnvironmentIndex implements EnvironmentSink {
  private readonly byDir = new Map<string, EffectiveEnvironment>();

  constructor(private readonly db: Db) {
    for (const env of db.loadEnvironments()) this.byDir.set(env.cwd, env);
  }

  observe(env: EffectiveEnvironment): void {
    const last = this.byDir.get(env.cwd);
    if (!last || last.observedAt <= env.observedAt) this.byDir.set(env.cwd, env);
    try {
      this.db.saveEnvironment(env);
    } catch {
      // the panel only loses this chat's snapshot until its next process
    }
  }

  /** The chat's own snapshot, else its folder's last with `source: 'folder'`; null when there is neither */
  forChat(chatId: string, cwd: string): { env: EffectiveEnvironment; source: EnvironmentSource } | null {
    const own = this.db.environmentOf(chatId);
    if (own) return { env: own, source: 'chat' };
    const folder = this.byDir.get(cwd);
    return folder ? { env: folder, source: 'folder' } : null;
  }

  /** The last snapshot taken in a folder */
  ofDir(cwd: string): EffectiveEnvironment | undefined {
    return this.byDir.get(cwd);
  }

  /** Each folder's last snapshot, newest first */
  latest(): EffectiveEnvironment[] {
    return [...this.byDir.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  }
}
