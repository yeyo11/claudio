/*
 * Flow control for one terminal, as pure logic: bytes in, decisions out. The service owns the sockets
 * and the timers and applies what these return; nothing here reads a clock the caller did not hand in.
 */

export const HIGH_WATERMARK = 2 * 1024 * 1024;
export const LOW_WATERMARK = 512 * 1024;
export const EVICT_BYTES = 8 * 1024 * 1024;
/** How often a pause is re-checked, so a stale count can never leave a shell paused */
export const RECHECK_MS = 5000;

/**
 * How long one client may hold the shell paused, while every other client has caught up, before it is
 * let go. Once the shell is paused nothing more is sent, so a client that stopped acknowledging never
 * reaches `EVICT_BYTES` and would hold the others for as long as it stays connected. Five seconds is
 * longer than a tab that is only rendering a burst takes to catch up (t7 measured under a second), and
 * short enough that the others notice a freeze, not a hang. The check runs with the re-check, so the
 * worst case is this plus `RECHECK_MS`.
 */
export const STALL_EVICT_MS = 5000;

export const COALESCE_MS = 4;
export const COALESCE_BYTES = 64 * 1024;
/** A chunk this small, after a quiet spell, is a keystroke's echo and goes at once */
export const ECHO_BYTES = 1024;

export interface FlowDecision {
  /** Pause the PTY (the shell blocks on write, as on a real terminal) */
  pause: boolean;
  /** Let it run again */
  resume: boolean;
  /** Clients to close with `evicted-slow`: they are already removed from the count */
  evict: string[];
}

export interface FlowLimits {
  high: number;
  low: number;
  evict: number;
  /** See {@link STALL_EVICT_MS} */
  stall: number;
}

/**
 * What every attached client has been sent and has acknowledged. A client acknowledges what its
 * xterm has *parsed*, not what arrived: a browser that receives fast and renders slowly is the case
 * that matters. The terminal pauses when any client is more than `high` behind and resumes when all
 * are under `low`; a client more than `evict` behind is let go and reattaches from a snapshot, so it
 * never holds the others hostage. A client that has held the pause for `stall` milliseconds while
 * every other client is under `low` is let go as well; a client that is the only one attached, or one of
 * several that are all behind, is not (there is nobody it is holding hostage, or no telling which to
 * blame), and the shell stays paused for it as on a real terminal. With no client attached output only feeds the screen and never pauses.
 */
export class FlowControl {
  private readonly clients = new Map<string, { sent: number; acked: number }>();
  private paused = false;
  private pausedAt = 0;
  private readonly limits: FlowLimits;

  /** `now` is the clock for the stall limit: milliseconds from any monotonic origin; a test hands in its own */
  constructor(
    limits: Partial<FlowLimits> = {},
    private readonly now: () => number = () => performance.now(),
  ) {
    this.limits = { high: HIGH_WATERMARK, low: LOW_WATERMARK, evict: EVICT_BYTES, stall: STALL_EVICT_MS, ...limits };
  }

  get isPaused(): boolean {
    return this.paused;
  }

  add(client: string): void {
    this.clients.set(client, { sent: 0, acked: 0 });
  }

  /** A client that closes takes its unacknowledged bytes with it, which may be what resumes the shell */
  remove(client: string): FlowDecision {
    this.clients.delete(client);
    return this.evaluate([]);
  }

  /** Bytes written to a client's socket */
  sent(client: string, bytes: number): FlowDecision {
    const state = this.clients.get(client);
    if (state) state.sent += bytes;
    return this.evaluate([]);
  }

  /** The client's xterm has parsed `bytes` more; never more than was sent */
  acked(client: string, bytes: number): FlowDecision {
    const state = this.clients.get(client);
    if (state && Number.isFinite(bytes) && bytes > 0) state.acked = Math.min(state.sent, state.acked + bytes);
    return this.evaluate([]);
  }

  /** The socket's own send buffer, which is behind when the network is */
  buffered(client: string, bufferedAmount: number): FlowDecision {
    return this.evaluate(bufferedAmount > this.limits.evict ? [client] : []);
  }

  unacked(client: string): number {
    const state = this.clients.get(client);
    return state ? state.sent - state.acked : 0;
  }

  /** The periodic re-check: the same evaluation, with nothing new to count */
  recheck(): FlowDecision {
    return this.evaluate([]);
  }

  private evaluate(forced: string[]): FlowDecision {
    const evict = [...forced];
    for (const [client, state] of this.clients) {
      if (state.sent - state.acked > this.limits.evict && !evict.includes(client)) evict.push(client);
    }
    if (this.paused && this.now() - this.pausedAt >= this.limits.stall) {
      // Only a client that is alone in being behind is the one holding the others
      const staying = [...this.clients].filter(([client]) => !evict.includes(client));
      const behindNow = staying.filter(([, s]) => s.sent - s.acked >= this.limits.low);
      if (behindNow.length === 1 && staying.length > 1) evict.push((behindNow[0] as [string, unknown])[0]);
    }
    for (const client of evict) this.clients.delete(client);
    const behind = [...this.clients.values()].map((s) => s.sent - s.acked);
    const decision: FlowDecision = { pause: false, resume: false, evict };
    if (!this.paused && behind.some((b) => b > this.limits.high)) {
      this.paused = true;
      this.pausedAt = this.now();
      decision.pause = true;
    } else if (this.paused && behind.every((b) => b < this.limits.low)) {
      this.paused = false;
      decision.resume = true;
    }
    return decision;
  }
}

export interface CoalescerClock {
  /** Milliseconds, from any monotonic origin */
  now(): number;
  /** Runs `run` once after `ms`; returns what cancels it */
  after(ms: number, run: () => void): () => void;
}

/**
 * Gathers a terminal's output for up to 4 ms or 64 KiB, whichever comes first, and hands it on as
 * one frame; a chunk under 1 KiB arriving after 4 ms of quiet (a keystroke's echo) goes at once.
 */
export class Coalescer {
  private chunks: Buffer[] = [];
  private size = 0;
  private cancel: (() => void) | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly clock: CoalescerClock,
    private readonly emit: (frame: Buffer) => void,
  ) {}

  push(chunk: Buffer): void {
    const now = this.clock.now();
    const quiet = now - this.lastAt >= COALESCE_MS;
    this.lastAt = now;
    if (this.size === 0 && quiet && chunk.length < ECHO_BYTES) {
      this.emit(chunk);
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size >= COALESCE_BYTES) {
      this.flush();
      return;
    }
    this.cancel ??= this.clock.after(COALESCE_MS, () => {
      this.cancel = null;
      this.flush();
    });
  }

  /** Sends what is held, now */
  flush(): void {
    this.cancel?.();
    this.cancel = null;
    if (this.size === 0) return;
    const frame = this.chunks.length === 1 ? (this.chunks[0] as Buffer) : Buffer.concat(this.chunks, this.size);
    this.chunks = [];
    this.size = 0;
    this.emit(frame);
  }

  /** Drops what is held (the terminal ended) */
  discard(): void {
    this.cancel?.();
    this.cancel = null;
    this.chunks = [];
    this.size = 0;
  }
}
