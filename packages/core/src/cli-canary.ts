import type { ChildProcess } from 'node:child_process';
import { runCanary, type CanaryOptions } from '@claudio/accounts';
import { errorMessage, isCompleteCanary, type CliCanary, type CliCanaryStatus } from '@claudio/shared';
import type { Db } from './db.ts';

export interface CliCanaryWatchOptions {
  db: Pick<Db, 'cliCanary' | 'saveCliCanary'>;
  claude: () => string;
  /** The server's log: a failed canary is said here once, with what it saw */
  log: (line: string) => void;
  /** The owner's children, so a shutdown ends a check still running */
  onSpawn?: (child: ChildProcess) => void;
  /** The result changed (or a run started or ended): the page reads it again */
  changed: () => void;
  /** Whether the owner is shutting down; no run starts after it */
  closed: () => boolean;
  /** `CLAUDIO_CLI_CANARY=off`: nothing runs by itself, and the stored results are still served */
  off?: boolean;
  run?: (opts: CanaryOptions) => Promise<CliCanary>;
}

/**
 * The CLI canary of the account-configuration plan (T5): the first time a CLI version is seen, its
 * three checks run in a temp dir (`runCanary`: free, no account, no turn) and the result is kept per
 * version. A version already checked is never run again by itself, so a restart costs nothing; a
 * person can ask for another run. It only reports: what a failure should change is the owner's call
 * (plan §10, R1), and nothing here changes how accounts are linked.
 */
export class CliCanaryWatch {
  private seen: string | null = null;
  private runningVersion: string | null = null;

  constructor(private readonly opts: CliCanaryWatchOptions) {}

  /** The version the CLI reads now; a run starts when it has no complete result */
  note(version: string | null): void {
    if (!version || version === this.seen) return;
    this.seen = version;
    const stored = this.opts.db.cliCanary(version);
    if (this.opts.off || (stored && isCompleteCanary(stored))) return;
    void this.check(version);
  }

  status(): CliCanaryStatus {
    const version = this.seen;
    return { version, running: this.runningVersion !== null, result: version ? this.opts.db.cliCanary(version) : null };
  }

  /** Runs again for the version in use, whatever is stored; false when there is none or one is running */
  recheck(): boolean {
    if (!this.seen || this.runningVersion) return false;
    void this.check(this.seen);
    return true;
  }

  private async check(version: string): Promise<void> {
    if (this.runningVersion || this.opts.closed()) return;
    this.runningVersion = version;
    this.opts.changed();
    try {
      const result = await (this.opts.run ?? runCanary)({ claude: this.opts.claude(), version, ...(this.opts.onSpawn ? { onSpawn: this.opts.onSpawn } : {}) });
      // A shutdown that came while it ran closed the database: the result is not kept
      if (this.opts.closed()) return;
      this.opts.db.saveCliCanary(result);
      for (const c of result.checks) {
        if (c.state === 'fail') this.opts.log(`cli canary: Claude Code ${version} fails ${c.id}: ${c.observed}`);
      }
    } catch (error) {
      this.opts.log(`cli canary: the checks of Claude Code ${version} did not finish: ${errorMessage(error)}`);
    } finally {
      this.runningVersion = null;
      if (!this.opts.closed()) this.opts.changed();
    }
  }
}
