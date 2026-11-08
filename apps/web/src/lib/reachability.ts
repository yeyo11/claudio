// Whether this page can reach its server at all: the one store the "server unreachable" screen,
// the reload banner and the lazy routes read (docs/plans/remote-updates.md, D9).
//
// Two things the PWA used to blur are kept apart here. A server that answers with another version is
// an update, and the reload banner handles it. A server that does not answer is a network problem
// (a phone away from home without Tailscale, a laptop with no connection), which a reload cannot
// fix and which must not make every widget print its own error.
//
// A failed call is only a suspicion: one dropped request must not replace the page. So the failure
// is confirmed with a probe of `/api/health`, which is open, cheap and answers from memory. Only a
// probe that gets no answer at all flips the store; any HTTP answer, even an error status, proves
// the server is there. Once flipped, the store retries on its own with a back-off, and at once when
// the browser says the network came back or the tab is looked at again.
import { useSyncExternalStore } from 'react';

export const HEALTH_PATH = '/api/health';
/** A probe this slow is no answer: a phone off its VPN often hangs on packets that go nowhere instead of failing. */
export const PROBE_TIMEOUT_MS = 8_000;
export const BACKOFF_FIRST_MS = 2_000;
export const BACKOFF_MAX_MS = 30_000;
/** A server that answered this recently is not asked again for every chunk or stream hiccup. */
export const REACHABLE_TTL_MS = 5_000;

/**
 * Whether an error is the network failing, as opposed to the server answering badly. `fetch` rejects
 * with a bare `TypeError` when no answer came back at all ("Failed to fetch", "Load failed",
 * "NetworkError…"), and the request layer wraps it as an `ApiRequestError` with status 0. A request
 * that ran out of time (`TimeoutError`, status 408) is a slow route on a live server, and one the
 * caller cancelled (`AbortError`) is nobody's failure: neither counts.
 */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return error.name === 'NetworkError';
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 0;
}

export interface ReachabilityView {
  /** The server did not answer a probe, and no answer has come since */
  readonly unreachable: boolean;
  /** The browser itself says there is no network: the screen says that instead of blaming the server */
  readonly offline: boolean;
  /** When the next automatic attempt runs (epoch ms), or null while one is running or the server is reachable */
  readonly nextAttemptAt: number | null;
  readonly probing: boolean;
}

export interface ReachabilityDeps {
  /** What the probe sends through; the real `fetch` unless a test hands in another */
  fetcher?: typeof fetch;
  online?: () => boolean;
  now?: () => number;
}

const REACHABLE: ReachabilityView = { unreachable: false, offline: false, nextAttemptAt: null, probing: false };

/** What of `window` the store listens to, so the tests can hand in a fake. */
export interface ReachabilityTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  document?: { visibilityState?: string; addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void };
}

export class Reachability {
  private view: ReachabilityView = REACHABLE;
  private readonly listeners = new Set<() => void>();
  private readonly recovered = new Set<() => void>();
  private waiters: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private lastAnswerAt = Number.NEGATIVE_INFINITY;
  private confirming: Promise<boolean> | null = null;
  private readonly fetcher: typeof fetch;
  private readonly online: () => boolean;
  private readonly now: () => number;

  constructor({ fetcher, online, now }: ReachabilityDeps = {}) {
    // Looked up at call time: a test stubs `globalThis.fetch` after this module has loaded
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
    this.online = online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
    this.now = now ?? (() => Date.now());
  }

  snapshot = (): ReachabilityView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Hears every recovery: the app refetches its queries and reopens its feed. Returns what stops listening. */
  onRecovered(listener: () => void): () => void {
    this.recovered.add(listener);
    return () => void this.recovered.delete(listener);
  }

  /** Resolves once the server is reachable; at once when it already is. */
  untilReachable(): Promise<void> {
    if (!this.view.unreachable) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * A call failed as the network does, or the feed dropped, or a chunk would not load: is the server
   * there? Resolves true when it answers (whatever it answers) and false when it does not, in which
   * case the screen is up. Calls made while a probe is out share it. A recent answer is taken as
   * the answer unless `fresh` asks for a probe: a chunk that will not load is the case where the
   * server may have gone down a moment after its last answer, and a wrong "reachable" there is a
   * false "Claudio was updated".
   */
  suspect(fresh = false): Promise<boolean> {
    if (this.view.unreachable) return Promise.resolve(false);
    // The browser saying it has no network only changes the words, never the verdict: the desktop
    // app's server is on this machine (127.0.0.1) and answers with no network at all, and a probe
    // of one that is really out of reach fails at once when the browser is offline
    if (!fresh && this.online() && this.now() - this.lastAnswerAt < REACHABLE_TTL_MS) return Promise.resolve(true);
    this.confirming ??= this.probe().then((answered) => {
      this.confirming = null;
      if (answered) this.lastAnswerAt = this.now();
      else this.markUnreachable();
      return answered;
    });
    return this.confirming;
  }

  /** Any answer from the server, over any route: proof it is there, and the end of the screen if it was up. */
  answered(): void {
    // Every caller is a request that went out to the server (the API, the events stream, the auth
    // probe; the service worker answers none of them from its cache), so this holds offline too
    this.lastAnswerAt = this.now();
    if (this.view.unreachable) this.recover();
  }

  /** Tries now, without waiting for the back-off (the button, `online`, focus, a tab shown again). */
  retryNow(): void {
    if (!this.view.unreachable || this.view.probing) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.set({ ...this.view, nextAttemptAt: null, probing: true });
    void this.probe().then((answered) => {
      // An answer to a call of the page's own may have ended it while the probe was out
      if (!this.view.unreachable) return;
      if (answered) return this.recover();
      this.attempts += 1;
      this.schedule();
    });
  }

  /** Listens for the events that say the network may be back; returns what stops listening. */
  watch(target: ReachabilityTarget): () => void {
    const refresh = (event: 'online' | 'offline') => {
      // Going offline is a reason to look, not a verdict (see `suspect`); coming back, to look again
      if (!this.view.unreachable) {
        if (event === 'offline') void this.suspect(true);
      } else if (this.online()) this.retryNow();
      // The wording depends on `navigator.onLine`, which this event just changed
      if (this.view.unreachable) this.set(this.view);
    };
    const online = () => refresh('online');
    const offline = () => refresh('offline');
    const visible = () => {
      if (target.document?.visibilityState === 'visible') this.retryNow();
    };
    const retry = () => this.retryNow();
    target.addEventListener('online', online);
    target.addEventListener('offline', offline);
    target.addEventListener('focus', retry);
    target.document?.addEventListener('visibilitychange', visible);
    return () => {
      target.removeEventListener('online', online);
      target.removeEventListener('offline', offline);
      target.removeEventListener('focus', retry);
      target.document?.removeEventListener('visibilitychange', visible);
    };
  }

  /** Back to a page that never failed; for the tests, which share the module's one store. */
  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.attempts = 0;
    this.lastAnswerAt = Number.NEGATIVE_INFINITY;
    this.confirming = null;
    this.view = REACHABLE;
    this.waiters = [];
    this.emit();
  }

  private async probe(): Promise<boolean> {
    try {
      await this.fetcher(HEALTH_PATH, { cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return true;
    } catch {
      return false;
    }
  }

  private markUnreachable(): void {
    if (this.view.unreachable) return;
    this.attempts = 0;
    this.lastAnswerAt = Number.NEGATIVE_INFINITY;
    this.set({ unreachable: true, offline: false, nextAttemptAt: null, probing: false });
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    const wait = Math.min(BACKOFF_FIRST_MS * 2 ** this.attempts, BACKOFF_MAX_MS);
    this.set({ unreachable: true, offline: false, nextAttemptAt: this.now() + wait, probing: false });
    this.timer = setTimeout(() => this.retryNow(), wait);
  }

  private recover(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.attempts = 0;
    this.lastAnswerAt = this.now();
    this.set(REACHABLE);
    const waiting = this.waiters;
    this.waiters = [];
    waiting.forEach((resolve) => resolve());
    for (const listener of [...this.recovered]) {
      try {
        listener();
      } catch {
        // that consumer's bug is its own
      }
    }
  }

  private set(next: ReachabilityView): void {
    // The wording follows the browser's own word on the network, read whenever the view is rebuilt
    this.view = next.unreachable ? { ...next, offline: !this.online() } : next;
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

/** One per page; the tests make their own. */
export const reachability = new Reachability();

export function useReachability(): ReachabilityView {
  // `offline` follows `navigator.onLine`, which changes with no event of ours: the view is rebuilt on `online`/`offline`
  return useSyncExternalStore(reachability.subscribe, reachability.snapshot, reachability.snapshot);
}

export const useUnreachable = (): boolean => useReachability().unreachable;
