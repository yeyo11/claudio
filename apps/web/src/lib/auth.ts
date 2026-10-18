import { useSyncExternalStore } from 'react';
import type { AuthMode, ClaimHostResult, HostRefusal } from '@claudio/shared';

/*
 * The credential this browser sends, and what happens when the API refuses it.
 *
 * Claudio is unguarded by default, so nothing here runs for a local install: the token is only
 * read from storage, and the challenge state only appears once a route has answered 401. The
 * 401's body carries the mode, which is how the UI knows what to ask for without an open route
 * to ask first.
 */

const TOKEN_KEY = 'claudio.token';

let token: string | null = read();

function read(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // private mode: the token lives for this page only
  }
}

export function getToken(): string | null {
  return token;
}

export function setToken(value: string | null): void {
  token = value?.trim() || null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // the token still applies to this page
  }
}

/** The header every `fetch` carries; nothing at all when no token is stored. */
export function authHeaders(): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * The credential in the query string, for the three GETs the browser makes itself: the two
 * `EventSource` streams and an attachment's `<img src>`. Nothing else may use it — a token in a
 * URL ends up in access logs, and anything called with `fetch` can send the header instead.
 */
export function withToken(url: string): string {
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

// ---------- the 401 state ----------

let challenge: AuthMode | null = null;
// The 401 says the owner token a container made on its first start has not been used yet
let firstRunToken = false;
// The 421 says this host is not one the wrapper answers to: the app shows that instead of a shell
let hostRefusal: HostRefusal | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** A route answered 401: the whole UI is replaced by the sign-in screen until one succeeds. */
export function setChallenge(mode: AuthMode | null, firstRun = false): void {
  const pending = mode !== null && firstRun;
  if (challenge === mode && firstRunToken === pending) return;
  challenge = mode;
  firstRunToken = pending;
  emit();
}

/** The 401's body, as far as the sign-in screen reads it */
export function challengeOf(body: unknown): { mode: AuthMode; firstRunToken: boolean } {
  const { mode, firstRunToken: first } = (body ?? {}) as { mode?: AuthMode; firstRunToken?: unknown };
  return { mode: mode ?? 'token', firstRunToken: first === true };
}

/** A 421 body this wrapper wrote, or null for any other answer (a proxy's page) */
export function hostRefusalOf(body: unknown): HostRefusal | null {
  const refusal = body as Partial<HostRefusal> | null;
  return refusal?.code === 'host-not-allowed' && typeof refusal.host === 'string' ? (refusal as HostRefusal) : null;
}

export function setHostRefusal(refusal: HostRefusal | null): void {
  if (hostRefusal === refusal) return;
  hostRefusal = refusal;
  emit();
}

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

export function useAuthChallenge(): AuthMode | null {
  const read = () => challenge;
  return useSyncExternalStore(subscribe, read, read);
}

/** The challenge is for the token a container printed on its first start */
export function useFirstRunToken(): boolean {
  const read = () => firstRunToken;
  return useSyncExternalStore(subscribe, read, read);
}

export function useHostRefusal(): HostRefusal | null {
  const read = () => hostRefusal;
  return useSyncExternalStore(subscribe, read, read);
}

// ---------- the first answer ----------

/** Guarded, and the cheapest read the API has: a small settings document, no CLI involved. */
const PROBE_PATH = '/api/security/auth';
/** A wrapper this slow to answer gets its shell anyway, and the first 401 still brings the sign-in. */
const PROBE_WAIT_MS = 1500;

// Settled unless a probe is running, so a page that never probes (a test) renders as it did
let settled = true;

function settle(): void {
  if (settled) return;
  settled = true;
  emit();
}

/**
 * Asks once, before the shell mounts, whether this browser's credential is accepted. Without it a
 * guarded wrapper first draws the whole shell as skeletons, and only swaps in the sign-in screen
 * when the first of its requests comes back 401: on a phone that flash is most of a second.
 */
export async function probeAuth(fetcher: typeof fetch = fetch, waitMs = PROBE_WAIT_MS): Promise<void> {
  settled = false;
  const timer = setTimeout(settle, waitMs);
  try {
    const res = await fetcher(PROBE_PATH, { headers: authHeaders() });
    if (res.status === 401) {
      const { mode, firstRunToken: first } = challengeOf(await res.json().catch(() => null));
      setChallenge(mode, first);
    } else if (res.status === 421) {
      setHostRefusal(hostRefusalOf(await res.json().catch(() => null)));
    }
  } catch {
    // Unreachable is not refused: the shell has its own way of saying the API is down
  } finally {
    clearTimeout(timer);
    settle();
  }
}

/** False while the first probe is out: the app draws nothing rather than a shell it may take back. */
export function useAuthSettled(): boolean {
  const read = () => settled;
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Stores a credential and proves it before the UI comes back: `GET /api/overview` is guarded, so
 * a token that is not accepted fails here instead of on every page at once.
 */
export async function signIn(credential: string): Promise<boolean> {
  const previous = token;
  setToken(credential);
  try {
    const res = await fetch('/api/overview', { headers: authHeaders(), signal: AbortSignal.timeout(15_000) });
    if (res.status === 401) {
      setToken(previous);
      return false;
    }
    setChallenge(null);
    return true;
  } catch (error) {
    setToken(previous);
    throw error;
  }
}

export type ClaimOutcome = { status: 'claimed'; result: ClaimHostResult } | { status: 'rejected' } | { status: 'rate-limited'; waitMs: number } | { status: 'refused'; message: string };

/**
 * Proves the owner's token against the one route a refused host may still reach, which adds the host
 * to the allowlist. The token is kept only when it was accepted, so a wrong one leaves the browser as
 * it was.
 */
export async function claimHost(credential: string): Promise<ClaimOutcome> {
  const res = await fetch('/api/security/allowed-hosts/claim', {
    method: 'POST',
    headers: { authorization: `Bearer ${credential.trim()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) {
    setToken(credential);
    return { status: 'claimed', result: (await res.json()) as ClaimHostResult };
  }
  if (res.status === 401) return { status: 'rejected' };
  if (res.status === 429) {
    const seconds = Number(res.headers.get('retry-after'));
    return { status: 'rate-limited', waitMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000 };
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return { status: 'refused', message: body?.error ?? `HTTP ${res.status}` };
}
