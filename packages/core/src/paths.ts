import { existsSync, mkdirSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import type { AppSettingValues, PermissionMode, ServerProfile } from '@claudio/shared';

/**
 * What the environment may say about the guard. Read here with everything else the environment
 * configures, so the auth store takes its defaults from a value and not from `process.env`: a
 * wrapper built for a test is then as closed, or as open, as the test asked for.
 */
const AUTH_ENV_KEYS = [
  'CLAUDIO_AUTH_MODE',
  'CLAUDIO_AUTH_TOKEN',
  'CLAUDIO_AUTH_TOKEN_RESET',
  'CLAUDIO_READ_ONLY',
  'CLAUDIO_OIDC_ISSUER',
  'CLAUDIO_OIDC_AUDIENCE',
  'CLAUDIO_OIDC_CLIENT_ID',
  // The desktop app's per-launch secret for its own tray; held in memory, never seeded to disk
  'CLAUDIO_DESKTOP_TOKEN',
] as const;

export type AuthEnv = Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>>;

export interface CoreConfig {
  /**
   * What this server registers and starts, from `CLAUDIO_PROFILE` (`full` unless it says
   * `headless`): one bundle that behaves by profile is one bundle to test
   * (docs/plans/headless-image.md, D2)
   */
  profile: ServerProfile;
  /** The budget of a chat that names none, from `CLAUDIO_CHAT_BUDGET_USD` (1 USD by default); the confined API chat applies it (D4) */
  chatBudgetUsd: number;
  /** Days after its last activity that a headless chat is deleted, from `CLAUDIO_CHAT_RETENTION_DAYS` (30 by default; D15) */
  chatRetentionDays: number;
  claudeBin: string;
  /** The `tailscale` CLI the tunnel runs, from `TAILSCALE_BIN`: the one on the `PATH` unless someone points at another */
  tailscaleBin: string;
  /**
   * Whether this deploy offers the tunnel, from `CLAUDIO_TUNNEL`. On by default. In the Docker image
   * (`CLAUDIO_DISTRIBUTION=docker`) the default follows `tailscaleManaged`: a container sees neither
   * the host's `tailscale` CLI nor its daemon, so the tunnel is offered there only when the image's
   * entrypoint started a `tailscaled` of Claudio's own (docs/deploy.md, "The tunnel in Docker").
   */
  tunnelEnabled: boolean;
  /**
   * Whether the `tailscaled` the CLI talks to is Claudio's own, from `CLAUDIO_TAILSCALE_MANAGED`,
   * which the image's entrypoint sets once it started one. Only then may the app sign it in and out:
   * a machine's own Tailscale belongs to the person, and Claudio never runs `up` or `logout` on it.
   */
  tailscaleManaged: boolean;
  /** The node name a managed `tailscaled` signs in with, from `CLAUDIO_TAILSCALE_HOSTNAME`; `claudio` by default */
  tailscaleHostname: string;
  /**
   * The HTTPS port of Claudio's `tailscale serve` rule as `CLAUDIO_TUNNEL_PORT` fixes it; null when
   * unset, so the port is the tunnel's setting (`tunnel-settings.json`, 8444 by default)
   */
  tunnelPort: number | null;
  /**
   * The listener on the local network, from `CLAUDIO_LAN` (docs/plans/lan-access.md, D2): `on` and
   * `off` fix it, `auto` (what the desktop app sets) listens whenever the guard asks for a credential
   * unless the person turned it off; null when unset, where it stays off until the person turns it on.
   * The image and Helm set `off`.
   */
  lan: LanSwitch | null;
  /** The listener's port as `CLAUDIO_LAN_PORT` fixes it; null when unset, so it is the setting's (8791 by default) */
  lanPort: number | null;
  /** The IPv4 addresses `CLAUDIO_LAN_BIND` fixes the listener to; null when unset, so they are the setting's */
  lanBind: string[] | null;
  configDir: string;
  /** Global CLI config file holding user-scope mcpServers */
  globalConfigFile: string;
  projectsDir: string;
  workspaceDir: string;
  dataDir: string;
  defaultPermissionMode: PermissionMode;
  setupSeen: boolean;
  maxConcurrentRuns: number;
  /** The daily spend cap from `CLAUDIO_DAILY_SPEND_CAP_USD` (or the default, no cap) */
  dailySpendCapUsd: number | null;
  /** The instruction evals' Phase 2 switch from `CLAUDIO_EVALS_PHASE2` (or the default, off) */
  evalsPhase2: boolean;
  /** How long an OpenAI client's tool call is held, from `CLAUDIO_OPENAI_TOOL_CALL_TIMEOUT_MINUTES` (or the default, 10) */
  openaiToolCallTimeoutMinutes: number;
  /**
   * VAPID `sub` claim of every push the server signs: a `mailto:` or `https:` the push service can
   * complain to. It has to name a real domain — Apple refuses the whole JWT with `403 BadJwtToken`
   * for something like `mailto:claudio@localhost`, and every iPhone goes quiet with it.
   */
  pushSubject: string;
  /**
   * Seeds the guard of an install that has no `auth.json` yet, and carries the desktop app's
   * per-launch secret, which is never written down; see `security/auth.ts`
   */
  authEnv: AuthEnv;
  /**
   * The key the desktop app hands the server to encrypt its secret files with (`CLAUDIO_SECRET_KEY`,
   * see `secret-box.ts`); absent on a server, where they stay plain at 0600. The server drops it
   * from `process.env` once read so no chat inherits it.
   */
  secretKey?: string;
  /**
   * How this Claudio was installed, from `CLAUDIO_DISTRIBUTION` (lower case): `docker` makes the
   * secret vault keep a key of its own beside the data when the environment brings none.
   */
  distribution?: string;
  /**
   * Host names this wrapper answers to besides loopback, from `CLAUDIO_ALLOWED_HOSTS`, each either
   * a name or a `*.domain` pattern standing for its subdomains. Read here for the same reason as
   * `authEnv`: the guard takes its allowlist from a value, so a test can build a wrapper that
   * answers to a name of its own.
   */
  allowedHosts: readonly string[];
  /**
   * The layered settings (`AppSettingValues`) the environment set. The three values above stay the
   * environment's, or the default's; what applies at runtime is read from `AppSettingsStore`, which
   * needs to know which of them the deploy decided and the UI may therefore not change.
   */
  settingsFromEnv: ReadonlySet<keyof AppSettingValues>;
}

/**
 * Why an allowlist entry is not one the guard can match, or null when it is. Shared by the
 * environment and `app-settings.json`, so a pattern refused in one is refused in the other.
 */
export function hostPatternProblem(host: string): string | null {
  const wildcard = host.startsWith('*.');
  if (host.includes('*') && (!wildcard || host.slice(2).includes('*') || host.split('.').length < 3)) {
    return `'${host}' is neither a host name nor a pattern such as '*.example.com'`;
  }
  return null;
}

/**
 * `CLAUDIO_ALLOWED_HOSTS` as the names and `*.domain` patterns the guard matches against.
 *
 * A pattern has to name at least two labels below the wildcard. `*.com` is not an allowlist, it is
 * the absence of one, and a wrapper that looks guarded and is not is worse than one that refuses to
 * start: the mistake is a typo at deploy time, which is exactly when someone is still watching.
 */
function parseAllowedHosts(value: string | undefined): string[] {
  const hosts = (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '');
  for (const host of hosts) {
    const problem = hostPatternProblem(host);
    if (problem) throw new Error(`CLAUDIO_ALLOWED_HOSTS: ${problem}`);
  }
  return hosts;
}

/**
 * `CLAUDIO_TUNNEL` as a yes or a no, or the default when it says nothing. Anything else stops the
 * wrapper: a typo in the variable that opens a public address is not something to guess about.
 */
function parseTunnelSwitch(value: string | undefined, fallback: boolean): boolean {
  if (!isSet(value)) return fallback;
  const word = value.trim().toLowerCase();
  if (['on', '1', 'true'].includes(word)) return true;
  if (['off', '0', 'false'].includes(word)) return false;
  throw new Error(`CLAUDIO_TUNNEL: '${value}' is neither on nor off`);
}

/** `CLAUDIO_LAN`: whether the server listens on the local network. Like the tunnel's, a typo stops the start */
export type LanSwitch = 'on' | 'off' | 'auto';

function parseLanSwitch(value: string | undefined): LanSwitch | null {
  if (!isSet(value)) return null;
  const word = value.trim().toLowerCase();
  if (['on', '1', 'true'].includes(word)) return 'on';
  if (['off', '0', 'false'].includes(word)) return 'off';
  if (word === 'auto') return 'auto';
  throw new Error(`CLAUDIO_LAN: '${value}' is none of on, off or auto`);
}

function parseLanPort(value: string | undefined): number | null {
  if (!isSet(value)) return null;
  const port = Number(value.trim());
  // 0 is whatever the system hands out, as PORT=0 is: a test's or a second instance's
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`CLAUDIO_LAN_PORT: '${value}' is not a port between 0 and 65535`);
  return port;
}

/** Comma-separated IPv4 addresses; a name or an IPv6 address is refused, since only an exact address joins the allowlist */
function parseLanBind(value: string | undefined): string[] | null {
  if (!isSet(value)) return null;
  const addresses = value
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address !== '');
  if (!addresses.length) return null;
  for (const address of addresses) if (!isIPv4(address)) throw new Error(`CLAUDIO_LAN_BIND: '${address}' is not an IPv4 address`);
  // Every interface, which is leaving it unset; listed, it would join the allowlist as a name
  if (addresses.includes('0.0.0.0')) throw new Error("CLAUDIO_LAN_BIND: '0.0.0.0' is every interface: leave CLAUDIO_LAN_BIND unset instead");
  return [...new Set(addresses)];
}

/** A flag the image's entrypoint sets: only an explicit yes counts */
function parseYes(value: string | undefined): boolean {
  return isSet(value) && ['on', '1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

/**
 * A node name for `tailscale up --hostname`: a DNS label, since it becomes the node's MagicDNS name.
 * Anything else stops the wrapper rather than reaching the CLI.
 */
function parseTailscaleHostname(value: string | undefined): string {
  if (!isSet(value)) return 'claudio';
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new Error(`CLAUDIO_TAILSCALE_HOSTNAME: '${value}' is not a host name (letters, digits and dashes, at most 63)`);
  return name;
}

/** A port that is not a port is refused at startup rather than guessed: it decides where a rule lands in the node's shared Serve config. */
function parseTunnelPort(value: string | undefined): number | null {
  if (!isSet(value)) return null;
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`CLAUDIO_TUNNEL_PORT: '${value}' is not a port between 1 and 65535`);
  return port;
}

function parseSeenSwitch(name: string, value: string): boolean {
  const word = value.trim().toLowerCase();
  if (['on', '1', 'true'].includes(word)) return true;
  if (['off', '0', 'false'].includes(word)) return false;
  throw new Error(`${name}: '${value}' is neither on nor off`);
}

/**
 * The variable an install set before the setup assistant replaced the first-run Providers step. It
 * still counts, so an install that saw the old step is not walked through the assistant again.
 */
export const OLD_SETUP_SEEN_ENV = 'CLAUDIO_PROVIDERS_STEP_SEEN';

/** `CLAUDIO_SETUP_SEEN`, else the old variable, else nothing */
function setupSeenFromEnv(env: NodeJS.ProcessEnv): boolean | null {
  if (isSet(env.CLAUDIO_SETUP_SEEN)) return parseSeenSwitch('CLAUDIO_SETUP_SEEN', env.CLAUDIO_SETUP_SEEN);
  if (isSet(env[OLD_SETUP_SEEN_ENV])) return parseSeenSwitch(OLD_SETUP_SEEN_ENV, env[OLD_SETUP_SEEN_ENV]);
  return null;
}

/** The most a daily cap may be set to: a typo of three more zeros is a mistake, not a budget */
export const MAX_DAILY_SPEND_CAP_USD = 100_000;

/**
 * A daily spend cap in USD: above 0 and at most {@link MAX_DAILY_SPEND_CAP_USD}, rounded to cents so
 * the sum and the figure the person typed compare without float noise. Null when it is not one.
 */
export function normalizeSpendCap(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const cents = Math.round(value * 100) / 100;
  return cents > 0 && cents <= MAX_DAILY_SPEND_CAP_USD ? cents : null;
}

/** `CLAUDIO_DAILY_SPEND_CAP_USD`: unset means no cap; a value that is not a valid cap stops the start rather than run uncapped by accident */
function spendCapFromEnv(value: string | undefined): number | null {
  if (!isSet(value)) return DEFAULT_APP_SETTINGS.dailySpendCapUsd;
  const cap = normalizeSpendCap(Number(value.trim()));
  if (cap === null) throw new Error(`CLAUDIO_DAILY_SPEND_CAP_USD: '${value}' is not an amount above 0 and up to ${String(MAX_DAILY_SPEND_CAP_USD)}`);
  return cap;
}

/** `CLAUDIO_PROFILE`: unset is the app; a value that names no profile stops the start rather than run the wrong one */
function profileFromEnv(value: string | undefined): ServerProfile {
  if (!isSet(value)) return 'full';
  const profile = value.trim().toLowerCase();
  if (profile === 'full' || profile === 'headless') return profile;
  throw new Error(`CLAUDIO_PROFILE: '${value}' is neither 'full' nor 'headless'`);
}

/** A chat's budget when it names none: the D4 default, enough for a few one-shot turns and no runaway */
export const DEFAULT_CHAT_BUDGET_USD = 1;

function chatBudgetFromEnv(value: string | undefined): number {
  if (!isSet(value)) return DEFAULT_CHAT_BUDGET_USD;
  const budget = normalizeSpendCap(Number(value.trim()));
  if (budget === null) throw new Error(`CLAUDIO_CHAT_BUDGET_USD: '${value}' is not an amount above 0 and up to ${String(MAX_DAILY_SPEND_CAP_USD)}`);
  return budget;
}

/** What a headless start is judged on: the guard's mode and the address it binds, and the settings in force */
export interface HeadlessStart {
  authMode: string;
  /** The address the server listens on */
  host: string;
  /** The permission mode in force (the environment's, else `app-settings.json`'s) */
  defaultPermissionMode: PermissionMode;
  /** `CLAUDIO_DAILY_SPEND_CAP_USD` as the environment set it; null when it did not */
  envSpendCapUsd: number | null;
}

const LOOPBACK_BIND = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Why a headless server must not start, one sentence each; empty when it may (D4). A headless
 * Claudio runs model turns for a program that holds its token, so an open guard is allowed only
 * where nothing but the machine itself can reach it, an unbounded day of spend is never its
 * default, and every chat runs in `dontAsk`, the one mode a confined API chat takes (D14).
 */
export function headlessStartProblems(start: HeadlessStart): string[] {
  const problems: string[] = [];
  if (start.authMode === 'none' && !LOOPBACK_BIND.has(start.host.trim().toLowerCase())) {
    problems.push(`CLAUDIO_AUTH_MODE=none on ${start.host}: a headless Claudio needs a token (CLAUDIO_AUTH_MODE=token with CLAUDIO_AUTH_TOKEN) unless it listens on loopback only`);
  }
  if (start.envSpendCapUsd === null) problems.push('CLAUDIO_DAILY_SPEND_CAP_USD is not set: a headless Claudio needs a daily spend cap');
  if (start.defaultPermissionMode !== 'dontAsk') {
    problems.push(`the permission mode is '${start.defaultPermissionMode}': a headless Claudio runs every chat in 'dontAsk' (CLAUDIO_DEFAULT_PERMISSION_MODE=dontAsk)`);
  }
  return problems;
}

/** How long a headless chat outlives its last activity: its transcript holds what it read of a repository */
export const DEFAULT_CHAT_RETENTION_DAYS = 30;

function retentionFromEnv(value: string | undefined): number {
  if (!isSet(value)) return DEFAULT_CHAT_RETENTION_DAYS;
  const days = Number(value.trim());
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error(`CLAUDIO_CHAT_RETENTION_DAYS: '${value}' is not a whole number of days from 1 to 3650`);
  return days;
}

/** The longest an OpenAI client's tool call may be held: a day, past which nobody is coming back */
export const MAX_OPENAI_TOOL_CALL_TIMEOUT_MINUTES = 1440;

/** A whole number of minutes from 1 to a day, or null when the value is not one. */
export function normalizeToolCallTimeout(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_OPENAI_TOOL_CALL_TIMEOUT_MINUTES ? value : null;
}

function toolCallTimeoutFromEnv(value: string | undefined): number {
  if (!isSet(value)) return DEFAULT_APP_SETTINGS.openaiToolCallTimeoutMinutes;
  const minutes = normalizeToolCallTimeout(Number(value.trim()));
  if (minutes === null) throw new Error(`CLAUDIO_OPENAI_TOOL_CALL_TIMEOUT_MINUTES: '${value}' is not a whole number of minutes from 1 to ${String(MAX_OPENAI_TOOL_CALL_TIMEOUT_MINUTES)}`);
  return minutes;
}

/** What a layered setting is when neither the environment nor `app-settings.json` says otherwise. */
export const DEFAULT_APP_SETTINGS: Readonly<AppSettingValues> = Object.freeze({
  allowedHosts: [],
  maxConcurrentRuns: 8,
  defaultPermissionMode: 'acceptEdits',
  setupSeen: false,
  dailySpendCapUsd: null,
  evalsPhase2: false,
  openaiToolCallTimeoutMinutes: 10,
});

/** pnpm runs scripts from the package dir; default state dirs belong at the monorepo root instead. */
function baseDir(): string {
  for (let dir = process.cwd(); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
  }
  return process.cwd();
}

/**
 * A variable counts as set when it holds something. Compose files pass `VAR=${VAR:-}` through, and
 * an empty value there means "not configured": treating it as set would lock the setting in the UI
 * to a value nobody chose.
 */
const isSet = (value: string | undefined): value is string => value !== undefined && value.trim() !== '';

/** The variable behind each layered setting, which the UI names when it shows one as read-only. */
export const APP_SETTING_ENV = {
  allowedHosts: 'CLAUDIO_ALLOWED_HOSTS',
  maxConcurrentRuns: 'CLAUDIO_MAX_CONCURRENT_RUNS',
  defaultPermissionMode: 'CLAUDIO_DEFAULT_PERMISSION_MODE',
  setupSeen: 'CLAUDIO_SETUP_SEEN',
  dailySpendCapUsd: 'CLAUDIO_DAILY_SPEND_CAP_USD',
  evalsPhase2: 'CLAUDIO_EVALS_PHASE2',
  openaiToolCallTimeoutMinutes: 'CLAUDIO_OPENAI_TOOL_CALL_TIMEOUT_MINUTES',
} as const satisfies Record<keyof AppSettingValues, string>;

/**
 * The variables that say where each code host's CLI keeps its sign-in and settings. The Docker image points them inside the data directory so the one volume holds them
 * (docs/deploy.md); the CLIs would otherwise write to their default homes, which are gone with the
 * container.
 */
export const PROVIDER_HOME_ENV = [
  'GH_CONFIG_DIR',
  'GLAB_CONFIG_DIR',
] as const;

/**
 * Creates the provider homes that live inside the data directory. A fresh volume has none of them,
 * and a CLI may refuse to start with a home that does not exist. A home somewhere else is the
 * operator's own and is left to them. Returns what it created or found, for the log.
 */
export function ensureProviderHomes(env: NodeJS.ProcessEnv, dataDir: string): string[] {
  const homes: string[] = [];
  for (const name of PROVIDER_HOME_ENV) {
    const value = env[name];
    if (!isSet(value) || !isAbsolute(value)) continue;
    const home = resolve(value);
    const inside = relative(dataDir, home);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) continue;
    mkdirSync(home, { recursive: true });
    homes.push(home);
  }
  return homes;
}

/** The data directory `loadConfig` uses, computed without creating or reading anything: the server locks it first */
export function dataDirFrom(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CLAUDIO_DATA_DIR ?? join(baseDir(), 'data'));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const configDir = resolve(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));
  // With CLAUDE_CONFIG_DIR the CLI keeps .claude.json inside that directory; otherwise in $HOME.
  const globalConfigFile = env.CLAUDE_CONFIG_DIR
    ? join(configDir, '.claude.json')
    : join(homedir(), '.claude.json');
  const workspaceDir = resolve(env.CLAUDIO_WORKSPACE_DIR ?? join(baseDir(), 'workspace'));
  const dataDir = dataDirFrom(env);
  for (const dir of [workspaceDir, dataDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  ensureProviderHomes(env, dataDir);
  return {
    profile: profileFromEnv(env.CLAUDIO_PROFILE),
    chatBudgetUsd: chatBudgetFromEnv(env.CLAUDIO_CHAT_BUDGET_USD),
    chatRetentionDays: retentionFromEnv(env.CLAUDIO_CHAT_RETENTION_DAYS),
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    tailscaleBin: env.TAILSCALE_BIN?.trim() || 'tailscale',
    tunnelEnabled: parseTunnelSwitch(env.CLAUDIO_TUNNEL, env.CLAUDIO_DISTRIBUTION?.trim().toLowerCase() !== 'docker' || parseYes(env.CLAUDIO_TAILSCALE_MANAGED)),
    tailscaleManaged: parseYes(env.CLAUDIO_TAILSCALE_MANAGED),
    tailscaleHostname: parseTailscaleHostname(env.CLAUDIO_TAILSCALE_HOSTNAME),
    tunnelPort: parseTunnelPort(env.CLAUDIO_TUNNEL_PORT),
    lan: parseLanSwitch(env.CLAUDIO_LAN),
    lanPort: parseLanPort(env.CLAUDIO_LAN_PORT),
    lanBind: parseLanBind(env.CLAUDIO_LAN_BIND),
    configDir,
    globalConfigFile,
    projectsDir: join(configDir, 'projects'),
    workspaceDir,
    dataDir,
    defaultPermissionMode: isSet(env.CLAUDIO_DEFAULT_PERMISSION_MODE) ? (env.CLAUDIO_DEFAULT_PERMISSION_MODE.trim() as PermissionMode) : DEFAULT_APP_SETTINGS.defaultPermissionMode,
    setupSeen: setupSeenFromEnv(env) ?? DEFAULT_APP_SETTINGS.setupSeen,
    dailySpendCapUsd: spendCapFromEnv(env.CLAUDIO_DAILY_SPEND_CAP_USD),
    evalsPhase2: isSet(env.CLAUDIO_EVALS_PHASE2) ? parseSeenSwitch('CLAUDIO_EVALS_PHASE2', env.CLAUDIO_EVALS_PHASE2) : DEFAULT_APP_SETTINGS.evalsPhase2,
    maxConcurrentRuns: isSet(env.CLAUDIO_MAX_CONCURRENT_RUNS) ? Number(env.CLAUDIO_MAX_CONCURRENT_RUNS) : DEFAULT_APP_SETTINGS.maxConcurrentRuns,
    openaiToolCallTimeoutMinutes: toolCallTimeoutFromEnv(env.CLAUDIO_OPENAI_TOOL_CALL_TIMEOUT_MINUTES),
    pushSubject: env.CLAUDIO_PUSH_SUBJECT?.trim() || 'https://github.com/yeyo11/claudio',
    allowedHosts: parseAllowedHosts(env.CLAUDIO_ALLOWED_HOSTS),
    settingsFromEnv: new Set((Object.keys(APP_SETTING_ENV) as (keyof AppSettingValues)[]).filter((key) => isSet(env[APP_SETTING_ENV[key]]) || (key === 'setupSeen' && isSet(env[OLD_SETUP_SEEN_ENV])))),
    authEnv: Object.fromEntries(AUTH_ENV_KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]]))) as AuthEnv,
    ...(isSet(env.CLAUDIO_SECRET_KEY) ? { secretKey: env.CLAUDIO_SECRET_KEY.trim() } : {}),
    ...(isSet(env.CLAUDIO_DISTRIBUTION) ? { distribution: env.CLAUDIO_DISTRIBUTION.trim().toLowerCase() } : {}),
  };
}
