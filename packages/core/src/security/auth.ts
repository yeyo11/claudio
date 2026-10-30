import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AuthConfig, AuthMode, AuthTokenResult, OidcConfig, SetAuthTokenRequest, UpdateAuthConfigRequest } from '@claudio/shared';
import { writeAtomic } from '../config/files.ts';
import type { AuthEnv, CoreConfig } from '../paths.ts';
import { ChatTokenStore, chatActor } from './chat-tokens.ts';
import { OidcVerifier } from './oidc.ts';
import { errorMessage } from '@claudio/shared';

/**
 * What is on disk. The token itself is never here: only its SHA-256, so a stolen data volume
 * yields nothing that can be replayed against the API, and no route can echo it back.
 */
interface StoredAuth {
  mode: AuthMode;
  tokenHash?: string;
  /** Names the credential in an audit row, so rotating the token is visible in the history */
  tokenId?: string;
  tokenCreatedAt?: string;
  /**
   * SHA-256 of the last `CLAUDIO_AUTH_TOKEN` that `CLAUDIO_AUTH_TOKEN_RESET` applied. A deployment
   * that leaves the variable set would otherwise undo, on every restart, a token rotated since.
   */
  envResetHash?: string;
  oidc?: OidcConfig;
  readOnly: boolean;
  /**
   * The owner token a container made for itself the first time it started (D3 of
   * docs/plans/container-polish.md). `pending` holds until a request first authenticates with it;
   * `generatedAt` stays, so the one-time migration of an older install never runs twice.
   */
  firstRun?: { generatedAt: string; pending: boolean };
  /** When a person chose `none` in Settings: a later start must not generate a first-run token over it */
  noneChosenAt?: string;
}

/** Names the token a container generated, in an audit row and as `tokenId` */
export const FIRST_RUN_TOKEN_ID = 'first-run';
/** Beside `auth.json`: the token, until it is first used, because `docker logs` is easy to lose */
export const FIRST_RUN_TOKEN_FILE = 'first-run-token';

/** The variables that say how access is configured: any of them set means the deployment decided */
const AUTH_DECIDING_KEYS = ['CLAUDIO_AUTH_MODE', 'CLAUDIO_AUTH_TOKEN', 'CLAUDIO_OIDC_ISSUER'] as const;

const DEFAULTS: StoredAuth = { mode: 'none', readOnly: false };

/** Who a request made with the desktop app's per-launch secret is, in an audit row and to the guard. */
export const DESKTOP_ACTOR = 'desktop';
/** Same floor as a token someone chooses: the app generates 32 random bytes, and less is a mistake. */
const MIN_SECRET_LENGTH = 24;

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** Compares digests, which are the same length, so the comparison cannot leak by timing out early. */
function sameSecret(presented: string, storedHex: string): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  const digest = sha256(presented);
  return stored.length === digest.length && timingSafeEqual(stored, digest);
}

function parseMode(value: unknown): AuthMode {
  if (value === 'none' || value === 'token' || value === 'oidc') return value;
  throw new Error("mode must be 'none', 'token' or 'oidc'");
}

function parseOidc(value: unknown): OidcConfig {
  if (typeof value !== 'object' || value === null) throw new Error('oidc must be an object');
  const { issuer, audience, clientId } = value as Record<string, unknown>;
  if (typeof issuer !== 'string' || !issuer.trim()) throw new Error('oidc.issuer is required');
  if (typeof audience !== 'string' || !audience.trim()) throw new Error('oidc.audience is required');
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error('oidc.issuer must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('oidc.issuer must be an http(s) URL');
  return {
    issuer: issuer.trim(),
    audience: audience.trim(),
    clientId: typeof clientId === 'string' ? clientId.trim() : '',
  };
}

/**
 * How the API is guarded, and the only thing that can answer "may this request in?".
 *
 * `none` is the default, because a local install behind loopback has always worked that way and
 * turning a guard on by itself would lock people out of their own wrapper on upgrade. The
 * environment can hand a fresh install its mode and token (a Helm chart with a Secret, a compose
 * file), and from then on the document in the data dir is what counts.
 */
export class AuthStore {
  private readonly file: string;
  private stored: StoredAuth = { ...DEFAULTS };
  private readonly oidcVerifier: OidcVerifier;
  /**
   * When this start replaced the token from the environment. The store has no database, so the
   * owner of both writes the audit row; nothing else should read it.
   */
  readonly environmentReset: { at: string } | null = null;
  /**
   * Awaited before the mode turns to `none`, so whatever must not outlive the guard (the tunnel)
   * is gone before the first unguarded request can arrive. Set by the owner of both, like the audit.
   */
  beforeUnguarded: (() => Promise<void>) | null = null;
  /**
   * SHA-256 of the secret the desktop app handed the server it spawned (`CLAUDIO_DESKTOP_TOKEN`),
   * so its tray can read the state under whatever guard the owner turned on from the Security
   * panel, whose token the app never sees. It lives in this process only: it is not part of
   * `StoredAuth`, so no write puts it on disk, and a new launch brings a new one.
   */
  private readonly desktopHash: string | null;
  /**
   * The tokens minted for the CLI processes Claudio spawns. Held here, beside the guard that reads
   * them, and never in `StoredAuth`: they live exactly as long as this process does.
   */
  readonly chatTokens: ChatTokenStore;
  /** When this start generated the first-run token; the owner of the store writes the audit row, like `environmentReset` */
  readonly firstRunGenerated: { at: string } | null;
  /** Called with the first request's time when it authenticates with the first-run token, for the same reason */
  onFirstRunUsed: ((at: string) => void) | null = null;
  private readonly tokenFile: string;
  private readonly announce: (text: string) => void;

  constructor(
    config: CoreConfig,
    env: AuthEnv = config.authEnv,
    verifier = new OidcVerifier(),
    chatTokens = new ChatTokenStore(),
    /** Where the first-run block and the start-up notes go: standard output on a server, a capture in a test */
    announce: (text: string) => void = (text) => process.stdout.write(text),
  ) {
    this.chatTokens = chatTokens;
    this.announce = announce;
    this.file = join(config.dataDir, 'auth.json');
    this.tokenFile = join(config.dataDir, FIRST_RUN_TOKEN_FILE);
    this.oidcVerifier = verifier;
    const desktop = env.CLAUDIO_DESKTOP_TOKEN?.trim();
    // Starting with a secret too short to be one would hand the guard a guessable way in
    if (desktop && desktop.length < MIN_SECRET_LENGTH) throw new Error(`CLAUDIO_DESKTOP_TOKEN must be at least ${String(MIN_SECRET_LENGTH)} characters`);
    this.desktopHash = desktop ? sha256(desktop).toString('hex') : null;
    if (existsSync(this.file)) {
      try {
        this.stored = { ...DEFAULTS, ...(JSON.parse(readFileSync(this.file, 'utf8')) as StoredAuth) };
      } catch (error) {
        // Falling back to the default would open a wrapper that was closed, so nothing starts
        // until a person looks at the file: an unreadable guard is not an absent one.
        throw new Error(`${this.file} is not readable as JSON (${errorMessage(error)}); fix or delete it`);
      }
      const reset = resetFromEnvironment(env, this.stored);
      if (reset) {
        this.stored = reset;
        this.environmentReset = { at: reset.tokenCreatedAt ?? new Date().toISOString() };
        this.persistSync();
      }
    } else {
      this.stored = fromEnvironment(env);
      if (this.stored.mode !== 'none' || this.stored.readOnly) this.persistSync();
    }
    this.firstRunGenerated = this.firstRunOnStart(config.distribution, env);
  }

  /**
   * In a container nothing is "this machine", so under `none` the terminal and in-app updates could
   * never work, and every device on the published port drives chats unguarded. A start with no
   * authentication variable therefore makes an owner token, once: for a new install, and for an
   * older one that still says `none` and never chose it.
   */
  private firstRunOnStart(distribution: string | undefined, env: AuthEnv): { at: string } | null {
    if (distribution !== 'docker') return null;
    const decided = AUTH_DECIDING_KEYS.some((key) => Boolean(env[key]?.trim()));
    if (decided) {
      if (env.CLAUDIO_AUTH_MODE?.trim() === 'none') this.announce('Claudio: CLAUDIO_AUTH_MODE=none keeps access open, so the terminal and in-app updates are unavailable until access is protected with a token.\n');
      return null;
    }
    if (this.stored.mode === 'none' && !this.stored.firstRun && !this.stored.noneChosenAt) {
      const token = randomBytes(32).toString('base64url');
      const at = new Date().toISOString();
      this.stored = {
        ...this.stored,
        mode: 'token',
        tokenHash: sha256(token).toString('hex'),
        tokenId: FIRST_RUN_TOKEN_ID,
        tokenCreatedAt: at,
        firstRun: { generatedAt: at, pending: true },
      };
      this.persistSync();
      // 0600 and the server's user: whoever reads /data owns the install already
      writeFileSync(this.tokenFile, `${token}\n`, { mode: 0o600 });
      this.announce(firstRunBlock(token));
      return { at };
    }
    if (this.stored.firstRun?.pending) {
      this.announce(`Claudio: the owner token made on first start has not been used yet; it is in ${FIRST_RUN_TOKEN_FILE} in the data directory.\n`);
    }
    return null;
  }

  /** The first-run token has not yet authenticated a request, so the sign-in screen says where to find it */
  get firstRunPending(): boolean {
    return this.stored.firstRun?.pending === true;
  }

  /** Done with the token's file: first use, a rotation or a removal */
  private settleFirstRun(): void {
    rmSync(this.tokenFile, { force: true });
    if (this.stored.firstRun?.pending) this.stored = { ...this.stored, firstRun: { ...this.stored.firstRun, pending: false } };
  }

  private async persist(): Promise<void> {
    await writeAtomic(this.file, `${JSON.stringify(this.stored, null, 2)}\n`, 0o600);
  }

  /** The constructor cannot await, and a guard the environment asked for must be on disk before the first request. */
  private persistSync(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // Same rename as `writeAtomic`: writing in place would leave an existing document at whatever
    // mode it already had, because `mode` only applies to a file being created.
    const tmp = `${this.file}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.stored, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /**
   * Whether a word is the owner's token, the desktop app's or a chat's, compared by hash: for
   * masking it where it should not travel, never for access.
   */
  isOwnSecret(word: string): boolean {
    if (this.stored.tokenHash && sameSecret(word, this.stored.tokenHash)) return true;
    if (this.desktopHash && sameSecret(word, this.desktopHash)) return true;
    return this.chatTokens.holds(word);
  }

  /** The public shape: mode, whether a token exists, the OIDC fields — never the token. */
  get config(): AuthConfig {
    return {
      mode: this.stored.mode,
      tokenSet: Boolean(this.stored.tokenHash),
      ...(this.stored.oidc ? { oidc: this.stored.oidc } : {}),
      readOnly: this.stored.readOnly,
      firstRunPending: this.firstRunPending,
      firstRunToken: Boolean(this.stored.tokenHash) && this.stored.tokenId === FIRST_RUN_TOKEN_ID,
    };
  }

  get mode(): AuthMode {
    return this.stored.mode;
  }

  get readOnly(): boolean {
    return this.stored.readOnly;
  }

  async update(request: UpdateAuthConfigRequest): Promise<AuthConfig> {
    if (typeof request !== 'object' || request === null) throw new Error('body must be a JSON object');
    const next: StoredAuth = { ...this.stored };
    if (request.oidc !== undefined) {
      if (request.oidc === null) delete next.oidc;
      else next.oidc = parseOidc(request.oidc);
    }
    if (request.readOnly !== undefined) {
      if (typeof request.readOnly !== 'boolean') throw new Error('readOnly must be a boolean');
      next.readOnly = request.readOnly;
    }
    if (request.mode !== undefined) {
      const mode = parseMode(request.mode);
      // Turning a mode on without what it needs would lock everyone out on the next request
      if (mode === 'token' && !next.tokenHash) throw new Error('set a token before turning on token authentication');
      if (mode === 'oidc' && !next.oidc) throw new Error('configure the issuer and the audience before turning on OIDC');
      next.mode = mode;
      // A person who chose it must not have it undone by a later start (the migration)
      if (mode === 'none') next.noneChosenAt = new Date().toISOString();
    }
    if (next.mode === 'none' && this.stored.mode !== 'none') await this.beforeUnguarded?.();
    this.stored = next;
    this.oidcVerifier.reset();
    await this.persist();
    return this.config;
  }

  /**
   * Sets or rotates the bearer token and returns it once, which is the only time it exists outside
   * the caller. A token Claudio generates is 32 random bytes: long enough that guessing it is not
   * a strategy, short enough to paste.
   */
  async setToken(request: SetAuthTokenRequest = {}): Promise<AuthTokenResult> {
    const given = typeof request.token === 'string' ? request.token.trim() : '';
    if (request.token !== undefined && typeof request.token !== 'string') throw new Error('token must be a string');
    if (given && given.length < MIN_SECRET_LENGTH) throw new Error('a token of your own must be at least 24 characters, so that guessing it stays out of reach of an attacker who can try many');
    const token = given || randomBytes(32).toString('base64url');
    const createdAt = new Date().toISOString();
    this.stored = {
      ...this.stored,
      tokenHash: sha256(token).toString('hex'),
      tokenId: randomBytes(4).toString('hex'),
      tokenCreatedAt: createdAt,
    };
    // A token of the owner's own replaces the generated one, which must not stay readable on disk
    this.settleFirstRun();
    await this.persist();
    return { token, createdAt };
  }

  /** Removes the token. Refused while it is the credential in use, which would lock everyone out. */
  async clearToken(): Promise<AuthConfig> {
    if (this.stored.mode === 'token') throw new Error('switch the mode away from `token` before removing the token');
    // `envResetHash` stays: forgetting it would let a variable still set re-apply a token removed on purpose
    const { tokenHash: _hash, tokenId: _id, tokenCreatedAt: _createdAt, ...rest } = this.stored;
    this.stored = rest;
    this.settleFirstRun();
    await this.persist();
    return this.config;
  }

  /**
   * Whether `credential` is the desktop app's per-launch secret, sent from this machine, whatever the
   * mode. Under `none` `actorFor` answers `local` for anything, so the four update writes the desktop
   * shell makes ask this instead (docs/plans/unified-updates.md, D8).
   */
  isDesktopCredential(credential: string | undefined, fromLocalMachine: boolean): boolean {
    return fromLocalMachine && credential !== undefined && this.desktopHash !== null && sameSecret(credential, this.desktopHash);
  }

  /**
   * Who is knocking, from the credential they presented: a token id, an OIDC subject, `desktop`
   * for the desktop app's own secret, or `local` when nothing guards the API. `null` means the
   * credential is not good, and the caller answers 401 without saying which part of it was wrong.
   *
   * `fromLocalMachine` is the caller's word that the request came from this machine and was not
   * relayed (a tunnel, a proxy): the desktop secret is only ever sent by the app beside the
   * server, so anywhere else it is refused like any wrong token.
   */
  async actorFor(credential: string | undefined, fromLocalMachine = false): Promise<string | null> {
    if (this.stored.mode === 'none') return 'local';
    if (!credential) return null;
    if (fromLocalMachine && this.desktopHash && sameSecret(credential, this.desktopHash)) return DESKTOP_ACTOR;
    if (this.stored.mode === 'token') {
      if (!this.stored.tokenHash || !sameSecret(credential, this.stored.tokenHash)) return null;
      const id = this.stored.tokenId ?? 'default';
      if (id === FIRST_RUN_TOKEN_ID && this.stored.firstRun?.pending) {
        this.settleFirstRun();
        this.onFirstRunUsed?.(new Date().toISOString());
        try {
          await this.persist();
        } catch {
          // The request is already authenticated; the flag is retried by the next write
        }
      }
      return `token:${id}`;
    }
    const oidc = this.stored.oidc;
    if (!oidc) return null;
    try {
      return await this.oidcVerifier.verify(credential, oidc);
    } catch {
      return null;
    }
  }

  /**
   * Who is calling, by the owner's token or a chat's own, whatever the mode: the OpenAI-compatible
   * routes ask for a credential even under `mode: 'none'`, where `actorFor` lets anything in, because
   * a request there starts a chat that may run commands. Null when the credential is neither, which
   * includes every credential on an install with no token set.
   */
  credentialActorFor(credential: string | undefined, fromLocalChat: boolean): string | null {
    if (!credential) return null;
    if (this.stored.tokenHash && sameSecret(credential, this.stored.tokenHash)) return `token:${this.stored.tokenId ?? 'default'}`;
    if (!fromLocalChat) return null;
    const chatId = this.chatTokens.verify(credential);
    return chatId === null ? null : chatActor(chatId);
  }

  /**
   * The actor behind a chat token, or null. Only under a guard: under `mode: 'none'` every request
   * is `local` and nothing is looked up. `fromLocalChat` is the caller's word that the request came
   * from a loopback peer, was dialled on a loopback name and carries no forwarding header: a tunnel
   * arrives from 127.0.0.1 too, so the peer alone would let a leaked chat token in from anywhere.
   */
  chatActorFor(credential: string, fromLocalChat: boolean): string | null {
    if (this.stored.mode === 'none' || !fromLocalChat) return null;
    const chatId = this.chatTokens.verify(credential);
    return chatId === null ? null : chatActor(chatId);
  }
}

/**
 * A fresh install takes its guard from the environment, so an image can be deployed already
 * closed. `CLAUDIO_AUTH_TOKEN` is hashed on the way in like any other: the variable is read once
 * and its value is never written down.
 */
function fromEnvironment(env: AuthEnv): StoredAuth {
  const stored: StoredAuth = { ...DEFAULTS };
  const token = env.CLAUDIO_AUTH_TOKEN?.trim();
  if (token) {
    stored.tokenHash = sha256(token).toString('hex');
    stored.tokenId = 'env';
    stored.tokenCreatedAt = new Date().toISOString();
    stored.mode = 'token';
    // Seeding already applied this value, so a reset flag left on does not apply it a second time
    if (flagOn(env.CLAUDIO_AUTH_TOKEN_RESET)) stored.envResetHash = stored.tokenHash;
  }
  const issuer = env.CLAUDIO_OIDC_ISSUER?.trim();
  const audience = env.CLAUDIO_OIDC_AUDIENCE?.trim();
  if (issuer && audience) {
    stored.oidc = { issuer, audience, clientId: env.CLAUDIO_OIDC_CLIENT_ID?.trim() ?? '' };
    stored.mode = 'oidc';
  }
  const mode = env.CLAUDIO_AUTH_MODE?.trim();
  if (mode) {
    const parsed = parseMode(mode);
    if (parsed === 'token' && !stored.tokenHash) throw new Error('CLAUDIO_AUTH_MODE=token needs CLAUDIO_AUTH_TOKEN');
    if (parsed === 'oidc' && !stored.oidc) throw new Error('CLAUDIO_AUTH_MODE=oidc needs CLAUDIO_OIDC_ISSUER and CLAUDIO_OIDC_AUDIENCE');
    stored.mode = parsed;
  }
  const readOnly = env.CLAUDIO_READ_ONLY?.trim();
  if (readOnly) stored.readOnly = flagOn(readOnly);
  return stored;
}

/** Jupyter-style: framed so it stands out in a log, printed once */
function firstRunBlock(token: string): string {
  const lines = [
    'Claudio made an owner token the first time it started.',
    'Paste it on the sign-in screen. It is shown only here, once.',
    '',
    `  ${token}`,
    '',
    `Until it is first used it is also in ${FIRST_RUN_TOKEN_FILE} in the data directory.`,
  ];
  const width = Math.max(...lines.map((line) => line.length));
  const bar = `+${'-'.repeat(width + 2)}+`;
  return `\n${bar}\n${lines.map((line) => `| ${line.padEnd(width)} |`).join('\n')}\n${bar}\n\n`;
}

function flagOn(value: string | undefined): boolean {
  const flag = value?.trim();
  return Boolean(flag) && flag !== '0' && flag?.toLowerCase() !== 'false';
}

/**
 * The way back in for someone who lost the token and cannot reach the data volume (a pod, a
 * managed host): `CLAUDIO_AUTH_TOKEN_RESET=1` with `CLAUDIO_AUTH_TOKEN` replaces the stored hash on
 * start. It changes the credential only; the mode, OIDC and read-only stay what the document says,
 * because the reset is about a lost secret, not about reconfiguring the guard. Returns `null` when
 * there is nothing to do, including a value already applied by an earlier start.
 */
function resetFromEnvironment(env: AuthEnv, stored: StoredAuth): StoredAuth | null {
  if (!flagOn(env.CLAUDIO_AUTH_TOKEN_RESET)) return null;
  const token = env.CLAUDIO_AUTH_TOKEN?.trim();
  // A reset that silently did nothing would leave the person locked out and wondering why
  if (!token) throw new Error('CLAUDIO_AUTH_TOKEN_RESET needs CLAUDIO_AUTH_TOKEN');
  const hash = sha256(token).toString('hex');
  if (stored.envResetHash === hash) return null;
  return { ...stored, tokenHash: hash, tokenId: 'env', tokenCreatedAt: new Date().toISOString(), envResetHash: hash };
}
