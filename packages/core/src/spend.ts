import type { SpendCapRefusal, SpendLevel, SpendPurpose, SpendState } from '@claudio/shared';
import type { Db } from './db.ts';

/** Rows older than this are dropped at startup: only today's decide anything. */
export const SPEND_RETENTION_DAYS = 35;

/** The shares at which the level changes, as the usage bars have them. */
const WARN = 0.6;
const BAD = 0.75;

const pad = (n: number): string => String(n).padStart(2, '0');

/** The local `YYYY-MM-DD`, from date parts so it is the server's day whatever the offset. */
export function localDayOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The local day containing `ms`, as `[start, end)` in epoch milliseconds. The end is the next
 * midnight built from date parts, never `+ 24 h`: a day that changes the clock is 23 or 25 hours.
 */
export function localDayWindow(ms: number): { start: number; end: number } {
  const d = new Date(ms);
  return { start: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() };
}

const cents = (usd: number): number => Math.round(usd * 100) / 100;

export interface SpendGateDeps {
  db: Db;
  /** The daily cap in USD; null for none. Read on every check, so a change applies at once. */
  cap: () => number | null;
  /** What waits for the gate right now, for the wait lines; zero without a reader. */
  waiting?: () => { flowRuns: number; orchestrationTasks: number };
  /** The local day a graph was let through the cap, null when it was not. */
  passOf?: (orchestrationId: string) => string | null;
  /** Records today's pass on a graph; the orchestrator keeps it in its document. */
  grant?: (orchestrationId: string, day: string) => unknown;
  /** The local day a flow card was let through the cap, null when it was not. */
  itemPassOf?: (itemId: string) => string | null;
  /** Records today's pass on a flow card; the flow keeps it in its table. */
  grantItem?: (itemId: string, day: string) => void;
  now?: () => number;
}

export interface SpendAllowance {
  /** A person's own request, which they confirmed past the cap */
  override?: boolean;
  /** The graph the start belongs to, which may hold today's pass */
  orchestrationId?: string;
  /** The flow card the start belongs to, which may hold today's pass */
  itemId?: string;
}

/**
 * Today's spend against the daily cap. A start gate, not a kill switch: it answers whether a new
 * unit of work may begin, and never touches what is running. The spend is a sum over the ledger
 * (`spend_ledger`), which every process of the data dir writes, so two of them agree.
 */
export class SpendGate {
  private readonly listeners = new Set<() => void>();
  private readonly alertListeners = new Set<(level: 'warn' | 'exhausted', spend: SpendState) => void>();
  private timer: NodeJS.Timeout | null = null;
  private lastLevel: SpendLevel | null = null;
  private lastDay: string | null = null;

  constructor(private readonly deps: SpendGateDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  state(now: number = this.now()): SpendState {
    const state = this.read(now);
    // Only what waits on the cap: below it, a queued run waits for a free place, not for money. Asked
    // last, since the readers of the waiting counts ask `allows` themselves
    return state.blocked ? { ...state, waiting: this.deps.waiting?.() ?? state.waiting } : state;
  }

  /** The ledger's reading without the waiting counts, which `allows` must not ask for (they ask `allows`). */
  private read(now: number): SpendState {
    const { start, end } = localDayWindow(now);
    const cap = this.deps.cap();
    const { groups, unreported } = this.deps.db.spendBetween(new Date(start).toISOString(), new Date(end).toISOString());
    const byPurpose: Partial<Record<SpendPurpose, number>> = {};
    const byAccountKind = { login: 0, token: 0, apiKey: 0, unknown: 0 };
    let total = 0;
    for (const g of groups) {
      total += g.usd;
      const purpose = g.purpose as SpendPurpose;
      byPurpose[purpose] = (byPurpose[purpose] ?? 0) + g.usd;
      const kind = g.accountKind === 'login' ? 'login' : g.accountKind === 'token' ? 'token' : g.accountKind === 'api-key' ? 'apiKey' : 'unknown';
      byAccountKind[kind] += g.usd;
    }
    for (const purpose of Object.keys(byPurpose) as SpendPurpose[]) byPurpose[purpose] = cents(byPurpose[purpose] ?? 0);
    for (const kind of Object.keys(byAccountKind) as Array<keyof typeof byAccountKind>) byAccountKind[kind] = cents(byAccountKind[kind]);
    // Rounded to cents before it meets the cap, so a cap of 20 reads reached at 20.00 and never "20,00 of 20,00" while open
    const spent = cents(total);
    const share = cap === null ? null : spent / cap;
    const level: SpendLevel = share === null ? 'off' : share >= 1 ? 'exhausted' : share >= BAD ? 'bad' : share >= WARN ? 'warn' : 'ok';
    return {
      day: localDayOf(now),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      capUsd: cap,
      spentUsd: spent,
      share,
      level,
      blocked: level === 'exhausted',
      resetsAt: new Date(end).toISOString(),
      unreported,
      byPurpose,
      byAccountKind,
      waiting: { flowRuns: 0, orchestrationTasks: 0 },
    };
  }

  /**
   * Whether a new unit of work may start. Open below the cap and with no cap; over it, only for a
   * person's override or a graph that holds today's pass. The purpose is not a way round the cap:
   * in-flight work is never asked, so nothing is exempt by what it is for.
   */
  allows(_purpose: SpendPurpose, options: SpendAllowance = {}): boolean {
    if (this.deps.cap() === null) return true;
    if (options.override) return true;
    const now = this.now();
    if (options.orchestrationId && this.deps.passOf?.(options.orchestrationId) === localDayOf(now)) return true;
    if (options.itemId && this.deps.itemPassOf?.(options.itemId) === localDayOf(now)) return true;
    return !this.read(now).blocked;
  }

  /** The 409 body of a person's request refused at the cap. */
  refusal(state: SpendState = this.state()): SpendCapRefusal {
    return { error: 'The daily spend cap was reached; confirm to go on past it.', code: 'spend-cap', spend: state };
  }

  /** Lets a graph run past today's cap. Hears of the change like every other. */
  grantPass(orchestrationId: string): unknown {
    const granted = this.deps.grant?.(orchestrationId, localDayOf(this.now()));
    this.changed();
    return granted;
  }

  /** Lets a flow card run past today's cap, as a graph is let. */
  grantItemPass(itemId: string): string {
    const day = localDayOf(this.now());
    this.deps.grantItem?.(itemId, day);
    this.changed();
    return day;
  }

  /** Fires after a cap change, a level crossing, midnight or a pass; a returned function stops listening. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Hears the first crossing of 75 % and of 100 % each day, whichever process saw it first. */
  onAlert(listener: (level: 'warn' | 'exhausted', spend: SpendState) => void): () => void {
    this.alertListeners.add(listener);
    return () => this.alertListeners.delete(listener);
  }

  /** The cap was set, changed or cleared. */
  capChanged(): void {
    this.changed();
  }

  /** A result was written to the ledger: tells only when the level moved. */
  recorded(): void {
    const state = this.state();
    if (state.level === this.lastLevel && state.day === this.lastDay) return;
    this.lastLevel = state.level;
    this.lastDay = state.day;
    this.notify(state);
  }

  private changed(): void {
    const state = this.state();
    this.lastLevel = state.level;
    this.lastDay = state.day;
    this.notify(state);
  }

  private notify(state: SpendState): void {
    this.alert(state);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // one listener's failure must not keep the others from hearing the gate open
      }
    }
  }

  /** The row decides who raises it: `INSERT OR IGNORE` lets only the process that inserted it emit. */
  private alert(state: SpendState): void {
    if (state.share === null) return;
    const levels: Array<'warn' | 'exhausted'> = [];
    if (state.share >= BAD) levels.push('warn');
    if (state.share >= 1) levels.push('exhausted');
    for (const level of levels) {
      let mine = false;
      try {
        mine = this.deps.db.addSpendAlert(state.day, level);
      } catch {
        // the database closed under a late result: no alert, no crash
      }
      if (!mine) continue;
      for (const listener of [...this.alertListeners]) {
        try {
          listener(level, state);
        } catch {
          // a listener's failure is its own
        }
      }
    }
  }

  /**
   * Fires at every local midnight, from a timer armed again each day from the date parts of the
   * moment it fires (a fixed 24 h would drift an hour over a clock change). `unref`'d, so it never
   * keeps a process alive.
   */
  start(): void {
    this.prune();
    const state = this.state();
    this.lastLevel = state.level;
    this.lastDay = state.day;
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const now = this.now();
    // At least a second, so a timer that fires a few milliseconds early does not spin
    const delay = Math.max(1000, localDayWindow(now).end - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.prune();
      this.changed();
      this.arm();
    }, delay);
    this.timer.unref();
  }

  /** Drops ledger rows and alerts older than the retention. */
  prune(): void {
    const now = this.now();
    const d = new Date(now);
    const cutoff = new Date(d.getFullYear(), d.getMonth(), d.getDate() - SPEND_RETENTION_DAYS).getTime();
    try {
      this.deps.db.pruneSpend(new Date(cutoff).toISOString(), localDayOf(cutoff));
    } catch {
      // housekeeping: the next start tries again
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
    this.alertListeners.clear();
  }
}
