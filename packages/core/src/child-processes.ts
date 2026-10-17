import type { ChildProcess } from 'node:child_process';
import { killGroup } from './processes.ts';

/**
 * The short-lived helpers one owner starts (version and sign-in probes of `gh`, `glab` and the
 * agents' CLIs), so that its shutdown ends them and waits for them to be gone.
 *
 * A child is not ended when the server exits: a probe in its own process group even survives the
 * terminal closing. One the server started a moment before SIGTERM kept running after it and
 * wrote its config home (`glab` its `~/.config/glab-cli`, `gh` its state) into a data dir that was
 * being removed, which is how the packaging test saw ENOTEMPTY on a loaded machine.
 */
export class ChildProcesses {
  private readonly live = new Map<ChildProcess, { exited: Promise<void>; group: boolean }>();
  private closing: Promise<void> | null = null;

  /** True once `close` was called: nothing new should be started for this owner */
  get closed(): boolean {
    return this.closing !== null;
  }

  /**
   * Follows `child` until it exits. `group` says it leads a process group of its own (spawned
   * `detached`), which is then ended whole. One added after `close` is ended at once.
   */
  add(child: ChildProcess, options: { group?: boolean } = {}): void {
    const group = options.group ?? false;
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      const done = (): void => {
        this.live.delete(child);
        resolve();
      };
      child.once('exit', done);
      // A spawn that failed emits `error` and never `exit`
      child.once('error', done);
    });
    this.live.set(child, { exited, group });
    if (this.closing) this.end(child, group);
  }

  /** Ends every child still running and resolves when each one has exited */
  close(): Promise<void> {
    if (!this.closing) {
      // SIGKILL and not SIGTERM: a probe has nothing to save, and a grace period is a window in
      // which it still writes
      for (const [child, { group }] of this.live) this.end(child, group);
      this.closing = this.drain();
    }
    return this.closing;
  }

  // Until the map is empty, not over a snapshot: one added while waiting is waited for too
  private async drain(): Promise<void> {
    while (this.live.size > 0) await Promise.all([...this.live.values()].map((entry) => entry.exited));
  }

  /** How many are running now */
  get size(): number {
    return this.live.size;
  }

  private end(child: ChildProcess, group: boolean): void {
    if (group) killGroup(child, 'SIGKILL');
    else child.kill('SIGKILL');
  }
}
