import { randomUUID } from 'node:crypto';
import { login, type AccountStore, type LoginSession as CliLogin } from '@claudio/accounts';
import type { AccountLoginSession, AccountLoginState } from '@claudio/shared';

/** The CLI waits for a code the person never pastes; past this it is stopped like a setup sign-in. */
const EXPIRES_MS = 15 * 60_000;
/** How long an ended sign-in stays readable, so a poll that was late still sees how it ended. */
const KEEP_ENDED_MS = 10 * 60_000;

interface Entry {
  session: AccountLoginSession;
  cli: CliLogin;
  /** The sign-in ended because it was cancelled, not because the CLI failed */
  cancelled: boolean;
  /** The 15 minutes passed before the person finished */
  expired: boolean;
  /** A sign-in again of an account that already existed: it stays whatever the outcome */
  existing: boolean;
  timers: NodeJS.Timeout[];
}

const fail = (status: number, message: string): Error => Object.assign(new Error(message), { statusCode: status });

/**
 * The sign-ins of `login` accounts: `claude auth login` in the account's own dir, relayed through
 * the API. Only the URL the CLI printed is kept; the credentials are written by the CLI into the
 * account's dir and are not read here. Held in memory: a sign-in does not outlive the server.
 */
export class AccountLogins {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly store: AccountStore,
    private readonly claude: string | (() => string),
    /** Called once a sign-in succeeded, before it is announced (the default account's clears a saved token) */
    private readonly onSignedIn: (accountId: string) => Promise<void> = () => Promise.resolve(),
    private readonly opts: { expiresMs?: number } = {},
  ) {}

  /** Adds the account and starts its sign-in. */
  async start(request: { alias?: string; email?: string }): Promise<AccountLoginSession> {
    const added = await this.store.add({ kind: 'login', alias: request.alias ?? null });
    return this.run(added.id, request.email, false);
  }

  /** Signs an existing `login` account in again, in its own dir, e.g. when its session expired. */
  async restart(accountId: string): Promise<AccountLoginSession> {
    const ref = this.store.ref(accountId);
    if (ref.kind !== 'login') throw fail(400, `account ${accountId} is not a login account`);
    for (const entry of this.entries.values()) {
      if (entry.session.accountId === accountId && !entry.session.endedAt) return { ...entry.session };
    }
    return this.run(accountId, undefined, true);
  }

  private run(accountId: string, emailInput: string | undefined, existing: boolean): AccountLoginSession {
    const email = emailInput?.trim();
    const cli = login(this.store.ref(accountId), { claude: typeof this.claude === 'function' ? this.claude() : this.claude, ...(email ? { email } : {}) });
    const session: AccountLoginSession = {
      id: randomUUID(),
      accountId,
      state: 'starting',
      url: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      account: null,
    };
    const entry: Entry = { session, cli, cancelled: false, expired: false, existing, timers: [] };
    this.entries.set(session.id, entry);
    entry.timers.push(setTimeout(() => this.expire(session.id), this.opts.expiresMs ?? EXPIRES_MS));
    void cli.url.then((url) => {
      if (url && session.state === 'starting') {
        session.url = url;
        session.state = 'waiting-for-person';
      }
    });
    void cli.done.then((code) => this.finish(entry, code));
    return { ...session };
  }

  private async finish(entry: Entry, code: number): Promise<void> {
    const { session } = entry;
    let state: AccountLoginState = entry.expired ? 'expired' : entry.cancelled ? 'cancelled' : 'failed';
    let account = null;
    if (!entry.cancelled && !entry.expired && code === 0) {
      try {
        account = await this.store.refresh(session.accountId);
        if (entry.existing) await this.store.clearAuthFailed(session.accountId);
        account = this.store.get(session.accountId);
        if (account.signedIn) {
          // A sign-in just proved itself: not expired, checked now
          await this.store.confirm(session.accountId);
          await this.onSignedIn(session.accountId).catch(() => undefined);
          account = this.store.get(session.accountId);
          state = 'succeeded';
        }
      } catch {
        // The account is gone (removed while the CLI ran) or the CLI cannot say: it did not sign in
      }
    }
    if (state !== 'succeeded') {
      // An account that never signed in is an empty dir nobody can use; one that existed stays
      if (!entry.existing) await this.store.remove(session.accountId).catch(() => undefined);
      account = null;
    }
    session.state = state;
    session.account = account;
    session.endedAt = new Date().toISOString();
    for (const t of entry.timers) clearTimeout(t);
    const forget = setTimeout(() => this.entries.delete(session.id), KEEP_ENDED_MS);
    forget.unref();
  }

  private live(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw fail(404, `sign-in ${id} not found`);
    return entry;
  }

  get(id: string): AccountLoginSession {
    return { ...this.live(id).session };
  }

  /** Hands the pasted code to the CLI. */
  submitCode(id: string, code: unknown): AccountLoginSession {
    const entry = this.live(id);
    if (typeof code !== 'string' || !code.trim()) throw new Error('code must be a non-empty string');
    if (entry.session.endedAt) throw fail(409, 'this sign-in is already over');
    entry.cli.submitCode(code);
    return { ...entry.session };
  }

  /** The CLI waited for a code that never came: the sign-in ends as `expired`, not as the person's cancel */
  private expire(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.session.endedAt) return;
    entry.expired = true;
    entry.cli.cancel();
  }

  cancel(id: string): AccountLoginSession {
    const entry = this.live(id);
    if (!entry.session.endedAt) {
      entry.cancelled = true;
      entry.cli.cancel();
    }
    return { ...entry.session };
  }

  /** Stops every open sign-in: the server is closing. */
  close(): void {
    for (const entry of this.entries.values()) {
      for (const t of entry.timers) clearTimeout(t);
      if (!entry.session.endedAt) {
        entry.cancelled = true;
        entry.cli.cancel();
      }
    }
  }
}
